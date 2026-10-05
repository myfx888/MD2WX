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

// 9 大组件的视觉骨架变体（与 parser.js 各渲染函数的 style === 'x' 分支逐一核对，2026-10-05）
// 每个组件的 variants 均含默认变体（parser 兜底分支），下拉可直接选回默认
export const CUSTOM_STYLES = [
  { key: 'container', label: '容器', variants: [
    { id: 'clean', label: '极简白' }, { id: 'paper', label: '牛皮纸微框' }, { id: 'dark', label: '曜石纯黑' },
    { id: 'card', label: '悬浮卡片' }, { id: 'memo', label: '日系便签' }, { id: 'brutalist', label: '新野兽派' },
  ]},
  { key: 'h1', label: '一级标题', variants: [
    { id: 'underline', label: '下划粗线' }, { id: 'double_line', label: '古典双线' }, { id: 'capsule', label: '胶囊药丸' },
    { id: 'terminal', label: '终端命令行' }, { id: 'brutalist', label: '黑框硬投影' },
  ]},
  { key: 'h2', label: '二级标题', variants: [
    { id: 'left_bar', label: '左侧竖条' }, { id: 'bottom_line', label: '底部细线' }, { id: 'pill_badge', label: '药丸徽章' },
    { id: 'bubble_bg', label: '气泡底色' }, { id: 'serif_badge', label: '衬线徽章' }, { id: 'terminal_prompt', label: '终端提示符' },
    { id: 'brutalist_box', label: '硬框投影' },
  ]},
  { key: 'h3', label: '三级标题', variants: [
    { id: 'diamond', label: '菱形' }, { id: 'circle_badge', label: '圆形徽章' }, { id: 'highlight_bg', label: '高亮底色' },
    { id: 'slash', label: '斜杠' },
  ]},
  { key: 'quote', label: '引用', variants: [
    { id: 'left_stripe', label: '左侧条纹' }, { id: 'elegant_quote', label: '优雅引号' }, { id: 'bubble_card', label: '气泡卡片' },
    { id: 'paper_memo', label: '便签纸' }, { id: 'terminal_box', label: '终端框' }, { id: 'brutalist', label: '硬边框' },
  ]},
  { key: 'code', label: '代码块', variants: [
    { id: 'mac_dark', label: '苹果暗色' }, { id: 'terminal', label: '终端' }, { id: 'clean_flat', label: '极简平' },
  ]},
  { key: 'table', label: '表格', variants: [
    { id: 'zebra', label: '斑马纹' }, { id: 'three_line', label: '学术三线表' }, { id: 'grid', label: '全网格' },
  ]},
  { key: 'list', label: '列表', variants: [
    { id: 'bullet', label: '圆点' }, { id: 'diamond', label: '菱形' }, { id: 'square', label: '方点' }, { id: 'arrow', label: '箭头' },
  ]},
  { key: 'hr', label: '分割线', variants: [
    { id: 'line', label: '细线' }, { id: 'gradient', label: '渐变线' }, { id: 'asterisk', label: '星号' }, { id: 'terminal_dash', label: '虚线终端' },
  ]},
];

const OVERRIDE_KEYS = ['colors', 'typography', 'styles'];

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
  return Object.keys(override).every((k) => {
    if (k === 'styles') {
      // styles 键值须在 CUSTOM_STYLES 白名单内
      const st = override[k];
      if (!st || typeof st !== 'object' || Array.isArray(st)) return false;
      const known = new Map(CUSTOM_STYLES.map((c) => [c.key, new Set(c.variants.map((v) => v.id))]));
      return Object.entries(st).every(([comp, val]) => known.get(comp)?.has(val));
    }
    return OVERRIDE_KEYS.includes(k) && override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]);
  });
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
