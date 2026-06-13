import { MemoryStream } from "./js/memory.js";

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

console.log("memory id/evidence OK");
