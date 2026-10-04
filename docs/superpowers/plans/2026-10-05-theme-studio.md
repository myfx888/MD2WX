# MD2WX 主题工坊（Theme Studio）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供可视化主题微调：在任一内置主题基础上改 9 色 + 排版参数，实时预览、本地保存、下拉可选、导入导出 JSON。

**Architecture:** 新增纯逻辑层 `web/src/core/customThemes.js`（差异覆盖 `{baseId, override}` 的 CRUD/导入导出，Node 可测），弹窗 UI 复用 `cover-modal-*` 与发布工坊的双类覆盖法，app.js 以 `initThemeStudio()` 接线并让 `selectTheme` 识别 `custom-` 前缀 id。引擎与 Python/Worker 零改动。

**Tech Stack:** 原生 ESM + Vanilla CSS；测试复用 worker 目录的 esbuild + `node --test` 基建。

**设计文档:** `docs/superpowers/specs/2026-10-05-theme-studio-design.md`

## Global Constraints

- 所有命令在 `E:\code\opensaas\zcodeapi\gzh\MD2WX` 仓库根执行（Git Bash / Windows），git 一律用 `git -C <MD2WX路径>` 或先 `cd` 到仓库根（本会话 shell cwd 会漂移）。
- 引擎 `web/src/core/themes.js` / `parser.js` 禁止结构性改动（import 其导出使用）；Python 端、Worker API（`worker.js` 路由逻辑）零改动——Worker 仅在测试基建 `package.json` 的 esbuild 命令行上追加。
- 每个改 web/ 的任务结束必须 `cd web && npm run build` 通过。
- localStorage 键：`md2wx_custom_themes`（单键）；`md2wx_theme` 沿用（可存 `custom-` id）。
- id 规则：`custom-` + 6 位随机小写字母数字。仅存差异 override（只允许 `colors` / `typography` 两键）。
- 推送/封面/预览的 theme 解析规则：custom id 对外一律映射 baseId；差异仅在前端渲染与合并判断中使用。
- 全站禁止 Emoji（SVG 图标规范）；文案中文。

---

### Task 1: customThemes.js 纯逻辑层 + 测试

**Files:**
- Create: `web/src/core/customThemes.js`
- Create: `cloudflare/md2wx-worker/test/customThemes.test.mjs`
- Modify: `cloudflare/md2wx-worker/package.json`（build:test / test 两条 script 追加）

**Interfaces:**
- Consumes: `web/src/core/themes.js` 的 `BUILTIN_THEMES`（id 校验）；`themes.js` 的 `deepMerge`（仅测试中用于合并断言；customThemes.js 自身不 import 它，避免打包 worker bundle 时重复引入引擎）。
- Produces（Task 2/3 依赖的确切签名）:
  - `CUSTOM_COLORS = [{key:'accent',label:'强调色'}, {key:'accent_bg',label:'强调底色'}, {key:'text_color',label:'正文色'}, {key:'sub_color',label:'次级色'}, {key:'border_color',label:'边框色'}, {key:'code_bg',label:'代码底色'}, {key:'code_text',label:'代码字色'}, {key:'quote_bg',label:'引言底色'}, {key:'page_bg',label:'页面底色'}]`
  - `CUSTOM_TYPOGRAPHY = [{key:'font_size_base',label:'正文字号',min:14,max:17.5,step:0.5,unit:'px'},{key:'line_height_base',label:'行距',min:1.6,max:2.1,step:0.05,unit:''},{key:'letter_spacing',label:'字间距',min:0,max:1.5,step:0.1,unit:'px'}]`
  - `FONT_STACKS = [{id:'system',label:'系统默认',value:"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"},{id:'serif',label:'衬线',value:"Georgia, 'Times New Roman', serif"},{id:'mono',label:'等宽',value:"ui-monospace, Menlo, monospace"}]`
  - `listCustomThemes(store?) -> [{id, baseId, name}]`
  - `getCustomTheme(id, store?) -> {baseId, name, override} | null`
  - `saveCustomTheme(idOrNull, {baseId, name, override}, store?) -> {ok:true, id} | {ok:false, error}`（校验 baseId ∈ BUILTIN_THEMES、name 非空、override 仅含 colors/typography 且均为对象；新 id `custom-` + 6 位随机小写字母数字）
  - `deleteCustomTheme(id, store?) -> boolean`
  - `exportCustomTheme(id, store?) -> {ok:true, json} | {ok:false, error}`（`{version:1, baseId, name, override}` 美化 JSON）
  - `importCustomTheme(jsonStr, store?) -> {ok:true, id} | {ok:false, error}`（校验同 save + 重名自动加「导入」后缀；version 键忽略不校验值）
  - `CUSTOM_STORE_KEY = 'md2wx_custom_themes'`
  - 所有函数 `store` 缺省 `localStorage`，不可用（Node）时读写内存 Map（同一模块内兜底，保证 Node 测试零注入也能跑）

- [ ] **Step 1: 写失败测试**

写入 `cloudflare/md2wx-worker/test/customThemes.test.mjs`：

```js
/**
 * 主题工坊纯逻辑层测试：esbuild 打包 web/src/core/customThemes.js 后用 node --test 断言
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_COLORS, CUSTOM_TYPOGRAPHY, FONT_STACKS, CUSTOM_STORE_KEY,
  listCustomThemes, getCustomTheme, saveCustomTheme, deleteCustomTheme,
  exportCustomTheme, importCustomTheme,
} from './.custom.bundle.mjs';
import { deepMerge, FALLBACK_BASE_THEME } from '../../../web/src/core/themes.js';

function mockStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

describe('常量清单', () => {
  it('九色清单 key 与 label 齐全', () => {
    assert.equal(CUSTOM_COLORS.length, 9);
    assert.ok(CUSTOM_COLORS.every((c) => c.key && c.label));
    assert.deepEqual(CUSTOM_COLORS.map((c) => c.key).slice(0, 2), ['accent', 'accent_bg']);
  });
  it('排版清单含字号/行距/字间距', () => {
    assert.deepEqual(CUSTOM_TYPOGRAPHY.map((t) => t.key), ['font_size_base', 'line_height_base', 'letter_spacing']);
  });
  it('字体栈三种', () => {
    assert.deepEqual(FONT_STACKS.map((f) => f.id), ['system', 'serif', 'mono']);
  });
});

describe('save/list/get/delete 往返', () => {
  it('保存新主题生成 custom- 前缀 id', () => {
    const store = mockStore();
    const r = saveCustomTheme(null, { baseId: 'tech-blue', name: '我的蓝', override: { colors: { accent: '#ff0000' } } }, store);
    assert.equal(r.ok, true);
    assert.match(r.id, /^custom-[a-z0-9]{6}$/);
    const list = listCustomThemes(store);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '我的蓝');
    assert.equal(getCustomTheme(r.id, store).baseId, 'tech-blue');
  });

  it('更新已有 id 不新增条目', () => {
    const store = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'vintage-news', name: 'A', override: {} }, store);
    saveCustomTheme(id, { baseId: 'vintage-news', name: 'B', override: { colors: { accent: '#123456' } } }, store);
    assert.equal(listCustomThemes(store).length, 1);
    assert.equal(getCustomTheme(id, store).name, 'B');
  });

  it('baseId 不在内置主题 -> 拒绝', () => {
    const r = saveCustomTheme(null, { baseId: 'no-such', name: 'X', override: {} }, mockStore());
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('baseId'));
  });

  it('name 为空 -> 拒绝；override 含非法键 -> 拒绝', () => {
    const s = mockStore();
    assert.equal(saveCustomTheme(null, { baseId: 'tech-blue', name: '  ', override: {} }, s).ok, false);
    assert.equal(saveCustomTheme(null, { baseId: 'tech-blue', name: 'X', override: { styles: { h1: 'underline' } } }, s).ok, false);
  });

  it('重名允许（id 唯一即可）', () => {
    const s = mockStore();
    saveCustomTheme(null, { baseId: 'tech-blue', name: '同名', override: {} }, s);
    const r = saveCustomTheme(null, { baseId: 'tech-blue', name: '同名', override: {} }, s);
    assert.equal(r.ok, true);
    assert.equal(listCustomThemes(s).length, 2);
  });

  it('deleteCustomTheme 删除并返回 true，删不存在返回 false', () => {
    const s = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'tech-blue', name: 'D', override: {} }, s);
    assert.equal(deleteCustomTheme(id, s), true);
    assert.equal(deleteCustomTheme(id, s), false);
    assert.deepEqual(listCustomThemes(s), []);
  });
});

describe('合并语义（getTheme 兼容）', () => {
  it('override 仅覆盖指定字段，其余保持基础主题值', () => {
    const override = { colors: { accent: '#ff0000' }, typography: { font_size_base: '17px' } };
    const base = FALLBACK_BASE_THEME;
    const merged = deepMerge(deepMerge({}, base), override);
    assert.equal(merged.colors.accent, '#ff0000');
    assert.equal(merged.typography.font_size_base, '17px');
    assert.equal(merged.colors.code_bg, base.colors.code_bg);
    assert.equal(merged.styles.h1, base.styles.h1);
  });
});

describe('export/import 回环', () => {
  it('导出为 version:1 JSON，导入还原 override', () => {
    const s = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'warm-memo', name: '便签变体', override: { colors: { page_bg: '#fffbeb' } } }, s);
    const { ok, json } = exportCustomTheme(id, s);
    assert.equal(ok, true);
    const parsed = JSON.parse(json);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.baseId, 'warm-memo');

    const s2 = mockStore();
    const imp = importCustomTheme(json, s2);
    assert.equal(imp.ok, true);
    assert.equal(getCustomTheme(imp.id, s2).override.colors.page_bg, '#fffbeb');
  });

  it('导入拒绝坏 JSON / 未知 baseId / 非法键', () => {
    const s = mockStore();
    assert.equal(importCustomTheme('{broken', s).ok, false);
    assert.equal(importCustomTheme(JSON.stringify({ version: 1, baseId: 'nope', name: 'X', override: {} }), s).ok, false);
    assert.equal(importCustomTheme(JSON.stringify({ version: 1, baseId: 'tech-blue', name: 'X', override: { styles: {} } }), s).ok, false);
  });

  it('导入重名自动加「导入」后缀', () => {
    const s = mockStore();
    const { id } = saveCustomTheme(null, { baseId: 'tech-blue', name: '主题A', override: {} }, s);
    const { json } = exportCustomTheme(id, s);
    const imp = importCustomTheme(json, s);
    assert.equal(imp.ok, true);
    assert.notEqual(imp.id, id);
    assert.equal(getCustomTheme(imp.id, s).name, '主题A导入');
  });
});
```

- [ ] **Step 2: 扩展测试脚本并确认失败**

`cloudflare/md2wx-worker/package.json` 两条 script 改为：

```json
    "build:test": "esbuild worker.js --bundle --format=esm --outfile=test/.worker.bundle.mjs --loader:.png=dataurl && esbuild ../../web/src/core/publish.js --bundle --format=esm --outfile=test/.publish.bundle.mjs && esbuild ../../web/src/core/customThemes.js --bundle --format=esm --outfile=test/.custom.bundle.mjs",
    "test": "npm run build:test && node --test test/engine.test.mjs test/publish.test.mjs test/customThemes.test.mjs",
```

运行：

```bash
cd /e/code/opensaas/zcodeapi/gzh/MD2WX/cloudflare/md2wx-worker && npm test 2>&1 | tail -4
```

Expected: FAIL——esbuild 报 `customThemes.js` 不存在。

- [ ] **Step 3: 实现 customThemes.js**

写入 `web/src/core/customThemes.js`：

```js
/**
 * MD2WX 主题工坊纯逻辑层：自定义主题 CRUD、导入导出。
 * 存储为差异覆盖 {baseId, override}；渲染走 getTheme(baseId, override) 现成管道。
 * 零 DOM 依赖（store 可注入，Node 下退化为内存 Map），可测。
 */
import { BUILTIN_THEMES } from './themes.js';

export const CUSTOM_STORE_KEY = 'md2wx_custom_themes';

export const CUSTOM_COLORS = [
  { key: 'accent', label: '强调色' },
  { key: 'accent_bg', label: '强调底色' },
  { key: 'text_color', label: '正文色' },
  { key: 'sub_color', label: '次级色' },
  { key: 'border_color', label: '边框色' },
  { key: 'code_bg', label: '代码底色' },
  { key: 'code_text', label: '代码字色' },
  { key: 'quote_bg', label: '引言底色' },
  { key: 'page_bg', label: '页面底色' },
];

export const CUSTOM_TYPOGRAPHY = [
  { key: 'font_size_base', label: '正文字号', min: 14, max: 17.5, step: 0.5, unit: 'px' },
  { key: 'line_height_base', label: '行距', min: 1.6, max: 2.1, step: 0.05, unit: '' },
  { key: 'letter_spacing', label: '字间距', min: 0, max: 1.5, step: 0.1, unit: 'px' },
];

export const FONT_STACKS = [
  { id: 'system', label: '系统默认', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { id: 'serif', label: '衬线', value: "Georgia, 'Times New Roman', serif" },
  { id: 'mono', label: '等宽', value: 'ui-monospace, Menlo, monospace' },
];

const OVERRIDE_KEYS = ['colors', 'typography'];

function defaultStore() {
  if (typeof localStorage !== 'undefined') return localStorage;
  // Node 环境（测试/SSR）内存兜底：模块级 Map 即持久语义
  if (!globalThis.__md2wxCustomThemeStore) {
    globalThis.__md2wxCustomThemeStore = new Map();
  }
  const m = globalThis.__md2wxCustomThemeStore;
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

function readAll(store) {
  try {
    const obj = JSON.parse(store.getItem(CUSTOM_STORE_KEY) || '{}');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeAll(obj, store) {
  store.setItem(CUSTOM_STORE_KEY, JSON.stringify(obj));
}

function genId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'custom-' + s;
}

function validOverride(override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return false;
  return Object.keys(override).every(
    (k) => OVERRIDE_KEYS.includes(k) && override[k] && typeof override[k] === 'object' && !Array.isArray(override[k])
  );
}

export function listCustomThemes(store = defaultStore()) {
  return Object.entries(readAll(store)).map(([id, t]) => ({ id, baseId: t.baseId, name: t.name }));
}

export function getCustomTheme(id, store = defaultStore()) {
  return readAll(store)[id] || null;
}

export function saveCustomTheme(idOrNull, { baseId, name, override }, store = defaultStore()) {
  if (!BUILTIN_THEMES[baseId]) return { ok: false, error: `baseId 不存在: ${baseId}` };
  if (!name || !String(name).trim()) return { ok: false, error: 'name 必填' };
  if (!validOverride(override)) return { ok: false, error: 'override 仅允许 colors/typography 对象' };
  const all = readAll(store);
  const id = idOrNull || genId();
  if (idOrNull && !all[idOrNull]) return { ok: false, error: `主题不存在: ${idOrNull}` };
  all[id] = { baseId, name: String(name).trim(), override };
  try {
    writeAll(all, store);
  } catch (e) {
    return { ok: false, error: '存储不可用' };
  }
  return { ok: true, id };
}

export function deleteCustomTheme(id, store = defaultStore()) {
  const all = readAll(store);
  if (!all[id]) return false;
  delete all[id];
  writeAll(all, store);
  return true;
}

export function exportCustomTheme(id, store = defaultStore()) {
  const t = getCustomTheme(id, store);
  if (!t) return { ok: false, error: `主题不存在: ${id}` };
  return { ok: true, json: JSON.stringify({ version: 1, ...t }, null, 2) };
}

export function importCustomTheme(jsonStr, store = defaultStore()) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonStr));
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败' };
  }
  const check = saveCustomTheme(null, { baseId: parsed.baseId, name: parsed.name, override: parsed.override }, store);
  if (!check.ok) return check;
  // 重名自动加后缀（save 已通过，此处仅处理 name 语义）
  const all = readAll(store);
  const saved = all[check.id];
  if (Object.values(all).filter((t) => t.name === saved.name).length > 1) {
    saved.name = saved.name + '导入';
    writeAll(all, store);
  }
  return { ok: true, id: check.id };
}
```

注意 import 一处：测试里 `import { deepMerge, FALLBACK_BASE_THEME } from '../../../web/src/core/themes.js'`——`node --test` 直接跑 ESM 会因 themes.js 的无断言 JSON import 失败。**修正**：测试不从源码 import，改从 bundle 取——在 customThemes.js 追加导出测试助手（或直接在 bundle 里 re-export）：

`customThemes.js` 末尾加：

```js
// 测试桥接：合并语义断言需要 themes.js 的 deepMerge/FALLBACK_BASE_THEME，
// 经 bundle 一并导出，避免 Node 直跑源码触发 JSON import 断言问题
export { deepMerge, FALLBACK_BASE_THEME } from './themes.js';
```

测试 import 行改为：

```js
import {
  CUSTOM_COLORS, CUSTOM_TYPOGRAPHY, FONT_STACKS, CUSTOM_STORE_KEY,
  listCustomThemes, getCustomTheme, saveCustomTheme, deleteCustomTheme,
  exportCustomTheme, importCustomTheme, deepMerge, FALLBACK_BASE_THEME,
} from './.custom.bundle.mjs';
```

（删除原 `from '../../../web/src/core/themes.js'` 那行 import。）

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /e/code/opensaas/zcodeapi/gzh/MD2WX/cloudflare/md2wx-worker && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 全部 passing（30 原有 + ~13 新增），0 failing。

- [ ] **Step 5: Commit**

```bash
git -C /e/code/opensaas/zcodeapi/gzh/MD2WX add web/src/core/customThemes.js cloudflare/md2wx-worker/test/customThemes.test.mjs cloudflare/md2wx-worker/package.json && git -C /e/code/opensaas/zcodeapi/gzh/MD2WX commit -m "feat(web): custom themes pure logic layer with node tests"
```

---

### Task 2: index.html 弹窗结构 + 下拉入口 + 样式

**Files:**
- Modify: `web/index.html`（body 末尾加主题工坊弹窗）
- Modify: `web/src/styles/main.css`（追加 `.theme-studio-*` 样式）
- Modify: `web/src/app.js`（仅 `renderThemeDropdown()` 追加自定义分组——属接线最小前置，完整接线在 Task 3）

**Interfaces:**
- Consumes: Task 1 的 `CUSTOM_COLORS` / `CUSTOM_TYPOGRAPHY` / `FONT_STACKS`（Task 3 渲染编辑面板时用）；既有 `cover-modal-overlay` / `cover-modal-window` / `cover-modal-header` / `cover-modal-body` / `cover-modal-close-btn` / `settings-input` 类。
- Produces（Task 3 依赖的确切 DOM id）：
  - 弹窗 `#theme-studio-overlay`、开按钮 `#btn-theme-studio`（Task 3 在下拉菜单动态渲染）、关闭 `#btn-close-theme-studio`；
  - 列表 `#ts-builtin-list` / `#ts-custom-list`；编辑 `#ts-name` / `#ts-color-row` / `#ts-typo-row` / `#ts-font-select` / `#ts-editor-title`；
  - 预览 `#ts-preview-target`；操作 `#btn-ts-save` / `#btn-ts-export` / `#btn-ts-delete` / `#ts-editor`（编辑面板容器）。

- [ ] **Step 1: index.html 插入弹窗**

在 `<!-- Publish Studio -->` 弹窗块的关闭 `</div>` 之后、`<!-- Changelog Modal -->` 之前插入（与发布工坊同级）：

```html
    <!-- Theme Studio -->
    <div class="cover-modal-overlay" id="theme-studio-overlay" role="dialog" aria-modal="true" aria-labelledby="theme-studio-title">
      <div class="cover-modal-window theme-studio-window">
        <div class="cover-modal-header">
          <div class="cover-header-title-group">
            <div class="cover-header-icon" id="icon-ts-window"></div>
            <div class="cover-header-title" id="theme-studio-title">
              <span>主题工坊</span>
              <span class="cover-header-badge">可视化微调</span>
            </div>
          </div>
          <button class="cover-modal-close-btn" id="btn-close-theme-studio" type="button" title="关闭 (Esc)">
            <span id="icon-ts-close"></span>
          </button>
        </div>
        <div class="cover-modal-body theme-studio-body">
          <div class="ts-layout">
            <div class="ts-left">
              <div class="ts-section-title">内置主题（复制为自定义后可编辑）</div>
              <div class="ts-builtin-list" id="ts-builtin-list"></div>
              <div class="ts-section-title">我的自定义主题</div>
              <div class="ts-custom-list" id="ts-custom-list"></div>
            </div>
            <div class="ts-right" id="ts-editor" hidden>
              <div class="ts-section-title" id="ts-editor-title">编辑</div>
              <div class="ts-field">
                <label class="settings-label">主题名称</label>
                <input type="text" class="settings-input" id="ts-name" placeholder="给主题起个名字" autocomplete="off">
              </div>
              <div class="ts-field">
                <label class="settings-label">颜色</label>
                <div class="ts-color-row" id="ts-color-row"></div>
              </div>
              <div class="ts-field">
                <label class="settings-label">排版</label>
                <div class="ts-typo-row" id="ts-typo-row"></div>
                <div class="ts-field" style="margin-top:8px;">
                  <label class="settings-label">字体栈</label>
                  <select class="settings-input" id="ts-font-select"></select>
                </div>
              </div>
              <div class="ts-actions">
                <button class="btn btn-primary" id="btn-ts-save" type="button">保存</button>
                <button class="btn btn-secondary" id="btn-ts-export" type="button">导出 JSON</button>
                <button class="btn btn-secondary" id="btn-ts-delete" type="button">删除</button>
              </div>
            </div>
            <div class="ts-preview">
              <div class="ts-section-title">实时预览</div>
              <div class="ts-preview-scroll">
                <div id="ts-preview-target"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: main.css 追加主题工坊样式**

`web/src/styles/main.css` 末尾追加：

```css
/* 主题工坊（Theme Studio） */
/* 覆盖 cover-modal 的窗体高度与两列栅格（同发布工坊：双类提升优先级） */
.cover-modal-window.theme-studio-window {
  max-width: 980px;
  width: 94vw;
  height: auto;
  max-height: 90vh;
}

.cover-modal-body.theme-studio-body {
  display: block;
  overflow: hidden;
  padding: 14px 16px 16px;
}

.ts-layout {
  display: grid;
  grid-template-columns: 240px 250px 1fr;
  gap: 14px;
  height: 66vh;
}

.ts-left, .ts-right {
  overflow-y: auto;
  padding-right: 4px;
}

.ts-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary, #a1a1aa);
  margin: 8px 0;
}

.ts-builtin-list, .ts-custom-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.ts-theme-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--border-color, #e4e4e7);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
}

.ts-theme-item:hover {
  border-color: var(--accent, #2563eb);
}

.ts-theme-item.active {
  border-color: var(--accent, #2563eb);
  background: var(--accent-soft, #eff6ff);
}

.ts-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.ts-theme-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ts-item-btn {
  border: none;
  background: none;
  color: var(--accent, #2563eb);
  cursor: pointer;
  font-size: 11.5px;
  padding: 2px 4px;
  flex: 0 0 auto;
}

.ts-item-btn.is-danger {
  color: #dc2626;
}

.ts-field {
  margin-bottom: 10px;
}

.ts-color-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
}

.ts-color-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.ts-color-item input[type="color"] {
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-color, #e4e4e7);
  border-radius: 6px;
  padding: 0;
  background: none;
  cursor: pointer;
}

.ts-color-item .ts-hex {
  width: 74px;
  font-size: 11px;
  text-transform: lowercase;
}

.ts-typo-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ts-typo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.ts-typo-item input[type="range"] {
  flex: 1;
  accent-color: var(--accent, #2563eb);
}

.ts-typo-item .ts-val {
  min-width: 48px;
  text-align: right;
  color: var(--text-secondary, #52525b);
}

.ts-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.ts-preview {
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border-color, #e4e4e7);
  padding-left: 14px;
  min-width: 0;
}

.ts-preview-scroll {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--border-color, #e4e4e7);
  border-radius: 8px;
  background: var(--control-bg, #f7f7f8);
  padding: 10px;
}

.ts-theme-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary, #52525b);
  cursor: pointer;
  padding: 9px 12px;
}

.ts-theme-entry:hover {
  background: var(--accent-soft, #eff6ff);
}

.ts-theme-group-label {
  font-size: 11px;
  color: var(--text-tertiary, #a1a1aa);
  padding: 6px 12px 2px;
}
```

- [ ] **Step 3: 构建验证**

```bash
cd /e/code/opensaas/zcodeapi/gzh/MD2WX/web && npm run build 2>&1 | tail -2
```

Expected: vite build 成功。

- [ ] **Step 4: Commit**

```bash
git -C /e/code/opensaas/zcodeapi/gzh/MD2WX add web/index.html web/src/styles/main.css && git -C /e/code/opensaas/zcodeapi/gzh/MD2WX commit -m "feat(web): theme studio modal markup and styles"
```

---

### Task 3: app.js 接线（下拉、选中、渲染、工坊交互）

**Files:**
- Modify: `web/src/app.js`

**Interfaces:**
- Consumes: Task 1 全部导出；既有 `BUILTIN_THEMES` / `getTheme` / `isDarkTheme` / `markdownToWechatHtml` / `showToast` / `setIcon` / `ICONS` / 全局 `textarea`。
- Produces: 完整主题工坊交互。模块级状态 `let currentCustomOverride = null;` 与助手 `effectiveThemeInfo() -> {themeId, override}`（custom id 返回 `{baseId, override}`，否则 `{themeId, null}`）。

- [ ] **Step 1: import 与状态**

import 区追加：

```js
import {
  listCustomThemes, getCustomTheme, saveCustomTheme, deleteCustomTheme,
  exportCustomTheme, importCustomTheme, CUSTOM_COLORS, CUSTOM_TYPOGRAPHY, FONT_STACKS,
} from './core/customThemes.js';
```

`let currentThemeId = ...` 行之后追加：

```js
// 当前选中的自定义主题差异覆盖（非 custom 主题时为 null）
let currentCustomOverride = null;
```

- [ ] **Step 2: 主题解析助手与 selectTheme/renderPreview/adaptPhoneTheme 改造**

`selectTheme` 函数之前加助手：

```js
/**
 * 解析当前主题：custom- 前缀映射为 { baseId, override }，否则 override 为 null
 */
function effectiveThemeInfo() {
  if (currentThemeId && currentThemeId.startsWith('custom-')) {
    const t = getCustomTheme(currentThemeId);
    if (t) return { themeId: t.baseId, override: t.override };
  }
  return { themeId: currentThemeId, override: null };
}
```

`selectTheme(themeId)` 中：

- `currentThemeId = themeId;` 之后加一行：`currentCustomOverride = effectiveThemeInfo().override;`
- `const theme = getTheme(themeId);` 改为：

```js
  const eff = effectiveThemeInfo();
  const theme = getTheme(eff.themeId, eff.override);
```

`renderPreview()` 中 `markdownToWechatHtml(body, currentThemeId, null, {...})` 改为 `markdownToWechatHtml(body, eff.themeId, eff.override, {...})`（函数内先取 `const eff = effectiveThemeInfo();`）。

`adaptPhoneTheme()` 的两个调用点不变（它接收已合并的 theme 对象，无需改）。

- [ ] **Step 3: renderThemeDropdown 追加自定义分组与工坊入口**

在 `renderThemeDropdown()` 内、现有 `for (const t of themes)` 循环之后、`themeDropdownMenu.appendChild` 收尾前追加（列表内容后 append 一个分隔与分组）：

```js
  // 自定义主题分组
  const customs = listCustomThemes();
  if (customs.length) {
    const label = document.createElement('div');
    label.className = 'ts-theme-group-label';
    label.textContent = '自定义主题';
    themeDropdownMenu.appendChild(label);
    for (const c of customs) {
      const item = document.createElement('div');
      item.className = `theme-option-item ${c.id === currentThemeId ? 'active' : ''}`;
      item.dataset.themeId = c.id;
      const full = getCustomTheme(c.id);
      const accent = full?.override?.colors?.accent || BUILTIN_THEMES[c.baseId]?.colors?.accent || '#2563eb';
      item.innerHTML = `
        <div class="theme-info">
          <div class="theme-name">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${accent}; display: inline-block;"></span>
            <span>${c.name}</span>
          </div>
        </div>
        <span style="font-size: 10px; color: #8a8a8a;">自定义</span>
      `;
      item.addEventListener('click', () => {
        selectTheme(c.id);
        themeDropdownMenu.classList.remove('show');
      });
      themeDropdownMenu.appendChild(item);
    }
  }

  // 工坊入口
  const entry = document.createElement('div');
  entry.className = 'ts-theme-entry';
  entry.innerHTML = `<span id="icon-ts-entry"></span><span>自定义主题…</span>`;
  entry.addEventListener('click', () => {
    themeDropdownMenu.classList.remove('show');
    document.getElementById('theme-studio-overlay').classList.add('active');
    window.__renderThemeStudio && window.__renderThemeStudio();
  });
  themeDropdownMenu.appendChild(entry);
```

同时 `initIcons()` 追加：`setIcon('#icon-ts-window', 'palette'); setIcon('#icon-ts-close', 'x'); setIcon('#icon-ts-entry', 'palette');`

- [ ] **Step 4: initThemeStudio（放在 initPublishStudio 之后）**

```js
/**
 * 主题工坊：内置主题复制为自定义 -> 可视化微调 -> 保存/导出/导入/删除
 */
function initThemeStudio() {
  const overlay = document.getElementById('theme-studio-overlay');
  const btnClose = document.getElementById('btn-close-theme-studio');
  const builtinList = document.getElementById('ts-builtin-list');
  const customList = document.getElementById('ts-custom-list');
  const editor = document.getElementById('ts-editor');
  const editorTitle = document.getElementById('ts-editor-title');
  const nameInput = document.getElementById('ts-name');
  const colorRow = document.getElementById('ts-color-row');
  const typoRow = document.getElementById('ts-typo-row');
  const fontSelect = document.getElementById('ts-font-select');
  const previewTarget = document.getElementById('ts-preview-target');
  const btnSave = document.getElementById('btn-ts-save');
  const btnExport = document.getElementById('btn-ts-export');
  const btnDelete = document.getElementById('btn-ts-delete');

  if (!overlay || !builtinList) return;

  // 工坊内编辑态（与全局 currentThemeId 解耦）
  let editing = null; // { id, baseId, name, override }

  const PREVIEW_SAMPLE = [
    '# 标题层级演示',
    '',
    '## 二级分区：核心观点',
    '',
    '> 这是一段引用导读块，用于检查引言底色与左边条。',
    '',
    '正文段落：**加粗强调** 与 `行内代码`，以及 [链接文字](https://example.com) 的脚注转换效果。',
    '',
    '```python',
    'def hello():',
    '    return "code block"',
    '```',
    '',
    '| 模块 | 说明 |',
    '| :--- | :--- |',
    '| Parser | 解析引擎 |',
    '| Theme | 主题系统 |',
  ].join('\n');

  // 构建编辑面板控件（一次性）
  const colorInputs = {};
  for (const c of CUSTOM_COLORS) {
    const wrap = document.createElement('div');
    wrap.className = 'ts-color-item';
    wrap.innerHTML = `<input type="color" data-key="${c.key}"><input type="text" class="settings-input ts-hex" data-key="${c.key}" placeholder="${c.label}"><span>${c.label}</span>`;
    colorRow.appendChild(wrap);
    const picker = wrap.querySelector('input[type="color"]');
    const hex = wrap.querySelector('.ts-hex');
    picker.addEventListener('input', () => { hex.value = picker.value; applyLocal(c.key, 'colors', picker.value); });
    hex.addEventListener('change', () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) { picker.value = hex.value; applyLocal(c.key, 'colors', hex.value); } });
    colorInputs[c.key] = { picker, hex };
  }
  const typoInputs = {};
  for (const t of CUSTOM_TYPOGRAPHY) {
    const wrap = document.createElement('div');
    wrap.className = 'ts-typo-item';
    wrap.innerHTML = `<span>${t.label}</span><input type="range" min="${t.min}" max="${t.max}" step="${t.step}" data-key="${t.key}"><span class="ts-val"></span>`;
    typoRow.appendChild(wrap);
    const range = wrap.querySelector('input[type="range"]');
    const val = wrap.querySelector('.ts-val');
    range.addEventListener('input', () => { val.textContent = range.value + t.unit; applyLocal(t.key, 'typography', range.value + t.unit); });
    typoInputs[t.key] = { range, val };
  }
  for (const f of FONT_STACKS) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    fontSelect.appendChild(opt);
  }
  fontSelect.addEventListener('change', () => {
    const f = FONT_STACKS.find((x) => x.id === fontSelect.value);
    if (f) applyLocal('font_family', 'typography', f.value);
  });

  function applyLocal(key, group, value) {
    if (!editing) return;
    editing.override[group] = editing.override[group] || {};
    editing.override[group][key] = value;
    renderPreviewPane();
  }

  function mergedTheme() {
    return getTheme(editing.baseId, editing.override);
  }

  function renderPreviewPane() {
    previewTarget.innerHTML = markdownToWechatHtml(PREVIEW_SAMPLE, editing.baseId, editing.override, { linkToFootnote: false, insertCover: false });
  }

  function fillEditor() {
    editorTitle.textContent = `编辑：${editing.name}（基于 ${BUILTIN_THEMES[editing.baseId]?.name || editing.baseId}）`;
    nameInput.value = editing.name;
    const baseTheme = getTheme(editing.baseId);
    for (const c of CUSTOM_COLORS) {
      const cur = editing.override.colors?.[c.key] || baseTheme.colors?.[c.key] || '#000000';
      colorInputs[c.key].picker.value = cur;
      colorInputs[c.key].hex.value = cur;
    }
    for (const t of CUSTOM_TYPOGRAPHY) {
      const cur = editing.override.typography?.[t.key] || baseTheme.typography?.[t.key] || '';
      const num = parseFloat(cur) || t.min;
      typoInputs[t.key].range.value = num;
      typoInputs[t.key].val.textContent = cur + (CUSTOM_TYPOGRAPHY.find((x) => x.key === t.key).unit || '');
    }
    const ff = editing.override.typography?.font_family || baseTheme.typography?.font_family || '';
    const match = FONT_STACKS.find((f) => f.value === ff);
    fontSelect.value = match ? match.id : 'system';
    renderPreviewPane();
  }

  function renderLists() {
    builtinList.innerHTML = '';
    for (const t of Object.values(BUILTIN_THEMES)) {
      const item = document.createElement('div');
      item.className = 'ts-theme-item';
      item.innerHTML = `<span class="ts-dot" style="background:${t.colors?.accent || '#2563eb'}"></span><span class="ts-theme-name">${t.name}</span><button class="ts-item-btn" type="button">复制为自定义</button>`;
      item.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        editing = { id: null, baseId: t.id, name: t.name.split('(')[0].trim() + ' 自定义', override: {} };
        editor.hidden = false;
        fillEditor();
      });
      builtinList.appendChild(item);
    }
    customList.innerHTML = '';
    const customs = listCustomThemes();
    if (!customs.length) {
      customList.innerHTML = '<div style="color:#a1a1aa;font-size:12px;">还没有自定义主题——点上方内置主题的「复制为自定义」</div>';
    }
    for (const c of customs) {
      const full = getCustomTheme(c.id);
      const baseAccent = BUILTIN_THEMES[c.baseId]?.colors?.accent || '#2563eb';
      const item = document.createElement('div');
      item.className = `ts-theme-item ${c.id === currentThemeId ? 'active' : ''}`;
      item.innerHTML = `<span class="ts-dot" style="background:${full.override.colors?.accent || baseAccent}"></span><span class="ts-theme-name">${c.name}</span><button class="ts-item-btn" type="button">编辑</button><button class="ts-item-btn" type="button">导出</button><button class="ts-item-btn is-danger" type="button">删除</button>`;
      const [btnEdit, btnExportItem, btnDeleteItem] = item.querySelectorAll('button');
      item.addEventListener('click', () => {
        // 点卡片即应用该主题
        selectTheme(c.id);
      });
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        editing = { id: c.id, baseId: full.baseId, name: full.name, override: JSON.parse(JSON.stringify(full.override)) };
        editor.hidden = false;
        fillEditor();
      });
      btnExportItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = exportCustomTheme(c.id);
        if (!r.ok) { showToast(r.error, 'error'); return; }
        const blob = new Blob([r.json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${full.name}.theme.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        showToast('主题已导出');
      });
      btnDeleteItem.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`确定删除自定义主题「${c.name}」吗？`)) return;
        deleteCustomTheme(c.id);
        if (currentThemeId === c.id) {
          localStorage.setItem('md2wx_theme', DEFAULT_THEME_ID);
          currentThemeId = DEFAULT_THEME_ID;
          currentCustomOverride = null;
          selectTheme(DEFAULT_THEME_ID);
        }
        renderLists();
        renderThemeDropdown();
        showToast('已删除');
      });
      customList.appendChild(item);
    }
  }

  btnSave.addEventListener('click', () => {
    if (!editing) return;
    editing.name = nameInput.value.trim() || editing.name;
    const r = saveCustomTheme(editing.id, { baseId: editing.baseId, name: editing.name, override: editing.override });
    if (!r.ok) { showToast(r.error, 'error'); return; }
    showToast('主题已保存');
    if (!editing.id) editing.id = r.id; // 新建后续编辑沿用
    renderLists();
    renderThemeDropdown();
    // 若正在使用该主题则刷新预览
    if (currentThemeId === r.id) selectTheme(r.id);
  });

  btnExport.addEventListener('click', () => {
    if (!editing) return;
    // 未保存的编辑态先落盘再导出
    if (!editing.id) {
      const r = saveCustomTheme(null, { baseId: editing.baseId, name: nameInput.value.trim() || editing.name, override: editing.override });
      if (!r.ok) { showToast(r.error, 'error'); return; }
      editing.id = r.id;
      renderLists();
      renderThemeDropdown();
    }
    const r = exportCustomTheme(editing.id);
    if (!r.ok) { showToast(r.error, 'error'); return; }
    const blob = new Blob([r.json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${editing.name}.theme.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('主题已导出');
  });

  btnDelete.addEventListener('click', () => {
    if (!editing || !editing.id) { showToast('尚未保存的新主题无需删除', 'error'); return; }
    if (!confirm(`确定删除自定义主题「${editing.name}」吗？`)) return;
    deleteCustomTheme(editing.id);
    if (currentThemeId === editing.id) {
      currentThemeId = DEFAULT_THEME_ID;
      currentCustomOverride = null;
      localStorage.setItem('md2wx_theme', DEFAULT_THEME_ID);
      selectTheme(DEFAULT_THEME_ID);
    }
    editing = null;
    editor.hidden = true;
    renderLists();
    renderThemeDropdown();
    showToast('已删除');
  });

  btnClose.addEventListener('click', () => overlay.classList.remove('active'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) overlay.classList.remove('active');
  });

  // 提供给下拉入口调用
  window.__renderThemeStudio = () => {
    renderLists();
    editor.hidden = !editing;
  };

  // 导入：文件选择器
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const r = importCustomTheme(text);
      if (!r.ok) { showToast('导入失败: ' + r.error, 'error'); return; }
      showToast('主题已导入');
      renderLists();
      renderThemeDropdown();
    } catch (e) {
      showToast('导入失败: ' + (e.message || e), 'error');
    }
  });

  // 无入口导入按钮则挂到列表区标题旁：简化——自定义列表空态文案旁不做导入按钮，
  // 在「我的自定义主题」标题行追加一个导入小按钮
  const importBtn = document.createElement('button');
  importBtn.className = 'ts-item-btn';
  importBtn.type = 'button';
  importBtn.textContent = '导入 JSON';
  importBtn.addEventListener('click', () => fileInput.click());
  const customTitle = customList.previousElementSibling; // ts-section-title
  if (customTitle && customTitle.classList.contains('ts-section-title')) {
    customTitle.appendChild(document.createTextNode('　'));
    customTitle.appendChild(importBtn);
  }
}
```

- [ ] **Step 5: init() 挂载**

`init()` 中 `initPublishStudio();` 之后加一行：`initThemeStudio();`

- [ ] **Step 6: 构建验证**

```bash
cd /e/code/opensaas/zcodeapi/gzh/MD2WX/web && npm run build 2>&1 | tail -2
```

Expected: vite build 成功。

- [ ] **Step 7: Commit**

```bash
git -C /e/code/opensaas/zcodeapi/gzh/MD2WX add web/src/app.js && git -C /e/code/opensaas/zcodeapi/gzh/MD2WX commit -m "feat(web): wire theme studio interactions in app.js"
```

---

### Task 4: 浏览器实测 + 触发上线

**Files:** 无新文件。

- [ ] **Step 1: 本地端到端**

```bash
cd /e/code/opensaas/zcodeapi/gzh/MD2WX/cloudflare/md2wx-worker && npx wrangler dev --port 8787
cd /e/code/opensaas/zcodeapi/gzh/MD2WX/web && npm run dev
```

浏览器开 `http://127.0.0.1:3000`：

- [ ] 主题下拉出现「自定义主题…」入口
- [ ] 打开工坊：内置 9 主题列表 + 空自定义列表 + 右侧预览
- [ ] 「复制为自定义」→ 改强调色 → 预览即时变化 → 改字号/字体 → 保存 → toast
- [ ] 下拉出现自定义主题 → 选中 → 正文预览应用自定义样式
- [ ] 刷新页面 → 选中持久（localStorage）
- [ ] 导出 JSON → 删除 → 确认下拉与列表清理 → 导入该 JSON → 还原
- [ ] 发布工坊徽章显示自定义名；推送 payload theme 为 baseId（DevTools network 抽查）
- [ ] Esc / 遮罩 / ✕ 关闭工坊

验证后停 dev 进程树并确认 workerd/vite 退出（`netstat -ano | grep -E ":(8787|3000)"`）。

- [ ] **Step 2: 合并推送触发部署**

```bash
git -C /e/code/opensaas/zcodeapi/gzh/MD2WX checkout main && git -C /e/code/opensaas/zcodeapi/gzh/MD2WX merge feat/theme-studio && git -C /e/code/opensaas/zcodeapi/gzh/MD2WX branch -d feat/theme-studio && git -C /e/code/opensaas/zcodeapi/gzh/MD2WX commit --allow-empty -m "ci: deploy theme studio" && git -C /e/code/opensaas/zcodeapi/gzh/MD2WX -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push myfork main
```

- [ ] **Step 3: 线上验证**

check-run `completed|success` 后：

```bash
curl -s --noproxy '*' https://gzh.9ej.com/api/health
curl -s --noproxy '*' https://gzh.9ej.com/ | grep -c "theme-studio-overlay"
```

Expected: health ok；首页 HTML 含 `theme-studio-overlay`。

---

## 任务依赖与交付物总览

- Task 1 → Task 2 → Task 3 → Task 4 严格顺序（Task 3 依赖 1 的 API 与 2 的 DOM id）。
- 交付：主题工坊弹窗（列表/编辑/实时预览/导入导出）、自定义主题进下拉可选、持久化、纯逻辑层测试。
