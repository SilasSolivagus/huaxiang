# 记录中心（Records Center）设计

**日期：** 2026-06-13
**状态：** 已与用户确认，待写实现计划

## 1. 目标与背景

「画像办公室」3D 模拟里，看板、个人小结、记忆、会议纪要、办公室动态都挤在 3D 主界面的小浮窗里，太小、看不全。本设计新增一个**独立的只读页面 `records.html`**，把所有文字记录全尺寸、可翻阅地呈现出来。

会议纪要/产出物是 P3a 刚产出但**还没有任何界面**的数据，本页是它的第一个呈现入口。

**用户已确认的四个决定：**
- 内容：四类全要——进展看板（含个人小结）、会议纪要与产出物、人物记忆流与画像、办公室动态日志（历史）。
- 布局：左侧分类栏 + 右侧大面板（档案馆式）。
- 更新：实时跟随模拟（模拟在另一标签页跑）。
- 降级：纪要类依赖 sidecar 在线，其余三类纯 localStorage 即可看；从 sidecar 打开四类全有，用 http-server/Pages 打开时纪要类显示「需从 sidecar 打开」。

## 2. 架构

**只读查看器，不参与模拟、不写数据。** 模拟仍只在 `index.html` 里跑；记录页是 `index.html` 的兄弟页（与 `admin.html` 同级），同源，因而能读同一份 localStorage 并响应跨标签页的 `storage` 事件，也能请求同一 sidecar 的 `/api/artifacts`。

```
index.html（模拟在跑）──写──▶ localStorage: board / memories / activity
                          └──写──▶ sidecar: artifacts
records.html（只读）──读──▶ localStorage（+ 监听 storage 事件实时刷新）
                     └──轮询──▶ sidecar GET /api/artifacts
```

### 新增文件

| 文件 | 职责 | 依赖 |
|---|---|---|
| `records.html` | 页面骨架：左分类栏 + 右主面板的 DOM 结构 | `css/style.css` + `css/records.css` + `js/records.js` |
| `css/records.css` | 记录页专属样式（暗色，复用既有色板与头像圆点） | 无 |
| `js/records.js` | 记录页控制器：取数（只读解析）、4 个分类渲染、分类/二级列表切换、实时刷新 | `store.js`（personas 身份）、`activityLog.js`（`loadActivity`） |
| `js/activityLog.js` | 办公室动态的持久化环形缓冲（写入 + 读取） | 无 |
| `test-activity.mjs` | `activityLog` 单测（增 / 截断 / 读 / 无 storage 降级） | `js/activityLog.js` |
| `test-records.mjs` | `records.js` 抽出的纯函数单测（分组、HTML 渲染串） | `js/records.js` 的导出纯函数 |

### 改动的既有文件（最小增量）

| 文件 | 改动 |
|---|---|
| `js/main.js` | 在 `log(msg, cls)`（第 121-131 行）里挂一行 `activityLog.add(...)`，把每条办公室动态持久化；顶部 import `activityLog`。**唯一触及运行代码的改动，纯增量，不影响模拟。** |
| `index.html` | 顶栏 `#admin-link` 旁加一个 `#records-link`（📑）跳 `records.html`。 |

## 3. 数据源契约（只读解析）

记录页**不 import 有副作用的 `Board` / `MemoryStream` 类**（它们会注册到全局 Map、调度存盘），改为只读直解析 localStorage，避免误写与触发存盘。仅复用 `store.js`（`loadConfig`/`runtimePersonas` 取人物身份，二者只读）与 `activityLog.js`（`loadActivity`）。个人小结直接读 board 里预先算好的 `summaries[id]`，无需 import `board.js`/`composeAgentSummary`。

| key | 形状 | 来源 |
|---|---|---|
| `huaxiang.board.v1` | `[{ day, items:[{type,text}], summaries:{ [id]: text } }]` | `board.js` |
| `huaxiang.memories.v1` | `{ [personaId]: [{ c, imp, type, day, time, t, at }] }` | `memory.js` |
| `huaxiang.activity.v1` | `[{ day, time, text, cls }]`（**本设计新增**，环形缓冲 ≤300 条） | `activityLog.js` |
| `huaxiang.config.v1` | 人物画像/模型/公司（经 `loadConfig`+`runtimePersonas` 读为运行期 personas） | `store.js` |
| sidecar `GET /api/artifacts?type=minutes` | `{ artifacts:[{ id, ts, type, day, content, meta:{ zone, phase, decisions, risks, actionItems } }] }` | P3a `ArtifactStore` |

### `js/activityLog.js` 接口

```js
const ACTIVITY_KEY = "huaxiang.activity.v1";
const MAX = 300;

// 追加一条动态（超出 MAX 丢最旧）。无 localStorage 环境（如 node 测试）安全 no-op。
export function addActivity({ day, time, text, cls });

// 读出全部动态（最新在前），无 storage 返回 []。
export function loadActivity();

// 测试可注入的纯逻辑：在数组上追加并裁剪，返回新数组（被 addActivity 复用）。
export function appendCapped(list, entry, max = MAX);
```

`appendCapped` 是纯函数，承载「追加 + 截断」逻辑，便于 node 单测；`addActivity`/`loadActivity` 是 localStorage 的薄封装（沿用 `board.js`/`memory.js` 的 `hasStorage()` 守卫与 try/catch 降级）。

`main.js` 接入：

```js
import { addActivity } from "./activityLog.js";
// log() 内，prepend 到 DOM 之后追加：
addActivity({ day: director ? director.day : world.day, time: director ? director.clockLabel : "09:00", text: msg, cls });
```

## 4. 页面：布局与四个分类

### 布局

- **左栏（分类导航）**：4 个一级分类按钮（📑 看板 / 📋 纪要 / 🧠 人物 / 📡 动态）；选中分类后，其下展开**二级列表**：
  - 看板 / 纪要 / 动态 → 二级是「天」列表（第 N 天，最新在上）；动态另给一个「全部」。
  - 人物 → 二级是人名列表（含头像圆点）。
- **右栏（详情面板）**：渲染当前 分类 × 二级选中项 的全尺寸内容。
- 顶部一条窄 header：标题「📑 记录中心」+ 返回 index.html 的链接 + sidecar 在线状态点。
- **响应式**：窄屏（<640px）左栏折为顶部横向标签，二级列表与详情上下叠放。

### 📑 看板

按天展示该天的 进展/决策/应对 条目（复用主页面的 `bi-progress/bi-decision/bi-response` 标签配色）+ 该天每个人的当日小结（人名 + 小结文本）。二级选「第 N 天」看单天；默认选最新一天。

### 📋 纪要（依赖 sidecar）

`GET /api/artifacts?type=minutes` 取全部纪要，按 `day` 倒序分组；同一天可能有产研/运营两区多条。每条卡片头部：第 N 天 · 办公区(meta.zone) · 相位(meta.phase)；正文分三段：**决议 / 风险 / 行动项**（行动项显示 owner + what，用 `meta.decisions/risks/actionItems` 渲染，正文 `content` 作兜底）。
- sidecar 离线（探测 `/api/health` 失败或 fetch 报错）：本分类显示空态「会议纪要需要从 sidecar 打开本页才能查看（见 README 启动方式）」。

### 🧠 人物

二级选一个人 → 右侧：头像圆点 + 姓名 + 职务 + 画像（personality）+ **完整记忆流**（该人 `huaxiang.memories.v1` 里的全部条目，按天/时刻倒序，反思条目 `type==="reflect"` 高亮，行动项 `type==="action"` 可加标记）+ 历史小结（从 board 的 `summaries[id]` 收集该人各天小结）。

### 📡 动态

办公室动态完整时间线：每条显示 时刻 + 文本，按天分组（第 N 天为小标题）。二级可选某天或「全部」。沿用主页面 `log-meeting/log-collab` 等 class 的配色（在 records.css 里给同名 class 上色）。

## 5. 实时更新

- **跨标签页**：`window.addEventListener("storage", e => { ... })`——当 index.html（另一标签页）写 `huaxiang.board.v1` / `huaxiang.memories.v1` / `huaxiang.activity.v1` 时，浏览器在记录页触发 `storage` 事件（同页自身的写不会触发，但记录页只读、不写，所以恰好都来自模拟页）。按 `e.key` 只刷新对应分类当前视图。
- **纪要（sidecar）**：`storage` 事件覆盖不到 sidecar 数据，故纪要分类在被激活时拉一次，并在该分类可见期间每 ~5s 轮询一次；切走则停。
- 刷新只重渲染当前分类 × 二级选中项，避免整页重建。

## 6. 测试策略

沿用项目「纯函数单测 + 环境相关人工验证」的惯例：

- `test-activity.mjs`：`appendCapped`（追加、超 max 丢最旧、空列表、边界）；`addActivity`/`loadActivity` 在无 localStorage 的 node 下应安全 no-op / 返回 `[]`（验证降级守卫）。
- `test-records.mjs`：`records.js` 抽出的纯函数——按天分组（board/activity）、按 day 分组纪要、把一条纪要/记忆/看板条目渲染为 HTML 串（断言含关键字段与转义）、人物历史小结收集。这些不依赖 DOM。
- DOM 装配、分类切换、跨标签页 `storage` 实时刷新、sidecar 轮询：浏览器人工验证。沙箱无头环境跑不动时如实标注为环境限制（非代码 bug），并说明真机可用。

## 7. 错误处理与降级

- 无 localStorage（隐私模式/极端环境）：四类本地源读为空，页面显示各自空态，不报错。
- sidecar 离线：仅纪要类降级提示，其余三类正常。
- 脏数据（JSON 解析失败）：每个解析器 try/catch 回退空数组/空对象（沿用 `board.js`/`memory.js` 既有模式）。
- HTML 注入：所有用户/模型来源文本经 `escapeHtml`（从 main.js 沿用同一实现）后再插入。

## 8. 本设计明确不做（YAGNI）

- 不在记录页内嵌 3D / Three.js（纯文字记录，头像用 CSS 圆点）。
- 不做编辑/删除/导出（只读查看）。
- 不做全文搜索/筛选器（按分类 + 天/人浏览已满足「看全」诉求；如后续需要再加）。
- 不改 sidecar（P3a 的 GET 端点已够用）。
- 办公室动态只持久化「动态日志（director.log 的内容）」，不持久化每个气泡 `agent.say`（那是瞬时演出，不属于记录）。
