// 纯函数：把模型扮演"市场"的输出归一化为 {deltas, reasons, feedback, competitorMove}。
// deltas 钳制防止单日剧烈跳变；失败给 null（调用方回退纯规则漂移）。

function clamp(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
}

function strList(v, max) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || "").trim()).filter(Boolean).map(s => s.slice(0, 80)).slice(0, max);
}

export function normalizeMarketReaction(raw) {
  let o = raw;
  if (typeof raw === "string") {
    const clean = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    try { o = JSON.parse(clean); } catch { return null; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const d = o.deltas && typeof o.deltas === "object" ? o.deltas : {};
  return {
    deltas: {
      dau: Math.round(clamp(d.dau, -200000, 200000)),
      sat: clamp(d.sat, -10, 10),
      bugs: Math.round(clamp(d.bugs, -20, 20)),
      runway: Math.round(clamp(d.runway, -2, 2) * 10) / 10
    },
    reasons: strList(o.reasons, 4),
    feedback: strList(o.feedback, 4),
    competitorMove: o.competitorMove ? String(o.competitorMove).trim().slice(0, 80) : null
  };
}
