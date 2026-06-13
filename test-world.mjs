// 世界模型 + 记忆流 + 隔离逻辑测试（Node 环境，无 localStorage → 自动降级为内存模式）
import { World, DEFAULT_COMPANY } from "./js/world.js";
import { MemoryStream } from "./js/memory.js";

// 世界演化 10 天
const w = new World(DEFAULT_COMPANY);
console.log("第1天:", w.metricsSummary());
console.log("事件:", w.todayEvents.map(e => e.text).join(" / "));
for (let i = 0; i < 10; i++) w.nextDay();
console.log("第11天:", w.metricsSummary());
if (w.day !== 11) throw new Error("day counter wrong");
if (w.todayEvents.length < 1) throw new Error("no events");
let fixed = 0;
for (let i = 0; i < 50; i++) if (w.onCollabDone()) fixed++;
console.log("50次协作修复bug次数:", fixed, "剩余bug:", w.metrics.bugs);

// 记忆流：写入、检索、隔离
const m1 = new MemoryStream("a1");
const m2 = new MemoryStream("a2");
m1.add("听到 王磊 说：「数据库索引要优化」", { importance: 4, day: 1, time: "10:00" });
m1.add("市场动态：竞品涨价了", { importance: 7, day: 1, time: "09:00" });
m1.add("我说：「这个需求很简单」", { importance: 2, day: 1, time: "11:00" });
m2.add("今天天气不错", { importance: 2, day: 1, time: "09:00" });
const r = await m1.retrieve("竞品 市场 价格", 2);
console.log("检索结果:", r);
if (!r[0].includes("竞品")) throw new Error("retrieval relevance failed");
if (m2.items.length !== 1) throw new Error("memory not isolated!");
console.log("隔离验证: a1有", m1.items.length, "条, a2有", m2.items.length, "条 ✓");
console.log("今日摘要:", m1.todayDigest(1).split("\n").length, "条");

// Director 集成：带 world 跑 2 天
import * as THREE from "three";
import { buildOffice } from "./js/office.js";
import { PERSONAS } from "./js/personas.js";
import { Director } from "./js/director.js";

class StubAgent {
  constructor(p, id) { this.persona = p; this.activity = ""; this.isBusy = false; this.memory = new MemoryStream("t-" + id); }
  sitAt() {} standAt() {} say() {} setActivity(l) { this.activity = l; } faceToward() {} goTo() {} standUp() {}
}
const scene = new THREE.Scene();
const office = buildOffice(scene, 6);
const agents = PERSONAS.map((p, i) => new StubAgent(p, i));
const w2 = new World(DEFAULT_COMPANY);
const logs = [];
const d = new Director(agents, office, m => logs.push(m), null, w2);
for (let t = 0; t < 259 * 2; t += 0.1) d.update(0.1);
console.log("模拟2天后 director.day =", d.day, "world.day =", w2.day);
const a0mem = agents[0].memory.items;
console.log("agent0 记忆条数:", a0mem.length, "示例:", a0mem.slice(-2).map(m => m.c));
const worldMems = a0mem.filter(m => m.type === "world").length;
const heardMems = a0mem.filter(m => m.type === "heard").length;
console.log("世界公告记忆:", worldMems, "听到的话:", heardMems);
if (worldMems === 0) throw new Error("no world broadcast memories");
if (heardMems === 0) throw new Error("no hearing memories");
// ---- 真实事件优先、虚构补位 ----
const w3 = new World(DEFAULT_COMPANY);
const realEvents = [
  { id: "evt_r1", summary: "百度网盘限速上热搜，新注册暴涨", real: true },
  { id: "evt_r2", summary: "带宽结算新规落地", real: true }
];
w3.nextDay(realEvents);
if (w3.todayEvents.length !== 2) throw new Error("真实事件应全部成为当日事件");
if (!w3.todayEvents[0].real) throw new Error("真实事件应带 real 标记");
if (w3.todayEvents[0].text !== "百度网盘限速上热搜，新注册暴涨") throw new Error("事件文本应取 summary");
w3.nextDay([]);
if (w3.todayEvents.length < 1) throw new Error("无真实事件时应虚构补位");
if (w3.todayEvents.some(e => e.real)) throw new Error("虚构事件不应带 real 标记");
console.log("真实事件注入验证 ✓");
// ---- Director × Feed：突发新闻、政策公告、跨日消费 ----
class StubFeed {
  constructor() { this.taken = 0; }
  takeEvents(max) {
    this.taken++;
    return [{ id: "evt_f1", summary: "竞品突然宣布免费扩容", real: true }];
  }
  activePolicies() { return ["全员降本，禁止新增带宽采购"]; }
}
const agents4 = PERSONAS.slice(0, 3).map((p, i) => new StubAgent(p, "f" + i));
const w4 = new World(DEFAULT_COMPANY);
const logs4 = [];
const feed4 = new StubFeed();
const d4 = new Director(agents4, office, m => logs4.push(m), null, w4, feed4);

// 突发新闻：所有人立即获得记忆，世界当日事件追加
const evCountBefore = w4.todayEvents.length;
d4.injectBreakingNews({ id: "evt_b1", summary: "服务器机房光缆被挖断" });
if (w4.todayEvents.length !== evCountBefore + 1) throw new Error("突发事件应进当日事件");
if (!agents4[0].memory.items.some(m => m.c.includes("光缆"))) throw new Error("突发事件应进记忆");
if (!logs4.some(l => l.includes("📡"))) throw new Error("突发事件应打日志");

// 政策公告：announced 写入全员高权重记忆
d4.announcePolicyChange({
  announced: [{ id: "pol_1", text: "全员降本，禁止新增带宽采购", active: true }],
  revoked: []
});
const polMem = agents4[1].memory.items.find(m => m.c.includes("降本"));
if (!polMem) throw new Error("政策应进入记忆");
if (polMem.imp < 8) throw new Error("政策记忆应为高权重");
d4.announcePolicyChange({ announced: [], revoked: ["pol_1"] });
if (!agents4[0].memory.items.some(m => m.c.includes("撤销") || m.c.includes("调整"))) throw new Error("撤销应有公告");

// 跨日：nextDay 应消费 feed.takeEvents
for (let t = 0; t < 259; t += 0.1) d4.update(0.1);
if (feed4.taken < 1) throw new Error("跨日应从 feed 取事件");
if (!w4.todayEvents.some(e => e.real)) throw new Error("新一天应使用真实事件");
console.log("Director × Feed 验证 ✓");
// ---- 记忆 recency 用模拟时间（不受墙钟影响）----
const mt = new MemoryStream("recency-test");
mt.add("第一天的旧事", { importance: 5, day: 1, time: "09:00" });
mt.add("第十天的新事", { importance: 5, day: 10, time: "09:00" });
const ml = mt.items;
if (!(ml[1].t > ml[0].t)) throw new Error("模拟时间戳 t 应随天数递增");
if (ml[0].t !== 1 * 1440 + 540) throw new Error("t 应为 day*1440 + 分钟数");
const r2 = await mt.retrieve("事", 2);
if (!r2[0].includes("第十天")) throw new Error("较新的记忆应因 recency 排在前");
console.log("模拟时间 recency 验证 ✓");

// ---- 语义检索：注入 embedder 后用余弦相似度 ----
const ms = new MemoryStream("semantic-test");
const VECS = {
  "我们要控制带宽成本": [1, 0, 0],
  "最近流量费用涨得厉害": [0.9, 0.1, 0],
  "今天午饭吃什么": [0, 0, 1]
};
ms.add("我们要控制带宽成本", { importance: 4, day: 1, time: "10:00" });
ms.add("最近流量费用涨得厉害", { importance: 4, day: 1, time: "10:05" });
ms.add("今天午饭吃什么", { importance: 4, day: 1, time: "10:10" });
ms.setEmbedder(async (texts) => texts.map(t => VECS[t] || [0, 0, 0]));
const sem = await ms.retrieve("我们要控制带宽成本", 2);
if (!sem.some(s => s.includes("流量费用涨"))) {
  throw new Error("语义检索应把'流量费用涨'召回（与'带宽成本'语义近），bigram 做不到");
}
if (sem.some(s => s.includes("午饭"))) throw new Error("语义无关的'午饭'不应进 top2");

const ms2 = new MemoryStream("fallback-test");
ms2.add("竞品涨价了", { importance: 5, day: 1, time: "09:00" });
const fb = await ms2.retrieve("竞品 价格", 1);
if (!fb[0].includes("竞品")) throw new Error("无 embedder 应回退 bigram");
console.log("语义检索 + 回退验证 ✓");
// ---- 真实分析指标接入世界模型 ----
const w5 = new World(DEFAULT_COMPANY);
const applied = w5.applyAnalysis({ todoCount: 42, fileCount: 50, hotFiles: [{ path: "js/office.js", lines: 320 }, { path: "js/director.js", lines: 410 }] });
if (applied !== true) throw new Error("applyAnalysis 应返回 true");
if (w5.metrics.bugs !== 42) throw new Error("bugs 应取真实 todoCount");
if (w5.bugsReal !== true) throw new Error("应标记 bugsReal");
if (!w5.metricsSummary().includes("真实代码")) throw new Error("摘要应标注来自真实代码扫描");
if (!w5.metricsSummary().includes("director.js")) throw new Error("摘要应含技术债热点文件");
const before = w5.metrics.bugs;
if (w5.applyAnalysis(null) !== false) throw new Error("null 应返回 false");
if (w5.metrics.bugs !== before) throw new Error("非法输入不应改指标");
console.log("真实分析指标接入验证 ✓");
console.log("ALL WORLD TESTS PASSED");
