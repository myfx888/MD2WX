# MD2WX 一体化 Worker（整站 + 转换 API + 草稿推送）

单部署单元：Workers Static Assets 托管 Web Studio 整站（`web/dist`），同时提供
Markdown 转换 API 与微信草稿箱推送 API。响应契约与旧版单文件 worker-deploy.js
完全兼容（`{code, media_id}` / `{code, msg}`），部署本 Worker 后旧 Worker 可退役。

## 路由

| 路由 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/health` | GET | 无 | 健康检查 |
| `/api/themes` | GET | 无 | 枚举 9 大内置主题 |
| `/api/convert` | POST | 无（CORS `*`，60 次/分/IP 限流） | `{markdown, theme?}` → `{code:0, html, title, digest, theme}`，title/digest 取自 frontmatter |
| `/api/draft` | POST | `X-API-Key` 头或 `?key=` | 见下 |
| `/api/wx-image` | POST | `X-API-Key` 头或 `?key=` | 本地图片直传公众号素材库（永久素材）：multipart 表单 `file`（PNG/JPG/WebP/GIF，≤10MB），返回 `{code:0, url, media_id}`，url 可直接插入正文。Web Studio 编辑器本地上传在配置推送 API Key 后自动走此通道 |

`/api/draft` 请求体两种形态：

1. markdown 形态：`{markdown, theme?, title?, digest?, cover?, appid?, secret?, author?, ...}`
   —— 服务端先转换，title/digest 缺省取 frontmatter，均无则 400；
2. content 形态：`{content: "<内联样式 HTML>", title, digest, ...}` —— 兼容旧调用方。

处理链路：正文外链图换链 `mmbiz.qpic.cn` → 封面（`cover` 参数 → 正文第一张图）→ `draft/add`。

## 配置

密钥（`wrangler secret put <NAME>` 注入；本地开发复制 `.dev.vars.example` 为 `.dev.vars`）：

- `DRAFT_API_KEY`：推送鉴权 Key。**未配置时 `/api/draft` 直接拒绝（fail-closed）**。
- `WECHAT_APPID` / `WECHAT_APPSECRET`：微信凭证兜底；请求体 `appid`/`secret` 可逐请求覆盖（多公众号）。
- `HUB_ADMIN_PASSWORD`：作品 Hub 管理密码。**未配置时上传/删除直接拒绝（fail-closed）**；依赖 R2 桶 `gzh-hub`（`wrangler r2 bucket create gzh-hub`）。

## 部署

```bash
cd web && npm ci && npm run build
cd ../cloudflare/md2wx-worker && npm ci && npx wrangler deploy
```

本地开发：

```bash
cd cloudflare/md2wx-worker && npm ci && npx wrangler dev   # API 于 127.0.0.1:8787
cd web && npm run dev                                      # vite，/api 已代理到 8787
```

## 调用示例

```bash
# 转换
curl -s https://<worker-domain>/api/convert -H 'content-type: application/json' \
  -d '{"markdown":"---\ntitle: 标题\n---\n\n# 标题\n\n正文", "theme":"tech-blue"}'

# 推送草稿（markdown 形态）
curl -s https://<worker-domain>/api/draft -H 'content-type: application/json' \
  -H 'X-API-Key: <DRAFT_API_KEY>' \
  -d '{"markdown":"---\ntitle: 标题\n---\n\n# 标题\n\n![图](https://cdn.example.com/a.png)\n\n正文"}'

# 推送草稿（content 形态，兼容旧 worker-deploy.js 调用方）
curl -s "https://<worker-domain>/api/draft?key=<DRAFT_API_KEY>" \
  -H 'content-type: application/json' \
  -d '{"title":"标题","content":"<section style=\"...\">...</section>"}'
```

GitHub Pages 场景：在 Web Studio 设置中把"推送端点 URL"填为 Worker 完整地址即可。
