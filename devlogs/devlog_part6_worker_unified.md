---
title: MD2WX 一体化 Worker 上线
digest: 整站、转换 API 与草稿推送合并进单个 Cloudflare Worker 部署。
---

# MD2WX 一体化 Worker 上线

## 为什么要合并

在这之前，一套完整的自动发文链路要维护三个部署：Web Studio 托管在 GitHub Pages，转换只在浏览器里跑；草稿箱推送是一个独立的单文件 Worker（worker-deploy.js）；图床代理是另一个 Worker。想用脚本把 Markdown 直接变成公众号草稿，就得自己想办法先拿到转换结果，链路是断的。

这次把前两块合进一个 Worker：`cloudflare/md2wx-worker/`。站点、转换 API、推送 API 是同一个部署单元，`curl` 一条命令就能从 Markdown 直达草稿箱。

## 方案取舍：跨目录直引

转换引擎没有重写。`web/src/core/` 下的 parser、themes、highlighter、cover 四个模块本来就是纯 ESM、无 DOM 依赖（canvas_exporter 和 clipboard 除外，它们不进 Worker），Worker 直接跨目录 `import ../../web/src/core/parser.js`。

考虑过另外两条路：把引擎抽成共享包（架构最干净，但要动 web/ 全部 import 路径，这个仓库还要跟上游合并，diff 太大不值）；把引擎拷贝一份进 Worker 目录（两份副本必然漂移，违背主题单一数据源的原则）。跨目录直引是改动最小的那条路，wrangler 内置的 esbuild 能直接处理跨目录 ESM 和无断言 JSON 导入，web/ 一行没改。

## 从 worker-deploy.js 移植推送逻辑

WeChat 类整体搬了过来，行为契约保持一致（`{code, media_id}` / `{code, msg}`），旧调用方不用改。搬的过程中修了三件事：

1. **token 缓存按 appid 隔离**。原来是一个全局单例缓存，请求体可以穿透带 appid/secret，两个公众号交替调用就会拿到对方的 token。现在缓存键是 appid。
2. **fetch 可注入**。构造函数接受自定义 fetch 实现，测试里通过 `env.__WX_FETCH` 塞进 mock，整条链路（转换 → 换链 → 封面 → draft/add）可以在 Node 里不碰真网跑通。
3. **鉴权 fail-closed**。`DRAFT_API_KEY` 没配置时推送接口直接拒绝，而不是退化成无鉴权开放。

## 测试怎么做的

`themes.js` 用的是 vite 风格的无断言 JSON 导入，Node 原生跑不了。做法是先用 esbuild 把 worker 连同引擎打成单文件 ESM，再交给 `node --test`。Node 24 自带 Request/Response 全局，worker.fetch 可以直接调。目前 16 个用例，覆盖 health、themes、convert（含 sample_article 全 9 主题冒烟）、draft 的鉴权分支和 mock 微信 API 的全链路。

一个测试期间发现的细节：`resolveCover` 会把换链后的 mmbiz 首图下载下来重新传 `add_material` 做永久素材——这是从原实现保留的预期行为（临时素材 URL 不能当 thumb_media_id），mock 里得把这个下载也 stub 掉。

## 配置与遗留

密钥走 `wrangler secret put`：`DRAFT_API_KEY`、`WECHAT_APPID`、`WECHAT_APPSECRET`。Web Studio 设置面板加了推送配置块（Key、端点、可选 appid/secret），端点留空默认本站 `/api/draft`，GitHub Pages 场景手填完整地址。

没有做的：GitHub Actions 自动部署 Worker（手动 `wrangler deploy`，文档写清了）；主题默认封面兜底上传（保持原行为，无封面报错）；Python 端和 r2-imagehost 没动。
