# P3d-2：突发反应（react.js）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 真实市场突发事件白天到达时，除全员收到公告记忆外，用 embedding 算事件与每人画像的相关度，挑最相关的 2 人各做一次即时反应（说一句话 + 决定一个轻动作：找同事/拉短会/查代码/无），保持逐人独立隔离、控制调用量。

**Architecture:** 新增纯函数模块 `js/cognition/react.js`（反应解析 + 相关度 top-k 排序：embedding 余弦优先、bigram 兜底）。`LLMClient` 新增 `react()`（单次小调用，沿用 available 限流）。`director.injectBreakingNews` 在原有全员公告之外追加 `runReactions`：算 top2 → 各 1 次 `react` → 应用轻动作（说话+广播+记忆 / 查代码 / 拉短会的跨人记忆），不改帧循环/不移动 3D 身体（那留 P3d-3）。降级：LLM 不可用不反应；embedding 离线回退 bigram 相关度。

**Tech Stack:** 浏览器原生 ESM；测试沿用根目录 `node test-*.mjs`。

参照设计 spec：`docs/superpowers/specs/2026-06-12-reality-link-design.md`（react.js 第 124-126 行）。复用 `director.js` 模块常量 `HEAR_RADIUS_TALK`、`DOMAIN_TERMS`、`codeRefNote`。

---

## 文件结构

- `js/cognition/react.js`（新建）：`parseReaction` / `cosineTopK` / `bigramTopK` 纯函数
- `js/llm.js`（修改）：新增 `react()`
- `js/director.js`（修改）：`injectBreakingNews` 末尾加 `runReactions`；新增 `runReactions` / `rankAgentsByRelevance` / `applyReaction`
- `test-react.mjs`（新建）、`test-react-loop.mjs`（新建）：纯函数 + director 集成单测

---

## Task 1：react.js — 反应解析与相关度排序

**Files:**
- Create: `js/cognition/react.js`
- Test: `test-react.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-react.mjs`）

```js
import { parseReaction, cosineTopK, bigramTopK } from "./js/cognition/react.js";

// parseReaction：合法对象
const r = parseReaction({ utterance: "带宽这事我盯一下", action: "investigate_repo" });
if (r.utterance !== "带宽这事我盯一下" || r.action !== "investigate_repo") throw new Error("合法反应解析错");
// 非法 action 归 none；JSON 字符串带围栏；脏输入当纯发言
if (parseReaction({ utterance: "x", action: "乱来" }).action !== "none") throw new Error("非法 action 应归 none");
const r2 = parseReaction('```json\n{"utterance":"拉个会","action":"call_meeting"}\n```');
if (r2.action !== "call_meeting") throw new Error("应解析围栏 JSON");
const r3 = parseReaction("就一句话没JSON");
if (r3.action !== "none" || !r3.utterance.includes("就一句话")) throw new Error("非 JSON 应当作纯发言、action=none");
if (parseReaction(null).action !== "none") throw new Error("null 应安全");
if (parseReaction([1]).utterance !== "") throw new Error("数组应空 utterance");

// cosineTopK：按余弦相似度降序取 index
const top = cosineTopK([1, 0], [[1, 0], [0, 1], [0.7, 0.7]], 2);
if (top[0] !== 0) throw new Error("最相似应是 index 0");
if (top[1] !== 2) throw new Error("次相似应是 index 2（0.7,0.7）");
if (cosineTopK([1, 0], [[0, 0]], 1)[0] !== 0) throw new Error("零向量不应崩，返回 index 0");

// bigramTopK：按二元组重叠降序取 index
const tb = bigramTopK("带宽成本压力", ["我负责带宽和成本优化", "我做用户增长活动"], 1);
if (tb[0] !== 0) throw new Error("带宽相关的应排第一");
if (bigramTopK("xyz", ["abc", "def"], 2).length !== 2) throw new Error("无重叠也应返回 k 个");

console.log("react OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-react.mjs`
Expected: FAIL — `Cannot find module ... react.js`

- [ ] **Step 3: 实现 react.js**（新建 `js/cognition/react.js`）

```js
// 突发反应纯函数：反应解析 + 相关度 top-k（embedding 余弦优先、bigram 兜底）。

const ACTIONS = new Set(["goto_colleague", "call_meeting", "investigate_repo", "none"]);

function strip(raw) {
  return String(raw).replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
}

/** 解析模型反应输出 → {utterance, action}。非 JSON 时整段当一句话、action=none。 */
export function parseReaction(raw) {
  let o = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(strip(raw)); }
    catch { return { utterance: String(raw).trim().slice(0, 40), action: "none" }; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { utterance: "", action: "none" };
  return {
    utterance: String(o.utterance || "").trim().slice(0, 40),
    action: ACTIONS.has(o.action) ? o.action : "none"
  };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 返回 vecs 里与 query 余弦最相似的 k 个的索引（降序）。 */
export function cosineTopK(query, vecs, k) {
  return vecs
    .map((v, i) => [i, cosine(query, v)])
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(s => s[0]);
}

function bigrams(s) {
  const out = new Set();
  const t = String(s || "").replace(/[^一-龥a-zA-Z0-9]/g, "");
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 返回 texts 里与 queryText 二元组重叠最多的 k 个的索引（降序）。embedding 不可用时的兜底。 */
export function bigramTopK(queryText, texts, k) {
  const q = bigrams(queryText);
  return texts
    .map((t, i) => {
      const tb = bigrams(t);
      let overlap = 0;
      for (const g of tb) if (q.has(g)) overlap++;
      return [i, overlap];
    })
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(s => s[0]);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-react.mjs`
Expected: PASS — 输出 `react OK`

- [ ] **Step 5: 提交**

```bash
git add js/cognition/react.js test-react.mjs
git commit -m "feat(cognition): breaking-news reaction parse + relevance ranking"
```

---

## Task 2：LLMClient.react()

**Files:**
- Modify: `js/llm.js`

无独立单测（解析健壮性由 Task 1 覆盖；Task 3 集成测试用桩 llm 验证）。

- [ ] **Step 1: 顶部引入 parseReaction**

`js/llm.js` 顶部已有的 `import { parseQuestions, parseInsight } from "./cognition/reflect.js";` 之后追加：

```js
import { parseReaction } from "./cognition/react.js";
```

- [ ] **Step 2: 新增 react() 方法**

在 `js/llm.js` 的 `reflectInsight()` 方法之后、`async test()` 之前插入：

```js
  /**
   * 突发反应：对一条与本角色相关的突发消息即时反应。单次小调用，沿用 available 限流（每事件仅 top2 调用）。
   * @param {object} opts { persona, company, event }
   * @returns {Promise<{utterance,action}|null>}
   */
  async react({ persona, company, event }) {
    if (!this.available) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}），性格：${persona.personality || "暂无"}。` +
          (company ? `公司背景：${company}\n` : "") +
          `刚收到一条跟你比较相关的突发市场消息。请即时反应：说一句话，并决定要不要采取一个行动。` +
          `只输出 JSON：{"utterance":"≤30字的一句话","action":"goto_colleague/call_meeting/investigate_repo/none"}。` +
          `action 含义：找同事对一下 / 拉个短会 / 去查代码 / 不必行动。不要输出 JSON 以外的任何文字。`;
        const raw = await this.chatRaw(system, `突发消息：${event}`, 200);
        this.lastError = null;
        return parseReaction(raw);
      } catch (e) {
        console.warn("突发反应生成失败：", e.message || e);
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
git commit -m "feat(llm): react structured call for breaking news"
```

---

## Task 3：director.js — 突发事件 top2 反应

**Files:**
- Modify: `js/director.js`
- Test: `test-react-loop.mjs`（新建）

- [ ] **Step 1: 写失败的集成测试**（新建 `test-react-loop.mjs`）

```js
import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name, personality) {
  return {
    persona: { id: name, name, role: "工程师", zone: "rd", personality, lines: { meeting: ["占位"], collab: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("rx-" + name),
    said: [], say(t) { this.said.push(t); }, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubLLM = {
  enabled: true, usage: "standard", available: true, cooldownUntil: 0,
  reactCalls: [],
  async dailyPlan() { return null; },
  async react({ persona, event }) {
    this.reactCalls.push(persona.name);
    return { utterance: `${persona.name} 关注：${event.slice(0, 6)}`, action: "investigate_repo" };
  }
};
// 桩 feed：embed 让"带宽专家"与"带宽事件"最相似；repoGrep 返回命中
const grepCalls = [];
const stubFeed = {
  activePolicies: () => [],
  async embed(texts) {
    // texts[0]=事件，其余=各人画像；按是否含"带宽"给 1/0 向量
    return texts.map(t => [t.includes("带宽") ? 1 : 0, t.includes("增长") ? 1 : 0]);
  },
  async repoGrep(q) { grepCalls.push(q); return [{ file: "js/x.js", line: 3, text: "限速逻辑" }]; }
};

const A = memAgent("王强", "负责带宽和成本");      // 与带宽事件最相关
const B = memAgent("李雷", "负责带宽优化");        // 次相关
const C = memAgent("韩梅", "做用户增长活动");      // 不相关
const dir = new Director([A, B, C], {}, () => {}, stubLLM, stubWorld, stubFeed, null, null);

dir.injectBreakingNews({ id: "e1", summary: "带宽结算新规落地，CDN 成本上涨" });
// 等待 embed + react 异步链
for (let i = 0; i < 12; i++) await Promise.resolve();
await new Promise(r => setTimeout(r, 5));
for (let i = 0; i < 12; i++) await Promise.resolve();

// 全员都收到公告记忆
for (const a of [A, B, C]) {
  if (!a.memory.items.some(m => m.type === "world" && m.c.includes("市场快讯"))) throw new Error(a.persona.name + " 应收到突发公告记忆");
}
// 只有 top2（王强、李雷）反应，韩梅没反应
if (stubLLM.reactCalls.length !== 2) throw new Error("应只有 top2 反应，实际 " + stubLLM.reactCalls.length);
if (stubLLM.reactCalls.includes("韩梅")) throw new Error("不相关的韩梅不应反应");
if (!stubLLM.reactCalls.includes("王强")) throw new Error("最相关的王强应反应");
// 反应：说了话 + 写了反应记忆 + investigate_repo 触发了 repoGrep
if (A.said.length === 0) throw new Error("反应者应说一句话");
if (!A.memory.items.some(m => m.c.includes("反应"))) throw new Error("反应者应写反应记忆");
if (grepCalls.length === 0) throw new Error("investigate_repo 应触发 repoGrep");

console.log("react loop OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-react-loop.mjs`
Expected: FAIL — `dir.runReactions is not a function`（injectBreakingNews 末尾调用了它）

- [ ] **Step 3: 接通 director**

3a. `js/director.js` 顶部 `import { shouldReflect, formatMemoriesWithIds } from "./cognition/reflect.js";` 之后追加：

```js
import { cosineTopK, bigramTopK } from "./cognition/react.js";
```

3b. `injectBreakingNews` 末尾（`for (const a of this.agents) { this.remember(...); }` 之后、方法闭合 `}` 之前）追加：

```js
    this.runReactions(text);
```

3c. 在 `injectBreakingNews` 方法之后插入三个方法：

```js
  /** 突发事件：挑最相关的 2 人各做一次反应，其余人只有公告记忆。 */
  runReactions(text) {
    if (!this.llm?.enabled || this.llm.usage === "economy") return;
    this.rankAgentsByRelevance(text).then(ranked => {
      for (const a of ranked.slice(0, 2)) {
        this.llm.react({ persona: a.persona, company: this.world?.companyBrief?.(), event: text })
          .then(r => { if (r) this.applyReaction(a, r, text); })
          .catch(() => {});
      }
    }).catch(() => {});
  }

  /** 按事件与各人画像的相关度排序（embedding 余弦优先，离线回退 bigram）。 */
  async rankAgentsByRelevance(text) {
    const personas = this.agents.map(a => `${a.persona.role}。${a.persona.personality || ""}`);
    let vecs = null;
    if (this.feed?.embed) {
      try { vecs = await this.feed.embed([text, ...personas]); } catch { vecs = null; }
    }
    const order = (Array.isArray(vecs) && vecs.length === personas.length + 1)
      ? cosineTopK(vecs[0], vecs.slice(1), this.agents.length)
      : bigramTopK(text, personas, this.agents.length);
    return order.map(i => this.agents[i]);
  }

  /** 应用一个轻动作（不移动 3D 身体）：说话+广播+记忆，按 action 产生跨人/查代码效果。 */
  applyReaction(a, r, text) {
    const u = r.utterance;
    if (u) {
      a.say?.(u, 5);
      this.log(`⚡ ${a.persona.name}（对突发反应）：${u}`, "log-collab");
      this.broadcastHearing(a, u, HEAR_RADIUS_TALK, 5);
    }
    this.remember(a, `我对突发「${text.slice(0, 18)}…」的反应：${u || r.action}`, 6, "event");
    if (r.action === "investigate_repo" && this.feed?.repoGrep) {
      const term = DOMAIN_TERMS[Math.floor(Math.random() * DOMAIN_TERMS.length)];
      this.feed.repoGrep(term).then(hits => {
        const note = codeRefNote(hits);
        if (note) this.remember(a, `因突发去查了代码${note}`, 5, "event");
      }).catch(() => {});
    } else if (r.action === "call_meeting") {
      this.log(`📣 ${a.persona.name} 提议就这事碰个短会`, "log-meeting");
      for (const o of this.crewInZone(a.persona.zone || "rd")) {
        if (o !== a) this.remember(o, `${a.persona.name} 提议就「${text.slice(0, 16)}」碰个短会`, 5, "heard");
      }
    } else if (r.action === "goto_colleague") {
      this.log(`🤝 ${a.persona.name} 想找人对一下这事`, "log-collab");
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-react-loop.mjs`
Expected: PASS — 输出 `react loop OK`

- [ ] **Step 5: 回归**

Run: `node test-sim.mjs >/dev/null && node test-reflect-tree.mjs >/dev/null && node test-plan-loop.mjs >/dev/null && node test-market-loop.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（StubAgent 无 llm 时 runReactions 因 `this.llm?.enabled` 为假 no-op；test-sim 不经 injectBreakingNews 也不受影响）

- [ ] **Step 6: 提交**

```bash
git add js/director.js test-react-loop.mjs
git commit -m "feat(director): top-2 relevance-ranked reactions to breaking news"
```

---

## 验收 / 收尾

- [ ] **全量测试**

```bash
node test-react.mjs && node test-react-loop.mjs && node test-reflect.mjs && node test-reflect-tree.mjs && node test-plan.mjs && node test-plan-loop.mjs && node test-actionitems.mjs && node test-market.mjs && node test-market-loop.mjs && node test-world.mjs >/dev/null && node test-sim.mjs >/dev/null && node test-minutes.mjs >/dev/null && node test-board.mjs >/dev/null && node test-feed.mjs >/dev/null && node test-agent.mjs >/dev/null && node test-records.mjs >/dev/null && node test-activity.mjs >/dev/null && echo "ALL GREEN"
cd sidecar && node --test 2>&1 | grep -E "# (pass|fail)"
```
Expected: `ALL GREEN` + sidecar 全过（本计划不改 sidecar）。

- [ ] **降级冒烟（人工说明，沙箱跑不动真机/真 LLM 则如实标注环境限制）**
  - LLM 不可用/economy：`runReactions` no-op，突发仍进全员记忆、只是无人即时反应。
  - embedding 离线（feed.embed 返回 null 或 sidecar 离线）：`rankAgentsByRelevance` 回退 bigram 相关度，仍能挑出 top2。
  - 反应是软动作：不移动 3D 身体、不改帧循环（移动/多轮留 P3d-3）。

- [ ] **最终审查后合并**：feature 分支跑完 final review（spec 覆盖 + 质量），再本地合 main + push。

---

## Self-Review（对照 spec）

**Spec 覆盖（设计文档第 124-126 行）：**
- SSE 事件白天到达 → director.injectBreakingNews（既有 onBreaking 路由）→ Task 3 末尾 `runReactions` ✅
- embedding 计算事件与每人画像相似度（本地免费）→ Task 3 `rankAgentsByRelevance` 用 `feed.embed` + Task 1 `cosineTopK` ✅
- top 2 各 1 次小调用 `{utterance, action}` → Task 2 `react` + Task 3 `ranked.slice(0,2)` ✅
- action ∈ goto_colleague/call_meeting/investigate_repo/none → Task 1 `parseReaction` 校验 + Task 3 `applyReaction` 落地 ✅
- 其余人仅写入公告记忆 → Task 3 `injectBreakingNews` 既有全员 `remember(..., 7, "world")` 保留，只有 top2 进 `applyReaction` ✅
- 逐人独立判断、控制调用量 → 每事件仅 2 次 `react`（`available` 限流），每人独立 prompt ✅

**本阶段明确不做（YAGNI，留 P3d-3）：** 反应动作真正移动 3D 身体 / 打断当前日程 / 发起多轮对话；会议/协作的多轮 {utterance,done} 自决终止。

**Placeholder 扫描：** 无 TBD；每步含完整代码与命令。
**类型一致性：** `parseReaction→{utterance,action}`、`cosineTopK(query,vecs,k)→indices`、`bigramTopK(text,texts,k)→indices` 在 react.js/llm/director/测试一致；`react({persona,company,event})` 签名一致；`applyReaction(a, r, text)` 用 `r.utterance`/`r.action` 与 parseReaction 输出一致。
