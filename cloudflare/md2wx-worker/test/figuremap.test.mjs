/**
 * figuremap 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, collectImageRefs } from './.figuremap.bundle.mjs';

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
