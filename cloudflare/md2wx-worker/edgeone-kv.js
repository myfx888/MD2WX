/**
 * EdgeOne KV -> hub-store 所需 R2 接口适配层（仅 EdgeOne 部署经过本文件，
 * Cloudflare 部署直接使用 R2，不经过此适配）。
 *
 * 平台差异（官方文档 pages.edgeone.ai/zh/document/kv-storage）：
 *   - key 仅允许数字/字母/下划线（无斜杠/点/连字符/中文）：Hub 原始键
 *     （<分类>/<项目>/<路径>）以 hex 编码后存储（每字节 2 个 0-9a-f 字符，严格合法；
 *     原始键 UTF-8 需 ≤ 256 字节，超长键只能走 Cloudflare R2 部署）；编码不保持前缀
 *     对应，因此 list 无法用编码前缀做 KV 侧过滤，只能全量翻页后在内存按解码后
 *     前缀筛选；
 *   - list({ prefix?, limit?, cursor? }) 返回 { complete, cursor, keys: [{ key }] }，
 *     不支持 delimiter，也没有 size/uploaded —— delimiter 由本层在内存模拟，
 *     size/uploaded 以 undefined 透传（hub-store 已做缺失容错）；
 *   - get(key, { type: 'arrayBuffer' }) 返回 ArrayBuffer，值上限 25MB（大文件场景仍用 R2 部署）。
 *
 * 适配器带形态自识别：首个操作先探测一次 list 返回结构，若绑定本身已是 R2 形态
 * （返回 objects/delimitedPrefixes，如 Cloudflare R2 或测试 MockR2），则全部原样透传，
 * 不做编码 —— 因此入口层可以无条件包裹，Cloudflare 复用同一入口也不会被二次编码。
 */

const EDGEONE_LIST_PAGE = 256; // EdgeOne list 单页上限
const LIST_GUARD = 1000;       // 翻页安全上限（256 * 1000 键，远超 Hub 规模）

// hex 编码：EdgeOne key 仅允许数字/字母/下划线，0-9a-f 是其严格子集；
// base64/base64url 不可用（+/= 与 - 均不在合法字符集内）
function encodeKey(key) {
  const bytes = new TextEncoder().encode(key);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function decodeKey(encoded) {
  const bytes = new Uint8Array(encoded.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(encoded.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

const wrappedBindings = new WeakMap();

export function wrapHubBinding(ns) {
  if (!ns || typeof ns.get !== 'function' || typeof ns.list !== 'function') return ns;
  // 同一绑定只包一次并记忆（入口每个请求都会调用，避免重复探测）
  if (wrappedBindings.has(ns)) return wrappedBindings.get(ns);
  const adapter = new EdgeOneHubKV(ns);
  wrappedBindings.set(ns, adapter);
  return adapter;
}

export class EdgeOneHubKV {
  constructor(ns) {
    this.ns = ns;
    this.mode = null; // 'edgeone' | 'r2'，首次操作探测后固定
  }

  async detect() {
    if (this.mode) return this.mode;
    try {
      const probe = await this.ns.list({ limit: 1 });
      this.mode = probe && Array.isArray(probe.keys) && !Array.isArray(probe.objects)
        ? 'edgeone'
        : 'r2';
    } catch {
      this.mode = 'r2'; // 探测失败按原样透传，让平台错误原封不动冒出来
    }
    return this.mode;
  }

  async put(key, value) {
    if ((await this.detect()) === 'r2') return this.ns.put(key, value);
    return this.ns.put(encodeKey(key), value);
  }

  async get(key) {
    if ((await this.detect()) === 'r2') return this.ns.get(key);
    const v = await this.ns.get(encodeKey(key), { type: 'arrayBuffer' });
    if (v === null || v === undefined) return null;
    return { key, size: v.byteLength, arrayBuffer: async () => v };
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    if ((await this.detect()) === 'r2') return this.ns.delete(list);
    for (const k of list) await this.ns.delete(encodeKey(k));
  }

  async list(opts = {}) {
    if ((await this.detect()) === 'r2') return this.ns.list(opts);
    const { prefix = '', delimiter } = opts;
    const objects = [];
    const delimitedPrefixes = new Set();
    let cursor;
    let complete = false;
    let pages = 0;
    do {
      const page = await this.ns.list({ limit: EDGEONE_LIST_PAGE, ...(cursor ? { cursor } : {}) });
      complete = page.complete !== false;
      cursor = page.cursor;
      for (const item of page.keys || []) {
        const key = decodeKey(item.key);
        if (prefix && !key.startsWith(prefix)) continue;
        if (delimiter) {
          const i = key.indexOf(delimiter, prefix.length);
          if (i >= 0) { delimitedPrefixes.add(key.slice(0, i + delimiter.length)); continue; }
        }
        objects.push({ key, size: undefined, uploaded: undefined });
      }
    } while (!complete && cursor && ++pages < LIST_GUARD);
    objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      objects,
      delimitedPrefixes: [...delimitedPrefixes].sort(),
      truncated: false,
      complete: true,
    };
  }
}
