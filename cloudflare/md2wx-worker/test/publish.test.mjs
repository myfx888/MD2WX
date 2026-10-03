/**
 * 发布工坊纯逻辑层测试：esbuild 打包 web/src/core/publish.js 后用 node --test 断言
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPublishMeta,
  buildPublishPayload,
  resolvePushConfig,
  readPushHistory,
  recordPush,
  countWords,
} from './.publish.bundle.mjs';

function mockStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

describe('extractPublishMeta', () => {
  it('frontmatter 优先', () => {
    const r = extractPublishMeta('---\ntitle: FM标题\ndigest: FM摘要\n---\n\n# H1标题\n\n![图](https://a.png)\n\n正文');
    assert.equal(r.title, 'FM标题');
    assert.equal(r.digest, 'FM摘要');
    assert.equal(r.coverImageSrc, 'https://a.png');
  });

  it('无 frontmatter 时 H1 回退，digest 为空', () => {
    const r = extractPublishMeta('# H1标题\n\n正文');
    assert.equal(r.title, 'H1标题');
    assert.equal(r.digest, '');
    assert.equal(r.coverImageSrc, '');
  });

  it('无 H1 时首行文字回退', () => {
    const r = extractPublishMeta('就是第一行文字\n\n正文');
    assert.equal(r.title, '就是第一行文字');
  });

  it('coverImageSrc 识别 HTML img 与 data URI', () => {
    assert.equal(extractPublishMeta('<img src="https://x.com/a.jpg">').coverImageSrc, 'https://x.com/a.jpg');
    assert.equal(extractPublishMeta('![b](data:image/png;base64,AAAA)').coverImageSrc.startsWith('data:'), true);
    assert.equal(extractPublishMeta('没有图').coverImageSrc, '');
  });
});

describe('buildPublishPayload', () => {
  it('基础形态只有 markdown 与 theme', () => {
    const p = buildPublishPayload({ markdown: '# t', theme: 'tech-blue' });
    assert.deepEqual(p, { markdown: '# t', theme: 'tech-blue' });
  });

  it('title/digest 非空即携带', () => {
    const p = buildPublishPayload({ markdown: '# t', theme: 'vintage-news', title: ' 标题 ', digest: '摘要' });
    assert.equal(p.title, '标题');
    assert.equal(p.digest, '摘要');
  });

  it('cover 与凭证穿透映射', () => {
    const p = buildPublishPayload({
      markdown: '# t', theme: 'tech-blue',
      coverDataUrl: 'data:image/png;base64,AA', appId: ' wx1 ', appSecret: ' sec ',
    });
    assert.equal(p.cover, 'data:image/png;base64,AA');
    assert.equal(p.appid, 'wx1');
    assert.equal(p.secret, 'sec');
  });
});

describe('resolvePushConfig', () => {
  it('无 Key 时不可推送', () => {
    const r = resolvePushConfig('', '');
    assert.equal(r.ok, false);
    assert.equal(r.endpoint, '/api/draft');
  });
  it('有 Key 时端点缺省同源，自定义端点去空格', () => {
    assert.equal(resolvePushConfig('k', '').endpoint, '/api/draft');
    assert.deepEqual(resolvePushConfig(' k ', ' https://x/api/draft '), { ok: true, endpoint: 'https://x/api/draft', reason: '' });
  });
});

describe('推送历史', () => {
  it('空存储读取返回空数组', () => {
    assert.deepEqual(readPushHistory(mockStore()), []);
  });

  it('recordPush 写入并持久化，超过 5 条截断最旧', () => {
    const store = mockStore();
    for (let i = 1; i <= 7; i++) {
      recordPush({ t: i, title: 'T' + i, ok: true, mediaId: 'M' + i }, store);
    }
    const h = readPushHistory(store);
    assert.equal(h.length, 5);
    assert.equal(h[0].title, 'T7');
    assert.equal(h[4].title, 'T3');
    assert.equal(h[0].mediaId, 'M7');
  });

  it('失败项带 msg', () => {
    const store = mockStore();
    recordPush({ t: 1, title: 'T', ok: false, msg: '缺少封面' }, store);
    const h = readPushHistory(store);
    assert.equal(h[0].ok, false);
    assert.equal(h[0].msg, '缺少封面');
  });
});

describe('countWords', () => {
  it('汉字与英文单词合计', () => {
    assert.equal(countWords('你好世界 hello world'), 6);
    assert.equal(countWords(''), 0);
  });
});
