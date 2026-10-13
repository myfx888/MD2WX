# MD2WX 封面工作台「保存配置」与发布同源生成 设计文档

日期:2026-10-13
状态:待评审
前置:封面文案两层自定义已上线(2026-10-12);封面工作台(cover-modal)的 主题/比例/6 文案字段 状态仅存于 `initCoverStudio` 局部变量,刷新即丢;发布工坊推送导出(`app.js:962`)与发布缩略图(`app.js:881`)写死「编辑器当前主题 + banner 比例」,正文顶部封面(`parser.js:597`)用编辑器主题——**封面工作台里选的主题与比例在发布链路上从不生效**

## 1. 背景与目标

用户诉求:封面工作台修改后,有一个**明显的保存按钮**,点击后保存;发布时按照保存的设置生成封面图片。

现状三个断点:

1. 工作台状态(coverThemeId / coverRatio / coverMeta)不持久化,刷新丢失;
2. 无「保存」动作——现有「💾 存为全局默认」只存 badge/tag/author/vol 四个品牌预填字段,与"这套封面配置"是两回事;
3. 发布链路三处消费点全部忽略工作台选择:推送导出与缩略图用编辑器主题 + 写死 banner 比例,正文顶部封面用编辑器主题。

目标:工作台内一键保存全套配置;发布推送、发布缩略图、正文顶部封面三处严格按保存配置生成;无保存配置时行为与现状完全一致。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 保存范围 | 全套配置:封面主题 + 比例 + 6 文案字段(用户已确认);安全线开关为预览辅助,不入库 |
| 生效语义 | **保存才生效**:点保存前,工作台内修改仅预览,三处消费点仍用上一次保存配置(按用户原话「点击后保存→发布时按设置生成」推断,待评审确认;备选方案 B「即时生效+保存仅持久化」见 §7) |
| 双图合拼(dual) | 推送/缩略图回落 banner 导出(双拼 3350x1000 是手动裁剪素材,直接推草稿箱会变形),发布状态栏提示;工作台内导出下载仍按 dual 原样 |
| 与全局品牌默认的关系 | 互不影响:快照管「这一篇发布用哪套」,`md2wx_cover_defaults` 管「新开主题时预填什么」 |
| 端范围 | 仅 Web 端;Python CLI(`md2wx/cover.py`)不同步(同前例) |
| 兼容红线 | 从未点过保存(无快照)时:发布导出、缩略图、正文顶部封面、工作台打开行为与现状逐一一致 |

## 2. 数据模型与核心模块

### 2.1 新模块 `web/src/core/coverWorkbench.js`(纯逻辑,零 DOM,Node 可测)

```js
export const COVER_WORKBENCH_KEY = 'md2wx_cover_workbench';

// 读快照;非法 JSON / ratio 非法 / themeId 非字符串 → null(调用方回落现状)
readCoverWorkbench(store) -> {
  themeId: 'tech-blue' | 'custom-...',
  ratio: 'banner' | 'square' | 'dual',
  title, digest, tag, badge, vol, author,   // 一律字符串,缺失补 ''
  savedAt: number
} | null

// 写快照:白名单 8 字段 + trim + savedAt=Date.now(),JSON.stringify 落库
// quota 异常向上抛,由调用方 toast(同 saveDraft 模式)
writeCoverWorkbench(store, snapshot) -> void

// 导出比例:消费链路专用(推送/缩略图);工作台导出下载不经过它
coverExportRatio(ratio) -> ratio === 'dual' ? 'banner' : ratio
```

存储格式:`md2wx_cover_workbench` = JSON 对象。`readCoverWorkbench` 只做结构性校验(类型/枚举),**不**校验 themeId 是否在主题注册表——自定义主题可能后被删除,由 app 层现有 `resolveCoverBase` 兜底(回落视觉基座)。

### 2.2 app 层取数助手(app.js)

```js
function getSavedCoverConfig() {
  const store = typeof localStorage !== 'undefined' ? localStorage : null;
  const snap = readCoverWorkbench(store);
  if (!snap) return null;
  return {
    themeId: resolveCoverBase(snap.themeId),  // custom-* → 视觉基座,主题被删时兜底
    ratio: snap.ratio,
    meta: { title: snap.title, digest: snap.digest, tag: snap.tag,
            badge: snap.badge, vol: snap.vol, author: snap.author },
  };
}
```

三处消费点统一模式:`const cfg = getSavedCoverConfig() || { themeId: currentThemeId, ratio: 'banner', meta: currentCoverMeta || {} }`。

## 3. UI(封面工作台)

### 3.1 保存按钮(index.html header + cover.css)

- 弹窗 header 右侧、关闭按钮**左侧**新增主按钮 `#btn-save-workbench`(primary 绿,文案「💾 保存配置」),始终可见不随滚动;
- 按钮内小圆点 `.save-dot`:当前表单状态(JSON 序列化)与 `lastSavedJson` 不一致时显示(未保存提示),一致时隐藏;
- 点击:`writeCoverWorkbench` → toast「已保存,发布时将按此配置生成封面」→ 刷新 `lastSavedJson` → 圆点消失;
- localStorage 不可用或 quota 异常:toast 报错(沿用现有 defaults 按钮模式),状态不变。

### 3.2 打开行为恢复(openCoverModal 改造)

- 有快照:恢复主题下拉、比例 tab 的 active 类与 `coverRatio` 变量、6 个文案输入框;**不再**强制 `coverThemeId = currentThemeId`、不再自动 `refreshMetaFromArticle()`;
- 无快照:维持现状(编辑器主题 + 正文提取),老用户零感知;
- 「同步正文」按钮行为不变(重提取进表单,属预览层,不自动保存)。

### 3.3 脏状态追踪

所有 6 输入框 `input` 事件、主题 `change`、比例 tab 点击后:比对当前表单 JSON 与 `lastSavedJson` → 切换圆点。无快照时 `lastSavedJson` 取"打开时从正文提取的结果"作为基线(避免一打开就显示未保存)。

## 4. 消费链路改造(修复不匹配 bug)

| # | 消费点 | 现状 | 改造后 |
|---|---|---|---|
| 1 | 推送导出 `app.js:962` | `renderCoverDirectCanvas(currentThemeId, 'banner', currentCoverMeta, 1)` | `cfg = getSavedCoverConfig() || 现状三元组`;`renderCoverDirectCanvas(cfg.themeId, coverExportRatio(cfg.ratio), cfg.meta, 1)`;cfg.ratio==='dual' 时在 `publish-cover-status` 追加「双拼配置,推送按 2.35:1 导出」 |
| 2 | 发布缩略图 `app.js:881` | `renderCoverHtml(currentThemeId, 'banner', currentCoverMeta)` | 同上 cfg 与 `coverExportRatio`,缩略图与推送所见一致 |
| 3 | 正文顶部封面 `app.js:486` + `parser.js:596-597` | `markdownToWechatHtml(..., coverMeta: currentCoverMeta)`,header cover 用编辑器主题 | `markdownToWechatHtml` 新增可选 `options.coverThemeId`;`parser.js` header cover 改用 `renderOptions.coverThemeId || themeName`;app.js 传 `coverThemeId: cfg?.themeId`、`coverMeta: cfg?.meta ?? currentCoverMeta` |
| 4 | 可用性判断 `refreshUseCoverAvailability` | `!!currentCoverMeta || 正文可提取` | 追加 `\|\| !!getSavedCoverConfig()` |

parser.js 改动向后兼容:`coverThemeId` 不传即回落 `themeName`,其它调用方零影响。

## 5. 错误处理与兼容

- 快照 JSON 损坏 / 字段非法:`readCoverWorkbench` 返回 null,全部回落现状,绝不抛错中断渲染/推送;
- 快照内主题已被删除:`resolveCoverBase` 兜底回落视觉基座(现状同款机制);
- localStorage quota 超限:写失败 toast「保存失败:存储空间不足」,旧快照保留;
- 兼容红线验收:清空 `md2wx_cover_workbench` 后,推送导出参数、缩略图 HTML、正文顶部封面 HTML、工作台打开状态与改造前逐一一致。

## 6. 测试

新增 `cloudflare/md2wx-worker/test/coverWorkbench.test.mjs`(esbuild 打包进 `build:test`,node --test,模式同 coverCopy):

- `writeCoverWorkbench`/`readCoverWorkbench`:8 字段往返、白名单外字段丢弃、trim、非法 JSON → null、ratio 非法 → null、store 不可用 → null;
- `coverExportRatio`:dual→banner、banner/square 原样;
- 回归门槛:既有 `engine.test.mjs` / `coverCopy.test.mjs` 等全部原样通过。

手动冒烟清单(发布前):

1. 工作台改主题+比例+文案 → 保存 → 刷新页面 → 重开工作台完整恢复;
2. 保存 square 后改动不保存 → 发布工坊缩略图仍是 square 形态,推送导出为 square;
3. 保存 dual → 缩略图/推送回落 banner 且状态栏有提示;工作台内「下载高清 PNG」仍是双拼;
4. 无快照(清 localStorage)→ 推送、缩略图、正文顶部封面与线上现状一致;
5. 保存配置后切换编辑器主题 → 正文顶部封面仍用保存的封面主题。

## 7. 范围边界

- 不做:多套命名预设、自动保存、关闭弹窗未保存拦截(仅圆点提示)、Python CLI 同步、Worker / API 改动;
- 不改:「存为全局默认 / 清除全局默认」逻辑、工作台内复制/下载导出行为、推送 payload 其余字段;
- 备选方案 B(若评审推翻生效语义):保留现状即时联动,保存仅写 localStorage 防丢;§3.3 与 §4 的消费点改造随之简化——实施计划阶段再展开。
