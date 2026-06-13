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
