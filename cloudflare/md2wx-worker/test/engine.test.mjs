/**
 * MD2WX Worker 测试
 * 先用 esbuild 把 worker.js（连同 web/src/core 引擎与 JSON 主题）打成单文件 ESM，
 * 再用 Node 内建 test runner 直接调用 worker.fetch —— Node 24 自带 Request/Response 全局。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetTokenCache } from './.worker.bundle.mjs';
import worker from './.worker.bundle.mjs';

function req(path, opts = {}) {
  return new Request('https://worker.test' + path, opts);
}

async function postJson(path, body, env = {}, headers = {}) {
  return worker.fetch(
    req(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
    {}
  );
}

describe('GET /api/health', () => {
  it('返回 ok 与服务名', async () => {
    const res = await worker.fetch(req('/api/health'), {}, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.service, 'md2wx-worker');
  });

  it('OPTIONS 预检返回 204 并带 CORS 头', async () => {
    const res = await worker.fetch(req('/api/convert', { method: 'OPTIONS' }), {}, {});
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('未知 API 路由返回 404', async () => {
    const res = await worker.fetch(req('/api/nope'), {}, {});
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.code, 1);
  });
});

describe('GET /api/themes', () => {
  it('返回 9 个内置主题，含 id/name', async () => {
    const res = await worker.fetch(req('/api/themes'), {}, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.themes.length, 9);
    for (const t of data.themes) {
      assert.ok(t.id && t.name);
    }
  });
});

describe('POST /api/convert', () => {
  const MD_WITH_FM = '---\ntitle: 你好标题\ndigest: 你好摘要\n---\n\n# Hi\n\n正文内容';

  it('frontmatter 标题摘要被提取，产物含内联样式', async () => {
    const res = await postJson('/api/convert', { markdown: MD_WITH_FM });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.title, '你好标题');
    assert.equal(data.digest, '你好摘要');
    assert.equal(data.theme, 'tech-blue');
    assert.ok(data.html.includes('<section style='));
  });

  it('未知主题回退默认主题', async () => {
    const res = await postJson('/api/convert', { markdown: MD_WITH_FM, theme: 'no-such-theme' });
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.theme, 'tech-blue');
  });

  it('sample_article.md 全 9 主题转换冒烟', async () => {
    const { readFileSync } = await import('node:fs');
    const sample = readFileSync(new URL('../../../sample_article.md', import.meta.url), 'utf-8');
    const themesRes = await worker.fetch(req('/api/themes'), {}, {});
    const { themes } = await themesRes.json();
    for (const t of themes) {
      const res = await postJson('/api/convert', { markdown: sample, theme: t.id });
      assert.equal(res.status, 200, `theme ${t.id} 应转换成功`);
      const data = await res.json();
      assert.ok(data.html.includes('<section style='), `theme ${t.id} 产物应含内联样式`);
    }
  });

  it('缺少 markdown 返回 400', async () => {
    const res = await postJson('/api/convert', {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, 1);
    assert.ok(data.msg.includes('markdown'));
  });

  it('非法 JSON 返回 400', async () => {
    const res = await worker.fetch(req('/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    }), {}, {});
    assert.equal(res.status, 400);
  });
});

// ============================== /api/draft ==============================

/** 按 URL 子串匹配返回预置 JSON 的微信 API mock（带调用记录；raw 项直接返回原始 Response） */
function mockWxFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    for (const r of responses) {
      if (String(url).includes(r.match)) {
        if (r.raw) return r.raw;
        return new Response(JSON.stringify(r.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ errcode: -1, errmsg: 'unmocked: ' + url }), { status: 500 });
  };
  fn.calls = calls;
  return fn;
}

const DRAFT_ENV = {
  DRAFT_API_KEY: 'test-key',
  WECHAT_APPID: 'wx-appid-test',
  WECHAT_APPSECRET: 'wx-secret-test',
};

const DRAFT_HEADERS = { 'X-API-Key': 'test-key' };

describe('POST /api/draft 鉴权与校验', () => {
  beforeEach(() => __resetTokenCache());

  it('未配置 DRAFT_API_KEY 时 fail-closed 拒绝', async () => {
    const res = await postJson('/api/draft', { markdown: '# t', title: 't' }, {});
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(data.msg.includes('DRAFT_API_KEY'));
  });

  it('Key 错误返回 401（header 与 query 两种通道均校验）', async () => {
    for (const path of ['/api/draft', '/api/draft?key=wrong']) {
      const res = await postJson(path, { markdown: '# t', title: 't' }, DRAFT_ENV, { 'X-API-Key': 'nope' });
      assert.equal(res.status, 401);
    }
  });

  it('query key 正确时放行到业务校验（缺 markdown/content 返回 400 而非 401）', async () => {
    const res = await postJson('/api/draft?key=test-key', { title: 't' }, DRAFT_ENV);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('markdown'));
  });

  it('markdown 形态但无 frontmatter title 且未传 title 返回 400', async () => {
    const res = await postJson('/api/draft', { markdown: '# 无标题文章' }, DRAFT_ENV, DRAFT_HEADERS);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('title'));
  });

  it('env 与 body 均无 appid/secret 返回 400', async () => {
    const res = await postJson(
      '/api/draft',
      { markdown: '---\ntitle: T\n---\n\n正文' },
      { DRAFT_API_KEY: 'test-key' },
      DRAFT_HEADERS
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('appid'));
  });
});

describe('POST /api/draft 推送链路（env.__WX_FETCH 注入 mock 微信 API）', () => {
  beforeEach(() => __resetTokenCache());

  it('markdown 形态全链路：转换 -> 图片换链 -> 封面解析 -> 草稿成功', async () => {
    const wx = mockWxFetch([
      { match: 'stable_token', body: { access_token: 'TOKEN1' } },
      { match: 'cdn.example.com', raw: new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }) },
      { match: 'uploadimg', body: { url: 'https://mmbiz.qpic.cn/m/replace.png' } },
      // resolveCover 会把换链后的首图（mmbiz 域名）下载后重新传 add_material 做永久素材
      { match: 'mmbiz.qpic.cn', raw: new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }) },
      { match: 'add_material', body: { media_id: 'MEDIA1' } },
      { match: 'draft/add', body: { media_id: 'DRAFT1' } },
    ]);

    const md = '---\ntitle: 测试文章\ndigest: 测试摘要\n---\n\n# 测试文章\n\n![封面](https://cdn.example.com/cover.png)\n\n正文';
    const res = await postJson('/api/draft', { markdown: md }, { ...DRAFT_ENV, __WX_FETCH: wx }, DRAFT_HEADERS);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.media_id, 'DRAFT1');

    const addCall = wx.calls.find((c) => c.url.includes('draft/add'));
    assert.ok(addCall, '必须调用过 draft/add');
    const sent = JSON.parse(addCall.opts.body);
    assert.equal(sent.articles[0].title, '测试文章');
    assert.equal(sent.articles[0].digest, '测试摘要');
    assert.equal(sent.articles[0].thumb_media_id, 'MEDIA1');
    assert.ok(sent.articles[0].content.includes('<section style='), '正文必须是引擎转换产物');
    assert.ok(sent.articles[0].content.includes('mmbiz.qpic.cn/m/replace.png'), '外链图必须已换链');

    const uploadCall = wx.calls.find((c) => c.url.includes('uploadimg'));
    assert.ok(uploadCall, '正文外链图必须经过 uploadimg 换链');
  });

  it('content 形态：无封面且正文无图返回 400 缺少封面', async () => {
    const res = await postJson(
      '/api/draft',
      { content: '<section style="x">hi</section>', title: 'T' },
      DRAFT_ENV,
      DRAFT_HEADERS
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('封面'));
  });
});
