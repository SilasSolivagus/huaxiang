# P3d-3：converse 多轮自决终止 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把协作讨论从写死的 3 轮改成「每轮发言者输出 {utterance, done}、自行决定结束、上限 6 轮」的循环；会议保留轮转但允许「没什么要补充」跳过。模型不可用时回退原有定轮台词行为。

**Architecture:** 新增纯函数 `js/cognition/converse.js`（`parseTurn`）。`LLMClient` 新增 `converseTurn()` 返回 `{utterance, done}`。`director` 新增共享包装 `converseTurn(agent, scene, fallback, {onTurn})`（仿 `speakSmart`，但回调带 done）；`maybeStartCollab` 改为递归调度的 converse 循环（保留落座/找 bug/清理时序），`runMeetingTalk` 改为可跳过的轮转（done 者入 `st.done` 被跳过）。降级：无 LLM 时 fallback 台词、done 由轮次上限决定，协作回退 3 轮、会议照常轮转——既有动画时序与清理逻辑完全保留。

**Tech Stack:** 浏览器原生 ESM；测试沿用根目录 `node test-*.mjs`。这是 P3 唯一涉及帧循环（`after()` 调度 + 帧轮询）的改造，务必保证所有路径终止并清理 `collabBusy`。

参照设计 spec：`docs/superpowers/specs/2026-06-12-reality-link-design.md`（converse.js 第 132-134 行）。

---

## 文件结构

- `js/cognition/converse.js`（新建）：`parseTurn` 纯函数
- `js/llm.js`（修改）：新增 `converseTurn()`
- `js/director.js`（修改）：新增共享 `converseTurn` 方法；重写 `maybeStartCollab` 的对话段为 converse 循环；`runMeetingTalk` 加 done 跳过；`freshMeet` 加 `done` 集合
- `test-converse.mjs`（新建）、`test-converse-loop.mjs`（新建）：纯函数 + director 集成单测

---

## Task 1：converse.js — 轮次解析纯函数

**Files:**
- Create: `js/cognition/converse.js`
- Test: `test-converse.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-converse.mjs`）

```js
import { parseTurn } from "./js/cognition/converse.js";

// 合法对象
const a = parseTurn({ utterance: "我觉得可以上限速", done: false });
if (a.utterance !== "我觉得可以上限速" || a.done !== false) throw new Error("合法对象解析错");
const b = parseTurn({ utterance: "没什么要补充了", done: true });
if (b.done !== true) throw new Error("done=true 应保留");

// JSON 字符串（围栏）+ 去引号
const c = parseTurn('```json\n{"utterance":"「带宽得盯」","done":true}\n```');
if (c.utterance !== "带宽得盯") throw new Error("应解析围栏并去引号");
if (c.done !== true) throw new Error("done 应为 true");

// 非 JSON → 整段当一句话、done=false、去引号
const d = parseTurn("「就这么定」");
if (d.utterance !== "就这么定" || d.done !== false) throw new Error("非 JSON 应当作一句话、done=false");

// 脏/空输入安全
if (parseTurn(null).utterance !== "" || parseTurn(null).done !== false) throw new Error("null 应安全");
if (parseTurn([1]).utterance !== "") throw new Error("数组应空 utterance");
// done 非布尔 → 强制布尔
if (parseTurn({ utterance: "x", done: "yes" }).done !== true) throw new Error("done 真值应转 true");
if (parseTurn({ utterance: "x" }).done !== false) throw new Error("缺 done 应为 false");

console.log("converse OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-converse.mjs`
Expected: FAIL — `Cannot find module ... converse.js`

- [ ] **Step 3: 实现 converse.js**（新建 `js/cognition/converse.js`）

```js
// 多轮对话纯函数：解析每轮发言者输出的 {utterance, done}。

function strip(raw) {
  return String(raw).replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
}

function dequote(s) {
  return String(s).trim().replace(/^["「『]|["」』]$/g, "").slice(0, 60);
}

/** 解析一轮发言模型输出 → {utterance, done}。非 JSON 时整段当一句话、done=false。 */
export function parseTurn(raw) {
  let o = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(strip(raw)); }
    catch { return { utterance: dequote(raw), done: false }; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { utterance: "", done: false };
  return { utterance: dequote(o.utterance || ""), done: !!o.done };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-converse.mjs`
Expected: PASS — 输出 `converse OK`

- [ ] **Step 5: 提交**

```bash
git add js/cognition/converse.js test-converse.mjs
git commit -m "feat(cognition): multi-turn converse parseTurn"
```

---

## Task 2：LLMClient.converseTurn()

**Files:**
- Modify: `js/llm.js`

无独立单测（解析健壮性由 Task 1 覆盖；Task 3 集成测试用桩 llm 验证）。

- [ ] **Step 1: 顶部引入 parseTurn**

`js/llm.js` 顶部已有的 `import { parseReaction } from "./cognition/react.js";` 之后追加：

```js
import { parseTurn } from "./cognition/converse.js";
```

- [ ] **Step 2: 新增 converseTurn() 方法**

在 `js/llm.js` 的 `react()` 方法之后、`async test()` 之前插入：

```js
  /**
   * 多轮讨论的一轮发言：基于记忆与已说过的话，推进讨论并自行决定是否说完了。
   * @param {object} opts { persona, company, policies, memories, scene, transcript }
   * @returns {Promise<{utterance,done}|null>}
   */
  async converseTurn({ persona, company, policies = [], memories = [], scene, transcript = [] }) {
    if (!this.available) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在一个办公室模拟中扮演「${persona.name}」（${persona.role}）。性格：${persona.personality || "暂无"}。` +
          (company ? `你所在公司：${company}\n` : "") +
          (policies.length ? `现行公司政策（你的发言须与之相符）：\n${policies.map(p => "- " + p).join("\n")}\n` : "") +
          `这是一场多轮讨论，现在轮到你。基于你的记忆和刚听到的话，说一句推进讨论的话（≤40字、口语、符合你的性格）；` +
          `如果你觉得该说的都说完了、没什么要补充，把 done 设为 true。只输出 JSON：{"utterance":"你这一句话","done":true或false}。不要其他文字。`;
        const user =
          (memories.length ? `你记得的相关事情：\n${memories.map(m => "- " + m).join("\n")}\n\n` : "") +
          `当前场景：${scene}\n` +
          (transcript.length ? `刚刚的对话：\n${transcript.join("\n")}\n` : "") +
          `\n现在轮到你。`;
        const raw = await this.chatRaw(system, user, 256);
        this.lastError = null;
        return parseTurn(raw);
      } catch (e) {
        console.warn("多轮发言生成失败：", e.message || e);
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
git commit -m "feat(llm): converseTurn returns {utterance, done}"
```

---

## Task 3：director.converseTurn — 共享多轮发言包装

**Files:**
- Modify: `js/director.js`
- Test: `test-converse-loop.mjs`

- [ ] **Step 1: 写失败的集成测试**（新建 `test-converse-loop.mjs`，先只测 converseTurn 方法）

```js
import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name) {
  return {
    persona: { id: name, name, role: "工程师", zone: "rd", personality: "踏实", lines: { meeting: ["占位"], collab: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("cv-" + name),
    said: [], say(t) { this.said.push(t); }, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubFeed = { activePolicies: () => [], async embed() { return null; } };

// 1) llm 可用：converseTurn 说话 + 回调带 done
const stubLLM1 = {
  enabled: true, usage: "standard", available: true, cooldownUntil: 0,
  async dailyPlan() { return null; },
  async converseTurn() { return { utterance: "我觉得限速能上", done: true }; }
};
const A = memAgent("王强");
const dir1 = new Director([A], {}, () => {}, stubLLM1, stubWorld, stubFeed, null, null);
let cb = null;
await dir1.converseTurn(A, "讨论场景", "兜底台词", { logCls: "log-collab", transcript: [], onTurn: (text, done) => { cb = { text, done }; } });
if (!A.said.includes("我觉得限速能上")) throw new Error("应说出模型台词");
if (!cb || cb.text !== "我觉得限速能上" || cb.done !== true) throw new Error("onTurn 应回调 {text, done=true}");

// 2) llm 不可用：回退 fallback、done=false
const stubLLM2 = { enabled: false, usage: "standard", available: false, async dailyPlan() { return null; } };
const B = memAgent("李雷");
const dir2 = new Director([B], {}, () => {}, stubLLM2, stubWorld, stubFeed, null, null);
let cb2 = null;
await dir2.converseTurn(B, "场景", "我的兜底台词", { logCls: "log-collab", transcript: [], onTurn: (t, d) => { cb2 = { t, d }; } });
if (!B.said.includes("我的兜底台词")) throw new Error("无 llm 应说兜底台词");
if (!cb2 || cb2.d !== false) throw new Error("无 llm 时 done 应为 false");

console.log("converseTurn OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-converse-loop.mjs`
Expected: FAIL — `dir1.converseTurn is not a function`

- [ ] **Step 3: 实现 director.converseTurn + freshMeet done**

3a. 在 `js/director.js` 的 `speakSmart(...)` 方法之后插入共享多轮发言包装：

```js
  /**
   * 多轮讨论的一轮发言（仿 speakSmart，但回调带 done 让调用方决定是否继续）。
   * 返回 Promise 便于测试 await。无 llm 时说 fallback、done=false。
   */
  converseTurn(agent, scene, fallback, { radius = HEAR_RADIUS_TALK, importance = 4, logCls = "", transcript = [], onTurn = null } = {}) {
    const finish = (text, isAI, done) => {
      if (text) {
        agent.say(text, isAI ? 5 : 4);
        this.log(`${isAI ? "✨ " : ""}${agent.persona.name}：${text}`, logCls);
        this.broadcastHearing(agent, text, radius, importance);
        if (logCls === "log-meeting" || logCls === "log-collab") {
          this.todayHighlights.push(`${agent.persona.name}：${text}`);
          if (this.todayHighlights.length > 40) this.todayHighlights.shift();
        }
      }
      onTurn?.(text, done);
    };
    if (this.llm?.available && agent.memory) {
      return agent.memory.retrieve(scene, 6).then(memories =>
        this.llm.converseTurn({
          persona: agent.persona,
          company: this.world?.companyBrief(),
          policies: this.feed?.activePolicies() ?? [],
          memories, scene, transcript: transcript.slice(-6)
        })
      ).then(res => {
        const r = res || {};
        finish(r.utterance || fallback, !!r.utterance, !!r.done);
      }).catch(() => finish(fallback, false, false));
    }
    finish(fallback, false, false);
    return Promise.resolve();
  }
```

3b. 把 `js/director.js` 底部的 `freshMeet()` 函数：

```js
function freshMeet() {
  return { idx: 0, next: 0, pending: false, transcript: [] };
}
```

改为（加 `done` 集合，记录已表示"没有补充"的人）：

```js
function freshMeet() {
  return { idx: 0, next: 0, pending: false, transcript: [], done: new Set() };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-converse-loop.mjs`
Expected: PASS — 输出 `converseTurn OK`

- [ ] **Step 5: 提交**

```bash
git add js/director.js test-converse-loop.mjs
git commit -m "feat(director): shared converseTurn wrapper with done callback"
```

---

## Task 4：maybeStartCollab — 改为 converse 循环

**Files:**
- Modify: `js/director.js`

无新单测（converseTurn 已在 Task 3 测；循环终止靠 maxTurns 上限保证，由回归 test-sim 跑满 3 天验证 collabBusy 不泄漏、无报错）。

- [ ] **Step 1: 替换对话段**

把 `js/director.js` `maybeStartCollab` 里**从 `const turn = (agent, fallbackPool) => {` 到 4 个 `this.after(...)` 块结束**（即原本的 `turn` 辅助 + `after(4)`/`after(10)`/`after(16)`/`after(20)` 整段）替换为下面的 converse 循环。原文起点是这行：

```js
    const turn = (agent, fallbackPool) => {
```

终点是 `after(20)` 块的闭合（含 `this.collabBusy.delete(visitor.persona.id); this.collabBusy.delete(host.persona.id); });`）。整段替换为：

```js
    // 多轮 converse：每轮发言者自行决定是否说完，上限 6 轮（无 llm 回退定轮台词，3 轮收尾）
    const maxTurns = this.llm?.available ? 6 : 3;
    const speakers = [visitor, host];
    const closers = ["明白了，我去改！", "好，就这么定", "这个思路可以，搞起", "OK，同步完毕"];
    let turnNo = 0;

    const finishCollab = () => {
      if (this.currentPhase?.type === "work") {
        visitor.setActivity("在工位专注工作");
        host.setActivity("在工位专注工作");
        visitor.sitAt({ ...ownDesk.seat, lookAt: ownDesk.lookAt }, "type");
        host.faceToward(desk.lookAt.x, desk.lookAt.z);
      }
      const bugFixed = !!this.world?.onCollabDone();
      if (bugFixed) {
        this.log(`🔧 ${visitor.persona.name} 和 ${host.persona.name} 的讨论修复了一个 Bug（剩 ${this.world.metrics.bugs} 个）`, "log-collab");
        this.remember(visitor, `和 ${host.persona.name} 一起修复了一个产品 Bug`, 5, "event");
        this.remember(host, `和 ${visitor.persona.name} 一起修复了一个产品 Bug`, 5, "event");
        this.todayRecord.bugsFixed++;
      }
      this.todayRecord.collabs.push({ visitor: visitor.persona.name, host: host.persona.name, bugFixed });
      this.collabBusy.delete(visitor.persona.id);
      this.collabBusy.delete(host.persona.id);
    };

    const runConverseTurn = () => {
      const speaker = speakers[turnNo % 2];
      const isLast = turnNo >= maxTurns - 1;
      const fallback = isLast ? pick(closers) : pick(speaker.persona.lines.collab);
      this.converseTurn(speaker, sceneBase + codeNote, fallback, {
        radius: HEAR_RADIUS_TALK,
        importance: 4,
        logCls: "log-collab",
        transcript: tx,
        onTurn: (text, done) => {
          tx.push(`${speaker.persona.name}：${text}`);
          turnNo++;
          if (done || turnNo >= maxTurns) this.after(4, finishCollab);
          else this.after(4.5 + Math.random() * 2.5, runConverseTurn);
        }
      });
    };

    this.after(4, () => {
      host.faceToward(desk.standSpot.x, desk.standSpot.z);
      host.setActivity(`和 ${visitor.persona.name} 讨论中`);
      visitor.setActivity(`和 ${host.persona.name} 讨论中`);
      runConverseTurn();
    });
```

- [ ] **Step 2: 语法校验 + 回归（关键：collabBusy 不泄漏、跑满 3 天无报错）**

Run: `node --check js/director.js && node test-sim.mjs >/dev/null && node test-converse-loop.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（test-sim 用 StubAgent 无 llm，走 3 轮 fallback 收尾，collabBusy 正常清理）

- [ ] **Step 3: 回归其它**

Run: `node test-minutes.mjs >/dev/null && node test-reflect-tree.mjs >/dev/null && node test-react-loop.mjs >/dev/null && echo OK`
Expected: 输出 `OK`

- [ ] **Step 4: 提交**

```bash
git add js/director.js
git commit -m "feat(director): collaboration as multi-turn converse loop (self-terminating)"
```

---

## Task 5：runMeetingTalk — 允许「没什么要补充」跳过

**Files:**
- Modify: `js/director.js`
- Test: `test-converse-loop.mjs`（追加）

- [ ] **Step 1: 追加失败测试**（在 `test-converse-loop.mjs` 末尾 `console.log("converseTurn OK")` 之前插入）

```js
// 3) runMeetingTalk：done 的人被加入 st.done 并在后续轮转中被跳过
const reactions = { 王强: { utterance: "没什么补充", done: true }, 李雷: { utterance: "我说两句", done: false } };
const stubLLM3 = {
  enabled: true, usage: "standard", available: true, cooldownUntil: 0,
  async dailyPlan() { return null; },
  async converseTurn({ persona }) { return reactions[persona.name] || { utterance: "嗯", done: false }; }
};
const W = memAgent("王强"), L = memAgent("李雷");
const dir3 = new Director([W, L], {}, () => {}, stubLLM3, stubWorld, stubFeed, null, null);
dir3.currentPhase = { type: "standup", label: "每日站会" };
dir3.meetState = { rd: { idx: 0, next: 0, pending: false, transcript: [], done: new Set() }, ops: { idx: 0, next: 0, pending: false, transcript: [], done: new Set() } };

// 反复推进会议轮转，喂足够时间让异步发言落地
for (let k = 0; k < 6; k++) {
  dir3.simTime += 10;
  dir3.runMeetingTalk();
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
// 王强 done=true 应被记入 st.done
if (!dir3.meetState.rd.done.has("王强")) throw new Error("说完的王强应进 st.done");
// 李雷 done=false 不应在 done 集合
if (dir3.meetState.rd.done.has("李雷")) throw new Error("还想说的李雷不应在 st.done");

console.log("converseTurn OK");
```

- [ ] **Step 2: 运行确认失败**

Run: `node test-converse-loop.mjs`
Expected: FAIL — `st.done` 不存在 / 王强未被记入（旧 runMeetingTalk 用 speakSmart、无 done 概念）

- [ ] **Step 3: 改写 runMeetingTalk**

把 `js/director.js` 整个 `runMeetingTalk()` 方法替换为：

```js
  runMeetingTalk() {
    for (const zone of ZONES) {
      const st = this.meetState[zone];
      if (this.simTime < st.next || st.pending) continue;
      const crew = this.crewInZone(zone);
      if (crew.length === 0) continue;
      if (!st.done) st.done = new Set();
      if (st.done.size >= crew.length) continue;   // 全员都表示没有补充，会议安静收尾
      // 轮转挑下一个还没说"完"、且不忙的人
      let speaker = null, tries = 0;
      while (tries < crew.length) {
        const cand = crew[st.idx % crew.length];
        st.idx++;
        tries++;
        if (!st.done.has(cand.persona.id) && !cand.isBusy) { speaker = cand; break; }
      }
      if (!speaker) continue;
      st.next = this.simTime + 5.5 + Math.random() * 3;
      st.pending = true;
      const fallback = pick(speaker.persona.lines.meeting);
      this.converseTurn(speaker, this.meetingScene(this.currentPhase, zone), fallback, {
        radius: HEAR_RADIUS_MEETING,
        importance: 4,
        logCls: "log-meeting",
        transcript: st.transcript,
        onTurn: (text, done) => {
          st.transcript.push(`${speaker.persona.name}：${text}`);
          if (done) st.done.add(speaker.persona.id);
          st.pending = false;
        }
      });
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node test-converse-loop.mjs`
Expected: PASS — 输出 `converseTurn OK`

- [ ] **Step 5: 回归**

Run: `node test-sim.mjs >/dev/null && node test-minutes.mjs >/dev/null && echo OK`
Expected: 输出 `OK`（StubAgent 无 llm：converseTurn 走 fallback、done 恒 false，会议照常轮转，纪要收割不受影响）

- [ ] **Step 6: 提交**

```bash
git add js/director.js test-converse-loop.mjs
git commit -m "feat(director): meetings allow skip when nothing to add"
```

---

## 验收 / 收尾

- [ ] **全量测试**

```bash
node test-converse.mjs && node test-converse-loop.mjs && node test-react.mjs && node test-react-loop.mjs && node test-reflect.mjs && node test-reflect-tree.mjs && node test-plan.mjs && node test-plan-loop.mjs && node test-actionitems.mjs && node test-market.mjs && node test-market-loop.mjs && node test-world.mjs >/dev/null && node test-sim.mjs >/dev/null && node test-minutes.mjs >/dev/null && node test-board.mjs >/dev/null && node test-feed.mjs >/dev/null && node test-agent.mjs >/dev/null && node test-records.mjs >/dev/null && node test-activity.mjs >/dev/null && echo "ALL GREEN"
cd sidecar && node --test 2>&1 | grep -E "# (pass|fail)"
```
Expected: `ALL GREEN` + sidecar 全过（本计划不改 sidecar）。

- [ ] **降级冒烟（人工说明，沙箱跑不动真机/真 LLM 则如实标注环境限制）**
  - 无 LLM：协作回退 3 轮定轮台词收尾、会议照常轮转、纪要收割不变；`collabBusy` 始终清理（test-sim 跑满 3 天验证）。
  - 有 LLM：协作每轮自决 done、上限 6 轮；会议允许「没什么补充」跳过，全员跳过则安静收尾。

- [ ] **最终审查后合并**：feature 分支跑完 final review（spec 覆盖 + 质量），再本地合 main + push。**P3（完整斯坦福化）至此全部完成。**

---

## Self-Review（对照 spec）

**Spec 覆盖（设计文档第 132-134 行）：**
- 协作讨论从写死 3 轮改为循环、每轮 {utterance, done} 自决结束、上限 6 轮 → Task 4 converse 循环 + `maxTurns=6` ✅
- 会议保留轮转但允许跳过（"没什么要补充"）→ Task 5 `st.done` 跳过 + 全员 done 安静收尾 ✅
- 每轮发言者输出 {utterance, done} → Task 1 `parseTurn` + Task 2 `llm.converseTurn` ✅
- 会议结束生成纪要（P3a 已实现，本计划不动）→ `finishMeetings` 在相位切换收割 `st.transcript`，不受影响 ✅

**本阶段明确不做（YAGNI）：** 协作里也接入"会议结束纪要"（协作非正式会议，无纪要）；done 的可视化角标。

**风险与保证：** converse 循环靠 `turnNo >= maxTurns` 上限**保证终止**，`finishCollab` 必清理 `collabBusy`；相位切换/日终既有 `collabBusy.clear()` 兜底；无 llm 时行为退回原有定轮，回归 test-sim 跑满 3 天验证无泄漏无报错。

**Placeholder 扫描：** 无 TBD；每步含完整代码与命令。
**类型一致性：** `parseTurn→{utterance,done}` 在 converse.js/llm.converseTurn/director.converseTurn/测试一致；`director.converseTurn(agent, scene, fallback, {onTurn})` 的 `onTurn(text, done)` 回调签名在 maybeStartCollab/runMeetingTalk/测试一致；`freshMeet` 的 `done:Set` 在 runMeetingTalk/测试一致。
