/**
 * MD2WX 封面默认文案两层自定义:全局品牌默认值(localStorage)+ 自定义主题 coverCopy。
 * 纯逻辑层(零 DOM,store 可注入,Node 可测);解析链每元素独立回落:
 *   frontmatter(调用方先行) > 主题 coverCopy > 全局默认 > 内置预设 > 硬编码兜底
 */

export const COVER_DEFAULTS_KEY = 'md2wx_cover_defaults';

/** 最底层硬编码兜底(与既有渲染字面量逐字一致) */
export const DEFAULT_FALLBACK = Object.freeze({
  badge: 'WZZS',
  tag: '万舟智算 · 教程系列',
  author: '万舟智算',
});

const COPY_KEYS = ['badge', 'tag', 'author'];

function safeStore(store) {
  try {
    store.getItem(COVER_DEFAULTS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 全局默认读取:只返回非空字段;无有效字段/不可用/非法 JSON -> null */
export function readCoverDefaults(store) {
  if (!store || !safeStore(store)) return null;
  let raw;
  try {
    raw = store.getItem(COVER_DEFAULTS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const k of COPY_KEYS) {
    if (typeof obj[k] === 'string' && obj[k].trim()) out[k] = obj[k].trim();
  }
  return Object.keys(out).length ? out : null;
}

/** 全局默认写入:空串字段剔除;三个全空即删键;存储不可用静默 */
export function writeCoverDefaults(store, partial) {
  if (!store || !safeStore(store)) return;
  const merged = { ...(readCoverDefaults(store) || {}), ...(partial || {}) };
  const out = {};
  for (const k of COPY_KEYS) {
    if (typeof merged[k] === 'string' && merged[k].trim()) out[k] = merged[k].trim();
  }
  try {
    if (Object.keys(out).length === 0) store.removeItem(COVER_DEFAULTS_KEY);
    else store.setItem(COVER_DEFAULTS_KEY, JSON.stringify(out));
  } catch {
    // 存储不可用静默(隐私模式)
  }
}

/** 自定义主题 coverCopy 提取:非法/缺字段/全空 -> null;只认三键的非空字符串 */
export function extractThemeCoverCopy(themeDef) {
  const cc = themeDef && typeof themeDef === 'object' ? themeDef.coverCopy : null;
  if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return null;
  const out = {};
  for (const k of COPY_KEYS) {
    if (typeof cc[k] === 'string' && cc[k].trim()) out[k] = cc[k].trim();
  }
  return Object.keys(out).length ? out : null;
}
