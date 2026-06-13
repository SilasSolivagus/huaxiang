// 办公室动态的持久化：把原本只在 DOM 里一闪而过的 director.log 内容存成环形缓冲，
// 供记录页（records.html）翻阅历史。沿用 board.js/memory.js 的 hasStorage 守卫与降级。

const ACTIVITY_KEY = "huaxiang.activity.v1";
const MAX = 300;

function hasStorage() {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

/** 纯函数：追加 entry 到末尾，超过 max 丢最旧，返回新数组（不改入参）。 */
export function appendCapped(list, entry, max = MAX) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.push(entry);
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

/** 追加一条办公室动态。无 localStorage 或空文本时安全 no-op。 */
export function addActivity({ day, time, text, cls } = {}) {
  if (!hasStorage() || !text) return;
  try {
    const next = appendCapped(loadActivity(), {
      day: Number(day) || 0, time: time || "", text: String(text), cls: cls || ""
    });
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(next));
  } catch { /* 存储满/不可用：丢弃这条，不影响模拟 */ }
}

/** 读出全部动态（存储顺序：旧→新）。无 storage / 脏数据返回 []。 */
export function loadActivity() {
  if (!hasStorage()) return [];
  try {
    const arr = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
