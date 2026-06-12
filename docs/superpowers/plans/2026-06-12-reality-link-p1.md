# 现实连接 P1（sidecar 骨架 + RSS 市场监控 + 政策注入）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 真实市场新闻（RSS）经 LLM 筛选后实时进入 3D 办公室成为 Agent 的记忆与讨论素材；用户发布的上层决策持久约束所有 Agent 的发言；sidecar 离线时一切回退现有纯虚构模式。

**Architecture:** 新增 `sidecar/`（Node ≥22.9，Express + rss-parser + 内置 node:sqlite，绑定 127.0.0.1:7878，静态托管现有前端）。浏览器侧新增 `js/feed.js` 同源访问 sidecar（探测/快照/SSE/政策轮询），Director 新增突发新闻注入与政策公告，World 的每日事件优先用真实事件、无则虚构补位。设计文档：`docs/superpowers/specs/2026-06-12-reality-link-design.md`。

**Tech Stack:** Node 22（node:sqlite、内置 fetch、node --test）、Express、rss-parser、原生 ES Modules 前端（无构建）。

**约定:**
- sidecar 测试：`cd sidecar && node --test`（`test/*.test.mjs`）
- 前端逻辑测试：仓库根 `node test-feed.mjs` / `node test-world.mjs`（沿用现有脚本风格）
- 当前分支 `design/reality-link`，每个任务一个 commit
- node:sqlite 会打印 ExperimentalWarning，无害，忽略即可

---

### Task 1: sidecar 脚手架与配置文件

**Files:**
- Create: `sidecar/package.json`
- Create: `sidecar/.env.example`
- Create: `sidecar/config.example.json`
- Create: `.gitignore`

- [ ] **Step 1: 创建 `sidecar/package.json`**

```json
{
  "name": "huaxiang-sidecar",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.9" },
  "scripts": {
    "start": "node --env-file-if-exists=.env src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.19.2",
    "rss-parser": "^3.13.0"
  }
}
```

- [ ] **Step 2: 创建 `sidecar/.env.example`**

```bash
# sidecar 自用的模型配置（与浏览器 localStorage 里那份互不依赖）
# 用于 RSS 条目的相关性打分与摘要。复制为 .env 并填写。
SIDECAR_PROVIDER=anthropic          # anthropic | openai（OpenAI 兼容接口）
SIDECAR_API_KEY=
SIDECAR_MODEL=claude-haiku-4-5      # 筛选摘要用便宜模型即可
SIDECAR_BASE_URL=                   # 仅 openai 兼容接口需要，如 https://api.deepseek.com/v1
```

- [ ] **Step 3: 创建 `sidecar/config.example.json`**

```json
{
  "port": 7878,
  "company": "123云盘，个人网盘/云存储创业公司，主打大容量与上传下载不限速，正经历免费额度收紧与会员涨价的阵痛期，竞品是百度网盘、夸克、阿里云盘",
  "feeds": [
    "https://www.ithome.com/rss/",
    "https://36kr.com/feed"
  ],
  "relevanceThreshold": 6,
  "rssIntervalMinutes": 30
}
```

- [ ] **Step 4: 创建仓库根 `.gitignore`**（仓库目前没有这个文件）

```gitignore
node_modules/
sidecar/.env
sidecar/config.json
sidecar/data/
```

- [ ] **Step 5: 安装依赖并验证**

Run: `cd /Users/silas/huaxiang/sidecar && npm install`
Expected: 生成 `package-lock.json` 与 `node_modules/`，无错误

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/package.json sidecar/package-lock.json sidecar/.env.example sidecar/config.example.json .gitignore
git commit -m "feat(sidecar): scaffold sidecar package with config templates"
```

---

### Task 2: 数据库层（node:sqlite + 三张表）

**Files:**
- Create: `sidecar/src/db.js`
- Test: `sidecar/test/db.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/db.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";

test("openDb 建出 events / seen_urls / policies 三张表", () => {
  const db = openDb(":memory:");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(r => r.name);
  assert.ok(tables.includes("events"));
  assert.ok(tables.includes("seen_urls"));
  assert.ok(tables.includes("policies"));
});

test("openDb 幂等：对同一库重复执行 schema 不报错", () => {
  const db = openDb(":memory:");
  assert.doesNotThrow(() => openDbAgain(db));
});

function openDbAgain(db) {
  // 模拟二次启动：直接重放 schema
  db.exec(`CREATE TABLE IF NOT EXISTS events(
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'market', title TEXT NOT NULL, summary TEXT NOT NULL,
    url TEXT, relevance INTEGER NOT NULL DEFAULT 5,
    suggested_impact TEXT, consumed INTEGER NOT NULL DEFAULT 0
  )`);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/db.test.mjs`
Expected: FAIL（`Cannot find module '../src/db.js'`）

- [ ] **Step 3: 实现 `sidecar/src/db.js`**

```js
// SQLite 打开与建表。用 Node 内置 node:sqlite（≥22.5），零原生依赖。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'market',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url TEXT,
  relevance INTEGER NOT NULL DEFAULT 5,
  suggested_impact TEXT,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seen_urls(
  hash TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS policies(
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  issued_ts INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
`;

export function openDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/db.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/db.js sidecar/test/db.test.mjs
git commit -m "feat(sidecar): sqlite schema for events, seen_urls, policies"
```

---

### Task 3: 事件契约（校验与归一化）

**Files:**
- Create: `sidecar/src/contracts.js`
- Test: `sidecar/test/contracts.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/contracts.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, urlHash } from "../src/contracts.js";

test("normalizeEvent 补全默认值并生成 id", () => {
  const ev = normalizeEvent({ source: "rss", title: "夸克网盘上线校园活动" });
  assert.match(ev.id, /^evt_/);
  assert.equal(ev.kind, "market");
  assert.equal(ev.summary, "夸克网盘上线校园活动"); // 缺 summary 用 title 顶
  assert.equal(ev.relevance, 5);
  assert.equal(ev.consumed, false);
  assert.ok(ev.ts > 0);
});

test("normalizeEvent 拒绝空标题和非法 source", () => {
  assert.throws(() => normalizeEvent({ source: "rss", title: "" }));
  assert.throws(() => normalizeEvent({ source: "weibo", title: "x" }));
  assert.throws(() => normalizeEvent(null));
});

test("normalizeEvent 把 relevance 钳制在 0~10", () => {
  assert.equal(normalizeEvent({ source: "manual", title: "x", relevance: 99 }).relevance, 10);
  assert.equal(normalizeEvent({ source: "manual", title: "x", relevance: -3 }).relevance, 0);
});

test("urlHash 稳定且区分大小写敏感的不同 URL", () => {
  assert.equal(urlHash("https://a.com/1"), urlHash("https://a.com/1"));
  assert.notEqual(urlHash("https://a.com/1"), urlHash("https://a.com/2"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/contracts.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/contracts.js`**

```js
// 事件契约：B 接口三契约之一。所有进入事件总线的数据必须经过这里归一化。
import { createHash, randomUUID } from "node:crypto";

const SOURCES = new Set(["rss", "search", "watch", "manual", "policy"]);

export function urlHash(url) {
  return createHash("sha256").update(String(url)).digest("hex");
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") throw new Error("event must be an object");
  const title = String(raw.title || "").trim();
  if (!title) throw new Error("event.title required");
  if (!SOURCES.has(raw.source)) throw new Error(`bad event.source: ${raw.source}`);
  return {
    id: raw.id || `evt_${randomUUID().slice(0, 8)}`,
    ts: Number(raw.ts) || Date.now(),
    source: raw.source,
    kind: raw.kind || "market",
    title: title.slice(0, 200),
    summary: String(raw.summary || title).trim().slice(0, 200),
    url: raw.url ? String(raw.url) : null,
    relevance: Math.max(0, Math.min(10, Number(raw.relevance ?? 5) || 0)),
    suggestedImpact: raw.suggestedImpact ?? null,
    consumed: false
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/contracts.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/contracts.js sidecar/test/contracts.test.mjs
git commit -m "feat(sidecar): event contract validation and url hashing"
```

---

### Task 4: 事件仓库（入库、去重、消费、订阅）

**Files:**
- Create: `sidecar/src/eventStore.js`
- Test: `sidecar/test/eventStore.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/eventStore.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";

function freshStore() {
  return new EventStore(openDb(":memory:"));
}

test("add 入库后 listUnconsumed 能取到，ack 后取不到", () => {
  const s = freshStore();
  const ev = s.add({ source: "rss", title: "百度网盘限速上热搜", relevance: 8 });
  assert.equal(s.listUnconsumed().length, 1);
  assert.equal(s.listUnconsumed()[0].id, ev.id);
  assert.equal(s.ack([ev.id]), 1);
  assert.equal(s.listUnconsumed().length, 0);
  assert.equal(s.ack(["evt_nonexist"]), 0);
});

test("suggestedImpact 经 JSON 往返保持结构", () => {
  const s = freshStore();
  s.add({ source: "rss", title: "x", suggestedImpact: { sat: -2, dau: "+1%" } });
  assert.deepEqual(s.listUnconsumed()[0].suggestedImpact, { sat: -2, dau: "+1%" });
});

test("markSeen + filterUnseen 实现 URL 去重", () => {
  const s = freshStore();
  const urls = ["https://a.com/1", "https://a.com/2"];
  assert.deepEqual(s.filterUnseen(urls), urls);
  s.markSeen(["https://a.com/1"]);
  assert.deepEqual(s.filterUnseen(urls), ["https://a.com/2"]);
  s.markSeen(["https://a.com/1"]); // 重复标记不报错
});

test("subscribe 在 add 时收到归一化后的事件，退订后不再收到", () => {
  const s = freshStore();
  const got = [];
  const unsub = s.subscribe(ev => got.push(ev));
  s.add({ source: "manual", title: "测试事件" });
  assert.equal(got.length, 1);
  assert.match(got[0].id, /^evt_/);
  unsub();
  s.add({ source: "manual", title: "再来一条" });
  assert.equal(got.length, 1);
});

test("todayCount 只统计近 24 小时", () => {
  const s = freshStore();
  s.add({ source: "manual", title: "新的" });
  s.add({ source: "manual", title: "旧的", ts: Date.now() - 2 * 86400000 });
  assert.equal(s.todayCount(), 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/eventStore.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/eventStore.js`**

```js
// 事件总线的存储层：入库（含订阅推送）、URL 去重、未消费查询、消费确认。
import { normalizeEvent, urlHash } from "./contracts.js";

export class EventStore {
  constructor(db) {
    this.db = db;
    this.subs = new Set();
  }

  add(raw) {
    const ev = normalizeEvent(raw);
    this.db.prepare(
      `INSERT INTO events(id, ts, source, kind, title, summary, url, relevance, suggested_impact, consumed)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      ev.id, ev.ts, ev.source, ev.kind, ev.title, ev.summary, ev.url, ev.relevance,
      ev.suggestedImpact ? JSON.stringify(ev.suggestedImpact) : null
    );
    for (const fn of this.subs) fn(ev);
    return ev;
  }

  listUnconsumed() {
    return this.db
      .prepare("SELECT * FROM events WHERE consumed = 0 ORDER BY ts")
      .all()
      .map(rowToEvent);
  }

  ack(ids) {
    const stmt = this.db.prepare("UPDATE events SET consumed = 1 WHERE id = ?");
    let n = 0;
    for (const id of ids) n += stmt.run(String(id)).changes;
    return n;
  }

  filterUnseen(urls) {
    const stmt = this.db.prepare("SELECT 1 AS x FROM seen_urls WHERE hash = ?");
    return urls.filter(u => !stmt.get(urlHash(u)));
  }

  markSeen(urls) {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO seen_urls(hash, ts) VALUES(?, ?)");
    for (const u of urls) stmt.run(urlHash(u), Date.now());
  }

  todayCount() {
    return this.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE ts >= ?")
      .get(Date.now() - 86400000).c;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

function rowToEvent(r) {
  return {
    id: r.id, ts: r.ts, source: r.source, kind: r.kind,
    title: r.title, summary: r.summary, url: r.url, relevance: r.relevance,
    suggestedImpact: r.suggested_impact ? JSON.parse(r.suggested_impact) : null,
    consumed: !!r.consumed
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/eventStore.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/eventStore.js sidecar/test/eventStore.test.mjs
git commit -m "feat(sidecar): event store with dedupe, ack and subscriptions"
```

---

### Task 5: 政策仓库

**Files:**
- Create: `sidecar/src/policyStore.js`
- Test: `sidecar/test/policyStore.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/policyStore.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { PolicyStore } from "../src/policyStore.js";

test("create / list / deactivate 完整生命周期", () => {
  const s = new PolicyStore(openDb(":memory:"));
  const p = s.create("本季度冻结新功能，全员优先降本");
  assert.match(p.id, /^pol_/);
  assert.equal(p.active, true);

  assert.equal(s.list().length, 1);            // 默认只列 active
  assert.equal(s.deactivate(p.id), true);
  assert.equal(s.list().length, 0);
  assert.equal(s.list(true).length, 1);        // all=true 含已撤销
  assert.equal(s.list(true)[0].active, false);
  assert.equal(s.deactivate(p.id), false);     // 重复撤销返回 false
});

test("空文本拒绝创建", () => {
  const s = new PolicyStore(openDb(":memory:"));
  assert.throws(() => s.create("   "));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/policyStore.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/policyStore.js`**

```js
// 上层决策（政策）存储：发布、列表、撤销（软删除）。
import { randomUUID } from "node:crypto";

export class PolicyStore {
  constructor(db) {
    this.db = db;
  }

  create(text) {
    const t = String(text || "").trim();
    if (!t) throw new Error("policy text required");
    const p = { id: `pol_${randomUUID().slice(0, 8)}`, text: t.slice(0, 300), issuedTs: Date.now(), active: true };
    this.db.prepare("INSERT INTO policies(id, text, issued_ts, active) VALUES(?, ?, ?, 1)")
      .run(p.id, p.text, p.issuedTs);
    return p;
  }

  list(all = false) {
    const sql = all
      ? "SELECT * FROM policies ORDER BY issued_ts"
      : "SELECT * FROM policies WHERE active = 1 ORDER BY issued_ts";
    return this.db.prepare(sql).all().map(r => ({
      id: r.id, text: r.text, issuedTs: r.issued_ts, active: !!r.active
    }));
  }

  deactivate(id) {
    return this.db.prepare("UPDATE policies SET active = 0 WHERE id = ? AND active = 1")
      .run(String(id)).changes > 0;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/policyStore.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/policyStore.js sidecar/test/policyStore.test.mjs
git commit -m "feat(sidecar): policy store with soft-delete revocation"
```

---

### Task 6: sidecar LLM 客户端（批量相关性打分 + 摘要）

**Files:**
- Create: `sidecar/src/llm.js`
- Test: `sidecar/test/llm.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/llm.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SidecarLLM } from "../src/llm.js";

function anthropicResponse(text) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" })
  };
}

test("未配置 key 时 enabled=false，scoreBatch 返回 null", async () => {
  const llm = new SidecarLLM({}, async () => { throw new Error("不该发起请求"); });
  assert.equal(llm.enabled, false);
  assert.equal(await llm.scoreBatch([{ title: "x" }], "公司"), null);
});

test("scoreBatch 解析 JSON 数组并按 i 对位，容忍 markdown 代码栏", async () => {
  const reply = '```json\n[{"i":0,"relevance":8,"summary":"竞品涨价","suggestedImpact":{"dau":"+2%"}},{"i":1,"relevance":2,"summary":"无关"}]\n```';
  const llm = new SidecarLLM(
    { SIDECAR_API_KEY: "k", SIDECAR_MODEL: "m" },
    async () => anthropicResponse(reply)
  );
  const out = await llm.scoreBatch(
    [{ title: "竞品宣布涨价", snippet: "" }, { title: "某地天气", snippet: "" }],
    "123云盘"
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].relevance, 8);
  assert.equal(out[0].summary, "竞品涨价");
  assert.deepEqual(out[0].suggestedImpact, { dau: "+2%" });
  assert.equal(out[1].relevance, 2);
});

test("模型返回非法 JSON 时 scoreBatch 返回 null 而不是抛错", async () => {
  const llm = new SidecarLLM(
    { SIDECAR_API_KEY: "k", SIDECAR_MODEL: "m" },
    async () => anthropicResponse("抱歉我无法……")
  );
  assert.equal(await llm.scoreBatch([{ title: "x" }], "公司"), null);
});

test("openai 兼容模式走 chat/completions 接口", async () => {
  let calledUrl = "";
  const llm = new SidecarLLM(
    { SIDECAR_PROVIDER: "openai", SIDECAR_API_KEY: "k", SIDECAR_MODEL: "deepseek-chat", SIDECAR_BASE_URL: "https://api.deepseek.com/v1" },
    async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"i":0,"relevance":7,"summary":"s"}]' } }] }) };
    }
  );
  const out = await llm.scoreBatch([{ title: "x" }], "公司");
  assert.equal(calledUrl, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(out[0].relevance, 7);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/llm.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/llm.js`**

```js
// sidecar 自用 LLM 客户端：只做一件事——给资讯条目批量打相关性分 + 写摘要。
// 接口形状与前端 js/llm.js 保持一致（anthropic / openai 兼容），但 key 来自环境变量。

export class SidecarLLM {
  constructor(env = process.env, fetchFn = fetch) {
    this.provider = env.SIDECAR_PROVIDER || "anthropic";
    this.apiKey = env.SIDECAR_API_KEY || "";
    this.model = env.SIDECAR_MODEL || "";
    this.baseUrl = (env.SIDECAR_BASE_URL || "").replace(/\/+$/, "");
    this.fetch = fetchFn;
  }

  get enabled() {
    return !!(this.apiKey && this.model);
  }

  async chatRaw(system, user, maxTokens = 1500) {
    if (this.provider === "openai") {
      const base = this.baseUrl || "https://api.openai.com/v1";
      const res = await this.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: user }]
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    const res = await this.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.content || []).find(b => b.type === "text")?.text ?? "";
  }

  /**
   * 批量打分：items = [{title, snippet}]，返回与 items 等长的数组
   * （每项 {relevance, summary, suggestedImpact} 或 null），整体失败返回 null。
   */
  async scoreBatch(items, companyBrief) {
    if (!this.enabled || items.length === 0) return null;
    const system =
      `你是市场情报分析员。公司背景：${companyBrief}\n` +
      `对下面每条资讯：判断它与这家公司经营的相关程度 relevance（0~10 整数，无关给 0~3，` +
      `行业相关给 4~6，直接影响公司给 7~10）；写一条不超过 120 字的中文摘要 summary` +
      `（说清发生了什么、和公司的关系）；可选给出 suggestedImpact（对 dau/sat/bugs/runway 的方向性影响）。\n` +
      `只输出 JSON 数组，不要任何其他文字。格式示例：` +
      `[{"i":0,"relevance":8,"summary":"……","suggestedImpact":{"sat":-1}}]`;
    const user = items
      .map((it, i) => `${i}. ${it.title}\n${String(it.snippet || "").slice(0, 200)}`)
      .join("\n\n");
    try {
      const text = await this.chatRaw(system, user);
      const clean = text.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
      const arr = JSON.parse(clean);
      if (!Array.isArray(arr)) return null;
      const out = new Array(items.length).fill(null);
      for (const r of arr) {
        if (Number.isInteger(r.i) && r.i >= 0 && r.i < items.length) {
          out[r.i] = {
            relevance: Math.max(0, Math.min(10, Number(r.relevance) || 0)),
            summary: String(r.summary || items[r.i].title).slice(0, 160),
            suggestedImpact: r.suggestedImpact ?? null
          };
        }
      }
      return out;
    } catch (e) {
      console.warn("scoreBatch 失败：", e.message);
      return null;
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/llm.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/llm.js sidecar/test/llm.test.mjs
git commit -m "feat(sidecar): llm client for batch relevance scoring"
```

---

### Task 7: RSS 采集器

**Files:**
- Create: `sidecar/src/collectors/rss.js`
- Test: `sidecar/test/rss.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/rss.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { runRssOnce } from "../src/collectors/rss.js";

const FIXTURE_ITEMS = [
  { title: "百度网盘非会员限速又上热搜", link: "https://news.test/1", contentSnippet: "网友吐槽下载速度" },
  { title: "某市今日多云转晴", link: "https://news.test/2", contentSnippet: "气温 25 度" }
];

function stubParser(itemsByUrl) {
  return { parseURL: async url => {
    if (itemsByUrl[url] instanceof Error) throw itemsByUrl[url];
    return { items: itemsByUrl[url] || [] };
  } };
}

function stubLLM(scores) {
  return { enabled: true, scoreBatch: async items => items.map((it, i) => scores[i] ?? null) };
}

test("打分过阈值的入库，低于阈值的丢弃，URL 标记为已见", async () => {
  const store = new EventStore(openDb(":memory:"));
  const r = await runRssOnce({
    feeds: ["https://feed.test/rss"],
    parser: stubParser({ "https://feed.test/rss": FIXTURE_ITEMS }),
    llm: stubLLM([
      { relevance: 9, summary: "限速话题发酵，利好不限速产品", suggestedImpact: { dau: "+2%" } },
      { relevance: 1, summary: "天气新闻，无关" }
    ]),
    store, companyBrief: "123云盘", threshold: 6, log: () => {}
  });
  assert.equal(r.fetched, 2);
  assert.equal(r.inserted, 1);
  const evs = store.listUnconsumed();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].source, "rss");
  assert.equal(evs[0].summary, "限速话题发酵，利好不限速产品");
  assert.equal(evs[0].url, "https://news.test/1");
});

test("第二轮同样的条目全部去重，不再调用 LLM", async () => {
  const store = new EventStore(openDb(":memory:"));
  let llmCalls = 0;
  const llm = { enabled: true, scoreBatch: async items => { llmCalls++; return items.map(() => ({ relevance: 9, summary: "s" })); } };
  const deps = {
    feeds: ["https://feed.test/rss"],
    parser: stubParser({ "https://feed.test/rss": FIXTURE_ITEMS }),
    llm, store, companyBrief: "c", threshold: 6, log: () => {}
  };
  await runRssOnce(deps);
  const r2 = await runRssOnce(deps);
  assert.equal(llmCalls, 1);
  assert.equal(r2.inserted, 0);
});

test("单个源拉取失败不影响其他源", async () => {
  const store = new EventStore(openDb(":memory:"));
  const r = await runRssOnce({
    feeds: ["https://bad.test/rss", "https://good.test/rss"],
    parser: stubParser({
      "https://bad.test/rss": new Error("ECONNREFUSED"),
      "https://good.test/rss": [FIXTURE_ITEMS[0]]
    }),
    llm: stubLLM([{ relevance: 8, summary: "s" }]),
    store, companyBrief: "c", threshold: 6, log: () => {}
  });
  assert.equal(r.inserted, 1);
});

test("LLM 整体失败（返回 null）时本轮放弃但不抛错", async () => {
  const store = new EventStore(openDb(":memory:"));
  const r = await runRssOnce({
    feeds: ["https://feed.test/rss"],
    parser: stubParser({ "https://feed.test/rss": FIXTURE_ITEMS }),
    llm: { enabled: true, scoreBatch: async () => null },
    store, companyBrief: "c", threshold: 6, log: () => {}
  });
  assert.equal(r.inserted, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/rss.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/collectors/rss.js`**

```js
// RSS 采集器：拉源 → URL 去重 → LLM 批量打分摘要 → 过阈值入库。
// 所有依赖注入（parser/llm/store），便于离线测试。

export async function runRssOnce({ feeds, parser, llm, store, companyBrief, threshold = 6, log = console.log }) {
  let fetched = 0;
  let inserted = 0;
  for (const feedUrl of feeds) {
    let parsed;
    try {
      parsed = await parser.parseURL(feedUrl);
    } catch (e) {
      log(`RSS 拉取失败 ${feedUrl}: ${e.message}`);
      continue;
    }
    const items = (parsed.items || []).filter(it => it.link && it.title).slice(0, 30);
    fetched += items.length;

    const freshLinks = store.filterUnseen(items.map(it => it.link));
    const fresh = items.filter(it => freshLinks.includes(it.link)).slice(0, 10);
    if (fresh.length === 0) continue;
    store.markSeen(fresh.map(it => it.link));

    const scored = await llm.scoreBatch(
      fresh.map(it => ({ title: it.title, snippet: it.contentSnippet || "" })),
      companyBrief
    );
    if (!scored) continue; // 无 key 或解析失败：本轮放弃（URL 已 seen，不会反复积压）

    fresh.forEach((it, i) => {
      const s = scored[i];
      if (s && s.relevance >= threshold) {
        store.add({
          source: "rss",
          title: it.title,
          summary: s.summary,
          url: it.link,
          relevance: s.relevance,
          suggestedImpact: s.suggestedImpact
        });
        inserted++;
      }
    });
  }
  return { fetched, inserted };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/rss.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/collectors/rss.js sidecar/test/rss.test.mjs
git commit -m "feat(sidecar): rss collector with dedupe and llm filtering"
```

---

### Task 8: HTTP 服务（snapshot / ack / SSE / policies / health / 静态托管）

**Files:**
- Create: `sidecar/src/server.js`
- Test: `sidecar/test/server.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/server.test.mjs`**

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { PolicyStore } from "../src/policyStore.js";
import { buildApp } from "../src/server.js";

function startTestServer() {
  const db = openDb(":memory:");
  const eventStore = new EventStore(db);
  const policyStore = new PolicyStore(db);
  const status = { collectors: { rss: { enabled: false, lastRun: null, lastResult: null, reason: "test" } } };
  const app = buildApp({ eventStore, policyStore, status });
  const server = app.listen(0, "127.0.0.1");
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { server, base, eventStore, policyStore };
}

test("API 集成：health / snapshot / ack / policies", async () => {
  const { server, base, eventStore } = startTestServer();
  after(() => server.close());

  const health = await (await fetch(`${base()}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.collectors.rss.enabled, false);

  eventStore.add({ source: "rss", title: "事件A", relevance: 7 });

  let snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.events.length, 1);
  assert.deepEqual(snap.policies, []);

  // 政策 CRUD
  const created = await (await fetch(`${base()}/api/policies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "全员降本" })
  })).json();
  assert.match(created.id, /^pol_/);

  const bad = await fetch(`${base()}/api/policies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" })
  });
  assert.equal(bad.status, 400);

  snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.policies.length, 1);

  const del = await (await fetch(`${base()}/api/policies/${created.id}`, { method: "DELETE" })).json();
  assert.equal(del.ok, true);
  snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.policies.length, 0);

  // ack
  const evId = snap.events[0].id;
  const acked = await (await fetch(`${base()}/api/events/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [evId] })
  })).json();
  assert.equal(acked.acked, 1);
  snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.events.length, 0);
});

test("SSE 流推送新事件", async () => {
  const { server, base, eventStore } = startTestServer();
  after(() => server.close());

  const res = await fetch(`${base()}/api/stream`);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  await reader.read(); // 吃掉 :connected 注释行

  eventStore.add({ source: "manual", title: "突发事件" });
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /^data: /m);
  assert.ok(JSON.parse(chunk.replace(/^data: /, "").trim()).title === "突发事件");
  await reader.cancel();
});

test("静态托管仓库根目录（index.html 可访问）", async () => {
  const { server, base } = startTestServer();
  after(() => server.close());
  const res = await fetch(`${base()}/index.html`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /画像办公室|<canvas|scene/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/server.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/server.js`**

```js
// sidecar HTTP 服务：API + SSE + 静态托管前端。
// buildApp 纯组装（可测试）；直接运行本文件时连真实依赖并启动采集循环。
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Parser from "rss-parser";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { PolicyStore } from "./policyStore.js";
import { SidecarLLM } from "./llm.js";
import { runRssOnce } from "./collectors/rss.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = join(__dirname, "..");
const FRONTEND_ROOT = join(SIDECAR_ROOT, "..");

export function loadConfig() {
  const defaults = { port: 7878, company: "", feeds: [], relevanceThreshold: 6, rssIntervalMinutes: 30 };
  const path = join(SIDECAR_ROOT, "config.json");
  if (!existsSync(path)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    console.warn("config.json 解析失败，使用默认配置：", e.message);
    return defaults;
  }
}

export function buildApp({ eventStore, policyStore, status }) {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, today: eventStore.todayCount(), collectors: status.collectors });
  });

  app.get("/api/snapshot", (req, res) => {
    res.json({ events: eventStore.listUnconsumed(), policies: policyStore.list() });
  });

  app.post("/api/events/ack", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ acked: eventStore.ack(ids) });
  });

  app.get("/api/stream", (req, res) => {
    res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    res.write(":connected\n\n");
    const unsub = eventStore.subscribe(ev => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const hb = setInterval(() => res.write(":hb\n\n"), 25000);
    req.on("close", () => { unsub(); clearInterval(hb); });
  });

  app.get("/api/policies", (req, res) => res.json(policyStore.list(req.query.all === "1")));
  app.post("/api/policies", (req, res) => {
    try {
      res.json(policyStore.create(req.body?.text));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.delete("/api/policies/:id", (req, res) => res.json({ ok: policyStore.deactivate(req.params.id) }));

  app.use(express.static(FRONTEND_ROOT));
  return app;
}

// 直接运行：node --env-file-if-exists=.env src/server.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const db = openDb(join(SIDECAR_ROOT, "data", "huaxiang.db"));
  const eventStore = new EventStore(db);
  const policyStore = new PolicyStore(db);
  const llm = new SidecarLLM();
  const parser = new Parser({ timeout: 10000 });

  const rssReason = !llm.enabled
    ? "未配置 SIDECAR_API_KEY / SIDECAR_MODEL（见 .env.example）"
    : cfg.feeds.length === 0
      ? "config.json 未配置 feeds（见 config.example.json）"
      : null;
  const status = {
    collectors: { rss: { enabled: !rssReason, lastRun: null, lastResult: null, reason: rssReason } }
  };

  const app = buildApp({ eventStore, policyStore, status });
  app.listen(cfg.port, "127.0.0.1", () => {
    console.log(`sidecar 运行中：http://127.0.0.1:${cfg.port}（办公室页面也从这里打开）`);
    if (rssReason) console.log(`⚠️ RSS 采集器未启用：${rssReason}`);
  });

  async function rssTick() {
    if (!status.collectors.rss.enabled) return;
    status.collectors.rss.lastRun = Date.now();
    try {
      status.collectors.rss.lastResult = await runRssOnce({
        feeds: cfg.feeds, parser, llm, store: eventStore,
        companyBrief: cfg.company, threshold: cfg.relevanceThreshold
      });
      console.log(`RSS 采集完成：抓 ${status.collectors.rss.lastResult.fetched} 条，入库 ${status.collectors.rss.lastResult.inserted} 条`);
    } catch (e) {
      status.collectors.rss.lastResult = { error: e.message };
      console.warn("RSS 采集异常：", e.message);
    }
  }
  rssTick();
  setInterval(rssTick, cfg.rssIntervalMinutes * 60 * 1000);
}
```

- [ ] **Step 4: 运行确认通过（全部 sidecar 测试）**

Run: `cd /Users/silas/huaxiang/sidecar && node --test`
Expected: PASS（全部测试，约 18 个）

- [ ] **Step 5: 手动冒烟：启动并访问**

```bash
cd /Users/silas/huaxiang/sidecar && npm start &
sleep 1
curl -s http://127.0.0.1:7878/api/health
curl -s -X POST http://127.0.0.1:7878/api/policies -H 'content-type: application/json' -d '{"text":"测试政策"}'
curl -s http://127.0.0.1:7878/api/snapshot
kill %1
```
Expected: health 返回 `{"ok":true,...}`（rss enabled=false 带 reason 正常）；政策创建成功并出现在 snapshot 里

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/server.js sidecar/test/server.test.mjs
git commit -m "feat(sidecar): http server with snapshot, ack, sse, policies, static hosting"
```

---

### Task 9: 前端 Feed 客户端（js/feed.js）

**Files:**
- Create: `js/feed.js`
- Test: `test-feed.mjs`（仓库根，沿用现有脚本风格）

- [ ] **Step 1: 写失败测试 `test-feed.mjs`**

```js
// Feed 纯逻辑测试（Node 环境，不依赖浏览器）
import { diffPolicies } from "./js/feed.js";

// 新政策 → announced
let d = diffPolicies({}, [{ id: "pol_1", text: "降本", active: true }]);
if (d.announced.length !== 1 || d.announced[0].id !== "pol_1") throw new Error("新政策应进 announced");
if (d.revoked.length !== 0) throw new Error("不应有 revoked");

// 已见过且仍 active → 无动作
d = diffPolicies({ pol_1: true }, [{ id: "pol_1", text: "降本", active: true }]);
if (d.announced.length !== 0 || d.revoked.length !== 0) throw new Error("无变化时应静默");

// 之前 active 的政策消失/失效 → revoked
d = diffPolicies({ pol_1: true }, []);
if (d.revoked.length !== 1 || d.revoked[0] !== "pol_1") throw new Error("撤销检测失败");

// 之前就 inactive 的不再重复公告撤销
d = diffPolicies({ pol_1: false }, []);
if (d.revoked.length !== 0) throw new Error("已撤销的不应重复公告");

console.log("ALL FEED TESTS PASSED");
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-feed.mjs`
Expected: FAIL（`Cannot find module './js/feed.js'`）

- [ ] **Step 3: 实现 `js/feed.js`**

```js
// 与本地 sidecar 的连接：探测、快照、SSE 实时事件、政策同步。
// sidecar 不在线（如 GitHub Pages 或 http-server 直开）时所有方法安全降级，
// 模拟自动回到纯虚构模式——这是 P0 级约束：模拟永不因数据面缺席而停摆。

const SEEN_KEY = "huaxiang.policies.seen.v1";
const POLICY_POLL_MS = 30000;

/**
 * 纯函数：对比「上次见过的政策状态」和「当前政策列表」。
 * seen: { [id]: lastActive }；current: [{id, text, active}]
 * 返回 { announced: [policy], revoked: [id] }
 */
export function diffPolicies(seen, current) {
  const announced = current.filter(p => p.active && seen[p.id] === undefined);
  const revoked = Object.keys(seen).filter(
    id => seen[id] && !current.some(p => p.id === id && p.active)
  );
  return { announced, revoked };
}

function loadSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch { return {}; }
}

function saveSeen(seen) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
}

export class Feed {
  constructor() {
    this.online = false;
    this.pending = [];        // 已到达、未投递进模拟的真实事件
    this.policies = [];       // 现行政策 [{id, text, active}]
    this.onBreaking = null;   // (event) => void   模拟运行中实时到达
    this.onPolicyChange = null; // ({announced, revoked: [id]}) => void
    this.onStatus = null;     // (online: boolean) => void
  }

  /** 探测 sidecar；在线则拉快照、开 SSE、起政策轮询。返回是否在线。 */
  async connect() {
    try {
      const res = await fetch("/api/health", { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.online = true;
    } catch {
      this.online = false;
      this.onStatus?.(false);
      return false;
    }
    this.onStatus?.(true);

    try {
      const snap = await (await fetch("/api/snapshot")).json();
      this.pending.push(...(snap.events || []));
      this.syncPolicies(snap.policies || []);
    } catch (e) {
      console.warn("快照拉取失败：", e);
    }

    const es = new EventSource("/api/stream");
    es.onmessage = e => {
      try {
        const ev = JSON.parse(e.data);
        if (this.onBreaking) {
          this.onBreaking(ev);
          this.ack([ev.id]);
        } else {
          this.pending.push(ev);
        }
      } catch {}
    };
    es.onerror = () => { /* EventSource 自带重连 */ };

    setInterval(async () => {
      try {
        this.syncPolicies(await (await fetch("/api/policies")).json());
      } catch {}
    }, POLICY_POLL_MS);

    return true;
  }

  /** 政策对账：发现新政策/撤销则回调，并更新本地已见标记 */
  syncPolicies(current) {
    this.policies = current;
    const seen = loadSeen();
    const diff = diffPolicies(seen, current);
    if (diff.announced.length || diff.revoked.length) {
      this.onPolicyChange?.(diff);
    }
    const next = {};
    for (const p of current) next[p.id] = p.active;
    for (const id of diff.revoked) next[id] = false;
    saveSeen(next);
  }

  /** 取走最多 max 条待投递事件并向 sidecar 确认消费 */
  takeEvents(max = 3) {
    const taken = this.pending.splice(0, max);
    if (taken.length) this.ack(taken.map(e => e.id));
    return taken;
  }

  /** 现行政策文本列表（注入发言上下文用） */
  activePolicies() {
    return this.policies.filter(p => p.active).map(p => p.text);
  }

  ack(ids) {
    if (!this.online || !ids.length) return;
    fetch("/api/events/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids })
    }).catch(() => {});
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-feed.mjs`
Expected: `ALL FEED TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/feed.js test-feed.mjs
git commit -m "feat(frontend): feed client for sidecar events and policies"
```

---

### Task 10: World 接收真实事件（虚构补位）

**Files:**
- Modify: `js/world.js:119-149`（`generateEvents` 与 `nextDay`）
- Test: 追加到 `test-world.mjs`

- [ ] **Step 1: 在 `test-world.mjs` 末尾（`console.log("ALL WORLD TESTS PASSED")` 之前）追加失败测试**

```js
// ---- 真实事件优先、虚构补位 ----
const w3 = new World(DEFAULT_COMPANY);
const realEvents = [
  { id: "evt_r1", summary: "百度网盘限速上热搜，新注册暴涨", real: true },
  { id: "evt_r2", summary: "带宽结算新规落地", real: true }
];
w3.nextDay(realEvents);
if (w3.todayEvents.length !== 2) throw new Error("真实事件应全部成为当日事件");
if (!w3.todayEvents[0].real) throw new Error("真实事件应带 real 标记");
if (w3.todayEvents[0].text !== "百度网盘限速上热搜，新注册暴涨") throw new Error("事件文本应取 summary");
w3.nextDay([]);
if (w3.todayEvents.length < 1) throw new Error("无真实事件时应虚构补位");
if (w3.todayEvents.some(e => e.real)) throw new Error("虚构事件不应带 real 标记");
console.log("真实事件注入验证 ✓");
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（`真实事件应全部成为当日事件` —— 现有 `nextDay()` 不接收参数，事件全是虚构的且无 real 标记）

- [ ] **Step 3: 修改 `js/world.js`**

`generateEvents` 改为（原 `js/world.js:120-134`）：

```js
  /** 生成今日事件：优先用真实市场事件（最多 3 条），没有才虚构补位 */
  generateEvents(realEvents = []) {
    this.todayEvents = [];
    for (const ev of realEvents.slice(0, 3)) {
      // 真实事件不直接改指标（指标影响归市场反应模拟器，P3）
      this.todayEvents.push({ id: ev.id, text: ev.summary || ev.title, real: true });
    }
    if (this.todayEvents.length === 0) {
      const competitor = COMPETITORS[Math.floor(Math.random() * COMPETITORS.length)];
      const n = Math.random() < 0.45 ? 2 : 1;
      const used = new Set();
      for (let i = 0; i < n; i++) {
        const ev = pickWeighted(this.eventPool, used);
        used.add(ev.id);
        const text = ev.text(this.company, competitor);
        ev.effect(this.metrics);
        this.todayEvents.push({ id: ev.id, text });
      }
    }
    this.clampMetrics();
    this.save();
  }
```

`nextDay` 签名改为（原 `js/world.js:137`）：

```js
  /** 进入新的一天：指标自然演化 + 新事件（realEvents 来自 sidecar） */
  nextDay(realEvents = []) {
```

及其末行（原 `js/world.js:148`）：

```js
    this.generateEvents(realEvents);
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: `真实事件注入验证 ✓` 与 `ALL WORLD TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/world.js test-world.mjs
git commit -m "feat(world): real market events take priority, fiction as fallback"
```

---

### Task 11: Director 突发新闻注入 + 政策进入发言上下文

**Files:**
- Modify: `js/director.js`（构造函数、nextDay 段、speakSmart、新增两个方法）
- Modify: `js/llm.js:104-131`（`speak` 增加 policies 参数）
- Test: 追加到 `test-world.mjs`

- [ ] **Step 1: 在 `test-world.mjs` 末尾追加失败测试**

```js
// ---- Director × Feed：突发新闻、政策公告、跨日消费 ----
class StubFeed {
  constructor() { this.taken = 0; }
  takeEvents(max) {
    this.taken++;
    return [{ id: "evt_f1", summary: "竞品突然宣布免费扩容", real: true }];
  }
  activePolicies() { return ["全员降本，禁止新增带宽采购"]; }
}
const agents4 = PERSONAS.slice(0, 3).map((p, i) => new StubAgent(p, "f" + i));
const w4 = new World(DEFAULT_COMPANY);
const logs4 = [];
const feed4 = new StubFeed();
const d4 = new Director(agents4, office, m => logs4.push(m), null, w4, feed4);

// 突发新闻：所有人立即获得记忆，世界当日事件追加
const evCountBefore = w4.todayEvents.length;
d4.injectBreakingNews({ id: "evt_b1", summary: "服务器机房光缆被挖断" });
if (w4.todayEvents.length !== evCountBefore + 1) throw new Error("突发事件应进当日事件");
if (!agents4[0].memory.items.some(m => m.c.includes("光缆"))) throw new Error("突发事件应进记忆");
if (!logs4.some(l => l.includes("📡"))) throw new Error("突发事件应打日志");

// 政策公告：announced 写入全员高权重记忆
d4.announcePolicyChange({
  announced: [{ id: "pol_1", text: "全员降本，禁止新增带宽采购", active: true }],
  revoked: []
});
const polMem = agents4[1].memory.items.find(m => m.c.includes("降本"));
if (!polMem) throw new Error("政策应进入记忆");
if (polMem.imp < 8) throw new Error("政策记忆应为高权重");
d4.announcePolicyChange({ announced: [], revoked: ["pol_1"] });
if (!agents4[0].memory.items.some(m => m.c.includes("撤销") || m.c.includes("调整"))) throw new Error("撤销应有公告");

// 跨日：nextDay 应消费 feed.takeEvents
for (let t = 0; t < 259; t += 0.1) d4.update(0.1);
if (feed4.taken < 1) throw new Error("跨日应从 feed 取事件");
if (!w4.todayEvents.some(e => e.real)) throw new Error("新一天应使用真实事件");
console.log("Director × Feed 验证 ✓");
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（Director 构造函数不接收第 6 个参数 feed，`injectBreakingNews` 不存在）

- [ ] **Step 3: 修改 `js/director.js`**

构造函数签名（原 `js/director.js:36`）：

```js
  constructor(agents, office, log, llm = null, world = null, feed = null) {
```

并在 `this.world = world;` 之后加一行：

```js
    this.feed = feed;
```

跨日段（原 `js/director.js:169`）`this.world?.nextDay();` 改为：

```js
      this.world?.nextDay(this.feed?.takeEvents(3) ?? []);
```

`speakSmart` 里的 `this.llm.speak({...})` 调用（原 `js/director.js:141-146`）增加 policies：

```js
      this.llm.speak({
        persona: agent.persona,
        company: this.world?.companyBrief(),
        policies: this.feed?.activePolicies() ?? [],
        memories: agent.memory.retrieve(scene, 6),
        scene,
        transcript
      }).then(text => {
```

在 `broadcastDaily()` 方法之后新增两个方法：

```js
  /** 真实市场事件白天实时到达：作为突发新闻插入当前模拟日 */
  injectBreakingNews(ev) {
    const text = ev.summary || ev.title || "";
    if (!text) return;
    this.log(`📡 突发：${text}`, "log-meeting");
    if (this.world) this.world.todayEvents.push({ id: ev.id, text, real: true });
    for (const a of this.agents) {
      this.remember(a, `市场快讯：${text}`, 7, "world");
    }
  }

  /** 上层决策发布/撤销：高权重公告进入全员记忆 */
  announcePolicyChange({ announced = [], revoked = [] }) {
    for (const p of announced) {
      this.log(`📣 管理层决策：${p.text}`, "log-meeting");
      for (const a of this.agents) {
        this.remember(a, `管理层决策：${p.text}`, 9, "world");
      }
    }
    if (revoked.length > 0) {
      this.log(`📣 管理层调整：有 ${revoked.length} 条决策被撤销`, "log-meeting");
      for (const a of this.agents) {
        this.remember(a, `管理层撤销了之前的一条决策`, 6, "world");
      }
    }
  }
```

- [ ] **Step 4: 修改 `js/llm.js` 的 `speak`**

签名（原 `js/llm.js:104`）：

```js
  async speak({ persona, company, policies = [], memories = [], scene, transcript = [] }) {
```

system 拼接（原 `js/llm.js:108-113`）在公司行之后插入政策块：

```js
        const system =
          `你在一个办公室模拟中扮演「${persona.name}」（${persona.role}）。` +
          `你的性格画像：${persona.personality || "暂无"}。\n` +
          (company ? `你所在的公司：${company}\n` : "") +
          (policies.length
            ? `现行公司政策（管理层指令，你的发言和决定必须与之相符）：\n${policies.map(p => "- " + p).join("\n")}\n`
            : "") +
          `规则：你只知道下面提供的你自己的记忆和你刚听到的话，不要编造你不可能知道的信息。` +
          `用第一人称说一句话，口语化、符合你的性格，不超过 40 个字。只输出这句话本身，不要引号、不要名字前缀。`;
```

- [ ] **Step 5: 运行确认通过（全部前端测试）**

Run: `cd /Users/silas/huaxiang && node test-world.mjs && node test-feed.mjs && node test-sim.mjs`
Expected: 三个脚本全部以 ALL ... PASSED / DONE 结束（test-sim.mjs 不传 feed，验证向后兼容）

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add js/director.js js/llm.js test-world.mjs
git commit -m "feat(director): breaking news injection and policy-aware speech"
```

---

### Task 12: main.js 接线 + 状态指示 + 仪表盘标记

**Files:**
- Modify: `js/main.js`（引入 Feed、构造顺序、连接回调、renderDashboard）
- Modify: `index.html`（顶部加 feed 状态指示）

- [ ] **Step 1: 修改 `js/main.js` 头部 import 区（`js/main.js:5` 附近）追加**

```js
import { Feed } from "./feed.js";
```

- [ ] **Step 2: 修改 director 创建段（原 `js/main.js:99-103`）**

```js
log(`☀️ 第 ${world.day} 天开始了，团队陆续到岗`, "log-meeting");
const feed = new Feed();
director = new Director(agents, office, log, llm, world, feed);
feed.onBreaking = ev => director.injectBreakingNews(ev);
feed.onPolicyChange = ch => director.announcePolicyChange(ch);
feed.onStatus = on => {
  const chip = document.getElementById("feed-chip");
  if (!chip) return;
  chip.textContent = on ? "📡数据" : "📡离线";
  chip.classList.toggle("on", on);
  chip.title = on
    ? "已连接本地 sidecar，真实市场动态实时进入办公室"
    : "未检测到 sidecar，运行纯虚构模式（启动方式见 README）";
};
feed.connect().then(ok => {
  if (!ok) return;
  log("📡 已连接本地数据服务，真实市场动态将实时进入办公室", "log-meeting");
  // 开场把积压的真实事件（最多 2 条）作为突发新闻陆续放出
  feed.takeEvents(2).forEach((ev, i) => {
    setTimeout(() => director.injectBreakingNews(ev), 4000 + i * 9000);
  });
});
if (llm.enabled) {
  log(`✨ AI 对话已启用（${config.model.model}），会议和协作将实时生成对话`, "log-collab");
}
```

- [ ] **Step 3: 修改 `renderDashboard` 的事件渲染（原 `js/main.js:226-228`）**

```js
  dash.events.innerHTML = world.todayEvents
    .map(e => `<div class="dash-event">${e.real ? "📡" : "🎭"} ${escapeHtml(e.text)}</div>`)
    .join("");
```

- [ ] **Step 4: 修改 `index.html`：找到 ai-chip 元素，紧随其后插入 feed-chip**

先定位：`grep -n "ai-chip" /Users/silas/huaxiang/index.html`
在该元素之后插入（沿用 ai-chip 的同款 class，保持样式一致）：

```html
<span id="feed-chip" class="chip" title="未检测到 sidecar">📡离线</span>
```

注意：如 ai-chip 的标签结构带其他 class（以 grep 结果为准），feed-chip 抄同样的结构。

- [ ] **Step 5: 手动冒烟（经 sidecar 托管访问）**

```bash
cd /Users/silas/huaxiang/sidecar && npm start &
sleep 1
curl -s -X POST http://127.0.0.1:7878/api/policies -H 'content-type: application/json' -d '{"text":"冒烟测试政策：全员降本"}'
```
然后浏览器打开 `http://127.0.0.1:7878/`，验证：
1. 顶部出现「📡数据」指示（绿色 on 状态）
2. 事件日志出现「📣 管理层决策：冒烟测试政策…」
3. 点击任一人物 → 记忆流里有「管理层决策」条目
4. 用 `npx http-server -p 8080` 另开一个不带 sidecar 的入口，确认显示「📡离线」且模拟正常运行（降级路径）
完成后 `kill %1`

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add js/main.js index.html
git commit -m "feat(frontend): wire feed into simulation with status chip and dashboard marks"
```

---

### Task 13: admin 政策管理页 + sidecar 状态

**Files:**
- Modify: `admin.html:112`（公司设定 section 之后、人物管理 section 之前插入新 section）
- Modify: `js/admin.js`（末尾追加政策逻辑）

- [ ] **Step 1: 在 `admin.html` 的公司设定 `</section>`（112 行）之后插入**

```html
    <!-- 上层决策（需要本地 sidecar） -->
    <section class="card">
      <h2>🏛️ 上层决策 <span id="policy-count" class="count"></span></h2>
      <p class="hint">
        发布的决策会作为公司公告进入<strong>所有人的记忆</strong>，并持续约束他们之后的发言，直到撤销。
        需要本地 sidecar 运行，并从 sidecar 地址打开本页（如 <code>http://127.0.0.1:7878/admin.html</code>）。
      </p>
      <div id="policy-offline" class="hint" hidden>⚠️ 未检测到 sidecar，本区块不可用。启动方式见 README。</div>
      <div id="policy-list"></div>
      <div class="form-row">
        <label>新决策</label>
        <textarea id="policy-text" placeholder="例如：本季度冻结一切新功能开发，全员优先降本，带宽成本必须下降 15%"></textarea>
      </div>
      <div class="form-actions">
        <button id="btn-policy-publish">发布决策</button>
        <span id="policy-status"></span>
      </div>
    </section>
```

- [ ] **Step 2: 在 `js/admin.js` 末尾（`renderPersonas();` 之后）追加**

```js
// ---------- 上层决策（需要 sidecar） ----------
async function initPolicies() {
  const offline = $("policy-offline");
  const list = $("policy-list");
  const statusEl = $("policy-status");

  async function refresh() {
    const policies = await (await fetch("/api/policies")).json();
    $("policy-count").textContent = `（现行 ${policies.length} 条）`;
    list.innerHTML = policies.length === 0
      ? '<p class="hint">还没有现行决策。</p>'
      : "";
    for (const p of policies) {
      const row = document.createElement("div");
      row.className = "form-row policy-row";
      const span = document.createElement("span");
      span.textContent = `📣 ${p.text}`;
      const btn = document.createElement("button");
      btn.className = "ghost danger";
      btn.textContent = "撤销";
      btn.addEventListener("click", async () => {
        if (!confirm(`确定撤销这条决策吗？\n「${p.text}」`)) return;
        await fetch(`/api/policies/${p.id}`, { method: "DELETE" });
        refresh();
      });
      row.append(span, btn);
      list.appendChild(row);
    }
  }

  try {
    const health = await (await fetch("/api/health", { signal: AbortSignal.timeout(2000) })).json();
    if (!health.ok) throw new Error("bad health");
    const rss = health.collectors?.rss;
    if (rss && !rss.enabled && rss.reason) {
      offline.hidden = false;
      offline.textContent = `ℹ️ sidecar 已连接，但 RSS 采集器未启用：${rss.reason}`;
    }
  } catch {
    offline.hidden = false;
    $("btn-policy-publish").disabled = true;
    $("policy-text").disabled = true;
    return;
  }

  await refresh();

  $("btn-policy-publish").addEventListener("click", async () => {
    const text = $("policy-text").value.trim();
    if (!text) { alert("请先写下决策内容"); return; }
    const res = await fetch("/api/policies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (res.ok) {
      $("policy-text").value = "";
      statusEl.textContent = "已发布 ✓（返回办公室后 30 秒内生效）";
      setTimeout(() => { statusEl.textContent = ""; }, 4000);
      refresh();
    } else {
      alert(`发布失败：${(await res.json()).error || res.status}`);
    }
  });
}

initPolicies();
```

- [ ] **Step 3: 手动冒烟**

```bash
cd /Users/silas/huaxiang/sidecar && npm start &
sleep 1
```
浏览器打开 `http://127.0.0.1:7878/admin.html`，验证：
1. 「上层决策」区块出现，发布一条决策 → 列表刷新显示
2. 点撤销 → 确认后从列表消失
3. 打开 `http://127.0.0.1:7878/` 办公室页 → 30 秒内日志出现 📣 公告
4. 经 `npx http-server -p 8080` 打开 admin → 区块置灰显示离线提示
完成后 `kill %1`

- [ ] **Step 4: Commit**

```bash
cd /Users/silas/huaxiang
git add admin.html js/admin.js
git commit -m "feat(admin): policy management section with sidecar status"
```

---

### Task 14: README 与收尾验证

**Files:**
- Modify: `README.md`（「如何打开」一节后追加 sidecar 说明）

- [ ] **Step 1: 在 README「如何打开」一节末尾追加**

````markdown
**方式三：本地 sidecar（解锁真实市场监控与上层决策）**

```bash
cd sidecar
cp config.example.json config.json   # 改公司简介和 RSS 源
cp .env.example .env                 # 填一个便宜模型的 API Key（筛选新闻用）
npm install && npm start
# 浏览器打开 http://127.0.0.1:7878
```

sidecar 在线时：RSS 新闻经 AI 筛选后实时进入办公室（📡 标记），管理后台可发布「上层决策」长期约束所有人的言行。sidecar 不在线时一切回退纯虚构模式，GitHub Pages 部署不受影响。
````

- [ ] **Step 2: 全量测试**

```bash
cd /Users/silas/huaxiang/sidecar && node --test
cd /Users/silas/huaxiang && node test-feed.mjs && node test-world.mjs && node test-sim.mjs && node test-agent.mjs
```
Expected: 全部通过（test-agent.mjs 未被本期改动，应保持绿色）

- [ ] **Step 3: Commit**

```bash
cd /Users/silas/huaxiang
git add README.md
git commit -m "docs: sidecar quickstart in README"
```

---

## 验收清单（对照 spec P1 范围）

- [x] sidecar 骨架 + SQLite（Task 1, 2, 8）
- [x] RSS 采集器 + LLM 筛选（Task 6, 7）
- [x] 事件契约（Task 3）
- [x] SSE 实时推送 + 快照 + ack（Task 4, 8, 9）
- [x] 政策注入：持久 prompt 约束 + 发布/撤销公告（Task 5, 9, 11, 13）
- [x] admin 政策页（Task 13）
- [x] 前端事件消费 + 降级（Task 9, 10, 11, 12）
- [x] 静态托管（Task 8）
- [x] 安全：绑定 127.0.0.1（Task 8）
- 延后到 P2/P3/P4（按 spec 分期）：仓库端点、静态分析、embedding、web search/竞品 diff 采集器、市场反应模拟器、用户化身
