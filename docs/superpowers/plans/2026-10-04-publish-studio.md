# MD2WX 发布工坊（Publish Studio）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用「发布工坊」弹窗统一公众号推送的配置、预览、推送与历史，替换现有割裂的按钮 + 设置块形态。

**Architecture:** 新增纯逻辑层 `web/src/core/publish.js`（提取/payload/历史，Node 可测），UI 仿 Cover Studio 模式新增 `#publish-modal-overlay` 弹窗（复用 `cover-modal-*` 类），`app.js` 以 `initPublishStudio()` 接线并删除旧的 `handlePushDraft`/`initPushSettings`。Worker 与 Python 端零改动。

**Tech Stack:** 原生 ESM + Vanilla CSS；测试复用 `cloudflare/md2wx-worker` 的 esbuild + `node --test` 基建。

**设计文档:** `docs/superpowers/specs/2026-10-04-publish-studio-design.md`

## Global Constraints

- 所有命令在 `E:\code\opensaas\zcodeapi\gzh\MD2WX` 仓库根执行（Git Bash / Windows），除非步骤明确写明其他目录。
- 引擎模块 `web/src/core/parser.js`、`themes.js`、`cover.js` 禁止结构性改动；Worker（`cloudflare/md2wx-worker/`）与 Python 端零改动。
- Web 端改动的每个任务结束必须 `cd web && npm run build` 通过（仓库硬性要求）。
- localStorage 键沿用：`md2wx_push_api_key` / `md2wx_push_endpoint` / `md2wx_push_appid` / `md2wx_push_secret`；新增 `md2wx_push_history`、`md2wx_push_use_cover`。
- `/api/draft` 请求规则（spec §4）：title/digest **非空即携带**；cover 仅在勾选工坊联动时携带（`renderCoverDirectCanvas(themeId,'banner',meta,1).toDataURL('image/png')`）；appid/secret 由输入穿透。
- 推送历史最多 5 条，超出截断最旧的。
- 顶部按钮文案「发布」；弹窗标题「发布工坊」；全站禁止 Emoji（SVG 图标规范）。

---

### Task 1: publish.js 纯逻辑层 + 测试基建扩展

**Files:**
- Create: `web/src/core/publish.js`
- Create: `cloudflare/md2wx-worker/test/publish.test.mjs`
- Modify: `cloudflare/md2wx-worker/package.json`（scripts.test / scripts.build:test）
- Modify: `.gitignore`（追加 publish bundle 产物）
- Modify: `web/vite.config.js`（fs.allow 已含上级目录，无需改——确认即可，不改）

**Interfaces:**
- Consumes: `web/src/core/parser.js` 的 `parseFrontmatter(text) -> {meta, body}`（Task 3 的 app.js 已有 import；publish.js 自行 import）。
- Produces（Task 3 依赖的确切签名）:
  - `extractPublishMeta(markdownText) -> { title: string, digest: string, coverImageSrc: string }`——title 回退链 frontmatter→H1→首行文字；digest 仅 frontmatter；coverImageSrc 为第一张图片 URL（md 或 `<img>`，含 data: URI），无则 `''`；
  - `buildPublishPayload({ markdown, theme, title, digest, coverDataUrl, appId, appSecret }) -> object`——title/digest 非空即携带，`appId/appSecret` 映射为 payload 的 `appid/secret` 键，`coverDataUrl` 非空时映射为 `cover`；
  - `resolvePushConfig(apiKey, endpoint) -> { ok: boolean, endpoint: string, reason: string }`——endpoint 空则为 `'/api/draft'`；
  - `readPushHistory(store?) -> Array` / `recordPush(entry, store?) -> Array`——entry `{ t: number, title: string, ok: boolean, mediaId?: string, msg?: string }`；store 需实现 `getItem/setItem`，缺省用 `localStorage`，不可用时读取返回 `[]`、写入仅返回内存数组；历史固定截断 5 条；
  - `countWords(text) -> number`——汉字数 + 英文单词数（与 app.js `updateWordCount` 同口径）。

- [ ] **Step 1: 写失败测试**

写入 `cloudflare/md2wx-worker/test/publish.test.mjs`：

```js
/**
 * 发布工坊纯逻辑层测试：esbuild 打包 web/src/core/publish.js 后用 node --test 断言
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPublishMeta,
  buildPublishPayload,
  resolvePushConfig,
  readPushHistory,
  recordPush,
  countWords,
} from './.publish.bundle.mjs';

function mockStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

describe('extractPublishMeta', () => {
  it('frontmatter 优先', () => {
    const r = extractPublishMeta('---\ntitle: FM标题\ndigest: FM摘要\n---\n\n# H1标题\n\n![图](https://a.png)\n\n正文');
    assert.equal(r.title, 'FM标题');
    assert.equal(r.digest, 'FM摘要');
    assert.equal(r.coverImageSrc, 'https://a.png');
  });

  it('无 frontmatter 时 H1 回退，digest 为空', () => {
    const r = extractPublishMeta('# H1标题\n\n正文');
    assert.equal(r.title, 'H1标题');
    assert.equal(r.digest, '');
    assert.equal(r.coverImageSrc, '');
  });

  it('无 H1 时首行文字回退', () => {
    const r = extractPublishMeta('就是第一行文字\n\n正文');
    assert.equal(r.title, '就是第一行文字');
  });

  it('coverImageSrc 识别 HTML img 与 data URI', () => {
    assert.equal(extractPublishMeta('<img src="https://x.com/a.jpg">').coverImageSrc, 'https://x.com/a.jpg');
    assert.equal(extractPublishMeta('![b](data:image/png;base64,AAAA)').coverImageSrc.startsWith('data:'), true);
    assert.equal(extractPublishMeta('没有图').coverImageSrc, '');
  });
});

describe('buildPublishPayload', () => {
  it('基础形态只有 markdown 与 theme', () => {
    const p = buildPublishPayload({ markdown: '# t', theme: 'tech-blue' });
    assert.deepEqual(p, { markdown: '# t', theme: 'tech-blue' });
  });

  it('title/digest 非空即携带', () => {
    const p = buildPublishPayload({ markdown: '# t', theme: 'vintage-news', title: ' 标题 ', digest: '摘要' });
    assert.equal(p.title, '标题');
    assert.equal(p.digest, '摘要');
  });

  it('cover 与凭证穿透映射', () => {
    const p = buildPublishPayload({
      markdown: '# t', theme: 'tech-blue',
      coverDataUrl: 'data:image/png;base64,AA', appId: ' wx1 ', appSecret: ' sec ',
    });
    assert.equal(p.cover, 'data:image/png;base64,AA');
    assert.equal(p.appid, 'wx1');
    assert.equal(p.secret, 'sec');
  });
});

describe('resolvePushConfig', () => {
  it('无 Key 时不可推送', () => {
    const r = resolvePushConfig('', '');
    assert.equal(r.ok, false);
    assert.equal(r.endpoint, '/api/draft');
  });
  it('有 Key 时端点缺省同源，自定义端点去空格', () => {
    assert.equal(resolvePushConfig('k', '').endpoint, '/api/draft');
    assert.deepEqual(resolvePushConfig(' k ', ' https://x/api/draft '), { ok: true, endpoint: 'https://x/api/draft', reason: '' });
  });
});

describe('推送历史', () => {
  it('空存储读取返回空数组', () => {
    assert.deepEqual(readPushHistory(mockStore()), []);
  });

  it('recordPush 写入并持久化，超过 5 条截断最旧', () => {
    const store = mockStore();
    for (let i = 1; i <= 7; i++) {
      recordPush({ t: i, title: 'T' + i, ok: true, mediaId: 'M' + i }, store);
    }
    const h = readPushHistory(store);
    assert.equal(h.length, 5);
    assert.equal(h[0].title, 'T7');
    assert.equal(h[4].title, 'T3');
    assert.equal(h[0].mediaId, 'M7');
  });

  it('失败项带 msg', () => {
    const store = mockStore();
    recordPush({ t: 1, title: 'T', ok: false, msg: '缺少封面' }, store);
    const h = readPushHistory(store);
    assert.equal(h[0].ok, false);
    assert.equal(h[0].msg, '缺少封面');
  });
});

describe('countWords', () => {
  it('汉字与英文单词合计', () => {
    assert.equal(countWords('你好世界 hello world'), 6);
    assert.equal(countWords(''), 0);
  });
});
```

- [ ] **Step 2: 扩展测试脚本并运行，确认失败**

`cloudflare/md2wx-worker/package.json` 的 scripts 改为：

```json
  "scripts": {
    "build:test": "esbuild worker.js --bundle --format=esm --outfile=test/.worker.bundle.mjs && esbuild ../../web/src/core/publish.js --bundle --format=esm --outfile=test/.publish.bundle.mjs",
    "test": "npm run build:test && node --test test/engine.test.mjs test/publish.test.mjs",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
```

`.gitignore` 追加一行：

```
cloudflare/md2wx-worker/test/.publish.bundle.mjs
```

运行：

```bash
cd cloudflare/md2wx-worker && npm test 2>&1 | tail -5
```

Expected: FAIL——`Cannot find module './.publish.bundle.mjs'`（publish.js 尚不存在，esbuild 报错退出）。

- [ ] **Step 3: 实现 publish.js**

写入 `web/src/core/publish.js`：

```js
/**
 * MD2WX 发布工坊纯逻辑层：提取、payload 组装、推送历史。
 * 零 DOM 依赖（store 可注入），Node 可测。
 */
import { parseFrontmatter } from './parser.js';

export const PUSH_HISTORY_KEY = 'md2wx_push_history';
export const PUSH_HISTORY_MAX = 5;

/**
 * 提取发布元信息，与 renderPreview 的标题回退链一致：
 * frontmatter title/digest -> 正文 H1 -> 首行非空文字
 */
export function extractPublishMeta(markdownText) {
  const text = String(markdownText || '');
  const { meta, body } = parseFrontmatter(text);

  let title = meta.title || '';
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) {
      title = h1[1].trim();
    } else {
      const firstLine = body.split('\n').map((s) => s.trim()).filter(Boolean)[0];
      title = firstLine ? firstLine.replace(/^[#*_\->\s]+/, '') : '';
    }
  }

  const imgMd = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
  const imgHtml = body.match(/<img\s+[^>]*?src="([^"]+)"/i);
  const coverImageSrc = (imgMd && imgMd[1]) || (imgHtml && imgHtml[1]) || '';

  return { title, digest: meta.digest || '', coverImageSrc };
}

/**
 * 组装 /api/draft 请求体：title/digest 非空即携带（服务端提取是其子集），
 * appId/appSecret 映射为 appid/secret，coverDataUrl 映射为 cover。
 */
export function buildPublishPayload({ markdown, theme, title = '', digest = '', coverDataUrl = '', appId = '', appSecret = '' }) {
  const payload = { markdown, theme };
  if (title && title.trim()) payload.title = title.trim();
  if (digest && digest.trim()) payload.digest = digest.trim();
  if (coverDataUrl) payload.cover = coverDataUrl;
  if (appId && appId.trim()) payload.appid = appId.trim();
  if (appSecret && appSecret.trim()) payload.secret = appSecret.trim();
  return payload;
}

/**
 * 连接状态判定：无 Key 不可推送；端点缺省同源。
 */
export function resolvePushConfig(apiKey, endpoint = '') {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, endpoint: '/api/draft', reason: '未配置 API Key' };
  }
  return { ok: true, endpoint: (endpoint || '').trim() || '/api/draft', reason: '' };
}

function defaultStore() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function parseHistory(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

export function readPushHistory(store = defaultStore()) {
  if (!store) return [];
  return parseHistory(store.getItem(PUSH_HISTORY_KEY));
}

export function recordPush(entry, store = defaultStore()) {
  const next = [entry, ...readPushHistory(store)].slice(0, PUSH_HISTORY_MAX);
  if (store) {
    try {
      store.setItem(PUSH_HISTORY_KEY, JSON.stringify(next));
    } catch (e) {
      // 存储不可用时静默，仅返回内存结果
    }
  }
  return next;
}

export function countWords(text) {
  const s = String(text || '');
  const chineseChars = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (s.replace(/[\u4e00-\u9fa5]/g, ' ').match(/\b\w+\b/g) || []).length;
  return chineseChars + englishWords;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd cloudflare/md2wx-worker && npm test 2>&1 | tail -8
```

Expected: 原有 16 个用例 + 新增 publish 用例全部 passing，0 failing。

- [ ] **Step 5: Commit**

```bash
git add web/src/core/publish.js cloudflare/md2wx-worker/test/publish.test.mjs cloudflare/md2wx-worker/package.json .gitignore && git commit -m "feat(web): publish studio pure logic layer with node tests"
```

---

### Task 2: index.html 弹窗结构 + 入口统一 + 样式

**Files:**
- Modify: `web/index.html`（顶部按钮改名、设置面板删推送块、body 末尾加发布工坊弹窗）
- Modify: `web/src/styles/main.css`（追加发布工坊样式）

**Interfaces:**
- Consumes: 既有 `cover-modal-overlay` / `cover-modal-window` / `cover-modal-header` / `cover-modal-body` / `cover-modal-close-btn` / `settings-input` CSS 类与 `cover-header-badge` 类。
- Produces（Task 3 的 app.js 依赖的确切 DOM id）：
  - 打开按钮 `#btn-open-publish`；弹窗 `#publish-modal-overlay`、关闭 `#btn-close-publish-modal`；
  - 预览：`#publish-cover-thumb`、`#publish-title`、`#publish-digest`、`#publish-digest-count`、`#publish-theme-badge`、`#publish-word-count`、`#publish-cover-status`、`#publish-use-cover`、`#publish-cover-toggle-row`；
  - 状态与动作：`#publish-conn-status`、`#btn-publish-push`；
  - 折叠配置：`#btn-publish-config-toggle`、`#publish-config-body`，输入沿用 `#push-api-key` / `#push-endpoint` / `#push-appid` / `#push-secret`；
  - 历史：`#publish-history-list`。

- [ ] **Step 1: 顶部按钮改名**

把 `web/index.html` 中：

```html
        <button class="btn btn-secondary" id="btn-push-draft" type="button" title="推送当前文章到微信公众号草稿箱（需在设置中配置 API Key）">
          <span id="icon-push"></span>
          <span>推送草稿箱</span>
        </button>
```

改为：

```html
        <button class="btn btn-secondary" id="btn-open-publish" type="button" title="打开发布工坊：预览并推送到微信公众号草稿箱">
          <span id="icon-push"></span>
          <span>发布</span>
        </button>
```

- [ ] **Step 2: 删除设置面板的「公众号推送」块**

在 `web/index.html` 设置面板中删除从 `<div class="settings-divider"></div>`（「双栏同步滚动」开关之后那一个）开始、到 AppID/Secret 那个 `settings-item` 的 `</div>` 结束的整块（含「公众号推送」settings-header 与三个 settings-item）。

- [ ] **Step 3: 插入发布工坊弹窗**

在 `web/index.html` 中 `id="cover-modal-overlay"` 弹窗的关闭 `</div>` 之后（与 changelog 弹窗同级），插入：

```html
    <!-- Publish Studio -->
    <div class="cover-modal-overlay" id="publish-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="publish-modal-title">
      <div class="cover-modal-window publish-modal-window">
        <div class="cover-modal-header">
          <div class="cover-header-title-group">
            <div class="cover-header-icon" id="icon-publish-window"></div>
            <div class="cover-header-title" id="publish-modal-title">
              <span>发布工坊</span>
              <span class="cover-header-badge">草稿箱直推</span>
            </div>
          </div>
          <button class="cover-modal-close-btn" id="btn-close-publish-modal" type="button" title="关闭 (Esc)">
            <span id="icon-publish-close"></span>
          </button>
        </div>
        <div class="cover-modal-body publish-modal-body">
          <div class="publish-preview">
            <div class="publish-cover-thumb" id="publish-cover-thumb">
              <div class="publish-cover-empty">暂无封面</div>
            </div>
            <div class="publish-fields">
              <input type="text" class="settings-input" id="publish-title" placeholder="标题（推送前必填）" autocomplete="off">
              <textarea class="settings-input publish-digest-input" id="publish-digest" rows="2" placeholder="摘要（留空则由服务端提取）"></textarea>
              <div class="publish-meta-row">
                <span class="publish-theme-badge" id="publish-theme-badge"></span>
                <span class="publish-word-count" id="publish-word-count"></span>
                <span class="publish-word-count" id="publish-digest-count"></span>
              </div>
            </div>
          </div>

          <div class="publish-cover-status" id="publish-cover-status"></div>

          <label class="publish-cover-toggle" id="publish-cover-toggle-row">
            <input type="checkbox" id="publish-use-cover">
            <span>使用封面工坊的封面（推送时自动导出上传）</span>
          </label>

          <div class="publish-conn-status" id="publish-conn-status"></div>

          <button class="btn btn-primary publish-push-btn" id="btn-publish-push" type="button">
            <span id="icon-publish-push"></span>
            <span>推送到草稿箱</span>
          </button>

          <div class="publish-config">
            <button type="button" class="publish-config-toggle" id="btn-publish-config-toggle">▸ 连接配置</button>
            <div class="publish-config-body" id="publish-config-body" hidden>
              <div class="settings-item">
                <div class="settings-label">推送 API Key</div>
                <input type="password" class="settings-input" id="push-api-key" placeholder="Worker 的 DRAFT_API_KEY" autocomplete="off">
              </div>
              <div class="settings-item">
                <div class="settings-label">推送端点 URL（留空 = 本站 /api/draft）</div>
                <input type="text" class="settings-input" id="push-endpoint" placeholder="https://gzh.9ej.com/api/draft" autocomplete="off">
              </div>
              <div class="settings-item">
                <div class="settings-label">AppID / Secret（可选，多公众号穿透）</div>
                <div class="push-cred-row">
                  <input type="text" class="settings-input" id="push-appid" placeholder="wx appid（可选）" autocomplete="off">
                  <input type="password" class="settings-input" id="push-secret" placeholder="wx secret（可选）" autocomplete="off">
                </div>
              </div>
              <div class="publish-history">
                <div class="settings-label">推送记录（本机最近 5 条）</div>
                <ul class="publish-history-list" id="publish-history-list"></ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: main.css 追加发布工坊样式**

在 `web/src/styles/main.css` 末尾追加：

```css
/* 发布工坊（Publish Studio） */
.publish-modal-window {
  max-width: 560px;
  width: 92vw;
}

.publish-modal-body {
  padding: 16px 18px 18px;
}

.publish-preview {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.publish-cover-thumb {
  flex: 0 0 150px;
  width: 150px;
  height: 64px;
  border: 1px solid var(--border-color, #e4e4e7);
  border-radius: 8px;
  overflow: hidden;
  position: relative;
  background: var(--control-bg, #f7f7f8);
}

.publish-cover-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.publish-cover-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 11px;
}

.publish-cover-scaled {
  transform-origin: top left;
}

.publish-fields {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.publish-fields .settings-input {
  margin-top: 0;
}

.publish-digest-input {
  resize: none;
}

.publish-meta-row {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--text-tertiary, #a1a1aa);
}

.publish-theme-badge {
  background: var(--accent-soft, #eff6ff);
  color: var(--accent, #2563eb);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
}

.publish-cover-status,
.publish-conn-status {
  margin-top: 12px;
  font-size: 12.5px;
  line-height: 1.6;
}

.publish-cover-status.is-ok,
.publish-conn-status.is-ok {
  color: #059669;
}

.publish-cover-status.is-warn,
.publish-conn-status.is-warn {
  color: #d97706;
}

.publish-cover-status.is-error {
  color: #dc2626;
}

.publish-cover-toggle {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--text-secondary, #52525b);
  cursor: pointer;
}

.publish-cover-toggle input {
  accent-color: var(--accent, #2563eb);
}

.publish-cover-toggle.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.publish-push-btn {
  width: 100%;
  margin-top: 12px;
  padding: 11px;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.publish-push-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.publish-config {
  margin-top: 14px;
  border-top: 1px solid var(--border-color, #e4e4e7);
  padding-top: 10px;
}

.publish-config-toggle {
  background: none;
  border: none;
  color: var(--text-secondary, #52525b);
  font-size: 12.5px;
  cursor: pointer;
  padding: 0;
}

.publish-config-body {
  margin-top: 10px;
}

.publish-config-body .settings-item {
  margin-bottom: 10px;
}

.publish-history {
  margin-top: 4px;
}

.publish-history-list {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-secondary, #52525b);
  max-height: 132px;
  overflow-y: auto;
}

.publish-history-list li {
  padding: 4px 0;
  border-bottom: 1px dashed var(--border-color, #e4e4e7);
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.publish-history-list .ph-time {
  color: var(--text-tertiary, #a1a1aa);
  flex: 0 0 auto;
}

.publish-history-list .ph-ok {
  color: #059669;
}

.publish-history-list .ph-fail {
  color: #dc2626;
}
```

- [ ] **Step 5: 构建验证**

```bash
cd web && npm run build 2>&1 | tail -3
```

Expected: vite build 成功（此任务纯静态结构，无 JS 逻辑变更，构建通过即可；app.js 尚未引用新 id，不报错）。

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/src/styles/main.css && git commit -m "feat(web): publish studio modal markup and styles"
```

---

### Task 3: app.js 接线 initPublishStudio

**Files:**
- Modify: `web/src/app.js`

**Interfaces:**
- Consumes: Task 1 的 `extractPublishMeta` / `buildPublishPayload` / `resolvePushConfig` / `readPushHistory` / `recordPush` / `countWords`；`canvas_exporter.js` 的 `renderCoverDirectCanvas(themeId, ratio, meta, scale) -> HTMLCanvasElement`；`cover.js` 的 `renderCoverHtml(themeId, ratio, meta, showSafeGuide) -> string` 与 `COVER_DIMENSIONS`；app.js 既有全局 `textarea` / `currentThemeId` / `currentCoverMeta` / `showToast` / `BUILTIN_THEMES` / `ICONS`。
- Produces: 弹窗完整交互。顶栏 `#btn-open-publish` 打开；`#btn-publish-push` 推送。旧函数 `handlePushDraft` 与 `initPushSettings` 删除；`init()` 中 `initPushSettings()` 调用替换为 `initPublishStudio()`。

- [ ] **Step 1: 调整 import 区**

`web/src/app.js` 顶部：把

```js
import { COVER_DIMENSIONS, extractCoverMeta, renderCoverHtml, THEME_COVER_PRESETS, WECHAT_CROP_COORDINATES } from './core/cover.js';
```

保持不变，并在 `canvas_exporter` 那行 import 中补入 `renderCoverDirectCanvas`（改为）：

```js
import { domToPngBlob, copyImageToClipboard, downloadImageBlob, renderCoverDirectCanvas } from './core/canvas_exporter.js';
```

新增一行：

```js
import { extractPublishMeta, buildPublishPayload, resolvePushConfig, readPushHistory, recordPush, countWords } from './core/publish.js';
```

同时在 `initIcons()` 内（`setIcon('#icon-push', 'send');` 附近）追加三行：

```js
  setIcon('#icon-publish-window', 'send');
  setIcon('#icon-publish-close', 'x');
  setIcon('#icon-publish-push', 'send');
```

- [ ] **Step 2: 删除旧推送代码**

删除 `handlePushDraft()` 整个函数与 `initPushSettings()` 整个函数；删除 `bindEvents()` 里的 `document.getElementById('btn-push-draft').addEventListener('click', handlePushDraft);` 一行。顶部的 4 个推送状态变量（`pushApiKey` 等）保留（`initPublishStudio` 继续使用）。

- [ ] **Step 3: 新增 initPublishStudio（放在 initChangelogModal 之后）**

```js
/**
 * 发布工坊：统一配置、预览、推送与历史
 */
function initPublishStudio() {
  const overlay = document.getElementById('publish-modal-overlay');
  const btnOpen = document.getElementById('btn-open-publish');
  const btnClose = document.getElementById('btn-close-publish-modal');
  const btnPush = document.getElementById('btn-publish-push');
  const titleInput = document.getElementById('publish-title');
  const digestInput = document.getElementById('publish-digest');
  const digestCount = document.getElementById('publish-digest-count');
  const themeBadge = document.getElementById('publish-theme-badge');
  const wordCount = document.getElementById('publish-word-count');
  const coverThumb = document.getElementById('publish-cover-thumb');
  const coverStatus = document.getElementById('publish-cover-status');
  const useCoverToggle = document.getElementById('publish-use-cover');
  const useCoverRow = document.getElementById('publish-cover-toggle-row');
  const connStatus = document.getElementById('publish-conn-status');
  const configToggle = document.getElementById('btn-publish-config-toggle');
  const configBody = document.getElementById('publish-config-body');
  const historyList = document.getElementById('publish-history-list');

  if (!overlay || !btnOpen) return;

  const configFields = [
    { id: 'push-api-key', key: 'md2wx_push_api_key', set: (v) => { pushApiKey = v; } },
    { id: 'push-endpoint', key: 'md2wx_push_endpoint', set: (v) => { pushEndpoint = v; } },
    { id: 'push-appid', key: 'md2wx_push_appid', set: (v) => { pushAppId = v; } },
    { id: 'push-secret', key: 'md2wx_push_secret', set: (v) => { pushSecret = v; } },
  ];

  // 输入即持久化（沿用旧键，老用户无感迁移）
  for (const f of configFields) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    el.value = localStorage.getItem(f.key) || '';
    el.addEventListener('input', () => {
      f.set(el.value.trim());
      localStorage.setItem(f.key, el.value.trim());
      renderConnStatus();
    });
  }

  function renderHistory() {
    const items = readPushHistory();
    historyList.innerHTML = items.length
      ? items.map((h) => {
          const time = new Date(h.t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const mark = h.ok ? '<span class="ph-ok">✓</span>' : '<span class="ph-fail">✗</span>';
          const detail = h.ok ? '' : `<span style="color:#dc2626;">${(h.msg || '').slice(0, 60)}</span>`;
          return `<li><span class="ph-time">${time}</span>${mark}<span>${h.title}</span>${detail}</li>`;
        }).join('')
      : '<li style="border:none;color:#a1a1aa;">暂无推送记录</li>';
  }

  function renderConnStatus() {
    const cfg = resolvePushConfig(pushApiKey, pushEndpoint);
    connStatus.className = 'publish-conn-status ' + (cfg.ok ? 'is-ok' : 'is-warn');
    connStatus.textContent = cfg.ok
      ? `● 已配置 · 端点 ${cfg.endpoint}`
      : `● ${cfg.reason}——展开下方「连接配置」填写`;
    btnPush.disabled = !cfg.ok || !titleInput.value.trim();
  }

  function renderCoverPreview() {
    const useWorkshop = useCoverToggle.checked;
    const meta = extractPublishMeta(textarea.value);
    if (useWorkshop) {
      // 封面工坊当前封面：CSS 同源渲染并等比缩到缩略尺寸
      const ratio = 150 / 1175;
      coverThumb.innerHTML = `<div class="publish-cover-scaled" style="width:1175px;height:500px;transform:scale(${ratio});">${renderCoverHtml(currentThemeId, 'banner', currentCoverMeta || {}, false)}</div>`;
      coverStatus.className = 'publish-cover-status is-ok';
      coverStatus.textContent = '封面来源：封面工坊 ✓（推送时自动导出上传）';
      return;
    }
    if (meta.coverImageSrc) {
      coverThumb.innerHTML = `<img src="${meta.coverImageSrc}" alt="cover">`;
      coverStatus.className = 'publish-cover-status is-ok';
      coverStatus.textContent = '封面来源：正文首图 ✓';
    } else {
      coverThumb.innerHTML = '<div class="publish-cover-empty">暂无封面</div>';
      coverStatus.className = 'publish-cover-status is-error';
      coverStatus.textContent = '⚠ 无封面——正文没有图片，微信将拒绝推送。请先在正文插入图片或使用封面工坊封面';
    }
  }

  function fillFromArticle() {
    const meta = extractPublishMeta(textarea.value);
    titleInput.value = meta.title;
    digestInput.value = meta.digest;
    themeBadge.textContent = (BUILTIN_THEMES[currentThemeId] || {}).name || currentThemeId;
    wordCount.textContent = `${countWords(textarea.value)} 字`;
    if (digestCount) digestCount.textContent = `${digestInput.value.length} 字`;
  }

  function refreshUseCoverAvailability() {
    // 工坊封面元数据存在即可勾选（打开过封面工坊或正文可提取）
    const available = !!currentCoverMeta || !!extractPublishMeta(textarea.value).title;
    useCoverRow.classList.toggle('is-disabled', !available);
    useCoverToggle.disabled = !available;
  }

  function openPublishModal() {
    fillFromArticle();
    refreshUseCoverAvailability();
    useCoverToggle.checked = localStorage.getItem('md2wx_push_use_cover') === '1' && !useCoverToggle.disabled;
    renderCoverPreview();
    renderConnStatus();
    renderHistory();
    overlay.classList.add('active');
  }

  function closePublishModal() {
    overlay.classList.remove('active');
  }

  btnOpen.addEventListener('click', openPublishModal);
  btnClose.addEventListener('click', closePublishModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePublishModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) closePublishModal();
  });

  titleInput.addEventListener('input', renderConnStatus);
  digestInput.addEventListener('input', () => {
    if (digestCount) digestCount.textContent = `${digestInput.value.length} 字`;
  });
  useCoverToggle.addEventListener('change', () => {
    localStorage.setItem('md2wx_push_use_cover', useCoverToggle.checked ? '1' : '0');
    renderCoverPreview();
  });

  configToggle.addEventListener('click', () => {
    configBody.hidden = !configBody.hidden;
    configToggle.textContent = configBody.hidden ? '▸ 连接配置' : '▾ 连接配置';
  });

  btnPush.addEventListener('click', async () => {
    const cfg = resolvePushConfig(pushApiKey, pushEndpoint);
    if (!cfg.ok || !titleInput.value.trim()) return;

    const origHtml = btnPush.innerHTML;
    btnPush.disabled = true;
    btnPush.innerHTML = `${ICONS.refresh}<span>推送中…</span>`;

    let coverDataUrl = '';
    try {
      if (useCoverToggle.checked) {
        const canvas = renderCoverDirectCanvas(currentThemeId, 'banner', currentCoverMeta || {}, 1);
        coverDataUrl = canvas.toDataURL('image/png');
      }
    } catch (e) {
      coverDataUrl = ''; // 导出失败回落正文首图
    }

    const payload = buildPublishPayload({
      markdown: textarea.value,
      theme: currentThemeId,
      title: titleInput.value,
      digest: digestInput.value,
      coverDataUrl,
      appId: pushAppId,
      appSecret: pushSecret,
    });

    try {
      const resp = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': pushApiKey },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.code === 0) {
        showToast('草稿推送成功！请到微信公众号后台查看');
        btnPush.innerHTML = `${ICONS.check}<span>已推送 ✓</span>`;
        recordPush({ t: Date.now(), title: titleInput.value, ok: true, mediaId: data.media_id });
        renderHistory();
        setTimeout(() => { btnPush.innerHTML = origHtml; renderConnStatus(); }, 1800);
      } else {
        const msg = data.msg || `HTTP ${resp.status}`;
        showToast('推送失败: ' + msg, 'error');
        recordPush({ t: Date.now(), title: titleInput.value, ok: false, msg });
        renderHistory();
        btnPush.innerHTML = origHtml;
        renderConnStatus();
      }
    } catch (err) {
      const msg = err.message || '网络错误';
      showToast('推送失败: ' + msg, 'error');
      recordPush({ t: Date.now(), title: titleInput.value, ok: false, msg });
      renderHistory();
      btnPush.innerHTML = origHtml;
      renderConnStatus();
    } finally {
      if (!btnPush.innerHTML.includes('已推送')) btnPush.disabled = false;
    }
  });
}
```

- [ ] **Step 4: init() 挂载**

`web/src/app.js` 的 `init()` 中，把 `initPushSettings();` 一行改为 `initPublishStudio();`（保持位置在 `initSettings();` 之后）。

- [ ] **Step 5: 构建验证**

```bash
cd web && npm run build 2>&1 | tail -3
```

Expected: vite build 成功。

- [ ] **Step 6: Commit**

```bash
git add web/src/app.js && git commit -m "feat(web): wire publish studio interactions in app.js"
```

---

### Task 4: 手工验证 + 触发线上部署

**Files:** 无新文件（验证与发布任务）。

- [ ] **Step 1: 本地端到端冒烟**

```bash
cd web && npm run build
cd ../cloudflare/md2wx-worker && cp -n .dev.vars.example .dev.vars 2>/dev/null; npx wrangler dev --port 8787
```

浏览器开 `http://127.0.0.1:3000`（另终端 `cd web && npm run dev`）验证清单：

- [ ] 顶栏「发布」按钮点击打开发布工坊弹窗；✕ / Esc / 点遮罩关闭
- [ ] 标题/摘要自动填入 frontmatter 值；清空 frontmatter 后打开，标题回退 H1
- [ ] 正文有图时封面状态「正文首图 ✓」，缩略显示；无图时红色警示
- [ ] 勾选「使用封面工坊的封面」→ 缩略变为工坊封面渲染
- [ ] 未配置 Key：推送按钮禁用 + 连接状态行黄色提示
- [ ] 配置 Key（dev-key-123，`.dev.vars`）后推送 → wrangler 日志可见 /api/draft 请求（假凭证会报 invalid appid，属预期）；失败项进入「推送记录」
- [ ] 设置面板不再有「公众号推送」块；顶栏按钮文案为「发布」

验证后停掉 wrangler dev 并确认 workerd 进程已退出（`netstat -ano | grep 8787`），删除本地 `.dev.vars`。

- [ ] **Step 2: 提交并推送触发线上部署**

```bash
git commit --allow-empty -m "ci: deploy publish studio" && git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push myfork main
```

- [ ] **Step 3: 线上验证**

构建检查通过（`gh api repos/myfx888/MD2WX/commits/<sha>/check-runs --jq '.check_runs[] | select(.name | contains("Workers Builds")) | .status + " " + (.conclusion // "")'` 出现 `completed success`）后：

```bash
curl -s --noproxy '*' https://gzh.9ej.com/ | grep -c "发布" | xargs echo "线上含发布按钮:"
curl -s --noproxy '*' https://gzh.9ej.com/api/health
```

Expected: 首页 HTML 含「发布」按钮文案；health 返回 `{"ok":true,"service":"md2wx-worker"}`。

---

## 任务依赖与交付物总览

- Task 1 → Task 2 → Task 3 顺序执行（Task 3 依赖 Task 1 的函数与 Task 2 的 DOM id）。
- Task 4 依赖前三者，含线上部署验证。
- 交付：发布工坊弹窗（配置 + 预览 + 推送 + 历史统一入口）、纯逻辑层及其测试、线上部署。
