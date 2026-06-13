import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { ArtifactStore } from "../src/artifactStore.js";

function freshStore() {
  return new ArtifactStore(openDb(":memory:"));
}

test("add 落库并回填归一化结果", () => {
  const s = freshStore();
  const a = s.add({ type: "minutes", day: 3, content: "决议：上线限速", meta: { zone: "rd" } });
  assert.match(a.id, /^art_/);
  assert.equal(a.day, 3);
  assert.deepEqual(a.meta, { zone: "rd" });
});

test("list 默认按 ts 倒序，可按 type / day 过滤", () => {
  const s = freshStore();
  s.add({ type: "minutes", day: 1, content: "一", ts: 100 });
  s.add({ type: "minutes", day: 2, content: "二", ts: 200 });
  s.add({ type: "report", day: 2, content: "三", ts: 300 });

  const all = s.list();
  assert.equal(all.length, 3);
  assert.equal(all[0].content, "三");   // ts 最大在前

  const minutes = s.list({ type: "minutes" });
  assert.equal(minutes.length, 2);
  assert.ok(minutes.every(a => a.type === "minutes"));

  const day2 = s.list({ day: 2 });
  assert.equal(day2.length, 2);
  assert.ok(day2.every(a => a.day === 2));

  const both = s.list({ type: "minutes", day: 2 });
  assert.equal(both.length, 1);
  assert.equal(both[0].content, "二");
});

test("list 尊重 limit", () => {
  const s = freshStore();
  for (let i = 0; i < 5; i++) s.add({ type: "minutes", content: "c" + i, ts: i });
  assert.equal(s.list({ limit: 2 }).length, 2);
});

test("add 非法输入抛错", () => {
  const s = freshStore();
  assert.throws(() => s.add({ type: "", content: "x" }));
});
