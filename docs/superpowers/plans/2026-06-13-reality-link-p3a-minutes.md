# P3a：会议纪要 + 产出物库 + 行动项 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让两个办公区的会议结束时自动生成结构化纪要（决议/风险/行动项），存入 sidecar 产出物库供翻阅；行动项写入负责人记忆，成为后续计划的输入。

**Architecture:** sidecar 新增 `artifacts` 表 + `ArtifactStore` + `GET/POST /api/artifacts`（照 `eventStore`/`policyStore` 现成模式）。前端新增纯函数模块 `js/cognition/minutes.js`（归一化模型输出），`LLMClient` 新增 `minutes()` 调用，`Feed` 新增产出物读写方法，`Director` 在离开会议相位时收割本场发言记录生成纪要。全程降级：LLM 不可用则不生成纪要、sidecar 离线则产出物静默丢弃但行动项仍进记忆，模拟永不停。

**Tech Stack:** Node ≥22 内置 `node:sqlite` + Express（sidecar）；浏览器原生 ESM + Three.js（前端）；测试用 `node --test`（sidecar）与根目录 `node test-*.mjs`（前端，纯断言无框架）。

**这是 P3「斯坦福化」的第一个子阶段**，完成「讨论 → 产出物」的前半闭环。后续 P3b 接「行动项状态机 + 市场反应模拟器」消费这里产出的行动项。

---

## 文件结构

**sidecar/**
- `sidecar/src/db.js`（修改）：`SCHEMA` 增加 `artifacts` 表
- `sidecar/src/contracts.js`（修改）：新增 `normalizeArtifact(raw)`
- `sidecar/src/artifactStore.js`（新建）：`ArtifactStore` 类，`add` / `list`
- `sidecar/src/server.js`（修改）：`buildApp` 接收 `artifactStore`，注册 `GET/POST /api/artifacts`；底部 `if (process.argv...)` 入口构造并注入
- `sidecar/test/contracts.test.mjs`（修改）：追加 `normalizeArtifact` 测试
- `sidecar/test/artifactStore.test.mjs`（新建）：Store 增删查测试
- `sidecar/test/server.test.mjs`（修改）：追加 `/api/artifacts` 端点测试

**前端 js/**
- `js/cognition/minutes.js`（新建）：纯函数 `normalizeMinutes` / `minutesEmpty` / `minutesToText`
- `js/llm.js`（修改）：`import { normalizeMinutes }` + 新增 `minutes()` 方法
- `js/feed.js`（修改）：新增 `writeArtifact(data)` / `readArtifacts({type, day})`
- `js/director.js`（修改）：`import { minutesEmpty, minutesToText }` + 相位切换时调 `finishMeetings` + 新增 `finishMeetings` / `runMeetingMinutes`
- `test-minutes.mjs`（新建）：minutes 纯函数测试 + Director 收割集成测试

---

## Task 1：sidecar — artifacts 表 + normalizeArtifact 契约

**Files:**
- Modify: `sidecar/src/db.js`（SCHEMA）
- Modify: `sidecar/src/contracts.js`
- Test: `sidecar/test/contracts.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**（追加到 `sidecar/test/contracts.test.mjs` 末尾）

```js
import { normalizeArtifact } from "../src/contracts.js";

test("normalizeArtifact 补全默认值并生成 id", () => {
  const a = normalizeArtifact({ type: "minutes", content: "今天决定上线限速优化" });
  assert.match(a.id, /^art_/);
  assert.equal(a.type, "minutes");
  assert.equal(a.day, 0);
  assert.equal(a.content, "今天决定上线限速优化");
  assert.equal(a.meta, null);
  assert.ok(a.ts > 1000000000000);
});

test("normalizeArtifact 拒绝空类型和空正文", () => {
  assert.throws(() => normalizeArtifact({ type: "", content: "x" }));
  assert.throws(() => normalizeArtifact({ type: "minutes", content: "  " }));
  assert.throws(() => normalizeArtifact(null));
});

test("normalizeArtifact 保留 day / meta，截断超长正文与类型", () => {
  const a = normalizeArtifact({ type: "minutes", day: 5, content: "决议X", meta: { zone: "rd", decisions: ["a"] } });
  assert.equal(a.day, 5);
  assert.deepEqual(a.meta, { zone: "rd", decisions: ["a"] });
  const long = normalizeArtifact({ type: "x".repeat(80), content: "y".repeat(5000) });
  assert.equal(long.type.length, 40);
  assert.equal(long.content.length, 4000);
  // 非对象 meta 归一化为 null
  assert.equal(normalizeArtifact({ type: "t", content: "c", meta: "oops" }).meta, null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd sidecar && node --test test/contracts.test.mjs`
Expected: FAIL — `normalizeArtifact is not a function`（import 报错或断言失败）

- [ ] **Step 3: 实现 normalizeArtifact**（追加到 `sidecar/src/contracts.js` 末尾，`randomUUID` 已在文件顶部 import）

```js
export function normalizeArtifact(raw) {
  if (!raw || typeof raw !== "object") throw new Error("artifact must be an object");
  const type = String(raw.type || "").trim();
  if (!type) throw new Error("artifact.type required");
  const content = String(raw.content || "").trim();
  if (!content) throw new Error("artifact.content required");
  return {
    id: raw.id || `art_${randomUUID().slice(0, 8)}`,
    ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : Date.now(),
    type: type.slice(0, 40),
    day: Number.isFinite(Number(raw.day)) ? Number(raw.day) : 0,
    content: content.slice(0, 4000),
    meta: raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta) ? raw.meta : null
  };
}
```

- [ ] **Step 4: 给 db.js 增加 artifacts 表**（在 `sidecar/src/db.js` 的 `SCHEMA` 模板字符串内，`page_snapshots` 表之后、闭合反引号之前追加）

```sql
CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  day INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  meta TEXT
);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd sidecar && node --test test/contracts.test.mjs`
Expected: PASS（全部 contracts 测试通过）

- [ ] **Step 6: 提交**

```bash
git add sidecar/src/db.js sidecar/src/contracts.js sidecar/test/contracts.test.mjs
git commit -m "feat(sidecar): artifact contract + artifacts table"
```

---

## Task 2：sidecar — ArtifactStore

**Files:**
- Create: `sidecar/src/artifactStore.js`
- Test: `sidecar/test/artifactStore.test.mjs`

- [ ] **Step 1: 写失败测试**（新建 `sidecar/test/artifactStore.test.mjs`）

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { ArtifactStore } from "../src/artifactStore.js";

function freshStore() {
  return new ArtifactStore(openDb(":memory:"));
}

test("add 落库并回填归一化结果", () => {
  const s = freshStore();
  const a = s.add({ type: "minutes", day: 3, content: "决议：上线限速", meta: { zone: "rd" } });
  assert.match(a.id, /^art_/);
  assert.equal(a.day, 3);
  assert.deepEqual(a.meta, { zone: "rd" });
});

test("list 默认按 ts 倒序，可按 type / day 过滤", () => {
  const s = freshStore();
  s.add({ type: "minutes", day: 1, content: "一", ts: 100 });
  s.add({ type: "minutes", day: 2, content: "二", ts: 200 });
  s.add({ type: "report", day: 2, content: "三", ts: 300 });

  const all = s.list();
  assert.equal(all.length, 3);
  assert.equal(all[0].content, "三");   // ts 最大在前

  const minutes = s.list({ type: "minutes" });
  assert.equal(minutes.length, 2);
  assert.ok(minutes.every(a => a.type === "minutes"));

  const day2 = s.list({ day: 2 });
  assert.equal(day2.length, 2);
  assert.ok(day2.every(a => a.day === 2));

  const both = s.list({ type: "minutes", day: 2 });
  assert.equal(both.length, 1);
  assert.equal(both[0].content, "二");
});

test("list 尊重 limit", () => {
  const s = freshStore();
  for (let i = 0; i < 5; i++) s.add({ type: "minutes", content: "c" + i, ts: i });
  assert.equal(s.list({ limit: 2 }).length, 2);
});

test("add 非法输入抛错", () => {
  const s = freshStore();
  assert.throws(() => s.add({ type: "", content: "x" }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd sidecar && node --test test/artifactStore.test.mjs`
Expected: FAIL — `Cannot find module ... artifactStore.js`

- [ ] **Step 3: 实现 ArtifactStore**（新建 `sidecar/src/artifactStore.js`）

```js
// 产出物存储：会议纪要 / 日报 / 市场反馈等结构化产出。照 eventStore/policyStore 模式。
import { normalizeArtifact } from "./contracts.js";

export class ArtifactStore {
  constructor(db) {
    this.db = db;
  }

  add(raw) {
    const a = normalizeArtifact(raw);
    this.db.prepare(
      "INSERT INTO artifacts(id, ts, type, day, content, meta) VALUES(?, ?, ?, ?, ?, ?)"
    ).run(a.id, a.ts, a.type, a.day, a.content, a.meta ? JSON.stringify(a.meta) : null);
    return a;
  }

  list({ type, day, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (type) { where.push("type = ?"); args.push(String(type)); }
    if (day !== undefined && day !== null && day !== "") { where.push("day = ?"); args.push(Number(day)); }
    const sql = `SELECT * FROM artifacts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`;
    args.push(Number(limit) || 50);
    return this.db.prepare(sql).all(...args).map(rowToArtifact);
  }
}

function rowToArtifact(r) {
  return {
    id: r.id, ts: r.ts, type: r.type, day: r.day,
    content: r.content, meta: r.meta ? JSON.parse(r.meta) : null
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd sidecar && node --test test/artifactStore.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add sidecar/src/artifactStore.js sidecar/test/artifactStore.test.mjs
git commit -m "feat(sidecar): ArtifactStore add/list with type/day filter"
```

---

## Task 3：sidecar — /api/artifacts 端点

**Files:**
- Modify: `sidecar/src/server.js`
- Test: `sidecar/test/server.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**（追加到 `sidecar/test/server.test.mjs` 末尾。自建带 artifactStore 的 app，模式照文件内 `/api/embed` 测试）

```js
import { ArtifactStore } from "../src/artifactStore.js";

test("/api/artifacts：POST 写入、GET 按 type/day 翻阅；未配置返回 503", async () => {
  const db = openDb(":memory:");
  const status = { collectors: { rss: { enabled: false, reason: "test" } } };
  const artifactStore = new ArtifactStore(db);
  const app = buildApp({ eventStore: new EventStore(db), policyStore: new PolicyStore(db), status, artifactStore });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await (await fetch(`${base}/api/artifacts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "minutes", day: 4, content: "决议：上线限速优化", meta: { zone: "rd" } })
  })).json();
  assert.match(created.id, /^art_/);

  const bad = await fetch(`${base}/api/artifacts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "", content: "x" })
  });
  assert.equal(bad.status, 400);

  const list = await (await fetch(`${base}/api/artifacts?type=minutes&day=4`)).json();
  assert.equal(list.artifacts.length, 1);
  assert.equal(list.artifacts[0].content, "决议：上线限速优化");

  const none = await (await fetch(`${base}/api/artifacts?day=99`)).json();
  assert.equal(none.artifacts.length, 0);

  // 未注入 artifactStore 的 app（startTestServer）→ 503
  const { server: s2, base: base2 } = await startTestServer();
  after(() => s2.close());
  assert.equal((await fetch(`${base2()}/api/artifacts`)).status, 503);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd sidecar && node --test test/server.test.mjs`
Expected: FAIL — 新增 case 失败（POST 返回 404 而非 200，因路由不存在）

- [ ] **Step 3: 在 buildApp 注册路由**

`sidecar/src/server.js` 第 35 行的 `buildApp` 解构参数追加 `artifactStore = null`：

```js
export function buildApp({ eventStore, policyStore, status, repo = null, analysisProvider = null, digestProvider = null, embedder = null, artifactStore = null }) {
```

在 `app.delete("/api/policies/:id", ...)`（约第 69 行）之后插入：

```js
  // ---------- 产出物库（会议纪要 / 日报 / 市场反馈）----------
  const artifactGuard = (req, res, next) => {
    if (!artifactStore) return res.status(503).json({ error: "artifacts 未启用" });
    next();
  };
  app.get("/api/artifacts", artifactGuard, (req, res) => {
    res.json({ artifacts: artifactStore.list({ type: req.query.type, day: req.query.day, limit: Number(req.query.limit) || 50 }) });
  });
  app.post("/api/artifacts", artifactGuard, (req, res) => {
    try { res.json(artifactStore.add(req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
```

- [ ] **Step 4: 入口接线**（`sidecar/src/server.js` 底部 `if (process.argv[1] === ...)` 块内）

在 `const policyStore = new PolicyStore(db);`（约第 136 行）之后追加：

```js
  const { ArtifactStore } = await import("./artifactStore.js");
  const artifactStore = new ArtifactStore(db);
```

并在调用 `buildApp({ eventStore, policyStore, status, repo, ... })`（约第 182 行）的参数对象里加入 `artifactStore`：

```js
  const app = buildApp({
    eventStore, policyStore, artifactStore, status, repo,
    analysisProvider: repo ? () => analyzeRepo(repo) : null,
    digestProvider: repo ? () => repoDigest(repo, { maxCommits: cfg.repoDigestMaxCommits }) : null,
    embedder
  });
```

- [ ] **Step 5: 运行全量 sidecar 测试确认通过**

Run: `cd sidecar && node --test`
Expected: PASS（含原有 55 测试 + 本次新增，无回归）

- [ ] **Step 6: 提交**

```bash
git add sidecar/src/server.js sidecar/test/server.test.mjs
git commit -m "feat(sidecar): GET/POST /api/artifacts endpoints"
```

---

## Task 4：前端 — minutes.js 纯函数

**Files:**
- Create: `js/cognition/minutes.js`
- Test: `test-minutes.mjs`

- [ ] **Step 1: 写失败测试**（新建 `test-minutes.mjs`）

```js
import { normalizeMinutes, minutesEmpty, minutesToText } from "./js/cognition/minutes.js";

// --- normalizeMinutes：对象输入 ---
const m1 = normalizeMinutes({
  decisions: ["上线限速优化", ""],
  risks: ["带宽成本上升"],
  actionItems: [
    { owner: "王强", what: "评估带宽方案" },
    { owner: "", what: "补单元测试" },
    { owner: "李雷", what: "" }   // 无 what → 丢弃
  ]
});
if (m1.decisions.length !== 1) throw new Error("空决议应被过滤");
if (m1.actionItems.length !== 2) throw new Error("无 what 的行动项应被丢弃，应剩 2 条");
if (m1.actionItems[1].owner !== "") throw new Error("允许 owner 为空");

// --- normalizeMinutes：JSON 字符串（含 ```json 围栏）---
const m2 = normalizeMinutes('```json\n{"decisions":["a"],"risks":[],"actionItems":[]}\n```');
if (m2.decisions[0] !== "a") throw new Error("应能解析带围栏的 JSON 字符串");

// --- normalizeMinutes：垃圾输入 → 空结构 ---
const m3 = normalizeMinutes("not json at all");
if (!minutesEmpty(m3)) throw new Error("垃圾输入应得空纪要");
if (!minutesEmpty(normalizeMinutes(null))) throw new Error("null 应得空纪要");
if (!minutesEmpty(normalizeMinutes([1, 2, 3]))) throw new Error("数组应得空纪要");

// --- 各列上限 4 条 ---
const m4 = normalizeMinutes({ decisions: ["1", "2", "3", "4", "5"], risks: [], actionItems: [] });
if (m4.decisions.length !== 4) throw new Error("决议应截断到 4 条");

// --- minutesToText：人类可读，含三段标题 ---
const text = minutesToText(m1);
if (!text.includes("【决议】") || !text.includes("【行动项】")) throw new Error("正文应含分段标题");
if (!text.includes("王强：评估带宽方案")) throw new Error("行动项应渲染 owner");

console.log("minutes helpers OK");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test-minutes.mjs`
Expected: FAIL — `Cannot find module ... js/cognition/minutes.js`

- [ ] **Step 3: 实现 minutes.js**（新建 `js/cognition/minutes.js`）

```js
// 纯函数：把模型输出的会议纪要归一化为 {decisions, risks, actionItems}，并渲染为可读正文。
// 认知层 B 接口模块——无副作用、可单测，供 llm.minutes() 与 director 复用。

function strList(v, max = 4) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || "").trim()).filter(Boolean).map(s => s.slice(0, 60)).slice(0, max);
}

/** 归一化模型输出（对象或 JSON 字符串，可带 ```json 围栏）→ 结构化纪要。失败给空结构。 */
export function normalizeMinutes(raw) {
  let o = raw;
  if (typeof raw === "string") {
    const clean = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    try { o = JSON.parse(clean); } catch { o = null; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    return { decisions: [], risks: [], actionItems: [] };
  }
  const actionItems = Array.isArray(o.actionItems)
    ? o.actionItems
        .map(a => ({
          owner: String(a?.owner || "").trim().slice(0, 20),
          what: String(a?.what || "").trim().slice(0, 60)
        }))
        .filter(a => a.what)
        .slice(0, 4)
    : [];
  return { decisions: strList(o.decisions), risks: strList(o.risks), actionItems };
}

/** 纪要是否完全为空（无任何条目）——空则不必生成产出物。 */
export function minutesEmpty(m) {
  return !m || (m.decisions.length === 0 && m.risks.length === 0 && m.actionItems.length === 0);
}

/** 渲染为人类可读正文（产出物 content）。 */
export function minutesToText(m) {
  const sections = [];
  if (m.decisions.length) sections.push("【决议】\n" + m.decisions.map(d => "· " + d).join("\n"));
  if (m.risks.length) sections.push("【风险】\n" + m.risks.map(r => "· " + r).join("\n"));
  if (m.actionItems.length) {
    sections.push("【行动项】\n" + m.actionItems.map(a => `· ${a.owner ? a.owner + "：" : ""}${a.what}`).join("\n"));
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test-minutes.mjs`
Expected: PASS — 输出 `minutes helpers OK`

- [ ] **Step 5: 提交**

```bash
git add js/cognition/minutes.js test-minutes.mjs
git commit -m "feat(cognition): minutes normalize/render pure helpers"
```

---

## Task 5：前端 — LLMClient.minutes()

**Files:**
- Modify: `js/llm.js`

无独立单测（前端无 LLM 测试框架，解析健壮性已由 Task 4 的 `normalizeMinutes` 覆盖；本方法仅是「调模型 + 交给纯函数归一化」的薄封装，将在 Task 7 的集成测试里用桩 llm 验证调用路径）。

- [ ] **Step 1: 顶部引入 normalizeMinutes**

在 `js/llm.js` 第 12 行（`USAGE_INTERVALS` 常量定义）之前、文件顶部注释之后追加 import：

```js
import { normalizeMinutes } from "./cognition/minutes.js";
```

- [ ] **Step 2: 新增 minutes() 方法**

在 `js/llm.js` 的 `digestDay()` 方法（结束于约第 192 行 `}`）之后、`async test()` 之前插入：

```js
  /**
   * 会议纪要：根据一场会议的发言记录，提炼结构化纪要。
   * @param {object} opts { company, day, scene, transcript: string[] }
   * @returns {Promise<{decisions,risks,actionItems}|null>} 失败/不可用/无记录返回 null
   */
  async minutes({ company, day, scene, transcript = [] }) {
    if (!this.available || transcript.length === 0) return null;
    return this.enqueue(async () => {
      try {
        const system =
          (company ? `公司背景：${company}\n` : "") +
          `你是会议记录员。根据下面这场会议的发言记录，提炼结构化纪要。` +
          `只输出 JSON，形如 {"decisions":["…"],"risks":["…"],"actionItems":[{"owner":"姓名","what":"待办"}]}。` +
          `decisions=会上拍板的决定，risks=暴露的风险或隐患，actionItems=明确的待办（owner 必须是发言记录里出现过的人名）。` +
          `每项不超过 40 字，各列最多 4 条，没有就给空数组。不要输出 JSON 以外的任何文字。`;
        const user = `会议场景：${scene}\n这是第 ${day} 个工作日。\n\n发言记录：\n${transcript.join("\n")}`;
        const raw = await this.chatRaw(system, user, 700);
        this.lastError = null;
        return normalizeMinutes(raw);
      } catch (e) {
        console.warn("会议纪要生成失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }
```

- [ ] **Step 3: 冒烟——确认模块仍可解析、无语法错**

Run: `node -e "import('./js/llm.js').then(()=>console.log('llm.js ok'))"`
Expected: 输出 `llm.js ok`（能 import 即语法正确；`cognition/minutes.js` 路径正确）

- [ ] **Step 4: 提交**

```bash
git add js/llm.js
git commit -m "feat(llm): minutes() structured meeting-minutes call"
```

---

## Task 6：前端 — Feed 产出物读写

**Files:**
- Modify: `js/feed.js`

- [ ] **Step 1: 写失败测试**（追加到 `test-minutes.mjs` 末尾的 `console.log("minutes helpers OK")` 之前，用注入 fetch 桩验证 URL/方法/降级）

```js
// --- Feed.writeArtifact / readArtifacts（桩 fetch）---
import { Feed } from "./js/feed.js";

const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url, method: opts?.method || "GET", body: opts?.body });
  if (String(url).startsWith("/api/artifacts") && (!opts || opts.method === undefined || opts.method === "GET")) {
    return { ok: true, json: async () => ({ artifacts: [{ id: "art_1", type: "minutes", day: 4, content: "X" }] }) };
  }
  return { ok: true, json: async () => ({ id: "art_new" }) };
};

const feed = new Feed();
feed.online = true;
const w = await feed.writeArtifact({ type: "minutes", day: 4, content: "决议X" });
if (!w || w.id !== "art_new") throw new Error("writeArtifact 应返回创建结果");
const postCall = calls.find(c => c.method === "POST");
if (!postCall || postCall.url !== "/api/artifacts") throw new Error("应 POST /api/artifacts");

const list = await feed.readArtifacts({ type: "minutes", day: 4 });
if (!Array.isArray(list) || list[0].id !== "art_1") throw new Error("readArtifacts 应返回数组");
const getCall = calls.find(c => c.method === "GET" && c.url.includes("type=minutes"));
if (!getCall || !getCall.url.includes("day=4")) throw new Error("GET URL 应含 type=minutes&day=4");

// 离线降级：不发请求、返回 null
const offline = new Feed();
offline.online = false;
if (await offline.writeArtifact({ type: "minutes", content: "x" }) !== null) throw new Error("离线 writeArtifact 应返回 null");
if (await offline.readArtifacts() !== null) throw new Error("离线 readArtifacts 应返回 null");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test-minutes.mjs`
Expected: FAIL — `feed.writeArtifact is not a function`

- [ ] **Step 3: 实现 Feed 方法**（在 `js/feed.js` 的 `repoGrep(q)` 方法之后、`ack(ids)` 之前插入）

```js
  /** 写一条产出物到 sidecar 产出物库；离线/失败静默返回 null */
  async writeArtifact(data) {
    if (!this.online || !data) return null;
    try {
      const res = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data)
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /** 翻阅产出物，返回数组或 null（离线/失败） */
  async readArtifacts({ type, day } = {}) {
    if (!this.online) return null;
    try {
      const qs = new URLSearchParams();
      if (type) qs.set("type", type);
      if (day !== undefined && day !== null) qs.set("day", String(day));
      const res = await fetch(`/api/artifacts?${qs.toString()}`);
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.artifacts) ? data.artifacts : null;
    } catch { return null; }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test-minutes.mjs`
Expected: PASS（注意：此步 `test-minutes.mjs` 顶部纯函数断言 + Feed 断言全过；末尾 `minutes helpers OK` 仍在最后输出）

- [ ] **Step 5: 提交**

```bash
git add js/feed.js test-minutes.mjs
git commit -m "feat(feed): writeArtifact/readArtifacts with offline fallback"
```

---

## Task 7：前端 — Director 收割会议纪要

**Files:**
- Modify: `js/director.js`
- Test: `test-minutes.mjs`（追加 Director 集成测试）

- [ ] **Step 1: 写失败的集成测试**（追加到 `test-minutes.mjs` 末尾的 `console.log("minutes helpers OK")` 之前。用桩 llm/feed/world 直接驱动 `finishMeetings`，无需 Three.js/office）

```js
// --- Director 收割纪要：行动项进负责人记忆 + 产出物落库 ---
import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name, zone) {
  return {
    persona: { id: name, name, role: "工程师", zone, lines: { meeting: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("mt-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [], metricsSummary: () => "指标平稳", companyBrief: () => "测试公司" };
const stubLLM = {
  available: true,
  async minutes() {
    return {
      decisions: ["上线限速优化"],
      risks: ["带宽成本上升"],
      actionItems: [
        { owner: "王强", what: "评估带宽方案" },
        { owner: "查无此人", what: "本条应被忽略" }
      ]
    };
  }
};
const written = [];
const stubFeed = { writeArtifact: (d) => { written.push(d); return Promise.resolve({ id: "art_x" }); }, activePolicies: () => [] };

const dAgents = [memAgent("王强", "rd"), memAgent("李雷", "rd")];
const dir = new Director(dAgents, {}, () => {}, stubLLM, stubWorld, stubFeed, null);
dir.meetState.rd.transcript = ["王强：要不要上限速优化？", "李雷：可以，但留意带宽成本"];
await dir.finishMeetings({ type: "standup", label: "每日站会" });

const wangActions = dAgents[0].memory.items.filter(m => m.type === "action");
if (wangActions.length !== 1) throw new Error("王强应有 1 条行动项记忆，实际 " + wangActions.length);
if (!wangActions[0].c.includes("评估带宽方案")) throw new Error("行动项内容不对：" + wangActions[0].c);

const leiActions = dAgents[1].memory.items.filter(m => m.type === "action");
if (leiActions.length !== 0) throw new Error("李雷无对应行动项，不应有 action 记忆");

if (written.length !== 1 || written[0].type !== "minutes") throw new Error("应写 1 条 minutes 产出物");
if (written[0].day !== 1) throw new Error("产出物 day 应为 1");
if (!written[0].content.includes("上线限速优化")) throw new Error("产出物正文应含决议");
if (!written[0].meta || written[0].meta.zone !== "rd") throw new Error("产出物 meta 应含 zone=rd");

// 发言记录太短（<2 句）→ 不收割
const dir2 = new Director([memAgent("赵六", "rd")], {}, () => {}, stubLLM, stubWorld, stubFeed, null);
dir2.meetState.rd.transcript = ["赵六：没什么补充"];
const before = written.length;
await dir2.finishMeetings({ type: "standup", label: "每日站会" });
if (written.length !== before) throw new Error("发言记录过短不应生成纪要");

console.log("director minutes integration OK");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test-minutes.mjs`
Expected: FAIL — `dir.finishMeetings is not a function`

- [ ] **Step 3: 引入纯函数并新增收割方法**

在 `js/director.js` 第 17 行 `import { buildItems, composeAgentSummary } from "./board.js";` 之后追加：

```js
import { minutesEmpty, minutesToText } from "./cognition/minutes.js";
```

在 `runReflections()` 方法（结束于约第 604 行 `}`）之后、类闭合 `}`（约第 605 行）之前，插入两个方法：

```js
  // ---------- 会议纪要：离开会议相位时收割本场发言 ----------

  /** 两个区分别根据本场发言记录生成结构化纪要。返回 Promise（便于测试 await）。 */
  finishMeetings(phase) {
    const jobs = [];
    for (const zone of ZONES) {
      const transcript = this.meetState[zone]?.transcript ?? [];
      if (transcript.length < 2) continue;   // 实质讨论太少，不值得成文
      jobs.push(this.runMeetingMinutes(zone, phase, transcript.slice()));
    }
    return Promise.all(jobs);
  }

  /** 调模型生成一区纪要 → 写产出物库 + 行动项进负责人记忆 + 日志。 */
  runMeetingMinutes(zone, phase, transcript) {
    if (!this.llm?.available) return Promise.resolve();
    const day = this.day;
    const scene = this.meetingScene(phase, zone);
    return this.llm.minutes({ company: this.world?.companyBrief(), day, scene, transcript })
      .then(m => {
        if (minutesEmpty(m)) return;
        this.feed?.writeArtifact?.({
          type: "minutes", day, content: minutesToText(m),
          meta: { zone, phase: phase.label, decisions: m.decisions, risks: m.risks, actionItems: m.actionItems }
        });
        const crew = this.crewInZone(zone);
        for (const item of m.actionItems) {
          const owner = item.owner ? this.findAgent(item.owner) : null;
          if (owner && crew.includes(owner)) {
            this.remember(owner, `行动项（${phase.label}）：${item.what}`, 7, "action");
          }
        }
        this.log(`📋 ${phase.label}纪要：${m.decisions.length} 决议 / ${m.risks.length} 风险 / ${m.actionItems.length} 行动项`, "log-meeting");
      })
      .catch(() => {});
  }
```

- [ ] **Step 4: 在相位切换时触发收割**

在 `js/director.js` 的 `update(dt)` 方法里，找到检查日程切换的块（约第 295-297 行）：

```js
    if (!this.currentPhase || this.currentPhase.label !== active.label) {
      this.applyPhase(active);
    }
```

替换为（离开会议相位时先收割，再切相位）：

```js
    if (!this.currentPhase || this.currentPhase.label !== active.label) {
      if (this.currentPhase && (this.currentPhase.type === "standup" || this.currentPhase.type === "review")) {
        this.finishMeetings(this.currentPhase);
      }
      this.applyPhase(active);
    }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node test-minutes.mjs`
Expected: PASS — 输出 `director minutes integration OK` 及 `minutes helpers OK`

- [ ] **Step 6: 跑前端既有回归，确认无破坏**

Run: `node test-sim.mjs && node test-world.mjs && node test-board.mjs`
Expected: 全部输出各自的 `... DONE` / 断言通过，无抛错（`finishMeetings` 在无 llm 的 StubAgent 路径下因 `this.llm?.available` 为假而 no-op）

- [ ] **Step 7: 提交**

```bash
git add js/director.js test-minutes.mjs
git commit -m "feat(director): harvest structured minutes at meeting end"
```

---

## 验收 / 收尾

- [ ] **全量测试**

```bash
cd sidecar && node --test
cd .. && node test-minutes.mjs && node test-sim.mjs && node test-world.mjs && node test-board.mjs && node test-feed.mjs && node test-agent.mjs
```
Expected: 全绿。

- [ ] **降级冒烟（人工说明，沙箱可能跑不动 WebGL/真实 LLM——如实标注为环境限制）**
  - LLM 不可用：`finishMeetings` → `runMeetingMinutes` 因 `this.llm?.available` 为假直接返回，无纪要、无报错。
  - sidecar 离线：`feed.writeArtifact` 返回 null，行动项仍写入负责人记忆（记忆与 sidecar 无关）。

- [ ] **最终审查后合并**：在 feature 分支跑完 final review（spec 覆盖 + 质量），再本地合 main + push。

---

## Self-Review（对照 spec 检查）

**Spec 覆盖：**
- 「会议结束 1 次调用生成结构化纪要（决议/风险/行动项）」→ Task 5 `llm.minutes()` + Task 7 `runMeetingMinutes` ✅
- 「→ POST 产出物库」→ Task 1-3 artifacts 端点 + Task 6 `feed.writeArtifact` + Task 7 调用 ✅
- 「行动项写入负责人记忆，成为次日计划输入」→ Task 7 `remember(owner, ..., 7, "action")` ✅（次日计划消费留待 P3c plan.js）
- 「POST /api/artifacts、GET /api/artifacts?type=&day=」→ Task 3 ✅
- artifact 契约（B 接口三契约之一）→ Task 1 `normalizeArtifact` ✅

**本阶段明确不做（留待后续 P3 子阶段，避免范围蔓延）：**
- converse.js 多轮 `{utterance, done}` 自决终止循环、会议「允许跳过」→ P3d（润色，涉及帧循环改造，风险隔离）
- 行动项 `待办→开发中→已上线` 状态机 + 市场反应模拟器 → P3b（消费本阶段产出的行动项）
- 产出物翻阅 UI → P4（admin 产出物区块）

**Placeholder 扫描：** 无 TBD/TODO；每步含完整代码与确切命令。
**类型一致性：** `normalizeMinutes` 返回 `{decisions, risks, actionItems:[{owner,what}]}` 在 minutes.js / llm.minutes / director.runMeetingMinutes / 测试中一致；artifact 形状 `{id,ts,type,day,content,meta}` 在 contracts / store / 路由 / feed / 测试中一致。
