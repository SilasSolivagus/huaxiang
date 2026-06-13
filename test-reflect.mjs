import { MemoryStream } from "./js/memory.js";
import { impSinceLastReflect, shouldReflect, formatMemoriesWithIds, parseQuestions, parseInsight } from "./js/cognition/reflect.js";

// 记忆自增 id
const m = new MemoryStream("t-mem-1");
m.items = [];   // node 无 localStorage，从空开始
m.add("第一条", { importance: 5, day: 1, time: "09:00" });
m.add("第二条", { importance: 7, day: 1, time: "10:00" });
if (m.items[0].id == null || m.items[1].id == null) throw new Error("每条记忆应有 id");
if (m.items[1].id <= m.items[0].id) throw new Error("id 应自增");

// evidence 透传存储
m.add("反思：要稳住核心链路", { importance: 8, type: "reflect", day: 1, time: "18:00", evidence: [m.items[0].id, m.items[1].id] });
const reflect = m.items[2];
if (!Array.isArray(reflect.evidence) || reflect.evidence.length !== 2) throw new Error("evidence 应被存储");
if (!reflect.evidence.includes(m.items[0].id)) throw new Error("evidence 应含引用的记忆 id");

// 无 evidence 时不写该字段
if ("evidence" in m.items[0]) throw new Error("普通记忆不应带 evidence 字段");

// impSinceLastReflect：只累计最近一条 reflect 之后的重要度
const items = [
  { id: 1, imp: 7, type: "world", c: "a", day: 1 },
  { id: 2, imp: 8, type: "reflect", c: "旧反思", day: 1 },
  { id: 3, imp: 7, type: "world", c: "b", day: 2 },
  { id: 4, imp: 6, type: "action", c: "c", day: 2 }
];
if (impSinceLastReflect(items) !== 13) throw new Error("应只累计最后反思后的 7+6=13");
if (impSinceLastReflect([]) !== 0) throw new Error("空应为 0");

// shouldReflect 阈值
if (shouldReflect(items, 40) !== false) throw new Error("13 < 40 不应反思");
if (shouldReflect(items, 10) !== true) throw new Error("13 >= 10 应反思");

// formatMemoriesWithIds：带编号、过滤无 id、取最近 max 条
const fmt = formatMemoriesWithIds(items, 2);
if (!fmt.includes("[3]") || !fmt.includes("[4]")) throw new Error("应含最近两条编号");
if (fmt.includes("[1]")) throw new Error("超出 max 的旧条目不应出现");
if (formatMemoriesWithIds([{ imp: 5, c: "无id" }]) !== "") throw new Error("无 id 记忆应被过滤");

// parseQuestions
if (parseQuestions('["问题一","问题二","问题三","第四个超额"]').length !== 3) throw new Error("问题应截断到 3");
if (parseQuestions('["有效", ""]').length !== 1) throw new Error("空问题应过滤");
if (parseQuestions("garbage").length !== 0) throw new Error("脏输入应空");
if (parseQuestions("{}").length !== 0) throw new Error("非数组应空");

// parseInsight：洞见 + 证据（validIds 过滤越界引用）
const ins = parseInsight('{"insight":"先稳核心链路","evidence":[3,4,99]}', [3, 4]);
if (ins.insight !== "先稳核心链路") throw new Error("洞见文本不对");
if (ins.evidence.length !== 2 || ins.evidence.includes(99)) throw new Error("越界证据 id 应被过滤");
if (parseInsight('{"insight":""}') !== null) throw new Error("空洞见应 null");
if (parseInsight("garbage") !== null) throw new Error("脏输入应 null");
if (parseInsight('```json\n{"insight":"x","evidence":[]}\n```').insight !== "x") throw new Error("应解析围栏 JSON");

console.log("memory id/evidence OK");
