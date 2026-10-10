/**
 * figuremap 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, collectImageRefs, matchFiles } from './.figuremap.bundle.mjs';

describe('normalizePath', () => {
  it('剥 ./ 前缀并统一分隔符', () => {
    assert.equal(normalizePath('./images/01.png'), 'images/01.png');
    assert.equal(normalizePath('.\\imgs\\a\\b.png'), 'imgs/a/b.png');
    assert.equal(normalizePath('a//b.png'), 'a/b.png');
    assert.equal(normalizePath('  images/x.png  '), 'images/x.png');
  });
});

describe('collectImageRefs', () => {
  it('收集 Markdown 与 HTML 引用并标注 kind', () => {
    const md = '![a](images/1.png)\n正文\n<img src="images/2.png" alt="b">';
    const refs = collectImageRefs(md);
    assert.deepEqual(
      refs.map((r) => [r.path, r.kind]),
      [['images/1.png', 'md'], ['images/2.png', 'html']]
    );
  });
  it('跳过远程与 data: 引用,支持 title 属性形态', () => {
    const md = '![x](https://mmbiz.qpic.cn/a.png) ![y](data:image/png;base64,AAA) ![t](local/3.png "标题")';
    const refs = collectImageRefs(md);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].path, 'local/3.png');
    assert.equal(refs[0].kind, 'md');
  });
  it('同一本地路径只收集一次', () => {
    const refs = collectImageRefs('![a](p.png)\n![b](p.png)\n<img src="p.png">');
    assert.equal(refs.length, 1);
  });
  it('空输入返回空数组', () => {
    assert.deepEqual(collectImageRefs(''), []);
    assert.deepEqual(collectImageRefs(null), []);
  });
});

describe('matchFiles', () => {
  const files = [
    { path: 'images/01.png', file: { name: '01.png' } },
    { path: 'images/02.png', file: { name: '02.png' } },
    { path: 'extra/03.png', file: { name: '03.png' } },
  ];
  it('精确路径命中并带 filePath', () => {
    const m = matchFiles([{ path: 'images/01.png' }], files);
    assert.equal(m.get('images/01.png').status, 'matched');
    assert.equal(m.get('images/01.png').matchType, 'exact');
    assert.equal(m.get('images/01.png').filePath, 'images/01.png');
  });
  it('./ 前缀与反斜杠归一化后精确命中', () => {
    const m = matchFiles([{ path: './images\\01.png' }], files);
    assert.equal(m.get('./images\\01.png').matchType, 'exact');
  });
  it('文件名在文件夹内唯一时回落命中', () => {
    const m = matchFiles([{ path: '03.png' }], files);
    assert.equal(m.get('03.png').status, 'matched');
    assert.equal(m.get('03.png').matchType, 'filename');
    assert.equal(m.get('03.png').filePath, 'extra/03.png');
  });
  it('重名冲突标记 conflict 并按路径排序列出候选', () => {
    const fs2 = [...files, { path: 'backup/03.png', file: { name: '03.png' } }];
    const m = matchFiles([{ path: '03.png' }], fs2);
    assert.equal(m.get('03.png').status, 'conflict');
    assert.deepEqual(m.get('03.png').conflicts, ['backup/03.png', 'extra/03.png']);
  });
  it('无候选标记 unmatched', () => {
    const m = matchFiles([{ path: 'nope.png' }], files);
    assert.equal(m.get('nope.png').status, 'unmatched');
  });
  it('大小写敏感:IMG.PNG 不命中 img.png', () => {
    const m = matchFiles([{ path: 'IMG.PNG' }], [{ path: 'img.png', file: { name: 'img.png' } }]);
    assert.equal(m.get('IMG.PNG').status, 'unmatched');
  });
});
