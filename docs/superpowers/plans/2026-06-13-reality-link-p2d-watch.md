# 现实连接 P2d（竞品页面 diff 监控采集器）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 sidecar 增加第二个真实市场信号源——**竞品页面 diff 监控**：定时抓取配置的竞品页面（官网公告页、应用商店版本页等），提取正文、与上次快照比对，有实质变化时用 LLM 判定相关性、过阈值则作为「竞品动态」事件进入办公室（与 RSS 同一条事件总线）。web search 采集器本轮按用户决定跳过。

**Architecture:** 新增 `sidecar/src/pageStore.js`（页面内容哈希快照，复用 SQLite，新增 `page_snapshots` 表）、`sidecar/src/collectors/watch.js`（`runWatchOnce` 依赖注入 fetchPage/llm/store/pageStore，含纯函数 `extractText` 提取正文）。变化检测用正文哈希；首次抓取只存基线不发事件（避免噪音）；变化后用既有 `SidecarLLM.scoreBatch` 判定相关性 + 摘要，复用 RSS 的「过阈值入库」逻辑。`server.js` 在直接运行块按 `watchIntervalMinutes` 定时跑，状态进 `/api/health`。全部依赖注入、可离线单测；无 LLM key 或无 watchUrls 时采集器自动禁用（同 RSS）。

**Tech Stack:** Node 22（内置 fetch、node:crypto、node:sqlite），沿用 sidecar `node --test`。

**约定：**
- sidecar 测试 `cd sidecar && node --test`
- 当前分支 main；本计划在新分支 `feature/p2d-watch` 执行，每任务一 commit
- 事件 source 用 `"watch"`（contracts.js 的 SOURCES 已含 watch，无需改）
- 噪音控制：变化检测基于正文哈希 + LLM 相关性过滤；用户应配置相对稳定的页面 URL（版本页/公告页）。首次抓取不发事件
- commit message 末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: page_snapshots 表 + pageStore

**Files:**
- Modify: `sidecar/src/db.js`
- Create: `sidecar/src/pageStore.js`
- Test: `sidecar/test/pageStore.test.mjs`

- [ ] **Step 1: 在 `sidecar/src/db.js` 的 SCHEMA 末尾追加表**

在 `policies` 表定义之后、模板字符串结束反引号之前，加入：

```js
CREATE TABLE IF NOT EXISTS page_snapshots(
  url_hash TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);
```

- [ ] **Step 2: 写失败测试 `sidecar/test/pageStore.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { PageStore } from "../src/pageStore.js";

test("save 存哈希，lastHash 取回；首次为 null", () => {
  const s = new PageStore(openDb(":memory:"));
  assert.equal(s.lastHash("https://a.com"), null);
  const h1 = s.save("https://a.com", "页面内容一");
  assert.equal(typeof h1, "string");
  assert.equal(s.lastHash("https://a.com"), h1);
});

test("内容不同 → 哈希不同；相同 → 相同", () => {
  const s = new PageStore(openDb(":memory:"));
  const a = s.save("https://x.com", "内容 A");
  const b = s.save("https://x.com", "内容 B");   // 覆盖
  assert.notEqual(a, b);
  assert.equal(s.lastHash("https://x.com"), b);
  const c = s.save("https://y.com", "内容 A");
  assert.equal(a, c);   // 相同正文 → 相同哈希（与 URL 无关）
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/pageStore.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `sidecar/src/pageStore.js`**

```js
// 竞品页面快照：只存正文哈希用于变化检测（不存全文，省空间）。
import { createHash } from "node:crypto";

function sha(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

export class PageStore {
  constructor(db) {
    this.db = db;
  }

  /** 该 URL 上次存的正文哈希，没有则 null */
  lastHash(url) {
    const r = this.db.prepare("SELECT content_hash FROM page_snapshots WHERE url_hash = ?").get(sha(url));
    return r ? r.content_hash : null;
  }

  /** 存入该 URL 的正文哈希，返回新哈希 */
  save(url, text) {
    const ch = sha(text);
    this.db.prepare("INSERT OR REPLACE INTO page_snapshots(url_hash, content_hash, ts) VALUES(?, ?, ?)")
      .run(sha(url), ch, Date.now());
    return ch;
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/pageStore.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/db.js sidecar/src/pageStore.js sidecar/test/pageStore.test.mjs
git commit -m "feat(sidecar): page_snapshots table and PageStore for diff detection"
```

---

### Task 2: extractText 正文提取（纯函数）

**Files:**
- Create: `sidecar/src/collectors/watch.js`
- Test: `sidecar/test/watch.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/watch.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../src/collectors/watch.js";

test("extractText 去掉脚本/样式/标签，解码实体，压空白", () => {
  const html = `<html><head><style>.a{color:red}</style><script>var x=1</script></head>
    <body><h1>会员价格</h1><p>SVIP&nbsp;年卡 &amp; 月卡<br>限时 5 折</p></body></html>`;
  const t = extractText(html);
  assert.ok(t.includes("会员价格"));
  assert.ok(t.includes("SVIP 年卡 & 月卡"));
  assert.ok(!t.includes("color:red"));   // style 内容被剔除
  assert.ok(!t.includes("var x"));        // script 内容被剔除
  assert.ok(!t.includes("<"));            // 无残留标签
});

test("extractText 空/非字符串安全", () => {
  assert.equal(extractText(""), "");
  assert.equal(extractText(null), "");
  assert.equal(extractText(undefined), "");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/watch.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 `sidecar/src/collectors/watch.js`（先只放 extractText）**

```js
// 竞品页面 diff 监控：抓页面 → 提取正文 → 与上次快照比对 → 有变化且相关则入库为「竞品动态」事件。
// 所有依赖注入（fetchPage/llm/store/pageStore），便于离线测试。

/** 从 HTML 提取可读正文：剔除 script/style/标签，解码常见实体，压缩空白 */
export function extractText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/watch.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/collectors/watch.js sidecar/test/watch.test.mjs
git commit -m "feat(sidecar): extractText for competitor page parsing"
```

---

### Task 3: runWatchOnce 采集逻辑

**Files:**
- Modify: `sidecar/src/collectors/watch.js`
- Test: `sidecar/test/watch.test.mjs`（追加）

- [ ] **Step 1: 在 `sidecar/test/watch.test.mjs` 末尾追加失败测试**

```js
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { PageStore } from "../src/pageStore.js";
import { runWatchOnce } from "../src/collectors/watch.js";

function makeDeps(pages, scores) {
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const pageStore = new PageStore(db);
  return {
    store, pageStore,
    urls: Object.keys(pages),
    fetchPage: async (url) => {
      if (pages[url] instanceof Error) throw pages[url];
      return pages[url];
    },
    llm: { scoreBatch: async (items) => items.map((_, i) => scores[i] ?? null) },
    companyBrief: "123云盘", threshold: 6, log: () => {}
  };
}

test("首次抓取只存基线，不发事件", async () => {
  const d = makeDeps({ "https://comp.test/vip": "<p>会员价格 10 元</p>" }, [{ relevance: 9, summary: "x" }]);
  const r = await runWatchOnce(d);
  assert.equal(r.checked, 1);
  assert.equal(r.changed, 0);
  assert.equal(r.inserted, 0);
  assert.equal(d.store.listUnconsumed().length, 0);
});

test("页面变化且相关 → 入库为 watch 事件", async () => {
  const d = makeDeps({ "https://comp.test/vip": "<p>会员价格 10 元</p>" }, [{ relevance: 9, summary: "竞品会员降价到 5 元" }]);
  await runWatchOnce(d);                                   // 基线
  d.fetchPage = async () => "<p>会员价格 5 元 限时</p>";    // 页面变了
  const r = await runWatchOnce(d);
  assert.equal(r.changed, 1);
  assert.equal(r.inserted, 1);
  const evs = d.store.listUnconsumed();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].source, "watch");
  assert.equal(evs[0].summary, "竞品会员降价到 5 元");
  assert.ok(evs[0].url.includes("comp.test"));
});

test("页面未变 → 不发事件；变化但低相关 → 不入库", async () => {
  const d = makeDeps({ "https://comp.test/p": "<p>原内容</p>" }, [{ relevance: 2, summary: "无关紧要" }]);
  await runWatchOnce(d);
  const r1 = await runWatchOnce(d);   // 内容没变
  assert.equal(r1.changed, 0);
  assert.equal(r1.inserted, 0);
  d.fetchPage = async () => "<p>变了但不重要</p>";
  const r2 = await runWatchOnce(d);   // 变了，但 relevance 2 < 6
  assert.equal(r2.changed, 1);
  assert.equal(r2.inserted, 0);
});

test("单页抓取失败不影响其他页", async () => {
  const d = makeDeps({
    "https://bad.test/x": new Error("ETIMEDOUT"),
    "https://ok.test/y": "<p>初始</p>"
  }, [{ relevance: 9, summary: "s" }]);
  await runWatchOnce(d);   // ok.test 建基线，bad.test 失败跳过
  d.fetchPage = async (url) => (url.includes("ok.test") ? "<p>更新了</p>" : (() => { throw new Error("ETIMEDOUT"); })());
  const r = await runWatchOnce(d);
  assert.equal(r.inserted, 1);   // ok.test 的变化照常入库
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/watch.test.mjs`
Expected: FAIL（`runWatchOnce is not exported`）

- [ ] **Step 3: 在 `watch.js` 追加 `runWatchOnce` 与 `hostOf`（extractText 之后）**

```js
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url); }
}

/**
 * 跑一轮竞品页监控：逐 URL 抓取 → 提取正文 → 比对快照 → 有变化且相关则入库。
 * 依赖注入：fetchPage(url)->html、llm.scoreBatch、store(EventStore)、pageStore(PageStore)。
 */
export async function runWatchOnce({ urls, fetchPage, llm, store, pageStore, companyBrief, threshold = 6, log = console.log }) {
  let checked = 0, changed = 0, inserted = 0;
  for (const url of urls) {
    let html;
    try { html = await fetchPage(url); }
    catch (e) { log(`竞品页抓取失败 ${url}: ${e.message}`); continue; }
    checked++;
    const text = extractText(html);
    if (!text) continue;

    const prev = pageStore.lastHash(url);
    const cur = pageStore.save(url, text);
    if (!prev || prev === cur) continue;   // 首次基线 / 无变化
    changed++;

    const host = hostOf(url);
    const title = `竞品「${host}」页面更新`;
    const scored = await llm.scoreBatch([{ title, snippet: text.slice(0, 400) }], companyBrief);
    if (!scored || !scored[0]) continue;
    if (scored[0].relevance >= threshold) {
      store.add({
        source: "watch",
        title,
        summary: scored[0].summary,
        url,
        relevance: scored[0].relevance,
        suggestedImpact: scored[0].suggestedImpact
      });
      inserted++;
    }
  }
  return { checked, changed, inserted };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/watch.test.mjs`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/collectors/watch.js sidecar/test/watch.test.mjs
git commit -m "feat(sidecar): competitor page diff collector (runWatchOnce)"
```

---

### Task 4: config + server 接线

**Files:**
- Modify: `sidecar/config.example.json`
- Modify: `sidecar/src/server.js`

- [ ] **Step 1: 在 `sidecar/config.example.json` 增加 watch 字段**

加入（在已有键里）：

```json
  "watchUrls": [],
  "watchIntervalMinutes": 120
```

并可在示例里给出注释性占位（JSON 无注释，留空数组即可；README 给例子）。

- [ ] **Step 2: 在 `server.js` 的 `loadConfig` defaults 加默认值**

把 defaults 改为追加：

```js
    watchUrls: [], watchIntervalMinutes: 120
```

（即 defaults 里现有字段后加 `watchUrls: [], watchIntervalMinutes: 120`。）

- [ ] **Step 3: 在 `server.js` 直接运行块装配 watch 采集器**

在 rss 装配/`status` 定义附近，仿照 rss 加 watch。具体：在 `const parser = new Parser(...)` 之后、`const status = {...}` 之前，加入 watch 启用判断：

```js
  const { PageStore } = await import("./pageStore.js");
  const { runWatchOnce } = await import("./collectors/watch.js");
  const pageStore = new PageStore(db);
  const watchReason = !llm.enabled
    ? "未配置 SIDECAR_API_KEY / SIDECAR_MODEL"
    : (cfg.watchUrls && cfg.watchUrls.length ? null : "config.json 未配置 watchUrls");
```

把 `status` 的 collectors 加上 watch（在 rss 字段之后）：

```js
    watch: { enabled: !watchReason, lastRun: null, lastResult: null, reason: watchReason, urls: (cfg.watchUrls || []).length }
```

在 rssTick/setInterval 之后，加 watchTick 与定时：

```js
  async function watchTick() {
    if (!status.collectors.watch.enabled) return;
    status.collectors.watch.lastRun = Date.now();
    try {
      status.collectors.watch.lastResult = await runWatchOnce({
        urls: cfg.watchUrls,
        fetchPage: async (url) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 huaxiang-watch" } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.text();
        },
        llm, store: eventStore, pageStore,
        companyBrief: cfg.company, threshold: cfg.relevanceThreshold
      });
      const r = status.collectors.watch.lastResult;
      console.log(`竞品页监控完成：查 ${r.checked} 页，变化 ${r.changed}，入库 ${r.inserted}`);
    } catch (e) {
      status.collectors.watch.lastResult = { error: e.message };
      console.warn("竞品页监控异常：", e.message);
    }
  }
  watchTick();
  setInterval(watchTick, cfg.watchIntervalMinutes * 60 * 1000);
```

启动日志后补一行（在 rss 的提示附近）：

```js
    if (watchReason) console.log(`ℹ️ 竞品页监控未启用：${watchReason}`);
```

- [ ] **Step 4: 全量 sidecar 测试（buildApp 未改，应无回归）**

Run: `cd /Users/silas/huaxiang/sidecar && node --test 2>&1 | grep -E "^# (pass|fail)"`
Expected: 全绿（原 47 + pageStore 2 + watch 6 ≈ 55）

- [ ] **Step 5: 手动冒烟（用一个稳定页面，验证基线→变化）**

```bash
cd /Users/silas/huaxiang/sidecar
node -e "const fs=require('fs');let c={};try{c=JSON.parse(fs.readFileSync('config.json','utf8'))}catch{};c.watchUrls=['https://example.com/'];c.watchIntervalMinutes=120;fs.writeFileSync('config.json',JSON.stringify(c,null,2))"
lsof -ti :7878 | xargs kill 2>/dev/null
node --env-file-if-exists=.env src/server.js & sleep 3
curl -s http://127.0.0.1:7878/api/health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const h=JSON.parse(s);console.log('watch collector:',JSON.stringify(h.collectors.watch))})"
kill %1 2>/dev/null
```
Expected: health 的 collectors.watch 出现（enabled 取决于是否配了 LLM key 与 watchUrls；至少字段存在、reason 合理）。example.com 首轮只建基线、不发事件，符合预期。

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/config.example.json sidecar/src/server.js
git commit -m "feat(sidecar): wire competitor page watch collector on interval"
```

---

### Task 5: README + 全量回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 `README.md` 的代码咬合讨论那段 `>` 之后追加**

```markdown
> 竞品监控：在 `sidecar/config.json` 的 `watchUrls` 里填竞品的稳定页面（官网公告页、应用商店版本页等），sidecar 每 `watchIntervalMinutes` 分钟抓一次、和上次比对，有实质变化且与你业务相关时作为「竞品动态」事件进入办公室（与 RSS 同一条事件流）。建议选版本/公告这类相对稳定的页面，避免高频变动页造成噪音。需配置 LLM key（用于相关性判定）。
```

- [ ] **Step 2: 全量回归 + 清理冒烟写入的 watchUrls**

```bash
cd /Users/silas/huaxiang/sidecar && node --test 2>&1 | grep -E "^# (pass|fail)"
# 还原冒烟时写入 config.json 的 watchUrls（config.json 已被 .gitignore 忽略，仅清理本机运行态）
node -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.watchUrls=[];fs.writeFileSync('config.json',JSON.stringify(c,null,2))}catch{}"
cd /Users/silas/huaxiang && for t in test-board test-feed test-world test-sim test-agent; do printf "%s: " "$t"; node $t.mjs 2>/dev/null | tail -1; done
```
Expected: sidecar 全绿（≈55）；前端 5 脚本全绿（前端本期未改动）。

- [ ] **Step 3: Commit**

```bash
cd /Users/silas/huaxiang
git add README.md
git commit -m "docs: competitor page watch collector usage"
```

---

## 验收清单（对照 spec P2d）

- [x] 竞品页面 diff 监控采集器（抓取 → 提取 → 比对 → LLM 相关性过滤 → 入库）（Task 2, 3, 4）
- [x] 与 RSS 同一条事件总线（source="watch"）（Task 3）
- [x] 首次基线不发事件、单页失败隔离、低相关不入库（Task 3）
- [x] 定时运行 + /api/health 状态（Task 4）
- [x] 无 LLM key 或无 watchUrls 时自动禁用（Task 4）
- 本子计划不含：web search 采集器（用户本轮决定跳过；以后用可配置搜索 API 补）
