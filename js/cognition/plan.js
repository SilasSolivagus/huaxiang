// 纯函数：把模型输出的每日计划归一化为 {intentions}，渲染摘要，并从一组 agent 的计划里
// 找一对协作意图。供 llm.dailyPlan() 与 director 复用。

const SLOTS = ["上午", "下午", "全天"];
const KINDS = ["investigate", "collab", "build", "review", "ops", "rest"];

/** 归一化模型输出（对象或 JSON 字符串，可带 ```json 围栏）→ {intentions:[{slot,what,with,kind}]}。 */
export function normalizePlan(raw) {
  let o = raw;
  if (typeof raw === "string") {
    const clean = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    try { o = JSON.parse(clean); } catch { return { intentions: [] }; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { intentions: [] };
  const arr = Array.isArray(o.intentions) ? o.intentions : [];
  const intentions = arr.map(it => ({
    slot: SLOTS.includes(it?.slot) ? it.slot : "全天",
    what: String(it?.what || "").trim().slice(0, 50),
    with: it?.with ? String(it.with).trim().slice(0, 20) : null,
    kind: KINDS.includes(it?.kind) ? it.kind : "build"
  })).filter(it => it.what).slice(0, 3);
  return { intentions };
}

/** 渲染计划为一行摘要（存记忆 / 展示用）。 */
export function planSummaryText(plan) {
  if (!plan || !Array.isArray(plan.intentions) || plan.intentions.length === 0) return "";
  return plan.intentions.map(i => `${i.slot}：${i.what}${i.with ? `（找${i.with}）` : ""}`).join("；");
}

/**
 * 从一组候选 agent 的计划里找一对协作意图：某 A 有 kind=collab 且 with=B，且 B 也在候选里。
 * @param {Array} candidates agent 列表（需有 persona.name）
 * @param {(agent)=>plan|null} planOf 取某 agent 当前计划
 * @returns {{visitor, host, topic}|null}
 */
export function findCollabPair(candidates, planOf) {
  for (const a of candidates) {
    const plan = planOf(a);
    if (!plan || !Array.isArray(plan.intentions)) continue;
    const want = plan.intentions.find(i => i.kind === "collab" && i.with);
    if (!want) continue;
    const host = candidates.find(b => b !== a && b.persona?.name === want.with);
    if (host) return { visitor: a, host, topic: want.what };
  }
  return null;
}
