import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbedder, cosine } from "../src/embed.js";

test("cosine：相同向量=1，正交=0", () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([0, 0], [1, 1]), 0);   // 零向量安全
});

test("embed：用注入 extractor 批量产出向量", async () => {
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
