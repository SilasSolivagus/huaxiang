import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { runRssOnce } from "../src/collectors/rss.js";

const FIXTURE_ITEMS = [
  { title: "百度网盘非会员限速又上热搜", link: "https://news.test/1", contentSnippet: "网友吐槽下载速度" },
  { title: "某市今日多云转晴", link: "https://news.test/2", contentSnippet: "气温 25 度" }
];

function stubParser(itemsByUrl) {
  return { parseURL: async url => {
    if (itemsByUrl[url] instanceof Error) throw itemsByUrl[url];
    return { items: itemsByUrl[url] || [] };
  } };
}

function stubLLM(scores) {
  return { enabled: true, scoreBatch: async items => items.map((it, i) => scores[i] ?? null) };
}

test("打分过阈值的入库，低于阈值的丢弃，URL 标记为已见", async () => {
  const store = new EventStore(openDb(":memory:"));
  const r = await runRssOnce({
    feeds: ["https://feed.test/rss"],
    parser: stubParser({ "https://feed.test/rss": FIXTURE_ITEMS }),
    llm: stubLLM([
      { relevance: 9, summary: "限速话题发酵，利好不限速产品", suggestedImpact: { dau: "+2%" } },
      { relevance: 1, summary: "天气新闻，无关" }
    ]),
    store, companyBrief: "123云盘", threshold: 6, log: () => {}
  });
  assert.equal(r.fetched, 2);
  assert.equal(r.inserted, 1);
  const evs = store.listUnconsumed();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].source, "rss");
  assert.equal(evs[0].summary, "限速话题发酵，利好不限速产品");
  assert.equal(evs[0].url, "https://news.test/1");
});

test("第二轮同样的条目全部去重，不再调用 LLM", async () => {
  const store = new EventStore(openDb(":memory:"));
  let llmCalls = 0;
  const llm = { enabled: true, scoreBatch: async items => { llmCalls++; return items.map(() => ({ relevance: 9, summary: "s" })); } };
  const deps = {
    feeds: ["https://feed.test/rss"],
    parser: stubParser({ "https://feed.test/rss": FIXTURE_ITEMS }),
    llm, store, companyBrief: "c", threshold: 6, log: () => {}
  };
  await runRssOnce(deps);
  const r2 = await runRssOnce(deps);
  assert.equal(llmCalls, 1);
  assert.equal(r2.inserted, 0);
});

test("单个源拉取失败不影响其他源", async () => {
  const store = new EventStore(openDb(":memory:"));
  const r = await runRssOnce({
    feeds: ["https://bad.test/rss", "https://good.test/rss"],
    parser: stubParser({
      "https://bad.test/rss": new Error("ECONNREFUSED"),
      "https://good.test/rss": [FIXTURE_ITEMS[0]]
    }),
    llm: stubLLM([{ relevance: 8, summary: "s" }]),
    store, companyBrief: "c", threshold: 6, log: () => {}
  });
  assert.equal(r.inserted, 1);
});

test("LLM 整体失败（返回 null）时本轮放弃但不抛错", async () => {
  const store = new EventStore(openDb(":memory:"));
  const r = await runRssOnce({
    feeds: ["https://feed.test/rss"],
    parser: stubParser({ "https://feed.test/rss": FIXTURE_ITEMS }),
    llm: { enabled: true, scoreBatch: async () => null },
    store, companyBrief: "c", threshold: 6, log: () => {}
  });
  assert.equal(r.inserted, 0);
});
