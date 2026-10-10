# 配图文件夹载入 + 批量上传素材库替换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在 MD2WX 工作台载入本地配图文件夹后,预览实时显示真图;人工检查后一键批量上传公众号素材库并把文中相对路径替换为微信 URL。

**Architecture:** 纯前端方案。新增纯逻辑模块 `figuremap.js`(引用收集/智能匹配/预览替换/源文本替换,Node 可测);`app.js` 增加会话态(文件夹 File 表 + blob URL + 匹配/上传状态),在 `renderPreview()` 的 HTML 输出层做显示级替换,上传成功后才把微信 URL 写回编辑器源文本。Worker 零改动,复用现有 `/api/wx-image` 与 `uploadImageFile()`。

**Tech Stack:** Vite + 原生 JavaScript(前端);esbuild 打包 + Node 内建 test runner(测试,模式同 `cloudflare/md2wx-worker/test/publish.test.mjs`)。

**Spec:** `docs/superpowers/specs/2026-10-10-figure-folder-upload-design.md`

## Global Constraints

- 零外部依赖:不新增任何 npm 包,纯原生 JS/CSS(AGENTS.md 设计哲学)
- Worker 侧零改动:不改 `worker.js`、不改 `/api/wx-image` 契约、不动既有 7 个测试文件
- 图片 MIME 清单恒为 `['image/png', 'image/jpeg', 'image/webp', 'image/gif']`,单文件上限 `10 * 1024 * 1024` 字节(与 `imagehost.js` 的 `IMAGE_HOST_ACCEPT` / `IMAGE_HOST_MAX_BYTES` 语义一致)
- 匹配大小写敏感;归一化 = 剥 `./` 前缀、`\` 转 `/`、合并连续 `/`
- 编辑器源文本在用户显式点「上传素材库并替换」前必须保持相对路径不变
- 会话态不进 localStorage(blob URL 会话性,刷新失效属预期)
- 所有命令在 `E:\code\opensaas\zcodeapi\gzh\MD2WX` 下执行;前端测试跑 `cd cloudflare/md2wx-worker && npm test`,前端构建跑 `cd web && npm run build`

---

### Task 1: figuremap.js — 路径归一化与引用收集

**Files:**
- Create: `web/src/core/figuremap.js`
- Create: `cloudflare/md2wx-worker/test/figuremap.test.mjs`
- Modify: `cloudflare/md2wx-worker/package.json`(build:test 与 test 两个 script 各追加一段)

**Interfaces:**
- Consumes: 无
- Produces: `normalizePath(p: string): string`、`collectImageRefs(markdown: string): Array<{ raw: string, path: string, kind: 'md' | 'html' }>`(后续 Task 2/3 及 Task 5 依赖)

- [ ] **Step 1: 写失败测试**

创建 `cloudflare/md2wx-worker/test/figuremap.test.mjs`:

```js
/**
 * figuremap 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, collectImageRefs } from './.figuremap.bundle.mjs';

describe('normalizePath', () => {
  it('剥 ./ 前缀并统一分隔符', () => {
    assert.equal(normalizePath('./images/01.png'), 'images/01.png');
    assert.equal(normalizePath('.\\imgs\\a\\b.png'), 'imgs/a/b.png');
    assert.equal(normalizePath('a//b.png'), 'a/b.png');
    assert.equal(normalizePath('  images/x.png  '), 'images/x.png');
  });
});

describe('collectImageRefs', () => {
  it('收集 Markdown 与 HTML 引用并标注 kind', () => {
    const md = '![a](images/1.png)\n正文\n<img src="images/2.png" alt="b">';
    const refs = collectImageRefs(md);
    assert.deepEqual(
      refs.map((r) => [r.path, r.kind]),
      [['images/1.png', 'md'], ['images/2.png', 'html']]
    );
  });
  it('跳过远程与 data: 引用,支持 title 属性形态', () => {
    const md = '![x](https://mmbiz.qpic.cn/a.png) ![y](data:image/png;base64,AAA) ![t](local/3.png "标题")';
    const refs = collectImageRefs(md);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].path, 'local/3.png');
    assert.equal(refs[0].kind, 'md');
  });
  it('同一本地路径只收集一次', () => {
    const refs = collectImageRefs('![a](p.png)\n![b](p.png)\n<img src="p.png">');
    assert.equal(refs.length, 1);
  });
  it('空输入返回空数组', () => {
    assert.deepEqual(collectImageRefs(''), []);
    assert.deepEqual(collectImageRefs(null), []);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd cloudflare/md2wx-worker && npm run build:test && node --test test/figuremap.test.mjs`
Expected: FAIL,报错 `Cannot find module './.figuremap.bundle.mjs'`(bundle 尚未配置、模块尚未创建)

- [ ] **Step 3: 创建模块与测试打包配置**

创建 `web/src/core/figuremap.js`:

```js
/**
 * MD2WX 配图映射纯逻辑层:图片引用收集、智能匹配、预览替换、源文本替换。
 * 零 DOM 依赖(Node 可测);路径归一化 = 剥 ./ 前缀、\ 转 /、合并连续 /,大小写敏感。
 */

/** 归一化路径:剥 ./ 前缀、\ 统一为 /、合并连续 /、去首尾空白 */
export function normalizePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/\/{2,}/g, '/');
}

/** 取 basename('images/01.png' -> '01.png') */
function basename(p) {
  const s = normalizePath(p);
  const idx = s.lastIndexOf('/');
  return idx === -1 ? s : s.slice(idx + 1);
}

/** 已远程的引用(协议相对 //、http(s)://、data:)不参与本地匹配 */
function isRemoteRef(path) {
  return /^(https?:)?\/\//i.test(path) || /^data:/i.test(path);
}

/**
 * 收集文中图片引用,返回 [{ raw, path, kind: 'md' | 'html' }]。
 * raw 与 path 相同(保留原文写法作替换键);已远程引用与重复路径跳过。
 */
export function collectImageRefs(markdown) {
  const text = String(markdown || '');
  const refs = [];
  const seen = new Set();
  let m;

  // Markdown: ![alt](path) / ![alt](path "title")
  const mdRe = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  while ((m = mdRe.exec(text)) !== null) {
    const p = m[1];
    if (isRemoteRef(p) || seen.has(p)) continue;
    seen.add(p);
    refs.push({ raw: p, path: p, kind: 'md' });
  }

  // HTML: <img ... src="path"> / src='path'
  const htmlRe = /<img\s+[^>]*?src=(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = htmlRe.exec(text)) !== null) {
    const p = m[1] !== undefined ? m[1] : m[2];
    if (isRemoteRef(p) || seen.has(p)) continue;
    seen.add(p);
    refs.push({ raw: p, path: p, kind: 'html' });
  }

  return refs;
}
```

修改 `cloudflare/md2wx-worker/package.json` 的 `scripts`:

```json
  "scripts": {
    "build:test": "esbuild worker.js --bundle --format=esm --outfile=test/.worker.bundle.mjs --loader:.png=dataurl && esbuild ../../web/src/core/publish.js --bundle --format=esm --outfile=test/.publish.bundle.mjs && esbuild ../../web/src/core/customThemes.js --bundle --format=esm --outfile=test/.custom.bundle.mjs && esbuild ../../web/src/core/figuremap.js --bundle --format=esm --outfile=test/.figuremap.bundle.mjs",
    "test": "npm run build:test && node --test test/engine.test.mjs test/publish.test.mjs test/customThemes.test.mjs test/hub-auth.test.mjs test/hub-store.test.mjs test/hub-routes.test.mjs test/hub-preview.test.mjs test/figuremap.test.mjs",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd cloudflare/md2wx-worker && node --test test/figuremap.test.mjs`
Expected: PASS(5 个用例全绿)

- [ ] **Step 5: 提交**

```bash
git add web/src/core/figuremap.js cloudflare/md2wx-worker/test/figuremap.test.mjs cloudflare/md2wx-worker/package.json
git commit -m "feat(figure): figuremap pure-logic module — path normalize + image ref collection"
```

---

### Task 2: figuremap.js — 智能匹配 matchFiles

**Files:**
- Modify: `web/src/core/figuremap.js`(文件末尾追加)
- Modify: `cloudflare/md2wx-worker/test/figuremap.test.mjs`(import 行与文件末尾追加)

**Interfaces:**
- Consumes: `normalizePath`(Task 1)
- Produces: `matchFiles(refs, files) -> Map<rawPath, { file, filePath, matchType: 'exact'|'filename', status: 'matched' } | { file: null, filePath: null, status: 'unmatched' } | { file: null, filePath: null, status: 'conflict', conflicts: string[] }>`,其中 `files` 入参为 `Array<{ path: string, file: any }>`;`filePath` 为命中文件的文件夹内归一化路径(Task 5/6 去重上传依赖)

- [ ] **Step 1: 写失败测试**

在 `test/figuremap.test.mjs` 顶部 import 行改为:

```js
import { normalizePath, collectImageRefs, matchFiles } from './.figuremap.bundle.mjs';
```

文件末尾追加:

```js
describe('matchFiles', () => {
  const files = [
    { path: 'images/01.png', file: { name: '01.png' } },
    { path: 'images/02.png', file: { name: '02.png' } },
    { path: 'extra/03.png', file: { name: '03.png' } },
  ];
  it('精确路径命中并带 filePath', () => {
    const m = matchFiles([{ path: 'images/01.png' }], files);
    assert.equal(m.get('images/01.png').status, 'matched');
    assert.equal(m.get('images/01.png').matchType, 'exact');
    assert.equal(m.get('images/01.png').filePath, 'images/01.png');
  });
  it('./ 前缀与反斜杠归一化后精确命中', () => {
    const m = matchFiles([{ path: './images\\01.png' }], files);
    assert.equal(m.get('./images\\01.png').matchType, 'exact');
  });
  it('文件名在文件夹内唯一时回落命中', () => {
    const m = matchFiles([{ path: '03.png' }], files);
    assert.equal(m.get('03.png').status, 'matched');
    assert.equal(m.get('03.png').matchType, 'filename');
    assert.equal(m.get('03.png').filePath, 'extra/03.png');
  });
  it('重名冲突标记 conflict 并按路径排序列出候选', () => {
    const fs2 = [...files, { path: 'backup/03.png', file: { name: '03.png' } }];
    const m = matchFiles([{ path: '03.png' }], fs2);
    assert.equal(m.get('03.png').status, 'conflict');
    assert.deepEqual(m.get('03.png').conflicts, ['backup/03.png', 'extra/03.png']);
  });
  it('无候选标记 unmatched', () => {
    const m = matchFiles([{ path: 'nope.png' }], files);
    assert.equal(m.get('nope.png').status, 'unmatched');
  });
  it('大小写敏感:IMG.PNG 不命中 img.png', () => {
    const m = matchFiles([{ path: 'IMG.PNG' }], [{ path: 'img.png', file: { name: 'img.png' } }]);
    assert.equal(m.get('IMG.PNG').status, 'unmatched');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd cloudflare/md2wx-worker && node --test test/figuremap.test.mjs`
Expected: FAIL,`matchFiles is not a function`(打包产物中尚无该导出)

- [ ] **Step 3: 实现最小实现**

在 `web/src/core/figuremap.js` 末尾追加:

```js
/**
 * 智能匹配:第一轮归一化相对路径精确;第二轮 basename 唯一回落;同名多个 -> conflict。
 * files: [{ path, file }](path 为文件夹内相对路径)。
 * 返回 Map<rawPath, 结果>;结果恒含 status,matched 另含 file/filePath/matchType,
 * conflict 另含 conflicts(排序后的候选路径数组)。
 */
export function matchFiles(refs, files) {
  const result = new Map();
  const byPath = new Map();
  const byName = new Map();
  for (const f of files) {
    const np = normalizePath(f.path);
    byPath.set(np, f);
    const name = basename(np);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(np);
  }

  for (const ref of refs) {
    const np = normalizePath(ref.path);
    if (byPath.has(np)) {
      result.set(ref.path, { file: byPath.get(np).file, filePath: np, matchType: 'exact', status: 'matched' });
      continue;
    }
    const candidates = (byName.get(basename(np)) || []).slice().sort();
    if (candidates.length === 1) {
      const hit = byPath.get(candidates[0]);
      result.set(ref.path, { file: hit.file, filePath: candidates[0], matchType: 'filename', status: 'matched' });
    } else if (candidates.length > 1) {
      result.set(ref.path, { file: null, filePath: null, status: 'conflict', conflicts: candidates });
    } else {
      result.set(ref.path, { file: null, filePath: null, status: 'unmatched' });
    }
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd cloudflare/md2wx-worker && node --test test/figuremap.test.mjs`
Expected: PASS(11 个用例全绿)

- [ ] **Step 5: 提交**

```bash
git add web/src/core/figuremap.js cloudflare/md2wx-worker/test/figuremap.test.mjs
git commit -m "feat(figure): smart matching — exact relative path first, unique-filename fallback, conflict detection"
```

---

### Task 3: figuremap.js — 源文本替换与预览替换

**Files:**
- Modify: `web/src/core/figuremap.js`(文件末尾追加)
- Modify: `cloudflare/md2wx-worker/test/figuremap.test.mjs`(import 行与文件末尾追加)

**Interfaces:**
- Consumes: `normalizePath` 无直接依赖,但替换键为 raw 路径(Task 1 约定)
- Produces: `applyPreviewMap(html: string, blobUrlMap: Map<string, string>): string`(Task 5 预览层调用);`replaceInMarkdown(markdown: string, urlMap: Map<string, string>): string`(Task 6 写回调用)。两者均带定界符防子串误伤,替换值中的 `$` 已转义

- [ ] **Step 1: 写失败测试**

import 行改为:

```js
import { normalizePath, collectImageRefs, matchFiles, applyPreviewMap, replaceInMarkdown } from './.figuremap.bundle.mjs';
```

文件末尾追加:

```js
describe('replaceInMarkdown', () => {
  it('同一文件多处引用全部替换,保留 title', () => {
    const md = '![a](img/1.png)\n![b](img/1.png "标题")\n![c](img/2.png)';
    const out = replaceInMarkdown(md, new Map([['img/1.png', 'https://mmbiz.qpic.cn/x.png']]));
    assert.equal(out, '![a](https://mmbiz.qpic.cn/x.png)\n![b](https://mmbiz.qpic.cn/x.png "标题")\n![c](img/2.png)');
  });
  it('子串路径不误伤(01.png 不动 101.png)', () => {
    const md = '![a](101.png)';
    const out = replaceInMarkdown(md, new Map([['01.png', 'https://wx/1.png']]));
    assert.equal(out, '![a](101.png)');
  });
  it('路径作为更长路径中段时不误伤', () => {
    const md = '![a](images/old-01.png)';
    const out = replaceInMarkdown(md, new Map([['01.png', 'https://wx/1.png']]));
    assert.equal(out, '![a](images/old-01.png)');
  });
  it('HTML img src 同步替换(单双引号)', () => {
    const md = '<img src="img/1.png" alt="a"><img src=\'img/2.png\'>';
    const out = replaceInMarkdown(md, new Map([['img/1.png', 'https://wx/1.png'], ['img/2.png', 'https://wx/2.png']]));
    assert.equal(out, '<img src="https://wx/1.png" alt="a"><img src=\'https://wx/2.png\'>');
  });
  it('无匹配时原文返回', () => {
    const md = '![a](other.png)';
    assert.equal(replaceInMarkdown(md, new Map([['x.png', 'https://wx/x.png']])), md);
  });
  it('空 urlMap 原文返回', () => {
    const md = '![a](other.png)';
    assert.equal(replaceInMarkdown(md, new Map()), md);
  });
});

describe('applyPreviewMap', () => {
  it('把匹配路径换成 blob URL,未匹配保留原样', () => {
    const html = '<p style="x">前言</p><img src="img/1.png" alt="a"><img src="img/9.png">';
    const out = applyPreviewMap(html, new Map([['img/1.png', 'blob:http://localhost/abc']]));
    assert.equal(out, '<p style="x">前言</p><img src="blob:http://localhost/abc" alt="a"><img src="img/9.png">');
  });
  it('空 Map 原文返回', () => {
    const html = '<img src="img/1.png">';
    assert.equal(applyPreviewMap(html, new Map()), html);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd cloudflare/md2wx-worker && node --test test/figuremap.test.mjs`
Expected: FAIL,`replaceInMarkdown is not a function`

- [ ] **Step 3: 实现最小实现**

在 `web/src/core/figuremap.js` 末尾追加:

```js
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 替换值里的 $ 转义,避免 String.replace 的 $&/$1 语义吞字符 */
function escapeReplacement(s) {
  return String(s).replace(/\$/g, '$$$$');
}

/** html 中替换 src="path" / src='path'(预览层与源文本 html 形态共用) */
function replacePathInHtml(html, path, newUrl) {
  const re = new RegExp(`(src=)(["'])${escapeRegExp(path)}\\2`, 'g');
  return html.replace(re, (_m, eq, q) => `${eq}${q}${newUrl}${q}`);
}

/**
 * 显示级替换:html 字符串里匹配路径的 src -> blob URL。仅用于预览渲染,不触碰编辑器文本。
 */
export function applyPreviewMap(html, blobUrlMap) {
  let out = String(html || '');
  for (const [path, blobUrl] of blobUrlMap) {
    out = replacePathInHtml(out, path, blobUrl);
  }
  return out;
}

/**
 * 源文本替换:urlMap 为 Map<rawPath, wxUrl>。
 * 定界符:md 的 ](path) / (path "title")(title 保留),html 的 src="path";
 * 子串路径(01.png vs 101.png)因定界符不会误伤。
 */
export function replaceInMarkdown(markdown, urlMap) {
  let out = String(markdown || '');
  for (const [path, url] of urlMap) {
    out = replacePathInHtml(out, path, url);
    const mdRe = new RegExp(`(\\]\\(\\s*)${escapeRegExp(path)}(\\s*(?:"[^"]*")?\\s*\\))`, 'g');
    out = out.replace(mdRe, (_m, pre, post) => `${pre}${url}${post}`);
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd cloudflare/md2wx-worker && node --test test/figuremap.test.mjs`
Expected: PASS(19 个用例全绿)

- [ ] **Step 5: 跑完整 worker 测试套确认无回归**

Run: `cd cloudflare/md2wx-worker && npm test`
Expected: PASS(既有 80 用例 + 新增 19 用例全绿)

- [ ] **Step 6: 提交**

```bash
git add web/src/core/figuremap.js cloudflare/md2wx-worker/test/figuremap.test.mjs
git commit -m "feat(figure): delimited source replacement + preview blob mapping — substring-safe, title preserved"
```

---

### Task 4: 状态条与明细浮层 DOM + 样式

**Files:**
- Modify: `web/index.html:156`(图片菜单加「载入配图文件夹」按钮)、`web/index.html:179`(隐藏目录 input)、`web/index.html:247`(`.preview-canvas` 内加状态条与明细面板)
- Modify: `web/src/styles/preview.css:57-63`(`.preview-canvas` 加 `position: relative`)与文件末尾追加样式块

**Interfaces:**
- Consumes: 无(纯静态 DOM/CSS)
- Produces: 元素 ID `figure-folder-trigger`、`figure-folder-input`、`figure-status-bar`、`figure-bar-text`、`figure-details-toggle`、`figure-retry-btn`、`figure-upload-btn`、`figure-details-panel`(Task 5/6 的 JS 按 these IDs 查找)

- [ ] **Step 1: index.html 图片菜单加按钮**

在 `<button class="image-menu-upload" id="image-upload-trigger" ...>`(约 156 行)之后加:

```html
                <button class="image-menu-upload" id="figure-folder-trigger" type="button" title="载入本地配图文件夹:预览实时显示,检查后批量上传素材库替换">载入配图文件夹</button>
```

- [ ] **Step 2: index.html 加隐藏目录 input**

在 `<input type="file" id="image-file-input" ...>`(约 179 行)之后加:

```html
        <input type="file" id="figure-folder-input" webkitdirectory multiple hidden />
```

- [ ] **Step 3: index.html 预览画布加状态条与明细面板**

在 `<!-- Bottom Home Indicator -->`(约 258 行)之前、`</div>`(`phone-content-scroll` 闭合)之后,即 `.mobile-device-frame` 闭合 `</div>` 与 `.floating-actions` 之间,插入:

```html
          <!-- 配图文件夹会话:状态条 + 明细浮层(载入文件夹后显示) -->
          <div class="figure-status-bar" id="figure-status-bar">
            <span id="figure-bar-text"></span>
            <span class="figure-bar-actions">
              <button class="figure-bar-btn" id="figure-details-toggle" type="button">明细 ▾</button>
              <button class="figure-bar-btn" id="figure-retry-btn" type="button" hidden>重试失败项</button>
              <button class="figure-bar-btn figure-bar-btn-primary" id="figure-upload-btn" type="button">上传素材库并替换</button>
            </span>
          </div>
          <div class="figure-details-panel" id="figure-details-panel" hidden></div>
```

- [ ] **Step 4: preview.css 定位与样式**

`.preview-canvas` 规则(约 57 行)的声明块中追加一行 `position: relative;`:

```css
.preview-canvas {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow-y: auto;
```

文件末尾追加:

```css
/* ============================== 配图文件夹:状态条与明细浮层 ============================== */
.figure-status-bar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: none;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: #1f2937;
  color: #f9fafb;
  border-radius: 999px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  white-space: nowrap;
}
.figure-status-bar.show { display: flex; }
.figure-bar-actions { display: inline-flex; gap: 8px; align-items: center; }
.figure-bar-btn {
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: transparent;
  color: #f9fafb;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.figure-bar-btn:hover { border-color: rgba(255, 255, 255, 0.7); }
.figure-bar-btn-primary { background: #10b981; border-color: #10b981; }
.figure-bar-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.figure-details-panel {
  position: absolute;
  top: 52px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  width: min(520px, 92%);
  max-height: 60%;
  overflow-y: auto;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  padding: 10px;
}
.figure-detail-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px solid #f3f4f6;
}
.figure-detail-row:last-child { border-bottom: none; }
.figure-detail-thumb {
  width: 56px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  background: #f3f4f6;
  flex: none;
}
.figure-detail-path { flex: 1; font-size: 12px; color: #374151; word-break: break-all; }
.figure-detail-badge { font-size: 11px; border-radius: 4px; padding: 2px 6px; white-space: nowrap; }
.figure-badge-exact { background: #d1fae5; color: #065f46; }
.figure-badge-filename { background: #dbeafe; color: #1e40af; }
.figure-badge-unmatched { background: #f3f4f6; color: #6b7280; }
.figure-badge-conflict { background: #fef3c7; color: #92400e; }
.figure-badge-failed { background: #fee2e2; color: #991b1b; }
.figure-badge-done { background: #d1fae5; color: #065f46; }
```

- [ ] **Step 5: 构建验证**

Run: `cd web && npm run build`
Expected: 构建成功无报错;浏览器打开 dist 或 `npm run dev` 目视确认:图片菜单出现「载入配图文件夹」按钮,预览区默认无状态条(DOM 存在但未显示)

- [ ] **Step 6: 提交**

```bash
git add web/index.html web/src/styles/preview.css
git commit -m "feat(figure): status bar + details overlay DOM and styles on preview canvas"
```

---

### Task 5: app.js — 会话构建、预览实时映射、状态条渲染

**Files:**
- Modify: `web/src/app.js`(顶部 import 区、`renderPreview()` 约 443 行、`bindEvents()` 图片菜单段约 841-1024 行;figure 系列函数为模块级新增,插在 `scheduleRender()` 约 505 行之后)

**Interfaces:**
- Consumes: `collectImageRefs / matchFiles / applyPreviewMap / normalizePath`(Task 1-3);Task 4 的全部元素 ID;既有模块级 `textarea / scheduleRender / showToast`
- Produces: 模块级 `figureSession`(结构见下)与 `loadFigureFolder(fileEntries: Array<{file: File, path: string}>)`(Task 6 的上传编排读取 `figureSession.items`,每项含 `path / filePath / file / blobUrl / status / upload / wxUrl / error`)

- [ ] **Step 1: 顶部 import 追加**

`app.js` 现有 `from './core/imagehost.js'` 的 import 块之后加:

```js
import { collectImageRefs, matchFiles, applyPreviewMap } from './core/figuremap.js';
```

- [ ] **Step 2: 模块级会话与构建逻辑**

在 `scheduleRender()` 函数(约 505 行)之后插入:

```js
  // ============================== 配图文件夹会话 ==============================
  // blob URL 是会话性的:不持久化,刷新失效属预期;重新载入文件夹即可重建。
  // session = { files: Map<folderPath, File>, items: [...], uploaded: number, uploading: bool, progress: {cur,total}|null, detailsOpen: bool }
  let figureSession = null;

  const FIGURE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const FIGURE_MAX_BYTES = 10 * 1024 * 1024;

  /** 载入文件夹(目录选择器与拖拽共用入口):过滤、匹配、建 blob URL、刷新渲染 */
  function loadFigureFolder(fileEntries) {
    if (figureSession) {
      for (const it of figureSession.items) {
        if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
      }
    }
    const files = new Map();
    let skipped = 0;
    for (const { file, path } of fileEntries) {
      if (!FIGURE_ACCEPT.includes(file.type) || file.size > FIGURE_MAX_BYTES) { skipped++; continue; }
      files.set(path, file);
    }
    figureSession = { files, items: [], uploaded: 0, uploading: false, progress: null, detailsOpen: false };
    refreshFigureMatches();
    if (skipped > 0) showToast(`已跳过 ${skipped} 个非图片或超 10MB 的文件`, 'error');
    renderFigureBar();
    scheduleRender();
  }

  /** 按当前编辑器文本重建匹配与 blob(上传状态按 路径+文件 保留),每次渲染前调用 */
  function refreshFigureMatches() {
    if (!figureSession) return;
    const prev = new Map(figureSession.items.map((it) => [it.path, it]));
    const refs = collectImageRefs(textarea.value);
    const entries = [...figureSession.files.entries()].map(([path, file]) => ({ path, file }));
    const matchResult = matchFiles(refs, entries);
    figureSession.items = refs.map((ref) => {
      const m = matchResult.get(ref.path);
      const old = prev.get(ref.path);
      const keep = old && old.status === 'matched' && old.filePath === (m.filePath || null);
      const item = {
        path: ref.path,
        filePath: m.filePath || null,
        file: m.file || null,
        blobUrl: keep ? old.blobUrl : (m.file ? URL.createObjectURL(m.file) : null),
        status: m.status,
        matchType: m.matchType || null,
        conflicts: m.conflicts || null,
        upload: keep ? old.upload : 'pending',
        wxUrl: keep ? old.wxUrl : '',
        error: keep ? old.error : '',
      };
      if (!keep && old && old.blobUrl && old.blobUrl !== item.blobUrl) {
        URL.revokeObjectURL(old.blobUrl);
      }
      return item;
    });
  }

  /** 预览 HTML 输出层的显示级替换(renderPreview 专属) */
  function applyFigurePreview(html) {
    if (!figureSession) return html;
    const blobMap = new Map();
    for (const it of figureSession.items) {
      if (it.blobUrl && it.upload !== 'done') blobMap.set(it.path, it.blobUrl);
    }
    return applyPreviewMap(html, blobMap);
  }

  /** 状态条 + 明细浮层渲染(figureSession 为空时隐藏) */
  function renderFigureBar() {
    const bar = document.getElementById('figure-status-bar');
    if (!bar) return;
    if (!figureSession) { bar.classList.remove('show'); return; }
    bar.classList.add('show');
    const total = figureSession.items.length;
    const unmatched = figureSession.items.filter((it) => it.status !== 'matched').length;
    const text = document.getElementById('figure-bar-text');
    if (text) {
      text.textContent = figureSession.uploading
        ? `上传中 ${figureSession.progress ? figureSession.progress.cur : 0}/${figureSession.progress ? figureSession.progress.total : 0}…`
        : `本地配图 ${total} · 未匹配 ${unmatched} · 已上传 ${figureSession.uploaded}`;
    }
    const uploadBtn = document.getElementById('figure-upload-btn');
    if (uploadBtn) {
      uploadBtn.disabled = figureSession.uploading || !isImageHostConfigured();
      uploadBtn.title = isImageHostConfigured() ? '' : IMAGE_HOST_UNCONFIGURED_HINT;
    }
    const failed = figureSession.items.filter((it) => it.upload === 'failed').length;
    const retryBtn = document.getElementById('figure-retry-btn');
    if (retryBtn) retryBtn.hidden = !failed || figureSession.uploading;
    renderFigureDetails();
  }

  const FIGURE_BADGE = {
    exact: ['exact', '精确'],
    filename: ['filename', '文件名'],
    unmatched: ['unmatched', '未匹配'],
    conflict: ['conflict', '重名冲突'],
  };

  function renderFigureDetails() {
    const panel = document.getElementById('figure-details-panel');
    if (!panel) return;
    panel.hidden = !figureSession || !figureSession.detailsOpen;
    if (panel.hidden || !figureSession) return;
    panel.innerHTML = figureSession.items.map((it) => {
      let badge;
      if (it.upload === 'failed') badge = '<span class="figure-detail-badge figure-badge-failed">失败</span>';
      else if (it.upload === 'done') badge = '<span class="figure-detail-badge figure-badge-done">已上传 ✓</span>';
      else if (it.status === 'matched') {
        const [cls, label] = FIGURE_BADGE[it.matchType] || FIGURE_BADGE.exact;
        badge = `<span class="figure-detail-badge figure-badge-${cls}">${label}</span>`;
      } else if (it.status === 'conflict') {
        badge = `<span class="figure-detail-badge figure-badge-conflict" title="${it.conflicts.join('、')}">重名冲突</span>`;
      } else {
        badge = '<span class="figure-detail-badge figure-badge-unmatched">未匹配</span>';
      }
      const thumbSrc = it.upload === 'done' && it.wxUrl ? it.wxUrl : (it.blobUrl || '');
      return `<div class="figure-detail-row">` +
        (thumbSrc ? `<img class="figure-detail-thumb" src="${thumbSrc}" alt="">` : '<span class="figure-detail-thumb"></span>') +
        `<span class="figure-detail-path">${it.path}${it.upload === 'failed' ? ' — ' + it.error : ''}</span>${badge}</div>`;
    }).join('');
  }
```

- [ ] **Step 3: renderPreview 挂钩**

`renderPreview()`(约 443 行)中,`previewTarget.innerHTML = currentHtmlOutput;` 一行改为:

```js
  refreshFigureMatches();
  currentHtmlOutput = applyFigurePreview(currentHtmlOutput);
  previewTarget.innerHTML = currentHtmlOutput;

  saveDraft(rawText);
  renderFigureBar();
```

(即原 `previewTarget.innerHTML = currentHtmlOutput;` 替换为上面前三行,并在 `saveDraft(rawText);` 后追加 `renderFigureBar();`)

- [ ] **Step 4: bindEvents 接线 — 菜单按钮与目录选择器**

在 `bindEvents()` 内、`imageFileInput?.addEventListener('change', ...)` 块之后插入:

```js
  // 配图文件夹:目录选择器入口(拖拽入口见下方 drop handler 扩展)
  const figureFolderTrigger = document.getElementById('figure-folder-trigger');
  const figureFolderInput = document.getElementById('figure-folder-input');
  figureFolderTrigger?.addEventListener('click', () => {
    figureFolderInput?.click();
  });
  figureFolderInput?.addEventListener('change', () => {
    const list = figureFolderInput.files;
    figureFolderInput.value = '';
    if (!list || !list.length) return;
    const entries = [...list].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    loadFigureFolder(entries);
  });

  // 状态条按钮:明细开关(上传/重试在 Task 6 接线)
  document.getElementById('figure-details-toggle')?.addEventListener('click', () => {
    if (!figureSession) return;
    figureSession.detailsOpen = !figureSession.detailsOpen;
    const t = document.getElementById('figure-details-toggle');
    if (t) t.textContent = figureSession.detailsOpen ? '明细 ▴' : '明细 ▾';
    renderFigureBar();
  });
```

- [ ] **Step 5: bindEvents 接线 — 拖拽目录支持**

将现有 drop handler:

```js
    textareaWrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      textareaWrapper.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.type.startsWith('image/')) {
          handleImageUpload(file, file.name.replace(/\.[^.]+$/, '') || '图片');
        }
      }
    });
```

改为:

```js
    textareaWrapper.addEventListener('drop', async (e) => {
      e.preventDefault();
      textareaWrapper.classList.remove('drag-over');
      // 目录项优先:含文件夹时整包走配图会话,单个图片文件走原直传
      const items = e.dataTransfer?.items;
      const entries = [];
      if (items && items.length && items[0].webkitGetAsEntry) {
        for (const item of items) {
          const en = item.webkitGetAsEntry && item.webkitGetAsEntry();
          if (en) entries.push(en);
        }
      }
      if (entries.some((en) => en.isDirectory)) {
        const collected = await collectEntryFiles(entries);
        if (collected.length) loadFigureFolder(collected);
        return;
      }
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.type.startsWith('image/')) {
          handleImageUpload(file, file.name.replace(/\.[^.]+$/, '') || '图片');
        }
      }
    });
```

并在 `bindEvents()` 函数体外(模块级,紧邻 figure 会话函数区)加递归收集器:

```js
/** 递归收集拖入目录的文件,返回 [{ file, path }];path 取 entry.fullPath 去首斜杠 */
function collectEntryFiles(fsEntries) {
  const out = [];
  const walk = (entry) => new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => { out.push({ file: f, path: entry.fullPath.replace(/^\//, '') }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();
        for (const child of batch) await walk(child);
        readBatch(); // readEntries 单次上限约 100 条,读到空为止
      }, () => resolve());
      readBatch();
    } else resolve();
  });
  return (async () => {
    for (const en of fsEntries) await walk(en);
    return out;
  })();
}
```

- [ ] **Step 6: 构建与回归验证**

Run: `cd web && npm run build && cd ../cloudflare/md2wx-worker && npm test`
Expected: 构建成功;80 个既有用例全绿。浏览器手测:载入一个含配图的文件夹 → 预览立即显示真图;编辑文字预览滚动重渲染不裂图;明细开关展示徽章。

- [ ] **Step 7: 提交**

```bash
git add web/src/app.js
git commit -m "feat(figure): folder session — realtime blob preview mapping, status bar, folder drop support"
```

---

### Task 6: app.js — 批量上传编排、写回替换、失败重试

**Files:**
- Modify: `web/src/app.js`(figure 会话函数区追加 `uploadFigureSession`;`bindEvents()` 状态条按钮段补上传/重试接线)

**Interfaces:**
- Consumes: `uploadImageFile(file)`(imagehost.js 既有导出,内部走微信直传)、`replaceInMarkdown`(Task 3)、`figureSession.items`(Task 5 结构)、`isImageHostConfigured / IMAGE_HOST_UNCONFIGURED_HINT`(app.js 既有 import)
- Produces: `uploadFigureSession(onlyFailed: boolean): Promise<void>`;写回后文中替换路径消失,`figureSession.uploaded` 累加,`renderFigureBar()` 反映「已上传 N」

- [ ] **Step 1: 实现上传编排**

figure 会话函数区(`renderFigureDetails` 之后)追加:

```js
  /**
   * 批量上传:按 filePath 去重(同一文件多处引用只传一次),顺序请求,
   * 单张失败不中断;结束后一次性把成功项写回源文本并触发重渲染。
   */
  async function uploadFigureSession(onlyFailed = false) {
    if (!figureSession || figureSession.uploading) return;
    if (!isImageHostConfigured()) {
      showToast(IMAGE_HOST_UNCONFIGURED_HINT, 'error');
      return;
    }
    // 去重分组:filePath -> 参与的 items
    const groups = new Map();
    for (const it of figureSession.items) {
      if (!it.file || it.upload === 'done') continue;
      if (onlyFailed && it.upload !== 'failed') continue;
      if (!groups.has(it.filePath)) groups.set(it.filePath, []);
      groups.get(it.filePath).push(it);
    }
    const targets = [...groups.values()];
    if (!targets.length) {
      showToast(onlyFailed ? '没有失败项可重试' : '没有可上传的本地配图');
      return;
    }

    figureSession.uploading = true;
    figureSession.progress = { cur: 0, total: targets.length };
    renderFigureBar();

    const toReplace = new Map();
    let ok = 0;
    let fail = 0;
    for (const group of targets) {
      const head = group[0];
      head.upload = 'uploading';
      try {
        const url = await uploadImageFile(head.file);
        for (const it of group) {
          it.upload = 'done';
          it.wxUrl = url;
          it.error = '';
        }
        toReplace.set(head.path, url);
        ok++;
      } catch (err) {
        for (const it of group) {
          it.upload = 'failed';
          it.error = String(err.message || err);
        }
        fail++;
      }
      figureSession.progress.cur++;
      renderFigureBar();
    }

    figureSession.uploading = false;
    figureSession.progress = null;
    if (toReplace.size) {
      textarea.value = replaceInMarkdown(textarea.value, toReplace);
      figureSession.uploaded += toReplace.size;
      scheduleRender(); // 写回后这些路径离开 items,计数由 uploaded 保持
    }
    if (fail) showToast(`上传完成:成功 ${ok} · 失败 ${fail},可重试失败项`, 'error');
    else showToast(`全部上传成功(共 ${ok} 张)`);
    renderFigureBar();
  }
```

- [ ] **Step 2: bindEvents 接线 — 上传与重试按钮**

在 Task 5 的状态条按钮接线之后插入:

```js
  document.getElementById('figure-upload-btn')?.addEventListener('click', () => uploadFigureSession(false));
  document.getElementById('figure-retry-btn')?.addEventListener('click', () => uploadFigureSession(true));
```

- [ ] **Step 3: 构建与全量回归**

Run: `cd web && npm run build && cd ../cloudflare/md2wx-worker && npm test`
Expected: 构建成功;99 个用例(80 既有 + 19 新增)全绿

- [ ] **Step 4: 手工冒烟(需配置推送 Key 的环境)**

浏览器手测清单:
1. 未配 Key:上传按钮置灰,hover 显示连接配置提示;载入文件夹仅预览可用
2. 配 Key 后:上传按钮可用;点击后状态条显示「上传中 n/m…」,按钮禁用
3. 全部成功:toast「全部上传成功」;编辑器源文本里相对路径已变 `https://mmbiz.qpic.cn/...`;状态条「已上传 N」;明细行绿 ✓ 且缩略图走微信 URL
4. 断网重试:飞行模式下点击上传 → 失败项标红;恢复网络 → 「重试失败项」出现,点击仅重传失败组
5. 重复引用:同一文件在文中出现两次 → 明细里两行,素材库只多一张图,两处都替换

- [ ] **Step 5: 提交**

```bash
git add web/src/app.js
git commit -m "feat(figure): batch upload orchestration — per-file dedupe, sequential wx upload, write-back and retry"
```

---

### Task 7: 收尾验证与 spec 状态回写

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-figure-folder-upload-design.md`(状态行)

**Interfaces:**
- Consumes: Task 1-6 全部产出
- Produces: 无代码;spec 状态标记为已实现

- [ ] **Step 1: 全量回归门**

Run: `cd cloudflare/md2wx-worker && npm test && cd ../../web && npm run build`
Expected: 99 用例全绿;构建产物生成于 `web/dist/`

- [ ] **Step 2: spec 状态回写**

`docs/superpowers/specs/2026-10-10-figure-folder-upload-design.md` 第 3 行改为:

```markdown
状态:已实现(2026-10-10)
```

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-10-10-figure-folder-upload-design.md
git commit -m "docs(spec): figure folder upload shipped"
```
