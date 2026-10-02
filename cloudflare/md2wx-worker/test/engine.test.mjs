/**
 * MD2WX Worker 测试
 * 先用 esbuild 把 worker.js（连同 web/src/core 引擎与 JSON 主题）打成单文件 ESM，
 * 再用 Node 内建 test runner 直接调用 worker.fetch —— Node 24 自带 Request/Response 全局。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from './.worker.bundle.mjs';

function req(path, opts = {}) {
  return new Request('https://worker.test' + path, opts);
}

async function postJson(path, body, env = {}, headers = {}) {
  return worker.fetch(
    req(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
    {}
  );
}

describe('GET /api/health', () => {
  it('返回 ok 与服务名', async () => {
    const res = await worker.fetch(req('/api/health'), {}, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.service, 'md2wx-worker');
  });

  it('OPTIONS 预检返回 204 并带 CORS 头', async () => {
    const res = await worker.fetch(req('/api/convert', { method: 'OPTIONS' }), {}, {});
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('未知 API 路由返回 404', async () => {
    const res = await worker.fetch(req('/api/nope'), {}, {});
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.code, 1);
  });
});
