// 上层决策（政策）存储：发布、列表、撤销（软删除）。
import { randomUUID } from "node:crypto";

export class PolicyStore {
  constructor(db) {
    this.db = db;
  }

  create(text) {
    const t = String(text || "").trim();
    if (!t) throw new Error("policy text required");
    const p = { id: `pol_${randomUUID().slice(0, 8)}`, text: t.slice(0, 300), issuedTs: Date.now(), active: true };
    this.db.prepare("INSERT INTO policies(id, text, issued_ts, active) VALUES(?, ?, ?, 1)")
      .run(p.id, p.text, p.issuedTs);
    return p;
  }

  list(all = false) {
    const sql = all
      ? "SELECT * FROM policies ORDER BY issued_ts"
      : "SELECT * FROM policies WHERE active = 1 ORDER BY issued_ts";
    return this.db.prepare(sql).all().map(r => ({
      id: r.id, text: r.text, issuedTs: r.issued_ts, active: !!r.active
    }));
  }

  deactivate(id) {
    return this.db.prepare("UPDATE policies SET active = 0 WHERE id = ? AND active = 1")
      .run(String(id)).changes > 0;
  }
}
