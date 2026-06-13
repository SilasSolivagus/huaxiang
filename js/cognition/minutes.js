// 纯函数：把模型输出的会议纪要归一化为 {decisions, risks, actionItems}，并渲染为可读正文。
// 认知层 B 接口模块——无副作用、可单测，供 llm.minutes() 与 director 复用。

function strList(v, max = 4) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || "").trim()).filter(Boolean).map(s => s.slice(0, 60)).slice(0, max);
}

/** 归一化模型输出（对象或 JSON 字符串，可带 ```json 围栏）→ 结构化纪要。失败给空结构。 */
export function normalizeMinutes(raw) {
  let o = raw;
  if (typeof raw === "string") {
    const clean = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    try { o = JSON.parse(clean); } catch { o = null; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    return { decisions: [], risks: [], actionItems: [] };
  }
  const actionItems = Array.isArray(o.actionItems)
    ? o.actionItems
        .map(a => ({
          owner: String(a?.owner || "").trim().slice(0, 20),
          what: String(a?.what || "").trim().slice(0, 60)
        }))
        .filter(a => a.what)
        .slice(0, 4)
    : [];
  return { decisions: strList(o.decisions), risks: strList(o.risks), actionItems };
}

/** 纪要是否完全为空（无任何条目）——空则不必生成产出物。 */
export function minutesEmpty(m) {
  return !m || (m.decisions.length === 0 && m.risks.length === 0 && m.actionItems.length === 0);
}

/** 渲染为人类可读正文（产出物 content）。 */
export function minutesToText(m) {
  const sections = [];
  if (m.decisions.length) sections.push("【决议】\n" + m.decisions.map(d => "· " + d).join("\n"));
  if (m.risks.length) sections.push("【风险】\n" + m.risks.map(r => "· " + r).join("\n"));
  if (m.actionItems.length) {
    sections.push("【行动项】\n" + m.actionItems.map(a => `· ${a.owner ? a.owner + "：" : ""}${a.what}`).join("\n"));
  }
  return sections.join("\n\n");
}
