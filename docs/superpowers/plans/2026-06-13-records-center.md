# 记录中心（Records Center）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增独立只读页面 `records.html`，档案馆式（左分类栏 + 右大面板）全尺寸呈现进展看板、会议纪要、人物记忆、办公室动态四类记录，实时跟随模拟。

**Architecture:** 只读查看器，与 `admin.html` 同级、同源。看板/记忆/动态读 localStorage 并监听跨标签页 `storage` 事件实时刷新；纪要读 sidecar `GET /api/artifacts` 并轮询。新增 `js/activityLog.js` 把原本临时的办公室动态持久化，`main.js` 的 `log()` 挂一行写入。`js/records.js` 把纯函数（解析/分组/渲染 HTML 串）与 DOM 控制器分离，纯函数单测。

**Tech Stack:** 浏览器原生 ESM + localStorage + fetch；无构建、无框架。测试沿用根目录 `node test-*.mjs`（纯断言）。

参照设计 spec：`docs/superpowers/specs/2026-06-13-records-center-design.md`。

---

## 文件结构

- `js/activityLog.js`（新建）：办公室动态持久化（`appendCapped` 纯函数 + `addActivity`/`loadActivity` localStorage 薄封装）
- `js/main.js`（修改）：`log()` 里挂 `addActivity(...)` + 顶部 import
- `js/records.js`（新建）：记录页。纯函数（parse/group/render/collect/escape）+ `initRecords()` DOM 控制器（浏览器才自动跑）
- `records.html`（新建）：页面骨架
- `css/records.css`（新建）：记录页样式（复用既有色板）
- `index.html`（修改）：顶栏加 📑 入口
- `test-activity.mjs`（新建）：activityLog 单测
- `test-records.mjs`（新建）：records.js 纯函数单测

色板（取自 `css/style.css`）：底 `#1a1d24`，面板 `rgba(20,24,32,.85)`，文本 `#e8edf4 / #9aa4b2 / #6b7686`，蓝 `#4f8cff / #8ab4ff`，绿 `#7fd49a / #6ee7a0`，金 `#ffd479`，橙 `#ffb27f`，红 `#ff7b72`。看板标签 `bi-progress`(绿)/`bi-decision`(蓝)/`bi-response`(橙) 已在 style.css 定义，records 复用。

---

## Task 1：activityLog.js — 办公室动态持久化

**Files:**
- Create: `js/activityLog.js`
- Test: `test-activity.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-activity.mjs`）

```js
import { appendCapped, addActivity, loadActivity } from "./js/activityLog.js";

// appendCapped：追加保序
let l = [];
l = appendCapped(l, { text: "a" });
l = appendCapped(l, { text: "b" });
if (l.length !== 2 || l[0].text !== "a" || l[1].text !== "b") throw new Error("append 应保序");

// appendCapped：超 max 丢最旧
let big = [];
for (let i = 0; i < 5; i++) big = appendCapped(big, { text: "n" + i }, 3);
if (big.length !== 3 || big[0].text !== "n2" || big[2].text !== "n4") throw new Error("超 max 应丢最旧、留最后 3 条");

// appendCapped：非数组输入从空开始，不改原数组
const src = [{ text: "x" }];
const out = appendCapped(src, { text: "y" }, 10);
if (src.length !== 1) throw new Error("不应修改入参数组");
if (appendCapped(null, { text: "z" }).length !== 1) throw new Error("null 入参应从空开始");

// 无 localStorage（node）：addActivity 安全 no-op、loadActivity 返回 []
addActivity({ text: "不应抛错", day: 1, time: "09:00" });
if (loadActivity().length !== 0) throw new Error("无 storage 时 loadActivity 应为 []");

console.log("activityLog OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-activity.mjs`
Expected: FAIL — `Cannot find module ... js/activityLog.js`

- [ ] **Step 3: 实现 activityLog.js**（新建 `js/activityLog.js`）

```js
// 办公室动态的持久化：把原本只在 DOM 里一闪而过的 director.log 内容存成环形缓冲，
// 供记录页（records.html）翻阅历史。沿用 board.js/memory.js 的 hasStorage 守卫与降级。

const ACTIVITY_KEY = "huaxiang.activity.v1";
const MAX = 300;

function hasStorage() {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

/** 纯函数：追加 entry 到末尾，超过 max 丢最旧，返回新数组（不改入参）。 */
export function appendCapped(list, entry, max = MAX) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.push(entry);
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

/** 追加一条办公室动态。无 localStorage 或空文本时安全 no-op。 */
export function addActivity({ day, time, text, cls } = {}) {
  if (!hasStorage() || !text) return;
  try {
    const next = appendCapped(loadActivity(), {
      day: Number(day) || 0, time: time || "", text: String(text), cls: cls || ""
    });
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(next));
  } catch { /* 存储满/不可用：丢弃这条，不影响模拟 */ }
}

/** 读出全部动态（存储顺序：旧→新）。无 storage / 脏数据返回 []。 */
export function loadActivity() {
  if (!hasStorage()) return [];
  try {
    const arr = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-activity.mjs`
Expected: PASS — 输出 `activityLog OK`

- [ ] **Step 5: 提交**

```bash
git add js/activityLog.js test-activity.mjs
git commit -m "feat(activity): persistent office-activity ring buffer"
```

---

## Task 2：把动态写入接进 main.js 的 log()

**Files:**
- Modify: `js/main.js`

无自动化单测（`main.js` 顶层 import three，node 不能整体运行；用 `node --check` 做语法校验，行为在浏览器人工验证）。

- [ ] **Step 1: 顶部 import**

在 `js/main.js` 第 14 行 `import { Board } from "./board.js";` 之后追加：

```js
import { addActivity } from "./activityLog.js";
```

- [ ] **Step 2: 在 log() 末尾持久化**

`js/main.js` 的 `log(msg, cls)` 函数（第 121-131 行）当前结尾为：

```js
  logBody.prepend(item);
  while (logBody.children.length > 60) logBody.lastChild.remove();
}
```

改为（在裁剪 DOM 之后追加一行写入；`director` 在调用时已赋值，取其 day/clockLabel，构造早期兜底用 world.day）：

```js
  logBody.prepend(item);
  while (logBody.children.length > 60) logBody.lastChild.remove();
  addActivity({ day: director ? director.day : world.day, time: director ? director.clockLabel : "09:00", text: msg, cls });
}
```

- [ ] **Step 3: 语法校验**

Run: `node --check js/main.js && node --check js/activityLog.js && echo OK`
Expected: 输出 `OK`（`--check` 只校验语法，不解析 three 远程 import）

- [ ] **Step 4: 回归——确认既有前端测试不受影响**

Run: `node test-sim.mjs >/dev/null && node test-world.mjs >/dev/null && node test-board.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（这些测试不 import main.js，应不受影响）

- [ ] **Step 5: 提交**

```bash
git add js/main.js
git commit -m "feat(main): persist office activity to activityLog"
```

---

## Task 3：records.js — 解析与分组纯函数

**Files:**
- Create: `js/records.js`
- Test: `test-records.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-records.mjs`）

```js
import {
  parseBoard, parseMemories, groupActivityByDay, groupMinutesByDay,
  collectPersonSummaries, sortMemoriesDesc
} from "./js/records.js";

// parseBoard：合法数组 / 脏输入降级
if (parseBoard('[{"day":1,"items":[],"summaries":{}}]').length !== 1) throw new Error("parseBoard 合法数组");
if (parseBoard("not json").length !== 0) throw new Error("parseBoard 脏输入应空");
if (parseBoard(null).length !== 0) throw new Error("parseBoard null 应空");
if (parseBoard('{"a":1}').length !== 0) throw new Error("parseBoard 非数组应空");

// parseMemories：对象 / 脏输入降级
const mem = parseMemories('{"wang":[{"c":"x","day":1}]}');
if (!mem.wang || mem.wang.length !== 1) throw new Error("parseMemories 对象");
if (Object.keys(parseMemories("[]")).length !== 0) throw new Error("parseMemories 数组应空对象");
if (Object.keys(parseMemories("bad")).length !== 0) throw new Error("parseMemories 脏输入应空对象");

// groupActivityByDay：按天倒序、天内保序
const g = groupActivityByDay([
  { day: 1, time: "09:00", text: "a" }, { day: 2, time: "10:00", text: "b" },
  { day: 1, time: "11:00", text: "c" }
]);
if (g[0].day !== 2 || g[1].day !== 1) throw new Error("应按天倒序");
if (g[1].entries.length !== 2 || g[1].entries[0].text !== "a") throw new Error("天内应保序");
if (groupActivityByDay(null).length !== 0) throw new Error("null → []");

// groupMinutesByDay：按 day 倒序分组
const gm = groupMinutesByDay([{ day: 1, content: "x" }, { day: 3, content: "y" }, { day: 1, content: "z" }]);
if (gm[0].day !== 3 || gm[1].day !== 1 || gm[1].items.length !== 2) throw new Error("纪要应按天倒序分组");

// collectPersonSummaries：收集某人各天小结，天倒序
const days = [
  { day: 1, summaries: { wang: "第一天", li: "x" } },
  { day: 2, summaries: { wang: "第二天" } },
  { day: 3, summaries: {} }
];
const ws = collectPersonSummaries(days, "wang");
if (ws.length !== 2 || ws[0].day !== 2) throw new Error("应收集 wang 两天且天倒序");

// sortMemoriesDesc：按 t 倒序，不改入参
const items = [{ c: "a", t: 10 }, { c: "b", t: 30 }, { c: "c", t: 20 }];
const sorted = sortMemoriesDesc(items);
if (sorted[0].c !== "b" || sorted[2].c !== "a") throw new Error("应按 t 倒序");
if (items[0].c !== "a") throw new Error("不应修改入参");

console.log("records parse/group OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-records.mjs`
Expected: FAIL — `Cannot find module ... js/records.js`

- [ ] **Step 3: 实现 records.js 的解析/分组层**（新建 `js/records.js`，先只放纯函数；DOM 控制器 Task 6 再加）

```js
// 记录中心控制器。纯函数（解析/分组/渲染 HTML 串）在上半部分，可在 node 单测；
// 下半部分 initRecords() 是浏览器 DOM 控制器，仅在浏览器自动运行。
// 只读：解析 localStorage，绝不写入；不 import 有副作用的 Board/MemoryStream。

const BOARD_KEY = "huaxiang.board.v1";
const MEM_KEY = "huaxiang.memories.v1";

// ---------- 解析（纯函数：原始字符串 → 结构）----------

export function parseBoard(raw) {
  try { const a = JSON.parse(raw || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

export function parseMemories(raw) {
  try {
    const o = JSON.parse(raw || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

// ---------- 分组（纯函数）----------

export function groupActivityByDay(list) {
  const byDay = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    const d = Number(e?.day) || 0;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ time: e.time || "", text: e.text || "", cls: e.cls || "" });
  }
  return [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, entries]) => ({ day, entries }));
}

export function groupMinutesByDay(artifacts) {
  const byDay = new Map();
  for (const a of Array.isArray(artifacts) ? artifacts : []) {
    const d = Number(a?.day) || 0;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(a);
  }
  return [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, items]) => ({ day, items }));
}

export function collectPersonSummaries(boardDays, personaId) {
  const out = [];
  for (const d of Array.isArray(boardDays) ? boardDays : []) {
    const s = d?.summaries?.[personaId];
    if (s) out.push({ day: d.day, text: s });
  }
  return out.sort((a, b) => b.day - a.day);
}

export function sortMemoriesDesc(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-records.mjs`
Expected: PASS — 输出 `records parse/group OK`

- [ ] **Step 5: 提交**

```bash
git add js/records.js test-records.mjs
git commit -m "feat(records): pure parse/group helpers"
```

---

## Task 4：records.js — 渲染 HTML 串纯函数

**Files:**
- Modify: `js/records.js`
- Test: `test-records.mjs`（追加）

- [ ] **Step 1: 追加失败测试**（在 `test-records.mjs` 末尾 `console.log("records parse/group OK")` 之前插入）

```js
import { escapeHtml, renderBoardDay, renderMinuteCard, renderMemoryItem } from "./js/records.js";

// escapeHtml
if (escapeHtml('<a>&"') !== "&lt;a&gt;&amp;&quot;") throw new Error("escapeHtml 转义不对");

// renderBoardDay：含天号、标签 class、小结人名映射、转义
const bd = renderBoardDay(
  { day: 5, items: [{ type: "进展", text: "上线<限速>" }], summaries: { wang: "干了活" } },
  { wang: "王强" }
);
if (!bd.includes("第 5 天")) throw new Error("应含天号");
if (!bd.includes("bi-progress")) throw new Error("进展应映射 bi-progress");
if (!bd.includes("上线&lt;限速&gt;")) throw new Error("正文应转义");
if (!bd.includes("王强") || !bd.includes("干了活")) throw new Error("小结应用人名映射");

// renderMinuteCard：用 meta 三段，行动项含 owner
const mc = renderMinuteCard({
  day: 4, content: "兜底正文",
  meta: { zone: "rd", phase: "每日站会", decisions: ["上线限速"], risks: ["带宽成本"], actionItems: [{ owner: "王强", what: "评估方案" }] }
});
if (!mc.includes("第 4 天") || !mc.includes("rd") || !mc.includes("每日站会")) throw new Error("应含头部信息");
if (!mc.includes("上线限速") || !mc.includes("带宽成本") || !mc.includes("评估方案")) throw new Error("三段都应渲染");
if (!mc.includes("王强")) throw new Error("行动项应含 owner");

// renderMinuteCard：无 meta 段时回退 content
const mc2 = renderMinuteCard({ day: 1, content: "只有正文", meta: { zone: "ops", phase: "评审会" } });
if (!mc2.includes("只有正文")) throw new Error("无三段应回退 content");

// renderMemoryItem：反思/行动项加 class，转义
const r = renderMemoryItem({ c: "今日反思：累了", type: "reflect", day: 2, time: "18:00" });
if (!r.includes("rc-mem-reflect")) throw new Error("反思应加 reflect class");
const ac = renderMemoryItem({ c: "行动项：改bug", type: "action", day: 2, time: "10:00" });
if (!ac.includes("rc-mem-action")) throw new Error("行动项应加 action class");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-records.mjs`
Expected: FAIL — `escapeHtml is not a function`（或断言失败）

- [ ] **Step 3: 追加渲染纯函数**（在 `js/records.js` 的 `sortMemoriesDesc` 之后、`initRecords` 之前追加）

```js
// ---------- 渲染（纯函数：结构 → HTML 串）----------

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

const BI_CLASS = { "进展": "bi-progress", "决策": "bi-decision", "应对": "bi-response" };

export function renderBoardDay(dayObj, nameOf = {}) {
  const items = (dayObj.items || []).map(it =>
    `<div class="rc-board-item"><span class="bi-tag ${BI_CLASS[it.type] || ""}">${escapeHtml(it.type)}</span>${escapeHtml(it.text)}</div>`
  ).join("");
  const sums = Object.entries(dayObj.summaries || {}).map(([id, text]) =>
    `<div class="rc-summary"><b>${escapeHtml(nameOf[id] || id)}</b>：${escapeHtml(text)}</div>`
  ).join("");
  return `<section class="rc-board-day"><h3>第 ${dayObj.day} 天</h3>` +
    (items || `<div class="rc-empty">这天没有沉淀条目</div>`) +
    (sums ? `<div class="rc-summaries"><h4>个人小结</h4>${sums}</div>` : "") +
    `</section>`;
}

export function renderMinuteCard(a) {
  const meta = a.meta || {};
  const sec = (title, arr) => Array.isArray(arr) && arr.length
    ? `<div class="rc-min-sec"><h4>${title}</h4><ul>${arr.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const actions = Array.isArray(meta.actionItems) && meta.actionItems.length
    ? `<div class="rc-min-sec"><h4>行动项</h4><ul>${meta.actionItems.map(it =>
        `<li>${it.owner ? `<b>${escapeHtml(it.owner)}</b>：` : ""}${escapeHtml(it.what || "")}</li>`).join("")}</ul></div>` : "";
  const body = sec("决议", meta.decisions) + sec("风险", meta.risks) + actions;
  return `<section class="rc-min-card"><div class="rc-min-h">第 ${a.day} 天 · ${escapeHtml(meta.zone || "—")} · ${escapeHtml(meta.phase || "")}</div>` +
    (body || `<div class="rc-min-body">${escapeHtml(a.content || "")}</div>`) + `</section>`;
}

export function renderMemoryItem(m) {
  const cls = m.type === "reflect" ? " rc-mem-reflect" : m.type === "action" ? " rc-mem-action" : "";
  return `<div class="rc-mem${cls}"><span class="rc-mem-time">第${m.day}天 ${escapeHtml(m.time || "")}</span>${escapeHtml(m.c || "")}</div>`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-records.mjs`
Expected: PASS — 输出 `records parse/group OK`

- [ ] **Step 5: 提交**

```bash
git add js/records.js test-records.mjs
git commit -m "feat(records): pure HTML render helpers"
```

---

## Task 5：records.html + css/records.css

**Files:**
- Create: `records.html`
- Create: `css/records.css`

- [ ] **Step 1: 写 records.html**（新建 `records.html`）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#1a1d24" />
  <title>记录中心 · 画像办公室</title>
  <link rel="stylesheet" href="css/style.css" />
  <link rel="stylesheet" href="css/records.css" />
</head>
<body>
  <div id="rc-app">
    <header id="rc-top">
      <a id="rc-back" href="index.html">← 返回办公室</a>
      <h1>📑 记录中心</h1>
      <span id="rc-sidecar" class="rc-chip">📡 检测中…</span>
    </header>
    <div id="rc-body">
      <nav id="rc-nav">
        <div id="rc-cats">
          <button class="rc-cat active" data-cat="board">📑 看板</button>
          <button class="rc-cat" data-cat="minutes">📋 纪要</button>
          <button class="rc-cat" data-cat="people">🧠 人物</button>
          <button class="rc-cat" data-cat="activity">📡 动态</button>
        </div>
        <div id="rc-sublist"></div>
      </nav>
      <main id="rc-main"></main>
    </div>
  </div>
  <script type="module" src="js/records.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写 css/records.css**（新建 `css/records.css`）

```css
/* 记录中心：档案馆式布局，复用主题色板。 */
#rc-app { display: flex; flex-direction: column; height: 100vh; background: #1a1d24; color: #e8edf4;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }

#rc-top { display: flex; align-items: center; gap: 14px; padding: 10px 16px;
  background: rgba(20, 24, 32, 0.92); border-bottom: 1px solid rgba(255,255,255,0.08); }
#rc-top h1 { font-size: 15px; font-weight: 600; margin: 0; }
#rc-back { color: #8ab4ff; text-decoration: none; font-size: 13px; }
#rc-back:hover { color: #cfd6e0; }
.rc-chip { margin-left: auto; font-size: 12px; padding: 3px 9px; border-radius: 10px;
  background: rgba(255,255,255,0.06); color: #9aa4b2; }
.rc-chip.on { background: rgba(82,196,126,0.2); color: #6ee7a0; }

#rc-body { flex: 1; display: flex; min-height: 0; }

#rc-nav { width: 200px; flex-shrink: 0; border-right: 1px solid rgba(255,255,255,0.08);
  display: flex; flex-direction: column; min-height: 0; }
#rc-cats { padding: 10px; display: flex; flex-direction: column; gap: 4px; }
.rc-cat { text-align: left; padding: 9px 12px; border: none; border-radius: 8px; cursor: pointer;
  font-size: 13px; background: transparent; color: #cfd6e0; }
.rc-cat:hover { background: rgba(255,255,255,0.06); }
.rc-cat.active { background: #4f8cff; color: #fff; }

#rc-sublist { flex: 1; overflow-y: auto; padding: 6px 10px 16px; border-top: 1px solid rgba(255,255,255,0.05); }
.rc-sub { display: block; width: 100%; text-align: left; padding: 7px 10px; border: none; border-radius: 6px;
  cursor: pointer; font-size: 12px; background: transparent; color: #9aa4b2; margin-bottom: 2px; }
.rc-sub:hover { background: rgba(255,255,255,0.05); color: #cfd6e0; }
.rc-sub.active { background: rgba(120,170,255,0.12); color: #cdd6e2; }
.rc-sub .dot { display: inline-flex; width: 18px; height: 18px; border-radius: 50%; margin-right: 7px;
  align-items: center; justify-content: center; font-size: 10px; color: #fff; vertical-align: middle; }

#rc-main { flex: 1; overflow-y: auto; padding: 18px 24px; min-width: 0; }

.rc-empty { font-size: 13px; color: #6b7686; padding: 30px 0; text-align: center; }

/* 看板 */
.rc-board-day { margin-bottom: 22px; }
.rc-board-day h3 { font-size: 14px; color: #e8edf4; margin: 0 0 10px; }
.rc-board-item { font-size: 13px; color: #cdd6e2; line-height: 1.7; margin-bottom: 4px; }
.bi-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-right: 7px; }
.rc-summaries { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
.rc-summaries h4 { font-size: 12px; color: #7f8a99; margin: 0 0 6px; }
.rc-summary { font-size: 12px; color: #b7c0cc; line-height: 1.7; }
.rc-summary b { color: #e8edf4; }

/* 纪要 */
.rc-min-card { background: rgba(255,255,255,0.04); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.rc-min-h { font-size: 12px; color: #8ab4ff; margin-bottom: 10px; font-weight: 600; }
.rc-min-sec { margin-bottom: 8px; }
.rc-min-sec h4 { font-size: 12px; color: #7f8a99; margin: 0 0 4px; }
.rc-min-sec ul { margin: 0; padding-left: 18px; }
.rc-min-sec li { font-size: 13px; color: #cdd6e2; line-height: 1.7; }
.rc-min-sec li b { color: #ffd479; }
.rc-min-body { font-size: 13px; color: #cdd6e2; line-height: 1.7; white-space: pre-wrap; }

/* 人物 */
.rc-profile-head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.rc-avatar { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; font-size: 16px; color: #fff; font-weight: 600; }
.rc-profile-name { font-size: 16px; font-weight: 600; }
.rc-profile-role { font-size: 12px; color: #8ab4ff; }
.rc-profile-personality { font-size: 12px; color: #9aa4b2; line-height: 1.7; margin: 8px 0 16px; }
.rc-section-title { font-size: 13px; color: #b7c0cc; margin: 16px 0 8px; font-weight: 600; }
.rc-mem { font-size: 12px; color: #9aa4b2; line-height: 1.6; padding: 5px 8px; border-radius: 5px;
  background: rgba(255,255,255,0.04); margin-bottom: 3px; }
.rc-mem-time { color: #6b7686; margin-right: 6px; font-size: 10px; }
.rc-mem-reflect { color: #ffd479; background: rgba(255,212,121,0.08); }
.rc-mem-action { color: #7fd49a; background: rgba(127,212,154,0.08); }

/* 动态 */
.rc-act-day { margin-bottom: 18px; }
.rc-act-day h3 { font-size: 13px; color: #7f8a99; margin: 0 0 8px; }
.rc-act { font-size: 13px; color: #b7c0cc; line-height: 1.7; }
.rc-act .rc-act-time { color: #6b7686; margin-right: 6px; font-variant-numeric: tabular-nums; }
.rc-act.log-meeting { color: #ffd479; }
.rc-act.log-collab { color: #8ab4ff; }

@media (max-width: 640px) {
  #rc-body { flex-direction: column; }
  #rc-nav { width: auto; border-right: none; border-bottom: 1px solid rgba(255,255,255,0.08); max-height: 42vh; }
  #rc-cats { flex-direction: row; flex-wrap: wrap; }
}
```

- [ ] **Step 3: 校验 HTML/CSS 存在且基本完整**

Run: `node -e "const fs=require('fs'); const h=fs.readFileSync('records.html','utf8'); const c=fs.readFileSync('css/records.css','utf8'); if(!h.includes('rc-main')||!h.includes('js/records.js')) throw new Error('html 缺关键节点'); if(!c.includes('#rc-nav')||!c.includes('.rc-min-card')) throw new Error('css 缺关键类'); console.log('html/css OK')"`
Expected: 输出 `html/css OK`

- [ ] **Step 4: 提交**

```bash
git add records.html css/records.css
git commit -m "feat(records): page skeleton + stylesheet"
```

---

## Task 6：records.js — DOM 控制器（initRecords）

**Files:**
- Modify: `js/records.js`

浏览器专属，无 node 单测（导入时不应有 DOM 副作用——靠底部守卫）。用 `node --check` 校验语法，并确认 `test-records.mjs` 仍通过（即 import records.js 不触发 DOM 代码）。

- [ ] **Step 1: 在 records.js 末尾追加控制器**（在所有纯函数之后追加；import 放文件顶部已有常量之上）

文件顶部（`const BOARD_KEY` 之前）追加 import：

```js
import { loadConfig, runtimePersonas } from "./store.js";
import { loadActivity } from "./activityLog.js";
```

文件末尾追加控制器：

```js
// ---------- DOM 控制器（仅浏览器）----------

function readBoard() {
  return parseBoard(typeof localStorage !== "undefined" ? localStorage.getItem(BOARD_KEY) : null);
}
function readMemories() {
  return parseMemories(typeof localStorage !== "undefined" ? localStorage.getItem(MEM_KEY) : null);
}

export function initRecords() {
  const personas = runtimePersonas(loadConfig());
  const nameOf = Object.fromEntries(personas.map(p => [p.id, p.name]));
  const main = document.getElementById("rc-main");
  const sublist = document.getElementById("rc-sublist");
  const sidecarChip = document.getElementById("rc-sidecar");

  const state = { cat: "board", sub: null };
  let online = false;
  let minutes = [];
  let pollTimer = null;

  // sidecar 探测
  fetch("/api/health", { signal: AbortSignal.timeout(2000) })
    .then(r => { online = r.ok; })
    .catch(() => { online = false; })
    .finally(() => {
      sidecarChip.textContent = online ? "📡 数据在线" : "📡 离线";
      sidecarChip.classList.toggle("on", online);
      if (state.cat === "minutes") renderCategory();
    });

  function subBtn(label, key, active, extraHtml = "") {
    return `<button class="rc-sub${active ? " active" : ""}" data-sub="${key}">${extraHtml}${escapeHtml(label)}</button>`;
  }

  function renderCategory() {
    stopPoll();
    if (state.cat === "board") return renderBoard();
    if (state.cat === "minutes") return renderMinutes();
    if (state.cat === "people") return renderPeople();
    if (state.cat === "activity") return renderActivity();
  }

  function renderBoard() {
    const days = readBoard().slice().sort((a, b) => b.day - a.day);
    if (!days.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">还没有看板记录，跑过一个工作日后这里会出现。</div>`; return; }
    if (state.sub == null || !days.some(d => String(d.day) === String(state.sub))) state.sub = days[0].day;
    sublist.innerHTML = days.map(d => subBtn(`第 ${d.day} 天`, d.day, String(d.day) === String(state.sub))).join("");
    const day = days.find(d => String(d.day) === String(state.sub));
    main.innerHTML = day ? renderBoardDay(day, nameOf) : "";
  }

  function renderMinutes() {
    if (!online) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">会议纪要需要从 sidecar 打开本页才能查看。<br>启动方式见 README（cd sidecar && npm start）。</div>`; return; }
    const load = () => fetch("/api/artifacts?type=minutes")
      .then(r => r.ok ? r.json() : { artifacts: [] })
      .then(data => { minutes = Array.isArray(data.artifacts) ? data.artifacts : []; paintMinutes(); })
      .catch(() => { minutes = []; paintMinutes(); });
    load();
    pollTimer = setInterval(load, 5000);
  }

  function paintMinutes() {
    const groups = groupMinutesByDay(minutes);
    if (!groups.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">还没有会议纪要，开过会后这里会出现决议/风险/行动项。</div>`; return; }
    if (state.sub == null || !groups.some(g => String(g.day) === String(state.sub))) state.sub = groups[0].day;
    sublist.innerHTML = groups.map(g => subBtn(`第 ${g.day} 天（${g.items.length}）`, g.day, String(g.day) === String(state.sub))).join("");
    const g = groups.find(x => String(x.day) === String(state.sub));
    main.innerHTML = g ? g.items.map(renderMinuteCard).join("") : "";
  }

  function renderPeople() {
    if (!personas.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">没有人物</div>`; return; }
    if (state.sub == null || !personas.some(p => p.id === state.sub)) state.sub = personas[0].id;
    sublist.innerHTML = personas.map(p => {
      const dot = `<span class="dot" style="background:#${p.color.toString(16).padStart(6, "0")}">${escapeHtml(p.name[0])}</span>`;
      return subBtn(p.name, p.id, p.id === state.sub, dot);
    }).join("");
    const p = personas.find(x => x.id === state.sub);
    const mems = sortMemoriesDesc(readMemories()[p.id] || []);
    const sums = collectPersonSummaries(readBoard(), p.id);
    main.innerHTML =
      `<div class="rc-profile-head"><div class="rc-avatar" style="background:#${p.color.toString(16).padStart(6, "0")}">${escapeHtml(p.name[0])}</div>` +
      `<div><div class="rc-profile-name">${escapeHtml(p.name)}</div><div class="rc-profile-role">${escapeHtml(p.role)}</div></div></div>` +
      `<div class="rc-profile-personality">${escapeHtml(p.personality || "暂无画像")}</div>` +
      `<div class="rc-section-title">📋 历史小结</div>` +
      (sums.length ? sums.map(s => `<div class="rc-summary">第${s.day}天：${escapeHtml(s.text)}</div>`).join("") : `<div class="rc-empty">还没有小结</div>`) +
      `<div class="rc-section-title">🧠 记忆流（${mems.length}）</div>` +
      (mems.length ? mems.map(renderMemoryItem).join("") : `<div class="rc-empty">还没有记忆</div>`);
  }

  function renderActivity() {
    const groups = groupActivityByDay(loadActivity());
    if (!groups.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">还没有办公室动态记录。</div>`; return; }
    const ALL = "__all__";
    if (state.sub == null) state.sub = ALL;
    sublist.innerHTML = subBtn("全部", ALL, String(state.sub) === ALL) +
      groups.map(g => subBtn(`第 ${g.day} 天`, g.day, String(g.day) === String(state.sub))).join("");
    const shown = String(state.sub) === ALL ? groups : groups.filter(g => String(g.day) === String(state.sub));
    main.innerHTML = shown.map(g =>
      `<div class="rc-act-day"><h3>第 ${g.day} 天</h3>` +
      g.entries.map(e => `<div class="rc-act ${escapeHtml(e.cls)}"><span class="rc-act-time">${escapeHtml(e.time)}</span>${escapeHtml(e.text)}</div>`).join("") +
      `</div>`
    ).join("");
  }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // 分类切换
  document.getElementById("rc-cats").addEventListener("click", e => {
    const btn = e.target.closest(".rc-cat");
    if (!btn) return;
    document.querySelectorAll(".rc-cat").forEach(b => b.classList.toggle("active", b === btn));
    state.cat = btn.dataset.cat;
    state.sub = null;
    renderCategory();
  });

  // 二级列表切换
  sublist.addEventListener("click", e => {
    const btn = e.target.closest(".rc-sub");
    if (!btn) return;
    state.sub = btn.dataset.sub;
    if (state.cat === "minutes") paintMinutes();
    else renderCategory();
  });

  // 跨标签页实时刷新（模拟在 index.html 写 localStorage 时触发）
  window.addEventListener("storage", e => {
    if (!e.key) return;
    if (e.key === BOARD_KEY && (state.cat === "board" || state.cat === "people")) renderCategory();
    else if (e.key === MEM_KEY && state.cat === "people") renderCategory();
    else if (e.key === "huaxiang.activity.v1" && state.cat === "activity") renderCategory();
  });

  renderCategory();
}

if (typeof document !== "undefined" && document.getElementById("rc-main")) {
  initRecords();
}
```

- [ ] **Step 2: 语法校验 + 确认导入无 DOM 副作用**

Run: `node --check js/records.js && node test-records.mjs && echo OK`
Expected: 输出 `records parse/group OK` 与 `OK`（`test-records.mjs` 仍过，证明 import records.js 在 node 下不触发 initRecords）

- [ ] **Step 3: 提交**

```bash
git add js/records.js
git commit -m "feat(records): DOM controller with live update + sidecar poll"
```

---

## Task 7：index.html 顶栏入口

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 加入口链接**

`index.html` 第 37 行的 admin 链接：

```html
      <a id="admin-link" href="admin.html" title="管理后台：添加人物、写画像、配置模型">⚙</a>
```

在它之前插入记录中心入口：

```html
      <a id="records-link" href="records.html" title="记录中心：看板、会议纪要、人物记忆、办公室动态">📑</a>
```

- [ ] **Step 2: 复用 admin-link 样式（让 📑 与 ⚙ 视觉一致）**

`css/style.css` 里 `#admin-link` 的选择器（搜索 `#admin-link`）：把每条 `#admin-link` 选择器改为同时命中 `#records-link`。具体地，找到这三处并各自追加 `, #records-link`（或对应的 `:active`）：
- `#admin-link { ... }` → `#admin-link, #records-link { ... }`
- 若有 `#admin-link:active { background: #4f8cff; }` → `#admin-link:active, #records-link:active { background: #4f8cff; }`

（实现者执行时先 `grep -n "#admin-link" css/style.css` 确认全部出现处，逐处补上 `, #records-link` 对应选择器。）

- [ ] **Step 3: 校验**

Run: `node -e "const fs=require('fs'); if(!fs.readFileSync('index.html','utf8').includes('records.html')) throw new Error('缺入口'); if(!fs.readFileSync('css/style.css','utf8').includes('#records-link')) throw new Error('缺样式'); console.log('entry OK')"`
Expected: 输出 `entry OK`

- [ ] **Step 4: 提交**

```bash
git add index.html css/style.css
git commit -m "feat(index): records center entry in topbar"
```

---

## 验收 / 收尾

- [ ] **全量纯函数测试**

```bash
node test-activity.mjs && node test-records.mjs && node test-sim.mjs >/dev/null && node test-world.mjs >/dev/null && node test-board.mjs >/dev/null && node test-feed.mjs >/dev/null && node test-minutes.mjs >/dev/null && echo "ALL GREEN"
cd sidecar && node --test 2>&1 | grep -E "# (pass|fail)"
```
Expected: `ALL GREEN` + sidecar 全过（本计划不改 sidecar，应无回归）。

- [ ] **浏览器人工验证（沙箱无头跑不动则如实标注为环境限制，真机可用）**
  1. `cd sidecar && npm start`，浏览器开 `http://127.0.0.1:7878/records.html`：四个分类都能切换；看板/人物/动态显示已有数据；纪要显示已有产出物（若已开过会）。
  2. 另开标签页跑 `http://127.0.0.1:7878/`（模拟）；回到记录页，看板/动态/人物随模拟推进自动刷新（storage 事件）；纪要在开完会 ~5s 内出现新条目（轮询）。
  3. 用 `npx http-server`（无 sidecar）打开 records.html：纪要分类显示「需从 sidecar 打开」，其余三类正常。
  4. index.html 顶栏 📑 能跳转，records 顶部「← 返回办公室」能回去。

- [ ] **最终审查后合并**：feature 分支跑完 final review（spec 覆盖 + 质量），再本地合 main + push。

---

## Self-Review（对照 spec）

**Spec 覆盖：**
- 四分类（看板/纪要/人物/动态）→ Task 6 renderBoard/renderMinutes/renderPeople/renderActivity ✅
- 左分类栏 + 右大面板 + 二级列表 → Task 5 骨架 + Task 6 sublist ✅
- 动态持久化（原临时 DOM）→ Task 1 activityLog + Task 2 main.js 接入 ✅
- 实时更新（storage 事件 + sidecar 轮询）→ Task 6 storage 监听 + minutes 轮询 ✅
- 只读直解析、不 import 有状态类 → Task 3/6 parse* + readBoard/readMemories，仅 import store(只读)/board 纯函数/activityLog ✅
- 纪要依赖 sidecar、离线降级提示 → Task 6 renderMinutes 的 online 分支 ✅
- 入口 + 返回链接 → Task 5 rc-back + Task 7 records-link ✅
- 转义防注入 → Task 4 escapeHtml 贯穿所有渲染 ✅
- 响应式窄屏 → Task 5 css @media ✅

**明确不做（YAGNI，spec 第 8 节）：** 不内嵌 3D、不编辑/删除/导出、不全文搜索、不改 sidecar、不持久化 agent.say 气泡。

**Placeholder 扫描：** 无 TBD；每步含完整代码/命令。Task 7 Step 2 因 style.css 的 `#admin-link` 出现处需实地 grep 确认，已给出确切操作（逐处追加 `, #records-link`）而非占位。
**类型一致性：** localStorage 键 `huaxiang.board.v1`/`huaxiang.memories.v1`/`huaxiang.activity.v1` 在 activityLog/records/storage 监听中一致；纯函数签名（parseBoard/parseMemories/groupActivityByDay/groupMinutesByDay/collectPersonSummaries/sortMemoriesDesc/escapeHtml/renderBoardDay(dayObj,nameOf)/renderMinuteCard(a)/renderMemoryItem(m)）在 Task 3/4 定义、Task 6 消费、测试断言三处一致。artifact 形状 `{day,content,meta:{zone,phase,decisions,risks,actionItems}}` 与 P3a 产出一致。
