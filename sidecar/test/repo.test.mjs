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
