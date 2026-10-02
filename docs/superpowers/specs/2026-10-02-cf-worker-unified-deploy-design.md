# MD2WX 整站 + API 一体化 Cloudflare Worker 设计文档

日期：2026-10-02
状态：已经用户确认

## 1. 背景与目标

MD2WX 当前的部署形态是分散的三块：

- Web Studio（`web/`）部署在 GitHub Pages，转换在浏览器端完成；
- 图床代理（`cloudflare/r2-imagehost/`）是独立 Worker；
- 微信草稿箱推送能力在外部单文件 Worker（worker-deploy.js，独立部署）。

目标：**用一个 Cloudflare Worker 承载整站 + 转换 API + 草稿推送 API**，形成单部署单元，同时保持与既有推送 Worker 的契约兼容，已有调用方零成本切换。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| Worker 形态 | 转换 + 草稿推送一体，整站由同一 Worker 托管 |
| 微信凭证 | Worker 环境变量兜底 + 请求体可穿透覆盖（多公众号） |
| API 鉴权 | 仅 `/api/draft` 需要 API Key；`/api/convert` 公开开放 |
| 代码组织 | 方案 A：Worker 跨目录直引 `web/src/core/` 引擎，`web/` 引擎代码零改动 |
| UI 集成 | Web Studio 新增"推送草稿箱"按钮与凭证配置 |
| GitHub Pages | 保留现有 deploy.yml 双轨运行，不作删除 |

## 2. 架构总览

```
浏览器 ─┬─ 静态资源（html/js/css）→ Workers Static Assets（平台直出，不消耗 Worker CPU）
        ├─ POST /api/convert  → 转换引擎（跨目录 import web/src/core 四模块）
        └─ POST /api/draft    → 转换 → 图片换链 → 封面解析 → 微信草稿箱
外部自动化（curl/脚本）────── 同上两个 API，响应契约与 worker-deploy.js 兼容
```

关键事实：`web/src/core/` 的转换引擎四模块（`parser.js`、`themes.js`、`highlighter.js`、`cover.js`）为纯 ESM 且无 DOM/window 依赖（静态扫描确认），主题 JSON 直接从 `md2wx/themes/` 导入（单一数据源）。`canvas_exporter.js` 与 `clipboard.js` 依赖浏览器 API，仅存在于客户端 bundle，不进入 Worker。

## 3. 目录结构

```
cloudflare/md2wx-worker/
├── worker.js                # 入口：路由 + WeChat 推送类（自 worker-deploy.js 移植）+ 引擎调用
├── wrangler.toml            # [assets] + run_worker_first + 限流 + secrets 说明
├── test/
│   └── engine.test.mjs      # 引擎与 API 契约冒烟测试
├── package.json             # wrangler devDependency（esbuild 为其传递依赖）
└── README.md                # 部署与配置文档
```

Worker 通过相对路径跨目录导入引擎：

```js
import { markdownToWechatHtml, parseFrontmatter } from "../../web/src/core/parser.js";
import { BUILTIN_THEMES, DEFAULT_THEME_ID, getTheme } from "../../web/src/core/themes.js";
```

wrangler 内置 esbuild 打包器可处理跨目录 ESM 与无断言 JSON 导入，无需任何构建胶水。

## 4. API 契约

| 路由 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/health` | GET | 无 | 健康检查 `{ok, service}` |
| `/api/themes` | GET | 无 | 返回 9 大主题 `{id, name}` 列表 |
| `/api/convert` | POST | 无（CORS `*`，宽松限流） | 见下 |
| `/api/draft` | POST | `X-API-Key` 头或 `?key=` 查询参数 | 见下 |

### POST /api/convert

请求体：`{ "markdown": "...", "theme": "tech-blue" }`（theme 缺省用 `DEFAULT_THEME_ID`）。

响应：

```json
{ "code": 0, "html": "...内联样式 HTML...", "title": "从 frontmatter 提取", "digest": "同左", "theme": "tech-blue" }
```

失败：`{ "code": 1, "msg": "..." }`，HTTP 400/500。

### POST /api/draft

请求体两种形态：

1. **markdown 形态**：`{ "markdown": "...", "theme": "...", "title": "?", "digest": "?", "cover": "?", "appid": "?", "secret": "?", "author": "?", ... }` —— 服务端先走转换引擎，title/digest 缺省时从 frontmatter 提取；
2. **HTML 形态**：`{ "content": "<已有内联样式 HTML>", ... }` —— 与 worker-deploy.js 现有调用方式完全兼容。

处理链路（移植自 worker-deploy.js，行为保持一致）：

1. 凭证解析：请求体 `appid/secret` 优先，否则 env `WECHAT_APPID` / `WECHAT_APPSECRET`，二者皆无则 400；
2. `localizeImages`：正文外链图经 `media/uploadimg` 换链为 `mmbiz.qpic.cn`，data URI 与 http(s) 均支持；
3. `resolveCover`：`cover` 参数（URL/data URI）→ 正文第一张图 → 都无则 400；
4. `draft/add` 推送草稿。

响应与 worker-deploy.js 完全兼容：`{ "code": 0, "media_id": "..." }` / `{ "code": 1, "msg": "..." }`。部署本 Worker 后旧 worker-deploy.js 可退役。

### 通用行为

- OPTIONS 预检：照搬 `r2-imagehost` 的 CORS 处理模式；
- `/api/convert` 挂 wrangler `[[ratelimits]]`（宽松阈值，防滥用）；
- 未匹配路由返回 404 JSON。

## 5. Web Studio UI 集成

改动文件：`web/src/app.js`（及少量样式），引擎文件不动。

- 设置区新增"公众号推送"配置块：
  - API Key（密码输入框，localStorage 持久化）；
  - 可选 appid / secret（穿透场景）；
  - 可选自定义端点 URL（默认同源 `/api/draft`；GitHub Pages 场景手填 Worker 完整 URL）；
- 操作区新增"推送草稿箱"按钮：取当前 markdown + 所选主题 + frontmatter 标题/摘要 → `POST /api/draft`；成功/失败复用现有提示通道；
- `web/vite.config.js` 增加一行 dev proxy（`/api` → `http://127.0.0.1:8787`），支持本地前后端联动。

UI 未配置 Key 时不推送、按钮给出提示；站点其余行为与现状完全一致。

## 6. 兼容性修正清单

静态扫描已确认四引擎模块无 DOM/window 引用，预期修正点：

1. **JSON 导入语法差异**：`themes.js` 使用无断言 `import x from '*.json'`（vite 语法）。esbuild 打包（wrangler 部署）无需断言，可正常工作；但 Node 原生运行测试需要 `with { type: 'json' }` 断言。对策：测试采用 **esbuild 先 bundle、再 `node --test` 断言**，esbuild 作为 wrangler 的传递依赖，不新增重依赖；
2. 实现过程中发现的任何隐藏浏览器 API 引用：就地修复并记录到实现说明；
3. 跨包相对路径导入在 wrangler 打包下的可用性验证（`web/src` → `md2wx/themes` 三层向上导入）。

## 7. 配置与部署

### wrangler.toml 要点

- `name = "md2wx-worker"`，`main = "worker.js"`，`compatibility_date` 取当前稳定日期；
- `[assets]`：`directory = "../../web/dist"`（相对 wrangler.toml），`binding = "ASSETS"`，`run_worker_first = ["/api/*"]` 保证 API 路由优先于静态资源；
  - 风险预案：若 wrangler 对父级相对 assets 路径报错，则在 worker 的 package.json 增加一个 `predeploy` 脚本把 `web/dist` 拷贝到 worker 目录内的 `assets/`（保持 API 不变，仅多一步复制）；
- secrets（`wrangler secret put` 配置，均可选）：`DRAFT_API_KEY`、`WECHAT_APPID`、`WECHAT_APPSECRET`；未配置 Key 时 `/api/draft` 拒绝推送（禁止无鉴权裸奔）。

### 部署流程

```bash
cd web && npm ci && npm run build
cd ../cloudflare/md2wx-worker && npm ci && npx wrangler deploy
```

本地开发：先 `vite build`（或 `vite dev` + proxy），再 `npx wrangler dev`。

### 文档

- `cloudflare/md2wx-worker/README.md`：配置、secrets、部署、API 调用示例（curl）；
- 仓库根 README 不大改，仅在部署章节补一行指向 Worker 部署文档。

## 8. 测试策略

- `test/engine.test.mjs`（esbuild bundle 后 `node --test`）：
  - `sample_article.md` 全 9 主题转换冒烟：产物含内联样式标记、frontmatter title/digest 提取正确；
  - convert 请求体校验与错误分支；
  - draft 请求的形态归一化逻辑（markdown 形态 → HTML 形态）纯函数断言（不发真实网络请求，WeChat 类以注入 mock 的方式测试）；
- UI 冒烟：`vite build` 成功 + 手工验证清单（推送按钮、Key 持久化、错误提示）；
- Python 端测试不涉及、不改动。

## 9. 非目标（YAGNI）

- 不做 GitHub Actions 自动部署 Worker（手动 `wrangler deploy`，文档写清流程）；
- 不做主题默认封面兜底上传（保持 worker-deploy.js 行为：无封面则报错）；
- 不改动 Python CLI 端与 `cloudflare/r2-imagehost/`；
- 不删除 GitHub Pages 工作流（双轨保留）；
- 不引入 React/Vue 等框架或测试框架（延续仓库零重型依赖哲学）。
