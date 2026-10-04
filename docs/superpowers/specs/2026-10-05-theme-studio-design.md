# MD2WX 主题工坊（Theme Studio）设计文档

日期：2026-10-05
状态：已经用户确认
前置：发布工坊已上线（2026-10-04）；主题引擎 `web/src/core/themes.js` 的 `deepMerge` / `getTheme(themeId, customOverride)` 为现成合并管道

## 1. 背景与目标

当前 9 大主题是构建期固定的 JSON（`md2wx/themes/*.json`，与 Python CLI 单一数据源），用户只能切换、不能个性化。目标：提供**可视化微调**能力——在任一内置主题基础上改颜色与排版参数，实时预览，保存后在主题下拉可选，支持导出/导入 JSON 分享。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 编辑粒度 | 可视化微调：9 个颜色 + 排版参数（字号/行距/字间距/字体栈），不做 JSON 高级编辑 |
| 存储 | localStorage 本地存储 + 导出/导入 JSON 文件；不做云端同步 |
| 形态 | 主题工坊弹窗（复用封面/发布工坊的遮罩弹窗模式） |
| 代码组织 | 方案 A：差异覆盖（`{baseId, override}`）+ 独立纯逻辑模块；运行时不注入 `BUILTIN_THEMES`、不存完整快照 |

## 2. 数据模型与纯逻辑层

新增 `web/src/core/customThemes.js`（无 DOM，store 可注入，Node 可测）：

- localStorage 键：`md2wx_custom_themes`（单键 JSON 对象）。
- 存储结构：
  ```json
  {
    "custom-a1b2c3": { "baseId": "tech-blue", "name": "我的科技蓝", "override": { "colors": { "accent": "#ff0000" }, "typography": { "font_size_base": "16px" } } }
  }
  ```
- id 规则：`custom-` + 6 位随机字母数字；仅覆盖用户实际修改的字段。
- API（确切签名）：
  - `listCustomThemes(store?) -> [{id, baseId, name}]`
  - `getCustomTheme(id, store?) -> {baseId, name, override} | null`
  - `saveCustomTheme(idOrNull, {baseId, name, override}, store?) -> {ok, id, error?}`（id 为 null 时生成新 id；校验 baseId 必须在 `BUILTIN_THEMES`、name 非空；重名允许——id 唯一即可，同名主题在列表中并列）
  - `deleteCustomTheme(id, store?) -> boolean`
  - `exportCustomTheme(id, store?) -> {ok, json} | {ok:false, error}`（导出 `{version:1, baseId, name, override}`）
  - `importCustomTheme(jsonStr, store?) -> {ok, id} | {ok:false, error}`（校验：JSON 可解析、`baseId` 在 `BUILTIN_THEMES`、`override` 仅含 `colors`/`typography` 两键且值为对象、name 非空去重——重名自动加「导入」后缀）
  - `CUSTOM_COLORS -> [{key, label}]` 九色清单：accent 强调色 / accent_bg 强调底色 / text_color 正文 / sub_color 次级 / border_color 边框 / code_bg 代码底 / code_text 代码字 / quote_bg 引言底 / page_bg 页面底
- 渲染管道（零引擎改动）：`markdownToWechatHtml(md, baseId, override)`；`isDarkTheme(getTheme(baseId, override))` 判暗色。

## 3. 主题工坊弹窗

复用 `cover-modal-overlay` 遮罩模式；**双类复合选择器覆盖** cover-modal 的两列 Grid 与 90vh 窗体（沿用发布工坊已验证的 `.theme-studio-window` / `.theme-studio-body` 覆盖法）。

### 入口

主题下拉菜单（`#theme-dropdown-menu`）底部新增分组「自定义主题」：列出已存自定义主题（点击即选中）+ 固定项「⚙ 自定义主题…」（调色板图标，打开工坊弹窗）。现有纯 SVG 图标规范不变（用 `palette` 图标）。

### 弹窗布局（上下两段，宽 ~720px）

1. **主题列表区**（上半）：两行网格——内置 9 主题卡片（色板圆点 + 名称 + 「复制为自定义」按钮）；自定义主题卡片（色板圆点 + 名称 + 编辑/导出/删除三个小按钮）。
2. **编辑面板**（下半，选中自定义主题后展开；点内置卡片的「复制为自定义」时以该主题为底新建并展开）：
   - **颜色组**：`CUSTOM_COLORS` 九个 `<input type="color">` 色板 + hex 文本框并排；
   - **排版组**：正文字号 range 滑块（14–17.5，步长 0.5，显示当前值）、行距 range 滑块（1.6–2.1，步长 0.05）、字体栈 select（系统默认 `-apple-system…` / 衬线 `Georgia, 'Times New Roman', serif` / 等宽 `ui-monospace, Menlo, monospace`）；
   - **名称输入 + 操作行**：重命名、保存、导出 JSON（触发下载 `<name>.theme.json`）、删除（`confirm` 确认后删并清选中）。
3. **实时预览**（右侧列，编辑面板改动即时刷新）：`markdownToWechatHtml(PREVIEW_SAMPLE, baseId, override)` 渲染到仿真容器（复用 `.publish-cover-scaled` 同款等比缩放思路或直接流式容器）；`PREVIEW_SAMPLE` 为内置 ~200 字样例（H1/H2/引用/粗体/代码块/表格各一）。

### 关键交互

- 改任一色板/滑块 → override 更新 → 预览即时刷新（未保存状态标记 `●` 提示）；
- 保存 → 写入 localStorage → 上半列表刷新 → toast「已保存」；
- 「复制为自定义」→ 以该内置主题为 baseId 新建（override 初始为空），直接进入编辑；
- 删除自定义主题 → 若当前 `md2wx_theme` 正是该 id，回退 `DEFAULT_THEME_ID`。

## 4. app.js 接线

- `renderThemeDropdown()`：追加自定义主题分组 + 工坊入口项；
- `selectTheme(themeId)`：识别 `custom-` 前缀——`getCustomTheme(id)` 取 `{baseId, override}` 存入模块级 `currentCustomOverride`；非 custom 置 null；
- `renderPreview()`：`markdownToWechatHtml(body, themeId, currentCustomOverride, {...})`——themeId 对 custom 传 baseId；
- `adaptPhoneTheme()` / `isDarkTheme`：用 `getTheme(effectiveId, currentCustomOverride)` 合并结果判断；
- `updateWordCount` 等其余链路无感；发布工坊/封面工坊的主题徽章显示 `getCustomTheme` 的 name；
- 推送 payload：`theme` 字段传 **baseId**（Worker `resolveThemeId` 不识别 custom id，且正文在前端已按 override 渲染完成，服务端不需要差异）。

## 5. 样式

仅 `web/src/styles/main.css` 追加：`.theme-studio-*` 系列（双类覆盖规则、列表卡片、色板行、滑块行、预览容器），复用 `settings-input` / `cover-modal-*` / `publish-*` 既有类与变量。

## 6. 测试策略

- `cloudflare/md2wx-worker/test/customThemes.test.mjs`（挂入现有 esbuild + node --test 基建，`build:test` 追加一条 esbuild 命令）：
  - save/list/get/delete 往返；新 id 生成格式（custom- 前缀）；重名允许、baseId 缺失拒绝；
  - 合并语义：`getTheme(baseId, override)` 产物断言（改 accent 后其余字段仍为基础主题值）；
  - export/import 回环；import 拒绝坏 JSON、未知 baseId、非法 override 键（如 `styles`）；导入重名自动加「导入」后缀；
  - store 注入隔离（不污染真实 localStorage）。
- `vite build` 必须通过；
- 浏览器自动化实测清单：下拉出现自定义分组 → 复制内置为自定义 → 改强调色预览变化 → 保存 → 下拉选中生效 → 刷新页面持久 → 导出 JSON → 删除 → 导入回环 → 推送弹窗主题徽章正确。

## 7. 非目标（YAGNI）

- 不做组件样式变体编辑（h1/quote/code/container 等枚举切换）——属「可视化+JSON 高级」档；
- 不做云端同步、主题分享链接；
- 不改 Python 端、Worker API、`BUILTIN_THEMES` 常量与 `md2wx/themes/*.json`；
- 不做自定义主题的封面预设（封面工坊仍按 baseId 出图）。
