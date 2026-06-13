# P3d-1：反思树（reflect.js）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"下班一句话反思"升级为反思树：重要度累积超阈值的 Agent 从近期记忆提出 2~3 个问题，逐题生成带证据引用（记忆 id）的洞见，存为高权重反思记忆；反思本身也是带 id 的记忆，可被后续反思引用，形成层级。顺带修复"反思只有前 3 人生成"——改为全员入队。

**Architecture:** `memory.js` 给每条记忆加 `id`（证据引用用）并支持存 `evidence`。新增纯函数模块 `js/cognition/reflect.js`（触发判定 + 记忆带 id 格式化 + 问题/洞见解析）。`LLMClient` 用 `reflectQuestions` + `reflectInsight` 取代旧 `reflect`，且按批量语义入队（去掉 `available` 的 queueLen 早退）。`director.runReflections` 重写为反思树。降级：LLM 不可用不反思；无证据时洞见仍存（evidence 空）。

**Tech Stack:** 浏览器原生 ESM + localStorage；测试沿用根目录 `node test-*.mjs`。

参照设计 spec：`docs/superpowers/specs/2026-06-12-reality-link-design.md`（reflect.js 反思树 第 128-130 行）。

---

## 文件结构

- `js/memory.js`（修改）：记忆加 `id`（自增，构造时从已存记忆恢复 `_seq`）+ `add` 支持 `opts.evidence`
- `js/cognition/reflect.js`（新建）：`impSinceLastReflect` / `shouldReflect` / `formatMemoriesWithIds` / `parseQuestions` / `parseInsight` 纯函数
- `js/llm.js`（修改）：删除旧 `reflect`，新增 `reflectQuestions` + `reflectInsight`（批量入队语义）
- `js/director.js`（修改）：重写 `runReflections` 为反思树（全员、问题→逐题洞见→带证据存记忆）
- `test-reflect.mjs`（新建）：memory id/evidence + reflect 纯函数单测
- `test-reflect-tree.mjs`（新建）：director 反思树集成单测

---

## Task 1：memory.js — 记忆加 id 与 evidence

**Files:**
- Modify: `js/memory.js`
- Test: `test-reflect.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-reflect.mjs`，先只测 memory）

```js
import { MemoryStream } from "./js/memory.js";

// 记忆自增 id
const m = new MemoryStream("t-mem-1");
m.items = [];   // node 无 localStorage，从空开始
m.add("第一条", { importance: 5, day: 1, time: "09:00" });
m.add("第二条", { importance: 7, day: 1, time: "10:00" });
if (m.items[0].id == null || m.items[1].id == null) throw new Error("每条记忆应有 id");
if (m.items[1].id <= m.items[0].id) throw new Error("id 应自增");

// evidence 透传存储
m.add("反思：要稳住核心链路", { importance: 8, type: "reflect", day: 1, time: "18:00", evidence: [m.items[0].id, m.items[1].id] });
const reflect = m.items[2];
if (!Array.isArray(reflect.evidence) || reflect.evidence.length !== 2) throw new Error("evidence 应被存储");
if (!reflect.evidence.includes(m.items[0].id)) throw new Error("evidence 应含引用的记忆 id");

// 无 evidence 时不写该字段
if ("evidence" in m.items[0]) throw new Error("普通记忆不应带 evidence 字段");

console.log("memory id/evidence OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-reflect.mjs`
Expected: FAIL — `每条记忆应有 id`

- [ ] **Step 3: 实现 memory id + evidence**

`js/memory.js` 构造函数（`this._vec = new WeakMap();` 之后）追加从已存记忆恢复自增游标：

```js
    this._seq = this.items.reduce((mx, it) => Math.max(mx, it.id || 0), 0);
```

`add(content, opts = {})` 里把 push 的对象改为带 id，并在有 evidence 时附上。把：

```js
    this.items.push({
      c: String(content).slice(0, 120),
      imp: opts.importance ?? 3,
      type: opts.type || "obs",
      day: opts.day ?? 0,
      time: opts.time || "",
      t: simMinutes(opts.day ?? 0, opts.time || ""),
      at: Date.now()
    });
```

改为：

```js
    const item = {
      id: ++this._seq,
      c: String(content).slice(0, 120),
      imp: opts.importance ?? 3,
      type: opts.type || "obs",
      day: opts.day ?? 0,
      time: opts.time || "",
      t: simMinutes(opts.day ?? 0, opts.time || ""),
      at: Date.now()
    };
    if (Array.isArray(opts.evidence) && opts.evidence.length) item.evidence = opts.evidence.slice(0, 5);
    this.items.push(item);
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-reflect.mjs`
Expected: PASS — 输出 `memory id/evidence OK`

- [ ] **Step 5: 回归**（memory 改动影响面广）

Run: `node test-world.mjs >/dev/null && node test-board.mjs >/dev/null && node test-agent.mjs >/dev/null && node test-sim.mjs >/dev/null && node test-records.mjs >/dev/null && echo OK`
Expected: 输出 `OK`

- [ ] **Step 6: 提交**

```bash
git add js/memory.js test-reflect.mjs
git commit -m "feat(memory): per-item id + evidence field for reflection tree"
```

---

## Task 2：reflect.js — 反思树纯函数

**Files:**
- Create: `js/cognition/reflect.js`
- Test: `test-reflect.mjs`（追加）

- [ ] **Step 1: 追加失败测试**（在 `test-reflect.mjs` 末尾 `console.log("memory id/evidence OK")` 之前插入）

```js
import { impSinceLastReflect, shouldReflect, formatMemoriesWithIds, parseQuestions, parseInsight } from "./js/cognition/reflect.js";

// impSinceLastReflect：只累计最近一条 reflect 之后的重要度
const items = [
  { id: 1, imp: 7, type: "world", c: "a", day: 1 },
  { id: 2, imp: 8, type: "reflect", c: "旧反思", day: 1 },
  { id: 3, imp: 7, type: "world", c: "b", day: 2 },
  { id: 4, imp: 6, type: "action", c: "c", day: 2 }
];
if (impSinceLastReflect(items) !== 13) throw new Error("应只累计最后反思后的 7+6=13");
if (impSinceLastReflect([]) !== 0) throw new Error("空应为 0");

// shouldReflect 阈值
if (shouldReflect(items, 40) !== false) throw new Error("13 < 40 不应反思");
if (shouldReflect(items, 10) !== true) throw new Error("13 >= 10 应反思");

// formatMemoriesWithIds：带编号、过滤无 id、取最近 max 条
const fmt = formatMemoriesWithIds(items, 2);
if (!fmt.includes("[3]") || !fmt.includes("[4]")) throw new Error("应含最近两条编号");
if (fmt.includes("[1]")) throw new Error("超出 max 的旧条目不应出现");
if (formatMemoriesWithIds([{ imp: 5, c: "无id" }]) !== "") throw new Error("无 id 记忆应被过滤");

// parseQuestions
if (parseQuestions('["问题一","问题二","问题三","第四个超额"]').length !== 3) throw new Error("问题应截断到 3");
if (parseQuestions('["有效", ""]').length !== 1) throw new Error("空问题应过滤");
if (parseQuestions("garbage").length !== 0) throw new Error("脏输入应空");
if (parseQuestions("{}").length !== 0) throw new Error("非数组应空");

// parseInsight：洞见 + 证据（validIds 过滤越界引用）
const ins = parseInsight('{"insight":"先稳核心链路","evidence":[3,4,99]}', [3, 4]);
if (ins.insight !== "先稳核心链路") throw new Error("洞见文本不对");
if (ins.evidence.length !== 2 || ins.evidence.includes(99)) throw new Error("越界证据 id 应被过滤");
if (parseInsight('{"insight":""}') !== null) throw new Error("空洞见应 null");
if (parseInsight("garbage") !== null) throw new Error("脏输入应 null");
if (parseInsight('```json\n{"insight":"x","evidence":[]}\n```').insight !== "x") throw new Error("应解析围栏 JSON");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-reflect.mjs`
Expected: FAIL — `Cannot find module ... reflect.js`

- [ ] **Step 3: 实现 reflect.js**（新建 `js/cognition/reflect.js`）

```js
// 反思树纯函数：触发判定（重要度累积）、记忆带 id 格式化、问题/洞见解析（含证据 id 校验）。

export const REFLECT_THRESHOLD = 40;

function strip(raw) {
  return String(raw).replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
}

/** 自上次反思以来新记忆的重要度之和（遇到最近一条 reflect 即止）。 */
export function impSinceLastReflect(items) {
  const arr = Array.isArray(items) ? items : [];
  let sum = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].type === "reflect") break;
    sum += arr[i].imp || 0;
  }
  return sum;
}

/** 是否到达反思阈值。 */
export function shouldReflect(items, threshold = REFLECT_THRESHOLD) {
  return impSinceLastReflect(items) >= threshold;
}

/** 把记忆格式化为带编号的清单（供模型提问/引证）；过滤无 id、取最近 max 条。 */
export function formatMemoriesWithIds(items, max = 20) {
  return (Array.isArray(items) ? items : [])
    .filter(m => m.id != null)
    .slice(-max)
    .map(m => `[${m.id}] (第${m.day}天) ${m.c}`)
    .join("\n");
}

/** 解析模型问题输出 → 最多 3 个非空问题。 */
export function parseQuestions(raw) {
  let o = raw;
  if (typeof raw === "string") { try { o = JSON.parse(strip(raw)); } catch { return []; } }
  if (!Array.isArray(o)) return [];
  return o.map(x => String(x || "").trim()).filter(Boolean).map(s => s.slice(0, 60)).slice(0, 3);
}

/** 解析模型洞见输出 → {insight, evidence:[id]}；validIds 非空时过滤越界引用。失败给 null。 */
export function parseInsight(raw, validIds = null) {
  let o = raw;
  if (typeof raw === "string") { try { o = JSON.parse(strip(raw)); } catch { return null; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const insight = String(o.insight || "").trim().slice(0, 70);
  if (!insight) return null;
  let evidence = Array.isArray(o.evidence) ? o.evidence.map(Number).filter(Number.isFinite) : [];
  if (validIds) { const set = new Set(validIds); evidence = evidence.filter(id => set.has(id)); }
  return { insight, evidence: evidence.slice(0, 5) };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-reflect.mjs`
Expected: PASS — 输出 `memory id/evidence OK`

- [ ] **Step 5: 提交**

```bash
git add js/cognition/reflect.js test-reflect.mjs
git commit -m "feat(cognition): reflection tree pure helpers"
```

---

## Task 3：llm.js — reflectQuestions + reflectInsight（替换旧 reflect）

**Files:**
- Modify: `js/llm.js`

无独立单测（解析健壮性由 Task 2 覆盖；Task 4 集成测试用桩 llm 验证）。

- [ ] **Step 1: 顶部引入纯函数**

`js/llm.js` 顶部已有的 `import { normalizePlan } from "./cognition/plan.js";` 之后追加：

```js
import { parseQuestions, parseInsight } from "./cognition/reflect.js";
```

- [ ] **Step 2: 删除旧 reflect 方法**

删除 `js/llm.js` 中整个旧的 `async reflect({ persona, company, digest, day }) { ... }` 方法（从其 JSDoc 注释 `/** 每日反思：把当天经历提炼成 1~2 条感悟（高权重记忆） */` 到该方法闭合 `}`）。它仅被 `director.runReflections` 调用，本计划 Task 4 会改为不再调用。

- [ ] **Step 3: 新增 reflectQuestions + reflectInsight**

在删除位置（`digestDay` 之前或之后均可，建议紧接 `digestDay` 之后）插入：

```js
  /**
   * 反思树·第一步：从近期记忆提出 2~3 个值得想清楚的问题。批量语义：靠 enqueue 串行节流，全员都排队。
   * @param {object} opts { persona, company, memories: string }  memories 是带编号的记忆清单
   * @returns {Promise<string[]|null>}
   */
  async reflectQuestions({ persona, company, memories }) {
    if (!this.enabled || Date.now() < this.cooldownUntil || !memories) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}），性格：${persona.personality || "暂无"}。` +
          (company ? `公司背景：${company}\n` : "") +
          `下面是你最近记得的事（每条带编号）。请从中提出 2~3 个你最该想清楚的问题（关于工作、协作、产品方向）。` +
          `只输出 JSON 字符串数组，如 ["问题1","问题2"]。不要其他文字。`;
        const raw = await this.chatRaw(system, `你最近记得的事：\n${memories}`, 300);
        this.lastError = null;
        return parseQuestions(raw);
      } catch (e) {
        console.warn("反思提问失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /**
   * 反思树·第二步：针对一个问题，结合带编号记忆给出洞见并标注证据编号。
   * @param {object} opts { persona, company, question, memories: string }
   * @returns {Promise<{insight,evidence}|null>}
   */
  async reflectInsight({ persona, company, question, memories }) {
    if (!this.enabled || Date.now() < this.cooldownUntil) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}）。针对问题，结合下面带编号的记忆，给出一条具体、能指导明天行动的洞见，` +
          `并标注你主要依据了哪几条记忆的编号。只输出 JSON：{"insight":"≤50字洞见","evidence":[依据的记忆编号]}。不要其他文字。`;
        const raw = await this.chatRaw(system, `问题：${question}\n\n带编号的记忆：\n${memories}`, 300);
        this.lastError = null;
        return parseInsight(raw);
      } catch (e) {
        console.warn("反思洞见失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }
```

- [ ] **Step 4: 冒烟**

Run: `node -e "import('./js/llm.js').then(()=>console.log('llm.js ok'))"`
Expected: 输出 `llm.js ok`

- [ ] **Step 5: 提交**

```bash
git add js/llm.js
git commit -m "feat(llm): reflectQuestions/reflectInsight replace one-shot reflect"
```

---

## Task 4：director.js — 重写 runReflections 为反思树

**Files:**
- Modify: `js/director.js`
- Test: `test-reflect-tree.mjs`（新建）

- [ ] **Step 1: 写失败的集成测试**（新建 `test-reflect-tree.mjs`）

```js
import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name) {
  const a = {
    persona: { id: name, name, role: "工程师", zone: "rd", personality: "踏实", lines: { meeting: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("rt-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
  a.memory.items = [];
  return a;
}

const stubWorld = { day: 2, todayEvents: [], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubLLM = {
  enabled: true, usage: "standard", cooldownUntil: 0,
  qCalls: 0, iCalls: 0,
  async reflectQuestions() { this.qCalls++; return ["带宽成本怎么控？", "限速口碑如何保住？"]; },
  async reflectInsight({ question, memories }) {
    this.iCalls++;
    // 引用记忆清单里出现的第一个编号作为证据
    const m = memories.match(/\[(\d+)\]/);
    return { insight: "针对「" + question.slice(0, 6) + "」的洞见", evidence: m ? [Number(m[1])] : [] };
  }
};

const A = memAgent("王强");   // 重要度足够（>40）
A.memory.add("市场动态：夸克搞活动", { importance: 7, type: "world", day: 2, time: "09:00" });
A.memory.add("行动项：评估带宽方案", { importance: 7, type: "action", day: 2, time: "10:00" });
A.memory.add("公司公告：满意度下滑", { importance: 7, type: "world", day: 2, time: "11:00" });
A.memory.add("听到 李雷 说带宽要爆", { importance: 7, type: "heard", day: 2, time: "14:00" });
A.memory.add("董事长说要控成本", { importance: 9, type: "chairman", day: 2, time: "15:00" });
const B = memAgent("李雷");   // 重要度不足
B.memory.add("日常工作", { importance: 3, type: "obs", day: 2, time: "09:00" });

const dir = new Director([A, B], {}, () => {}, stubLLM, stubWorld, null, null, null);
dir.runReflections();
// 等待异步链（stub 同步 resolve）
for (let i = 0; i < 8; i++) await Promise.resolve();

// 王强应生成反思（2 问 × 1 洞见 = 2 条 reflect 记忆，带证据）
const reflects = A.memory.items.filter(m => m.type === "reflect");
if (reflects.length !== 2) throw new Error("王强应有 2 条反思，实际 " + reflects.length);
if (!reflects.every(r => Array.isArray(r.evidence) && r.evidence.length >= 1)) throw new Error("反思应带证据引用");
if (stubLLM.qCalls !== 1) throw new Error("王强应提问 1 次");

// 李雷重要度不足，不反思
if (B.memory.items.some(m => m.type === "reflect")) throw new Error("李雷重要度不足不应反思");

console.log("reflect tree OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-reflect-tree.mjs`
Expected: FAIL（旧 runReflections 调用 `llm.reflect`，stub 无该方法 / 行为不符）

- [ ] **Step 3: 重写 runReflections + import**

3a. `js/director.js` 顶部 `import { findCollabPair, planSummaryText } from "./cognition/plan.js";` 之后追加：

```js
import { shouldReflect, formatMemoriesWithIds } from "./cognition/reflect.js";
```

3b. 把 `js/director.js` 现有的整个 `runReflections() { ... }` 方法替换为反思树版本：

```js
  // ---------- 每日反思（反思树）----------

  /** 下班前：重要度累积过阈值者，从近期记忆提问→逐题生成带证据洞见，存为反思记忆（全员入队）。 */
  runReflections() {
    if (!this.llm?.enabled || this.llm.usage === "economy") return;
    const company = this.world?.companyBrief?.();
    for (const a of this.agents) {
      if (!a.memory || !shouldReflect(a.memory.items)) continue;
      const day = this.day;
      const memories = formatMemoriesWithIds(a.memory.items);
      const validIds = a.memory.items.filter(m => m.id != null).map(m => m.id);
      this.llm.reflectQuestions({ persona: a.persona, company, memories })
        .then(questions => {
          if (!questions || !questions.length) return;
          for (const q of questions.slice(0, 3)) {
            this.llm.reflectInsight({ persona: a.persona, company, question: q, memories })
              .then(r => {
                if (!r || !r.insight) return;
                const evidence = r.evidence.filter(id => validIds.includes(id));
                a.memory.add(`反思：${r.insight}`, { importance: 8, type: "reflect", day, time: "18:00", evidence });
                const cite = evidence.length ? `（依据 #${evidence.join("、#")}）` : "";
                this.log(`🪞 ${a.persona.name}：${r.insight}${cite}`, "log-collab");
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-reflect-tree.mjs`
Expected: PASS — 输出 `reflect tree OK`

- [ ] **Step 5: 回归**

Run: `node test-sim.mjs >/dev/null && node test-plan-loop.mjs >/dev/null && node test-market-loop.mjs >/dev/null && node test-minutes.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（StubAgent 无 llm 时 runReflections 因 `this.llm?.enabled` 为假 no-op）

- [ ] **Step 6: 提交**

```bash
git add js/director.js test-reflect-tree.mjs
git commit -m "feat(director): reflection tree with evidence (all agents enqueue)"
```

---

## 验收 / 收尾

- [ ] **全量测试**

```bash
node test-reflect.mjs && node test-reflect-tree.mjs && node test-plan.mjs && node test-plan-loop.mjs && node test-actionitems.mjs && node test-market.mjs && node test-market-loop.mjs && node test-world.mjs >/dev/null && node test-sim.mjs >/dev/null && node test-minutes.mjs >/dev/null && node test-board.mjs >/dev/null && node test-feed.mjs >/dev/null && node test-agent.mjs >/dev/null && node test-records.mjs >/dev/null && node test-activity.mjs >/dev/null && echo "ALL GREEN"
cd sidecar && node --test 2>&1 | grep -E "# (pass|fail)"
```
Expected: `ALL GREEN` + sidecar 全过（本计划不改 sidecar）。

- [ ] **降级冒烟（人工说明，沙箱跑不动真机/真 LLM 则如实标注环境限制）**
  - LLM 不可用/economy：`runReflections` no-op，无反思。
  - 阈值未到：`shouldReflect` 为假，该 Agent 当天不反思（安静的人不会硬凑反思）。
  - 全员入队：去掉 `available` 的 queueLen 早退后，13 人都排上反思队列（修复"只有前 3 人反思"）。

- [ ] **最终审查后合并**：feature 分支跑完 final review（spec 覆盖 + 质量），再本地合 main + push。

---

## Self-Review（对照 spec）

**Spec 覆盖（设计文档第 128-130 行）：**
- 替换 17:50 定时一句话 → Task 4 重写 `runReflections` ✅
- 重要度累积触发（阈值约 50）→ Task 2 `impSinceLastReflect` + `shouldReflect`（阈值常量 40，可调）✅
- 模型从近期记忆提出 2~3 个问题 → Task 3 `reflectQuestions` + Task 2 `parseQuestions` ✅
- 逐题检索、生成带证据引用的洞见（evidence: [记忆id]）→ Task 1 记忆 id + Task 3 `reflectInsight` + Task 2 `parseInsight`（validIds 过滤）+ Task 4 存 evidence ✅
- 反思可被后续反思引用形成层级 → 反思也是带 id 的记忆，`formatMemoriesWithIds` 含历史反思条目，后续 `reflectInsight` 可引其 id ✅
- 下班兜底跑一次 → `runReflections` 仍由 17:50 触发（director.update 既有调用点不变）✅
- 顺带修复"只有前 3 人反思" → Task 3 用 `enabled`+cooldown 门取代 `available`（含 queueLen<3）✅

**本阶段明确不做（YAGNI，留后续）：** 记录页"人物"展示反思的证据链（renderMemoryItem 可后续加"依据 #x"）；白天中途的累积触发（当前在 17:50 单点判定，足够形成树）；react.js（P3d-2）、converse 多轮（P3d-3）。

**Placeholder 扫描：** 无 TBD；每步含完整代码与命令。
**类型一致性：** 记忆 item 加 `id`/`evidence` 在 memory/reflect/director/测试一致；`parseInsight→{insight,evidence:[id]}`、`parseQuestions→string[]` 在 reflect.js/llm/director/测试一致；`reflectQuestions({persona,company,memories})`、`reflectInsight({persona,company,question,memories})` 签名在 llm/director/测试一致。
