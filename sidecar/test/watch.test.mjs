import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../src/collectors/watch.js";

test("extractText 去掉脚本/样式/标签，解码实体，压空白", () => {
  const html = `<html><head><style>.a{color:red}</style><script>var x=1</script></head>
    <body><h1>会员价格</h1><p>SVIP&nbsp;年卡 &amp; 月卡<br>限时 5 折</p></body></html>`;
  const t = extractText(html);
  assert.ok(t.includes("会员价格"));
  assert.ok(t.includes("SVIP 年卡 & 月卡"));
  assert.ok(!t.includes("color:red"));
  assert.ok(!t.includes("var x"));
  assert.ok(!t.includes("<"));
});

test("extractText 空/非字符串安全", () => {
  assert.equal(extractText(""), "");
  assert.equal(extractText(null), "");
  assert.equal(extractText(undefined), "");
});

import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { PageStore } from "../src/pageStore.js";
import { runWatchOnce } from "../src/collectors/watch.js";

function makeDeps(pages, scores) {
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const pageStore = new PageStore(db);
  return {
    store, pageStore,
    urls: Object.keys(pages),
    fetchPage: async (url) => {
      if (pages[url] instanceof Error) throw pages[url];
      return pages[url];
    },
    llm: { scoreBatch: async (items) => items.map((_, i) => scores[i] ?? null) },
    companyBrief: "123云盘", threshold: 6, log: () => {}
  };
}

test("首次抓取只存基线，不发事件", async () => {
  const d = makeDeps({ "https://comp.test/vip": "<p>会员价格 10 元</p>" }, [{ relevance: 9, summary: "x" }]);
  const r = await runWatchOnce(d);
  assert.equal(r.checked, 1);
  assert.equal(r.changed, 0);
  assert.equal(r.inserted, 0);
  assert.equal(d.store.listUnconsumed().length, 0);
});

test("页面变化且相关 → 入库为 watch 事件", async () => {
  const d = makeDeps({ "https://comp.test/vip": "<p>会员价格 10 元</p>" }, [{ relevance: 9, summary: "竞品会员降价到 5 元" }]);
  await runWatchOnce(d);
  d.fetchPage = async () => "<p>会员价格 5 元 限时</p>";
  const r = await runWatchOnce(d);
  assert.equal(r.changed, 1);
  assert.equal(r.inserted, 1);
  const evs = d.store.listUnconsumed();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].source, "watch");
  assert.equal(evs[0].summary, "竞品会员降价到 5 元");
  assert.ok(evs[0].url.includes("comp.test"));
});

test("页面未变 → 不发事件；变化但低相关 → 不入库", async () => {
  const d = makeDeps({ "https://comp.test/p": "<p>原内容</p>" }, [{ relevance: 2, summary: "无关紧要" }]);
  await runWatchOnce(d);
  const r1 = await runWatchOnce(d);
  assert.equal(r1.changed, 0);
  assert.equal(r1.inserted, 0);
  d.fetchPage = async () => "<p>变了但不重要</p>";
  const r2 = await runWatchOnce(d);
  assert.equal(r2.changed, 1);
  assert.equal(r2.inserted, 0);
});

test("单页抓取失败不影响其他页", async () => {
  const d = makeDeps({
    "https://bad.test/x": new Error("ETIMEDOUT"),
    "https://ok.test/y": "<p>初始</p>"
  }, [{ relevance: 9, summary: "s" }]);
  await runWatchOnce(d);
  d.fetchPage = async (url) => (url.includes("ok.test") ? "<p>更新了</p>" : (() => { throw new Error("ETIMEDOUT"); })());
  const r = await runWatchOnce(d);
  assert.equal(r.inserted, 1);
});
