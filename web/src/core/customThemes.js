/**
 * MD2WX 主题工坊纯逻辑层：自定义主题 CRUD、导入导出。
 * 存储为差异覆盖 {baseId, override}；渲染走 getTheme(baseId, override) 现成管道。
 * 零 DOM 依赖（store 可注入，Node 下退化为内存 Map），可测。
 */
import { BUILTIN_THEMES } from './themes.js';

export const CUSTOM_STORE_KEY = 'md2wx_custom_themes';

export const CUSTOM_COLORS = [
  { key: 'accent', label: '强调色' },
  { key: 'accent_bg', label: '强调底色' },
  { key: 'text_color', label: '正文色' },
  { key: 'sub_color', label: '次级色' },
  { key: 'border_color', label: '边框色' },
  { key: 'code_bg', label: '代码底色' },
  { key: 'code_text', label: '代码字色' },
  { key: 'quote_bg', label: '引言底色' },
  { key: 'page_bg', label: '页面底色' },
];

export const CUSTOM_TYPOGRAPHY = [
  { key: 'font_size_base', label: '正文字号', min: 14, max: 17.5, step: 0.5, unit: 'px' },
  { key: 'line_height_base', label: '行距', min: 1.6, max: 2.1, step: 0.05, unit: '' },
  { key: 'letter_spacing', label: '字间距', min: 0, max: 1.5, step: 0.1, unit: 'px' },
];

export const FONT_STACKS = [
  { id: 'system', label: '系统默认', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { id: 'serif', label: '衬线', value: "Georgia, 'Times New Roman', serif" },
  { id: 'mono', label: '等宽', value: 'ui-monospace, Menlo, monospace' },
];

const OVERRIDE_KEYS = ['colors', 'typography'];

function defaultStore() {
  if (typeof localStorage !== 'undefined') return localStorage;
  // Node 环境（测试/SSR）内存兜底：模块级 Map 即持久语义
  if (!globalThis.__md2wxCustomThemeStore) {
    globalThis.__md2wxCustomThemeStore = new Map();
  }
  const m = globalThis.__md2wxCustomThemeStore;
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

function readAll(store) {
  try {
    const obj = JSON.parse(store.getItem(CUSTOM_STORE_KEY) || '{}');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeAll(obj, store) {
  store.setItem(CUSTOM_STORE_KEY, JSON.stringify(obj));
}

function genId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'custom-' + s;
}

function validOverride(override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return false;
  return Object.keys(override).every(
    (k) => OVERRIDE_KEYS.includes(k) && override[k] && typeof override[k] === 'object' && !Array.isArray(override[k])
  );
}

export function listCustomThemes(store = defaultStore()) {
  return Object.entries(readAll(store)).map(([id, t]) => ({ id, baseId: t.baseId, name: t.name }));
}

export function getCustomTheme(id, store = defaultStore()) {
  return readAll(store)[id] || null;
}

export function saveCustomTheme(idOrNull, { baseId, name, override }, store = defaultStore()) {
  if (!BUILTIN_THEMES[baseId]) return { ok: false, error: `baseId 不存在: ${baseId}` };
  if (!name || !String(name).trim()) return { ok: false, error: 'name 必填' };
  if (!validOverride(override)) return { ok: false, error: 'override 仅允许 colors/typography 对象' };
  const all = readAll(store);
  const id = idOrNull || genId();
  if (idOrNull && !all[idOrNull]) return { ok: false, error: `主题不存在: ${idOrNull}` };
  all[id] = { baseId, name: String(name).trim(), override };
  try {
    writeAll(all, store);
  } catch (e) {
    return { ok: false, error: '存储不可用' };
  }
  return { ok: true, id };
}

export function deleteCustomTheme(id, store = defaultStore()) {
  const all = readAll(store);
  if (!all[id]) return false;
  delete all[id];
  writeAll(all, store);
  return true;
}

export function exportCustomTheme(id, store = defaultStore()) {
  const t = getCustomTheme(id, store);
  if (!t) return { ok: false, error: `主题不存在: ${id}` };
  return { ok: true, json: JSON.stringify({ version: 1, ...t }, null, 2) };
}

export function importCustomTheme(jsonStr, store = defaultStore()) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonStr));
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败' };
  }
  const check = saveCustomTheme(null, { baseId: parsed.baseId, name: parsed.name, override: parsed.override }, store);
  if (!check.ok) return check;
  // 重名自动加后缀（save 已通过，此处仅处理 name 语义）
  const all = readAll(store);
  const saved = all[check.id];
  if (Object.values(all).filter((t) => t.name === saved.name).length > 1) {
    saved.name = saved.name + '导入';
    writeAll(all, store);
  }
  return { ok: true, id: check.id };
}

// 测试桥接：合并语义断言需要 themes.js 的 deepMerge/FALLBACK_BASE_THEME，
// 经 bundle 一并导出，避免 Node 直跑源码触发 JSON import 断言问题
export { deepMerge, FALLBACK_BASE_THEME } from './themes.js';
