// 行动项生命周期：待办(todo) → 开发中(dev, 1~3 模拟日) → 已上线(shipped)。
// 纯函数 + 一个 localStorage 持久化的 Store。上线项喂给市场反应模拟器。

const KEY = "huaxiang.actionitems.v1";
const DEV_CHOICES = [1, 2, 3];

function hasStorage() {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

function hashStr(s) {
  let h = 0;
  const t = String(s);
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 新建一条行动项（状态 todo）。devDays 不传时随机取 1~3。 */
export function newActionItem({ what, owner = "", zone = "rd", day, devDays }) {
  const dev = Number.isInteger(devDays) ? devDays : DEV_CHOICES[Math.floor(Math.random() * DEV_CHOICES.length)];
  return {
    id: `ai_${day}_${hashStr(what) % 100000}`,
    what: String(what || "").slice(0, 60),
    owner: String(owner || "").slice(0, 20),
    zone: zone === "ops" ? "ops" : "rd",
    status: "todo",
    createdDay: Number(day) || 0,
    devDays: dev,
    shipDay: null,
    shippedDay: null
  };
}

/**
 * 推进到 day：todo→dev（设 shipDay=day+devDays）；dev 且 day>=shipDay→shipped。
 * 返回 { items: 新数组, shipped: 当日新上线的项 }。纯函数，不改入参。
 */
export function advanceActionItems(items, day) {
  const shipped = [];
  const next = (Array.isArray(items) ? items : []).map(it => {
    if (it.status === "todo") {
      return { ...it, status: "dev", shipDay: day + it.devDays };
    }
    if (it.status === "dev" && it.shipDay != null && day >= it.shipDay) {
      const s = { ...it, status: "shipped", shippedDay: day };
      shipped.push(s);
      return s;
    }
    return it;
  });
  return { items: next, shipped };
}

export class ActionItemStore {
  constructor() {
    this.items = load();
  }
  add(item) {
    this.items.push(item);
    save(this.items);
    return item;
  }
  advance(day) {
    const r = advanceActionItems(this.items, day);
    this.items = r.items;
    save(this.items);
    return r.shipped;
  }
  byStatus(status) {
    return this.items.filter(i => i.status === status);
  }
  /** 某人未上线的行动项（给 P3c 每日计划用） */
  openFor(owner) {
    return this.items.filter(i => i.owner === owner && i.status !== "shipped");
  }
}

function load() {
  if (!hasStorage()) return [];
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function save(items) {
  if (!hasStorage()) return;
  try { localStorage.setItem(KEY, JSON.stringify(items.slice(-200))); } catch {}
}
