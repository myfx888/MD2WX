/** EdgeOne 入口集成测试：双调用形态 + env shim（EdgeOne KV 跑通 Hub 全链路） */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import entry from './.edgeone-entry.bundle.mjs';
import { onRequest } from './.edgeone-entry.bundle.mjs';
import { signToken } from '../hub-auth.js';
import { MockEdgeOneKV } from './mock-edgeone-kv.mjs';

const PW = 'hub-pw';
const req = (path, opts = {}) => new Request('https://edgeone.test' + path, opts);

function envWithKv() {
  return { HUB: new MockEdgeOneKV(), HUB_ADMIN_PASSWORD: PW };
}

async function seedPut(envObj, cat, proj, path, text) {
  const token = await signToken(PW);
  const res = await entry(req(`/api/hub/projects/${encodeURIComponent(cat)}/${encodeURIComponent(proj)}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'PUT', headers: { Authorization: 'Bearer ' + token }, body: text }), envObj, {});
  assert.equal(res.status, 200);
}

describe('入口调用形态双兼容', () => {
  it('默认导出存在，onRequest 具名导出可用', () => {
    assert.equal(typeof entry, 'function');
    assert.equal(typeof onRequest, 'function');
  });

  it('Workers 形态 fetch(request, env, ctx)', async () => {
    const res = await entry(req('/api/health'), envWithKv(), {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'md2wx-worker' });
  });

  it('Pages Functions 形态 onRequest({ request, env })', async () => {
    const res = await onRequest({ request: req('/api/health'), env: envWithKv() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'md2wx-worker' });
  });

  it('env 无 HUB 绑定时 Hub 预览 404 兜底（不抛异常）', async () => {
    const res = await entry(req('/hub/a/b'), {}, {});
    assert.equal(res.status, 404);
  });
});

describe('EdgeOne env shim：KV 绑定跑通 Hub', () => {
  let envObj;
  beforeEach(() => { envObj = envWithKv(); });

  it('中文键 PUT → /api/hub/projects 列表 → /hub/* 预览回源', async () => {
    await seedPut(envObj, '数据报告', '销量大屏', 'index.html', '<h1>大屏</h1>');
    await seedPut(envObj, '数据报告', '销量大屏', 'css/a.css', 'body{}');

    const list = await entry(req('/api/hub/projects'), envObj, {});
    const { code, categories } = await list.json();
    assert.equal(code, 0);
    assert.equal(categories[0].name, '数据报告');
    assert.equal(categories[0].projects[0].name, '销量大屏');
    assert.equal(categories[0].projects[0].entry, 'index.html');

    const root = await entry(req('/hub/' + encodeURIComponent('数据报告') + '/' + encodeURIComponent('销量大屏')), envObj, {});
    assert.equal(root.status, 302);
    assert.match(root.headers.get('Location'), /index\.html$/);

    const html = await entry(req('/hub/' + encodeURIComponent('数据报告') + '/' + encodeURIComponent('销量大屏') + '/index.html'), envObj, {});
    assert.equal(html.status, 200);
    assert.equal(await html.text(), '<h1>大屏</h1>');
    assert.equal(html.headers.get('Cache-Control'), 'public, max-age=300');

    const css = await entry(req('/hub/' + encodeURIComponent('数据报告') + '/' + encodeURIComponent('销量大屏') + '/css/a.css'), envObj, {});
    assert.equal(css.headers.get('Cache-Control'), 'public, max-age=86400');
  });

  it('API 响应带 Cache-Control: no-store（全站缓存上限约束）', async () => {
    const res = await entry(req('/api/themes'), envObj, {});
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });
});
