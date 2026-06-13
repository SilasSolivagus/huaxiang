# 现实连接 P2b（记忆检索升级）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每个 Agent 的记忆检索从「中文 bigram 字面重叠 + 墙钟时间衰减」升级为「神经 embedding 语义相似度 + 模拟时间衰减」，让"成本压力"能检索到"带宽涨价"这类语义相关但字面不同的记忆；embedding 由 sidecar 内置本地模型（transformers.js）提供，sidecar/模型不可用时**自动回退** bigram，模拟永不中断。

**Architecture:** sidecar 新增 `embed.js`（懒加载 transformers.js 本地模型，批量 `feature-extraction` + mean-pool + L2 归一化）和 `/api/embed` 端点。前端 `memory.js` 的 `retrieve` 改为 **async**：注入了 embedder（来自 feed → sidecar）时用余弦相似度，否则回退 bigram；记忆向量按 item 引用缓存在 WeakMap（不持久化，避免撑爆 localStorage）。记忆时间戳改存**模拟分钟数**（`day*1440 + HH:MM`），recency 从它计算，修掉加速/隔夜衰减错乱。director 的发言生成 `await` 检索结果。

**Tech Stack:** `@xenova/transformers`（transformers.js v2，ONNX 本地推理）、模型 `Xenova/bge-small-zh-v1.5`（中文优化，384 维，~100MB，首次调用时下载并缓存）、Node 22、sidecar `node --test`，前端 `test-*.mjs`。

**约定：**
- sidecar 测试 `cd sidecar && node --test`；前端测试在仓库根 `node test-*.mjs`
- 当前分支 main；本计划在新分支 `feature/p2b-memory` 执行，每任务一 commit
- embedding 逻辑全部依赖注入（extractor / embedder / embed fn）以便离线单测；真实模型加载只在冒烟步骤验证
- **核心不变量**：sidecar 离线、模型未安装、embed 调用失败 → 一律回退 bigram，retrieve 不抛错、不阻塞
- commit message 末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: memory.js 模拟时间 recency 修复

**Files:**
- Modify: `js/memory.js`
- Test: 追加到 `test-world.mjs`

**背景：** `add` 现在存 `at: Date.now()`（墙钟），`retrieve` 用 `(newest.at - m.at)/3600000` 算 ageHours。加速/隔夜时墙钟与模拟时间脱节。本任务给每条记忆加 `t`（模拟分钟数）并让 recency 用它；`at` 保留用于存盘/淘汰的插入顺序。

- [ ] **Step 1: 在 `test-world.mjs` 末尾（`ALL WORLD TESTS PASSED` 之前）追加失败测试**

```js
// ---- 记忆 recency 用模拟时间（不受墙钟影响）----
const mt = new MemoryStream("recency-test");
mt.add("第一天的旧事", { importance: 5, day: 1, time: "09:00" });
mt.add("第十天的新事", { importance: 5, day: 10, time: "09:00" });
const ml = mt.items;
if (!(ml[1].t > ml[0].t)) throw new Error("模拟时间戳 t 应随天数递增");
if (ml[0].t !== 1 * 1440 + 540) throw new Error("t 应为 day*1440 + 分钟数");
// 同等重要度/相关度下，第十天的记忆 recency 更高，排在前面
const r2 = await mt.retrieve("事", 2);
if (!r2[0].includes("第十天")) throw new Error("较新的记忆应因 recency 排在前");
console.log("模拟时间 recency 验证 ✓");
```

注意：本测试用了 `await mt.retrieve(...)`——Task 5 才把 retrieve 改成 async。本任务只加 `t` 字段并让 recency 用 `t`，**retrieve 仍是同步的**，所以这一步先把 `await mt.retrieve` 写成 `mt.retrieve`（同步）。Task 5 再统一改 await。即本步测试写成：

```js
const r2 = mt.retrieve("事", 2);
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（`ml[1].t` 为 undefined → "模拟时间戳 t 应随天数递增"）

- [ ] **Step 3: 修改 `js/memory.js`**

在文件顶部 `MAX_ITEMS` 附近加一个常量与解析函数（放在 `bigrams` 之前）：

```js
const DAY_SPAN_MIN = 1440;   // 把"第 N 天 HH:MM"折算成单调递增的模拟分钟数

function simMinutes(day, time) {
  let hm = 0;
  if (typeof time === "string" && time.includes(":")) {
    const [h, m] = time.split(":").map(Number);
    hm = (h || 0) * 60 + (m || 0);
  }
  return (Number(day) || 0) * DAY_SPAN_MIN + hm;
}
```

`add` 方法里 push 的对象加上 `t`：

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

`retrieve` 里 recency 改用模拟时间（把现有用 `at` 算 recency 的两行替换）：

```js
  retrieve(query, k = 6) {
    if (this.items.length === 0) return [];
    const q = bigrams(query);
    const newestT = this.items.reduce((mx, m) => Math.max(mx, m.t ?? 0), 0);
    const scored = this.items.map(m => {
      const ageDays = (newestT - (m.t ?? 0)) / DAY_SPAN_MIN;
      const recency = Math.pow(0.6, ageDays);   // 每过一个模拟日衰减到 0.6
      let relevance = 0;
      const mb = bigrams(m.c);
      for (const g of q) if (mb.has(g)) relevance++;
      return { m, score: m.imp * 0.7 + recency * 3 + Math.min(relevance, 6) * 0.8 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ m }) =>
      `（第${m.day}天${m.time ? " " + m.time : ""}）${m.c}`
    );
  }
```

（注意：旧记忆从 localStorage 读出时可能没有 `t` 字段——`m.t ?? 0` 兜底，老数据 recency 当作最旧，无害。）

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: 含 `模拟时间 recency 验证 ✓` 与 `ALL WORLD TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/memory.js test-world.mjs
git commit -m "feat(memory): simulated-time recency instead of wall-clock"
```

---

### Task 2: sidecar embed.js（依赖注入版 + 余弦/批量逻辑）

**Files:**
- Create: `sidecar/src/embed.js`
- Test: `sidecar/test/embed.test.mjs`

**背景：** 先做不依赖真实模型的逻辑层（批量调 extractor、归一化兜底、空输入处理），真实模型加载在 Task 3 接入。

- [ ] **Step 1: 写失败测试 `sidecar/test/embed.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbedder, cosine } from "../src/embed.js";

test("cosine：相同向量=1，正交=0", () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([0, 0], [1, 1]), 0);   // 零向量安全
});

test("embed：用注入 extractor 批量产出向量", async () => {
  // 假 extractor：把文本长度映射成一个 2 维向量
  const fakeExtractor = async (texts) => texts.map(t => [t.length, 1]);
  const emb = createEmbedder("fake-model", { extractor: fakeExtractor });
  const vecs = await emb.embed(["ab", "abcd"]);
  assert.equal(vecs.length, 2);
  assert.deepEqual(vecs[0], [2, 1]);
  assert.deepEqual(vecs[1], [4, 1]);
});

test("embed：空输入返回空数组，不调 extractor", async () => {
  let called = false;
  const emb = createEmbedder("fake", { extractor: async () => { called = true; return []; } });
  assert.deepEqual(await emb.embed([]), []);
  assert.equal(called, false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/embed.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/embed.js`**

```js
// 本地 embedding 服务：懒加载 transformers.js 模型，批量产出归一化句向量。
// extractor 依赖注入：真实用 transformers.js pipeline（Task 3 接入），测试用假函数。

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {string} model 模型名
 * @param {{extractor?: (texts:string[]) => Promise<number[][]>}} deps
 */
export function createEmbedder(model, deps = {}) {
  const extractor = deps.extractor || null;

  async function embed(texts) {
    const list = (texts || []).map(t => String(t || ""));
    if (list.length === 0) return [];
    if (!extractor) throw new Error("embedder not ready");
    return await extractor(list);
  }

  return { model, embed };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/embed.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/embed.js sidecar/test/embed.test.mjs
git commit -m "feat(sidecar): embedder logic layer with cosine (DI extractor)"
```

---

### Task 3: 接入真实 transformers.js 模型 + 安装依赖

**Files:**
- Modify: `sidecar/package.json`
- Modify: `sidecar/src/embed.js`
- Modify: `sidecar/config.example.json`
- Modify: `sidecar/src/server.js`（loadConfig 默认值）

- [ ] **Step 1: 加依赖并安装**

```bash
cd /Users/silas/huaxiang/sidecar
npm install @xenova/transformers@^2.17.2
```
Expected: package.json dependencies 多出 `@xenova/transformers`，无报错。

- [ ] **Step 2: 在 `embed.js` 给 `createEmbedder` 加默认 extractor（懒加载真实 pipeline）**

把 `const extractor = deps.extractor || null;` 改为：

```js
  let pipe = null, loading = null;
  async function realExtractor(texts) {
    if (!pipe) {
      if (!loading) {
        const { pipeline } = await import("@xenova/transformers");
        loading = pipeline("feature-extraction", model).then(p => { pipe = p; return p; });
      }
      await loading;
    }
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist();   // [[...], [...]]
  }
  const extractor = deps.extractor || realExtractor;
```

- [ ] **Step 3: 在 `config.example.json` 增加 embed 字段**

在 JSON 里加：

```json
  "embedEnabled": true,
  "embedModel": "Xenova/bge-small-zh-v1.5"
```

- [ ] **Step 4: 在 `server.js` 的 `loadConfig` defaults 加默认值**

```js
  const defaults = {
    port: 7878, company: "", feeds: [], relevanceThreshold: 6, rssIntervalMinutes: 30,
    repoPath: "", repoDigestMaxCommits: 10,
    embedEnabled: true, embedModel: "Xenova/bge-small-zh-v1.5"
  };
```

- [ ] **Step 5: 单测仍只验证逻辑层（不下载模型），确认不回归**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/embed.test.mjs`
Expected: PASS（3 tests，注入 extractor 路径不触发真实下载）

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/package.json sidecar/package-lock.json sidecar/src/embed.js sidecar/config.example.json sidecar/src/server.js
git commit -m "feat(sidecar): wire transformers.js local model into embedder"
```

---

### Task 4: /api/embed 端点

**Files:**
- Modify: `sidecar/src/server.js`
- Test: `sidecar/test/server.test.mjs`（追加）

- [ ] **Step 1: 在 `sidecar/test/server.test.mjs` 末尾追加失败测试**

```js
test("/api/embed：用注入 embedder 返回向量；未配置返回 503", async () => {
  // 带 embedder 的实例
  const db = openDb(":memory:");
  const status = { collectors: { rss: { enabled: false, reason: "test" } }, embed: { enabled: true } };
  const fakeEmbedder = { embed: async (texts) => texts.map(t => [t.length, 1]) };
  const app = buildApp({ eventStore: new EventStore(db), policyStore: new PolicyStore(db), status, embedder: fakeEmbedder });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const r = await (await fetch(`${base}/api/embed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts: ["ab", "abcd"] })
  })).json();
  assert.deepEqual(r.vectors, [[2, 1], [4, 1]]);

  // 无 embedder 的实例 → 503
  const { server: s2, base: base2 } = startTestServer();
  after(() => s2.close());
  const res = await fetch(`${base2()}/api/embed`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: ["x"] })
  });
  assert.equal(res.status, 503);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/server.test.mjs`
Expected: FAIL（/api/embed 路由不存在 → 404）

- [ ] **Step 3: 修改 `buildApp`**

签名加 `embedder = null`：

```js
export function buildApp({ eventStore, policyStore, status, repo = null, analysisProvider = null, digestProvider = null, embedder = null }) {
```

在 repo 路由之后、静态托管之前插入：

```js
  // ---------- 本地 embedding（需开启且模型可加载）----------
  app.post("/api/embed", async (req, res) => {
    if (!embedder) return res.status(503).json({ error: "embed 未启用" });
    try {
      const texts = Array.isArray(req.body?.texts) ? req.body.texts : [];
      res.json({ vectors: await embedder.embed(texts) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/server.test.mjs`
Expected: PASS（含新测试）

- [ ] **Step 5: 直接运行分支装配 embedder + health**

在该块 repo 装配之后加入：

```js
  let embedder = null;
  if (cfg.embedEnabled) {
    const { createEmbedder } = await import("./embed.js");
    embedder = createEmbedder(cfg.embedModel);   // 懒加载：首次 /api/embed 时才下载模型
  }
```

把 `status` 加上 embed 字段：

```js
  const status = {
    collectors: { rss: { enabled: !rssReason, lastRun: null, lastResult: null, reason: rssReason } },
    repo: { enabled: !!repo, path: cfg.repoPath || "", reason: repoReason },
    embed: { enabled: !!embedder, model: cfg.embedModel }
  };
```

把 `buildApp({...})` 调用加上 `embedder`：

```js
  const app = buildApp({
    eventStore, policyStore, status, repo,
    analysisProvider: repo ? () => analyzeRepo(repo) : null,
    digestProvider: repo ? () => repoDigest(repo, { maxCommits: cfg.repoDigestMaxCommits }) : null,
    embedder
  });
```

`/api/health` 返回加上 `embed: status.embed`（把那行改为）：

```js
    res.json({ ok: true, today: eventStore.todayCount(), collectors: status.collectors, repo: status.repo, embed: status.embed });
```

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/server.js sidecar/test/server.test.mjs
git commit -m "feat(sidecar): /api/embed endpoint"
```

---

### Task 5: memory.js 语义检索（async retrieve + bigram 回退）

**Files:**
- Modify: `js/memory.js`
- Modify: `js/director.js`（speakSmart 改为 await 检索）
- Test: 追加到 `test-world.mjs`

**背景：** retrieve 改 async。注入 embedder（`setEmbedder(fn)`，fn: `(texts)=>Promise<number[][]|null>`）时：embed 查询 + 候选记忆（按 item 引用缓存在 WeakMap，不持久化），余弦相似度当 relevance；否则回退 bigram。候选只取最近 150 条（控成本）。embedder 返回 null（离线/失败）时该次回退 bigram。

- [ ] **Step 1: 在 `test-world.mjs` 末尾追加失败测试**

```js
// ---- 语义检索：注入 embedder 后用余弦相似度 ----
const ms = new MemoryStream("semantic-test");
// 假 embedder：把关键词映射到固定向量，让"带宽成本"和"流量费用涨"语义接近
const VECS = {
  "我们要控制带宽成本": [1, 0, 0],
  "最近流量费用涨得厉害": [0.9, 0.1, 0],
  "今天午饭吃什么": [0, 0, 1]
};
ms.add("我们要控制带宽成本", { importance: 4, day: 1, time: "10:00" });
ms.add("最近流量费用涨得厉害", { importance: 4, day: 1, time: "10:05" });
ms.add("今天午饭吃什么", { importance: 4, day: 1, time: "10:10" });
ms.setEmbedder(async (texts) => texts.map(t => VECS[t] || [0, 0, 0]));
const sem = await ms.retrieve("我们要控制带宽成本", 2);
if (!sem.some(s => s.includes("流量费用涨"))) {
  throw new Error("语义检索应把'流量费用涨'召回（与'带宽成本'语义近），bigram 做不到");
}
if (sem.some(s => s.includes("午饭"))) throw new Error("语义无关的'午饭'不应进 top2");

// 无 embedder → 回退 bigram，仍可用（不抛错）
const ms2 = new MemoryStream("fallback-test");
ms2.add("竞品涨价了", { importance: 5, day: 1, time: "09:00" });
const fb = await ms2.retrieve("竞品 价格", 1);
if (!fb[0].includes("竞品")) throw new Error("无 embedder 应回退 bigram");
console.log("语义检索 + 回退验证 ✓");
```

并把 Task 1 里那条 `const r2 = mt.retrieve("事", 2);` 改成 `const r2 = await mt.retrieve("事", 2);`（现在 retrieve 是 async 了）。

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（`ms.setEmbedder is not a function`）

- [ ] **Step 3: 修改 `js/memory.js`**

constructor 末尾加：

```js
    this.embedder = null;        // (texts:string[]) => Promise<number[][]|null>
    this._vec = new WeakMap();   // item -> 向量（内存缓存，不持久化）
```

加 setEmbedder 方法（放在 add 之后）：

```js
  setEmbedder(fn) { this.embedder = fn; }
```

加一个文件内余弦函数（放在 bigrams 之前或之后）：

```js
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
```

把整个 `retrieve` 替换为 async 版（语义优先、bigram 回退）：

```js
  async retrieve(query, k = 6) {
    if (this.items.length === 0) return [];
    const newestT = this.items.reduce((mx, m) => Math.max(mx, m.t ?? 0), 0);
    const recencyOf = m => Math.pow(0.6, (newestT - (m.t ?? 0)) / DAY_SPAN_MIN);

    // 候选：最近 150 条（控 embedding 成本）
    const cand = this.items.slice(-150);

    // 尝试语义检索
    if (this.embedder) {
      try {
        const need = cand.filter(m => !this._vec.has(m));
        const toEmbed = [query, ...need.map(m => m.c)];
        const vecs = await this.embedder(toEmbed);
        if (vecs && vecs.length === toEmbed.length) {
          const qv = vecs[0];
          need.forEach((m, i) => this._vec.set(m, vecs[i + 1]));
          const scored = cand.map(m => {
            const rel = cosineSim(qv, this._vec.get(m) || []);   // 0~1
            return { m, score: m.imp * 0.5 + recencyOf(m) * 2 + rel * 5 };
          });
          scored.sort((a, b) => b.score - a.score);
          return scored.slice(0, k).map(fmt);
        }
      } catch (e) {
        // 落空 → 回退 bigram
      }
    }

    // 回退：bigram 字面相关
    const q = bigrams(query);
    const scored = cand.map(m => {
      let rel = 0;
      const mb = bigrams(m.c);
      for (const g of q) if (mb.has(g)) rel++;
      return { m, score: m.imp * 0.7 + recencyOf(m) * 3 + Math.min(rel, 6) * 0.8 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(fmt);
  }
```

并在文件内加格式化辅助（retrieve 用到的 `fmt`）：

```js
function fmt(s) {
  const m = s.m || s;
  return `（第${m.day}天${m.time ? " " + m.time : ""}）${m.c}`;
}
```

注意：上面 `scored.slice(0,k).map(fmt)` 传入的是 `{m,score}`，`fmt` 取 `s.m`。确保 fmt 兼容。

- [ ] **Step 4: 修改 `js/director.js` 的 speakSmart：await 检索结果**

把 speakSmart 里 LLM 可用分支：

```js
    if (this.llm?.available && agent.memory) {
      this.llm.speak({
        persona: agent.persona,
        company: this.world?.companyBrief(),
        policies: this.feed?.activePolicies() ?? [],
        memories: agent.memory.retrieve(scene, 6),
        scene,
        transcript: transcript.slice(-6)
      }).then(text => {
        finish(text || fallback, !!text);
      });
    } else {
      finish(fallback, false);
    }
```

改为先 await 检索（retrieve 现在是 async）：

```js
    if (this.llm?.available && agent.memory) {
      agent.memory.retrieve(scene, 6).then(memories =>
        this.llm.speak({
          persona: agent.persona,
          company: this.world?.companyBrief(),
          policies: this.feed?.activePolicies() ?? [],
          memories,
          scene,
          transcript: transcript.slice(-6)
        })
      ).then(text => {
        finish(text || fallback, !!text);
      }).catch(() => finish(fallback, false));
    } else {
      finish(fallback, false);
    }
```

- [ ] **Step 5: 运行确认通过（前端全量）**

Run: `cd /Users/silas/huaxiang && node test-world.mjs && node test-sim.mjs && node test-board.mjs && node test-agent.mjs && node test-feed.mjs`
Expected: 全部 PASS（test-world 含 `语义检索 + 回退验证 ✓`；test-sim 的 Director 跑动正常——它不带 embedder，retrieve 走 bigram 回退）

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add js/memory.js js/director.js test-world.mjs
git commit -m "feat(memory): async semantic retrieval via embeddings, bigram fallback"
```

---

### Task 6: 前端接线（feed.embed + 给每个 Agent 注入 embedder）

**Files:**
- Modify: `js/feed.js`
- Modify: `js/main.js`
- Test: 追加到 `test-feed.mjs`

- [ ] **Step 1: 在 `test-feed.mjs` 末尾追加失败测试（diffPolicies 同款纯逻辑风格）**

feed.embed 依赖 fetch/online，不易纯测；这里只测「离线时 embed 返回 null」这一回退保证。在 `ALL FEED TESTS PASSED` 之前加：

```js
import { Feed } from "./js/feed.js";
const f = new Feed();   // 未 connect → online=false
const v = await f.embed(["x"]);
if (v !== null) throw new Error("离线时 embed 应返回 null（触发 bigram 回退）");
console.log("feed.embed 离线回退验证 ✓");
```

（注意：`test-feed.mjs` 顶部已 `import { diffPolicies } from "./js/feed.js";`，可改为一并 import `Feed`。Feed 构造不碰浏览器 API，Node 下可实例化；embed 在 online=false 时直接返回 null，不发 fetch。）

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-feed.mjs`
Expected: FAIL（`f.embed is not a function`）

- [ ] **Step 3: 在 `js/feed.js` 的 Feed 类加 embed 方法（放在 ack 之后）**

```js
  /** 文本批量转向量：在线则走 sidecar 本地模型，离线/失败返回 null（调用方回退 bigram） */
  async embed(texts) {
    if (!this.online || !texts || texts.length === 0) return null;
    try {
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts })
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.vectors) ? data.vectors : null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: 在 `js/main.js` 给每个 Agent 的记忆注入 embedder**

在 `feed` 与 `agents` 都已创建之后（`director = new Director(...)` 那一段之后，`feed.connect()` 之前或之后均可），加入：

```js
// 给每个 Agent 的记忆流接上 sidecar 本地 embedding（离线自动回退 bigram）
for (const a of agents) {
  if (a.memory) a.memory.setEmbedder(texts => feed.embed(texts));
}
```

- [ ] **Step 5: 运行确认通过 + 语法检查**

```bash
cd /Users/silas/huaxiang
node test-feed.mjs
node --check js/main.js && echo "main.js OK"
```
Expected: `feed.embed 离线回退验证 ✓` + `ALL FEED TESTS PASSED`；main.js 语法 OK

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add js/feed.js js/main.js test-feed.mjs
git commit -m "feat(frontend): wire sidecar embeddings into agent memory"
```

---

### Task 7: 真实模型冒烟 + README + 全量回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 真实模型端到端冒烟（会下载 ~100MB 模型，首次较慢）**

```bash
cd /Users/silas/huaxiang/sidecar
lsof -ti :7878 | xargs kill 2>/dev/null
node --env-file-if-exists=.env src/server.js & sleep 2
# 第一次调用触发模型下载，可能需要 1~2 分钟；用较长超时
curl -s -m 180 -X POST http://127.0.0.1:7878/api/embed -H 'content-type: application/json' \
  -d '{"texts":["控制带宽成本","流量费用上涨","今天午饭吃什么"]}' > /tmp/embed-smoke.json
node -e "const d=require('/tmp/embed-smoke.json');const c=(a,b)=>{let dot=0,x=0,y=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i]}return dot/Math.sqrt(x*y)};const v=d.vectors;console.log('dim',v[0].length);console.log('带宽~流量', c(v[0],v[1]).toFixed(3));console.log('带宽~午饭', c(v[0],v[2]).toFixed(3))"
kill %1 2>/dev/null
```
Expected: 输出向量维度（384）；`带宽~流量` 的余弦明显高于 `带宽~午饭`（语义可分）。若模型下载失败/装不起来，记录到报告——前端会回退 bigram，不阻塞合并，但需如实说明冒烟未通过的原因。

- [ ] **Step 2: 在 `README.md`「方式三」repoPath 那段之后追加一句**

```markdown
> 记忆语义检索：sidecar 默认启用本地 embedding 模型（`embedModel`，首次调用自动下载 ~100MB，离线运行）。开启后 Agent 的记忆按**语义相似度**检索（"成本压力"能召回"带宽涨价"）；sidecar 不在线或模型未就绪时自动回退到字面检索，不影响运行。如需关闭，在 `config.json` 设 `"embedEnabled": false`。
```

- [ ] **Step 3: 全量回归**

```bash
cd /Users/silas/huaxiang/sidecar && node --test 2>&1 | grep -E "^# (pass|fail)"
cd /Users/silas/huaxiang && for t in test-board test-feed test-world test-sim test-agent; do printf "%s: " "$t"; node $t.mjs 2>/dev/null | tail -1; done
```
Expected: sidecar 全绿（原 43 + embed 逻辑 + /api/embed ≈ 47）；前端 5 脚本全绿。

- [ ] **Step 4: Commit**

```bash
cd /Users/silas/huaxiang
git add README.md
git commit -m "docs: local embedding model for semantic memory retrieval"
```

---

## 验收清单（对照 spec P2 中本子计划覆盖部分）

- [x] 记忆相关性 bigram → embedding 余弦（Task 2, 3, 5）
- [x] embedding 由 sidecar 本地模型提供（transformers.js）（Task 3, 4）
- [x] 时近性用模拟时间而非墙钟，修加速/隔夜衰减（Task 1）
- [x] 优雅降级：sidecar/模型不可用 → bigram，retrieve 不抛错（Task 5, 6 全程）
- [x] 向量不持久化（WeakMap 内存缓存），不撑爆 localStorage（Task 5）
- 本子计划不含（留给后续）：会议 tool-use + 真实指标接入世界模型（P2c）、web search/竞品 diff 采集器（P2d）
