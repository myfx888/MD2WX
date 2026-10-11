/**
 * coverCopy 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCoverDefaults, writeCoverDefaults, extractThemeCoverCopy, DEFAULT_FALLBACK,
  resolveCoverCopy, applyCoverCopyToMeta,
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

const PRESET = { badgeText: 'ACID BOLD', defaultTag: '态度发声 · 拒绝平庸', volText: '2026 · VOL.01' };

describe('resolveCoverCopy', () => {
  it('五层链:主题 coverCopy > 全局默认 > 内置预设 > 兜底(每元素独立)', () => {
    const s = memStore();
    writeCoverDefaults(s, { tag: '全局标签', author: '全局作者' });
    const themeDef = { coverCopy: { badge: '主题徽章' } };
    const r = resolveCoverCopy({ themeDef, store: s, preset: PRESET });
    assert.deepEqual(r, { badge: '主题徽章', tag: '全局标签', author: '全局作者' });
  });
  it('全局默认压过内置预设(已确认语义)', () => {
    const s = memStore();
    writeCoverDefaults(s, { badge: '全局徽章' });
    const r = resolveCoverCopy({ themeDef: null, store: s, preset: PRESET });
    assert.equal(r.badge, '全局徽章');
    assert.equal(r.tag, PRESET.defaultTag);
    assert.equal(r.author, DEFAULT_FALLBACK.author);
  });
  it('无任何配置:内置预设优先,缺项落兜底', () => {
    const s = memStore();
    const r = resolveCoverCopy({ themeDef: null, store: s, preset: PRESET });
    assert.deepEqual(r, { badge: 'ACID BOLD', tag: '态度发声 · 拒绝平庸', author: '万舟智算' });
  });
  it('preset 缺省(null)时全部落兜底', () => {
    const r = resolveCoverCopy({ themeDef: null, store: memStore(), preset: null });
    assert.deepEqual(r, { badge: 'WZZS', tag: '万舟智算 · 教程系列', author: '万舟智算' });
  });
  it('themeDef 无 coverCopy 时等同 null', () => {
    const r = resolveCoverCopy({ themeDef: { baseId: 'x', override: {} }, store: memStore(), preset: PRESET });
    assert.equal(r.badge, 'ACID BOLD');
  });
  it('store 不可用时跳过全局层不抛错', () => {
    const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    const r = resolveCoverCopy({ themeDef: null, store: bad, preset: PRESET });
    assert.deepEqual(r, { badge: 'ACID BOLD', tag: '态度发声 · 拒绝平庸', author: '万舟智算' });
  });
});

describe('applyCoverCopyToMeta', () => {
  it('仅填空位,不覆盖显式值', () => {
    const meta = { author: '显式作者', badge: '' };
    const out = applyCoverCopyToMeta(meta, { badge: 'B', tag: 'T', author: 'A' });
    assert.deepEqual(out, { author: '显式作者', badge: 'B', tag: 'T' });
  });
  it('meta 为 null/undefined 安全返回空对象填充', () => {
    assert.deepEqual(applyCoverCopyToMeta(null, { badge: 'B', tag: 'T', author: 'A' }), { badge: 'B', tag: 'T', author: 'A' });
  });
});
