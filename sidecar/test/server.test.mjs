import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { PolicyStore } from "../src/policyStore.js";
import { buildApp } from "../src/server.js";
import { createRepoService } from "../src/repo.js";
import { repoDigest } from "../src/digest.js";
import { analyzeRepo } from "../src/analysis.js";
import { fileURLToPath as _f } from "node:url";
import { dirname as _d, join as _j } from "node:path";
const REPO_ROOT = _j(_d(_f(import.meta.url)), "..", "..");

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

function startRepoServer() {
  const db = openDb(":memory:");
  const eventStore = new EventStore(db);
  const policyStore = new PolicyStore(db);
  const repo = createRepoService(REPO_ROOT);
  const status = { collectors: { rss: { enabled: false, lastRun: null, lastResult: null, reason: "test" } },
                   repo: { enabled: true, path: REPO_ROOT } };
  const app = buildApp({ eventStore, policyStore, status, repo,
    analysisProvider: () => analyzeRepo(repo),
    digestProvider: () => repoDigest(repo, { maxCommits: 5 }) });
  const server = app.listen(0, "127.0.0.1");
  return new Promise(r => server.once("listening", () => r({ server, base: () => `http://127.0.0.1:${server.address().port}` })));
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

test("静态托管不暴露 .git 与 sidecar 目录", async () => {
  const { server, base } = await startTestServer();
  after(() => server.close());
  assert.equal((await fetch(`${base()}/.git/config`)).status, 403);
  assert.equal((await fetch(`${base()}/sidecar/package.json`)).status, 403);
  assert.equal((await fetch(`${base()}/index.html`)).status, 200); // 正常文件不受影响
  assert.equal((await fetch(`${base()}/%2egit/config`)).status, 403);
  assert.equal((await fetch(`${base()}/%73idecar/package.json`)).status, 403);
  assert.equal((await fetch(`${base()}/sidecar%2fpackage.json`)).status, 403);
});

test("repo 端点：tree / file / grep / log / analysis / digest", async () => {
  const { server, base } = await startRepoServer();
  after(() => server.close());

  const tree = await (await fetch(`${base()}/api/repo/tree`)).json();
  assert.ok(tree.files.includes("js/main.js"));

  const file = await (await fetch(`${base()}/api/repo/file?path=README.md`)).json();
  assert.match(file.text, /画像办公室|123/);

  const grep = await (await fetch(`${base()}/api/repo/grep?q=buildOffice`)).json();
  assert.ok(grep.hits.some(h => h.file.includes("office.js")));

  const log = await (await fetch(`${base()}/api/repo/log?n=3`)).json();
  assert.equal(log.commits.length, 3);

  const analysis = await (await fetch(`${base()}/api/analysis`)).json();
  assert.ok(analysis.fileCount > 5);

  const digest = await (await fetch(`${base()}/api/repo/digest`)).json();
  assert.ok(digest.text.length > 0);

  const escaped = await fetch(`${base()}/api/repo/file?path=../../etc/passwd`);
  assert.equal(escaped.status, 400);
});

test("未配置 repo 时端点返回 503", async () => {
  const { server, base } = await startTestServer();
  after(() => server.close());
  const res = await fetch(`${base()}/api/repo/tree`);
  assert.equal(res.status, 503);
});

import { ArtifactStore } from "../src/artifactStore.js";

test("/api/artifacts：POST 写入、GET 按 type/day 翻阅；未配置返回 503", async () => {
  const db = openDb(":memory:");
  const status = { collectors: { rss: { enabled: false, reason: "test" } } };
  const artifactStore = new ArtifactStore(db);
  const app = buildApp({ eventStore: new EventStore(db), policyStore: new PolicyStore(db), status, artifactStore });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await (await fetch(`${base}/api/artifacts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "minutes", day: 4, content: "决议：上线限速优化", meta: { zone: "rd" } })
  })).json();
  assert.match(created.id, /^art_/);

  const bad = await fetch(`${base}/api/artifacts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "", content: "x" })
  });
  assert.equal(bad.status, 400);

  const list = await (await fetch(`${base}/api/artifacts?type=minutes&day=4`)).json();
  assert.equal(list.artifacts.length, 1);
  assert.equal(list.artifacts[0].content, "决议：上线限速优化");

  const none = await (await fetch(`${base}/api/artifacts?day=99`)).json();
  assert.equal(none.artifacts.length, 0);

  // 未注入 artifactStore 的 app（startTestServer）→ 503
  const { server: s2, base: base2 } = await startTestServer();
  after(() => s2.close());
  assert.equal((await fetch(`${base2()}/api/artifacts`)).status, 503);
});

test("/api/embed：用注入 embedder 返回向量；未配置返回 503", async () => {
  const db = openDb(":memory:");
  const status = { collectors: { rss: { enabled: false, reason: "test" } }, embed: { enabled: true } };
  const fakeEmbedder = { embed: async (texts) => texts.map(t => [t.length, 1]) };
  const app = buildApp({ eventStore: new EventStore(db), policyStore: new PolicyStore(db), status, embedder: fakeEmbedder });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const r = await (await fetch(`${base}/api/embed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts: ["ab", "abcd"] })
  })).json();
  assert.deepEqual(r.vectors, [[2, 1], [4, 1]]);

  const { server: s2, base: base2 } = await startTestServer();
  after(() => s2.close());
  const res = await fetch(`${base2()}/api/embed`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: ["x"] })
  });
  assert.equal(res.status, 503);
});
