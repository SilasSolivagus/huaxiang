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
