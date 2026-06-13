// 反思树纯函数：触发判定（重要度累积）、记忆带 id 格式化、问题/洞见解析（含证据 id 校验）。

export const REFLECT_THRESHOLD = 40;

function strip(raw) {
  return String(raw).replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
}

/** 自上次反思以来新记忆的重要度之和（遇到最近一条 reflect 即止）。 */
export function impSinceLastReflect(items) {
  const arr = Array.isArray(items) ? items : [];
  let sum = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].type === "reflect") break;
    sum += arr[i].imp || 0;
  }
  return sum;
}

/** 是否到达反思阈值。 */
export function shouldReflect(items, threshold = REFLECT_THRESHOLD) {
  return impSinceLastReflect(items) >= threshold;
}

/** 把记忆格式化为带编号的清单（供模型提问/引证）；过滤无 id、取最近 max 条。 */
export function formatMemoriesWithIds(items, max = 20) {
  return (Array.isArray(items) ? items : [])
    .filter(m => m.id != null)
    .slice(-max)
    .map(m => `[${m.id}] (第${m.day}天) ${m.c}`)
    .join("\n");
}

/** 解析模型问题输出 → 最多 3 个非空问题。 */
export function parseQuestions(raw) {
  let o = raw;
  if (typeof raw === "string") { try { o = JSON.parse(strip(raw)); } catch { return []; } }
  if (!Array.isArray(o)) return [];
  return o.map(x => String(x || "").trim()).filter(Boolean).map(s => s.slice(0, 60)).slice(0, 3);
}

/** 解析模型洞见输出 → {insight, evidence:[id]}；validIds 非空时过滤越界引用。失败给 null。 */
export function parseInsight(raw, validIds = null) {
  let o = raw;
  if (typeof raw === "string") { try { o = JSON.parse(strip(raw)); } catch { return null; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const insight = String(o.insight || "").trim().slice(0, 70);
  if (!insight) return null;
  let evidence = Array.isArray(o.evidence) ? o.evidence.map(Number).filter(Number.isFinite) : [];
  if (validIds) { const set = new Set(validIds); evidence = evidence.filter(id => set.has(id)); }
  return { insight, evidence: evidence.slice(0, 5) };
}
