# 封面默认文案两层自定义 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全局品牌默认值(localStorage)+ 自定义主题 `coverCopy` 两层默认文案,按 badge/tag/author 逐元素回落,填入封面提取与渲染链;未配置时输出与现状逐一像素一致。

**Architecture:** 新增纯逻辑模块 `core/coverCopy.js`(存储读写、主题 coverCopy 提取、五层解析链合并);`cover.js` 的 `extractCoverMeta` 与 `canvas_exporter.js` 的 `renderCoverDirectCanvas` 各自三处回落改为消费 `resolveCoverCopy`;Cover Studio 加「存为全局默认/清除」按钮;主题工坊加「封面默认文案」小节并把 `coverCopy` 纳入主题存储白名单。

**Tech Stack:** Vite + 原生 JavaScript(前端);esbuild 打包 + Node 内建 test runner(worker test harness)。

**Spec:** `docs/superpowers/specs/2026-10-12-cover-copy-defaults-design.md`

## Global Constraints

- 零外部依赖:不新增任何 npm 包,纯原生 JS(AGENTS.md 设计哲学)
- Worker 侧零改动:不改 `worker.js`、不动既有测试文件(新增 coverCopy 测试除外)
- 兼容红线:清空 `md2wx_cover_defaults` + 使用无 `coverCopy` 的主题时,`extractCoverMeta` 输出与现状完全一致(万舟智算 / WZZS / 万舟智算·教程系列)
- localStorage 键名恒为 `md2wx_cover_defaults`,值形如 `{"badge":"...","tag":"...","author":"..."}`(只存非空字段,三个全空即删键)
- 每元素独立回落,顺序恒为:frontmatter(调用方先行)> 主题 coverCopy > 全局默认 > 内置预设 > 硬编码兜底
- 硬编码兜底字面量保持不变:`万舟智算`、`WZZS`、`万舟智算 · 教程系列`(注意 tag 用 ` · ` 间隔)
- 截断规则不变:author 16 字、tag 24 字(badge 不截断)
- 所有命令在 `E:\code\opensaas\zcodeapi\gzh\MD2WX` 下执行;测试 `cd cloudflare/md2wx-worker && npm test`,构建 `cd web && npm run build`
- Worker 测试的 esbuild bundle 需先 `npm run build:test` 再 `node --test test/coverCopy.test.mjs`(或直接 `npm test`)

---

### Task 1: coverCopy.js — 存储读写与主题提取

**Files:**
- Create: `web/src/core/coverCopy.js`
- Create: `cloudflare/md2wx-worker/test/coverCopy.test.mjs`
- Modify: `cloudflare/md2wx-worker/package.json`(build:test 与 test 两 script 各追加一段)

**Interfaces:**
- Consumes: 无
- Produces: `readCoverDefaults(store) -> {badge,tag,author}|null`、`writeCoverDefaults(store, partial) -> void`、`extractThemeCoverCopy(themeDef) -> {badge,tag,author}|null`、`DEFAULT_FALLBACK = { badge: 'WZZS', tag: '万舟智算 · 教程系列', author: '万舟智算' }`(Task 2/3/4 依赖)

- [ ] **Step 1: 写失败测试**

创建 `cloudflare/md2wx-worker/test/coverCopy.test.mjs`:

```js
/**
 * coverCopy 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCoverDefaults, writeCoverDefaults, extractThemeCoverCopy, DEFAULT_FALLBACK,
} from './.coverCopy.bundle.mjs';

/** 内存版 localStorage 桩(store 参数注入用) */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

describe('writeCoverDefaults / readCoverDefaults', () => {
  it('写入后读回一致,空串字段被剔除', () => {
    const s = memStore();
    writeCoverDefaults(s, { badge: 'MYBRAND', tag: '', author: '  作者  ' });
    assert.deepEqual(readCoverDefaults(s), { badge: 'MYBRAND', author: '作者' });
  });
  it('三个全空即删键,读回 null', () => {
    const s = memStore();
    writeCoverDefaults(s, { badge: 'X', tag: 'T', author: 'A' });
    writeCoverDefaults(s, { badge: '', tag: '', author: '' });
    assert.equal(readCoverDefaults(s), null);
    assert.equal(s.getItem('md2wx_cover_defaults'), null);
  });
  it('store 不可用时静默:read 返回 null,write 不抛错', () => {
    const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    assert.equal(readCoverDefaults(bad), null);
    assert.doesNotThrow(() => writeCoverDefaults(bad, { badge: 'X' }));
  });
  it('非法 JSON 容错返回 null', () => {
    const s = memStore();
    s.setItem('md2wx_cover_defaults', '{not json');
    assert.equal(readCoverDefaults(s), null);
  });
  it('非对象 JSON(数组/字符串)容错返回 null', () => {
    const s = memStore();
    s.setItem('md2wx_cover_defaults', '["x"]');
    assert.equal(readCoverDefaults(s), null);
    s.setItem('md2wx_cover_defaults', '"abc"');
    assert.equal(readCoverDefaults(s), null);
  });
});

describe('extractThemeCoverCopy', () => {
  it('提取合法 coverCopy 字段(只取三键,忽略多余键)', () => {
    const t = { baseId: 'tech-blue', name: 'X', override: {}, coverCopy: { badge: 'B', tag: 'T', author: 'A', junk: 1 } };
    assert.deepEqual(extractThemeCoverCopy(t), { badge: 'B', tag: 'T', author: 'A' });
  });
  it('部分字段缺失时仅返回存在的非空字段', () => {
    const t = { coverCopy: { badge: 'B' } };
    assert.deepEqual(extractThemeCoverCopy(t), { badge: 'B' });
  });
  it('coverCopy 缺失/非对象/全空 -> null', () => {
    assert.equal(extractThemeCoverCopy({}), null);
    assert.equal(extractThemeCoverCopy({ coverCopy: 'x' }), null);
    assert.equal(extractThemeCoverCopy({ coverCopy: { badge: '', tag: '', author: '' } }), null);
    assert.equal(extractThemeCoverCopy(null), null);
    assert.equal(extractThemeCoverCopy({ coverCopy: { badge: 123 } }), null);
  });
});

describe('DEFAULT_FALLBACK', () => {
  it('兜底三元组与现状硬编码一致', () => {
    assert.deepEqual(DEFAULT_FALLBACK, { badge: 'WZZS', tag: '万舟智算 · 教程系列', author: '万舟智算' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd cloudflare/md2wx-worker && npm run build:test && node --test test/coverCopy.test.mjs`
Expected: FAIL,`Cannot find module './.coverCopy.bundle.mjs'`

- [ ] **Step 3: 创建模块与测试打包配置**

创建 `web/src/core/coverCopy.js`:

```js
/**
 * MD2WX 封面默认文案两层自定义:全局品牌默认值(localStorage)+ 自定义主题 coverCopy。
 * 纯逻辑层(零 DOM,store 可注入,Node 可测);解析链每元素独立回落:
 *   frontmatter(调用方先行) > 主题 coverCopy > 全局默认 > 内置预设 > 硬编码兜底
 */

export const COVER_DEFAULTS_KEY = 'md2wx_cover_defaults';

/** 最底层硬编码兜底(与既有渲染字面量逐字一致) */
export const DEFAULT_FALLBACK = Object.freeze({
  badge: 'WZZS',
  tag: '万舟智算 · 教程系列',
  author: '万舟智算',
});

const COPY_KEYS = ['badge', 'tag', 'author'];

function safeStore(store) {
  try {
    store.getItem(COVER_DEFAULTS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 全局默认读取:只返回非空字段;无有效字段/不可用/非法 JSON -> null */
export function readCoverDefaults(store) {
  if (!store || !safeStore(store)) return null;
  let raw;
  try {
    raw = store.getItem(COVER_DEFAULTS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const k of COPY_KEYS) {
    if (typeof obj[k] === 'string' && obj[k].trim()) out[k] = obj[k].trim();
  }
  return Object.keys(out).length ? out : null;
}

/** 全局默认写入:空串字段剔除;三个全空即删键;存储不可用静默 */
export function writeCoverDefaults(store, partial) {
  if (!store || !safeStore(store)) return;
  const merged = { ...(readCoverDefaults(store) || {}), ...(partial || {}) };
  const out = {};
  for (const k of COPY_KEYS) {
    if (typeof merged[k] === 'string' && merged[k].trim()) out[k] = merged[k].trim();
  }
  try {
    if (Object.keys(out).length === 0) store.removeItem(COVER_DEFAULTS_KEY);
    else store.setItem(COVER_DEFAULTS_KEY, JSON.stringify(out));
  } catch {
    // 存储不可用静默(隐私模式)
  }
}

/** 自定义主题 coverCopy 提取:非法/缺字段/全空 -> null;只认三键的非空字符串 */
export function extractThemeCoverCopy(themeDef) {
  const cc = themeDef && typeof themeDef === 'object' ? themeDef.coverCopy : null;
  if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return null;
  const out = {};
  for (const k of COPY_KEYS) {
    if (typeof cc[k] === 'string' && cc[k].trim()) out[k] = cc[k].trim();
  }
  return Object.keys(out).length ? out : null;
}
```

修改 `cloudflare/md2wx-worker/package.json` 的 `scripts`:

```json
  "scripts": {
    "build:test": "esbuild worker.js --bundle --format=esm --outfile=test/.worker.bundle.mjs --loader:.png=dataurl && esbuild ../../web/src/core/publish.js --bundle --format=esm --outfile=test/.publish.bundle.mjs && esbuild ../../web/src/core/customThemes.js --bundle --format=esm --outfile=test/.custom.bundle.mjs && esbuild ../../web/src/core/figuremap.js --bundle --format=esm --outfile=test/.figuremap.bundle.mjs && esbuild ../../web/src/core/coverCopy.js --bundle --format=esm --outfile=test/.coverCopy.bundle.mjs",
    "test": "npm run build:test && node --test test/engine.test.mjs test/publish.test.mjs test/customThemes.test.mjs test/hub-auth.test.mjs test/hub-store.test.mjs test/hub-routes.test.mjs test/hub-preview.test.mjs test/figuremap.test.mjs test/coverCopy.test.mjs",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd cloudflare/md2wx-worker && npm run build:test && node --test test/coverCopy.test.mjs`
Expected: PASS(10 个用例全绿)

- [ ] **Step 5: 提交**

```bash
git add web/src/core/coverCopy.js cloudflare/md2wx-worker/test/coverCopy.test.mjs cloudflare/md2wx-worker/package.json
git commit -m "feat(cover-copy): pure-logic module — defaults store, theme coverCopy extraction"
```

---

### Task 2: coverCopy.js — 解析链 resolveCoverCopy 与 applyCoverCopyToMeta

**Files:**
- Modify: `web/src/core/coverCopy.js`(文件末尾追加)
- Modify: `cloudflare/md2wx-worker/test/coverCopy.test.mjs`(import 行与文件末尾追加)

**Interfaces:**
- Consumes: `readCoverDefaults / extractThemeCoverCopy / DEFAULT_FALLBACK`(Task 1);`THEME_COVER_PRESETS`(cover.js 既有导出,Task 3 会用它,此处经参数传入避免循环依赖)
- Produces: `resolveCoverCopy({ themeDef, store, preset }) -> {badge,tag,author}`(themeDef 为自定义主题对象或 null;preset 为 `THEME_COVER_PRESETS[baseThemeId]` 形态,含 `badgeText/defaultTag`)、`applyCoverCopyToMeta(meta, resolved) -> meta`(Task 3/4/5 依赖)

- [ ] **Step 1: 写失败测试**

import 行改为:

```js
import {
  readCoverDefaults, writeCoverDefaults, extractThemeCoverCopy, DEFAULT_FALLBACK,
  resolveCoverCopy, applyCoverCopyToMeta,
} from './.coverCopy.bundle.mjs';
```

文件末尾追加:

```js
const PRESET = { badgeText: 'ACID BOLD', defaultTag: '态度发声 · 拒绝平庸', volText: '2026 · VOL.01' };

describe('resolveCoverCopy', () => {
  it('五层链:主题 coverCopy > 全局默认 > 内置预设 > 兜底(每元素独立)', () => {
    const s = memStore();
    writeCoverDefaults(s, { tag: '全局标签', author: '全局作者' });
    const themeDef = { coverCopy: { badge: '主题徽章' } };
    const r = resolveCoverCopy({ themeDef, store: s, preset: PRESET });
    assert.deepEqual(r, { badge: '主题徽章', tag: '全局标签', author: '全局作者' });
  });
  it('全局默认压过内置预设(已确认语义)', () => {
    const s = memStore();
    writeCoverDefaults(s, { badge: '全局徽章' });
    const r = resolveCoverCopy({ themeDef: null, store: s, preset: PRESET });
    assert.equal(r.badge, '全局徽章');
    assert.equal(r.tag, PRESET.defaultTag);
    assert.equal(r.author, DEFAULT_FALLBACK.author);
  });
  it('无任何配置:内置预设优先,缺项落兜底', () => {
    const s = memStore();
    const r = resolveCoverCopy({ themeDef: null, store: s, preset: PRESET });
    assert.deepEqual(r, { badge: 'ACID BOLD', tag: '态度发声 · 拒绝平庸', author: '万舟智算' });
  });
  it('preset 缺省(null)时全部落兜底', () => {
    const r = resolveCoverCopy({ themeDef: null, store: memStore(), preset: null });
    assert.deepEqual(r, { badge: 'WZZS', tag: '万舟智算 · 教程系列', author: '万舟智算' });
  });
  it('themeDef 无 coverCopy 时等同 null', () => {
    const r = resolveCoverCopy({ themeDef: { baseId: 'x', override: {} }, store: memStore(), preset: PRESET });
    assert.equal(r.badge, 'ACID BOLD');
  });
  it('store 不可用时跳过全局层不抛错', () => {
    const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    const r = resolveCoverCopy({ themeDef: null, store: bad, preset: PRESET });
    assert.deepEqual(r, { badge: 'ACID BOLD', tag: '态度发声 · 拒绝平庸', author: '万舟智算' });
  });
});

describe('applyCoverCopyToMeta', () => {
  it('仅填空位,不覆盖显式值', () => {
    const meta = { author: '显式作者', badge: '' };
    const out = applyCoverCopyToMeta(meta, { badge: 'B', tag: 'T', author: 'A' });
    assert.deepEqual(out, { author: '显式作者', badge: 'B', tag: 'T' });
  });
  it('meta 为 null/undefined 安全返回空对象填充', () => {
    assert.deepEqual(applyCoverCopyToMeta(null, { badge: 'B', tag: 'T', author: 'A' }), { badge: 'B', tag: 'T', author: 'A' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd cloudflare/md2wx-worker && npm run build:test && node --test test/coverCopy.test.mjs`
Expected: FAIL,`does not provide an export named 'resolveCoverCopy'`

- [ ] **Step 3: 实现最小实现**

在 `web/src/core/coverCopy.js` 末尾追加:

```js
/**
 * 五层解析链合并(每元素独立):
 *   主题 coverCopy > 全局默认 > 内置预设(badgeText/defaultTag)> 硬编码兜底。
 * preset 为 THEME_COVER_PRESETS[baseThemeId](可 null);store 不可用时全局层静默跳过。
 */
export function resolveCoverCopy({ themeDef, store, preset }) {
  const themeCopy = extractThemeCoverCopy(themeDef) || {};
  const globalCopy = readCoverDefaults(store) || {};
  const presetCopy = preset && typeof preset === 'object'
    ? { badge: preset.badgeText, tag: preset.defaultTag }
    : {};
  const out = {};
  for (const k of COPY_KEYS) {
    out[k] = themeCopy[k] || globalCopy[k] || presetCopy[k] || DEFAULT_FALLBACK[k];
  }
  return out;
}

/** 仅当 meta 中该元素为空时填入 resolved 值;返回新对象,不修改入参 */
export function applyCoverCopyToMeta(meta, resolved) {
  const base = meta && typeof meta === 'object' ? meta : {};
  const out = { ...base };
  for (const k of COPY_KEYS) {
    if (!out[k]) out[k] = resolved[k];
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd cloudflare/md2wx-worker && npm run build:test && node --test test/coverCopy.test.mjs`
Expected: PASS(18 个用例全绿)

- [ ] **Step 5: 提交**

```bash
git add web/src/core/coverCopy.js cloudflare/md2wx-worker/test/coverCopy.test.mjs
git commit -m "feat(cover-copy): five-layer per-element resolution chain + meta fill"
```

---

### Task 3: 接入 cover.js 与 canvas_exporter.js(解析链生效)

**Files:**
- Modify: `web/src/core/cover.js:27-31`(THEME_COVER_PRESETS 上方 import)、`cover.js:88-124`(extractCoverMeta 三处回落)
- Modify: `web/src/core/canvas_exporter.js:16`(import)、`canvas_exporter.js:52-56`(回落段)
- Modify: `cloudflare/md2wx-worker/test/coverCopy.test.mjs`(文件末尾追加回归用例)

**Interfaces:**
- Consumes: `resolveCoverCopy / applyCoverCopyToMeta`(Task 2);既有 `THEME_COVER_PRESETS`、`getCustomTheme`(customThemes.js)
- Produces: `extractCoverMeta(markdownText, themeId, { store })` 第三参可选 options(缺省 `{}`,兼容全部既有调用);`resolveForThemeId(themeId, store)` — cover.js 导出的便捷函数,内部判定 `custom-` 前缀取自定义主题并把 `THEME_COVER_PRESETS[baseId]` 作为 preset(Task 4/5 复用此函数)

- [ ] **Step 1: 写失败回归测试**

在 `test/coverCopy.test.mjs` 末尾追加(bundle 需 engine 同源,改从 worker bundle import extractCoverMeta):

```js
import { extractCoverMeta } from './.worker.bundle.mjs';

describe('extractCoverMeta 兼容红线(Task 3 后生效)', () => {
  it('无任何配置时输出与现状硬编码一致', () => {
    const m = extractCoverMeta('# T\n\n正文', 'tech-blue', { store: memStore() });
    assert.equal(m.author, '万舟智算');
    assert.equal(m.badge, 'WZZS');
    assert.equal(m.tag, '万舟智算 · 教程系列');
  });
  it('自定义主题 coverCopy 生效且逐元素独立', () => {
    const m = extractCoverMeta('---\nauthor: 文章作者\n---\n# T', 'custom-abc', {
      store: memStore(),
      getCustomTheme: (id) => (id === 'custom-abc'
        ? { baseId: 'acid-bold', name: 'X', override: {}, coverCopy: { badge: 'TB', tag: 'TT' } }
        : null),
    });
    assert.equal(m.author, '文章作者');
    assert.equal(m.badge, 'TB');
    assert.equal(m.tag, 'TT');
  });
  it('全局默认压过内置预设', () => {
    const s = memStore();
    writeCoverDefaults(s, { badge: 'GB' });
    const m = extractCoverMeta('# T', 'tech-blue', { store: s });
    assert.equal(m.badge, 'GB');
  });
});
```

同时给 `resolveForThemeId` 的便捷断言(同文件追加):

```js
import { resolveForThemeId } from './.coverCopy.bundle.mjs';

describe('resolveForThemeId', () => {
  it('内置主题走预设层', () => {
    const r = resolveForThemeId('tech-blue', memStore());
    assert.deepEqual(r, { badge: 'WZZS', tag: '万舟智算 · 教程系列', author: '万舟智算' });
  });
  it('custom- 主题经 getCustomTheme 注入 themeDef', () => {
    const r = resolveForThemeId('custom-abc', memStore(), (id) => (
      id === 'custom-abc' ? { baseId: 'acid-bold', coverCopy: { badge: 'TB' } } : null
    ));
    assert.equal(r.badge, 'TB');
    assert.equal(r.tag, '态度发声 · 拒绝平庸');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd cloudflare/md2wx-worker && npm run build:test && node --test test/coverCopy.test.mjs`
Expected: FAIL(`resolveForThemeId` 无导出;extractCoverMeta 新 options 未生效的断言失败)

- [ ] **Step 3: 实现接入**

`web/src/core/cover.js` 顶部 import 区追加:

```js
import { resolveCoverCopy } from './coverCopy.js';
```

`cover.js` 在 `THEME_COVER_PRESETS` 定义之后新增导出函数:

```js
/**
 * 按主题 ID 解析默认文案(五层链):custom- 前缀主题经 getCustomThemeResolver
 * 取主题定义(其 coverCopy 层生效),否则仅内置预设层。store 可注入,Node 可测。
 */
export function resolveForThemeId(themeId, store = null, getCustomThemeResolver = null) {
  let themeDef = null;
  let preset = THEME_COVER_PRESETS[themeId] || null;
  if (themeId && String(themeId).startsWith('custom-')) {
    themeDef = getCustomThemeResolver ? getCustomThemeResolver(themeId) : null;
    const baseId = themeDef && themeDef.baseId;
    preset = THEME_COVER_PRESETS[baseId] || null;
  }
  return resolveCoverCopy({ themeDef, store, preset });
}
```

`extractCoverMeta` 签名与三处回落改为:

```js
export function extractCoverMeta(markdownText, themeId = 'tech-blue', { store = null, getCustomTheme: getCustomThemeResolver = null } = {}) {
```

(原签名只有前两参,第三参新增带默认值,全部既有调用兼容)

```js
  // 3. 提取作者与标签(五层解析链:frontmatter > 主题coverCopy > 全局默认 > 内置预设 > 兜底)
  const resolved = resolveForThemeId(themeId, store, getCustomThemeResolver);
  const author = meta.author || resolved.author;
  const tag = Array.isArray(meta.tags) && meta.tags.length > 0 ? meta.tags.join(' · ') : resolved.tag;
```

`return` 对象中 `badge: preset.badgeText` 改为 `badge: resolved.badge`(`preset` 变量此行之后不再被 badge/tag 使用,`preset` 声明保留供 `volText`/`website` 使用——检查后若 `preset` 仅剩 volText 用途则保留原声明不动)。

`web/src/core/canvas_exporter.js` 顶部 import 区追加:

```js
import { resolveCoverCopy } from './coverCopy.js';
```

`renderCoverDirectCanvas` 内回落段(52-56 行)改为:

```js
  const resolved = resolveCoverCopy({ themeDef: null, store: null, preset: null });
  const title = meta.title || '在喧嚣时代重塑深度思考';
  const digest = meta.digest || '真正的专注，是在充满干扰的世界中守住内心的秩序';
  const author = meta.author || resolved.author;
  const tag = meta.tag || resolved.tag;
  const badge = meta.badge || resolved.badge;
  const vol = meta.vol || '2026 · VOL.02';
  const site = meta.website || 'MD2WX.ZANEVEN.COM';
```

(canvas 渲染只处理 meta 已由 extractCoverMeta 填好的情形,兜底层走 DEFAULT_FALLBACK 即可;`themeDef/store/preset` 均传 null 不引入新依赖——canvas 层的默认来源统一由 extractCoverMeta 负责)

- [ ] **Step 4: 运行测试确认通过 + 全量回归**

Run: `cd cloudflare/md2wx-worker && npm test`
Expected: PASS(既有 99 + 新增 coverCopy 全部用例;engine 套中 cover 相关用例全绿)

Run: `cd web && npm run build`
Expected: 构建成功(cover.js 循环依赖检查:coverCopy.js 不 import cover.js,resolveCoverCopy 的 preset 由参数传入,无环)

- [ ] **Step 5: 提交**

```bash
git add web/src/core/cover.js web/src/core/canvas_exporter.js cloudflare/md2wx-worker/test/coverCopy.test.mjs
git commit -m "feat(cover-copy): wire resolution chain into extractCoverMeta and canvas exporter"
```

---

### Task 4: app.js — 自定义主题 themeDef 注入 + Cover Studio「存为全局默认」

**Files:**
- Modify: `web/src/app.js`(extractCoverMeta 调用点注入 store/getCustomTheme;Cover Studio 文案区块加两按钮与接线)

**Interfaces:**
- Consumes: `extractCoverMeta(m, themeId, { store, getCustomTheme })`(Task 3)、`writeCoverDefaults / readCoverDefaults`(Task 1)、既有 `currentThemeId / textarea / showToast / localStorage`
- Produces: 模块级 `resolveActiveThemeDef()`(返回 `currentThemeId` 以 `custom-` 开头时的主题定义对象,否则 null)——Task 5 主题工坊复用

- [ ] **Step 1: 模块级辅助 + 调用点注入**

`app.js` 顶部 `from './core/coverCopy.js'` 新增 import:

```js
import { writeCoverDefaults, readCoverDefaults } from './core/coverCopy.js';
```

模块级(`currentCoverMeta` 声明附近)新增:

```js
/** 当前主题为自定义主题时返回其定义对象,否则 null(Task 5 主题工坊复用) */
function resolveActiveThemeDef() {
  if (currentThemeId && currentThemeId.startsWith('custom-')) {
    return getCustomTheme(currentThemeId);
  }
  return null;
}

/** extractCoverMeta 的统一 options 注入:localStorage store + 自定义主题解析器 */
function coverMetaOptions() {
  return {
    store: typeof localStorage !== 'undefined' ? localStorage : null,
    getCustomTheme: (id) => getCustomTheme(id),
  };
}
```

app.js 中 `extractCoverMeta(` 的全部调用点(约 3 处:renderPreview 联动、封面工坊 refreshMetaFromArticle、发布工坊封面缩略)统一追加第三参 `coverMetaOptions()`。

- [ ] **Step 2: Cover Studio 两按钮接线**

`index.html` 文案元素自定义区块(6 个 form-group 之后、微信转发卡片容器之前)插入:

```html
            <div class="form-group cover-defaults-actions">
              <button type="button" class="btn btn-secondary" id="btn-save-cover-defaults" title="把当前徽章/标签/作者存为全局品牌默认值,所有主题的封面预填使用">💾 存为全局默认</button>
              <button type="button" class="btn btn-secondary" id="btn-clear-cover-defaults" title="清除全局品牌默认值,回到内置主题预设">清除全局默认</button>
            </div>
```

`preview.css` 末尾追加:

```css
.cover-defaults-actions { display: flex; gap: 8px; }
.cover-defaults-actions .btn { flex: 1; font-size: 12px; padding: 6px 8px; }
```

`app.js` 的 `initCoverStudio()`(约 1385 行初始化区)追加接线:

```js
  const btnSaveDefaults = document.getElementById('btn-save-cover-defaults');
  const btnClearDefaults = document.getElementById('btn-clear-cover-defaults');
  btnSaveDefaults?.addEventListener('click', () => {
    const store = typeof localStorage !== 'undefined' ? localStorage : null;
    if (!store) { showToast('当前环境存储不可用,无法保存全局默认', 'error'); return; }
    writeCoverDefaults(store, {
      badge: inputBadge.value,
      tag: inputTag.value,
      author: inputAuthor.value,
    });
    showToast(readCoverDefaults(store)
      ? '已存为全局默认,所有主题的封面将预填此文案'
      : '全局默认已清空(三个输入框均为空)');
  });
  btnClearDefaults?.addEventListener('click', () => {
    const store = typeof localStorage !== 'undefined' ? localStorage : null;
    if (!store) { showToast('当前环境存储不可用', 'error'); return; }
    writeCoverDefaults(store, {});
    showToast('已清除全局默认,回到内置主题预设');
  });
```

- [ ] **Step 3: 构建与全量回归**

Run: `cd web && npm run build && cd ../cloudflare/md2wx-worker && npm test`
Expected: 构建成功;测试全绿(coverCopy + 既有 99)

浏览器手测:打开封面工坊 → 文案区块出现两按钮;填入徽章/标签/作者 → 存为全局默认 → 清空输入框并「同步正文」→ 三个值从全局默认预填回来;清除全局默认 → 回到内置预设值。

- [ ] **Step 4: 提交**

```bash
git add web/src/app.js web/index.html web/src/styles/preview.css
git commit -m "feat(cover-copy): save/clear global defaults in Cover Studio; custom-theme injection at call sites"
```

---

### Task 5: 主题工坊「封面默认文案」小节 + coverCopy 入库

**Files:**
- Modify: `web/src/core/customThemes.js`(validOverride 白名单之外:`saveCustomTheme` 增加 coverCopy 形参校验)
- Modify: `web/index.html`(主题工坊编辑器 DOM,动态构建处)+ `web/src/app.js`(initThemeStudio 接线)
- Modify: `web/src/app.js`(effectiveThemeInfo 不变,确认 selectTheme 后预览联动走 Task 4 的 options 注入即可)

**Interfaces:**
- Consumes: Task 4 的 `resolveActiveThemeDef()`(工坊打开时预填当前编辑主题的 coverCopy)、`saveCustomTheme` 既有签名
- Produces: `saveCustomTheme(idOrNull, { baseId, name, override, coverCopy }, store)`(coverCopy 可选,缺省不写入;传入时仅保留 badge/tag/author 三键的非空字符串);主题定义新增可选顶层字段 `coverCopy`,导入导出自动携带(exportCustomTheme/importCustomTheme 基于整个主题对象,无需改动——实现者需验证 import 路径对 coverCopy 的容错)

- [ ] **Step 1: customThemes.js 存储层支持 coverCopy**

`saveCustomTheme` 改为(新增第四个解构字段与写入):

```js
function validCoverCopy(coverCopy) {
  if (coverCopy == null) return true;
  if (!coverCopy || typeof coverCopy !== 'object' || Array.isArray(coverCopy)) return false;
  return Object.entries(coverCopy).every(([k, v]) => ['badge', 'tag', 'author'].includes(k) && (v == null || typeof v === 'string'));
}

export function saveCustomTheme(idOrNull, { baseId, name, override, coverCopy }, store = defaultStore()) {
  if (!BUILTIN_THEMES[baseId]) return { ok: false, error: `baseId 不存在: ${baseId}` };
  if (!name || !String(name).trim()) return { ok: false, error: 'name 必填' };
  if (!validOverride(override)) return { ok: false, error: 'override 仅允许 colors/typography 对象' };
  if (!validCoverCopy(coverCopy)) return { ok: false, error: 'coverCopy 仅允许 badge/tag/author 字符串字段' };
  const all = readAll(store);
  const id = idOrNull || genId();
  if (idOrNull && !all[idOrNull]) return { ok: false, error: `主题不存在: ${idOrNull}` };
  const cleanCopy = validCoverCopy(coverCopy) && coverCopy
    ? Object.fromEntries(Object.entries(coverCopy).filter(([, v]) => typeof v === 'string' && v.trim()))
    : undefined;
  all[id] = { baseId, name: String(name).trim(), override, ...(cleanCopy && Object.keys(cleanCopy).length ? { coverCopy: cleanCopy } : {}) };
  try {
    writeAll(all, store);
  } catch (e) {
    return { ok: false, error: '存储不可用' };
  }
  return { ok: true, id };
}
```

`importCustomTheme` 校验段追加(定位其现有 parsed 字段校验处,同样容错——非法 coverCopy 时**拒绝导入**并返回既有 error 形态):

```js
  if (parsed.coverCopy !== undefined && !validCoverCopy(parsed.coverCopy)) {
    return { ok: false, error: 'coverCopy 仅允许 badge/tag/author 字符串字段' };
  }
```

并在其写入对象处同样套用 cleanCopy 过滤逻辑(与 saveCustomTheme 相同的三键非空过滤;version 字段等原逻辑不动)。

- [ ] **Step 2: 主题工坊 UI**

`app.js` 的 `initThemeStudio` 中 tab 动态构建区(tabsBar.innerHTML 的 tab 数组)追加第四个 tab:

```js
  tabsBar.innerHTML = ['颜色', '排版', '组件样式', '封面文案'].map((t, i) =>
    `<button type="button" class="ts-tab ${i === 0 ? 'active' : ''}" data-tab="${i}">${t}</button>`
  ).join('');
  const tabPages = [document.createElement('div'), document.createElement('div'), document.createElement('div'), document.createElement('div')];
  tabPages.forEach((p, i) => { p.className = 'ts-tab-page' + (i === 0 ? ' active' : ''); p.hidden = i !== 0; });
```

(实现者注意:保持原有 className 拼接风格一致,上面第二行若与原代码风格冲突,以原风格为准——核心是 4 个 tab 页且封面文案为第 4 页)

第 4 页内容动态构建:

```js
  const coverCopyField = document.createElement('div');
  coverCopyField.className = 'ts-field';
  coverCopyField.innerHTML =
    '<label class="ts-label">封面默认文案(选此主题时封面预填,仅自定义主题生效)</label>' +
    '<input type="text" class="ts-input" id="ts-cover-badge" placeholder="徽章,如 MYBRAND(留空走全局默认)">' +
    '<input type="text" class="ts-input" id="ts-cover-tag" placeholder="默认标签,如 深度架构 · 极客手记">' +
    '<input type="text" class="ts-input" id="ts-cover-author" placeholder="作者 / 品牌落款">';
  tabPages[3].appendChild(coverCopyField);
  const tsCoverBadge = coverCopyField.querySelector('#ts-cover-badge');
  const tsCoverTag = coverCopyField.querySelector('#ts-cover-tag');
  const tsCoverAuthor = coverCopyField.querySelector('#ts-cover-author');
```

编辑态装载(现有 `editing = { id, baseId, name, override }` 赋值处)扩展为:

```js
  editing = { id, baseId, name, override, coverCopy: full.coverCopy || {} };
```

(新建主题时 `editing = { id: null, baseId: ..., name: ..., override: {}, coverCopy: {} }`;内置主题点击时编辑态不出现第 4 tab 内容——由下方条件控制)

打开工坊/切换编辑对象时回填:

```js
  tsCoverBadge.value = (editing && editing.coverCopy && editing.coverCopy.badge) || '';
  tsCoverTag.value = (editing && editing.coverCopy && editing.coverCopy.tag) || '';
  tsCoverAuthor.value = (editing && editing.coverCopy && editing.coverCopy.author) || '';
```

保存与导出两处 `saveCustomTheme` 调用追加 coverCopy:

```js
    const coverCopy = {};
    if (tsCoverBadge.value.trim()) coverCopy.badge = tsCoverBadge.value.trim();
    if (tsCoverTag.value.trim()) coverCopy.tag = tsCoverTag.value.trim();
    if (tsCoverAuthor.value.trim()) coverCopy.author = tsCoverAuthor.value.trim();
    const r = saveCustomTheme(editing.id, { baseId: editing.baseId, name: editing.name, override: editing.override, coverCopy });
```

(导出路径的同型调用同样追加;**内置主题**编辑分支:第 4 tab 显示提示文案「内置主题的封面文案预设由代码维护,不可编辑」且三输入框 disabled——实现者按现有内置/自定义分支判断方式实现)

- [ ] **Step 3: 构建与全量回归**

Run: `cd web && npm run build && cd ../cloudflare/md2wx-worker && npm test`
Expected: 构建成功;测试全绿(含 customThemes 既有用例——saveCustomTheme 新形参向后兼容,旧调用不传 coverCopy 行为不变)

浏览器手测:主题工坊 → 自定义主题 → 第 4 tab 填入徽章/标签/作者 → 保存 → 导出 JSON 确认含 coverCopy → 重新导入成功;主界面切到该主题 → 封面工坊打开时三值预填主题 coverCopy;清空主题 coverCopy 保存 → 封面回落全局默认。

- [ ] **Step 4: 提交**

```bash
git add web/src/core/customThemes.js web/index.html web/src/app.js
git commit -m "feat(cover-copy): theme-studio coverCopy tab + storage whitelist and import validation"
```

---

### Task 6: 收尾验证与 spec 状态回写

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-cover-copy-defaults-design.md`(状态行)

**Interfaces:**
- Consumes: Task 1-5 全部产出
- Produces: 无代码;spec 状态标记为已实现

- [ ] **Step 1: 全量回归门**

Run: `cd cloudflare/md2wx-worker && npm test && cd ../../web && npm run build`
Expected: 全部用例绿(既有 99 + coverCopy 新增);构建成功

- [ ] **Step 2: spec 状态回写**

`docs/superpowers/specs/2026-10-12-cover-copy-defaults-design.md` 第 3 行 `状态:已经用户确认` 改为:

```markdown
状态:已实现(2026-10-12)
```

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-10-12-cover-copy-defaults-design.md
git commit -m "docs(spec): cover copy defaults shipped"
```
