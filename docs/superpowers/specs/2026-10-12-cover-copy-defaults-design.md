# MD2WX 封面默认文案元素两层自定义 设计文档

日期:2026-10-12
状态:已经用户确认
前置:发布工坊与主题工坊已上线;`THEME_COVER_PRESETS` 仅覆盖 9 个内置主题,自定义主题无封面文案预设;品牌兜底字(万舟智算/WZZS/万舟智算·教程系列)硬编码于 `cover.js`/`canvas_exporter.js`

## 1. 背景与目标

Cover Studio 已有「文案元素自定义」区块(主标题/摘要/标签/徽章/期号/作者 6 输入框,逐文章可改),但**默认值**不可配置:

- 品牌兜底字(徽章 WZZS、作者 万舟智算、标签 万舟智算·教程系列)硬编码在代码里,换公众号或改品牌需要改代码;
- 自定义主题没有封面文案预设,一律回落到 tech-blue 的预设值,自定义主题无法拥有自己的文案身份。

目标:两层默认文案元素自定义——**全局品牌默认值**(跨主题跨文章)+ **自定义主题级默认文案**(随主题定义),解析链逐元素独立回落。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 层级 | 两层都要:全局默认 + 自定义主题 coverCopy(方案 A) |
| 内置主题预设 | 保持代码所有,不开放编辑(排除方案 C) |
| 解析链语义 | 全局默认一旦设置**压过**内置主题预设;清除后回到内置预设 |
| 覆盖元素 | 仅 badge(徽章)/ tag(默认标签)/ author(作者)三个品牌性元素 |
| 不设默认 | 主标题/摘要/期号是逐文章属性,不设全局默认 |
| 端范围 | 仅 Web 端;Python CLI(cover.py 同款硬编码)不同步,留作后续 |
| 兼容红线 | 无任何配置时,封面输出与现状逐一像素一致 |

## 2. 数据模型与解析链

### 2.1 新模块 `web/src/core/coverCopy.js`(纯逻辑,零 DOM,Node 可测)

```js
// 全局品牌默认值 (localStorage 键: md2wx_cover_defaults)
readCoverDefaults(store)  -> { badge, tag, author } | null  // 无有效字段返回 null
writeCoverDefaults(store, { badge, tag, author }) -> void    // 空串字段剔除;三个全空即删键
// 自定义主题 coverCopy 提取
extractThemeCoverCopy(themeDef) -> { badge, tag, author } | null // 非法/缺字段返回 null
// 解析链合并 (每元素独立优先级回落)
resolveCoverCopy({ themeDef, store }) -> { badge, tag, author }
//   每元素: 主题 coverCopy > 全局默认 > 内置预设 > 硬编码兜底
//   (frontmatter 层不在本函数内——由现有 extractCoverMeta 的 meta.X||... 路径天然处理)
//   themeDef 为 null/非自定义主题时,主题层跳过;内置主题由调用方传 null
applyCoverCopyToMeta(meta, resolved) -> meta
//   仅当 meta 中该元素为空时填入 resolved 值,不覆盖显式值
```

存储格式(`md2wx_cover_defaults`):JSON 对象 `{"badge":"...","tag":"...","author":"..."}`,只存非空字段;读取时非法 JSON 容错返回 null。

### 2.2 五层优先级契约

| 层 | 来源 | 优先级 | 持久化 |
|---|---|---|---|
| 1. 正文 frontmatter | `meta.author / meta.tags` | 最高(逐文章) | 文章本身 |
| 2. 自定义主题 coverCopy | 主题定义 JSON `coverCopy` 字段 | 高(选该主题时) | 随主题(customThemes 存储) |
| 3. 全局品牌默认 | `md2wx_cover_defaults` | 中 | localStorage |
| 4. 内置主题预设 | `THEME_COVER_PRESETS`(代码) | 低 | 代码所有 |
| 5. 硬编码兜底 | `万舟智算 / WZZS / 万舟智算·教程系列` 字面量 | 最低 | 代码所有,迁入 `coverCopy.js` 常量 |

解析链每元素独立:badge/tag/author 三者可来自不同层(例如主题只配了 badge,tag 落到全局默认)。

### 2.3 接入点(改动面)

- `web/src/core/cover.js` 的 `extractCoverMeta`(现 88-124 行):三处回落逻辑改为
  - `meta.author || resolved.author`
  - tag:`meta.tags` 非空数组沿用现逻辑,否则 `resolved.tag`
  - badge:`resolved.badge`(preset.badgeText 经解析链进入 resolved)
- `web/src/core/canvas_exporter.js:53-55`:同样三处改为消费 `resolveCoverCopy` 结果(保持两处渲染同源)
- 硬编码兜底字面量从两处渲染文件移入 `coverCopy.js` 常量(单一事实来源);字面量值不变

## 3. UI

### 3.1 Cover Studio(`index.html` 文案元素自定义区块底部新增)

```
[💾 存为全局默认]  [清除全局默认]
```

- 「存为全局默认」:取**当前输入框**的 badge(`input-cover-badge`)/tag(`input-cover-tag`)/author(`input-cover-author`)三值 → `writeCoverDefaults`;成功 toast「已存为全局默认,所有主题的封面将预填此文案」
- 「清除全局默认」:`writeCoverDefaults(store, {})`(全空即删键);toast「已清除全局默认」
- 既有 6 输入框与「同步正文」逻辑零改动——默认值只改变打开封面工坊时的预填源(extractCoverMeta 内部生效)
- 空输入框也可存:存空 = 全局默认中该元素为空,解析链跳到下一层

### 3.2 主题工坊(自定义主题编辑器新增「封面默认文案」小节)

- 3 个输入框:徽章 / 默认标签 / 作者,写入主题定义的 `coverCopy` 字段,随主题保存/导入导出自然流转
- 留空 = 主题层不设置,该元素落到全局默认层
- 内置主题在主题工坊中**不显示**此小节

## 4. 错误处理与兼容

- 非法 JSON / 缺字段 / 类型不对:各读取函数容错返回 null,解析链自然跳层,绝不抛错中断渲染;
- `coverCopy` 为主题定义的可选字段:旧自定义主题(无该字段)行为不变;导入含 `coverCopy` 的主题自动生效,导出自动携带;
- 兼容红线验收:清空 `md2wx_cover_defaults` + 使用无 coverCopy 的主题,`extractCoverMeta` 输出与现状完全一致(万舟智算/WZZS/万舟智算·教程系列);
- localStorage 不可用(隐私模式):read/write 静默降级,UI 按钮仍可点但提示存储不可用。

## 5. 测试

新增 `cloudflare/md2wx-worker/test/coverCopy.test.mjs`(esbuild 打包 `coverCopy.js` → Node test runner,模式同 figuremap):

- `readCoverDefaults`/`writeCoverDefaults`:空值剔除、三全空删键、非法 JSON 容错、store 不可用;
- `extractThemeCoverCopy`:正常提取、缺字段、非法类型、null 入参;
- `resolveCoverCopy`:五层链逐级回落、每元素独立解析、内置主题(themeDef=null)走预设层;
- `applyCoverCopyToMeta`:不覆盖显式值、空值填入;
- **回归关键用例**:无配置时 resolveCoverCopy 返回硬编码兜底三元组,extractCoverMeta 输出与现状一致。

`cover.js`/`canvas_exporter.js` 既有测试(engine 套)原样通过为回归门槛。

## 6. 范围边界

- 不做:内置主题预设开放编辑、Python CLI 同步、主标题/摘要/期号默认值、全局默认的导入导出 UI(可后续);
- 不改:Worker、/api 契约、既有 6 个文案输入框与「同步正文」行为;
- 兼容:功能完全增量,无配置迁移;未配置时 UI 与现状完全一致。
