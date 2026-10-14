/**
 * MD2WX 封面工作台保存快照:主题/比例/6 文案字段一次性持久化,
 * 发布链路(推送导出/发布缩略图/正文顶部封面)按快照同源生成。
 * 纯逻辑层(零 DOM,store 可注入,Node 可测)。
 * 设计: docs/superpowers/specs/2026-10-13-cover-workbench-save-design.md
 */

export const COVER_WORKBENCH_KEY = 'md2wx_cover_workbench';

const SNAPSHOT_KEYS = ['title', 'digest', 'tag', 'badge', 'vol', 'author'];
const RATIOS = ['banner', 'square', 'dual'];

function safeStore(store) {
  try {
    store.getItem(COVER_WORKBENCH_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 读快照;store 不可用/非法 JSON/结构非法 -> null(调用方回落现状,绝不抛错) */
export function readCoverWorkbench(store) {
  if (!store || !safeStore(store)) return null;
  let raw;
  try {
    raw = store.getItem(COVER_WORKBENCH_KEY);
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
  if (typeof obj.themeId !== 'string' || !obj.themeId.trim()) return null;
  if (!RATIOS.includes(obj.ratio)) return null;
  const out = { themeId: obj.themeId.trim(), ratio: obj.ratio };
  for (const k of SNAPSHOT_KEYS) out[k] = typeof obj[k] === 'string' ? obj[k] : '';
  out.savedAt = typeof obj.savedAt === 'number' ? obj.savedAt : 0;
  return out;
}

/**
 * 写快照:白名单 8 字段(6 文案 trim)+ savedAt=Date.now()。
 * themeId 为空或 store 缺失 -> throw(调用方 toast);存储异常(如 quota)原样向上抛,不允许静默假成功。
 */
export function writeCoverWorkbench(store, snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const themeId = typeof snap.themeId === 'string' ? snap.themeId.trim() : '';
  if (!themeId) throw new Error('themeId 为空，拒绝保存');
  if (!store) throw new Error('存储不可用');
  const out = {
    themeId,
    ratio: RATIOS.includes(snap.ratio) ? snap.ratio : 'banner',
  };
  for (const k of SNAPSHOT_KEYS) out[k] = typeof snap[k] === 'string' ? snap[k].trim() : '';
  out.savedAt = Date.now();
  store.setItem(COVER_WORKBENCH_KEY, JSON.stringify(out));
}

/** 消费链路导出比例:双拼(3350x1000 手动裁剪素材)推送回落 banner;工作台内导出不经过此函数 */
export function coverExportRatio(ratio) {
  return ratio === 'dual' ? 'banner' : ratio;
}
