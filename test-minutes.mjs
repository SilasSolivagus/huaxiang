import { normalizeMinutes, minutesEmpty, minutesToText } from "./js/cognition/minutes.js";

// --- normalizeMinutes：对象输入 ---
const m1 = normalizeMinutes({
  decisions: ["上线限速优化", ""],
  risks: ["带宽成本上升"],
  actionItems: [
    { owner: "王强", what: "评估带宽方案" },
    { owner: "", what: "补单元测试" },
    { owner: "李雷", what: "" }   // 无 what → 丢弃
  ]
});
if (m1.decisions.length !== 1) throw new Error("空决议应被过滤");
if (m1.actionItems.length !== 2) throw new Error("无 what 的行动项应被丢弃，应剩 2 条");
if (m1.actionItems[1].owner !== "") throw new Error("允许 owner 为空");

// --- normalizeMinutes：JSON 字符串（含 ```json 围栏）---
const m2 = normalizeMinutes('```json\n{"decisions":["a"],"risks":[],"actionItems":[]}\n```');
if (m2.decisions[0] !== "a") throw new Error("应能解析带围栏的 JSON 字符串");

// --- normalizeMinutes：垃圾输入 → 空结构 ---
const m3 = normalizeMinutes("not json at all");
if (!minutesEmpty(m3)) throw new Error("垃圾输入应得空纪要");
if (!minutesEmpty(normalizeMinutes(null))) throw new Error("null 应得空纪要");
if (!minutesEmpty(normalizeMinutes([1, 2, 3]))) throw new Error("数组应得空纪要");

// --- 各列上限 4 条 ---
const m4 = normalizeMinutes({ decisions: ["1", "2", "3", "4", "5"], risks: [], actionItems: [] });
if (m4.decisions.length !== 4) throw new Error("决议应截断到 4 条");

// --- minutesToText：人类可读，含三段标题 ---
const text = minutesToText(m1);
if (!text.includes("【决议】") || !text.includes("【行动项】")) throw new Error("正文应含分段标题");
if (!text.includes("王强：评估带宽方案")) throw new Error("行动项应渲染 owner");

console.log("minutes helpers OK");
