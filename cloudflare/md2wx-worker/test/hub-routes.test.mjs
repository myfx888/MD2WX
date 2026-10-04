/** hub 路由级测试：esbuild 打包后的 worker.fetch + MockR2 + mock 限流器 */
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
function makeEnv() {
  return { HUB: new MockR2(), HUB_ADMIN_PASSWORD: PW };
}
const req = (path, opts = {}) => new Request('https://worker.test' + path, opts);

async function login(password = PW) {
  const res = await worker.fetch(req('/api/hub/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  }), makeEnv(), {});
  return (await res.json()).token;
}

describe('POST /api/hub/login', () => {
  it('正确密码返回 token', async () => {
    const res = await worker.fetch(req('/api/hub/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    }), makeEnv(), {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.match(data.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('错误密码 → 401；未配置密码 → 500 fail-closed', async () => {
    const bad = await worker.fetch(req('/api/hub/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    }), makeEnv(), {});
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).msg, '密码错误或请求过于频繁');

    const unset = await worker.fetch(req('/api/hub/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    }), { HUB: new MockR2() }, {});
    assert.equal(unset.status, 500);
  });

  it('限流触发时同样返回 401 + 同文案（防探测）', async () => {
    const env = { ...makeEnv(), HUB_LOGIN_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await worker.fetch(req('/api/hub/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    }), env, {});
    assert.equal(res.status, 401);
    assert.equal((await res.json()).msg, '密码错误或请求过于频繁');
  });
});

describe('写路由鉴权', () => {
  it('无 token / 坏 token → 401；未配置密码 → 500', async () => {
    let res = await worker.fetch(req('/api/hub/projects/c/p/files/a.html', { method: 'PUT', body: 'x' }), makeEnv(), {});
    assert.equal(res.status, 401);
    res = await worker.fetch(req('/api/hub/projects/c/p/files/a.html', { method: 'PUT', headers: { Authorization: 'Bearer bad' }, body: 'x' }), makeEnv(), {});
    assert.equal(res.status, 401);
    res = await worker.fetch(req('/api/hub/projects/c/p/files/a.html', { method: 'PUT', body: 'x' }), { HUB: new MockR2() }, {});
    assert.equal(res.status, 500);
  });

  it('合法 token 可上传，路径非法 → 400', async () => {
    const token = await login();
    const good = await worker.fetch(req('/api/hub/projects/' + encodeURIComponent('分类') + '/' + encodeURIComponent('项目') + '/files/css%2Fa.css', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: 'body{}',
    }), makeEnv(), {});
    assert.equal(good.status, 200);

    const bad = await worker.fetch(req('/api/hub/projects/c/p/files/a%2F..%2Fb.html', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: 'x',
    }), makeEnv(), {});
    assert.equal(bad.status, 400);
  });

  it('超大 body → 413', async () => {
    const token = await login();
    const res = await worker.fetch(req('/api/hub/projects/c/p/files/big.bin', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'content-length': String(96 * 1024 * 1024) },
      body: 'x',
    }), makeEnv(), {});
    assert.equal(res.status, 413);
  });
});

describe('列表与删除路由', () => {
  let env; let token;
  beforeEach(async () => {
    env = makeEnv();
    token = await signToken(PW);
    const put = async (cat, proj, path, body) => worker.fetch(
      req(`/api/hub/projects/${encodeURIComponent(cat)}/${encodeURIComponent(proj)}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body }),
      env, {});
    await put('报告', 'demo', 'index.html', '<h1>hi</h1>');
    await put('报告', 'demo', 'css/a.css', 'body{}');
  });

  it('GET projects 返回分类树（无缓存环境直接回源）', async () => {
    const res = await worker.fetch(req('/api/hub/projects'), env, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    const cat = data.categories.find((c) => c.name === '报告');
    assert.equal(cat.projects[0].entry, 'index.html');
    assert.equal(cat.projects[0].fileCount, 2);
  });

  it('GET files 返回项目文件清单', async () => {
    const res = await worker.fetch(req('/api/hub/projects/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo') + '/files'), env, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.files.map((f) => f.path).sort(), ['css/a.css', 'index.html']);
  });

  it('DELETE 单文件 → 200；再删 → 404；DELETE 项目 → deleted:1', async () => {
    const one = await worker.fetch(req('/api/hub/projects/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo') + '/files/css%2Fa.css', {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    }), env, {});
    assert.equal(one.status, 200);

    const again = await worker.fetch(req('/api/hub/projects/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo') + '/files/css%2Fa.css', {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    }), env, {});
    assert.equal(again.status, 404);

    const proj = await worker.fetch(req('/api/hub/projects/' + encodeURIComponent('报告') + '/' + encodeURIComponent('demo'), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    }), env, {});
    assert.equal(proj.status, 200);
    assert.equal((await proj.json()).deleted, 1);
  });
});
