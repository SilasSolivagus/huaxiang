// 多轮对话纯函数：解析每轮发言者输出的 {utterance, done}。

function strip(raw) {
  return String(raw).replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
}

function dequote(s) {
  return String(s).trim().replace(/^["「『]|["」』]$/g, "").slice(0, 60);
}

/** 解析一轮发言模型输出 → {utterance, done}。非 JSON 时整段当一句话、done=false。 */
export function parseTurn(raw) {
  let o = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(strip(raw)); }
    catch { return { utterance: dequote(raw), done: false }; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { utterance: "", done: false };
  return { utterance: dequote(o.utterance || ""), done: !!o.done };
}
