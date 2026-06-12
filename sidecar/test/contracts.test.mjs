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
});

test("urlHash 稳定且区分大小写敏感的不同 URL", () => {
  assert.equal(urlHash("https://a.com/1"), urlHash("https://a.com/1"));
  assert.notEqual(urlHash("https://a.com/1"), urlHash("https://a.com/2"));
});
