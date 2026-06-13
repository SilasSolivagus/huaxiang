// 记录中心控制器。纯函数（解析/分组/渲染 HTML 串）在上半部分，可在 node 单测；
// 下半部分 initRecords() 是浏览器 DOM 控制器，仅在浏览器自动运行。
// 只读：解析 localStorage，绝不写入；不 import 有副作用的 Board/MemoryStream。

import { loadConfig, runtimePersonas } from "./store.js";
import { loadActivity } from "./activityLog.js";

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

// ---------- DOM 控制器（仅浏览器）----------

function readBoard() {
  return parseBoard(typeof localStorage !== "undefined" ? localStorage.getItem(BOARD_KEY) : null);
}
function readMemories() {
  return parseMemories(typeof localStorage !== "undefined" ? localStorage.getItem(MEM_KEY) : null);
}

export function initRecords() {
  const personas = runtimePersonas(loadConfig());
  const nameOf = Object.fromEntries(personas.map(p => [p.id, p.name]));
  const main = document.getElementById("rc-main");
  const sublist = document.getElementById("rc-sublist");
  const sidecarChip = document.getElementById("rc-sidecar");

  const state = { cat: "board", sub: null };
  let online = false;
  let minutes = [];
  let pollTimer = null;

  // sidecar 探测
  fetch("/api/health", { signal: AbortSignal.timeout(2000) })
    .then(r => { online = r.ok; })
    .catch(() => { online = false; })
    .finally(() => {
      sidecarChip.textContent = online ? "📡 数据在线" : "📡 离线";
      sidecarChip.classList.toggle("on", online);
      if (state.cat === "minutes") renderCategory();
    });

  function subBtn(label, key, active, extraHtml = "") {
    return `<button class="rc-sub${active ? " active" : ""}" data-sub="${escapeHtml(key)}">${extraHtml}${escapeHtml(label)}</button>`;
  }

  function renderCategory() {
    stopPoll();
    if (state.cat === "board") return renderBoard();
    if (state.cat === "minutes") return renderMinutes();
    if (state.cat === "people") return renderPeople();
    if (state.cat === "activity") return renderActivity();
  }

  function renderBoard() {
    const days = readBoard().slice().sort((a, b) => b.day - a.day);
    if (!days.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">还没有看板记录，跑过一个工作日后这里会出现。</div>`; return; }
    if (state.sub == null || !days.some(d => String(d.day) === String(state.sub))) state.sub = days[0].day;
    sublist.innerHTML = days.map(d => subBtn(`第 ${d.day} 天`, d.day, String(d.day) === String(state.sub))).join("");
    const day = days.find(d => String(d.day) === String(state.sub));
    main.innerHTML = day ? renderBoardDay(day, nameOf) : "";
  }

  function renderMinutes() {
    if (!online) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">会议纪要需要从 sidecar 打开本页才能查看。<br>启动方式见 README（cd sidecar && npm start）。</div>`; return; }
    const load = () => fetch("/api/artifacts?type=minutes")
      .then(r => r.ok ? r.json() : { artifacts: [] })
      .then(data => { minutes = Array.isArray(data.artifacts) ? data.artifacts : []; paintMinutes(); })
      .catch(() => { minutes = []; paintMinutes(); });
    load();
    pollTimer = setInterval(load, 5000);
  }

  function paintMinutes() {
    const groups = groupMinutesByDay(minutes);
    if (!groups.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">还没有会议纪要，开过会后这里会出现决议/风险/行动项。</div>`; return; }
    if (state.sub == null || !groups.some(g => String(g.day) === String(state.sub))) state.sub = groups[0].day;
    sublist.innerHTML = groups.map(g => subBtn(`第 ${g.day} 天（${g.items.length}）`, g.day, String(g.day) === String(state.sub))).join("");
    const g = groups.find(x => String(x.day) === String(state.sub));
    main.innerHTML = g ? g.items.map(renderMinuteCard).join("") : "";
  }

  function renderPeople() {
    if (!personas.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">没有人物</div>`; return; }
    if (state.sub == null || !personas.some(p => p.id === state.sub)) state.sub = personas[0].id;
    sublist.innerHTML = personas.map(p => {
      const dot = `<span class="dot" style="background:#${p.color.toString(16).padStart(6, "0")}">${escapeHtml(p.name[0])}</span>`;
      return subBtn(p.name, p.id, p.id === state.sub, dot);
    }).join("");
    const p = personas.find(x => x.id === state.sub);
    const mems = sortMemoriesDesc(readMemories()[p.id] || []);
    const sums = collectPersonSummaries(readBoard(), p.id);
    main.innerHTML =
      `<div class="rc-profile-head"><div class="rc-avatar" style="background:#${p.color.toString(16).padStart(6, "0")}">${escapeHtml(p.name[0])}</div>` +
      `<div><div class="rc-profile-name">${escapeHtml(p.name)}</div><div class="rc-profile-role">${escapeHtml(p.role)}</div></div></div>` +
      `<div class="rc-profile-personality">${escapeHtml(p.personality || "暂无画像")}</div>` +
      `<div class="rc-section-title">📋 历史小结</div>` +
      (sums.length ? sums.map(s => `<div class="rc-summary">第${s.day}天：${escapeHtml(s.text)}</div>`).join("") : `<div class="rc-empty">还没有小结</div>`) +
      `<div class="rc-section-title">🧠 记忆流（${mems.length}）</div>` +
      (mems.length ? mems.map(renderMemoryItem).join("") : `<div class="rc-empty">还没有记忆</div>`);
  }

  function renderActivity() {
    const groups = groupActivityByDay(loadActivity());
    if (!groups.length) { sublist.innerHTML = ""; main.innerHTML = `<div class="rc-empty">还没有办公室动态记录。</div>`; return; }
    const ALL = "__all__";
    if (state.sub == null) state.sub = ALL;
    sublist.innerHTML = subBtn("全部", ALL, String(state.sub) === ALL) +
      groups.map(g => subBtn(`第 ${g.day} 天`, g.day, String(g.day) === String(state.sub))).join("");
    const shown = String(state.sub) === ALL ? groups : groups.filter(g => String(g.day) === String(state.sub));
    main.innerHTML = shown.map(g =>
      `<div class="rc-act-day"><h3>第 ${g.day} 天</h3>` +
      g.entries.map(e => `<div class="rc-act ${escapeHtml(e.cls)}"><span class="rc-act-time">${escapeHtml(e.time)}</span>${escapeHtml(e.text)}</div>`).join("") +
      `</div>`
    ).join("");
  }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // 分类切换
  document.getElementById("rc-cats").addEventListener("click", e => {
    const btn = e.target.closest(".rc-cat");
    if (!btn) return;
    document.querySelectorAll(".rc-cat").forEach(b => b.classList.toggle("active", b === btn));
    state.cat = btn.dataset.cat;
    state.sub = null;
    renderCategory();
  });

  // 二级列表切换
  sublist.addEventListener("click", e => {
    const btn = e.target.closest(".rc-sub");
    if (!btn) return;
    state.sub = btn.dataset.sub;
    if (state.cat === "minutes") paintMinutes();
    else renderCategory();
  });

  // 跨标签页实时刷新（模拟在 index.html 写 localStorage 时触发）
  window.addEventListener("storage", e => {
    if (!e.key) return;
    if (e.key === BOARD_KEY && (state.cat === "board" || state.cat === "people")) renderCategory();
    else if (e.key === MEM_KEY && state.cat === "people") renderCategory();
    else if (e.key === "huaxiang.activity.v1" && state.cat === "activity") renderCategory();
  });

  renderCategory();
}

if (typeof document !== "undefined" && document.getElementById("rc-main")) {
  initRecords();
}
