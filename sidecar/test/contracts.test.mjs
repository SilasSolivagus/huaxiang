import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, urlHash } from "../src/contracts.js";

test("normalizeEvent 补全默认值并生成 id", () => {
  const ev = normalizeEvent({ source: "rss", title: "夸克网盘上线校园活动" });
  assert.match(ev.id, /^evt_/);
  assert.equal(ev.kind, "market");
  assert.equal(ev.summary, "夸克网盘上线校园活动"); // 缺 summary 用 title 顶
  assert.equal(ev.relevance, 5);
  assert.equal(ev.consumed, false);
  assert.ok(ev.ts > 0);
});

test("normalizeEvent 拒绝空标题和非法 source", () => {
  assert.throws(() => normalizeEvent({ source: "rss", title: "" }));
  assert.throws(() => normalizeEvent({ source: "weibo", title: "x" }));
  assert.throws(() => normalizeEvent(null));
});

test("normalizeEvent 把 relevance 钳制在 0~10", () => {
  assert.equal(normalizeEvent({ source: "manual", title: "x", relevance: 99 }).relevance, 10);
  assert.equal(normalizeEvent({ source: "manual", title: "x", relevance: -3 }).relevance, 0);
  assert.equal(normalizeEvent({ source: "manual", title: "x", relevance: "abc" }).relevance, 5);
  assert.equal(normalizeEvent({ source: "manual", title: "x", relevance: 0 }).relevance, 0);
});

test("显式传入的 ts 被保留（包括 0），缺省才用当前时间", () => {
  assert.equal(normalizeEvent({ source: "manual", title: "x", ts: 0 }).ts, 0);
  assert.equal(normalizeEvent({ source: "manual", title: "x", ts: 12345 }).ts, 12345);
  assert.ok(normalizeEvent({ source: "manual", title: "x" }).ts > 1000000000000);
});

test("urlHash 稳定且区分大小写敏感的不同 URL", () => {
  assert.equal(urlHash("https://a.com/1"), urlHash("https://a.com/1"));
  assert.notEqual(urlHash("https://a.com/1"), urlHash("https://a.com/2"));
});

import { normalizeArtifact } from "../src/contracts.js";

test("normalizeArtifact 补全默认值并生成 id", () => {
  const a = normalizeArtifact({ type: "minutes", content: "今天决定上线限速优化" });
  assert.match(a.id, /^art_/);
  assert.equal(a.type, "minutes");
  assert.equal(a.day, 0);
  assert.equal(a.content, "今天决定上线限速优化");
  assert.equal(a.meta, null);
  assert.ok(a.ts > 1000000000000);
});

test("normalizeArtifact 拒绝空类型和空正文", () => {
  assert.throws(() => normalizeArtifact({ type: "", content: "x" }));
  assert.throws(() => normalizeArtifact({ type: "minutes", content: "  " }));
  assert.throws(() => normalizeArtifact(null));
});

test("normalizeArtifact 保留 day / meta，截断超长正文与类型", () => {
  const a = normalizeArtifact({ type: "minutes", day: 5, content: "决议X", meta: { zone: "rd", decisions: ["a"] } });
  assert.equal(a.day, 5);
  assert.deepEqual(a.meta, { zone: "rd", decisions: ["a"] });
  const long = normalizeArtifact({ type: "x".repeat(80), content: "y".repeat(5000) });
  assert.equal(long.type.length, 40);
  assert.equal(long.content.length, 4000);
  // 非对象 meta 归一化为 null
  assert.equal(normalizeArtifact({ type: "t", content: "c", meta: "oops" }).meta, null);
});
