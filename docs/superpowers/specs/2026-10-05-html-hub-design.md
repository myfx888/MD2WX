# 作品 Hub（HTMLhub 功能整合）设计文档

日期：2026-10-05
状态：已与用户逐节确认
上游参考：[zaneven/HTMLhub](https://github.com/zaneven/HTMLhub)（同一上游作者的作品聚合托管工坊）

## 1. 目标与范围

把 HTMLhub 的核心能力并入现有 gzh.9ej.com（MD2WX Worker 站点）：

- **托管对象**：单文件 HTML 报告 + 多文件站点（拖拽整文件夹，保留 css/js/图片相对路径），按「分类/项目」两级组织
- **权限**：任何人可浏览与预览；上传/删除/管理需管理员密码（公开浏览 + 密码管理）
- **沉浸式预览工作台**：视口预设（铺满 / 1440×900 / 1920×1080 / 375×812）、20%~150% 等比缩放、左侧文件树 + 右侧主入口渲染
- **明确不做**（YAGNI）：KV 索引、纯静态双通道模式、Vue/Naive UI 引入、私有/公开作品开关、Agent 发布 API（后续可加）

非目标说明：本项目不改动 MD2WX 现有转换、发布工坊、封面工坊任何行为。

## 2. 总体架构（方案 A：主 Worker 内嵌）

单个 Worker（现有 `cloudflare/md2wx-worker`，name = `gzh`）承载三件事：

1. **静态页面**：`web/dist` 照旧经 ASSETS 绑定伺服，新增 `/hub` 页面入口（Vite 多入口）
2. **管理 API**：`/api/hub/*` 路由组
3. **作品回源**：`/hub/<分类>/<项目>/<路径>` 直读 R2

新增一个 Cloudflare 资源：R2 桶 `gzh-hub`。不新增 KV、D1 或索引文件。

## 3. 存储设计

对象键即目录结构，无任何元数据存储：

```
<分类>/<项目>/<相对路径>
例：可视化项目/数据大屏/css/main.css
```

- **列表推导**：项目树、文件数、总大小、更新时间全部由 R2 `list({ delimiter: '/' })` 按前缀逐级列举实时得出
- **入口探测**：项目根 `index.html` 优先，否则字典序第一个 `.html`；仅作展示与重定向，不入库
- **缓存**：列表结果经 Cache API 缓存 60 秒（cache key = 请求 URL），任何写操作（PUT/DELETE）后清除同前缀缓存

## 4. API 设计

| 路由 | 方法 | 鉴权 | 作用 |
|---|---|---|---|
| `/api/hub/login` | POST | — | `{password}` → `{token}`；HMAC 签名，7 天有效 |
| `/api/hub/projects` | GET | 公开 | 分类→项目树（文件数/大小/入口/更新时间） |
| `/api/hub/projects/<cat>/<proj>/files` | GET | 公开 | 项目内文件清单（供文件树） |
| `/api/hub/projects/<cat>/<proj>/files/<路径>` | PUT | token | 上传/覆盖单文件；多文件 = 前端循环逐个 PUT，天然支持追加 |
| `/api/hub/projects/<cat>/<proj>` | DELETE | token | 删除整项目（前缀列举 + 批量删） |
| `/api/hub/projects/<cat>/<proj>/files/<路径>` | DELETE | token | 删除单文件 |

### 鉴权

- secret `HUB_ADMIN_PASSWORD`（`wrangler secret put` 注入；未配置时所有写路由 fail-closed 拒绝）
- token = `base64url(payload{exp}) + '.' + base64url(HMAC-SHA256(payload, key))`；key = SHA-256(密码 + ":hub-session")；无用户名、无服务端会话
- 校验用 `crypto.subtle.verify`（常数时间比较）

### 预览服务

- `run_worker_first` 由 `["/api/*"]` 扩为 `["/api/*", "/hub/*"]`
- Worker 按 R2 对象回源，按扩展名映射 Content-Type；`text/html` 用 `Cache-Control: public, max-age=300`，静态资源较长
- `/hub/<cat>/<proj>/` 与 `/hub/<cat>/<proj>` 302 到入口文件路径

### 安全

- 路径穿越：拒绝 `..` 段、前导 `/`、反斜杠；分类/项目名白名单（中英文、数字、连字符、下划线；分类 ≤ 24 字符，项目名 ≤ 64 字符，单路径段）
- 登录限流：`[[ratelimits]]` 新增 namespace（如 1003），10 次/分钟/IP，仅作用于 `/api/hub/login`
- 登录失败响应不区分密码错/限流（防探测）
- 同源部署，无 CORS 暴露面

## 5. 前端设计

不塞进现有 Studio Tab（app.js 已 1470 行，UI 形态不同），采用 **Vite 多入口**：新增 `hub.html` + `src/hub.js`（原生 JS，预计 600~900 行），构建产物由现有 ASSETS 伺服；Studio 顶部导航加「作品 Hub →」链接。继续遵守 AGENTS.md 零重型依赖哲学。

- **首页**：顶栏（搜索框：项目名/分类实时模糊过滤；登录按钮）+ 分类导航 + 项目卡片网格（项目名、分类、文件数、体积、更新时间、「预览」；登录态追加「编辑/删除」——编辑 = 复用上传弹窗进入追加模式（新增/覆盖文件）+ 文件树内单文件删除）
- **沉浸式预览工作台**：全屏覆盖层；左侧文件树（files 接口）；右侧 iframe 指向 `/hub/<分类>/<项目>/`；视口预设四档，外层容器 CSS transform 等比缩放适配窗口；缩放滑杆 20%~150%；无损刷新；新窗口打开
- **上传弹窗**：选/新建分类 + 项目名 + 拖放区。文件夹拖拽用 `DataTransferItem.webkitGetAsEntry()` 递归遍历保留相对路径；另支持 `webkitdirectory` 选择器。逐文件 PUT，进度条显示 n/总 与当前文件名；入口探测结果仅展示
- **鉴权 UX**：token 存 localStorage；任一 401 → 清 token、弹登录框

## 6. 错误处理

- 上传批处理：单文件失败即中止，报出失败文件名，可重试
- 单文件上限 95MB，前后端双拦（Worker request body 限制内）
- 预览 404：简单样式的「页面不存在」页（非裸 JSON）
- R2 异常 → 500 JSON；路径非法 → 400

## 7. 测试与部署

- 无既有 Worker 测试框架，遵循轻量哲学：`wrangler dev` + curl 冒烟清单（登录 → 建项目 → 传 3 文件迷你站点 → 列表 → 预览确认 css/js 相对路径生效 → 删项目）；前端手工验收清单
- 部署步骤（本地 wrangler 已登录）：`wrangler r2 bucket create gzh-hub` → `wrangler secret put HUB_ADMIN_PASSWORD` → `web/` 构建 → `wrangler deploy`
- `wrangler.toml` 改动点：`[[r2_buckets]]` 绑定 HUB → `gzh-hub`；`run_worker_first` 加 `/hub/*`；登录限流 namespace

## 8. 实施阶段（供 writing-plans 使用）

1. **Worker 存储 + API + 预览回源**：R2 绑定、登录/token、PUT/DELETE/列表、`/hub/*` 回源与重定向（含第 3 节的写后清缓存）
2. **Hub 浏览页 + 工作台**：hub.html/hub.js 骨架、卡片网格、分类导航、搜索、预览工作台
3. **上传/删除管理**：拖拽文件夹、逐文件 PUT 进度、追加模式、删除确认
4. **打磨**：空态/加载态、移动端适配检查
