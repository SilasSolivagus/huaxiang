import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";

function freshStore() {
  return new EventStore(openDb(":memory:"));
}

test("add 入库后 listUnconsumed 能取到，ack 后取不到", () => {
  const s = freshStore();
  const ev = s.add({ source: "rss", title: "百度网盘限速上热搜", relevance: 8 });
  assert.equal(s.listUnconsumed().length, 1);
  assert.equal(s.listUnconsumed()[0].id, ev.id);
  assert.equal(s.ack([ev.id]), 1);
  assert.equal(s.listUnconsumed().length, 0);
  assert.equal(s.ack(["evt_nonexist"]), 0);
});

test("suggestedImpact 经 JSON 往返保持结构", () => {
  const s = freshStore();
  s.add({ source: "rss", title: "x", suggestedImpact: { sat: -2, dau: "+1%" } });
  assert.deepEqual(s.listUnconsumed()[0].suggestedImpact, { sat: -2, dau: "+1%" });
});

test("markSeen + filterUnseen 实现 URL 去重", () => {
  const s = freshStore();
  const urls = ["https://a.com/1", "https://a.com/2"];
  assert.deepEqual(s.filterUnseen(urls), urls);
  s.markSeen(["https://a.com/1"]);
  assert.deepEqual(s.filterUnseen(urls), ["https://a.com/2"]);
  s.markSeen(["https://a.com/1"]); // 重复标记不报错
});

test("subscribe 在 add 时收到归一化后的事件，退订后不再收到", () => {
  const s = freshStore();
  const got = [];
  const unsub = s.subscribe(ev => got.push(ev));
  s.add({ source: "manual", title: "测试事件" });
  assert.equal(got.length, 1);
  assert.match(got[0].id, /^evt_/);
  unsub();
  s.add({ source: "manual", title: "再来一条" });
  assert.equal(got.length, 1);
});

test("todayCount 只统计近 24 小时", () => {
  const s = freshStore();
  s.add({ source: "manual", title: "新的" });
  s.add({ source: "manual", title: "旧的", ts: Date.now() - 2 * 86400000 });
  assert.equal(s.todayCount(), 1);
});
