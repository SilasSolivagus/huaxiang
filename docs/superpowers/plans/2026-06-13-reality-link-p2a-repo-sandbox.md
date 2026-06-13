# 现实连接 P2a（代码仓库沙箱）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sidecar 以**只读、防逃逸**的方式挂载一个本地代码仓库，对前端暴露 tree / file / grep / log 四个读取端点、每日仓库动态摘要、以及静态分析指标（文件数 / TODO 数 / 复杂度热点），为后续「Agent 开会讨论真实代码」「用真实技术债替换虚构 Bug 指标」打地基。

**Architecture:** 新增 `sidecar/src/repo.js`（路径白名单 + tree/readFile/grep/log，命令用 `execFile` 无 shell 注入、带超时）、`sidecar/src/analysis.js`（静态分析）、`sidecar/src/digest.js`（每日摘要，带缓存）。`server.js` 加 `/api/repo/*` 与 `/api/analysis` 路由，仅在 `config.repoPath` 配置且通过校验时启用，否则返回 503 并在 `/api/health` 标注未启用原因。全部依赖注入（`run` 执行器）以便离线单测。本计划纯 sidecar 侧，前端消费（feed / world / 会议 tool-use）留给 P2c。

**Tech Stack:** Node 22（node:child_process execFile、node:fs realpath）、ripgrep（`rg`）、git，沿用 sidecar 既有 `node --test` 测试风格。

**约定：**
- 测试目录：`sidecar/test/*.test.mjs`，运行 `cd sidecar && node --test`
- 被挂载的"产品仓库"在测试中就用 huaxiang 仓库自身（`join(SIDECAR_ROOT, "..")`，含 git 历史与源码）
- 当前分支 main；本计划在新分支 `feature/p2a-repo-sandbox` 上执行，每个任务一个 commit
- 安全是本计划的核心：任何 repo 端点都必须 `realpath` 校验在仓库根内，拒绝 `..` 与符号链接逃逸；只读，永不执行仓库内的脚本
- `rg` 已确认在 `/opt/homebrew/bin/rg`；git 可用。commit message 末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 配置项 repoPath 接入

**Files:**
- Modify: `sidecar/config.example.json`
- Modify: `sidecar/src/server.js`（`loadConfig` 默认值）

- [ ] **Step 1: 在 `sidecar/config.example.json` 增加 repo 相关字段**

把文件改为（在原有键基础上加 `repoPath`、`repoDigestMaxCommits`）：

```json
{
  "port": 7878,
  "company": "123云盘（123pan），个人云存储创业公司，主打大容量与上传下载不限速，竞品有百度网盘、夸克、阿里云盘等",
  "feeds": [
    "https://www.ithome.com/rss/",
    "https://36kr.com/feed"
  ],
  "relevanceThreshold": 6,
  "rssIntervalMinutes": 30,
  "repoPath": "",
  "repoDigestMaxCommits": 10
}
```

- [ ] **Step 2: 在 `server.js` 的 `loadConfig` defaults 里加入新字段**

找到 `loadConfig` 里的 `const defaults = {...}`，改为：

```js
  const defaults = {
    port: 7878, company: "", feeds: [], relevanceThreshold: 6, rssIntervalMinutes: 30,
    repoPath: "", repoDigestMaxCommits: 10
  };
```

- [ ] **Step 3: 验证 sidecar 现有测试不受影响**

Run: `cd /Users/silas/huaxiang/sidecar && node --test`
Expected: 仍 28 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/config.example.json sidecar/src/server.js
git commit -m "feat(sidecar): config plumbing for repoPath"
```

---

### Task 2: repo.js 路径安全（resolveInside）

**Files:**
- Create: `sidecar/src/repo.js`
- Test: `sidecar/test/repo.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/repo.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRepoService } from "../src/repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");  // huaxiang 仓库根

test("resolveInside 接受仓库内路径", () => {
  const svc = createRepoService(REPO_ROOT);
  assert.ok(svc.resolveInside("js/main.js").endsWith("/js/main.js"));
  assert.ok(svc.resolveInside("README.md").endsWith("/README.md"));
});

test("resolveInside 拒绝 .. 逃逸、绝对路径、上级目录", () => {
  const svc = createRepoService(REPO_ROOT);
  assert.throws(() => svc.resolveInside("../../etc/passwd"));
  assert.throws(() => svc.resolveInside("/etc/passwd"));
  assert.throws(() => svc.resolveInside("../package.json"));
  assert.throws(() => svc.resolveInside("js/../../.."));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/repo.test.mjs`
Expected: FAIL（`Cannot find module '../src/repo.js'`）

- [ ] **Step 3: 实现 `sidecar/src/repo.js`（先只放安全层 + 执行器）**

```js
// 只读代码仓库服务：路径白名单 + tree/readFile/grep/log。
// 命令一律用 execFile（无 shell，杜绝注入）、带超时；只读，永不执行仓库内脚本。
import { realpathSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFile } from "node:child_process";

function defaultRun(cmd, args, cwd) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { err.stdout = stdout; return rej(err); }
      res(stdout);
    });
  });
}

export function createRepoService(rootPath, deps = {}) {
  const run = deps.run || defaultRun;
  let root;
  try { root = realpathSync(resolve(rootPath)); } catch { root = resolve(rootPath); }

  function resolveInside(rel) {
    const cleaned = String(rel || "").replace(/^[/\\]+/, "");
    const abs = resolve(root, cleaned);
    let real;
    try { real = realpathSync(abs); } catch { real = abs; }   // 文件不存在时按规范化路径判断
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error("path escapes repo root");
    }
    return real;
  }

  return { root, run, resolveInside };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/repo.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/repo.js sidecar/test/repo.test.mjs
git commit -m "feat(sidecar): repo path-safety resolveInside with traversal defense"
```

---

### Task 3: repo.js tree + readFile

**Files:**
- Modify: `sidecar/src/repo.js`
- Test: `sidecar/test/repo.test.mjs`（追加）

- [ ] **Step 1: 在 `sidecar/test/repo.test.mjs` 末尾追加失败测试**

```js
test("tree 列出仓库文件（相对路径，含 js/main.js，排除 node_modules/.git）", async () => {
  const svc = createRepoService(REPO_ROOT);
  const files = await svc.tree();
  assert.ok(files.includes("js/main.js"));
  assert.ok(files.includes("README.md"));
  assert.ok(!files.some(f => f.startsWith("node_modules/") || f.startsWith(".git/")));
  assert.ok(files.length <= 400);
});

test("readFile 读到内容并按上限截断", async () => {
  const svc = createRepoService(REPO_ROOT);
  const r = await svc.readFile("README.md");
  assert.match(r.text, /画像办公室|123/);
  assert.equal(r.truncated, false);
  const small = await svc.readFile("README.md", 50);
  assert.equal(small.text.length, 50);
  assert.equal(small.truncated, true);
});

test("readFile 对越界路径抛错", async () => {
  const svc = createRepoService(REPO_ROOT);
  await assert.rejects(() => svc.readFile("../../etc/passwd"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/repo.test.mjs`
Expected: FAIL（`svc.tree is not a function`）

- [ ] **Step 3: 在 `repo.js` 的 `return` 之前加入 tree / readFile，并挂到返回对象**

把 `return { root, run, resolveInside };` 替换为：

```js
  // 文件清单：用 ripgrep --files（自动遵守 .gitignore、跳过 node_modules/.git），相对路径
  async function tree(maxFiles = 400) {
    let out;
    try { out = await run("rg", ["--files"], root); }
    catch (e) { if (e.code === 1) return []; throw e; }
    return out.split("\n").map(s => s.trim()).filter(Boolean).slice(0, maxFiles);
  }

  // 读单文件：白名单校验 + 截断
  async function readFile(rel, maxBytes = 20000) {
    const abs = resolveInside(rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error("not a file");
    const full = readFileSync(abs, "utf8");
    const truncated = full.length > maxBytes;
    return { path: rel, text: truncated ? full.slice(0, maxBytes) : full, truncated, bytes: st.size };
  }

  return { root, run, resolveInside, tree, readFile };
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/repo.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/repo.js sidecar/test/repo.test.mjs
git commit -m "feat(sidecar): repo tree and readFile with truncation"
```

---

### Task 4: repo.js grep + log

**Files:**
- Modify: `sidecar/src/repo.js`
- Test: `sidecar/test/repo.test.mjs`（追加）

- [ ] **Step 1: 在测试末尾追加失败测试**

```js
test("grep 命中真实代码（buildOffice 在 js/office.js）", async () => {
  const svc = createRepoService(REPO_ROOT);
  const hits = await svc.grep("buildOffice");
  assert.ok(hits.length >= 1);
  assert.ok(hits.some(h => h.file.includes("office.js")));
  assert.ok(hits[0].line > 0 && typeof hits[0].text === "string");
});

test("grep 无命中返回空数组（不抛错）", async () => {
  const svc = createRepoService(REPO_ROOT);
  const hits = await svc.grep("zzz_no_such_token_xyzzy_123");
  assert.deepEqual(hits, []);
});

test("grep 解析注入式 run（不依赖真实 rg）", async () => {
  const fakeRun = async () => "js/a.js:12:const x = 1\njs/b.js:3:foo()";
  const svc = createRepoService(REPO_ROOT, { run: fakeRun });
  const hits = await svc.grep("x", 40);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { file: "js/a.js", line: 12, text: "const x = 1" });
});

test("log 返回最近提交（hash + subject）", async () => {
  const svc = createRepoService(REPO_ROOT);
  const commits = await svc.log(3);
  assert.equal(commits.length, 3);
  assert.match(commits[0].hash, /^[0-9a-f]{6,}$/);
  assert.ok(commits[0].subject.length > 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/repo.test.mjs`
Expected: FAIL（`svc.grep is not a function`）

- [ ] **Step 3: 在 `repo.js` 加入 grep / log，并挂到返回对象**

在 `readFile` 之后、`return` 之前加入：

```js
  // 全文检索：ripgrep，返回 [{file,line,text}]，结果数封顶
  async function grep(query, max = 40) {
    const q = String(query || "").trim();
    if (!q) return [];
    let out;
    try { out = await run("rg", ["-n", "--no-heading", "-S", "--", q], root); }
    catch (e) { if (e.code === 1) return []; throw e; }   // rg 退出码 1 = 无命中
    return out.split("\n").filter(Boolean).slice(0, max).map(parseGrepLine).filter(Boolean);
  }

  // git 最近 n 条提交：hash / author / subject
  async function log(n = 10) {
    const count = Math.max(1, Math.min(50, Number(n) || 10));
    let out;
    try { out = await run("git", ["-C", root, "log", "-n", String(count), "--pretty=%h\x1f%an\x1f%s"], root); }
    catch (e) { if (e.code === 128) return []; throw e; }   // 128 = 非 git 仓库
    return out.split("\n").filter(Boolean).map(l => {
      const [hash, author, subject] = l.split("\x1f");
      return { hash, author, subject };
    });
  }
```

并在文件末尾（`createRepoService` 函数外）加入解析辅助：

```js
function parseGrepLine(line) {
  // 格式：file:line:text （text 内可能含冒号，只切前两个）
  const first = line.indexOf(":");
  const second = line.indexOf(":", first + 1);
  if (first < 0 || second < 0) return null;
  const file = line.slice(0, first);
  const ln = Number(line.slice(first + 1, second));
  const text = line.slice(second + 1);
  if (!Number.isFinite(ln)) return null;
  return { file, line: ln, text };
}
```

把 `return { root, run, resolveInside, tree, readFile };` 改为：

```js
  return { root, run, resolveInside, tree, readFile, grep, log };
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/repo.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/repo.js sidecar/test/repo.test.mjs
git commit -m "feat(sidecar): repo grep (ripgrep) and git log"
```

---

### Task 5: analysis.js 静态分析

**Files:**
- Create: `sidecar/src/analysis.js`
- Test: `sidecar/test/analysis.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/analysis.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRepoService } from "../src/repo.js";
import { analyzeRepo } from "../src/analysis.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("analyzeRepo 统计文件数、TODO 数、复杂度热点", async () => {
  const svc = createRepoService(REPO_ROOT);
  const a = await analyzeRepo(svc);
  assert.ok(a.fileCount > 5);
  assert.ok(typeof a.todoCount === "number" && a.todoCount >= 0);
  assert.ok(Array.isArray(a.hotFiles));
  if (a.hotFiles.length) {
    assert.ok(a.hotFiles[0].path && a.hotFiles[0].lines > 0);
    // 热点按行数降序
    for (let i = 1; i < a.hotFiles.length; i++) {
      assert.ok(a.hotFiles[i - 1].lines >= a.hotFiles[i].lines);
    }
  }
});

test("analyzeRepo TODO 计数用注入 run 验证解析", async () => {
  const fakeSvc = {
    tree: async () => ["js/a.js", "js/b.js"],
    readFile: async () => ({ text: "x" }),
    run: async (cmd, args) => {
      if (args.includes("--files")) return "js/a.js\njs/b.js";
      if (args.includes("-c")) return "js/a.js:2\njs/b.js:1";   // rg -c：每文件命中数
      return "";
    },
    root: "/x"
  };
  const a = await analyzeRepo(fakeSvc);
  assert.equal(a.todoCount, 3);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/analysis.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/analysis.js`**

```js
// 静态分析：文件数、TODO/FIXME 数、按行数排序的复杂度热点文件。
// 只读：用 ripgrep 统计，不安装依赖、不执行仓库脚本。

const SRC_EXT = /\.(js|mjs|ts|tsx|jsx|py|go|java|rs|c|cpp|h|css|html|vue)$/;

export async function analyzeRepo(repo, { hotN = 8 } = {}) {
  const files = await repo.tree(2000);
  const srcFiles = files.filter(f => SRC_EXT.test(f));

  // TODO / FIXME 计数：rg -c 输出每文件命中数 "file:count"
  let todoCount = 0;
  try {
    const out = await repo.run("rg", ["-c", "-i", "--", "TODO|FIXME|HACK|XXX", repo.root], repo.root);
    for (const line of String(out).split("\n").filter(Boolean)) {
      const n = Number(line.slice(line.lastIndexOf(":") + 1));
      if (Number.isFinite(n)) todoCount += n;
    }
  } catch (e) {
    if (e.code !== 1) todoCount = 0;   // 退出码 1 = 无命中
  }

  // 复杂度热点：按行数排序的最大源文件（行数是粗略的复杂度代理）
  const counted = [];
  for (const f of srcFiles.slice(0, 800)) {
    try {
      const { text } = await repo.readFile(f, 200000);
      counted.push({ path: f, lines: text.split("\n").length });
    } catch {}
  }
  counted.sort((a, b) => b.lines - a.lines);

  return {
    fileCount: files.length,
    srcFileCount: srcFiles.length,
    todoCount,
    hotFiles: counted.slice(0, hotN),
    at: null   // 时间戳由调用方在落地时补（脚本环境不取系统时间）
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/analysis.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/analysis.js sidecar/test/analysis.test.mjs
git commit -m "feat(sidecar): static analysis (file/TODO counts, complexity hotspots)"
```

---

### Task 6: digest.js 每日仓库摘要

**Files:**
- Create: `sidecar/src/digest.js`
- Test: `sidecar/test/digest.test.mjs`

- [ ] **Step 1: 写失败测试 `sidecar/test/digest.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRepoService } from "../src/repo.js";
import { repoDigest } from "../src/digest.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("repoDigest 汇总最近提交 + TODO + 热点，输出非空文本", async () => {
  const svc = createRepoService(REPO_ROOT);
  const text = await repoDigest(svc, { maxCommits: 5 });
  assert.ok(typeof text === "string" && text.length > 0);
  assert.match(text, /最近提交|提交/);
});

test("repoDigest 用注入 run 验证组装（不依赖真实仓库）", async () => {
  const fakeSvc = {
    root: "/x",
    log: async () => [{ hash: "abc123", author: "我", subject: "加了直链限速逻辑" }],
    tree: async () => ["js/a.js"],
    readFile: async () => ({ text: "line\nline" }),
    run: async (cmd, args) => (args.includes("-c") ? "js/a.js:1" : "js/a.js")
  };
  const text = await repoDigest(fakeSvc, { maxCommits: 5 });
  assert.match(text, /加了直链限速逻辑/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/digest.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sidecar/src/digest.js`**

```js
// 每日仓库动态摘要：最近提交 + 待办热点 + 大文件。给 Agent 当作"今天代码侧发生了什么"的素材。
import { analyzeRepo } from "./analysis.js";

export async function repoDigest(repo, { maxCommits = 10 } = {}) {
  const [commits, analysis] = await Promise.all([
    repo.log(maxCommits).catch(() => []),
    analyzeRepo(repo).catch(() => null)
  ]);

  const lines = [];
  lines.push(`最近提交（${commits.length} 条）：`);
  for (const c of commits) lines.push(`  - ${c.hash} ${c.subject}`);
  if (analysis) {
    lines.push(`代码规模：${analysis.fileCount} 个文件，源码 ${analysis.srcFileCount} 个；待办标记 ${analysis.todoCount} 处。`);
    if (analysis.hotFiles.length) {
      lines.push(`体量最大的文件：${analysis.hotFiles.slice(0, 3).map(f => `${f.path}(${f.lines}行)`).join("、")}`);
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/digest.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/digest.js sidecar/test/digest.test.mjs
git commit -m "feat(sidecar): daily repo digest (commits + analysis)"
```

---

### Task 7: server.js 路由 /api/repo/* + /api/analysis + health

**Files:**
- Modify: `sidecar/src/server.js`
- Test: `sidecar/test/server.test.mjs`（追加）

- [ ] **Step 1: 在 `sidecar/test/server.test.mjs` 追加失败测试**

先看文件顶部的 `startTestServer`：它构造 `buildApp({ eventStore, policyStore, status })`。本任务给 `buildApp` 增加可选的 `repo` 与 `analysisProvider` 入参。在 `startTestServer` 之后、第一个 `test(...)` 之前，新增一个带 repo 的启动器，并追加测试：

```js
import { createRepoService } from "../src/repo.js";
import { repoDigest } from "../src/digest.js";
import { analyzeRepo } from "../src/analysis.js";
import { fileURLToPath as _f } from "node:url";
import { dirname as _d, join as _j } from "node:path";
const REPO_ROOT = _j(_d(_f(import.meta.url)), "..", "..");

function startRepoServer() {
  const db = openDb(":memory:");
  const eventStore = new EventStore(db);
  const policyStore = new PolicyStore(db);
  const repo = createRepoService(REPO_ROOT);
  const status = { collectors: { rss: { enabled: false, lastRun: null, lastResult: null, reason: "test" } },
                   repo: { enabled: true, path: REPO_ROOT } };
  const app = buildApp({ eventStore, policyStore, status, repo,
    analysisProvider: () => analyzeRepo(repo),
    digestProvider: () => repoDigest(repo, { maxCommits: 5 }) });
  const server = app.listen(0, "127.0.0.1");
  return new Promise(r => server.once("listening", () => r({ server, base: () => `http://127.0.0.1:${server.address().port}` })));
}

test("repo 端点：tree / file / grep / log / analysis / digest", async () => {
  const { server, base } = await startRepoServer();
  after(() => server.close());

  const tree = await (await fetch(`${base()}/api/repo/tree`)).json();
  assert.ok(tree.files.includes("js/main.js"));

  const file = await (await fetch(`${base()}/api/repo/file?path=README.md`)).json();
  assert.match(file.text, /画像办公室|123/);

  const grep = await (await fetch(`${base()}/api/repo/grep?q=buildOffice`)).json();
  assert.ok(grep.hits.some(h => h.file.includes("office.js")));

  const log = await (await fetch(`${base()}/api/repo/log?n=3`)).json();
  assert.equal(log.commits.length, 3);

  const analysis = await (await fetch(`${base()}/api/analysis`)).json();
  assert.ok(analysis.fileCount > 5);

  const digest = await (await fetch(`${base()}/api/repo/digest`)).json();
  assert.ok(digest.text.length > 0);

  // 路径逃逸防御
  const escaped = await fetch(`${base()}/api/repo/file?path=../../etc/passwd`);
  assert.equal(escaped.status, 400);
});

test("未配置 repo 时端点返回 503", async () => {
  const { server, base } = startTestServer();   // 无 repo
  after(() => server.close());
  const res = await fetch(`${base()}/api/repo/tree`);
  assert.equal(res.status, 503);
});
```

注意：`startTestServer()` 现有实现是同步返回 `{ server, base, ... }`，而 `startRepoServer` 用了 await listening。两者并存即可，保持 `startTestServer` 原样不动。

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/server.test.mjs`
Expected: FAIL（repo 路由不存在 → tree 请求 404，断言失败）

- [ ] **Step 3: 修改 `buildApp` 签名与路由**

把 `export function buildApp({ eventStore, policyStore, status }) {` 改为：

```js
export function buildApp({ eventStore, policyStore, status, repo = null, analysisProvider = null, digestProvider = null }) {
```

在 `app.use(express.static(...))` 之前（即所有 `/api/*` 路由之后、静态托管之前）插入 repo 路由：

```js
  // ---------- 代码仓库（只读，需配置 repoPath）----------
  const repoGuard = (req, res, next) => {
    if (!repo) return res.status(503).json({ error: "repo 未配置（在 config.json 设置 repoPath）" });
    next();
  };

  app.get("/api/repo/tree", repoGuard, async (req, res) => {
    try { res.json({ files: await repo.tree() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/repo/file", repoGuard, async (req, res) => {
    try { res.json(await repo.readFile(String(req.query.path || ""))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/repo/grep", repoGuard, async (req, res) => {
    try { res.json({ hits: await repo.grep(String(req.query.q || "")) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/repo/log", repoGuard, async (req, res) => {
    try { res.json({ commits: await repo.log(Number(req.query.n) || 10) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/repo/digest", repoGuard, async (req, res) => {
    try { res.json({ text: digestProvider ? await digestProvider() : "" }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/analysis", repoGuard, async (req, res) => {
    try { res.json(analysisProvider ? await analysisProvider() : {}); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang/sidecar && node --test test/server.test.mjs`
Expected: PASS（含原有 + 2 个新测试）

- [ ] **Step 5: 在直接运行分支接入真实 repo（`if (process.argv[1] === ...)` 块内）**

在该块里 `const llm = new SidecarLLM();` 之后加入 repo 装配，并把 `status` 与 `buildApp` 调用改为带 repo：

```js
  let repo = null;
  let repoReason = "未配置 repoPath（见 config.example.json）";
  if (cfg.repoPath) {
    try {
      const { createRepoService } = await import("./repo.js");
      repo = createRepoService(cfg.repoPath);
      repoReason = null;
    } catch (e) {
      repoReason = `repoPath 无效：${e.message}`;
    }
  }
```

把该块里的 `const status = {...}` 改为加上 repo 状态：

```js
  const status = {
    collectors: { rss: { enabled: !rssReason, lastRun: null, lastResult: null, reason: rssReason } },
    repo: { enabled: !!repo, path: cfg.repoPath || "", reason: repoReason }
  };
```

把 `const app = buildApp({ eventStore, policyStore, status });` 改为：

```js
  const { analyzeRepo } = await import("./analysis.js");
  const { repoDigest } = await import("./digest.js");
  const app = buildApp({
    eventStore, policyStore, status, repo,
    analysisProvider: repo ? () => analyzeRepo(repo) : null,
    digestProvider: repo ? () => repoDigest(repo, { maxCommits: cfg.repoDigestMaxCommits }) : null
  });
```

启动日志后追加一行（在 `if (rssReason) ...` 之后）：

```js
    if (repoReason) console.log(`ℹ️ 代码仓库未挂载：${repoReason}`);
    else console.log(`📂 已挂载只读代码仓库：${cfg.repoPath}`);
```

注意：`/api/health` 已经返回 `status.collectors`；本步顺带让它带上 repo 状态——把 health 路由的 `res.json({ ok: true, today: ..., collectors: status.collectors });` 改为 `res.json({ ok: true, today: eventStore.todayCount(), collectors: status.collectors, repo: status.repo });`。

- [ ] **Step 6: 手动冒烟（用 huaxiang 仓库自身当被挂载产品）**

```bash
cd /Users/silas/huaxiang/sidecar
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.repoPath='..';fs.writeFileSync('config.json',JSON.stringify(c,null,2))"
lsof -ti :7878 | xargs kill 2>/dev/null
npm start & sleep 2
curl -s "http://127.0.0.1:7878/api/repo/grep?q=buildOffice" | head -c 200; echo
curl -s "http://127.0.0.1:7878/api/analysis" | head -c 200; echo
curl -s -o /dev/null -w "escape:%{http_code}\n" "http://127.0.0.1:7878/api/repo/file?path=../../../etc/passwd"
kill %1
```
Expected: grep 命中 office.js；analysis 返回 fileCount；逃逸请求返回 400。

- [ ] **Step 7: Commit**

```bash
cd /Users/silas/huaxiang
git add sidecar/src/server.js sidecar/test/server.test.mjs
git commit -m "feat(sidecar): repo/analysis/digest http endpoints with traversal guard"
```

---

### Task 8: README 补充 repoPath 用法

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 README「方式三：本地 sidecar」段落末尾追加一句**

````markdown
> 想让团队讨论你的真实代码：在 `sidecar/config.json` 里把 `repoPath` 设为你的项目目录（绝对路径或相对 sidecar 的路径，只读挂载）。sidecar 会暴露代码检索与每日仓库摘要，供后续版本的会议讨论使用。
````

- [ ] **Step 2: 全量回归**

```bash
cd /Users/silas/huaxiang/sidecar && node --test
cd /Users/silas/huaxiang && node test-board.mjs && node test-feed.mjs && node test-world.mjs && node test-sim.mjs && node test-agent.mjs
```
Expected: sidecar 全绿（原 28 + 新增 repo/analysis/digest/server ≈ 41）；前端 5 脚本全绿。

- [ ] **Step 3: 还原冒烟时写入的 config.json（避免把本机路径留在工作区）**

```bash
cd /Users/silas/huaxiang/sidecar
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.repoPath='';fs.writeFileSync('config.json',JSON.stringify(c,null,2))"
```
（`config.json` 已被 .gitignore 忽略，不会进仓库；此步只是清理本机运行态。）

- [ ] **Step 4: Commit**

```bash
cd /Users/silas/huaxiang
git add README.md
git commit -m "docs: repoPath usage for code sandbox"
```

---

## 验收清单（对照 spec P2 中本子计划覆盖的部分）

- [x] 仓库只读端点 tree / file / grep / log（Task 3, 4, 7）
- [x] 每日仓库摘要 /api/repo/digest（Task 6, 7）
- [x] 静态分析 /api/analysis（文件数 / TODO / 复杂度热点）（Task 5, 7）
- [x] 安全：realpath 白名单防 `../` 与符号链接逃逸、execFile 无 shell、只读不执行仓库脚本（Task 2, 全程）
- [x] 仅 127.0.0.1（沿用 P1 server 绑定，未改动）
- 本子计划不含（留给后续 P2 子计划）：embedding 检索升级（P2b）、会议 tool-use + 真实指标接入世界模型（P2c）、web search / 竞品 diff 采集器（P2d）
