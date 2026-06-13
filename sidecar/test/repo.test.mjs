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

test("grep 命中真实代码（buildOffice 在 js/office.js）", async () => {
  const svc = createRepoService(REPO_ROOT);
  const hits = await svc.grep("buildOffice");
  assert.ok(hits.length >= 1);
  assert.ok(hits.some(h => h.file.includes("office.js")));
  assert.ok(hits[0].line > 0 && typeof hits[0].text === "string");
});

test("grep 无命中返回空数组（不抛错）", async () => {
  // 用 fakeRun 模拟 rg 退出码 1（无命中），验证不抛错
  const fakeRun = async () => { const e = new Error("no match"); e.code = 1; throw e; };
  const svc = createRepoService(REPO_ROOT, { run: fakeRun });
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
