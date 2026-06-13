# P3c：每日计划（plan.js）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个 Agent 每天开工时基于「昨日反思 + 今晨快照（事件/政策/仓库摘要/昨夜市场反馈）+ 名下未完成行动项」给自己定当日计划（intentions），存为高权重记忆并挂在 agent 上；协作配对优先取计划里的 collab 意图（随机配对降为兜底），协作场景携带该意图。

**Architecture:** 新增纯函数模块 `js/cognition/plan.js`（计划输出归一化 + 协作配对选取）。`LLMClient` 新增 `dailyPlan()`。`director.js` 在每日开工（broadcastDaily 之后）为每人跑一次计划生成，`maybeStartCollab` 先从计划里找 collab 配对、找不到再随机。全程降级：LLM 不可用/economy 档不跑计划，协作回退纯随机；与 sidecar 无关。

**Tech Stack:** 浏览器原生 ESM；测试沿用根目录 `node test-*.mjs`（纯断言）。

参照设计 spec：`docs/superpowers/specs/2026-06-12-reality-link-design.md`（plan.js 第 111-122 行）。依赖 P3b 的 `actionItems.openFor(owner)` 与既有反思记忆（type=reflect）。

---

## 文件结构

- `js/cognition/plan.js`（新建）：`normalizePlan` / `planSummaryText` / `findCollabPair` 纯函数
- `js/llm.js`（修改）：新增 `dailyPlan()`
- `js/director.js`（修改）：新增 `runDailyPlans()` + 开工触发 + `broadcastDaily` 捕获昨夜市场反馈文本 + `maybeStartCollab` 优先用计划配对并把意图带进场景
- `test-plan.mjs`（新建）、`test-plan-loop.mjs`（新建）：纯函数 + director 集成单测

无需改 `main.js`（director 已持有 llm/world/feed/actionItems/agents）。

---

## Task 1：plan.js — 计划归一化与协作配对

**Files:**
- Create: `js/cognition/plan.js`
- Test: `test-plan.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-plan.mjs`）

```js
import { normalizePlan, planSummaryText, findCollabPair } from "./js/cognition/plan.js";

// normalizePlan：合法对象，slot/kind 校验，截断 3 条
const p = normalizePlan({ intentions: [
  { slot: "上午", what: "查限速 TODO", with: null, kind: "investigate" },
  { slot: "下午", what: "找王强对带宽方案", with: "王强", kind: "collab" },
  { slot: "晚上", what: "非法 slot 归全天", with: "", kind: "badkind" },
  { slot: "上午", what: "第四条应被截断", with: null, kind: "build" }
]});
if (p.intentions.length !== 3) throw new Error("应截断到 3 条");
if (p.intentions[2].slot !== "全天") throw new Error("非法 slot 应归全天");
if (p.intentions[2].kind !== "build") throw new Error("非法 kind 应归 build");
if (p.intentions[1].with !== "王强" || p.intentions[1].kind !== "collab") throw new Error("collab 意图应保留");
if (p.intentions[0].with !== null) throw new Error("无 with 应为 null");

// normalizePlan：空 what 过滤；JSON 字符串（带围栏）；脏输入空
if (normalizePlan({ intentions: [{ what: "" }] }).intentions.length !== 0) throw new Error("空 what 应过滤");
const p2 = normalizePlan('```json\n{"intentions":[{"slot":"上午","what":"写测试","kind":"build"}]}\n```');
if (p2.intentions[0].what !== "写测试") throw new Error("应解析围栏 JSON");
if (normalizePlan("garbage").intentions.length !== 0) throw new Error("脏输入应空");
if (normalizePlan(null).intentions.length !== 0) throw new Error("null 应空");

// planSummaryText
const t = planSummaryText(p);
if (!t.includes("上午：查限速 TODO") || !t.includes("（找王强）")) throw new Error("摘要格式不对");
if (planSummaryText({ intentions: [] }) !== "") throw new Error("空计划摘要应为空串");

// findCollabPair：A 的 collab 意图指向 B，且 B 在候选里 → 返回 {visitor:A, host:B, topic}
const A = { persona: { name: "王强" }, plan: { intentions: [{ kind: "collab", with: "李雷", what: "对带宽方案" }] } };
const B = { persona: { name: "李雷" }, plan: { intentions: [] } };
const C = { persona: { name: "韩梅" }, plan: null };
const pair = findCollabPair([A, B, C], ag => ag.plan);
if (!pair || pair.visitor !== A || pair.host !== B) throw new Error("应配出 A→B");
if (pair.topic !== "对带宽方案") throw new Error("应带上话题");

// findCollabPair：with 指向不在候选里的人 → null
const D = { persona: { name: "王强" }, plan: { intentions: [{ kind: "collab", with: "不在场", what: "x" }] } };
if (findCollabPair([D, B], ag => ag.plan) !== null) throw new Error("with 不在候选应返回 null");
// 无人有 collab 意图 → null
if (findCollabPair([B, C], ag => ag.plan) !== null) throw new Error("无 collab 意图应 null");

console.log("plan OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-plan.mjs`
Expected: FAIL — `Cannot find module ... plan.js`

- [ ] **Step 3: 实现 plan.js**（新建 `js/cognition/plan.js`）

```js
// 纯函数：把模型输出的每日计划归一化为 {intentions}，渲染摘要，并从一组 agent 的计划里
// 找一对协作意图。供 llm.dailyPlan() 与 director 复用。

const SLOTS = ["上午", "下午", "全天"];
const KINDS = ["investigate", "collab", "build", "review", "ops", "rest"];

/** 归一化模型输出（对象或 JSON 字符串，可带 ```json 围栏）→ {intentions:[{slot,what,with,kind}]}。 */
export function normalizePlan(raw) {
  let o = raw;
  if (typeof raw === "string") {
    const clean = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    try { o = JSON.parse(clean); } catch { return { intentions: [] }; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { intentions: [] };
  const arr = Array.isArray(o.intentions) ? o.intentions : [];
  const intentions = arr.map(it => ({
    slot: SLOTS.includes(it?.slot) ? it.slot : "全天",
    what: String(it?.what || "").trim().slice(0, 50),
    with: it?.with ? String(it.with).trim().slice(0, 20) : null,
    kind: KINDS.includes(it?.kind) ? it.kind : "build"
  })).filter(it => it.what).slice(0, 3);
  return { intentions };
}

/** 渲染计划为一行摘要（存记忆 / 展示用）。 */
export function planSummaryText(plan) {
  if (!plan || !Array.isArray(plan.intentions) || plan.intentions.length === 0) return "";
  return plan.intentions.map(i => `${i.slot}：${i.what}${i.with ? `（找${i.with}）` : ""}`).join("；");
}

/**
 * 从一组候选 agent 的计划里找一对协作意图：某 A 有 kind=collab 且 with=B，且 B 也在候选里。
 * @param {Array} candidates agent 列表（需有 persona.name）
 * @param {(agent)=>plan|null} planOf 取某 agent 当前计划
 * @returns {{visitor, host, topic}|null}
 */
export function findCollabPair(candidates, planOf) {
  for (const a of candidates) {
    const plan = planOf(a);
    if (!plan || !Array.isArray(plan.intentions)) continue;
    const want = plan.intentions.find(i => i.kind === "collab" && i.with);
    if (!want) continue;
    const host = candidates.find(b => b !== a && b.persona?.name === want.with);
    if (host) return { visitor: a, host, topic: want.what };
  }
  return null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-plan.mjs`
Expected: PASS — 输出 `plan OK`

- [ ] **Step 5: 提交**

```bash
git add js/cognition/plan.js test-plan.mjs
git commit -m "feat(cognition): daily plan normalize + collab pairing"
```

---

## Task 2：LLMClient.dailyPlan()

**Files:**
- Modify: `js/llm.js`

无独立单测（解析健壮性已由 Task 1 覆盖；本方法是薄封装，Task 3 集成测试用桩 llm 验证）。

- [ ] **Step 1: 顶部引入 normalizePlan**

在 `js/llm.js` 顶部已有的 `import { normalizeMarketReaction } from "./cognition/market.js";` 之后追加：

```js
import { normalizePlan } from "./cognition/plan.js";
```

- [ ] **Step 2: 新增 dailyPlan() 方法**

在 `js/llm.js` 的 `marketReaction()` 方法之后、`async test()` 之前插入：

```js
  /**
   * 每日计划：以某角色身份给今天定 1~3 条 intentions。
   * @param {object} opts { persona, company, reflection, snapshot, openItems: string[] }
   * @returns {Promise<{intentions}|null>} 失败/不可用返回 null
   */
  async dailyPlan({ persona, company, reflection, snapshot, openItems = [] }) {
    if (!this.available) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}），性格：${persona.personality || "暂无"}。` +
          (company ? `公司背景：${company}\n` : "") +
          `现在是早上开工，请给自己定今天的计划。结合昨日反思、今晨情况和你名下没做完的事，` +
          `只输出 JSON：{"intentions":[{"slot":"上午/下午/全天","what":"具体一件事","with":"要找的同事名或null","kind":"investigate/collab/build/review/ops/rest"}]}。` +
          `最多 3 条、要具体可执行；需要协作就把 with 填同事名、kind 设 collab。不要输出 JSON 以外的任何文字。`;
        const user =
          (reflection ? `昨日反思：${reflection}\n` : "") +
          (snapshot ? `今晨情况：\n${snapshot}\n` : "") +
          (openItems.length ? `你名下未完成的行动项：\n${openItems.map(s => "- " + s).join("\n")}\n` : "");
        const raw = await this.chatRaw(system, user, 500);
        this.lastError = null;
        return normalizePlan(raw);
      } catch (e) {
        console.warn("每日计划生成失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }
```

- [ ] **Step 3: 冒烟**

Run: `node -e "import('./js/llm.js').then(()=>console.log('llm.js ok'))"`
Expected: 输出 `llm.js ok`

- [ ] **Step 4: 提交**

```bash
git add js/llm.js
git commit -m "feat(llm): dailyPlan structured call"
```

---

## Task 3：director.js — 开工生成计划 + 协作优先用计划

**Files:**
- Modify: `js/director.js`
- Test: `test-plan-loop.mjs`（新建）

- [ ] **Step 1: 写失败的集成测试**（新建 `test-plan-loop.mjs`）

```js
import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";
import { findCollabPair } from "./js/cognition/plan.js";

function memAgent(name, zone) {
  return {
    persona: { id: name, name, role: "工程师", zone, personality: "踏实", lines: { meeting: ["占位"], collab: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("pl-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [{ text: "夸克搞活动" }], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubLLM = {
  available: true, enabled: true, usage: "standard",
  async dailyPlan({ persona, openItems }) {
    return { intentions: [
      { slot: "上午", what: `推进 ${openItems[0] || "日常"}`, with: null, kind: "investigate" },
      { slot: "下午", what: "对带宽方案", with: persona.name === "王强" ? "李雷" : null, kind: persona.name === "王强" ? "collab" : "build" }
    ]};
  }
};
const stubFeed = { activePolicies: () => ["全员降本"], takeEvents: () => [] };

// 用真实 ActionItemStore 提供 openFor
const { ActionItemStore, newActionItem } = await import("./js/cognition/actionItems.js");
const store = new ActionItemStore(); store.items = [];
store.add(newActionItem({ what: "评估带宽方案", owner: "王强", zone: "rd", day: 1, devDays: 1 }));

const agents = [memAgent("王强", "rd"), memAgent("李雷", "rd")];
const dir = new Director(agents, {}, () => {}, stubLLM, stubWorld, stubFeed, null, store);

// 1) runDailyPlans：每人挂上 plan + 写入 plan 记忆
await dir.runDailyPlans();
// 等待微任务链（stub 是同步 resolve 的 promise）
await Promise.resolve(); await Promise.resolve();
if (!agents[0].plan || agents[0].plan.intentions.length !== 2) throw new Error("王强应挂上 2 条意图的计划");
if (agents[0].plan.day !== 1) throw new Error("计划应标当日");
if (!agents[0].plan.intentions[0].what.includes("评估带宽方案")) throw new Error("计划应消费 openFor 行动项");
const planMem = agents[0].memory.items.filter(m => m.type === "plan");
if (planMem.length !== 1 || !planMem[0].c.includes("今日计划")) throw new Error("应写一条 plan 记忆");

// 2) 计划里的 collab 意图能被 findCollabPair 选出（王强→李雷）
const pair = findCollabPair(agents, a => a.plan?.day === dir.day ? a.plan : null);
if (!pair || pair.host.persona.name !== "李雷") throw new Error("应从计划配出 王强→李雷");

console.log("plan loop OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-plan-loop.mjs`
Expected: FAIL — `dir.runDailyPlans is not a function`

- [ ] **Step 3: 接通 director**

3a. **顶部 import**。`js/director.js` 顶部 `import { newActionItem } from "./cognition/actionItems.js";` 之后追加：

```js
import { findCollabPair, planSummaryText } from "./cognition/plan.js";
```

3b. **构造体加 `todayMarketFeedback` 字段**。在构造函数里 `this.pendingMarketFeedback = [];` 之后追加：

```js
    this.todayMarketFeedback = [];      // 昨夜市场反馈文本（供今日计划快照）
```

3c. **`broadcastDaily` 捕获昨夜反馈文本**。在 `broadcastDaily` 末尾 P3b 加的反馈块里，把：

```js
      const ready = this.pendingMarketFeedback.filter(f => f.day < this.day);
      for (const f of ready) {
        this.log(`💬 市场反馈：${f.text}`, "log-meeting");
        for (const a of this.agents) this.remember(a, `市场反馈：${f.text}`, 7, "world");
      }
      this.pendingMarketFeedback = this.pendingMarketFeedback.filter(f => f.day >= this.day);
```

改为（多存一份纯文本给计划快照用）：

```js
      const ready = this.pendingMarketFeedback.filter(f => f.day < this.day);
      this.todayMarketFeedback = ready.map(f => f.text);
      for (const f of ready) {
        this.log(`💬 市场反馈：${f.text}`, "log-meeting");
        for (const a of this.agents) this.remember(a, `市场反馈：${f.text}`, 7, "world");
      }
      this.pendingMarketFeedback = this.pendingMarketFeedback.filter(f => f.day >= this.day);
```

3d. **新增 `runDailyPlans` + `lastReflection`**。在 `runMarketReaction` 方法之后插入：

```js
  /** 每日开工：每人基于反思+今晨快照+名下未完成行动项定计划，挂到 agent 并写高权重记忆。 */
  runDailyPlans() {
    if (!this.llm?.enabled || this.llm.usage === "economy") return;
    const company = this.world?.companyBrief?.();
    const policies = this.feed?.activePolicies?.() ?? [];
    const snapshot = [
      this.world?.metricsSummary?.(),
      this.world?.todayEvents?.length ? "今日动态：" + this.world.todayEvents.map(e => e.text).join("；") : "",
      this.todayMarketFeedback?.length ? "昨夜市场反馈：" + this.todayMarketFeedback.join("；") : "",
      policies.length ? "现行政策：" + policies.join("；") : "",
      this.repoDigest ? "代码近况：" + this.repoDigest : ""
    ].filter(Boolean).join("\n");
    const day = this.day;
    for (const a of this.agents) {
      if (!a.memory) continue;
      const reflection = lastReflection(a);
      const openItems = (this.actionItems?.openFor(a.persona.name) ?? []).map(i => i.what);
      this.llm.dailyPlan({ persona: a.persona, company, reflection, snapshot, openItems })
        .then(plan => {
          if (!plan || !plan.intentions.length) return;
          a.plan = { ...plan, day };
          this.remember(a, `今日计划：${planSummaryText(plan)}`, 7, "plan");
        })
        .catch(() => {});
    }
  }
```

并在文件底部模块作用域（`fmtDelta` 函数附近）追加：

```js
function lastReflection(agent) {
  const items = agent.memory?.items?.filter(m => m.type === "reflect") ?? [];
  const last = items[items.length - 1];
  return last ? String(last.c).replace(/^今日反思：/, "") : "";
}
```

3e. **开工触发**。两处调用 `this.runDailyPlans()`：
- 构造函数末尾 `this.broadcastDaily();` 改为：
  ```js
    this.broadcastDaily();
    this.runDailyPlans();
  ```
- `update(dt)` 日终块里 `this.refreshRepoState().then(() => this.broadcastDaily());` 改为：
  ```js
      this.refreshRepoState().then(() => { this.broadcastDaily(); this.runDailyPlans(); });
  ```

- [ ] **Step 4: 运行确认通过**

Run: `node test-plan-loop.mjs`
Expected: PASS — 输出 `plan loop OK`

- [ ] **Step 5: 回归**

Run: `node test-sim.mjs >/dev/null && node test-market-loop.mjs >/dev/null && node test-minutes.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（无 llm 的 StubAgent 路径下 `runDailyPlans` 因 `this.llm?.enabled` 为假 no-op）

- [ ] **Step 6: 提交**

```bash
git add js/director.js test-plan-loop.mjs
git commit -m "feat(director): generate daily plans at workday start"
```

---

## Task 4：director.js — 协作优先用计划意图

**Files:**
- Modify: `js/director.js`

无新单测（`findCollabPair` 的选取逻辑已由 Task 1 纯函数测试覆盖；本任务是把它接进 `maybeStartCollab`，行为靠回归测试与人工验证）。

- [ ] **Step 1: 改 `maybeStartCollab` 的人选与场景**

`js/director.js` 的 `maybeStartCollab` 中，把：

```js
    if (free.length < 2) return;
    const visitor = pick(free);
    const host = pick(free.filter(a => a !== visitor));
    if (!host) return;
```

改为（先从计划里找 collab 配对，找不到再随机；记下话题）：

```js
    if (free.length < 2) return;
    let visitor, host, planTopic = "";
    const pair = findCollabPair(free, a => (a.plan?.day === this.day ? a.plan : null));
    if (pair) {
      visitor = pair.visitor; host = pair.host; planTopic = pair.topic || "";
    } else {
      visitor = pick(free);
      host = pick(free.filter(a => a !== visitor));
    }
    if (!host) return;
```

- [ ] **Step 2: 场景携带意图**

`maybeStartCollab` 中的 `sceneBase` 这一行：

```js
    const sceneBase = `工位旁的工作讨论：${visitor.persona.name} 走到 ${host.persona.name} 的工位。结合你记得的事情聊一个具体话题。`;
```

改为（有计划话题时带上）：

```js
    const sceneBase = `工位旁的工作讨论：${visitor.persona.name} 走到 ${host.persona.name} 的工位。` +
      (planTopic ? `${visitor.persona.name}今天本就计划找人聊「${planTopic}」。` : "") +
      `结合你记得的事情聊一个具体话题。`;
```

- [ ] **Step 3: 语法校验 + 回归**

Run: `node --check js/director.js && node test-sim.mjs >/dev/null && node test-plan-loop.mjs >/dev/null && node test-market-loop.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（StubAgent 无 `.plan` 时 `findCollabPair` 返回 null，回退随机，行为不变）

- [ ] **Step 4: 提交**

```bash
git add js/director.js
git commit -m "feat(director): collaboration pairing prefers daily-plan intentions"
```

---

## 验收 / 收尾

- [ ] **全量测试**

```bash
node test-plan.mjs && node test-plan-loop.mjs && node test-actionitems.mjs && node test-market.mjs && node test-market-loop.mjs && node test-world.mjs >/dev/null && node test-sim.mjs >/dev/null && node test-minutes.mjs >/dev/null && node test-board.mjs >/dev/null && node test-feed.mjs >/dev/null && node test-agent.mjs >/dev/null && node test-records.mjs >/dev/null && node test-activity.mjs >/dev/null && echo "ALL GREEN"
cd sidecar && node --test 2>&1 | grep -E "# (pass|fail)"
```
Expected: `ALL GREEN` + sidecar 全过（本计划不改 sidecar）。

- [ ] **降级冒烟（人工说明，沙箱跑不动真机/真 LLM 则如实标注环境限制）**
  - LLM 不可用/economy：`runDailyPlans` no-op，agent 无 `.plan`，`maybeStartCollab` 的 `findCollabPair` 返回 null 回退纯随机——行为退回 P3b 现状。
  - 无 actionItems：`openFor` 经 `?? []` 安全，计划照常生成（只是无未完成项输入）。

- [ ] **最终审查后合并**：feature 分支跑完 final review（spec 覆盖 + 质量），再本地合 main + push。

---

## Self-Review（对照 spec）

**Spec 覆盖（设计文档第 111-122 行）：**
- 每天开工每人 1 次调用 → Task 3 `runDailyPlans` 在 broadcastDaily 后触发（构造 + 日终）✅
- 输入：画像 + 昨日反思 + 今晨快照（真实事件/政策/仓库摘要/昨夜市场反馈）+ 名下未完成行动项 → Task 3 snapshot 拼装 + `lastReflection` + `actionItems.openFor` ✅
- 输出 intentions `[{slot,what,with,kind}]` → Task 1 `normalizePlan` ✅
- 计划存为高权重记忆并挂在 agent 上 → Task 3 `a.plan = {...}` + `remember(..., 7, "plan")` ✅
- 协作配对从 intentions 优先取、随机降为兜底 → Task 1 `findCollabPair` + Task 4 `maybeStartCollab` ✅
- 发言场景携带当前意图 → Task 4 `planTopic` 拼进 `sceneBase` ✅

**本阶段明确不做（YAGNI）：** 计划在记录页/3D 的专门可视化（记录页"人物"已显示 type=plan 记忆）；会议发言全面携带意图（仅协作场景带，足够体现）；P3d 的反思树/突发反应/converse 多轮。

**Placeholder 扫描：** 无 TBD；每步含完整代码与命令。
**类型一致性：** 计划形状 `{intentions:[{slot,what,with,kind}]}` 在 plan.js/llm.dailyPlan/director/测试一致；`findCollabPair(candidates, planOf)→{visitor,host,topic}` 在 plan.js/director/测试一致；agent 上挂 `a.plan = {intentions, day}`，`findCollabPair` 的 planOf 用 `a.plan?.day === this.day` 守卫只取当日计划。
