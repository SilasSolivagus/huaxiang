# 现实连接 P2c（会议 tool-use + 真实指标接入世界模型）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让产研团队的讨论真正咬合真实代码与真实代码健康度：① 用 sidecar 静态分析的**真实 TODO/技术债**替换世界模型里虚构的 Bug 数与技术债，流入每日公司公告（全员记忆）；② 把**每日仓库摘要**（最近提交 + 热点文件）注入产研区的站会/评审场景；③ 在产研区协作讨论时把**真实代码片段（grep 命中的 file:line）**注入发言上下文，让 Agent 引用真实文件和代码行。

**Architecture:** 采用 **RAG 注入** 而非原生 tool-use 循环——sidecar 已有的 `/api/repo/grep`、`/api/repo/digest`、`/api/analysis`（P2a）由前端 `feed.js` 取回，director 在合适时机把这些真实信息拼进发言/会议/协作的 scene 文本里。相比为 anthropic 与 openai 两个 provider 各实现一套函数调用循环，RAG 注入 provider 无关、可离线降级，且用户可见效果一致（Agent 讨论真实代码）。世界模型 `world.js` 增加 `applyAnalysis` 摄入真实指标。全部在 sidecar 离线时优雅降级（feed 方法返回 null → 不注入 → 行为同 P2b）。

**Tech Stack:** 纯前端 ES Module（无构建）+ 已有 sidecar 端点，沿用 `test-*.mjs`。

**约定：**
- 前端测试在仓库根 `node test-*.mjs`；sidecar 不改动（端点 P2a 已就绪）
- 当前分支 main；本计划在新分支 `feature/p2c-code-aware` 执行，每任务一 commit
- 核心不变量：sidecar/repo 不可用时 feed 方法返回 null，director 不注入任何东西，发言回退 P2b 行为，不抛错
- commit message 末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: world.js 摄入真实分析指标

**Files:**
- Modify: `js/world.js`
- Test: 追加到 `test-world.mjs`

**背景：** `world.metrics.bugs` 现在是虚构的、每天随机漂移。本任务加 `applyAnalysis(a)`：用真实 `todoCount` 设 `bugs`，存技术债热点，并让 `metricsSummary` 在用真实数据时标注。World 构造函数需初始化 `bugsReal=false`、`techDebt=[]`。

- [ ] **Step 1: 在 `test-world.mjs` 末尾（ALL WORLD TESTS PASSED 之前）追加失败测试**

```js
// ---- 真实分析指标接入世界模型 ----
const w5 = new World(DEFAULT_COMPANY);
const applied = w5.applyAnalysis({ todoCount: 42, fileCount: 50, hotFiles: [{ path: "js/office.js", lines: 320 }, { path: "js/director.js", lines: 410 }] });
if (applied !== true) throw new Error("applyAnalysis 应返回 true");
if (w5.metrics.bugs !== 42) throw new Error("bugs 应取真实 todoCount");
if (w5.bugsReal !== true) throw new Error("应标记 bugsReal");
if (!w5.metricsSummary().includes("真实代码")) throw new Error("摘要应标注来自真实代码扫描");
if (!w5.metricsSummary().includes("director.js")) throw new Error("摘要应含技术债热点文件");
// 非法输入安全返回 false，不污染
const before = w5.metrics.bugs;
if (w5.applyAnalysis(null) !== false) throw new Error("null 应返回 false");
if (w5.metrics.bugs !== before) throw new Error("非法输入不应改指标");
console.log("真实分析指标接入验证 ✓");
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（`w5.applyAnalysis is not a function`）

- [ ] **Step 3: 修改 `js/world.js`**

在 World 构造函数末尾（`generateEvents()` 调用之前或之后均可，建议之前）加初始化：

```js
    this.bugsReal = false;
    this.techDebt = [];
```

新增 `applyAnalysis` 方法（放在 `metricsSummary` 之前）：

```js
  /** 摄入 sidecar 静态分析的真实指标：用真实 TODO 数替换虚构 Bug 数，记录技术债热点 */
  applyAnalysis(a) {
    if (!a || typeof a.todoCount !== "number") return false;
    this.metrics.bugs = Math.max(0, Math.min(999, Math.round(a.todoCount)));
    this.bugsReal = true;
    this.techDebt = Array.isArray(a.hotFiles) ? a.hotFiles.slice(0, 3) : [];
    this.clampMetrics();
    this.save();
    return true;
  }
```

把 `metricsSummary` 改为（标注真实来源 + 附技术债）：

```js
  metricsSummary() {
    const m = this.metrics;
    let s = `今日产品数据：日活 ${m.dau.toLocaleString()}，用户满意度 ${m.sat} 分，` +
      `待修 Bug ${m.bugs} 个${this.bugsReal ? "（来自真实代码扫描）" : ""}，` +
      `服务器${m.serverOk ? "运行正常" : "出现故障"}，现金还能支撑约 ${m.runway} 个月。`;
    if (this.techDebt && this.techDebt.length) {
      s += ` 技术债热点：${this.techDebt.map(f => f.path).join("、")}。`;
    }
    return s;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: 含 `真实分析指标接入验证 ✓` 与 `ALL WORLD TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/world.js test-world.mjs
git commit -m "feat(world): ingest real static-analysis metrics (bugs/tech-debt)"
```

---

### Task 2: feed.js 取仓库摘要 / 分析 / 检索

**Files:**
- Modify: `js/feed.js`
- Test: 追加到 `test-feed.mjs`

- [ ] **Step 1: 在 `test-feed.mjs` 末尾（ALL FEED TESTS PASSED 之前）追加失败测试**

`test-feed.mjs` 顶部已 `import { diffPolicies, Feed } from "./js/feed.js";`（P2b 改过）。追加：

```js
const f2 = new Feed();   // 未 connect → online=false
if (await f2.analysis() !== null) throw new Error("离线 analysis 应返回 null");
if (await f2.repoDigest() !== null) throw new Error("离线 repoDigest 应返回 null");
if (await f2.repoGrep("x") !== null) throw new Error("离线 repoGrep 应返回 null");
console.log("feed 仓库方法离线回退验证 ✓");
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-feed.mjs`
Expected: FAIL（`f2.analysis is not a function`）

- [ ] **Step 3: 在 `js/feed.js` 的 Feed 类加三个方法（放在 embed 方法之后）**

```js
  /** 取静态分析指标（文件数/TODO/热点），离线返回 null */
  async analysis() {
    if (!this.online) return null;
    try {
      const res = await fetch("/api/analysis");
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /** 取每日仓库摘要文本，离线返回 null */
  async repoDigest() {
    if (!this.online) return null;
    try {
      const res = await fetch("/api/repo/digest");
      if (!res.ok) return null;
      const data = await res.json();
      return data.text || null;
    } catch { return null; }
  }

  /** 代码检索，返回 [{file,line,text}] 或 null（离线/无命中处理交给调用方） */
  async repoGrep(q) {
    if (!this.online || !q) return null;
    try {
      const res = await fetch(`/api/repo/grep?q=${encodeURIComponent(q)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.hits) ? data.hits : null;
    } catch { return null; }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-feed.mjs`
Expected: 含 `feed 仓库方法离线回退验证 ✓` 与 `ALL FEED TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/feed.js test-feed.mjs
git commit -m "feat(frontend): feed methods for repo analysis/digest/grep"
```

---

### Task 3: director 摄入仓库状态 + 把摘要注入产研会议

**Files:**
- Modify: `js/director.js`
- Test: 追加到 `test-world.mjs`

**背景：** director 加 `this.repoDigest = null`（构造时）和 `async refreshRepoState()`：从 feed 取分析喂给 world、取摘要存起来。新的一天触发刷新。`meetingScene` 在产研区把摘要拼进去。

- [ ] **Step 1: 在 `test-world.mjs` 末尾追加失败测试**

```js
// ---- director 摄入仓库状态 + 产研会议注入摘要 ----
class RepoStubFeed {
  takeEvents() { return []; }
  activePolicies() { return []; }
  async analysis() { return { todoCount: 17, fileCount: 50, hotFiles: [{ path: "js/director.js", lines: 400 }] }; }
  async repoDigest() { return "最近提交（2 条）：\n  - abc 加了限速逻辑\n  - def 修了上传 bug"; }
  async repoGrep() { return null; }
}
const w6 = new World(DEFAULT_COMPANY);
const d6 = new Director(PERSONAS.slice(0, 3).map((p, i) => new StubAgent(p, "r" + i)), office, () => {}, null, w6, new RepoStubFeed());
await d6.refreshRepoState();
if (w6.metrics.bugs !== 17) throw new Error("refreshRepoState 应把真实 todoCount 喂给 world");
if (d6.repoDigest === null) throw new Error("refreshRepoState 应存下仓库摘要");
const sc = d6.meetingScene({ type: "review" }, "rd");
if (!sc.includes("限速逻辑")) throw new Error("产研会议场景应注入仓库摘要");
const scOps = d6.meetingScene({ type: "review" }, "ops");
if (scOps.includes("限速逻辑")) throw new Error("运营会议不应注入代码摘要");
console.log("director 仓库状态注入验证 ✓");
```

注意：`test-world.mjs` 里已有 `StubAgent` 类（带 memory）和 `office`、`PERSONAS`、`World`、`Director` 的 import。若 StubAgent 定义在该测试块之后，请把这段测试放到 StubAgent 定义之后（即文件靠后位置，仍在 ALL WORLD TESTS PASSED 之前）。

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（`d6.refreshRepoState is not a function`）

- [ ] **Step 3: 修改 `js/director.js`**

构造函数里（`this.todayHighlights = [];` 附近）加：

```js
    this.repoDigest = null;          // 每日仓库摘要（来自 sidecar）
```

新增方法（放在 `broadcastDaily` 之后）：

```js
  /** 从 feed 摄入真实仓库状态：分析指标喂给世界模型，摘要存下来注入会议 */
  async refreshRepoState() {
    if (!this.feed) return;
    try {
      const a = await this.feed.analysis?.();
      if (a && this.world) this.world.applyAnalysis(a);
      const d = await this.feed.repoDigest?.();
      if (d) this.repoDigest = d;
    } catch { /* sidecar 不可用：保持纯模拟，不注入 */ }
  }
```

`meetingScene` 改为产研区注入摘要：

```js
  meetingScene(phase, zone) {
    if (zone === "ops") {
      const goal = phase.type === "standup"
        ? "运营团队每日站会，同步运营数据、客服反馈和 B 端进展"
        : "运营团队评审会，复盘活动效果、用户口碑和商业化进展";
      return `${goal}。今天是第 ${this.day} 个工作日。`;
    }
    const goal = phase.type === "standup"
      ? "产研团队每日站会，每人同步进展、技术/产品计划和遇到的问题"
      : "产研团队项目评审会，讨论产品现状、市场动态、技术风险和下一步计划";
    const base = `${goal}。今天是第 ${this.day} 个工作日。`;
    return this.repoDigest ? `${base}\n代码仓库近况：${this.repoDigest}` : base;
  }
```

在 update() 的新一天块里（`this.broadcastDaily();` 之前）触发刷新（先刷新真实指标，再发公告，这样当天公告带上真实 Bug/技术债）。把那一段：

```js
      this.todayRecord = freshRecord();
      this.todayHighlights = [];
      this.log(`☀️ 第 ${this.day} 天开始了`, "log-meeting");
      this.broadcastDaily();
```

改为：

```js
      this.todayRecord = freshRecord();
      this.todayHighlights = [];
      this.log(`☀️ 第 ${this.day} 天开始了`, "log-meeting");
      this.refreshRepoState().then(() => this.broadcastDaily());
```

（refreshRepoState 是 async；fire-and-forget 后再发公告，保证公告用上当天刚摄入的真实指标。feed 离线时 refreshRepoState 立即 resolve、不改任何东西。）

注意：构造函数末尾也调用了一次 `this.broadcastDaily()`（开局第 1 天）。构造函数不是 async，无法 await refreshRepoState；开局这次保持原样（`this.broadcastDaily()` 不动），由 main.js 在 feed.connect() 成功后调用 `director.refreshRepoState()` 补摄入（见 Task 5）。即：构造里 `this.broadcastDaily();` 保持不变。

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-world.mjs && node test-sim.mjs`
Expected: 含 `director 仓库状态注入验证 ✓` 与 `ALL WORLD TESTS PASSED`；test-sim 正常（无 feed → refreshRepoState 不被调，meetingScene 无摘要）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/director.js test-world.mjs
git commit -m "feat(director): ingest repo state, inject digest into 产研 meetings"
```

---

### Task 4: 协作讨论注入真实代码片段

**Files:**
- Modify: `js/director.js`
- Test: 追加到 `test-world.mjs`

**背景：** 在产研区协作时，按产品域关键词 grep 真实代码，把命中的 `file:line` 拼进协作 scene，让 Agent 引用真实代码。先做纯函数 `codeRefNote(hits)`（可测），再 best-effort 接进 collab。

- [ ] **Step 1: 在 `test-world.mjs` 末尾追加失败测试**

```js
// ---- 代码引用便签（纯函数）----
import { codeRefNote } from "./js/director.js";
if (codeRefNote(null) !== "") throw new Error("无命中应返回空串");
if (codeRefNote([]) !== "") throw new Error("空数组应返回空串");
const note = codeRefNote([{ file: "js/office.js", line: 120, text: "function buildOffice()" }]);
if (!note.includes("js/office.js") || !note.includes("120")) throw new Error("便签应含 file:line");
console.log("代码引用便签验证 ✓");
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（`codeRefNote is not a function` / 无此导出）

- [ ] **Step 3: 修改 `js/director.js`**

在文件末尾（`freshRecord` 函数附近，模块级）加导出：

```js
const DOMAIN_TERMS = ["限速", "带宽", "直链", "上传", "下载", "分享", "存储", "会员"];

export function codeRefNote(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return "";
  const h = hits[0];
  if (!h || !h.file) return "";
  return `（讨论中翻了下代码：${h.file}:${h.line} ${String(h.text || "").trim().slice(0, 40)}）`;
}
```

在 `maybeStartCollab` 里，确定 zone 之后、构造 scene 之前（即 `const tx = [];` 那行附近），加入 best-effort 代码检索注入：

把 collab 里：

```js
    const tx = [];   // 本次协作的对话上下文
    const scene = `工位旁的工作讨论：${visitor.persona.name} 走到 ${host.persona.name} 的工位。结合你记得的事情聊一个具体话题。`;
```

改为：

```js
    const tx = [];   // 本次协作的对话上下文
    let codeNote = "";
    if (zone === "rd" && this.feed?.repoGrep) {
      const term = DOMAIN_TERMS[Math.floor(Math.random() * DOMAIN_TERMS.length)];
      this.feed.repoGrep(term).then(hits => { codeNote = codeRefNote(hits); }).catch(() => {});
    }
    const sceneBase = `工位旁的工作讨论：${visitor.persona.name} 走到 ${host.persona.name} 的工位。结合你记得的事情聊一个具体话题。`;
```

并把后面 `turn` 函数里用到的 `scene` 改为动态拼接 `sceneBase + codeNote`（codeNote 在首轮发言前通常已 resolve；未就绪则为空，无害）。即把 turn 定义：

```js
    const turn = (agent, fallbackPool) => {
      this.speakSmart(agent, sceneBase + codeNote, pick(fallbackPool), {
        radius: HEAR_RADIUS_TALK,
        importance: 4,
        logCls: "log-collab",
        transcript: tx,
        onDone: (text) => tx.push(`${agent.persona.name}：${text}`)
      });
    };
```

（注意：原代码里 `turn` 用的是 `scene`，现在统一改成 `sceneBase + codeNote`。确保 collab 内不再引用未定义的 `scene`。）

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-world.mjs && node test-sim.mjs`
Expected: 含 `代码引用便签验证 ✓` 与 `ALL WORLD TESTS PASSED`；test-sim 正常（无 feed → 不 grep，codeNote 恒为空，collab 照常）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/director.js test-world.mjs
git commit -m "feat(director): inject real code snippet into 产研 collaboration"
```

---

### Task 5: main.js 接线 + 仪表盘真实指标标记

**Files:**
- Modify: `js/main.js`

- [ ] **Step 1: 在 `js/main.js` 的 `feed.connect().then(ok => {...})` 回调里，连接成功后补一次仓库状态摄入**

找到 `feed.connect().then(ok => {` 块，在 `if (!ok) return;` 之后加入：

```js
  director.refreshRepoState();   // 开局补摄入真实仓库指标与摘要（构造时 feed 尚未连上）
```

- [ ] **Step 2: 仪表盘 Bug 指标标注真实来源**

找到 `renderDashboard()` 里渲染 Bug 的那行（形如 `metric("Bug", \`${m.bugs} 个\`, ...)`），把标签改为按 `world.bugsReal` 标注：

```js
    metric(world.bugsReal ? "Bug📂" : "Bug", `${m.bugs} 个`, m.bugs > 22 ? "bad" : m.bugs < 8 ? "good" : "") +
```

（📂 表示来自真实代码扫描；其余指标行不动。）

- [ ] **Step 3: 语法检查**

Run: `cd /Users/silas/huaxiang && node --check js/main.js && echo "main.js OK"`
Expected: main.js OK

- [ ] **Step 4: Commit**

```bash
cd /Users/silas/huaxiang
git add js/main.js
git commit -m "feat(frontend): wire repo-state ingest, mark real bug metric on dashboard"
```

---

### Task 6: README + 全量回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 `README.md` 的 embedding 那段 `>` 引用之后追加一句**

```markdown
> 代码咬合讨论：挂载 `repoPath` 后，产研团队的站会/评审会带上**每日仓库摘要**（最近提交、热点文件），协作讨论会引用**真实代码片段**（grep 命中的文件与行号），世界模型里的「待修 Bug」也会用**真实的 TODO/技术债扫描**替换（仪表盘标 📂）。这些都在 sidecar 在线且配置了 `repoPath` 时生效，否则回退纯模拟。
```

- [ ] **Step 2: 全量回归**

```bash
cd /Users/silas/huaxiang && for t in test-board test-feed test-world test-sim test-agent; do printf "%s: " "$t"; node $t.mjs 2>/dev/null | tail -1; done
cd /Users/silas/huaxiang/sidecar && node --test 2>&1 | grep -E "^# (pass|fail)"
```
Expected: 前端 5 脚本全绿（test-world 含三条新验证、test-feed 含一条）；sidecar 仍 47 pass（未改动）。

- [ ] **Step 3: Commit**

```bash
cd /Users/silas/huaxiang
git add README.md
git commit -m "docs: code-aware meetings and real metrics in world model"
```

---

## 验收清单（对照 spec P2 中本子计划覆盖部分）

- [x] 会议 tool-use（Agent 讨论引用真实代码）——以 RAG 注入实现：摘要进产研会议（Task 3）、grep 片段进产研协作（Task 4）
- [x] 真实 Bug/技术债替换世界模型虚构指标，流入每日公告全员记忆（Task 1, 3）
- [x] 仪表盘标注真实来源（Task 5）
- [x] 优雅降级：sidecar/repo 不可用 → feed 方法 null → 不注入、回退纯模拟（Task 2, 3, 4 全程）
- 本子计划不含（留给 P2d）：web search 采集器、竞品页 diff 采集器
- 说明：未实现 anthropic/openai 原生函数调用循环；改用 provider 无关的 RAG 注入达到等价的用户可见效果（Agent 讨论真实代码）
