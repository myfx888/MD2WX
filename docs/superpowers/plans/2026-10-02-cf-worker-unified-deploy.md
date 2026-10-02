# MD2WX 一体化 Cloudflare Worker 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个 Cloudflare Worker 承载 MD2WX 整站静态托管 + 公开转换 API + 微信草稿箱推送 API，并在 Web Studio 中集成推送按钮。

**Architecture:** 新增 `cloudflare/md2wx-worker/`，Worker 代码跨目录直引 `web/src/core/` 四个无 DOM 依赖的引擎模块（parser/themes/highlighter/cover），用 wrangler Workers Static Assets 托管 `web/dist`，`run_worker_first` 保证 `/api/*` 优先。推送逻辑自外部 worker-deploy.js 1:1 移植，响应契约保持兼容。

**Tech Stack:** Cloudflare Workers (Static Assets + Ratelimits)、wrangler v4、esbuild（测试打包）、原生 ESM、Node 内建 test runner。零运行时依赖。

**设计文档:** `docs/superpowers/specs/2026-10-02-cf-worker-unified-deploy-design.md`

## Global Constraints

- 所有命令在 `E:\code\opensaas\zcodeapi\gzh\MD2WX` 仓库根执行（Git Bash / Windows），除非步骤明确写明其他目录。
- 引擎模块 `web/src/core/parser.js`、`themes.js`、`highlighter.js`、`cover.js` **禁止结构性重构**；仅当发现真实浏览器 API 引用导致 Worker 运行失败时，允许最小化就地修复并在提交信息中说明。
- Worker 运行时零 npm 依赖；devDependencies 仅允许 `esbuild`、`wrangler`。
- 仓库要求：Web 端代码改动后必须 `npm run build` 通过；Python 端不涉及。
- `/api/draft` 响应契约必须与外部 worker-deploy.js 完全兼容：成功 `{code:0, media_id}`，失败 `{code:1, msg}`。
- 鉴权 fail-closed：`DRAFT_API_KEY` 未配置时 `/api/draft` 返回 500 拒绝，绝不降级为无鉴权开放。
- `compatibility_date = "2025-06-01"`；Worker 名 `md2wx-worker`。
- 主题有效性判定统一用 `resolveThemeId()`：请求主题不在 `BUILTIN_THEMES` 中时回退 `DEFAULT_THEME_ID`（'tech-blue'）。
- devlog 编写规则（AGENTS.md）：主标题 ≤20 字、frontmatter `digest` ≤50 字、**不填 `cover` 字段**、语言平实无公关腔。

---

### Task 1: Worker 工程骨架、测试基建与 /api/health

**Files:**
- Create: `cloudflare/md2wx-worker/package.json`
- Create: `cloudflare/md2wx-worker/wrangler.toml`
- Create: `cloudflare/md2wx-worker/worker.js`
- Create: `cloudflare/md2wx-worker/test/engine.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: 默认导出 `worker.default.fetch(request, env, ctx)`（Workers 标准签名，可在 Node 测试中直接调用）；`json(obj, status)` 响应助手；CORS 头常量 `CORS_HEADERS`；npm script `npm test`（esbuild 打包 + node --test）。后续任务在 worker.js 内追加路由，测试文件内追加用例。

- [ ] **Step 1: 创建 worker 目录与 package.json**

写入 `cloudflare/md2wx-worker/package.json`：

```json
{
  "name": "md2wx-worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build:test": "esbuild worker.js --bundle --format=esm --outfile=test/.worker.bundle.mjs",
    "test": "npm run build:test && node --test test/",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: 写入 wrangler.toml**

写入 `cloudflare/md2wx-worker/wrangler.toml`：

```toml
name = "md2wx-worker"
main = "worker.js"
compatibility_date = "2025-06-01"

# 整站静态资产：部署前先在 web/ 目录执行 npm ci && npm run build 生成 web/dist
# 风险预案：若 wrangler 拒绝父级相对路径，改用 predeploy 脚本把 web/dist 复制到本目录 assets/ 并将 directory 改为 "assets"
[assets]
directory = "../../web/dist"
binding = "ASSETS"
run_worker_first = ["/api/*"]

# /api/convert 公开转换限流：单 IP 每 60 秒最多 60 次
[[ratelimits]]
name = "CONVERT_RATE_LIMITER"
namespace_id = "1002"

  [ratelimits.simple]
  limit = 60
  period = 60

# 密钥一律走 wrangler secret put（本地开发用 .dev.vars，勿提交）：
#   DRAFT_API_KEY      /api/draft 鉴权 Key；未配置则推送接口直接拒绝（fail-closed）
#   WECHAT_APPID       微信 appid 兜底（请求体 appid 优先）
#   WECHAT_APPSECRET   微信 secret 兜底（请求体 secret 优先）
```

- [ ] **Step 3: 追加 .gitignore 条目**

在 `.gitignore` 末尾追加：

```
# Worker 本地密钥与测试打包产物
.dev.vars
cloudflare/md2wx-worker/test/.worker.bundle.mjs
```

- [ ] **Step 4: 写入 worker.js 骨架（仅 health 路由）**

写入 `cloudflare/md2wx-worker/worker.js`：

```js
/**
 * MD2WX 一体化 Worker：整站静态托管（Workers Assets）+ Markdown 转换 API + 微信草稿箱推送
 *
 * 路由（本任务先实现 /api/health，其余路由由后续任务追加）：
 *   GET  /api/health   健康检查
 *   GET  /api/themes   枚举内置主题
 *   POST /api/convert  公开转换（markdown -> 微信内联 HTML）
 *   POST /api/draft    草稿推送（X-API-Key 或 ?key= 鉴权）
 *
 * 非 /api 请求由 wrangler [assets] 直接托管 web/dist，不进入本 Worker 的路由逻辑。
 *
 * 密钥 (wrangler secret / .dev.vars)：
 *   DRAFT_API_KEY      推送鉴权 Key；未配置则 /api/draft 直接拒绝（fail-closed）
 *   WECHAT_APPID       微信 appid 兜底（请求体 appid 优先）
 *   WECHAT_APPSECRET   微信 secret 兜底（请求体 secret 优先）
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'md2wx-worker' });
    }

    return json({ code: 1, msg: 'not found' }, 404);
  },
};
```

- [ ] **Step 5: 写入测试文件（health 用例）**

写入 `cloudflare/md2wx-worker/test/engine.test.mjs`：

```js
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
```

- [ ] **Step 6: 安装依赖并运行测试，验证通过**

```bash
cd cloudflare/md2wx-worker && npm install
npm test
```

Expected: esbuild 打包成功；`node --test` 输出 3 个 passing（health / OPTIONS / 404），0 failing。

- [ ] **Step 7: Commit**

```bash
git add .gitignore cloudflare/md2wx-worker && git commit -m "feat(worker): md2wx-worker skeleton with health route and test harness"
```

---

### Task 2: 转换 API（/api/themes + /api/convert）

**Files:**
- Modify: `cloudflare/md2wx-worker/worker.js`
- Modify: `cloudflare/md2wx-worker/test/engine.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `worker.default.fetch`、`json()`、`CORS_HEADERS`；引擎模块 `web/src/core/parser.js` 的 `markdownToWechatHtml(mdText, themeName, customOverride, renderOptions) -> string` 与 `parseFrontmatter(text) -> {meta, body}`；`web/src/core/themes.js` 的 `BUILTIN_THEMES`、`DEFAULT_THEME_ID`（'tech-blue'）、`listThemes() -> [{id, name, description, accent, page_bg, container}]`。
- Produces: `resolveThemeId(theme) -> string`；`buildConvertResult(body) -> {code:0, html, title, digest, theme}`（Task 3 的 draft 归一化复用）；HTTP 契约：`GET /api/themes` → `{code:0, themes:[...]}`；`POST /api/convert` body `{markdown, theme?}` → `{code:0, html, title, digest, theme}`，缺 markdown → 400 `{code:1, msg}`。

- [ ] **Step 1: 在 worker.js 顶部追加引擎导入**

在 `worker.js` 文件注释块之后、`const CORS_HEADERS` 之前插入：

```js
import { markdownToWechatHtml, parseFrontmatter } from '../../web/src/core/parser.js';
import { BUILTIN_THEMES, DEFAULT_THEME_ID, listThemes } from '../../web/src/core/themes.js';
```

- [ ] **Step 2: 追加转换处理函数**

在 `json()` 函数之后插入：

```js
function resolveThemeId(theme) {
  return theme && Object.prototype.hasOwnProperty.call(BUILTIN_THEMES, theme)
    ? theme
    : DEFAULT_THEME_ID;
}

function buildConvertResult(body) {
  const themeId = resolveThemeId(body.theme);
  const html = markdownToWechatHtml(body.markdown, themeId);
  const { meta } = parseFrontmatter(body.markdown);
  return {
    code: 0,
    html,
    title: body.title || meta.title || '',
    digest: body.digest || meta.digest || '',
    theme: themeId,
  };
}

function handleConvert(body) {
  if (typeof body.markdown !== 'string' || !body.markdown.trim()) {
    return json({ code: 1, msg: 'markdown 必填且不能为空' }, 400);
  }
  return json(buildConvertResult(body));
}
```

- [ ] **Step 3: 在 fetch 路由中注册两个 GET/POST 路由**

在 `if (request.method === 'GET' && url.pathname === '/api/health')` 块之后、`return json({ code: 1, msg: 'not found' }, 404);` 之前插入：

```js
    if (request.method === 'GET' && url.pathname === '/api/themes') {
      return json({ code: 0, themes: listThemes() });
    }

    if (request.method === 'POST' && url.pathname === '/api/convert') {
      const limited = await enforceConvertRateLimit(request, env);
      if (limited) return limited;
      let body;
      try { body = await request.json(); } catch { return json({ code: 1, msg: 'invalid json' }, 400); }
      return handleConvert(body);
    }
```

同时在 `json()` 函数之后补上限流助手（与 handleConvert 同级）：

```js
async function enforceConvertRateLimit(request, env) {
  const limiter = env.CONVERT_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key: `convert:${ip}` });
  if (!success) return json({ code: 1, msg: '请求过于频繁，请稍后再试' }, 429);
  return null;
}
```

- [ ] **Step 4: 追加 themes/convert 测试用例**

在 `test/engine.test.mjs` 末尾追加：

```js
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
```

- [ ] **Step 5: 运行测试（实现已先行完成，此处验证全绿）**

```bash
cd cloudflare/md2wx-worker && npm test
```

Expected: 全部用例 passing，0 failing。若 `themes.length` 断言失败，核对 `BUILTIN_THEMES` 实际数量并同步修正断言与 README 文案（当前仓库为 9 主题）。

- [ ] **Step 6: Commit**

```bash
cd cloudflare/md2wx-worker && git add worker.js test/engine.test.mjs && git commit -m "feat(worker): convert API (/api/themes + /api/convert) reusing web engine"
```

---

### Task 3: 草稿推送 API（/api/draft）

**Files:**
- Modify: `cloudflare/md2wx-worker/worker.js`
- Modify: `cloudflare/md2wx-worker/test/engine.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `buildConvertResult(body)`、`json()`；`globalThis.fetch`（可注入 mock）。
- Produces: 导出 `class WeChat`（构造签名 `new WeChat(appid, secret, fetchImpl = globalThis.fetch)`，方法 `getToken()` / `uploadTempImage(blob)` / `uploadMaterial(blob)` / `localizeImages(html)` / `resolveCover(cover, content)` / `addDraft(article)`）；导出测试钩子 `__resetTokenCache()`；env 测试注入口 `env.__WX_FETCH`（可选，覆盖微信 API 的 fetch 实现，生产环境恒为 undefined）；HTTP 契约：`POST /api/draft` 鉴权 `X-API-Key` 头或 `?key=` 查询参数，body 支持 `{markdown, theme?, title?, digest?, cover?, appid?, secret?, author?, content_source_url?, need_open_comment?, only_fans_can_comment?}` 或 `{content(html), title, digest, cover?, ...}`，成功 `{code:0, media_id}`。

- [ ] **Step 1: 追加 WeChat 推送类（自 worker-deploy.js 移植，三处增强：fetch 可注入、token 缓存按 appid 隔离、urlToBlob 走注入 fetch）**

在 `handleConvert` 之后插入：

```js
// ============================== 微信草稿箱推送 ==============================
const WX_BASE = 'https://api.weixin.qq.com';
// token 缓存按 appid 隔离：请求体可穿透凭证（多公众号），共享单例缓存会串号
const tokenCache = new Map(); // appid -> { token, exp }

function dataUriToBlob(dataUri) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUri);
  if (!m) return null;
  const mime = m[1];
  const bin = atob(m[2]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function formDataFile(field, blob, filename) {
  const fd = new FormData();
  fd.append(field, blob, filename);
  return fd;
}

export class WeChat {
  constructor(appid, secret, fetchImpl = globalThis.fetch) {
    this.appid = appid;
    this.secret = secret;
    this.fetch = fetchImpl;
  }

  async getToken() {
    const now = Date.now();
    const cached = tokenCache.get(this.appid);
    if (cached && now < cached.exp) return cached.token;
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/stable_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: this.appid,
        secret: this.secret,
        force_refresh: false,
      }),
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error('获取 token 失败: ' + JSON.stringify(data));
    tokenCache.set(this.appid, { token: data.access_token, exp: now + 7000 * 1000 });
    return data.access_token;
  }

  async uploadTempImage(blob) {
    const token = await this.getToken();
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/media/uploadimg?access_token=${token}`, {
      method: 'POST',
      body: formDataFile('media', blob, 'img.png'),
    });
    const data = await resp.json();
    if (!data.url) throw new Error('上传正文图失败: ' + JSON.stringify(data));
    return data.url;
  }

  async uploadMaterial(blob) {
    const token = await this.getToken();
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/material/add_material?access_token=${token}&type=image`, {
      method: 'POST',
      body: formDataFile('media', blob, 'cover.png'),
    });
    const data = await resp.json();
    if (!data.media_id) throw new Error('上传封面素材失败: ' + JSON.stringify(data));
    return data.media_id;
  }

  async urlToBlob(url) {
    const resp = await this.fetch(url);
    if (!resp.ok) throw new Error('下载图片失败: ' + url + ' (' + resp.status + ')');
    return resp.blob();
  }

  async localizeImages(html) {
    const re = /<img\s+[^>]*?src="([^"]+)"[^>]*?>/gi;
    const srcs = [];
    let m;
    while ((m = re.exec(html)) !== null) srcs.push(m[1]);
    for (const src of srcs) {
      if (src.startsWith('https://mmbiz.qpic.cn') || src.startsWith('http://mmbiz.qpic.cn')) continue;
      let blob = null;
      try {
        if (src.startsWith('data:')) blob = dataUriToBlob(src);
        else if (/^https?:\/\//.test(src)) blob = await this.urlToBlob(src);
      } catch (e) {
        continue;
      }
      if (blob) {
        try {
          const wxUrl = await this.uploadTempImage(blob);
          html = html.split(src).join(wxUrl);
        } catch (e) { }
      }
    }
    return html;
  }

  async resolveCover(cover, content) {
    if (cover) {
      let blob = null;
      if (cover.startsWith('data:')) blob = dataUriToBlob(cover);
      else if (/^https?:\/\//.test(cover)) blob = await this.urlToBlob(cover);
      if (blob) return await this.uploadMaterial(blob);
    }
    const m = /<img\s+[^>]*?src="([^"]+)"[^>]*?>/i.exec(content);
    if (m) {
      const src = m[1];
      let blob = null;
      if (src.startsWith('data:')) blob = dataUriToBlob(src);
      else if (/^https?:\/\//.test(src)) blob = await this.urlToBlob(src);
      if (blob) return await this.uploadMaterial(blob);
    }
    return null;
  }

  async addDraft(article) {
    const token = await this.getToken();
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/draft/add?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ articles: [article] }),
    });
    const data = await resp.json();
    if (data.errcode) throw new Error('draft/add 失败: ' + JSON.stringify(data));
    return data.media_id;
  }
}

export function __resetTokenCache() {
  tokenCache.clear();
}
```

- [ ] **Step 2: 追加 draft 归一化与路由处理**

在 `__resetTokenCache` 之后插入：

```js
function normalizeDraftSource(body) {
  if (typeof body.markdown === 'string' && body.markdown.trim()) {
    const converted = buildConvertResult(body);
    return { content: converted.html, title: converted.title, digest: converted.digest };
  }
  if (typeof body.content === 'string' && body.content.trim()) {
    return { content: body.content, title: body.title || '', digest: body.digest || '' };
  }
  return null;
}

async function handleDraft(request, body, env) {
  const KEY = env.DRAFT_API_KEY || '';
  if (!KEY) return json({ code: 1, msg: '服务端未配置 DRAFT_API_KEY，拒绝推送' }, 500);
  const provided = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('key') || '';
  if (provided !== KEY) return json({ code: 1, msg: '未授权' }, 401);

  const source = normalizeDraftSource(body);
  if (!source) return json({ code: 1, msg: 'markdown 或 content 必填' }, 400);
  if (!source.title) return json({ code: 1, msg: 'title 必填（frontmatter title 或请求体 title）' }, 400);

  const appid = body.appid || env.WECHAT_APPID || '';
  const secret = body.secret || env.WECHAT_APPSECRET || '';
  if (!appid || !secret) {
    return json({ code: 1, msg: '缺少 appid/secret：请求体未带且 Worker 未配置环境变量' }, 400);
  }

  // env.__WX_FETCH 为测试注入口：生产环境恒为 undefined，走 globalThis.fetch
  const wx = new WeChat(appid, secret, env.__WX_FETCH || globalThis.fetch);
  try {
    const finalContent = await wx.localizeImages(source.content);
    const thumb_media_id = await wx.resolveCover(body.cover, finalContent);
    if (!thumb_media_id) return json({ code: 1, msg: '缺少封面图（cover 或正文第一张图都不存在）' }, 400);
    const media_id = await wx.addDraft({
      title: source.title,
      author: body.author || '',
      digest: source.digest,
      content: finalContent,
      thumb_media_id,
      content_source_url: body.content_source_url || '',
      need_open_comment: body.need_open_comment ? 1 : 0,
      only_fans_can_comment: body.only_fans_can_comment ? 1 : 0,
    });
    return json({ code: 0, media_id });
  } catch (e) {
    return json({ code: 1, msg: String(e.message || e) }, 500);
  }
}
```

- [ ] **Step 3: 注册 draft 路由**

在 `/api/convert` 路由块之后、最终 404 之前插入：

```js
    if (request.method === 'POST' && url.pathname === '/api/draft') {
      let body;
      try { body = await request.json(); } catch { return json({ code: 1, msg: 'invalid json' }, 400); }
      return handleDraft(request, body, env);
    }
```

- [ ] **Step 4: 追加 draft 测试用例**

把 `test/engine.test.mjs` 顶部的 `import { describe, it } from 'node:test';` 改为：

```js
import { describe, it, beforeEach } from 'node:test';
import { __resetTokenCache } from './.worker.bundle.mjs';
```

文件末尾追加：

```js
// ============================== /api/draft ==============================

/** 按 URL 子串匹配返回预置 JSON 的微信 API mock（带调用记录；raw 项直接返回原始 Response） */
function mockWxFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    for (const r of responses) {
      if (String(url).includes(r.match)) {
        if (r.raw) return r.raw;
        return new Response(JSON.stringify(r.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ errcode: -1, errmsg: 'unmocked: ' + url }), { status: 500 });
  };
  fn.calls = calls;
  return fn;
}

const DRAFT_ENV = {
  DRAFT_API_KEY: 'test-key',
  WECHAT_APPID: 'wx-appid-test',
  WECHAT_APPSECRET: 'wx-secret-test',
};

const DRAFT_HEADERS = { 'X-API-Key': 'test-key' };

describe('POST /api/draft 鉴权与校验', () => {
  beforeEach(() => __resetTokenCache());

  it('未配置 DRAFT_API_KEY 时 fail-closed 拒绝', async () => {
    const res = await postJson('/api/draft', { markdown: '# t', title: 't' }, {});
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(data.msg.includes('DRAFT_API_KEY'));
  });

  it('Key 错误返回 401（header 与 query 两种通道均校验）', async () => {
    for (const path of ['/api/draft', '/api/draft?key=wrong']) {
      const res = await postJson(path, { markdown: '# t', title: 't' }, DRAFT_ENV, { 'X-API-Key': 'nope' });
      assert.equal(res.status, 401);
    }
  });

  it('query key 正确时放行到业务校验（缺 markdown/content 返回 400 而非 401）', async () => {
    const res = await postJson('/api/draft?key=test-key', { title: 't' }, DRAFT_ENV);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('markdown'));
  });

  it('markdown 形态但无 frontmatter title 且未传 title 返回 400', async () => {
    const res = await postJson('/api/draft', { markdown: '# 无标题文章' }, DRAFT_ENV, DRAFT_HEADERS);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('title'));
  });

  it('env 与 body 均无 appid/secret 返回 400', async () => {
    const res = await postJson(
      '/api/draft',
      { markdown: '---\ntitle: T\n---\n\n正文' },
      { DRAFT_API_KEY: 'test-key' },
      DRAFT_HEADERS
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('appid'));
  });
});

describe('POST /api/draft 推送链路（env.__WX_FETCH 注入 mock 微信 API）', () => {
  beforeEach(() => __resetTokenCache());

  it('markdown 形态全链路：转换 -> 图片换链 -> 封面解析 -> 草稿成功', async () => {
    const wx = mockWxFetch([
      { match: 'stable_token', body: { access_token: 'TOKEN1' } },
      { match: 'cdn.example.com', raw: new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }) },
      { match: 'uploadimg', body: { url: 'https://mmbiz.qpic.cn/m/replace.png' } },
      { match: 'add_material', body: { media_id: 'MEDIA1' } },
      { match: 'draft/add', body: { media_id: 'DRAFT1' } },
    ]);

    const md = '---\ntitle: 测试文章\ndigest: 测试摘要\n---\n\n# 测试文章\n\n![封面](https://cdn.example.com/cover.png)\n\n正文';
    const res = await postJson('/api/draft', { markdown: md }, { ...DRAFT_ENV, __WX_FETCH: wx }, DRAFT_HEADERS);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.code, 0);
    assert.equal(data.media_id, 'DRAFT1');

    const addCall = wx.calls.find((c) => c.url.includes('draft/add'));
    assert.ok(addCall, '必须调用过 draft/add');
    const sent = JSON.parse(addCall.opts.body);
    assert.equal(sent.articles[0].title, '测试文章');
    assert.equal(sent.articles[0].digest, '测试摘要');
    assert.equal(sent.articles[0].thumb_media_id, 'MEDIA1');
    assert.ok(sent.articles[0].content.includes('<section style='), '正文必须是引擎转换产物');
    assert.ok(sent.articles[0].content.includes('mmbiz.qpic.cn/m/replace.png'), '外链图必须已换链');

    const uploadCall = wx.calls.find((c) => c.url.includes('uploadimg'));
    assert.ok(uploadCall, '正文外链图必须经过 uploadimg 换链');
  });

  it('content 形态：无封面且正文无图返回 400 缺少封面', async () => {
    const res = await postJson(
      '/api/draft',
      { content: '<section style="x">hi</section>', title: 'T' },
      DRAFT_ENV,
      DRAFT_HEADERS
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.msg.includes('封面'));
  });
});
```

- [ ] **Step 5: 运行测试**

```bash
cd cloudflare/md2wx-worker && npm test
```

Expected: 全部 passing，0 failing。若 `sample_article.md` 转换或引擎产物断言失败，先确认是否引擎隐藏浏览器 API 引用导致（`node -e "import('./test/.worker.bundle.mjs')"` 复现），就地最小修复引擎并记入提交说明。

- [ ] **Step 6: Commit**

```bash
cd cloudflare/md2wx-worker && git add worker.js test/engine.test.mjs && git commit -m "feat(worker): draft push API compatible with worker-deploy.js contract"
```

---

### Task 4: Web Studio 推送按钮与推送设置

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/app.js`
- Modify: `web/src/assets/icons.js`
- Modify: `web/src/styles/main.css`

**Interfaces:**
- Consumes: Task 3 的 `POST /api/draft` 契约；app.js 现有 `showToast(message, type)`、`setIcon(selector, name)`、全局 `textarea`、`currentThemeId`；localStorage 键约定 `md2wx_*`。
- Produces: localStorage 键 `md2wx_push_api_key` / `md2wx_push_endpoint` / `md2wx_push_appid` / `md2wx_push_secret`；按钮 `#btn-push-draft`；设置输入 `#push-api-key` / `#push-endpoint` / `#push-appid` / `#push-secret`；新图标 `ICONS.send`。

- [ ] **Step 1: icons.js 增加 send 图标**

在 `web/src/assets/icons.js` 的 `ICONS` 对象中 `info:` 条目之后追加（沿用现有 18x18 stroke 风格）：

```js
  send: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="m22 2-7 20-4-9-9-4Z"/>
  <path d="M22 2 11 13"/>
</svg>`,
```

- [ ] **Step 2: index.html 增加"推送草稿箱"按钮**

在 `<button class="btn btn-secondary" id="btn-export-html" ...>` 与 `<button class="btn btn-primary" id="btn-copy-header" ...>` 两个按钮之间插入：

```html
        <button class="btn btn-secondary" id="btn-push-draft" type="button" title="推送当前文章到微信公众号草稿箱（需在设置中配置 API Key）">
          <span id="icon-push"></span>
          <span>推送草稿箱</span>
        </button>
```

- [ ] **Step 3: index.html 设置面板增加"公众号推送"配置块**

在 `#settings-dropdown-menu` 容器内、最后一个 `settings-toggle-row`（"双栏同步滚动"）之后、该容器的关闭 `</div>` 之前插入：

```html
            <div class="settings-divider"></div>

            <div class="settings-header">
              <span id="icon-send-title"></span>
              <span>公众号推送</span>
            </div>

            <div class="settings-item">
              <div class="settings-label">推送 API Key</div>
              <input type="password" class="settings-input" id="push-api-key" placeholder="Worker 的 DRAFT_API_KEY" autocomplete="off">
            </div>

            <div class="settings-item">
              <div class="settings-label">推送端点 URL（留空 = 本站 /api/draft）</div>
              <input type="text" class="settings-input" id="push-endpoint" placeholder="https://md2wx-worker.你的子域.workers.dev/api/draft" autocomplete="off">
            </div>

            <div class="settings-item">
              <div class="settings-label">AppID / Secret（可选，多公众号穿透）</div>
              <div class="push-cred-row">
                <input type="text" class="settings-input" id="push-appid" placeholder="wx appid（可选）" autocomplete="off">
                <input type="password" class="settings-input" id="push-secret" placeholder="wx secret（可选）" autocomplete="off">
              </div>
            </div>
```

- [ ] **Step 4: main.css 增加输入样式**

在 `web/src/styles/main.css` 末尾追加（全部带字面量回退值，避免依赖未定义的 CSS 变量）：

```css
/* 公众号推送设置输入项 */
.settings-input {
  width: 100%;
  margin-top: 6px;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text-secondary, #52525b);
  background: var(--control-bg, #f7f7f8);
  border: 1px solid var(--border-color, #e4e4e7);
  border-radius: 7px;
  outline: none;
}

.settings-input:focus {
  border-color: var(--accent, #2563eb);
}

.push-cred-row {
  display: flex;
  gap: 8px;
}
```

- [ ] **Step 5: app.js 增加推送状态与逻辑**

(a) 在 `let insertCoverEnabled = ...` 行（约 68 行）之后追加：

```js
// 公众号推送配置（localStorage 持久化；secret 仅存本机浏览器，敏感场景建议留空走 Worker env）
let pushApiKey = localStorage.getItem('md2wx_push_api_key') || '';
let pushEndpoint = localStorage.getItem('md2wx_push_endpoint') || '';
let pushAppId = localStorage.getItem('md2wx_push_appid') || '';
let pushSecret = localStorage.getItem('md2wx_push_secret') || '';
```

(b) 在 `initIcons()` 内 `setIcon('#icon-settings', 'settings');` 附近追加两行：

```js
  setIcon('#icon-push', 'send');
  setIcon('#icon-send-title', 'send');
```

(c) 在 `handleCopy()` 函数之后追加两个函数：

```js
/**
 * 推送当前文章到微信草稿箱（调用 MD2WX Worker /api/draft，服务端完成转换、换链与封面解析）
 */
async function handlePushDraft() {
  const md = textarea.value;
  if (!md.trim()) {
    showToast('当前没有可推送的内容', 'error');
    return;
  }
  if (!pushApiKey) {
    showToast('请先在设置中配置推送 API Key', 'error');
    return;
  }

  const btn = document.getElementById('btn-push-draft');
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${ICONS.refresh}<span>推送中…</span>`;

  const endpoint = pushEndpoint.trim() || '/api/draft';
  const payload = { markdown: md, theme: currentThemeId };
  if (pushAppId.trim()) payload.appid = pushAppId.trim();
  if (pushSecret.trim()) payload.secret = pushSecret.trim();

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': pushApiKey },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.code === 0) {
      showToast('草稿推送成功！请到微信公众号后台查看');
      btn.innerHTML = `${ICONS.check}<span>已推送</span>`;
      setTimeout(() => { btn.innerHTML = origHtml; }, 1800);
    } else {
      showToast('推送失败: ' + (data.msg || `HTTP ${resp.status}`), 'error');
      btn.innerHTML = origHtml;
    }
  } catch (err) {
    showToast('推送失败: ' + (err.message || '网络错误'), 'error');
    btn.innerHTML = origHtml;
  } finally {
    btn.disabled = false;
  }
}

/**
 * 初始化公众号推送设置项（输入即持久化到 localStorage）
 */
function initPushSettings() {
  const fields = [
    { id: 'push-api-key', key: 'md2wx_push_api_key', set: (v) => { pushApiKey = v; } },
    { id: 'push-endpoint', key: 'md2wx_push_endpoint', set: (v) => { pushEndpoint = v; } },
    { id: 'push-appid', key: 'md2wx_push_appid', set: (v) => { pushAppId = v; } },
    { id: 'push-secret', key: 'md2wx_push_secret', set: (v) => { pushSecret = v; } },
  ];
  for (const f of fields) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    el.value = localStorage.getItem(f.key) || '';
    el.addEventListener('input', () => {
      f.set(el.value.trim());
      localStorage.setItem(f.key, el.value.trim());
    });
  }
}
```

(d) 在 `bindEvents()` 内 `document.getElementById('btn-export-html')...` 监听附近追加：

```js
  document.getElementById('btn-push-draft').addEventListener('click', handlePushDraft);
```

(e) 在 `init()` 内 `initSettings();` 调用之后追加：

```js
  initPushSettings();
```

- [ ] **Step 6: 构建验证（仓库硬性要求）**

```bash
cd web && npm ci && npm run build
```

Expected: vite build 成功无错误，`dist/` 生成。

- [ ] **Step 7: 手工验证清单（vite dev + wrangler dev 或部署预览）**

- [ ] 推送按钮未配置 Key 时点击 → toast"请先在设置中配置推送 API Key"
- [ ] 设置面板四个输入可输入且刷新页面后仍在（localStorage）
- [ ] 配置正确 Key 后点推送 → toast 成功（或按服务端返回 msg 报错）
- [ ] 不推送时站点其余功能（复制/导出/主题切换）与改动前一致

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/src/app.js web/src/assets/icons.js web/src/styles/main.css && git commit -m "feat(web): draft push button and push settings in Web Studio"
```

---

### Task 5: vite 代理、文档、devlog 与端到端冒烟

**Files:**
- Modify: `web/vite.config.js`
- Create: `cloudflare/md2wx-worker/README.md`
- Create: `cloudflare/md2wx-worker/.dev.vars.example`
- Modify: `README.md`（仓库根，部署章节补一行）
- Create: `devlogs/devlog_part6_worker_unified.md`
- Modify: `devlogs/README.md`（索引追加 Part 6）

**Interfaces:**
- Consumes: Task 1-4 的全部成果（完整 Worker + 构建好的 web/dist）。
- Produces: 可部署的完整交付物与文档。

- [ ] **Step 1: vite.config.js 增加 /api 开发代理**

`web/vite.config.js` 的 `server` 块改为：

```js
  server: {
    port: 3000,
    open: false,
    host: true,
    // 本地开发：/api 请求转发到 wrangler dev (cloudflare/md2wx-worker, 默认 8787 端口)
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    },
    // 允许开发期导入 web/ 目录之外的 md2wx/themes/*.json (主题单一数据源)
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))]
    }
  },
```

- [ ] **Step 2: 写入 .dev.vars.example**

写入 `cloudflare/md2wx-worker/.dev.vars.example`：

```
# 复制为 .dev.vars 供 wrangler dev 本地使用（.dev.vars 已被 .gitignore 忽略）
DRAFT_API_KEY=dev-key-123
WECHAT_APPID=wx-your-appid
WECHAT_APPSECRET=your-secret
```

- [ ] **Step 3: 写入 Worker 部署文档**

写入 `cloudflare/md2wx-worker/README.md`：

````markdown
# MD2WX 一体化 Worker（整站 + 转换 API + 草稿推送）

单部署单元：Workers Static Assets 托管 Web Studio 整站（`web/dist`），同时提供
Markdown 转换 API 与微信草稿箱推送 API。响应契约与旧版单文件 worker-deploy.js
完全兼容（`{code, media_id}` / `{code, msg}`），部署本 Worker 后旧 Worker 可退役。

## 路由

| 路由 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/health` | GET | 无 | 健康检查 |
| `/api/themes` | GET | 无 | 枚举 9 大内置主题 |
| `/api/convert` | POST | 无（CORS `*`，60 次/分/IP 限流） | `{markdown, theme?}` → `{code:0, html, title, digest, theme}`，title/digest 取自 frontmatter |
| `/api/draft` | POST | `X-API-Key` 头或 `?key=` | 见下 |

`/api/draft` 请求体两种形态：

1. markdown 形态：`{markdown, theme?, title?, digest?, cover?, appid?, secret?, author?, ...}`
   —— 服务端先转换，title/digest 缺省取 frontmatter，均无则 400；
2. content 形态：`{content: "<内联样式 HTML>", title, digest, ...}` —— 兼容旧调用方。

处理链路：正文外链图换链 `mmbiz.qpic.cn` → 封面（`cover` 参数 → 正文第一张图）→ `draft/add`。

## 配置

密钥（`wrangler secret put <NAME>` 注入；本地开发复制 `.dev.vars.example` 为 `.dev.vars`）：

- `DRAFT_API_KEY`：推送鉴权 Key。**未配置时 `/api/draft` 直接拒绝（fail-closed）**。
- `WECHAT_APPID` / `WECHAT_APPSECRET`：微信凭证兜底；请求体 `appid`/`secret` 可逐请求覆盖（多公众号）。

## 部署

```bash
cd web && npm ci && npm run build
cd ../cloudflare/md2wx-worker && npm ci && npx wrangler deploy
```

本地开发：

```bash
cd cloudflare/md2wx-worker && npm ci && npx wrangler dev   # API 于 127.0.0.1:8787
cd web && npm run dev                                      # vite 5173/3000，/api 已代理到 8787
```

## 调用示例

```bash
# 转换
curl -s https://<worker-domain>/api/convert -H 'content-type: application/json' \
  -d '{"markdown":"---\ntitle: 标题\n---\n\n# 标题\n\n正文", "theme":"tech-blue"}'

# 推送草稿（markdown 形态）
curl -s https://<worker-domain>/api/draft -H 'content-type: application/json' \
  -H 'X-API-Key: <DRAFT_API_KEY>' \
  -d '{"markdown":"---\ntitle: 标题\n---\n\n# 标题\n\n![图](https://cdn.example.com/a.png)\n\n正文"}'

# 推送草稿（content 形态，兼容旧 worker-deploy.js 调用方）
curl -s "https://<worker-domain>/api/draft?key=<DRAFT_API_KEY>" \
  -H 'content-type: application/json' \
  -d '{"title":"标题","content":"<section style=\"...\">...</section>"}'
```

GitHub Pages 场景：在 Web Studio 设置中把"推送端点 URL"填为 Worker 完整地址即可。
````

- [ ] **Step 4: 根 README 部署章节补一行**

在根 `README.md` 的 `### Web Studio 构建期图床配置（GitHub Pages 部署）` 小节的安全提示引用块之后、`---` 分隔线之前插入：

```markdown
### 一体化 Cloudflare Worker 部署（整站 + 转换 API + 草稿推送）

除 GitHub Pages 外，可将整站与 API 一并部署至 Cloudflare Worker（单部署单元），详见 [cloudflare/md2wx-worker/README.md](cloudflare/md2wx-worker/README.md)。
```

- [ ] **Step 5: 写 devlog（遵守 AGENTS.md 规则：标题 ≤20 字、digest ≤50 字、不填 cover）**

写入 `devlogs/devlog_part6_worker_unified.md`（骨架如下，正文语言平实、讲人话，禁止公关排比）：

```markdown
---
title: MD2WX 一体化 Worker 上线
digest: 整站、转换 API 与草稿推送合并为单个 Cloudflare Worker，旧推送 Worker 可退役。
---

# MD2WX 一体化 Worker 上线

（正文按 devlogs 现有各篇的行文风格展开：背景痛点、方案取舍（为何跨目录直引而非抽包/拷贝）、
token 缓存按 appid 隔离的修正、fail-closed 鉴权、测试方式（esbuild 打包 + node --test）、遗留事项。）
```

并在 `devlogs/README.md` 的目录索引代码块追加一行、在"各期开发日志要点总结"追加 `### [Part 6: 一体化 Worker 上线](devlog_part6_worker_unified.md)` 小节（格式对齐 Part 5 条目）。

- [ ] **Step 6: 端到端冒烟**

```bash
cd web && npm run build
cd ../cloudflare/md2wx-worker && cp .dev.vars.example .dev.vars
npx wrangler dev   # 后台运行
```

另开终端：

```bash
curl -s http://127.0.0.1:8787/api/health
# Expected: {"ok":true,"service":"md2wx-worker"}

curl -s http://127.0.0.1:8787/api/convert -H 'content-type: application/json' \
  -d '{"markdown":"---\ntitle: T\n---\n\n# T\n\n正文"}'
# Expected: {"code":0,"html":"...<section style=...","title":"T","digest":"","theme":"tech-blue"}

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/ -H 'Accept: text/html'
# Expected: 200（整站静态资产由 wrangler dev 托管）

curl -s http://127.0.0.1:8787/api/draft -H 'content-type: application/json' -H 'X-API-Key: wrong' -d '{}'
# Expected: {"code":1,"msg":"未授权"}
```

Expected: 以上全部符合。验证后停掉 wrangler dev，并删除本地 `.dev.vars`（已 gitignore，不会误提交）。

- [ ] **Step 7: 全量回归**

```bash
cd cloudflare/md2wx-worker && npm test
cd ../../web && npm run build
```

Expected: 测试全绿、构建无错。

- [ ] **Step 8: Commit**

```bash
git add web/vite.config.js cloudflare/md2wx-worker/README.md cloudflare/md2wx-worker/.dev.vars.example README.md devlogs/ && git commit -m "docs(worker): deploy docs, vite api proxy and devlog part 6"
```

---

## 任务依赖与交付物总览

- Task 1 → Task 2 → Task 3 严格顺序（同一文件 worker.js 迭代）。
- Task 4 依赖 Task 3 的 API 契约（可并行开发但建议顺序执行）。
- Task 5 收尾，依赖全部前序任务。
- 最终交付：`cloudflare/md2wx-worker/`（可 `wrangler deploy`）、Web Studio 推送按钮、文档与 devlog、绿色测试套件。
