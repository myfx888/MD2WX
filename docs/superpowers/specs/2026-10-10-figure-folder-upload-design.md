# MD2WX 配图文件夹载入 + 批量上传素材库替换 设计文档

日期:2026-10-10
状态:已实现(2026-10-10)
前置:发布工坊已上线(`/api/wx-image` 单图直传素材库契约稳定);`imagehost.js` 微信直传通道已复用推送 Key 配置

## 1. 背景与目标

当前文章里引用本地相对路径的配图(如 `![图](images/01.png)`)在预览里是裂图;`/api/draft` 的 `localizeImages` 只能处理 `http(s)://` 与 `data:`,推草稿前必须先把本地图换成微信 URL。现有单图上传(菜单/粘贴/拖拽)逐张操作,配图多时不可用。

目标:补齐「**本地配图文件夹 → 预览实时显示真图 → 人工检查 → 一键批量上传素材库并回写替换**」的完整链路。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 匹配策略 | 智能匹配:相对路径精确优先,回落文件名唯一匹配,重名冲突标黄人工处理 |
| 检查界面 | 状态条 + 明细浮层(预览画布顶部),非常驻面板、无向导弹窗 |
| 实现架构 | 方案 A:纯前端会话映射,复用现有 `/api/wx-image`,Worker 零改动 |
| 预览注入点 | `renderPreview()` 的 HTML 输出层做显示级替换;编辑器源文本保持相对路径 |
| 替换时机 | 用户显式点「上传素材库并替换」后才写回 textarea,只写成功项 |
| 会话持久化 | 不持久化(blob URL 会话性,刷新失效属预期;重新载入文件夹即可) |

排除的备选:R2 中转(绕远路、积垃圾、已有直传能力不用);Worker 批量端点(内存峰值、进度反馈差,YAGNI)。

## 2. 架构与组件

### 2.1 新模块 `web/src/core/figuremap.js`(纯逻辑,零 DOM,Node 可测)

| 导出函数 | 职责 |
|---|---|
| `collectImageRefs(markdown)` | 扫描图片引用,返回 `[{ raw, path, kind: 'md'\|'html' }]`;跳过 `http(s)://` 与 `data:` 开头的已远程引用。覆盖 Markdown `![alt](path)` / `![alt](path "title")` 与 HTML `<img src="path">` 两种形态 |
| `matchFiles(refs, files)` | 智能匹配。第一轮:归一化相对路径精确匹配(剥 `./` 前缀、`\` 统一为 `/`;大小写敏感,与文件系统实际名一致);第二轮:basename 在文件夹内唯一时命中;同名多于一个 → `conflict`。files 入参为 `[{ path, file }]`(path 为文件夹内相对路径)。输出 `Map<path, { file, matchType: 'exact'\|'filename', status: 'matched'\|'unmatched'\|'conflict', conflicts?: string[] }>` |
| `applyPreviewMap(html, blobUrlMap)` | 显示级替换:html 字符串里匹配路径 → blob URL(入参为文中引用路径 → blob URL 的 Map)。仅用于预览渲染,不触碰编辑器文本 |
| `replaceInMarkdown(markdown, urlMap)` | 源文本替换:urlMap 为 `Map<path, wxUrl>`。带定界符匹配(md: `](path)` / `(path "`,html: `src="path"`)防子串误伤(`01.png` ≠ `101.png`);同一文件多处引用全替换;返回新 markdown 字符串 |

### 2.2 `app.js` 集成(会话态)

- 图片插入菜单新增「载入配图文件夹」按钮 → 触发隐藏 `<input type="file" webkitdirectory multiple>`;
- 现有编辑器拖拽 handler 扩展:识别文件夹项(`webkitGetAsEntry`)递归收集文件,与目录选择器走同一入口;
- 会话对象 `figureSession`(模块内变量,不进 localStorage):
  - `files: Map<relativePath, File>`(文件夹内相对路径)
  - `blobUrls: Map<refPath, blobUrl>`(按文中引用路径建,匹配成功才有)
  - `matchResult`(matchFiles 输出)、`uploadState`(逐张 pending/uploading/done/failed + wxUrl/错误信息)
- `renderPreview()` 在 `previewTarget.innerHTML` 赋值前执行 `currentHtmlOutput = applyPreviewMap(currentHtmlOutput, figureSession)`——编辑器任何改动触发的重渲染自动带上映射,「实时显示」零额外代码路径;
- 上传流程(见 §4)完成后 `replaceInMarkdown` 写回 `textarea.value` 并触发 `scheduleRender()`。

## 3. UI:状态条 + 明细浮层(`preview.css` 新增)

```
┌──────────────────────────────────────────────────────┐
│ 🖼 本地配图 6 · 已匹配 5 · 未匹配 1 · 已上传 0          │
│                        [明细 ▾] [上传素材库并替换]      │
└──────────────────────────────────────────────────────┘
```

- 位置:预览画布顶部浮层(absolute),仅在会话存在时渲染;
- 「明细 ▾」展开浮层列表,每行:缩略图(blob URL)+ 相对路径 + 状态徽章(`精确`绿 / `文件名`蓝 / `未匹配`灰 / `重名冲突`黄 / `失败`红)+ 上传成功后缩略图切微信 URL 并打 ✓;
- 未配置 API Key 时上传按钮置灰,提示文案复用 `IMAGE_HOST_UNCONFIGURED_HINT` 的连接配置指引逻辑;
- 未匹配/冲突项不阻断其他图;冲突行提示「改名或调整目录后重新载入文件夹」。

## 4. 上传与错误处理

- **去重**:同一文件被多处引用只上传一次;
- **顺序上传**(微信接口友好),逐张更新状态条「上传中 3/6…」,按钮 loading 态防重复点击;
- **单张失败**(网络/微信报错):标红记录原因,继续下一张;结束 toast 汇总「成功 5 · 失败 1」,状态条出现「重试失败项」;
- **写回**:全部请求结束后一次性把成功项 `replaceInMarkdown` 写回 textarea;失败项保留原相对路径,重试成功后一并替换;
- **载入预检**:非图片 MIME 与超 10MB 文件载入时剔除并 toast「已跳过 N 个」(阈值与 MIME 清单复用 `imagehost.js` 的 `IMAGE_HOST_ACCEPT` / `IMAGE_HOST_MAX_BYTES`);
- **中断**:页面刷新/关闭时上传终止,已写回的成功项不丢;重新载入文件夹再来一次(会话态即设计意图);
- **重复载入**:再次选择文件夹重置整个会话(文件表、匹配、上传态全量重建)。

## 5. 测试

新增 `cloudflare/md2wx-worker/test/figuremap.test.mjs`(esbuild 打包 `figuremap.js` → Node 内建 test runner,模式同 `publish.test.mjs`):

- `collectImageRefs`:md 语法、HTML img、混合文档、排除远程/data: 引用;
- `matchFiles`:精确命中、文件名唯一回落、重名 conflict、未匹配、`./` 前缀与 `\` 分隔符归一化;
- `replaceInMarkdown`:多处引用全替换、`01.png` vs `101.png` 子串陷阱、`title` 属性保留、无匹配时原文原样返回;
- `applyPreviewMap`:匹配替换、未匹配保留原样。

Worker 侧零改动:既有 7 个测试文件(80 用例)原样通过即为回归门槛;DOM 交互(app.js 侧)以构建通过 + 回归测试兜底。

## 6. 范围边界

- 不做:跨会话 md5 去重缓存、并发上传、上传进度百分比(逐张粒度足够)、文件夹内容变更监听;
- 不改:Worker 任何代码、`/api/wx-image` 契约、现有单图上传/粘贴/拖拽行为;
- 兼容:功能完全增量,无配置迁移;不载入文件夹时 UI 与现状完全一致。
