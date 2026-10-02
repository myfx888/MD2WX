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

describe('GET /api/themes', () => {
  it('返回 9 个内置主题，含 id/name', async () => {
    const res = await worker.fetch(req('/api/themes'), {}, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.themes.length, 9);
    for (const t of data.themes) {
      assert.ok(t.id && t.name);
    }
  });
});

describe('POST /api/convert', () => {
  const MD_WITH_FM = '---\ntitle: 你好标题\ndigest: 你好摘要\n---\n\n# Hi\n\n正文内容';

  it('frontmatter 标题摘要被提取，产物含内联样式', async () => {
    const res = await postJson('/api/convert', { markdown: MD_WITH_FM });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.title, '你好标题');
    assert.equal(data.digest, '你好摘要');
    assert.equal(data.theme, 'tech-blue');
    assert.ok(data.html.includes('<section style='));
  });

  it('未知主题回退默认主题', async () => {
    const res = await postJson('/api/convert', { markdown: MD_WITH_FM, theme: 'no-such-theme' });
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.theme, 'tech-blue');
  });

  it('sample_article.md 全 9 主题转换冒烟', async () => {
    const { readFileSync } = await import('node:fs');
    const sample = readFileSync(new URL('../../../sample_article.md', import.meta.url), 'utf-8');
    const themesRes = await worker.fetch(req('/api/themes'), {}, {});
    const { themes } = await themesRes.json();
    for (const t of themes) {
      const res = await postJson('/api/convert', { markdown: sample, theme: t.id });
      assert.equal(res.status, 200, `theme ${t.id} 应转换成功`);
      const data = await res.json();
      assert.ok(data.html.includes('<section style='), `theme ${t.id} 产物应含内联样式`);
    }
  });

  it('缺少 markdown 返回 400', async () => {
    const res = await postJson('/api/convert', {});
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, 1);
    assert.ok(data.msg.includes('markdown'));
  });

  it('非法 JSON 返回 400', async () => {
    const res = await worker.fetch(req('/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    }), {}, {});
    assert.equal(res.status, 400);
  });
});
