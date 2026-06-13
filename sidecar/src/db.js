// SQLite 打开与建表。用 Node 内置 node:sqlite（≥22.5），零原生依赖。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'market',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url TEXT,
  relevance INTEGER NOT NULL DEFAULT 5,
  suggested_impact TEXT,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seen_urls(
  hash TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS policies(
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  issued_ts INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS page_snapshots(
  url_hash TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`;

export function openDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
