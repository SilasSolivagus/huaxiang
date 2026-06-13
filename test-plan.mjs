import { normalizePlan, planSummaryText, findCollabPair } from "./js/cognition/plan.js";

// normalizePlan：合法对象，slot/kind 校验，截断 3 条
const p = normalizePlan({ intentions: [
  { slot: "上午", what: "查限速 TODO", with: null, kind: "investigate" },
  { slot: "下午", what: "找王强对带宽方案", with: "王强", kind: "collab" },
  { slot: "晚上", what: "非法 slot 归全天", with: "", kind: "badkind" },
  { slot: "上午", what: "第四条应被截断", with: null, kind: "build" }
]});
if (p.intentions.length !== 3) throw new Error("应截断到 3 条");
if (p.intentions[2].slot !== "全天") throw new Error("非法 slot 应归全天");
if (p.intentions[2].kind !== "build") throw new Error("非法 kind 应归 build");
if (p.intentions[1].with !== "王强" || p.intentions[1].kind !== "collab") throw new Error("collab 意图应保留");
if (p.intentions[0].with !== null) throw new Error("无 with 应为 null");

// normalizePlan：空 what 过滤；JSON 字符串（带围栏）；脏输入空
if (normalizePlan({ intentions: [{ what: "" }] }).intentions.length !== 0) throw new Error("空 what 应过滤");
const p2 = normalizePlan('```json\n{"intentions":[{"slot":"上午","what":"写测试","kind":"build"}]}\n```');
if (p2.intentions[0].what !== "写测试") throw new Error("应解析围栏 JSON");
if (normalizePlan("garbage").intentions.length !== 0) throw new Error("脏输入应空");
if (normalizePlan(null).intentions.length !== 0) throw new Error("null 应空");

// planSummaryText
const t = planSummaryText(p);
if (!t.includes("上午：查限速 TODO") || !t.includes("（找王强）")) throw new Error("摘要格式不对");
if (planSummaryText({ intentions: [] }) !== "") throw new Error("空计划摘要应为空串");

// findCollabPair：A 的 collab 意图指向 B，且 B 在候选里 → 返回 {visitor:A, host:B, topic}
const A = { persona: { name: "王强" }, plan: { intentions: [{ kind: "collab", with: "李雷", what: "对带宽方案" }] } };
const B = { persona: { name: "李雷" }, plan: { intentions: [] } };
const C = { persona: { name: "韩梅" }, plan: null };
const pair = findCollabPair([A, B, C], ag => ag.plan);
if (!pair || pair.visitor !== A || pair.host !== B) throw new Error("应配出 A→B");
if (pair.topic !== "对带宽方案") throw new Error("应带上话题");

// findCollabPair：with 指向不在候选里的人 → null
const D = { persona: { name: "王强" }, plan: { intentions: [{ kind: "collab", with: "不在场", what: "x" }] } };
if (findCollabPair([D, B], ag => ag.plan) !== null) throw new Error("with 不在候选应返回 null");
// 无人有 collab 意图 → null
if (findCollabPair([B, C], ag => ag.plan) !== null) throw new Error("无 collab 意图应 null");

console.log("plan OK");
