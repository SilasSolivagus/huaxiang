// 产出物存储：会议纪要 / 日报 / 市场反馈等结构化产出。照 eventStore/policyStore 模式。
import { normalizeArtifact } from "./contracts.js";

export class ArtifactStore {
  constructor(db) {
    this.db = db;
  }

  add(raw) {
    const a = normalizeArtifact(raw);
    this.db.prepare(
      "INSERT INTO artifacts(id, ts, type, day, content, meta) VALUES(?, ?, ?, ?, ?, ?)"
    ).run(a.id, a.ts, a.type, a.day, a.content, a.meta ? JSON.stringify(a.meta) : null);
    return a;
  }

  list({ type, day, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (type) { where.push("type = ?"); args.push(String(type)); }
    if (day !== undefined && day !== null && day !== "") { where.push("day = ?"); args.push(Number(day)); }
    const sql = `SELECT * FROM artifacts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`;
    args.push(Number(limit) || 50);
    return this.db.prepare(sql).all(...args).map(rowToArtifact);
  }
}

function rowToArtifact(r) {
  return {
    id: r.id, ts: r.ts, type: r.type, day: r.day,
    content: r.content, meta: r.meta ? JSON.parse(r.meta) : null
  };
}
