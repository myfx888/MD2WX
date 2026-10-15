/** edgeone-kv 适配层测试：EdgeOne KV mock 顶替绑定，校验编码/透传/目录模拟 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeOneHubKV, wrapHubBinding } from '../edgeone-kv.js';
import { listProjects, listFiles, putFile, deleteFile, deleteProject } from '../hub-store.js';
import { MockEdgeOneKV } from './mock-edgeone-kv.mjs';

/** 与现有测试同款的最小 R2 内存实现（验证 r2 形态直通） */
class MockR2 {
  constructor() { this.map = new Map(); }
  async put(key, value) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new TextEncoder().encode(String(value));
    this.map.set(key, { bytes, size: bytes.byteLength, uploaded: new Date() });
  }
  async get(key) {
    const o = this.map.get(key);
    if (!o) return null;
    return { key, size: o.size, uploaded: o.uploaded, arrayBuffer: async () => o.bytes.slice().buffer };
  }
  async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k); }
  async list({ prefix = '', delimiter } = {}) {
    const objects = []; const delimitedPrefixes = new Set();
    for (const k of [...this.map.keys()].filter((x) => x.startsWith(prefix)).sort()) {
      const rest = k.slice(prefix.length);
      if (delimiter) {
        const i = rest.indexOf(delimiter);
        if (i >= 0) { delimitedPrefixes.add(prefix + rest.slice(0, i + delimiter.length)); continue; }
      }
      const o = this.map.get(k);
      objects.push({ key: k, size: o.size, uploaded: o.uploaded });
    }
    return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated: false };
  }
}

const enc = new TextEncoder();

async function seed(kv, key, text) {
  await kv.put(key, enc.encode(text).buffer);
}

describe('key 编码（EdgeOne 字符集合规）', () => {
  let ns; let kv;
  beforeEach(() => { ns = new MockEdgeOneKV(); kv = new EdgeOneHubKV(ns); });

  it('put 后底层存储键只含数字/字母/下划线，get 可还原', async () => {
    await seed(kv, '可视化报告/项目A/index.html', '<h1>你好</h1>');
    const keys = [...ns.map.keys()];
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^[A-Za-z0-9_]+$/);
    const obj = await kv.get('可视化报告/项目A/index.html');
    assert.equal(new TextDecoder().decode(await obj.arrayBuffer()), '<h1>你好</h1>');
    assert.equal(obj.size, enc.encode('<h1>你好</h1>').byteLength);
  });

  it('get 不存在的键返回 null（区分平台空值语义）', async () => {
    assert.equal(await kv.get('no/such/key.png'), null);
  });

  it('二进制内容（PNG 字节）roundtrip 不损坏', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xab]);
    await kv.put('图/封/cover.png', png.buffer);
    const obj = await kv.get('图/封/cover.png');
    assert.deepEqual(new Uint8Array(await obj.arrayBuffer()), png);
  });
});

describe('list 目录模拟（delimiter）', () => {
  let kv;
  beforeEach(async () => {
    const ns = new MockEdgeOneKV();
    kv = new EdgeOneHubKV(ns);
    await seed(kv, '报告/demo/index.html', 'a');
    await seed(kv, '报告/demo/css/a.css', 'b');
    await seed(kv, '报告/大屏/index.html', 'c');
    await seed(kv, '可视化/x/index.html', 'd');
  });

  it('根级 delimiter 得到分类前缀', async () => {
    const r = await kv.list({ delimiter: '/' });
    // JS 字符序：可(U+53EF) < 报(U+62A5)；hub-store 消费前会自行 sort，顺序不敏感
    assert.deepEqual(r.delimitedPrefixes, ['可视化/', '报告/']);
    assert.equal(r.objects.length, 0);
  });

  it('分类前缀下 delimiter 得到项目前缀', async () => {
    const r = await kv.list({ prefix: '报告/', delimiter: '/' });
    assert.deepEqual(r.delimitedPrefixes, ['报告/demo/', '报告/大屏/']);
  });

  it('项目全量 list 返回 objects（无 size/uploaded 透传 undefined）', async () => {
    const r = await kv.list({ prefix: '报告/demo/' });
    assert.deepEqual(r.objects.map((o) => o.key), ['报告/demo/css/a.css', '报告/demo/index.html']);
    for (const o of r.objects) {
      assert.equal(o.size, undefined);
      assert.equal(o.uploaded, undefined);
    }
  });

  it('跨多页翻页（KV limit 256 强制小页时也不丢键）', async () => {
    const ns = new MockEdgeOneKV();
    const small = {
      async put(k, v) { return ns.put(k, v); },
      async get(k, o) { return ns.get(k, o); },
      async delete(k) { return ns.delete(k); },
      async list(opts) { return ns.list({ ...opts, limit: 2 }); },
    };
    const kvs = new EdgeOneHubKV(small);
    for (let i = 0; i < 5; i++) await seed(kvs, `报告/demo/f${i}.html`, String(i));
    const r = await kvs.list({ prefix: '报告/demo/' });
    assert.equal(r.objects.length, 5);
    assert.equal(r.complete, true);
  });
});

describe('r2 形态直通（不二次编码）', () => {
  it('MockR2 绑定被透传：键保持原文，size/uploaded 保留', async () => {
    const r2 = new MockR2();
    const kv = wrapHubBinding(r2);
    assert.notEqual(kv, r2); // 包一层适配器，但探测为 r2 形态后行为完全透传
    await kv.put('分类/项目/a.html', enc.encode('hi').buffer);
    assert.ok(r2.map.has('分类/项目/a.html'));
    const obj = await kv.get('分类/项目/a.html');
    assert.equal(obj.size, 2);
    assert.ok(obj.uploaded instanceof Date);
    const rAll = await kv.list({});
    assert.equal(rAll.objects[0].size, 2);
    const r = await kv.list({ delimiter: '/' });
    assert.deepEqual(r.delimitedPrefixes, ['分类/']);
  });

  it('探测失败按 r2 透传（错误原样冒出）', async () => {
    const broken = { get: async () => { throw new Error('boom'); }, list: async () => { throw new Error('list boom'); } };
    const kv = new EdgeOneHubKV(broken);
    await assert.rejects(() => kv.list({}), /list boom/);
  });
});

describe('hub-store 全链路跑在 EdgeOne KV 上', () => {
  let env;
  beforeEach(() => {
    const ns = new MockEdgeOneKV();
    env = { HUB: new EdgeOneHubKV(ns) };
  });

  it('putFile → listProjects → listFiles → deleteFile → deleteProject', async () => {
    await putFile(env, '报告', 'demo', 'index.html', '<h1>hi</h1>');
    await putFile(env, '报告', 'demo', 'css/a.css', 'body{}');

    const cats = await listProjects(env);
    assert.equal(cats.length, 1);
    assert.equal(cats[0].name, '报告');
    assert.equal(cats[0].projects[0].name, 'demo');
    assert.equal(cats[0].projects[0].entry, 'index.html');
    assert.equal(cats[0].projects[0].updatedAt, null); // EdgeOne 无 uploaded

    const files = await listFiles(env, '报告', 'demo');
    assert.deepEqual(files.map((f) => f.path), ['css/a.css', 'index.html']);
    assert.equal(files[0].size, null);
    assert.equal(files[0].updatedAt, null);

    assert.equal(await deleteFile(env, '报告', 'demo', 'css/a.css'), true);
    assert.equal(await deleteFile(env, '报告', 'demo', 'css/a.css'), false);
    assert.equal(await deleteProject(env, '报告', 'demo'), 1);
    assert.deepEqual(await listProjects(env), []);
  });
});
