/**
 * EdgeOne KV 内存 mock：严格按官方语义实现（pages.edgeone.ai/zh/document/kv-storage）。
 * key 强制平台字符集（仅数字/字母/下划线，≤512B）；list 按 { prefix, limit≤256, cursor }
 * 返回 { complete, cursor, keys: [{ key }] }。适配层传进来的是已编码键，mock 不感知编码。
 */
const KEY_RE = /^[A-Za-z0-9_]+$/;

export class MockEdgeOneKV {
  constructor() { this.map = new Map(); }

  assertValidKey(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key) || Buffer.byteLength(key) > 512) {
      throw new Error(`EdgeOne KV key 非法: ${JSON.stringify(key)}`);
    }
  }

  async put(key, value) {
    this.assertValidKey(key);
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new TextEncoder().encode(String(value));
    this.map.set(key, bytes.slice().buffer);
  }

  async get(key, opts) {
    this.assertValidKey(key);
    const buf = this.map.get(key);
    if (buf === undefined) return null;
    const type = typeof opts === 'string' ? opts : opts && opts.type;
    if (type === 'arrayBuffer') return buf;
    if (type === 'json') return JSON.parse(new TextDecoder().decode(buf));
    return new TextDecoder().decode(buf);
  }

  async delete(key) {
    this.assertValidKey(key);
    this.map.delete(key);
  }

  async list({ prefix = '', limit = 256, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw new Error('EdgeOne KV list limit 必须为 1-256');
    }
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const slice = all.slice(offset, offset + limit);
    const next = offset + limit;
    return {
      keys: slice.map((key) => ({ key })),
      cursor: next < all.length ? String(next) : '',
      complete: next >= all.length,
    };
  }
}
