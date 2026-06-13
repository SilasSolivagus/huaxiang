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
