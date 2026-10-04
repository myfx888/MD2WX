/**
 * 主题工坊纯逻辑层测试：esbuild 打包 web/src/core/customThemes.js 后用 node --test 断言
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_COLORS, CUSTOM_TYPOGRAPHY, FONT_STACKS, CUSTOM_STORE_KEY,
  listCustomThemes, getCustomTheme, saveCustomTheme, deleteCustomTheme,
  exportCustomTheme, importCustomTheme, deepMerge, FALLBACK_BASE_THEME,
} from './.custom.bundle.mjs';

function mockStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

describe('常量清单', () => {
  it('九色清单 key 与 label 齐全', () => {
    assert.equal(CUSTOM_COLORS.length, 9);
    assert.ok(CUSTOM_COLORS.every((c) => c.key && c.label));
    assert.deepEqual(CUSTOM_COLORS.map((c) => c.key).slice(0, 2), ['accent', 'accent_bg']);
  });
  it('排版清单含字号/行距/字间距', () => {
    assert.deepEqual(CUSTOM_TYPOGRAPHY.map((t) => t.key), ['font_size_base', 'line_height_base', 'letter_spacing']);
  });
  it('字体栈三种', () => {
    assert.deepEqual(FONT_STACKS.map((f) => f.id), ['system', 'serif', 'mono']);
  });
});

describe('save/list/get/delete 往返', () => {
  it('保存新主题生成 custom- 前缀 id', () => {
    const store = mockStore();
    const r = saveCustomTheme(null, { baseId: 'tech-blue', name: '我的蓝', override: { colors: { accent: '#ff0000' } } }, store);
    assert.equal(r.ok, true);
    assert.match(r.id, /^custom-[a-z0-9]{6}$/);
    const list = listCustomThemes(store);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '我的蓝');
    assert.equal(getCustomTheme(r.id, store).baseId, 'tech-blue');
  });

  it('更新已有 id 不新增条目', () => {
    const store = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'vintage-news', name: 'A', override: {} }, store);
    saveCustomTheme(id, { baseId: 'vintage-news', name: 'B', override: { colors: { accent: '#123456' } } }, store);
    assert.equal(listCustomThemes(store).length, 1);
    assert.equal(getCustomTheme(id, store).name, 'B');
  });

  it('baseId 不在内置主题 -> 拒绝', () => {
    const r = saveCustomTheme(null, { baseId: 'no-such', name: 'X', override: {} }, mockStore());
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('baseId'));
  });

  it('name 为空 -> 拒绝；override 含非法键 -> 拒绝', () => {
    const s = mockStore();
    assert.equal(saveCustomTheme(null, { baseId: 'tech-blue', name: '  ', override: {} }, s).ok, false);
    assert.equal(saveCustomTheme(null, { baseId: 'tech-blue', name: 'X', override: { styles: { h1: 'underline' } } }, s).ok, false);
  });

  it('重名允许（id 唯一即可）', () => {
    const s = mockStore();
    saveCustomTheme(null, { baseId: 'tech-blue', name: '同名', override: {} }, s);
    const r = saveCustomTheme(null, { baseId: 'tech-blue', name: '同名', override: {} }, s);
    assert.equal(r.ok, true);
    assert.equal(listCustomThemes(s).length, 2);
  });

  it('deleteCustomTheme 删除并返回 true，删不存在返回 false', () => {
    const s = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'tech-blue', name: 'D', override: {} }, s);
    assert.equal(deleteCustomTheme(id, s), true);
    assert.equal(deleteCustomTheme(id, s), false);
    assert.deepEqual(listCustomThemes(s), []);
  });
});

describe('合并语义（getTheme 兼容）', () => {
  it('override 仅覆盖指定字段，其余保持基础主题值', () => {
    const override = { colors: { accent: '#ff0000' }, typography: { font_size_base: '17px' } };
    const base = FALLBACK_BASE_THEME;
    const merged = deepMerge(deepMerge({}, base), override);
    assert.equal(merged.colors.accent, '#ff0000');
    assert.equal(merged.typography.font_size_base, '17px');
    assert.equal(merged.colors.code_bg, base.colors.code_bg);
    assert.equal(merged.styles.h1, base.styles.h1);
  });
});

describe('export/import 回环', () => {
  it('导出为 version:1 JSON，导入还原 override', () => {
    const s = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'warm-memo', name: '便签变体', override: { colors: { page_bg: '#fffbeb' } } }, s);
    const { ok, json } = exportCustomTheme(id, s);
    assert.equal(ok, true);
    const parsed = JSON.parse(json);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.baseId, 'warm-memo');

    const s2 = mockStore();
    const imp = importCustomTheme(json, s2);
    assert.equal(imp.ok, true);
    assert.equal(getCustomTheme(imp.id, s2).override.colors.page_bg, '#fffbeb');
  });

  it('导入拒绝坏 JSON / 未知 baseId / 非法键', () => {
    const s = mockStore();
    assert.equal(importCustomTheme('{broken', s).ok, false);
    assert.equal(importCustomTheme(JSON.stringify({ version: 1, baseId: 'nope', name: 'X', override: {} }), s).ok, false);
    assert.equal(importCustomTheme(JSON.stringify({ version: 1, baseId: 'tech-blue', name: 'X', override: { styles: {} } }), s).ok, false);
  });

  it('导入重名自动加「导入」后缀', () => {
    const s = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'tech-blue', name: '主题A', override: {} }, s);
    const { json } = exportCustomTheme(id, s);
    const imp = importCustomTheme(json, s);
    assert.equal(imp.ok, true);
    assert.notEqual(imp.id, id);
    assert.equal(getCustomTheme(imp.id, s).name, '主题A导入');
  });
});
