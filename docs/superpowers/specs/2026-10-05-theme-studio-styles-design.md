# MD2WX 主题工坊二期（组件样式编辑）设计文档

日期：2026-10-05
状态：已经用户确认（面板组织未答复，按推荐的标签页方案执行）
前置：主题工坊一期已上线（2026-10-05，`customThemes.js` 差异覆盖 + 9 色/排版编辑）

## 1. 背景与目标

一期主题工坊只开放了 `colors`（9 色）与 `typography`（字号/行距/字间距/字体栈）的编辑；主题 JSON 的第三块 **`styles`（9 大组件的视觉骨架变体）**未开放。用户要求"这些部分都需要能编辑和统一"。

目标：在主题工坊编辑面板中新增**组件样式编辑**——9 个组件各一个变体下拉（引擎内建枚举），改动即时进实时预览；存储格式向后兼容扩展。

## 2. 引擎变体枚举（从 parser.js 逐函数核对，非猜测）

渲染函数按 `theme.styles.<key>`（兼容 `theme.<key>_style`）读取变体；未匹配变体自动走各函数的默认分支。以下为 `web/src/core/parser.js` 实际支持的分支枚举（按行区间提取核对，2026-10-05）：

| 组件 key | 默认变体 | 可选变体（parser 实际分支） |
|---|---|---|
| container | clean | paper / dark / card / memo / brutalist |
| h1 | underline | double_line / capsule / terminal / brutalist |
| h2 | left_bar | bottom_line / pill_badge / bubble_bg / serif_badge / terminal_prompt / brutalist_box |
| h3 | diamond | circle_badge / highlight_bg / slash |
| quote | left_stripe | elegant_quote / bubble_card / paper_memo / terminal_box / brutalist |
| code | mac_dark | terminal / clean_flat |
| table | zebra | three_line / grid |
| list | bullet | diamond / square / arrow |
| hr | line | gradient / asterisk / terminal_dash |

**重要**：默认变体（clean/underline/left_bar/diamond/left_stripe/mac_dark/zebra/bullet/line）在 parser 中是**兜底分支而非 `style === 'x'` 枚举分支**，不在上表"可选变体"列中，但下拉必须包含它们（否则选不回默认）。下拉选项 = 默认变体 + 上表可选变体。

**未知值容错**：选任何值都不会崩——parser 匹配不到就走默认分支。校验层（import）仍按白名单拒绝非法值，避免用户导出的 JSON 混入无意义配置。

## 3. 数据模型扩展

- `customThemes.js` 的 `OVERRIDE_KEYS` 从 `['colors', 'typography']` 扩展为 `['colors', 'typography', 'styles']`（`styles` 值必须为对象，各键值须在 `CUSTOM_STYLES` 白名单内或为默认变体）。
- 存储结构不变（差异覆盖），已存的 `custom-*` 主题（无 `styles` 键）完全兼容。
- 导出 JSON `{version:1, baseId, name, override{colors?, typography?, styles?}}` 自动含 styles；旧格式文件导入不受影响。

## 4. 新增常量清单（`customThemes.js` 导出）

`CUSTOM_STYLES = [{key, label, variants:[{id, label}]}...]`，9 项，精确对应第 2 节枚举：

- container 容器：clean 极简白 / paper 牛皮纸微框 / dark 曜石纯黑 / card 悬浮卡片 / memo 日系便签 / brutalist 新野兽派
- h1 一级标题：underline 下划粗线 / double_line 古典双线 / capsule 胶囊药丸 / terminal 终端命令行 / brutalist 黑框硬投影
- h2 二级标题：left_bar 左侧竖条 / bottom_line 底部细线 / pill_badge 药丸徽章 / bubble_bg 气泡底色 / serif_badge 衬线徽章 / terminal_prompt 终端提示符 / brutalist_box 硬框投影
- h3 三级标题：diamond 菱形 / circle_badge 圆形徽章 / highlight_bg 高亮底色 / slash 斜杠
- quote 引用：left_stripe 左侧条纹 / elegant_quote 优雅引号 / bubble_card 气泡卡片 / paper_memo 便签纸 / terminal_box 终端框 / brutalist 硬边框
- code 代码块：mac_dark 苹果暗色 / terminal 终端 / clean_flat 极简平
- table 表格：zebra 斑马纹 / three_line 学术三线表 / grid 全网格
- list 列表：bullet 圆点 / diamond 菱形 / square 方点 / arrow 箭头
- hr 分割线：line 细线 / gradient 渐变线 / asterisk 星号 / terminal_dash 虚线终端

## 5. UI：编辑面板标签页化

- 编辑面板（`#ts-editor`）顶部加标签页：「颜色」「排版」「组件样式」；面板宽度不变（工坊弹窗已是三列 240+250+1fr，styles 用下拉不占宽）。
- 「组件样式」tab：9 行组件 × `<select>`（选项 = 默认 + 变体，label 中文）；改动走既有 `applyLocal(key, 'styles', value)` 管道，预览即时刷新。
- `fillEditor` 回填：styles 各下拉当前值 = `override.styles?.[key] || baseTheme.styles?.[key] || 默认变体`。
- 一期布局其余不动（列表区、预览区、操作按钮）。

## 6. 改动面

| 文件 | 改动 |
|---|---|
| `web/src/core/customThemes.js` | `OVERRIDE_KEYS` 加 `'styles'`；新增 `CUSTOM_STYLES` 导出；`validOverride` 校验 styles 白名单 |
| `web/src/app.js` | `initThemeStudio`：标签页切换逻辑 + styles 下拉渲染/回填（`fillEditor`）；`applyLocal` 已支持任意 group 无需改 |
| `web/src/styles/main.css` | 标签页样式（`.ts-tab-*`） |
| 测试 `customThemes.test.mjs` | styles 键合法值通过、非法变体值拒绝、含 styles 的导出导入回环 |
| 引擎 / Worker / Python | **零改动** |

## 7. 测试策略

- 单测（挂现有 esbuild + node --test 基建）：
  - `saveCustomTheme` 接受合法 `{styles:{h1:'capsule'}}`；拒绝 `{styles:{h1:'not-a-variant'}}`；拒绝 `{styles:[...]}`（数组）；
  - `importCustomTheme` 对含 styles 的 v1 JSON 回环；旧格式（无 styles）导入仍通过；
  - `CUSTOM_STYLES` 9 项且每项 variants 含默认变体 id。
- `vite build` 必须通过；
- 浏览器实测：切到组件样式 tab → 改 h1 为胶囊 → 预览一级标题变胶囊 → 保存 → 下拉选中该自定义主题 → 正文预览应用 → 导出 JSON 含 styles 字段。

## 8. 非目标（YAGNI）

- 不做变体的子参数微调（边框粗细、圆角大小等）——变体是引擎内建枚举，粒度到此；
- 不做自定义新变体、不做变体缩略图选择器（下拉文本够用，预览区承担可视化）；
- 不改引擎渲染逻辑、Python 端、Worker。
