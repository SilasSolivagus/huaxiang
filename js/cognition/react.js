// 突发反应纯函数：反应解析 + 相关度 top-k（embedding 余弦优先、bigram 兜底）。

const ACTIONS = new Set(["goto_colleague", "call_meeting", "investigate_repo", "none"]);

function strip(raw) {
  return String(raw).replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
}

/** 解析模型反应输出 → {utterance, action}。非 JSON 时整段当一句话、action=none。 */
export function parseReaction(raw) {
  let o = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(strip(raw)); }
    catch { return { utterance: String(raw).trim().slice(0, 40), action: "none" }; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { utterance: "", action: "none" };
  return {
    utterance: String(o.utterance || "").trim().slice(0, 40),
    action: ACTIONS.has(o.action) ? o.action : "none"
  };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 返回 vecs 里与 query 余弦最相似的 k 个的索引（降序）。 */
export function cosineTopK(query, vecs, k) {
  return vecs
    .map((v, i) => [i, cosine(query, v)])
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(s => s[0]);
}

function bigrams(s) {
  const out = new Set();
  const t = String(s || "").replace(/[^一-龥a-zA-Z0-9]/g, "");
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 返回 texts 里与 queryText 二元组重叠最多的 k 个的索引（降序）。embedding 不可用时的兜底。 */
export function bigramTopK(queryText, texts, k) {
  const q = bigrams(queryText);
  return texts
    .map((t, i) => {
      const tb = bigrams(t);
      let overlap = 0;
      for (const g of tb) if (q.has(g)) overlap++;
      return [i, overlap];
    })
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(s => s[0]);
}
