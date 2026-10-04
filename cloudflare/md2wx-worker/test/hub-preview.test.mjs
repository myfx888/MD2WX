/** /hub/* 预览回源测试 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from './.worker.bundle.mjs';
import { signToken } from '../hub-auth.js';

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
    return { key, size: o.size, uploaded: o.uploaded, arrayBuffer: async () => o.bytes.slice().buffer, text: async () => new TextDecoder().decode(o.bytes) };
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

const PW = 'hub-pw';
const env = () => ({ HUB: new MockR2(), HUB_ADMIN_PASSWORD: PW });
const req = (path, opts = {}) => new Request('https://worker.test' + path, opts);

async function seedPut(envObj, cat, proj, path, text) {
  const token = await signToken(PW);
  await worker.fetch(req(`/api/hub/projects/${encodeURIComponent(cat)}/${encodeURIComponent(proj)}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: text }), envObj, {});
}

describe('GET /hub/* 预览', () => {
  let e;
  beforeEach(async () => {
    e = env();
    await seedPut(e, '报告', 'demo', 'index.html', '<h1>hi</h1>');
    await seedPut(e, '报告', 'demo', 'css/a.css', 'body{}');
  });

  it('项目根路径 302 到入口 index.html', async () => {
    const res = await worker.fetch(req('/hub/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo')), e, {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), '/hub/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo') + '/index.html');
  });

  it('按扩展名返回 Content-Type 与内容', async () => {
    const html = await worker.fetch(req('/hub/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo') + '/index.html'), e, {});
    assert.equal(html.status, 200);
    assert.match(html.headers.get('Content-Type'), /^text\/html/);
    assert.match(html.headers.get('Cache-Control'), /max-age=300/);
    assert.equal(await html.text(), '<h1>hi</h1>');

    const css = await worker.fetch(req('/hub/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo') + '/css%2Fa.css'), e, {});
    assert.match(css.headers.get('Content-Type'), /^text\/css/);
    assert.match(css.headers.get('Cache-Control'), /max-age=86400/);
  });

  it('未知文件 → 404 HTML 页（含返回链接）', async () => {
    const res = await worker.fetch(req('/hub/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo') + '/nope.html'), e, {});
    assert.equal(res.status, 404);
    assert.match(res.headers.get('Content-Type'), /^text\/html/);
    assert.match(await res.text(), /返回作品 Hub/);
  });

  it('穿越路径（..）→ 404 HTML', async () => {
    const res = await worker.fetch(req('/hub/c/p/a%2F..%2Fb.html'), e, {});
    assert.equal(res.status, 404);
  });

  it('无 html 的项目 302 也无目标 → 404 HTML', async () => {
    await seedPut(e, 'c', 'empty', 'readme.md', 'md');
    const res = await worker.fetch(req('/hub/c/empty'), e, {});
    assert.equal(res.status, 404);
  });
});
