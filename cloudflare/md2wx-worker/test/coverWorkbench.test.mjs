/**
 * coverWorkbench 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_WORKBENCH_KEY, readCoverWorkbench, writeCoverWorkbench, coverExportRatio,
} from './.coverWorkbench.bundle.mjs';

/** 内存版 localStorage 桩(store 参数注入用) */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const SNAP = {
  themeId: 'acid-bold', ratio: 'square',
  title: ' 标题 ', digest: '副标题', tag: '标签', badge: '徽章', vol: 'VOL.01', author: '作者',
};

describe('writeCoverWorkbench / readCoverWorkbench', () => {
  it('写入后读回一致,savedAt 为数字', () => {
    const s = memStore();
    writeCoverWorkbench(s, SNAP);
    const r = readCoverWorkbench(s);
    assert.equal(r.themeId, 'acid-bold');
    assert.equal(r.ratio, 'square');
    assert.equal(r.title, '标题'); // 6 文案字段 trim
    assert.equal(r.digest, '副标题');
    assert.equal(typeof r.savedAt, 'number');
    assert.equal(s.getItem(COVER_WORKBENCH_KEY) !== null, true);
  });
  it('白名单外字段丢弃,非字符串文案字段补空串', () => {
    const s = memStore();
    writeCoverWorkbench(s, { ...SNAP, junk: 1, digest: 123 });
    const r = readCoverWorkbench(s);
    assert.equal('junk' in r, false);
    assert.equal(r.digest, '');
  });
  it('ratio 非法时写入回落 banner,读回即 banner', () => {
    const s = memStore();
    writeCoverWorkbench(s, { ...SNAP, ratio: 'weird' });
    assert.equal(readCoverWorkbench(s).ratio, 'banner');
  });
  it('themeId 为空串/缺失时写入抛错', () => {
    const s = memStore();
    assert.throws(() => writeCoverWorkbench(s, { ...SNAP, themeId: '  ' }));
    assert.throws(() => writeCoverWorkbench(s, { ratio: 'banner' }));
    assert.equal(readCoverWorkbench(s), null); // 抛错前未落库
  });
  it('store 为 null 时写入抛错;存储异常向上抛', () => {
    assert.throws(() => writeCoverWorkbench(null, SNAP));
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    assert.throws(() => writeCoverWorkbench(bad, SNAP), /quota/);
    assert.equal(readCoverWorkbench(bad), null);
  });
  it('非法 JSON / 数组 / 字符串 / 缺 themeId / ratio 非法 -> 读回 null', () => {
    const s = memStore();
    s.setItem(COVER_WORKBENCH_KEY, '{not json');
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, '["x"]');
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, '"abc"');
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, JSON.stringify({ ratio: 'banner' }));
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, JSON.stringify({ themeId: 'tech-blue', ratio: 'wide' }));
    assert.equal(readCoverWorkbench(s), null);
  });
  it('无键 / store 不可用 / store null -> 读回 null', () => {
    assert.equal(readCoverWorkbench(memStore()), null);
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => {}, removeItem: () => {} };
    assert.equal(readCoverWorkbench(bad), null);
    assert.equal(readCoverWorkbench(null), null);
  });
});

describe('coverExportRatio', () => {
  it('dual 回落 banner;banner/square 原样', () => {
    assert.equal(coverExportRatio('dual'), 'banner');
    assert.equal(coverExportRatio('banner'), 'banner');
    assert.equal(coverExportRatio('square'), 'square');
  });
});
