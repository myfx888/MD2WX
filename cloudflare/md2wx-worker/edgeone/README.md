# EdgeOne Pages 部署

MD2WX Worker 的腾讯 EdgeOne Pages（Makers）适配层。业务逻辑与 Cloudflare Worker
共用同一份 `worker.js`，本目录只处理平台差异。

## 文件

| 文件 | 作用 |
|---|---|
| `entry.js` | EdgeOne 入口：`onRequest(context)` / `fetch(request, env, ctx)` 双形态兼容；把 `env.HUB` 包一层 KV 适配 |
| `../edgeone-kv.js` | EdgeOne KV → hub-store 所需 R2 接口适配（key hex 编码、delimiter 内存模拟、R2 形态自动直通） |
| `../../../scripts/edgeone-build.mjs` | 构建脚本：vite 构建静态站 + esbuild 单文件打包函数 |
| `../../../edgeone.json` | EdgeOne 项目配置：构建命令、输出目录、全站缓存头 |

## 与 Cloudflare Worker 的差异

| 能力 | Cloudflare | EdgeOne |
|---|---|---|
| 托管形态 | Workers + Static Assets（`wrangler.toml`） | edgeone-dist 静态 + 仓库根 `edge-functions/[[default]].js` catch-all（静态资源优先） |
| Hub 存储 | R2 桶 `gzh-hub` | EdgeOne KV 命名空间（控制台绑定变量名 **`HUB`**） |
| 限流 | Ratelimits 绑定（60 次/分 等） | 无对应绑定，代码自动直通 → **限流不生效**（如需可在 EdgeOne 控制台配 WAF/限频） |
| 客户端 IP | `cf-connecting-ip` | 无对应 header 读取（仅影响限流 key） |
| 缓存 | 静态走 `web/public/_headers`；函数响应自带 Cache-Control | 静态走 `edgeone.json` headers；函数响应同 Cloudflare |

EdgeOne 平台硬限制（官方文档 pages.edgeone.ai/zh/document/kv-storage 与 edge-functions）：

- KV 值上限 **25MB**、key 仅允许数字/字母/下划线 → 适配层用 hex 编码 Hub 键，
  原始键 UTF-8 需 ≤ 256 字节（常规文章路径远低于此）；超大文件请用 Cloudflare 部署。
- 边缘函数请求体上限以官方文档为准（文档标注 1MB 量级）→ **Hub 大文件上传
  （95MB）与 10MB 图片直传在 EdgeOne 上可能不可用或受限**，相关 API 会返回平台错误。
- 单函数代码包 ≤ 5MB（本打包产物约 415KB，余量充足）。

## 部署步骤

1. 仓库推到 Git 托管（GitHub/GitLab 均可），EdgeOne Pages 控制台「创建项目 → 导入 Git 仓库」，
   仓库根即 MD2WX/，`edgeone.json` 会被自动识别（构建命令 `node scripts/edgeone-build.mjs`，
   输出目录 `edgeone-dist`）。
2. KV 存储：创建命名空间（建议名 `gzh-hub`），在项目详情 → KV 存储 → 绑定，
   **变量名填 `HUB`**（与 worker.js 里的 `env.HUB` 对应）。
3. 环境变量（项目设置 → 环境变量）：
   - `DRAFT_API_KEY` 推送鉴权 Key（未配置则 `/api/draft` 拒绝，fail-closed）
   - `WECHAT_APPID` / `WECHAT_APPSECRET` 微信凭证兜底（请求体可逐请求覆盖）
   - `HUB_ADMIN_PASSWORD` Hub 管理密码（未配置则上传/删除拒绝，fail-closed）
4. 部署后验证：
   ```bash
   curl https://<edgeone-domain>/api/health          # {"ok":true,"service":"md2wx-worker"}
   curl -I https://<edgeone-domain>/assets/main-*.js # Cache-Control: public, max-age=86400
   ```
5. 本地构建产物（不上 Git，平台构建时自动生成）：
   ```bash
   node scripts/edgeone-build.mjs   # 产物: edge-functions/[[default]].js + edgeone-dist/
   ```

## 全站缓存上限 1 天

- 静态资产：`edgeone.json` headers → `/*` 为 `public, max-age=86400`；
  `/index.html`、`/hub.html` 覆盖为 300 秒（部署后 5 分钟内全量生效，仍 ≤ 1 天上限）。
- 函数响应：`/api/*` 一律 `no-store`；`/hub/*` 预览 HTML 300 秒、其余资产 1 天
  （worker.js `SITE_CACHE_MAX_AGE = 86400` 收口）。
