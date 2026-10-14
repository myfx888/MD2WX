# 封面工作台「保存配置」与发布同源生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 封面工作台一键保存全套配置(主题/比例/6 文案)到 localStorage;发布推送、发布缩略图、正文顶部封面三处消费点严格按保存配置渲染;无保存配置时行为与现状逐一一致。

**Architecture:** 新增纯逻辑模块 `coverWorkbench.js`(快照读写 + 导出比例换算,Node 可测);封面工作台 header 增加常驻保存按钮与未保存圆点;`app.js` 模块层新增 `getSavedCoverConfig()` 统一取数,替换三处消费点的写死参数;`parser.js` 的正文顶部封面支持 `coverThemeId` 覆盖。

**Tech Stack:** Vanilla ES modules(Vite 构建)、localStorage、esbuild 打包 + Node 内建 test runner(worker 侧测试)、Python unittest(既有回归)。

**Spec:** `docs/superpowers/specs/2026-10-13-cover-workbench-save-design.md`

## Global Constraints

- 兼容红线:从未保存过(无 `md2wx_cover_workbench` 键)时,推送导出参数、发布缩略图 HTML、正文顶部封面 HTML、工作台打开行为与改造前逐一一致。
- 比例枚举:`'banner' | 'square' | 'dual'`;消费链路(推送/缩略图)经 `coverExportRatio` 把 `dual` 回落 `'banner'`;工作台内复制/下载导出不经过该函数。
- 安全线开关(`toggle-safe-area`)是预览辅助,不入快照。
- 端范围:仅 `web/` 前端;`md2wx/` Python CLI 与 `cloudflare/md2wx-worker/worker.js` 除测试登记(package.json)外零改动。
- 快照写入失败(存储不可用/quota)必须 toast,不允许静默假成功;读取失败一律 null 回落,绝不抛错中断渲染/推送。
- 所有新代码遵循仓库现有风格:中文注释、无 Emoji 图标逻辑(按钮文案「💾 保存配置」与既有「💾 存为全局默认」一致)。

---

### Task 1: `coverWorkbench.js` 核心模块(Node 测试先行)

**Files:**
- Create: `web/src/core/coverWorkbench.js`
- Create: `cloudflare/md2wx-worker/test/coverWorkbench.test.mjs`
- Modify: `cloudflare/md2wx-worker/package.json:7-8`(build:test 与 test 脚本各追加一段)

**Interfaces:**
- Consumes: 无(独立纯逻辑模块)。
- Produces(Task 2/3 依赖,签名逐字):
  - `COVER_WORKBENCH_KEY = 'md2wx_cover_workbench'`
  - `readCoverWorkbench(store) -> { themeId: string, ratio: 'banner'|'square'|'dual', title: string, digest: string, tag: string, badge: string, vol: string, author: string, savedAt: number } | null`
  - `writeCoverWorkbench(store, snapshot) -> void`(themeId 为空或 store 为 null 时 **throw Error**;存储异常向上抛)
  - `coverExportRatio(ratio) -> 'banner' | 'square'`(dual → banner,其余原样)

- [ ] **Step 1: 写失败测试**

创建 `cloudflare/md2wx-worker/test/coverWorkbench.test.mjs`:

```js
/**
 * coverWorkbench 纯逻辑测试:esbuild 打包后用 Node 内建 test runner 直接断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_WORKBENCH_KEY, readCoverWorkbench, writeCoverWorkbench, coverExportRatio,
} from './.coverWorkbench.bundle.mjs';

/** 内存版 localStorage 桩(store 参数注入用) */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const SNAP = {
  themeId: 'acid-bold', ratio: 'square',
  title: ' 标题 ', digest: '副标题', tag: '标签', badge: '徽章', vol: 'VOL.01', author: '作者',
};

describe('writeCoverWorkbench / readCoverWorkbench', () => {
  it('写入后读回一致,savedAt 为数字', () => {
    const s = memStore();
    writeCoverWorkbench(s, SNAP);
    const r = readCoverWorkbench(s);
    assert.equal(r.themeId, 'acid-bold');
    assert.equal(r.ratio, 'square');
    assert.equal(r.title, '标题'); // 6 文案字段 trim
    assert.equal(r.digest, '副标题');
    assert.equal(typeof r.savedAt, 'number');
    assert.equal(s.getItem(COVER_WORKBENCH_KEY) !== null, true);
  });
  it('白名单外字段丢弃,非字符串文案字段补空串', () => {
    const s = memStore();
    writeCoverWorkbench(s, { ...SNAP, junk: 1, digest: 123 });
    const r = readCoverWorkbench(s);
    assert.equal('junk' in r, false);
    assert.equal(r.digest, '');
  });
  it('ratio 非法时写入回落 banner,读回即 banner', () => {
    const s = memStore();
    writeCoverWorkbench(s, { ...SNAP, ratio: 'weird' });
    assert.equal(readCoverWorkbench(s).ratio, 'banner');
  });
  it('themeId 为空串/缺失时写入抛错', () => {
    const s = memStore();
    assert.throws(() => writeCoverWorkbench(s, { ...SNAP, themeId: '  ' }));
    assert.throws(() => writeCoverWorkbench(s, { ratio: 'banner' }));
    assert.equal(readCoverWorkbench(s), null); // 抛错前未落库
  });
  it('store 为 null 时写入抛错;存储异常向上抛', () => {
    assert.throws(() => writeCoverWorkbench(null, SNAP));
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    assert.throws(() => writeCoverWorkbench(bad, SNAP), /quota/);
    assert.equal(readCoverWorkbench(bad), null);
  });
  it('非法 JSON / 数组 / 字符串 / 缺 themeId / ratio 非法 -> 读回 null', () => {
    const s = memStore();
    s.setItem(COVER_WORKBENCH_KEY, '{not json');
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, '["x"]');
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, '"abc"');
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, JSON.stringify({ ratio: 'banner' }));
    assert.equal(readCoverWorkbench(s), null);
    s.setItem(COVER_WORKBENCH_KEY, JSON.stringify({ themeId: 'tech-blue', ratio: 'wide' }));
    assert.equal(readCoverWorkbench(s), null);
  });
  it('无键 / store 不可用 / store null -> 读回 null', () => {
    assert.equal(readCoverWorkbench(memStore()), null);
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => {}, removeItem: () => {} };
    assert.equal(readCoverWorkbench(bad), null);
    assert.equal(readCoverWorkbench(null), null);
  });
});

describe('coverExportRatio', () => {
  it('dual 回落 banner;banner/square 原样', () => {
    assert.equal(coverExportRatio('dual'), 'banner');
    assert.equal(coverExportRatio('banner'), 'banner');
    assert.equal(coverExportRatio('square'), 'square');
  });
});
```

- [ ] **Step 2: 登记 package.json 并运行,确认失败**

修改 `cloudflare/md2wx-worker/package.json`:

`build:test` 脚本末尾追加(在最后一个 esbuild 命令之后):

```
 && esbuild ../../web/src/core/coverWorkbench.js --bundle --format=esm --outfile=test/.coverWorkbench.bundle.mjs
```

`test` 脚本的 node --test 文件列表末尾追加:

```
 test/coverWorkbench.test.mjs
```

运行:

```bash
cd cloudflare/md2wx-worker && npm run build:test && node --test test/coverWorkbench.test.mjs
```

Expected: FAIL — esbuild 报 `web/src/core/coverWorkbench.js` 不存在(模块尚未创建)。

- [ ] **Step 3: 最小实现**

创建 `web/src/core/coverWorkbench.js`:

```js
/**
 * MD2WX 封面工作台保存快照:主题/比例/6 文案字段一次性持久化,
 * 发布链路(推送导出/发布缩略图/正文顶部封面)按快照同源生成。
 * 纯逻辑层(零 DOM,store 可注入,Node 可测)。
 * 设计: docs/superpowers/specs/2026-10-13-cover-workbench-save-design.md
 */

export const COVER_WORKBENCH_KEY = 'md2wx_cover_workbench';

const SNAPSHOT_KEYS = ['title', 'digest', 'tag', 'badge', 'vol', 'author'];
const RATIOS = ['banner', 'square', 'dual'];

function safeStore(store) {
  try {
    store.getItem(COVER_WORKBENCH_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 读快照;store 不可用/非法 JSON/结构非法 -> null(调用方回落现状,绝不抛错) */
export function readCoverWorkbench(store) {
  if (!store || !safeStore(store)) return null;
  let raw;
  try {
    raw = store.getItem(COVER_WORKBENCH_KEY);
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
  if (typeof obj.themeId !== 'string' || !obj.themeId.trim()) return null;
  if (!RATIOS.includes(obj.ratio)) return null;
  const out = { themeId: obj.themeId.trim(), ratio: obj.ratio };
  for (const k of SNAPSHOT_KEYS) out[k] = typeof obj[k] === 'string' ? obj[k] : '';
  out.savedAt = typeof obj.savedAt === 'number' ? obj.savedAt : 0;
  return out;
}

/**
 * 写快照:白名单 8 字段(6 文案 trim)+ savedAt=Date.now()。
 * themeId 为空或 store 缺失 -> throw(调用方 toast);存储异常(如 quota)原样向上抛,不允许静默假成功。
 */
export function writeCoverWorkbench(store, snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const themeId = typeof snap.themeId === 'string' ? snap.themeId.trim() : '';
  if (!themeId) throw new Error('themeId 为空，拒绝保存');
  if (!store) throw new Error('存储不可用');
  const out = {
    themeId,
    ratio: RATIOS.includes(snap.ratio) ? snap.ratio : 'banner',
  };
  for (const k of SNAPSHOT_KEYS) out[k] = typeof snap[k] === 'string' ? snap[k].trim() : '';
  out.savedAt = Date.now();
  store.setItem(COVER_WORKBENCH_KEY, JSON.stringify(out));
}

/** 消费链路导出比例:双拼(3350x1000 手动裁剪素材)推送回落 banner;工作台内导出不经过此函数 */
export function coverExportRatio(ratio) {
  return ratio === 'dual' ? 'banner' : ratio;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd cloudflare/md2wx-worker && npm run build:test && node --test test/coverWorkbench.test.mjs
```

Expected: 全部 PASS(约 11 个用例)。

- [ ] **Step 5: Commit**

```bash
cd E:/code/opensaas/zcodeapi/gzh/MD2WX
git add web/src/core/coverWorkbench.js cloudflare/md2wx-worker/test/coverWorkbench.test.mjs cloudflare/md2wx-worker/package.json
git commit -m "feat(web): coverWorkbench snapshot module — persist full workbench config"
```

---

### Task 2: 工作台 UI——保存按钮、打开恢复与脏状态圆点

**Files:**
- Modify: `web/index.html:300-302`(cover-modal-header 关闭按钮前插入保存按钮)
- Modify: `web/src/styles/cover.css`(文件末尾追加样式块)
- Modify: `web/src/app.js:29`(追加 import)、`web/src/app.js:1394` 起的 `initCoverStudio`(元素引用、快照助手、openCoverModal、各监听器)

**Interfaces:**
- Consumes: Task 1 的 `readCoverWorkbench` / `writeCoverWorkbench`(签名见 Task 1 Produces)。
- Produces: localStorage 键 `md2wx_cover_workbench` 的快照语义(themeId/ratio/6 文案);Task 3 的消费链路读取同一份快照。UI 行为:打开弹窗有快照即恢复;「💾 保存配置」写快照并 toast;表单偏离基线时圆点出现。

- [ ] **Step 1: index.html 插入保存按钮**

在 `web/index.html` 中找到(约 300-302 行):

```html
          <button class="cover-modal-close-btn" id="btn-close-cover-modal" type="button" title="关闭 (Esc)">
            <span id="icon-cover-close"></span>
          </button>
```

替换为:

```html
          <div class="cover-header-actions">
            <button class="cover-save-btn" id="btn-save-workbench" type="button" title="保存当前封面配置（主题/比例/文案），发布推送与正文顶部封面将按此生成">
              <span>💾 保存配置</span>
              <span class="cover-save-dot" id="cover-save-dot" hidden></span>
            </button>
            <button class="cover-modal-close-btn" id="btn-close-cover-modal" type="button" title="关闭 (Esc)">
              <span id="icon-cover-close"></span>
            </button>
          </div>
```

- [ ] **Step 2: cover.css 追加样式**

在 `web/src/styles/cover.css` 文件末尾追加:

```css
/* ---------- 封面工作台保存按钮 (Header 常驻) ---------- */
.cover-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cover-save-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 16px;
  border: 1px solid rgba(52, 211, 153, 0.45);
  border-radius: 9px;
  background: linear-gradient(135deg, #059669, #10b981);
  color: #ffffff;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: filter 0.18s ease, transform 0.12s ease;
}

.cover-save-btn:hover {
  filter: brightness(1.12);
}

.cover-save-btn:active {
  transform: scale(0.97);
}

.cover-save-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fbbf24;
  box-shadow: 0 0 6px rgba(251, 191, 36, 0.9);
}
```

- [ ] **Step 3: app.js 追加 import**

在 `web/src/app.js:29`(现有 `import { writeCoverDefaults, readCoverDefaults } from './core/coverCopy.js';`)之后追加:

```js
import { readCoverWorkbench, writeCoverWorkbench } from './core/coverWorkbench.js';
```

- [ ] **Step 4: initCoverStudio 增加元素引用与快照助手**

在 `initCoverStudio` 内,找到:

```js
  const viewport = document.getElementById('cover-canvas-viewport');
```

在其之前插入:

```js
  const btnSaveWorkbench = document.getElementById('btn-save-workbench');
  const saveDot = document.getElementById('cover-save-dot');
```

找到(`initCoverStudio` 内,`let coverMeta = {};` 所在段落之后):

```js
  const shareTitleEl = document.getElementById('preview-share-title');
```

在其之前插入:

```js
  // 保存快照(设计: docs/superpowers/specs/2026-10-13-cover-workbench-save-design.md)
  // lastSavedJson 是「已保存」基线:表单现场状态与之偏离时,保存按钮亮未保存圆点
  let lastSavedJson = null;

  const storeOrNull = () => (typeof localStorage !== 'undefined' ? localStorage : null);

  // 表单现场状态 -> 快照对象(字段与 coverWorkbench.writeCoverWorkbench 一一对应)
  const formSnapshot = () => ({
    themeId: coverThemeId,
    ratio: coverRatio,
    title: inputTitle.value,
    digest: inputDigest.value,
    tag: inputTag.value,
    badge: inputBadge.value,
    vol: inputVol.value,
    author: inputAuthor.value,
  });

  function refreshSaveDot() {
    if (saveDot) saveDot.hidden = JSON.stringify(formSnapshot()) === lastSavedJson;
  }

  // 比例 tab 状态统一入口:点击切换与打开恢复共用
  function applyRatioTab(ratio) {
    coverRatio = ratio;
    if (tabBanner) tabBanner.classList.toggle('active', ratio === 'banner');
    if (tabSquare) tabSquare.classList.toggle('active', ratio === 'square');
    if (tabDual) tabDual.classList.toggle('active', ratio === 'dual');
  }
```

- [ ] **Step 5: 三个比例 tab 处理器改用 applyRatioTab**

将现有三个处理器:

```js
  tabBanner.addEventListener('click', () => {
    tabBanner.classList.add('active');
    tabSquare.classList.remove('active');
    if (tabDual) tabDual.classList.remove('active');
    coverRatio = 'banner';
    renderCover();
  });

  tabSquare.addEventListener('click', () => {
    tabSquare.classList.add('active');
    tabBanner.classList.remove('active');
    if (tabDual) tabDual.classList.remove('active');
    coverRatio = 'square';
    renderCover();
  });

  if (tabDual) {
    tabDual.addEventListener('click', () => {
      tabDual.classList.add('active');
      tabBanner.classList.remove('active');
      tabSquare.classList.remove('active');
      coverRatio = 'dual';
      renderCover();
    });
  }
```

替换为:

```js
  tabBanner.addEventListener('click', () => {
    applyRatioTab('banner');
    renderCover();
    refreshSaveDot();
  });

  tabSquare.addEventListener('click', () => {
    applyRatioTab('square');
    renderCover();
    refreshSaveDot();
  });

  if (tabDual) {
    tabDual.addEventListener('click', () => {
      applyRatioTab('dual');
      renderCover();
      refreshSaveDot();
    });
  }
```

- [ ] **Step 6: openCoverModal 恢复快照**

将 `openCoverModal` 开头:

```js
  function openCoverModal() {
    coverThemeId = currentThemeId;
    if (selectThemeEl) {
```

替换为:

```js
  function openCoverModal() {
    const snap = readCoverWorkbench(storeOrNull());
    if (snap) {
      // 有保存配置:完整恢复主题/比例/文案——保存的配置是发布事实源
      coverThemeId = snap.themeId;
      applyRatioTab(snap.ratio);
      coverMeta = { title: snap.title, digest: snap.digest, tag: snap.tag, badge: snap.badge, vol: snap.vol, author: snap.author };
    } else {
      coverThemeId = currentThemeId;
      applyRatioTab('banner');
    }
    if (selectThemeEl) {
```

(其内部 optgroup 注入与兜底逻辑保持不变。)

再将随后的:

```js
    refreshMetaFromArticle();
    overlay.classList.add('active');
```

替换为:

```js
    if (snap) syncFormInputs();
    else refreshMetaFromArticle();
    // 打开时刻的现场状态作为「已保存」基线,避免一打开就亮未保存圆点
    lastSavedJson = JSON.stringify(formSnapshot());
    refreshSaveDot();
    overlay.classList.add('active');
```

- [ ] **Step 7: 既有监听器接入脏状态**

主题切换处理器,在 `renderCover();` 后追加一行:

```js
    refreshSaveDot();
```

六个文案输入监听器(`inputTitle/inputDigest/inputTag/inputBadge/inputVol/inputAuthor` 的 `input` 事件),每个在 `scheduleRender();` 后追加一行:

```js
    refreshSaveDot();
```

(安全线开关 `toggle-safe-area` 是预览辅助,不入快照,不加。)

- [ ] **Step 8: 保存按钮处理器**

在「全局品牌默认文案:保存 / 清除」代码块之前插入:

```js
  // 保存全套工作台配置;发布链路按此快照生成(Task 3 接线)
  btnSaveWorkbench?.addEventListener('click', () => {
    const store = storeOrNull();
    if (!store) { showToast('当前环境存储不可用，无法保存封面配置', 'error'); return; }
    try {
      writeCoverWorkbench(store, formSnapshot());
      lastSavedJson = JSON.stringify(formSnapshot());
      refreshSaveDot();
      showToast('已保存，发布时将按此配置生成封面', 'success');
    } catch (err) {
      showToast('保存失败: ' + (err.message || '存储异常'), 'error');
    }
  });
```

- [ ] **Step 9: 构建验证 + 手动冒烟**

```bash
cd web && npm run build
```

Expected: 构建成功,无报错。

浏览器冒烟(`npm run dev`):

1. 打开封面工作台,改主题/比例/文案 → 保存按钮出现黄点 → 点「💾 保存配置」→ toast 成功、黄点消失;
2. 再改动任一字段 → 黄点重现;刷新页面 → 重开工作台 → 主题/比例/文案完整恢复、黄点不亮;
3. 未保存关闭弹窗 → 重新打开 → 恢复的是**上次保存**的状态(而非关闭前的草稿)。

- [ ] **Step 10: Commit**

```bash
cd E:/code/opensaas/zcodeapi/gzh/MD2WX
git add web/index.html web/src/styles/cover.css web/src/app.js
git commit -m "feat(web): cover studio save button — snapshot restore & unsaved dot"
```

---

### Task 3: 发布链路按保存配置生成(修复主题/比例不匹配)

**Files:**
- Modify: `web/src/app.js:29`(import 追加 `coverExportRatio`)、模块层(~96 行 `coverMetaOptions` 后新增 `getSavedCoverConfig`)、`renderPreview` 调用处(~486)、`initPublishStudio` 的 `renderCoverPreview`(~881)与 `refreshUseCoverAvailability`(~908)、推送导出(~962)
- Modify: `web/src/core/parser.js:597`(正文顶部封面主题覆盖)

**Interfaces:**
- Consumes: Task 1 `readCoverWorkbench` / `coverExportRatio`;Task 2 落库的快照。
- Produces: 模块层函数 `getSavedCoverConfig() -> { themeId: string, ratio: 'banner'|'square'|'dual', meta: {title,digest,tag,badge,vol,author} } | null`(custom-* 主题经 `getCustomTheme().baseId` 解析为视觉基座,删除的主题回落 `'tech-blue'`);`markdownToWechatHtml` 新可选渲染选项 `coverThemeId: string`(不传回落 `themeName`,向后兼容)。

- [ ] **Step 1: app.js import 追加 coverExportRatio**

将 Task 2 添加的 import 行:

```js
import { readCoverWorkbench, writeCoverWorkbench } from './core/coverWorkbench.js';
```

替换为:

```js
import { readCoverWorkbench, writeCoverWorkbench, coverExportRatio } from './core/coverWorkbench.js';
```

- [ ] **Step 2: 模块层新增 getSavedCoverConfig**

在 `web/src/app.js` 的 `coverMetaOptions()` 函数定义(约 96-100 行)之后插入:

```js
/** 封面工作台保存配置 -> 发布链路渲染参数;无快照返回 null(调用方回落现状) */
function getSavedCoverConfig() {
  const snap = readCoverWorkbench(typeof localStorage !== 'undefined' ? localStorage : null);
  if (!snap) return null;
  const themeId = snap.themeId.startsWith('custom-')
    ? (getCustomTheme(snap.themeId)?.baseId || 'tech-blue')
    : snap.themeId;
  return {
    themeId,
    ratio: snap.ratio,
    meta: { title: snap.title, digest: snap.digest, tag: snap.tag, badge: snap.badge, vol: snap.vol, author: snap.author },
  };
}
```

- [ ] **Step 3: 正文顶部封面接线(app.js + parser.js)**

`app.js` `renderPreview` 内,找到:

```js
  currentHtmlOutput = markdownToWechatHtml(body, eff.themeId, eff.override, {
```

在其之前插入一行:

```js
  const savedCoverCfg = getSavedCoverConfig();
```

并将选项对象中的:

```js
    coverMeta: currentCoverMeta,
```

替换为:

```js
    coverMeta: savedCoverCfg ? savedCoverCfg.meta : currentCoverMeta,
    coverThemeId: savedCoverCfg ? savedCoverCfg.themeId : undefined,
```

`web/src/core/parser.js:597`,将:

```js
    const headerCoverHtml = renderWechatArticleHeaderCover(themeName, coverMeta);
```

替换为:

```js
    const headerCoverHtml = renderWechatArticleHeaderCover(renderOptions.coverThemeId || themeName, coverMeta);
```

- [ ] **Step 4: 发布缩略图按保存配置渲染(含 dual 提示与自适应缩放)**

`initPublishStudio` 的 `renderCoverPreview` 内,将 useWorkshop 分支:

```js
    if (useWorkshop) {
      // 封面工坊当前封面：CSS 同源渲染并等比缩到缩略尺寸
      const ratio = 150 / 1175;
      coverThumb.innerHTML = `<div class="publish-cover-scaled" style="width:1175px;height:500px;transform:scale(${ratio});">${renderCoverHtml(currentThemeId, 'banner', currentCoverMeta || {}, false)}</div>`;
      coverStatus.className = 'publish-cover-status is-ok';
      coverStatus.textContent = '封面来源：封面工坊 ✓（推送时自动导出上传）';
      return;
    }
```

替换为:

```js
    if (useWorkshop) {
      // 发布所见即推送所得:严格按保存配置(无快照回落现状)渲染推送同款比例
      const cfg = getSavedCoverConfig() || { themeId: currentThemeId, ratio: 'banner', meta: currentCoverMeta || {} };
      const outRatio = coverExportRatio(cfg.ratio);
      const dim = COVER_DIMENSIONS[outRatio] || COVER_DIMENSIONS.banner;
      const s = outRatio === 'banner' ? 150 / dim.width : Math.max(150 / dim.width, 64 / dim.height);
      const offX = (150 - dim.width * s) / 2;
      const offY = (64 - dim.height * s) / 2;
      coverThumb.innerHTML = `<div class="publish-cover-scaled" style="width:${dim.width}px;height:${dim.height}px;transform:scale(${s});margin-left:${offX}px;margin-top:${offY}px;">${renderCoverHtml(cfg.themeId, outRatio, cfg.meta, false)}</div>`;
      coverStatus.className = 'publish-cover-status is-ok';
      coverStatus.textContent = cfg.ratio === 'dual'
        ? '封面来源：封面工坊 ✓（双拼配置，推送按 2.35:1 导出）'
        : '封面来源：封面工坊 ✓（推送时自动导出上传）';
      return;
    }
```

(无快照时 `outRatio='banner'`、`s=150/1175`,HTML 与现状逐字节一致——兼容红线。square 分支做居中裁切填充 150x64。)

- [ ] **Step 5: 可用性判断纳入保存配置**

将 `refreshUseCoverAvailability` 中的:

```js
    const available = !!currentCoverMeta || !!extractPublishMeta(textarea.value).title;
```

替换为:

```js
    const available = !!getSavedCoverConfig() || !!currentCoverMeta || !!extractPublishMeta(textarea.value).title;
```

- [ ] **Step 6: 推送导出按保存配置生成**

`btnPush` 处理器中,将:

```js
      if (useCoverToggle.checked) {
        // renderCoverDirectCanvas 返回 Promise<Blob>（内部 canvas.toBlob），需 await
        const blob = await renderCoverDirectCanvas(currentThemeId, 'banner', currentCoverMeta || {}, 1);
```

替换为:

```js
      if (useCoverToggle.checked) {
        // 按保存配置导出(无快照回落现状);双拼回落 2.35:1,双拼素材不直推草稿箱
        const cfg = getSavedCoverConfig() || { themeId: currentThemeId, ratio: 'banner', meta: currentCoverMeta || {} };
        const blob = await renderCoverDirectCanvas(cfg.themeId, coverExportRatio(cfg.ratio), cfg.meta, 1);
```

- [ ] **Step 7: 构建与全量回归**

```bash
cd web && npm run build
cd ../cloudflare/md2wx-worker && npm test
cd ../.. && python -m pytest tests/ -q
```

Expected: vite 构建成功;Node 测试全绿(含 Task 1 新增);pytest 44 项全绿。

- [ ] **Step 8: 浏览器端到端冒烟**

`cd web && npm run dev` 后:

1. 工作台保存 square 配置 → 发布工坊:缩略图为方图居中裁切、「使用封面工坊的封面」勾选 → 推送成功,草稿箱封面为 1:1 形态;
2. 保存 dual 配置 → 发布工坊缩略图为 banner 形态、状态栏显示「双拼配置,推送按 2.35:1 导出」;工作台内「下载高清 PNG」仍为双拼原图;
3. 不保存 square 而是改成 dual 后直接开发布工坊(不点保存)→ 缩略图仍是上次保存的形态;
4. 清空 localStorage 的 `md2wx_cover_workbench` → 发布缩略图/推送行为与线上现状一致(兼容红线);
5. 保存某封面主题(如 dark-night)后切换编辑器主题 → 正文顶部封面卡片仍为 dark-night,正文排版跟随编辑器主题。

- [ ] **Step 9: Commit**

```bash
cd E:/code/opensaas/zcodeapi/gzh/MD2WX
git add web/src/app.js web/src/core/parser.js
git commit -m "feat(web): publish chain renders from saved cover config — fix theme/ratio mismatch"
```

---

### Task 4: 收尾——devlog 与全量验证

**Files:**
- Create: `devlogs/2026-10-13-cover-workbench-save.md`(沿仓库 devlogs 惯例,若无此惯例则跳过本文件,改为在 PR/commit 说明中记录)
- 无代码改动

**Interfaces:**
- Consumes: Task 1-3 全部完成。
- Produces: 回归全绿的验证记录 + 用户冒烟清单。

- [ ] **Step 1: 全量测试**

```bash
cd cloudflare/md2wx-worker && npm test
cd .. && cd .. && python -m pytest tests/ -q
cd web && npm run build
```

Expected: Node 测试全绿、pytest 44 项全绿、vite 构建成功。

- [ ] **Step 2: 记录 devlog(格式沿 `devlogs/devlog_part6_worker_unified.md`:frontmatter title/digest + 叙事正文)**

创建 `devlogs/2026-10-13-cover-workbench-save.md`:

```markdown
---
title: 封面工作台保存配置与发布同源生成
digest: 工作台一键保存全套封面配置,发布推送/缩略图/正文顶部封面三处严格按保存配置渲染。
---

# 封面工作台保存配置与发布同源生成

## 改了什么

(此处写:coverWorkbench.js 快照模块、header 保存按钮与未保存圆点、
app.js getSavedCoverConfig 统一取数替换三处消费点写死参数、
parser.js coverThemeId 覆盖、dual 推送回落 banner)

## 兼容红线怎么验证的

(此处写:清空 md2wx_cover_workbench 后推送/缩略图/正文顶部封面与改造前逐一一致的核对人)

## 用户冒烟清单

(Task 3 Step 8 的 5 条,逐条列出)
```

- [ ] **Step 3: Commit**

```bash
cd E:/code/opensaas/zcodeapi/gzh/MD2WX
git add devlogs/
git commit -m "docs(devlog): cover workbench save-config shipped"
```
