/**
 * coverCopy 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCoverDefaults, writeCoverDefaults, extractThemeCoverCopy, DEFAULT_FALLBACK,
} from './.coverCopy.bundle.mjs';

/** 内存版 localStorage 桩(store 参数注入用) */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

describe('writeCoverDefaults / readCoverDefaults', () => {
  it('写入后读回一致,空串字段被剔除', () => {
    const s = memStore();
    writeCoverDefaults(s, { badge: 'MYBRAND', tag: '', author: '  作者  ' });
    assert.deepEqual(readCoverDefaults(s), { badge: 'MYBRAND', author: '作者' });
  });
  it('三个全空即删键,读回 null', () => {
    const s = memStore();
    writeCoverDefaults(s, { badge: 'X', tag: 'T', author: 'A' });
    writeCoverDefaults(s, { badge: '', tag: '', author: '' });
    assert.equal(readCoverDefaults(s), null);
    assert.equal(s.getItem('md2wx_cover_defaults'), null);
  });
  it('store 不可用时静默:read 返回 null,write 不抛错', () => {
    const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    assert.equal(readCoverDefaults(bad), null);
    assert.doesNotThrow(() => writeCoverDefaults(bad, { badge: 'X' }));
  });
  it('非法 JSON 容错返回 null', () => {
    const s = memStore();
    s.setItem('md2wx_cover_defaults', '{not json');
    assert.equal(readCoverDefaults(s), null);
  });
  it('非对象 JSON(数组/字符串)容错返回 null', () => {
    const s = memStore();
    s.setItem('md2wx_cover_defaults', '["x"]');
    assert.equal(readCoverDefaults(s), null);
    s.setItem('md2wx_cover_defaults', '"abc"');
    assert.equal(readCoverDefaults(s), null);
  });
});

describe('extractThemeCoverCopy', () => {
  it('提取合法 coverCopy 字段(只取三键,忽略多余键)', () => {
    const t = { baseId: 'tech-blue', name: 'X', override: {}, coverCopy: { badge: 'B', tag: 'T', author: 'A', junk: 1 } };
    assert.deepEqual(extractThemeCoverCopy(t), { badge: 'B', tag: 'T', author: 'A' });
  });
  it('部分字段缺失时仅返回存在的非空字段', () => {
    const t = { coverCopy: { badge: 'B' } };
    assert.deepEqual(extractThemeCoverCopy(t), { badge: 'B' });
  });
  it('coverCopy 缺失/非对象/全空 -> null', () => {
    assert.equal(extractThemeCoverCopy({}), null);
    assert.equal(extractThemeCoverCopy({ coverCopy: 'x' }), null);
    assert.equal(extractThemeCoverCopy({ coverCopy: { badge: '', tag: '', author: '' } }), null);
    assert.equal(extractThemeCoverCopy(null), null);
    assert.equal(extractThemeCoverCopy({ coverCopy: { badge: 123 } }), null);
  });
});

describe('DEFAULT_FALLBACK', () => {
  it('兜底三元组与现状硬编码一致', () => {
    assert.deepEqual(DEFAULT_FALLBACK, { badge: 'WZZS', tag: '万舟智算 · 教程系列', author: '万舟智算' });
  });
});
