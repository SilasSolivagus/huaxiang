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
  const b = s.save("https://x.com", "内容 B");
  assert.notEqual(a, b);
  assert.equal(s.lastHash("https://x.com"), b);
  const c = s.save("https://y.com", "内容 A");
  assert.equal(a, c);
});
