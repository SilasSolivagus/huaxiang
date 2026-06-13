// 进展看板：每个模拟日结束时沉淀「团队进展 / 决策 / 应对」条目和每个人的当日小结。
// 持久化在 localStorage，跨刷新累积。新条目在界面上高亮（按已看到的天数对比）。

const KEY = "huaxiang.board.v1";
const SEEN_KEY = "huaxiang.board.seen.v1";
const MAX_DAYS = 40;

const ITEM_TYPES = ["进展", "决策", "应对"];

function hasStorage() {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

/**
 * 确定性提炼：从当日事实记录生成看板条目（无模型时的兜底，保证看板始终有内容）。
 * record: { policies:[text], market:[text], breaking:[text], collabs:[{visitor,host,bugFixed}], bugsFixed }
 * 返回 [{ type, text }]
 */
export function buildItems(record = {}) {
  const items = [];
  for (const p of record.policies || []) {
    items.push({ type: "决策", text: `管理层决策：${p}` });
  }
  if (record.bugsFixed > 0) {
    items.push({ type: "进展", text: `团队协作修复了 ${record.bugsFixed} 个 Bug` });
  }
  const nonBugCollabs = (record.collabs || []).filter(c => !c.bugFixed);
  for (const c of nonBugCollabs.slice(0, 3)) {
    items.push({ type: "进展", text: `${c.visitor} 和 ${c.host} 对齐了一个工作话题` });
  }
  for (const ev of (record.breaking || []).slice(0, 3)) {
    items.push({ type: "应对", text: `面对突发：「${ev}」，团队当天做了讨论` });
  }
  for (const ev of (record.market || []).slice(0, 3)) {
    items.push({ type: "应对", text: `关注市场动态：${ev}` });
  }
  return items;
}

/**
 * 个人当日小结：从某人当天的记忆条目里统计出他干了什么（确定性，不额外调模型）。
 * memItems: 该人当天的记忆数组（{c, type, day}）
 */
export function composeAgentSummary(memItems = []) {
  const meetings = memItems.filter(m => m.c.includes("参加了")).length;
  const collabs = memItems.filter(m => m.c.includes("讨论") || m.c.includes("同步")).length;
  const fixes = memItems.filter(m => m.c.includes("修复了")).length;
  const reflect = memItems.find(m => m.type === "reflect");

  const parts = [];
  if (meetings) parts.push(`开了 ${meetings} 个会`);
  if (collabs) parts.push(`协作/讨论 ${collabs} 次`);
  if (fixes) parts.push(`参与修复 ${fixes} 个 Bug`);
  let s = parts.length ? parts.join("，") : "日常工作，无特别记录";
  if (reflect) s += `；感悟：${reflect.c.replace(/^(今日反思|反思)：/, "")}`;
  return s;
}

export class Board {
  constructor() {
    this.days = load();         // [{ day, items:[{type,text}], summaries:{ id: text } }]
    this.onUpdate = null;       // () => void  UI 刷新回调
  }

  /** 记录某天的看板条目与每人小结（覆盖同一天的旧记录） */
  recordDay(day, items, summaries) {
    const clean = (items || []).filter(it => it && ITEM_TYPES.includes(it.type) && it.text)
      .map(it => ({ type: it.type, text: String(it.text).slice(0, 140) }));
    this.days = this.days.filter(d => d.day !== day);
    this.days.push({ day, items: clean, summaries: summaries || {} });
    this.days.sort((a, b) => a.day - b.day);
    if (this.days.length > MAX_DAYS) this.days = this.days.slice(-MAX_DAYS);
    save(this.days);
    this.onUpdate?.();
  }

  /** 最近 n 天（最新在前） */
  recent(n = 8) {
    return this.days.slice(-n).reverse();
  }

  /** 某人最近一次的当日小结 */
  summaryFor(agentId) {
    for (let i = this.days.length - 1; i >= 0; i--) {
      const s = this.days[i].summaries?.[agentId];
      if (s) return { day: this.days[i].day, text: s };
    }
    return null;
  }

  /** 自上次「已看」以来新增的看板条目数（按天 + 条目数比对） */
  newCount() {
    const seen = loadSeen();   // { day: itemCount }
    let n = 0;
    for (const d of this.days) {
      const before = seen[d.day] || 0;
      if (d.items.length > before) n += d.items.length - before;
    }
    return n;
  }

  /** 把当前所有条目标记为已看 */
  markSeen() {
    const seen = {};
    for (const d of this.days) seen[d.day] = d.items.length;
    saveSeen(seen);
  }

  /** 某天某条目是否是「未看过的新条目」（用于高亮）：索引 >= 上次已看的条数 */
  isNew(day, index) {
    const seen = loadSeen();
    return index >= (seen[day] || 0);
  }

  static clearAll() {
    if (hasStorage()) {
      localStorage.removeItem(KEY);
      localStorage.removeItem(SEEN_KEY);
    }
  }
}

function load() {
  if (!hasStorage()) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function save(days) {
  if (!hasStorage()) return;
  try { localStorage.setItem(KEY, JSON.stringify(days)); } catch {}
}

function loadSeen() {
  if (!hasStorage()) return {};
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch { return {}; }
}

function saveSeen(seen) {
  if (!hasStorage()) return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
}
