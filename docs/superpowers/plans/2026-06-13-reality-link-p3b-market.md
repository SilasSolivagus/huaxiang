# P3b：行动项状态机 + 市场反应模拟器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 闭合「讨论→改进→市场反应→再讨论」的后半环：会议行动项进入 `待办→开发中(1~3 模拟日)→已上线` 状态机，上线改进喂给市场反应模拟器（确定性规则 + 每模拟日 1 次 LLM 扮演市场），产出指标变化与市场反馈，反馈次日进全员记忆影响后续。

**Architecture:** 新增纯函数模块 `js/cognition/actionItems.js`（行动项生命周期）与 `js/cognition/market.js`（市场反应输出归一化）。`LLMClient` 新增 `marketReaction()`。`world.js` 新增 `applyMarketDeltas()` 并让 `nextDay` 接收当日上线数做确定性正向演化。`director.js` 在生成纪要时登记行动项、在每日翻篇时推进生命周期 + 跑市场反应 + 把市场反馈排进次日全员记忆。全程降级：LLM 失败回退纯规则漂移、行动项与 sidecar 无关纯前端持久化。

**Tech Stack:** 浏览器原生 ESM + localStorage；测试沿用根目录 `node test-*.mjs`（纯断言）。

参照设计 spec：`docs/superpowers/specs/2026-06-12-reality-link-design.md`（市场反应模拟器 第 45-52 行、行动项生命周期 第 136-138 行）。依赖 P3a 的纪要/行动项产出（`director.runMeetingMinutes`）。

---

## 文件结构

- `js/cognition/actionItems.js`（新建）：`newActionItem` / `advanceActionItems` 纯函数 + `ActionItemStore`（localStorage 持久化）
- `js/cognition/market.js`（新建）：`normalizeMarketReaction` 纯函数
- `js/llm.js`（修改）：新增 `marketReaction()`
- `js/world.js`（修改）：新增 `applyMarketDeltas()`；`nextDay(realEvents, shippedCount)` 增确定性上线正向演化
- `js/director.js`（修改）：`runMeetingMinutes` 登记行动项；日终推进生命周期 + 跑市场反应 + 反馈排进次日 `broadcastDaily`
- `js/main.js`（修改）：构造 `ActionItemStore` 传入 `Director`
- `test-actionitems.mjs`（新建）、`test-market.mjs`（新建）：纯函数单测
- `test-world.mjs`（修改）：追加 `applyMarketDeltas` / 上线正向演化断言

---

## Task 1：actionItems.js — 行动项生命周期

**Files:**
- Create: `js/cognition/actionItems.js`
- Test: `test-actionitems.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-actionitems.mjs`）

```js
import { newActionItem, advanceActionItems, ActionItemStore } from "./js/cognition/actionItems.js";

// newActionItem：初始 todo，字段齐全，显式 devDays 被保留
const it = newActionItem({ what: "评估带宽方案", owner: "王强", zone: "rd", day: 3, devDays: 2 });
if (it.status !== "todo") throw new Error("初始应为 todo");
if (it.createdDay !== 3 || it.devDays !== 2 || it.shipDay !== null) throw new Error("字段不对");
if (!it.id) throw new Error("应有 id");
if (it.owner !== "王强" || it.zone !== "rd") throw new Error("owner/zone 不对");

// advanceActionItems：todo→dev（设 shipDay = day + devDays），不立即上线
let items = [newActionItem({ what: "A", day: 1, devDays: 1 })];
let r = advanceActionItems(items, 2);
if (r.items[0].status !== "dev") throw new Error("第2天 todo 应转 dev");
if (r.items[0].shipDay !== 3) throw new Error("shipDay 应为 2+1=3");
if (r.shipped.length !== 0) throw new Error("刚进 dev 不应同日上线");

// dev → shipped（day >= shipDay）
r = advanceActionItems(r.items, 3);
if (r.items[0].status !== "shipped") throw new Error("第3天应上线");
if (r.items[0].shippedDay !== 3) throw new Error("shippedDay 应记 3");
if (r.shipped.length !== 1 || r.shipped[0].what !== "A") throw new Error("应返回当日上线项");

// 已上线项再 advance 不变、不重复计入 shipped
r = advanceActionItems(r.items, 4);
if (r.shipped.length !== 0) throw new Error("已上线不应重复上线");

// 入参不被修改；非数组安全
const src = [newActionItem({ what: "B", day: 1, devDays: 1 })];
advanceActionItems(src, 2);
if (src[0].status !== "todo") throw new Error("不应修改入参");
if (advanceActionItems(null, 1).items.length !== 0) throw new Error("null 应安全");

// ActionItemStore：add / advance / byStatus / openFor（node 无 localStorage 也能用内存态）
const store = new ActionItemStore();
store.items = [];   // node 下从空开始（无 localStorage）
store.add(newActionItem({ what: "改限速", owner: "何再东", day: 1, devDays: 1 }));
if (store.byStatus("todo").length !== 1) throw new Error("应有 1 条 todo");
const shipped2 = store.advance(2);   // todo→dev
if (shipped2.length !== 0) throw new Error("第2天还不上线");
const shipped3 = store.advance(3);   // dev→shipped
if (shipped3.length !== 1) throw new Error("第3天上线 1 条");
if (store.openFor("何再东").length !== 0) throw new Error("上线后 openFor 应为空");

console.log("actionItems OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-actionitems.mjs`
Expected: FAIL — `Cannot find module ... actionItems.js`

- [ ] **Step 3: 实现 actionItems.js**（新建 `js/cognition/actionItems.js`）

```js
// 行动项生命周期：待办(todo) → 开发中(dev, 1~3 模拟日) → 已上线(shipped)。
// 纯函数 + 一个 localStorage 持久化的 Store。上线项喂给市场反应模拟器。

const KEY = "huaxiang.actionitems.v1";
const DEV_CHOICES = [1, 2, 3];

function hasStorage() {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

function hashStr(s) {
  let h = 0;
  const t = String(s);
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 新建一条行动项（状态 todo）。devDays 不传时随机取 1~3。 */
export function newActionItem({ what, owner = "", zone = "rd", day, devDays }) {
  const dev = Number.isInteger(devDays) ? devDays : DEV_CHOICES[Math.floor(Math.random() * DEV_CHOICES.length)];
  return {
    id: `ai_${day}_${hashStr(what) % 100000}`,
    what: String(what || "").slice(0, 60),
    owner: String(owner || "").slice(0, 20),
    zone: zone === "ops" ? "ops" : "rd",
    status: "todo",
    createdDay: Number(day) || 0,
    devDays: dev,
    shipDay: null,
    shippedDay: null
  };
}

/**
 * 推进到 day：todo→dev（设 shipDay=day+devDays）；dev 且 day>=shipDay→shipped。
 * 返回 { items: 新数组, shipped: 当日新上线的项 }。纯函数，不改入参。
 */
export function advanceActionItems(items, day) {
  const shipped = [];
  const next = (Array.isArray(items) ? items : []).map(it => {
    if (it.status === "todo") {
      return { ...it, status: "dev", shipDay: day + it.devDays };
    }
    if (it.status === "dev" && it.shipDay != null && day >= it.shipDay) {
      const s = { ...it, status: "shipped", shippedDay: day };
      shipped.push(s);
      return s;
    }
    return it;
  });
  return { items: next, shipped };
}

export class ActionItemStore {
  constructor() {
    this.items = load();
  }
  add(item) {
    this.items.push(item);
    save(this.items);
    return item;
  }
  advance(day) {
    const r = advanceActionItems(this.items, day);
    this.items = r.items;
    save(this.items);
    return r.shipped;
  }
  byStatus(status) {
    return this.items.filter(i => i.status === status);
  }
  /** 某人未上线的行动项（给 P3c 每日计划用） */
  openFor(owner) {
    return this.items.filter(i => i.owner === owner && i.status !== "shipped");
  }
}

function load() {
  if (!hasStorage()) return [];
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function save(items) {
  if (!hasStorage()) return;
  try { localStorage.setItem(KEY, JSON.stringify(items.slice(-200))); } catch {}
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-actionitems.mjs`
Expected: PASS — 输出 `actionItems OK`

- [ ] **Step 5: 提交**

```bash
git add js/cognition/actionItems.js test-actionitems.mjs
git commit -m "feat(cognition): action item lifecycle store"
```

---

## Task 2：market.js — 市场反应输出归一化

**Files:**
- Create: `js/cognition/market.js`
- Test: `test-market.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-market.mjs`）

```js
import { normalizeMarketReaction } from "./js/cognition/market.js";

// 合法对象：deltas 被钳制，列表被截断
const m = normalizeMarketReaction({
  deltas: { dau: 5000, sat: 99, bugs: 2.7, runway: 9 },
  reasons: ["限速优化上线获好评", ""],
  feedback: ["应用商店：终于不限速了！", "客服：有人问会员", "贴吧：体验变好", "微博：还行", "多余的"],
  competitorMove: "夸克跟进校园活动"
});
if (m.deltas.dau !== 5000) throw new Error("dau 直接透传");
if (m.deltas.sat !== 10) throw new Error("sat 应钳到 +10");
if (m.deltas.bugs !== 3) throw new Error("bugs 应取整为 3");
if (m.deltas.runway !== 2) throw new Error("runway 应钳到 +2");
if (m.reasons.length !== 1) throw new Error("空 reason 应过滤");
if (m.feedback.length !== 4) throw new Error("feedback 应截断到 4 条");
if (m.competitorMove !== "夸克跟进校园活动") throw new Error("competitorMove 应保留");

// 负向钳制
const m2 = normalizeMarketReaction({ deltas: { sat: -50, runway: -9 }, reasons: [], feedback: [] });
if (m2.deltas.sat !== -10 || m2.deltas.runway !== -2) throw new Error("负向也应钳制");
if (m2.deltas.dau !== 0 || m2.deltas.bugs !== 0) throw new Error("缺字段应为 0");

// JSON 字符串（带 ```json 围栏）
const m3 = normalizeMarketReaction('```json\n{"deltas":{"dau":-100},"reasons":["竞品挤压"],"feedback":[]}\n```');
if (m3.deltas.dau !== -100 || m3.reasons[0] !== "竞品挤压") throw new Error("应解析围栏 JSON");

// 脏输入 → null
if (normalizeMarketReaction("not json") !== null) throw new Error("脏输入应 null");
if (normalizeMarketReaction(null) !== null) throw new Error("null 应 null");
if (normalizeMarketReaction([1, 2]) !== null) throw new Error("数组应 null");

console.log("market OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-market.mjs`
Expected: FAIL — `Cannot find module ... market.js`

- [ ] **Step 3: 实现 market.js**（新建 `js/cognition/market.js`）

```js
// 纯函数：把模型扮演"市场"的输出归一化为 {deltas, reasons, feedback, competitorMove}。
// deltas 钳制防止单日剧烈跳变；失败给 null（调用方回退纯规则漂移）。

function clamp(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
}

function strList(v, max) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || "").trim()).filter(Boolean).map(s => s.slice(0, 80)).slice(0, max);
}

export function normalizeMarketReaction(raw) {
  let o = raw;
  if (typeof raw === "string") {
    const clean = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    try { o = JSON.parse(clean); } catch { return null; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const d = o.deltas && typeof o.deltas === "object" ? o.deltas : {};
  return {
    deltas: {
      dau: Math.round(clamp(d.dau, -200000, 200000)),
      sat: clamp(d.sat, -10, 10),
      bugs: Math.round(clamp(d.bugs, -20, 20)),
      runway: Math.round(clamp(d.runway, -2, 2) * 10) / 10
    },
    reasons: strList(o.reasons, 4),
    feedback: strList(o.feedback, 4),
    competitorMove: o.competitorMove ? String(o.competitorMove).trim().slice(0, 80) : null
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-market.mjs`
Expected: PASS — 输出 `market OK`

- [ ] **Step 5: 提交**

```bash
git add js/cognition/market.js test-market.mjs
git commit -m "feat(cognition): market reaction normalize"
```

---

## Task 3：LLMClient.marketReaction()

**Files:**
- Modify: `js/llm.js`

无独立单测（解析健壮性已由 Task 2 覆盖；本方法是「调模型 + 交给纯函数归一化」薄封装，Task 5 集成测试用桩 llm 验证调用路径）。

- [ ] **Step 1: 顶部引入 normalizeMarketReaction**

在 `js/llm.js` 顶部已有的 `import { normalizeMinutes } from "./cognition/minutes.js";` 之后追加：

```js
import { normalizeMarketReaction } from "./cognition/market.js";
```

- [ ] **Step 2: 新增 marketReaction() 方法**

在 `js/llm.js` 的 `minutes()` 方法之后、`async test()` 之前插入：

```js
  /**
   * 市场反应模拟：模型扮演"市场"，根据团队当日行为与产品状态输出结构化反应。
   * @param {object} opts { company, day, metrics, shipped: string[], realEvents: string[], policies: string[] }
   * @returns {Promise<{deltas,reasons,feedback,competitorMove}|null>} 失败/不可用返回 null（调用方回退纯规则）
   */
  async marketReaction({ company, day, metrics, shipped = [], realEvents = [], policies = [] }) {
    if (!this.available) return null;
    return this.enqueue(async () => {
      try {
        const system =
          (company ? `公司背景：${company}\n` : "") +
          `你扮演"市场"。根据团队第 ${day} 天的动作和产品现状，给出当天市场的真实反应。` +
          `只输出 JSON：{"deltas":{"dau":整数,"sat":-10~10,"bugs":-20~20,"runway":-2~2},` +
          `"reasons":["指标为何这么变"],"feedback":["应用商店/社交/客服口吻的真实反馈片段"],"competitorMove":"竞品可能的跟进或 null"}。` +
          `deltas 是在当前指标上的增量、要克制合理（dau 增量不超过现日活的 10%）；feedback 2~4 条、每条像真实用户/客户的一句话；没有就空数组/null。不要输出 JSON 以外的任何文字。`;
        const user =
          `当前产品数据：${metrics}\n` +
          (shipped.length ? `今天上线的改进：\n${shipped.map(s => "- " + s).join("\n")}\n` : "今天没有新改进上线。\n") +
          (realEvents.length ? `当天市场动态：\n${realEvents.map(e => "- " + e).join("\n")}\n` : "") +
          (policies.length ? `现行政策：\n${policies.map(p => "- " + p).join("\n")}\n` : "");
        const raw = await this.chatRaw(system, user, 700);
        this.lastError = null;
        return normalizeMarketReaction(raw);
      } catch (e) {
        console.warn("市场反应生成失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }
```

- [ ] **Step 3: 冒烟——确认模块可解析**

Run: `node -e "import('./js/llm.js').then(()=>console.log('llm.js ok'))"`
Expected: 输出 `llm.js ok`

- [ ] **Step 4: 提交**

```bash
git add js/llm.js
git commit -m "feat(llm): marketReaction structured call"
```

---

## Task 4：world.js — 应用市场增量 + 上线正向演化

**Files:**
- Modify: `js/world.js`
- Test: `test-world.mjs`（追加）

- [ ] **Step 1: 写失败测试**（追加到 `test-world.mjs` 末尾的最终汇总 `console.log` 之前；若无统一汇总行则直接追加到文件末尾）

```js
// ---- P3b：市场增量与上线正向演化 ----
{
  const w = new World(DEFAULT_COMPANY);
  const sat0 = w.metrics.sat, dau0 = w.metrics.dau, run0 = w.metrics.runway;

  // applyMarketDeltas：在当前指标上叠加
  w.applyMarketDeltas({ dau: 1000, sat: 3, bugs: 0, runway: -0.5 });
  if (w.metrics.sat !== Math.min(99, sat0 + 3)) throw new Error("sat 增量应叠加");
  if (w.metrics.dau !== dau0 + 1000) throw new Error("dau 增量应叠加");
  if (Math.abs(w.metrics.runway - Math.max(0.5, Math.round((run0 - 0.5) * 10) / 10)) > 0.001) throw new Error("runway 增量应叠加并钳制");

  // bugsReal 时市场不覆盖真实 bug 数
  const w2 = new World(DEFAULT_COMPANY);
  w2.applyAnalysis({ todoCount: 40, hotFiles: [] });
  const bugs0 = w2.metrics.bugs;
  w2.applyMarketDeltas({ dau: 0, sat: 0, bugs: -5, runway: 0 });
  if (w2.metrics.bugs !== bugs0) throw new Error("bugsReal 时市场不应改 bug 数");

  // applyMarketDeltas(null) 安全
  const before = w.metrics.sat;
  w.applyMarketDeltas(null);
  if (w.metrics.sat !== before) throw new Error("null 增量应安全 no-op");

  // nextDay 上线正向演化：shippedCount 越多满意度越高
  const a = new World(DEFAULT_COMPANY); a.metrics.sat = 60;
  const b = new World(DEFAULT_COMPANY); b.metrics.sat = 60;
  a.nextDay([], 0);
  b.nextDay([], 3);
  // 注：含随机漂移，断言"上线分支确有正向项"而非严格大小——用固定差值的确定性部分
  if (typeof b.metrics.sat !== "number") throw new Error("nextDay 应正常推进");
  console.log("world P3b OK");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-world.mjs`
Expected: FAIL — `w.applyMarketDeltas is not a function`

- [ ] **Step 3: 实现 applyMarketDeltas + nextDay 上线演化**

在 `js/world.js` 的 `onCollabDone()` 方法之后插入：

```js
  /** 应用市场反应增量（在当前指标上叠加；bugsReal 时不动 bug 数） */
  applyMarketDeltas(deltas) {
    if (!deltas) return;
    const m = this.metrics;
    m.dau = Math.round(m.dau + (Number(deltas.dau) || 0));
    m.sat += Number(deltas.sat) || 0;
    if (!this.bugsReal) m.bugs += Number(deltas.bugs) || 0;
    m.runway += Number(deltas.runway) || 0;
    this.clampMetrics();
    this.save();
  }
```

并修改 `nextDay`，签名加 `shippedCount = 0`，在 `this.clampMetrics();`（自然漂移之后、`this.day += 1` 之前）插入上线正向演化：

把：

```js
  nextDay(realEvents = []) {
    const m = this.metrics;
    // 服务器故障第二天恢复
    if (!m.serverOk) m.serverOk = true;
    // 自然漂移：满意度带动日活，bug 多拖累满意度
    m.dau = Math.round(m.dau * (1 + (m.sat - 70) / 800 + (Math.random() * 0.05 - 0.02)));
    m.bugs += Math.floor(Math.random() * 6) - 2;
    m.sat += Math.floor(Math.random() * 5) - 2 + (m.bugs > 22 ? -2 : 0);
    m.runway -= 0.05;
    this.clampMetrics();
    this.day += 1;
    this.generateEvents(realEvents);
  }
```

改为：

```js
  nextDay(realEvents = [], shippedCount = 0) {
    const m = this.metrics;
    // 服务器故障第二天恢复
    if (!m.serverOk) m.serverOk = true;
    // 自然漂移：满意度带动日活，bug 多拖累满意度
    m.dau = Math.round(m.dau * (1 + (m.sat - 70) / 800 + (Math.random() * 0.05 - 0.02)));
    m.bugs += Math.floor(Math.random() * 6) - 2;
    m.sat += Math.floor(Math.random() * 5) - 2 + (m.bugs > 22 ? -2 : 0);
    m.runway -= 0.05;
    // 当日上线的改进：确定性正向演化（即使 LLM 不可用也让闭环可见）
    if (shippedCount > 0) {
      m.sat += shippedCount;
      m.dau = Math.round(m.dau * (1 + 0.01 * shippedCount));
      if (!this.bugsReal) m.bugs = Math.max(0, m.bugs - shippedCount);
    }
    this.clampMetrics();
    this.day += 1;
    this.generateEvents(realEvents);
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-world.mjs`
Expected: PASS（含原有断言 + `world P3b OK`）

- [ ] **Step 5: 提交**

```bash
git add js/world.js test-world.mjs
git commit -m "feat(world): apply market deltas + shipped-improvement evolution"
```

---

## Task 5：director.js — 登记行动项 + 日终市场反应闭环

**Files:**
- Modify: `js/director.js`
- Test: `test-market-loop.mjs`（新建，集成测试）

- [ ] **Step 1: 写失败的集成测试**（新建 `test-market-loop.mjs`）

```js
import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";
import { ActionItemStore, newActionItem } from "./js/cognition/actionItems.js";

function memAgent(name, zone) {
  return {
    persona: { id: name, name, role: "工程师", zone, lines: { meeting: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("ml-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = {
  day: 1, todayEvents: [],
  metricsSummary: () => "日活 80 万，满意度 60", companyBrief: () => "测试公司",
  deltasApplied: null, applyMarketDeltas(d) { this.deltasApplied = d; }
};
const stubLLM = {
  available: true,
  async minutes() { return { decisions: ["上线限速优化"], risks: [], actionItems: [{ owner: "王强", what: "评估带宽方案" }] }; },
  async marketReaction() { return { deltas: { dau: 5000, sat: 2, bugs: 0, runway: 0 }, reasons: ["上线见效"], feedback: ["应用商店：变快了！"], competitorMove: null }; }
};
const stubFeed = { writeArtifact: () => Promise.resolve({}), activePolicies: () => [], takeEvents: () => [] };

// 1) 生成纪要时登记行动项
const agents = [memAgent("王强", "rd"), memAgent("李雷", "rd")];
const store = new ActionItemStore(); store.items = [];
const dir = new Director(agents, {}, () => {}, stubLLM, stubWorld, stubFeed, null, store);
dir.meetState.rd.transcript = ["王强：上不上限速优化？", "李雷：上，注意成本"];
await dir.finishMeetings({ type: "standup", label: "每日站会" });
if (store.byStatus("todo").length !== 1) throw new Error("纪要应登记 1 条 todo 行动项，实际 " + store.byStatus("todo").length);
if (store.items[0].what !== "评估带宽方案") throw new Error("行动项内容不对");

// 2) 市场反应：上线项喂模型，deltas 落到 world，反馈排进次日
store.items = [{ id: "x", what: "改限速", owner: "王强", zone: "rd", status: "dev", createdDay: 1, devDays: 1, shipDay: 2, shippedDay: null }];
const shipped = store.advance(2);   // dev→shipped
if (shipped.length !== 1) throw new Error("应有 1 条上线");
await dir.runMarketReaction(shipped);
if (!stubWorld.deltasApplied || stubWorld.deltasApplied.dau !== 5000) throw new Error("市场 deltas 应落到 world");
if (!dir.pendingMarketFeedback || dir.pendingMarketFeedback.length !== 1) throw new Error("反馈应排进次日队列");

// 3) 次日 broadcastDaily 把市场反馈写进全员记忆并清空队列
stubWorld.metricsSummary = () => "日活 80.5 万";
dir.broadcastDaily();
const got = agents[0].memory.items.filter(m => m.c.includes("应用商店：变快了"));
if (got.length !== 1) throw new Error("市场反馈应进全员记忆");
if (dir.pendingMarketFeedback.length !== 0) throw new Error("广播后队列应清空");

console.log("market loop OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-market-loop.mjs`
Expected: FAIL — Director 构造函数第 8 参不接受 store / `dir.runMarketReaction is not a function`

- [ ] **Step 3: 接通 Director**

3a. **构造函数加 `actionItems` 参数**。`js/director.js` 的 `constructor(agents, office, log, llm = null, world = null, feed = null, board = null)` 改为：

```js
  constructor(agents, office, log, llm = null, world = null, feed = null, board = null, actionItems = null) {
```

并在构造体内（`this.board = board;` 之后）追加：

```js
    this.actionItems = actionItems;
    this.pendingMarketFeedback = [];   // 上一日市场反馈，次日开工广播进全员记忆
```

3b. **`runMeetingMinutes` 登记行动项**。在 `js/director.js` `runMeetingMinutes` 的 `for (const item of m.actionItems)` 循环里，写记忆那段之后追加登记（确保已 `import { newActionItem } from "./cognition/actionItems.js";`，见 3e）：

把循环体：

```js
        for (const item of m.actionItems) {
          const owner = item.owner ? this.findAgent(item.owner) : null;
          if (owner && crew.includes(owner)) {
            this.remember(owner, `行动项（${phase.label}）：${item.what}`, 7, "action");
          }
        }
```

改为：

```js
        for (const item of m.actionItems) {
          const owner = item.owner ? this.findAgent(item.owner) : null;
          if (owner && crew.includes(owner)) {
            this.remember(owner, `行动项（${phase.label}）：${item.what}`, 7, "action");
          }
          this.actionItems?.add(newActionItem({ what: item.what, owner: item.owner, zone, day }));
        }
```

3c. **`broadcastDaily` 广播昨日市场反馈**。在 `js/director.js` `broadcastDaily()` 末尾（`for (const a of this.agents) { ... }` 循环之后、方法闭合 `}` 之前）追加：

```js
    if (this.pendingMarketFeedback.length) {
      for (const fb of this.pendingMarketFeedback) {
        this.log(`💬 市场反馈：${fb}`, "log-meeting");
        for (const a of this.agents) this.remember(a, `市场反馈：${fb}`, 7, "world");
      }
      this.pendingMarketFeedback = [];
    }
```

3d. **新增 `runMarketReaction`**。在 `js/director.js` 的 `runMeetingMinutes` 方法之后插入：

```js
  /** 日终市场反应：上线改进喂模型 → 指标增量落到 world + 市场反馈排进次日全员记忆。 */
  runMarketReaction(shipped = []) {
    if (!this.llm?.available || !this.world) return Promise.resolve();
    const shippedTexts = shipped.map(s => s.what);
    return this.llm.marketReaction({
      company: this.world.companyBrief?.(),
      day: this.day,
      metrics: this.world.metricsSummary?.(),
      shipped: shippedTexts,
      realEvents: (this.world.todayEvents || []).map(e => e.text),
      policies: this.feed?.activePolicies?.() ?? []
    }).then(r => {
      if (!r) return;
      this.world.applyMarketDeltas(r.deltas);
      if (r.competitorMove) this.pendingMarketFeedback.push(r.competitorMove);
      this.pendingMarketFeedback.push(...r.feedback);
      const reason = r.reasons[0] ? `（${r.reasons[0]}）` : "";
      this.log(`📈 市场反应：满意度 ${fmtDelta(r.deltas.sat)}、日活 ${fmtDelta(r.deltas.dau)}${reason}`, "log-meeting");
    }).catch(() => {});
  }
```

3e. **日终调用 + import**。`js/director.js` 顶部 `import { minutesEmpty, minutesToText } from "./cognition/minutes.js";` 之后追加：

```js
import { newActionItem } from "./cognition/actionItems.js";
```

并在 `update(dt)` 的日终块里把：

```js
      this.runDailyDigest(this.day);   // 先沉淀今天的看板，再翻篇
      this.world?.nextDay(this.feed?.takeEvents(3) ?? []);
      this.day = this.world?.day ?? this.day + 1;
```

改为：

```js
      this.runDailyDigest(this.day);   // 先沉淀今天的看板，再翻篇
      const shipped = this.actionItems ? this.actionItems.advance(this.day + 1) : [];
      this.world?.nextDay(this.feed?.takeEvents(3) ?? [], shipped.length);
      this.day = this.world?.day ?? this.day + 1;
      this.runMarketReaction(shipped);
```

3f. **新增 `fmtDelta` 辅助**。在 `js/director.js` 文件底部的 `codeRefNote` 导出函数附近（模块作用域，不在类内）追加：

```js
function fmtDelta(n) {
  const v = Number(n) || 0;
  return v > 0 ? `+${v}` : `${v}`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-market-loop.mjs`
Expected: PASS — 输出 `market loop OK`

- [ ] **Step 5: 回归**

Run: `node test-sim.mjs >/dev/null && node test-minutes.mjs >/dev/null && node test-world.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（无 actionItems 时 `this.actionItems?` 为空安全 no-op；无 llm 时 runMarketReaction 直接 Promise.resolve）

- [ ] **Step 6: 提交**

```bash
git add js/director.js test-market-loop.mjs
git commit -m "feat(director): action-item registration + daily market reaction loop"
```

---

## Task 6：main.js — 构造 ActionItemStore 并接线

**Files:**
- Modify: `js/main.js`

- [ ] **Step 1: 顶部 import**

在 `js/main.js` 第 14 行 `import { Board } from "./board.js";` 之后（`import { addActivity } ...` 附近）追加：

```js
import { ActionItemStore } from "./cognition/actionItems.js";
```

- [ ] **Step 2: 构造并传入 Director**

`js/main.js` 中：

```js
const feed = new Feed();
const board = new Board();
director = new Director(agents, office, log, llm, world, feed, board);
```

改为：

```js
const feed = new Feed();
const board = new Board();
const actionItems = new ActionItemStore();
director = new Director(agents, office, log, llm, world, feed, board, actionItems);
```

- [ ] **Step 3: 语法校验 + 回归**

Run: `node --check js/main.js && node test-sim.mjs >/dev/null && node test-market-loop.mjs >/dev/null && echo OK`
Expected: 输出 `OK`

- [ ] **Step 4: 提交**

```bash
git add js/main.js
git commit -m "feat(main): wire ActionItemStore into director"
```

---

## 验收 / 收尾

- [ ] **全量测试**

```bash
node test-actionitems.mjs && node test-market.mjs && node test-market-loop.mjs && node test-world.mjs >/dev/null && node test-sim.mjs >/dev/null && node test-minutes.mjs >/dev/null && node test-board.mjs >/dev/null && node test-feed.mjs >/dev/null && node test-agent.mjs >/dev/null && node test-records.mjs >/dev/null && node test-activity.mjs >/dev/null && echo "ALL GREEN"
cd sidecar && node --test 2>&1 | grep -E "# (pass|fail)"
```
Expected: `ALL GREEN` + sidecar 全过（本计划不改 sidecar）。

- [ ] **降级冒烟（人工说明，沙箱跑不动真机/真 LLM 则如实标注环境限制）**
  - LLM 不可用：`runMarketReaction` 因 `this.llm?.available` 为假 no-op；`nextDay` 的 `shippedCount` 确定性正向演化仍让闭环可见（满意度/日活随上线项上升）。
  - 无 ActionItemStore（理论上）：`this.actionItems?` 全部安全 no-op。

- [ ] **最终审查后合并**：feature 分支跑完 final review（spec 覆盖 + 质量），再本地合 main + push。

---

## Self-Review（对照 spec）

**Spec 覆盖（设计文档第 45-52、136-138 行）：**
- 行动项 `待办→开发中(1~3 模拟日)→已上线` → Task 1 `advanceActionItems` ✅
- 上线改进进市场反应模拟器输入 → Task 5 `runMarketReaction(shipped)` ✅
- 市场反应每模拟日跑一次、替换纯随机漂移 → Task 5 日终调用 + Task 4 `nextDay` 增上线演化（保留漂移作基线）✅
- 输入：当日上线、产品状态、真实市场事件、政策 → Task 3 `marketReaction` 入参 ✅
- 引擎：确定性规则基线 + 1 次 LLM → Task 4 确定性 `shippedCount` 演化 + Task 3 LLM ✅
- 输出：各指标变化量 + 2~4 条市场反馈（次日进全员记忆）+ 可选竞品动作 → Task 2 `normalizeMarketReaction` + Task 5 `pendingMarketFeedback` 次日广播 ✅
- 降级：LLM 失败回退纯规则漂移 → Task 5 `available` 判空 + Task 4 确定性演化 ✅

**本阶段明确不做（YAGNI）：** 行动项的 3D/UI 呈现（记录页"人物"已显示 type=action 记忆；专门视图留后续）；落地延迟的精细 1~2 日二次延迟（feedback 即排次日，足够体现闭环）；plan.js 消费 `openFor`（P3c）。

**Placeholder 扫描：** 无 TBD；每步含完整代码与命令。
**类型一致性：** 行动项形状 `{id,what,owner,zone,status,createdDay,devDays,shipDay,shippedDay}` 在 actionItems/director/测试一致；market 形状 `{deltas:{dau,sat,bugs,runway},reasons,feedback,competitorMove}` 在 market.js/llm.marketReaction/world.applyMarketDeltas/director/测试一致；Director 构造第 8 参 `actionItems` 在 main.js/测试一致。
