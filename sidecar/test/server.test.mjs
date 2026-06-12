import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { PolicyStore } from "../src/policyStore.js";
import { buildApp } from "../src/server.js";

async function startTestServer() {
  const db = openDb(":memory:");
  const eventStore = new EventStore(db);
  const policyStore = new PolicyStore(db);
  const status = { collectors: { rss: { enabled: false, lastRun: null, lastResult: null, reason: "test" } } };
  const app = buildApp({ eventStore, policyStore, status });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { server, base, eventStore, policyStore };
}

test("API 集成：health / snapshot / ack / policies", async () => {
  const { server, base, eventStore } = await startTestServer();
  after(() => server.close());

  const health = await (await fetch(`${base()}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.collectors.rss.enabled, false);

  eventStore.add({ source: "rss", title: "事件A", relevance: 7 });

  let snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.events.length, 1);
  assert.deepEqual(snap.policies, []);

  // 政策 CRUD
  const created = await (await fetch(`${base()}/api/policies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "全员降本" })
  })).json();
  assert.match(created.id, /^pol_/);

  const bad = await fetch(`${base()}/api/policies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" })
  });
  assert.equal(bad.status, 400);

  snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.policies.length, 1);

  const del = await (await fetch(`${base()}/api/policies/${created.id}`, { method: "DELETE" })).json();
  assert.equal(del.ok, true);
  snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.policies.length, 0);

  // ack
  const evId = snap.events[0].id;
  const acked = await (await fetch(`${base()}/api/events/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [evId] })
  })).json();
  assert.equal(acked.acked, 1);
  snap = await (await fetch(`${base()}/api/snapshot`)).json();
  assert.equal(snap.events.length, 0);
});

test("SSE 流推送新事件", async () => {
  const { server, base, eventStore } = await startTestServer();
  after(() => server.close());

  const res = await fetch(`${base()}/api/stream`);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  await reader.read(); // 吃掉 :connected 注释行

  eventStore.add({ source: "manual", title: "突发事件" });
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /^data: /m);
  assert.ok(JSON.parse(chunk.replace(/^data: /, "").trim()).title === "突发事件");
  await reader.cancel();
});

test("静态托管仓库根目录（index.html 可访问）", async () => {
  const { server, base } = await startTestServer();
  after(() => server.close());
  const res = await fetch(`${base()}/index.html`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /画像办公室|<canvas|scene/);
});
