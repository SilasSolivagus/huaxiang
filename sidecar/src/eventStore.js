// 事件总线的存储层：入库（含订阅推送）、URL 去重、未消费查询、消费确认。
import { normalizeEvent, urlHash } from "./contracts.js";

export class EventStore {
  constructor(db) {
    this.db = db;
    this.subs = new Set();
  }

  add(raw) {
    const ev = normalizeEvent(raw);
    this.db.prepare(
      `INSERT INTO events(id, ts, source, kind, title, summary, url, relevance, suggested_impact, consumed)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      ev.id, ev.ts, ev.source, ev.kind, ev.title, ev.summary, ev.url, ev.relevance,
      ev.suggestedImpact ? JSON.stringify(ev.suggestedImpact) : null
    );
    for (const fn of this.subs) fn(ev);
    return ev;
  }

  listUnconsumed() {
    return this.db
      .prepare("SELECT * FROM events WHERE consumed = 0 ORDER BY ts")
      .all()
      .map(rowToEvent);
  }

  ack(ids) {
    const stmt = this.db.prepare("UPDATE events SET consumed = 1 WHERE id = ?");
    let n = 0;
    for (const id of ids) n += stmt.run(String(id)).changes;
    return n;
  }

  filterUnseen(urls) {
    const stmt = this.db.prepare("SELECT 1 AS x FROM seen_urls WHERE hash = ?");
    return urls.filter(u => !stmt.get(urlHash(u)));
  }

  markSeen(urls) {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO seen_urls(hash, ts) VALUES(?, ?)");
    for (const u of urls) stmt.run(urlHash(u), Date.now());
  }

  todayCount() {
    return this.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE ts >= ?")
      .get(Date.now() - 86400000).c;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

function rowToEvent(r) {
  return {
    id: r.id, ts: r.ts, source: r.source, kind: r.kind,
    title: r.title, summary: r.summary, url: r.url, relevance: r.relevance,
    suggestedImpact: r.suggested_impact ? JSON.parse(r.suggested_impact) : null,
    consumed: !!r.consumed
  };
}
