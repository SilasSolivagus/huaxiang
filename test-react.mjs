import { parseReaction, cosineTopK, bigramTopK } from "./js/cognition/react.js";

// parseReaction：合法对象
const r = parseReaction({ utterance: "带宽这事我盯一下", action: "investigate_repo" });
if (r.utterance !== "带宽这事我盯一下" || r.action !== "investigate_repo") throw new Error("合法反应解析错");
// 非法 action 归 none；JSON 字符串带围栏；脏输入当纯发言
if (parseReaction({ utterance: "x", action: "乱来" }).action !== "none") throw new Error("非法 action 应归 none");
const r2 = parseReaction('```json\n{"utterance":"拉个会","action":"call_meeting"}\n```');
if (r2.action !== "call_meeting") throw new Error("应解析围栏 JSON");
const r3 = parseReaction("就一句话没JSON");
if (r3.action !== "none" || !r3.utterance.includes("就一句话")) throw new Error("非 JSON 应当作纯发言、action=none");
if (parseReaction(null).action !== "none") throw new Error("null 应安全");
if (parseReaction([1]).utterance !== "") throw new Error("数组应空 utterance");

// cosineTopK：按余弦相似度降序取 index
const top = cosineTopK([1, 0], [[1, 0], [0, 1], [0.7, 0.7]], 2);
if (top[0] !== 0) throw new Error("最相似应是 index 0");
if (top[1] !== 2) throw new Error("次相似应是 index 2（0.7,0.7）");
if (cosineTopK([1, 0], [[0, 0]], 1)[0] !== 0) throw new Error("零向量不应崩，返回 index 0");

// bigramTopK：按二元组重叠降序取 index
const tb = bigramTopK("带宽成本压力", ["我负责带宽和成本优化", "我做用户增长活动"], 1);
if (tb[0] !== 0) throw new Error("带宽相关的应排第一");
if (bigramTopK("xyz", ["abc", "def"], 2).length !== 2) throw new Error("无重叠也应返回 k 个");

console.log("react OK");
