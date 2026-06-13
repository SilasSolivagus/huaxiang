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

// ---------- 渲染（纯函数：结构 → HTML 串）----------

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

const BI_CLASS = { "进展": "bi-progress", "决策": "bi-decision", "应对": "bi-response" };

export function renderBoardDay(dayObj, nameOf = {}) {
  const items = (dayObj.items || []).map(it =>
    `<div class="rc-board-item"><span class="bi-tag ${BI_CLASS[it.type] || ""}">${escapeHtml(it.type)}</span>${escapeHtml(it.text)}</div>`
  ).join("");
  const sums = Object.entries(dayObj.summaries || {}).map(([id, text]) =>
    `<div class="rc-summary"><b>${escapeHtml(nameOf[id] || id)}</b>：${escapeHtml(text)}</div>`
  ).join("");
  return `<section class="rc-board-day"><h3>第 ${dayObj.day} 天</h3>` +
    (items || `<div class="rc-empty">这天没有沉淀条目</div>`) +
    (sums ? `<div class="rc-summaries"><h4>个人小结</h4>${sums}</div>` : "") +
    `</section>`;
}

export function renderMinuteCard(a) {
  const meta = a.meta || {};
  const sec = (title, arr) => Array.isArray(arr) && arr.length
    ? `<div class="rc-min-sec"><h4>${title}</h4><ul>${arr.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const actions = Array.isArray(meta.actionItems) && meta.actionItems.length
    ? `<div class="rc-min-sec"><h4>行动项</h4><ul>${meta.actionItems.map(it =>
        `<li>${it.owner ? `<b>${escapeHtml(it.owner)}</b>：` : ""}${escapeHtml(it.what || "")}</li>`).join("")}</ul></div>` : "";
  const body = sec("决议", meta.decisions) + sec("风险", meta.risks) + actions;
  return `<section class="rc-min-card"><div class="rc-min-h">第 ${a.day} 天 · ${escapeHtml(meta.zone || "—")} · ${escapeHtml(meta.phase || "")}</div>` +
    (body || `<div class="rc-min-body">${escapeHtml(a.content || "")}</div>`) + `</section>`;
}

export function renderMemoryItem(m) {
  const cls = m.type === "reflect" ? " rc-mem-reflect" : m.type === "action" ? " rc-mem-action" : "";
  return `<div class="rc-mem${cls}"><span class="rc-mem-time">第${m.day}天 ${escapeHtml(m.time || "")}</span>${escapeHtml(m.c || "")}</div>`;
}
