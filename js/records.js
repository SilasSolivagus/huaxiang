// 记录中心控制器。纯函数（解析/分组/渲染 HTML 串）在上半部分，可在 node 单测；
// 下半部分 initRecords() 是浏览器 DOM 控制器，仅在浏览器自动运行。
// 只读：解析 localStorage，绝不写入；不 import 有副作用的 Board/MemoryStream。

const BOARD_KEY = "huaxiang.board.v1";
const MEM_KEY = "huaxiang.memories.v1";

// ---------- 解析（纯函数：原始字符串 → 结构）----------

export function parseBoard(raw) {
  try { const a = JSON.parse(raw || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

export function parseMemories(raw) {
  try {
    const o = JSON.parse(raw || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

// ---------- 分组（纯函数）----------

export function groupActivityByDay(list) {
  const byDay = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    const d = Number(e?.day) || 0;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ time: e.time || "", text: e.text || "", cls: e.cls || "" });
  }
  return [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, entries]) => ({ day, entries }));
}

export function groupMinutesByDay(artifacts) {
  const byDay = new Map();
  for (const a of Array.isArray(artifacts) ? artifacts : []) {
    const d = Number(a?.day) || 0;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(a);
  }
  return [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, items]) => ({ day, items }));
}

export function collectPersonSummaries(boardDays, personaId) {
  const out = [];
  for (const d of Array.isArray(boardDays) ? boardDays : []) {
    const s = d?.summaries?.[personaId];
    if (s) out.push({ day: d.day, text: s });
  }
  return out.sort((a, b) => b.day - a.day);
}

export function sortMemoriesDesc(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
}
