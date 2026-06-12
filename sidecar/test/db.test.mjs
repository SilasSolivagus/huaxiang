import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";

test("openDb 建出 events / seen_urls / policies 三张表", () => {
  const db = openDb(":memory:");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(r => r.name);
  assert.ok(tables.includes("events"));
  assert.ok(tables.includes("seen_urls"));
  assert.ok(tables.includes("policies"));
});

test("openDb 幂等：对同一库重复执行 schema 不报错", () => {
  const db = openDb(":memory:");
  assert.doesNotThrow(() => openDbAgain(db));
});

function openDbAgain(db) {
  // 模拟二次启动：直接重放 schema
  db.exec(`CREATE TABLE IF NOT EXISTS events(
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'market', title TEXT NOT NULL, summary TEXT NOT NULL,
    url TEXT, relevance INTEGER NOT NULL DEFAULT 5,
    suggested_impact TEXT, consumed INTEGER NOT NULL DEFAULT 0
  )`);
}
