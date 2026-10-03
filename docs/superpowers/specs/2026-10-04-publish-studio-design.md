# MD2WX 发布工坊（Publish Studio）设计文档

日期：2026-10-04
状态：已经用户确认
前置：2026-10-02 CF Worker 一体化部署已上线（https://gzh.9ej.com），`/api/draft` 契约稳定

## 1. 背景与目标

当前推送相关 UI 是两个割裂的块：

- 顶部按钮「推送草稿箱」，无配置状态提示，点击后才知道是否可用；
- 「公众号推送」的 4 个配置项（Key/端点/AppID/Secret）塞在「排版与联动偏好」设置面板最底部，语义错位、不易发现；
- 推送前看不到将推送的标题/摘要/封面；结果只有一闪而过的 toast。

目标：仿照 Cover Studio 的模式，做一个**发布工坊弹窗**，统一「配置 + 预览 + 推送 + 结果」全流程；设置面板回归纯排版偏好。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 形态 | 发布工坊弹窗（独立模态，非设置分页、非轻量微调） |
| 布局 | 上下两段式：预览区在上（配置默认折叠），非左右栏、非向导 |
| 标题/摘要 | 可编辑：默认填 frontmatter 提取值，留空则推送时服务端提取 |
| 封面 | 封面工坊联动（勾选后 canvas 导出 dataURL 作 `cover` 参数）+ 正文首图回落 |
| 推送历史 | 本地最近 5 条（localStorage），含成功/失败与错误信息 |

## 2. 入口与旧元素处理

- 顶部按钮「推送草稿箱」改名「发布」（`send` 图标保留），点击打开发布工坊弹窗；
- 设置面板中「公众号推送」配置块整体删除（`settings-divider` + `settings-header` + 3 个 `settings-item`）；
- localStorage 键 `md2wx_push_api_key` / `md2wx_push_endpoint` / `md2wx_push_appid` / `md2wx_push_secret` 原样沿用，无迁移成本；
- 新增历史键 `md2wx_push_history`（JSON 数组）与联动记忆键 `md2wx_push_use_cover`（"1"/"0"）。

## 3. 弹窗结构

复用 `cover-modal-overlay` 的遮罩 + 居中模式，宽约 560px。自上而下：

1. **头部**：「发布工坊」标题 + ✕ 关闭（Esc 与点遮罩同关闭）；
2. **预览区**：
   - 左：封面缩略（2.35:1 比例容器，圆角边框）；
   - 右：标题输入框（`#publish-title`）、摘要输入框（`#publish-digest`，带字数提示）、主题徽章 + 正文字数；
   - 封面来源状态行（`#publish-cover-status`）：「封面工坊 ✓」/「正文首图 ✓」/「⚠ 无封面——微信将拒绝推送」，勾选联动时缩略图切换为工坊封面；
   - 勾选框「使用封面工坊的封面」（`#publish-use-cover`）：仅当 Cover Studio 存在当前封面元数据时可用；
3. **连接状态行**：「已配置 API Key ✓」/「未配置——展开下方连接配置」（有 Key 且端点合法时为绿色）；
4. **推送按钮**：`#btn-publish-push`，primary 全宽大按钮，文案随状态变化（推送草稿箱 → 推送中… → 已推送 ✓）；
5. **折叠区「连接配置」**（默认折叠）：API Key、端点 URL、AppID/Secret 四输入 + 推送历史列表（时间 + 标题 + ✓/✗ + 失败原因截断）。

## 4. 交互流与数据

### 打开弹窗时

- 用与 `renderPreview` 相同的提取逻辑（frontmatter `title/digest` → 正文 H1 → 首行文字回退）填入标题/摘要输入框；每次打开都重新提取覆盖（编辑值不跨会话保留，以打开时刻的文章为准）；
- 正则检测正文首图（`![...](url)` 与 `<img src>`，排除 data: URI 之外的全部算有图）；
- 恢复 `md2wx_push_use_cover` 勾选状态；主题徽章取 `currentThemeId` 对应主题名；字数复用 `updateWordCount` 的统计。

### 点击推送

- 前置校验：Key 已配置、标题非空（为空禁用按钮）；
- 按钮进入 loading（禁用 + 「推送中…」）；
- `POST /api/draft`（端点默认同源 `/api/draft`）：`{ markdown, theme, title?, digest?, cover?, appid?, secret? }`——title/digest 仅在用户改动过（非空且 ≠ 提取值）时携带；cover 仅在勾选工坊联动时携带（`domToPngBlob` 导出 Blob 后经 `FileReader.readAsDataURL` 转 dataURL）；
- 成功（`code:0`）：按钮「已推送 ✓」1.8s 恢复 + toast「草稿推送成功」+ 写入历史；
- 失败：toast 错误信息（含服务端 `msg`）+ 失败项入历史（错误信息截断 80 字）；
- 历史写入：`unshift` 后截断 5 条，持久化 `md2wx_push_history`。

## 5. 代码组织

| 文件 | 改动 |
|---|---|
| `web/src/core/publish.js`（新增） | 纯逻辑层：`extractPublishMeta`（标题/摘要/首图提取）、`buildPublishPayload`（payload 组装，含 cover 分支）、`readPushHistory` / `recordPush`（历史读写与截断）、连接状态判定。无 DOM 依赖，Node 可测 |
| `web/src/app.js` | 新增 `initPublishStudio()`（仿 `initCoverStudio`：开关、提取填充、推送调用、历史渲染）；删除 `handlePushDraft` / `initPushSettings`；`init()` 挂载 |
| `web/index.html` | 弹窗 markup（遮罩 + 上述结构）；顶部按钮改名「发布」；设置面板删「公众号推送」块 |
| `web/src/styles/main.css` | 弹窗样式：复用 `settings-input` 输入样式与 cover-modal 遮罩变量；封面缩略容器、状态行、历史列表样式 |
| `web/src/assets/icons.js` | 复用现有 `send` / `x` / `check` 图标，不新增 |

Worker（`cloudflare/md2wx-worker/`）与 Python 端**零改动**——现有 `/api/draft` 契约已覆盖全部需求（title/digest 覆盖、cover dataURL、凭证穿透均为既有字段）。

## 6. 测试策略

- `publish.test.mjs`（esbuild 打包 + `node --test`，复用 worker 测试基建）：
  - `extractPublishMeta`：frontmatter 优先 / H1 回退 / 首行回退 / 首图检测（md 图片、HTML img、无图三种）；
  - `buildPublishPayload`：默认形态 / title 覆盖形态 / cover 勾选形态 / 凭证穿透形态；
  - `recordPush`：成功项、失败项、截断至 5 条、持久化往返；
- `vite build` 必须通过（仓库硬性要求）；
- 手工清单：弹窗开/关（按钮、✕、Esc、点遮罩）、改标题后推送、工坊联动勾选后封面缩略切换、无封面警示文案、历史展示与持久化、未配置 Key 时连接状态行与折叠区引导。

## 7. 非目标（YAGNI）

- 不做多公众号配置档案管理（保持单组凭证 + 请求级覆盖）；
- 不做推送记录云端同步（仅 localStorage）；
- 不做定时/队列推送；
- 不改 Worker API 与 Python 端；
- 不做推送中图文二次编辑（正文回编辑器改）。
