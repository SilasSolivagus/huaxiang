import { normalizeMarketReaction } from "./js/cognition/market.js";

// 合法对象：deltas 被钳制，列表被截断
const m = normalizeMarketReaction({
  deltas: { dau: 5000, sat: 99, bugs: 2.7, runway: 9 },
  reasons: ["限速优化上线获好评", ""],
  feedback: ["应用商店：终于不限速了！", "客服：有人问会员", "贴吧：体验变好", "微博：还行", "多余的"],
  competitorMove: "夸克跟进校园活动"
});
if (m.deltas.dau !== 5000) throw new Error("dau 直接透传");
if (m.deltas.sat !== 10) throw new Error("sat 应钳到 +10");
if (m.deltas.bugs !== 3) throw new Error("bugs 应取整为 3");
if (m.deltas.runway !== 2) throw new Error("runway 应钳到 +2");
if (m.reasons.length !== 1) throw new Error("空 reason 应过滤");
if (m.feedback.length !== 4) throw new Error("feedback 应截断到 4 条");
if (m.competitorMove !== "夸克跟进校园活动") throw new Error("competitorMove 应保留");

// 负向钳制
const m2 = normalizeMarketReaction({ deltas: { sat: -50, runway: -9 }, reasons: [], feedback: [] });
if (m2.deltas.sat !== -10 || m2.deltas.runway !== -2) throw new Error("负向也应钳制");
if (m2.deltas.dau !== 0 || m2.deltas.bugs !== 0) throw new Error("缺字段应为 0");

// JSON 字符串（带 ```json 围栏）
const m3 = normalizeMarketReaction('```json\n{"deltas":{"dau":-100},"reasons":["竞品挤压"],"feedback":[]}\n```');
if (m3.deltas.dau !== -100 || m3.reasons[0] !== "竞品挤压") throw new Error("应解析围栏 JSON");

// 脏输入 → null
if (normalizeMarketReaction("not json") !== null) throw new Error("脏输入应 null");
if (normalizeMarketReaction(null) !== null) throw new Error("null 应 null");
if (normalizeMarketReaction([1, 2]) !== null) throw new Error("数组应 null");

console.log("market OK");
