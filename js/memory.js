// 记忆流（Memory Stream）：参照斯坦福 Generative Agents 的设计。
// 每个 Agent 拥有完全独立的一条记忆流：自己说过的话、在听力范围内听到的话、
// 公司公告、市场事件、每日反思。检索时按 重要度 + 时近性 + 相关性 打分取最相关的几条。
// 持久化在 localStorage，跨天、跨刷新累积。

const MEM_KEY = "huaxiang.memories.v1";
const MAX_ITEMS = 240;

function hasStorage() {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

function loadAll() {
  if (!hasStorage()) return {};
  try {
    return JSON.parse(localStorage.getItem(MEM_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

let saveTimer = null;
const streams = new Map();   // personaId -> MemoryStream（用于统一存盘）

function scheduleSave() {
  if (!hasStorage()) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const all = {};
    for (const [id, s] of streams) all[id] = s.items;
    try {
      localStorage.setItem(MEM_KEY, JSON.stringify(all));
    } catch (e) {
      // 存满了就砍掉每人最旧的一半再试一次
      for (const s of streams.values()) s.items = s.items.slice(-MAX_ITEMS / 2);
      try {
        const trimmed = {};
        for (const [id, s] of streams) trimmed[id] = s.items;
        localStorage.setItem(MEM_KEY, JSON.stringify(trimmed));
      } catch {}
    }
  }, 1500);
}

const DAY_SPAN_MIN = 1440;   // 把"第 N 天 HH:MM"折算成单调递增的模拟分钟数

function simMinutes(day, time) {
  let hm = 0;
  if (typeof time === "string" && time.includes(":")) {
    const [h, m] = time.split(":").map(Number);
    hm = (h || 0) * 60 + (m || 0);
  }
  return (Number(day) || 0) * DAY_SPAN_MIN + hm;
}

/** 中文相关性：统计共享二元组（bigram）数量 */
function bigrams(s) {
  const out = new Set();
  const t = (s || "").replace(/[^一-龥a-zA-Z0-9]/g, "");
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function fmt(s) {
  const m = s.m || s;
  return `（第${m.day}天${m.time ? " " + m.time : ""}）${m.c}`;
}

export class MemoryStream {
  constructor(personaId) {
    this.id = personaId;
    this.items = loadAll()[personaId] || [];
    streams.set(personaId, this);
    this.embedder = null;        // (texts:string[]) => Promise<number[][]|null>
    this._vec = new WeakMap();   // item -> 向量（内存缓存，不持久化）
  }

  /**
   * 写入一条记忆
   * @param {string} content
   * @param {object} opts { importance: 1~10, type, day, time }
   */
  add(content, opts = {}) {
    if (!content) return;
    this.items.push({
      c: String(content).slice(0, 120),
      imp: opts.importance ?? 3,
      type: opts.type || "obs",
      day: opts.day ?? 0,
      time: opts.time || "",
      t: simMinutes(opts.day ?? 0, opts.time || ""),
      at: Date.now()
    });
    if (this.items.length > MAX_ITEMS) {
      // 优先丢弃旧的低重要度记忆
      this.items.sort((a, b) => a.at - b.at);
      const idx = this.items.findIndex(m => m.imp <= 3);
      this.items.splice(idx === -1 ? 0 : idx, 1);
    }
    scheduleSave();
  }

  setEmbedder(fn) { this.embedder = fn; }

  /** 最近 n 条（给 UI 展示） */
  recent(n = 5) {
    return this.items.slice(-n).reverse();
  }

  /**
   * 检索与 query 最相关的 k 条记忆（重要度 + 时近性 + 相关性）。
   * 返回格式化好的字符串数组。注入 embedder 时用余弦语义检索，否则回退 bigram。
   */
  async retrieve(query, k = 6) {
    if (this.items.length === 0) return [];
    const newestT = this.items.reduce((mx, m) => Math.max(mx, m.t ?? 0), 0);
    const recencyOf = m => Math.pow(0.6, (newestT - (m.t ?? 0)) / DAY_SPAN_MIN);
    const cand = this.items.slice(-150);   // 候选：最近 150 条（控 embedding 成本）

    // 尝试语义检索
    if (this.embedder) {
      try {
        const need = cand.filter(m => !this._vec.has(m));
        const toEmbed = [query, ...need.map(m => m.c)];
        const vecs = await this.embedder(toEmbed);
        if (vecs && vecs.length === toEmbed.length) {
          const qv = vecs[0];
          need.forEach((m, i) => this._vec.set(m, vecs[i + 1]));
          const scored = cand.map(m => {
            const rel = cosineSim(qv, this._vec.get(m) || []);   // 0~1
            return { m, score: m.imp * 0.5 + recencyOf(m) * 2 + rel * 5 };
          });
          scored.sort((a, b) => b.score - a.score);
          return scored.slice(0, k).map(fmt);
        }
      } catch (e) {
        // 落空 → 回退 bigram
      }
    }

    // 回退：bigram 字面相关
    const q = bigrams(query);
    const scored = cand.map(m => {
      let rel = 0;
      const mb = bigrams(m.c);
      for (const g of q) if (mb.has(g)) rel++;
      return { m, score: m.imp * 0.7 + recencyOf(m) * 3 + Math.min(rel, 6) * 0.8 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(fmt);
  }

  /** 给每日反思用的原始素材：今天的记忆摘录 */
  todayDigest(day, n = 18) {
    const today = this.items.filter(m => m.day === day);
    return today.slice(-n).map(m => m.c).join("\n");
  }

  static clearAll() {
    streams.clear();
    if (hasStorage()) localStorage.removeItem(MEM_KEY);
  }
}
