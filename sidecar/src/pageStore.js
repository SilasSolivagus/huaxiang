// 竞品页面快照：只存正文哈希用于变化检测（不存全文，省空间）。
import { createHash } from "node:crypto";

function sha(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

export class PageStore {
  constructor(db) {
    this.db = db;
  }

  /** 该 URL 上次存的正文哈希，没有则 null */
  lastHash(url) {
    const r = this.db.prepare("SELECT content_hash FROM page_snapshots WHERE url_hash = ?").get(sha(url));
    return r ? r.content_hash : null;
  }

  /** 存入该 URL 的正文哈希，返回新哈希 */
  save(url, text) {
    const ch = sha(text);
    this.db.prepare("INSERT OR REPLACE INTO page_snapshots(url_hash, content_hash, ts) VALUES(?, ?, ?)")
      .run(sha(url), ch, Date.now());
    return ch;
  }
}
