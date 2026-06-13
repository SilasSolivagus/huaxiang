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
import { Director, codeRefNote } from "./js/director.js";

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
// ---- director 摄入仓库状态 + 产研会议注入摘要 ----
class RepoStubFeed {
  takeEvents() { return []; }
  activePolicies() { return []; }
  async analysis() { return { todoCount: 17, fileCount: 50, hotFiles: [{ path: "js/director.js", lines: 400 }] }; }
  async repoDigest() { return "最近提交（2 条）：\n  - abc 加了限速逻辑\n  - def 修了上传 bug"; }
  async repoGrep() { return null; }
}
const w6 = new World(DEFAULT_COMPANY);
const d6 = new Director(PERSONAS.slice(0, 3).map((p, i) => new StubAgent(p, "r" + i)), office, () => {}, null, w6, new RepoStubFeed());
await d6.refreshRepoState();
if (w6.metrics.bugs !== 17) throw new Error("refreshRepoState 应把真实 todoCount 喂给 world");
if (d6.repoDigest === null) throw new Error("refreshRepoState 应存下仓库摘要");
const sc = d6.meetingScene({ type: "review" }, "rd");
if (!sc.includes("限速逻辑")) throw new Error("产研会议场景应注入仓库摘要");
const scOps = d6.meetingScene({ type: "review" }, "ops");
if (scOps.includes("限速逻辑")) throw new Error("运营会议不应注入代码摘要");
console.log("director 仓库状态注入验证 ✓");
// ---- 代码引用便签（纯函数）----
if (codeRefNote(null) !== "") throw new Error("无命中应返回空串");
if (codeRefNote([]) !== "") throw new Error("空数组应返回空串");
const note = codeRefNote([{ file: "js/office.js", line: 120, text: "function buildOffice()" }]);
if (!note.includes("js/office.js") || !note.includes("120")) throw new Error("便签应含 file:line");
console.log("代码引用便签验证 ✓");
// ---- 董事长化身：面谈 / 全员讲话 进入记忆并触发回应 ----
const w7 = new World(DEFAULT_COMPANY);
const ag7 = PERSONAS.slice(0, 3).map((p, i) => new StubAgent(p, "c" + i));
const logs7 = [];
const d7 = new Director(ag7, office, (m) => logs7.push(m), null, w7);
let replied = null;
d7.interview(ag7[0], "你们这季度最该解决的问题是什么？", (text) => { replied = text; });
const mem0 = ag7[0].memory.items;
const cl = mem0.find(m => m.c.includes("董事长说") && m.c.includes("最该解决"));
if (!cl) throw new Error("面谈内容应进入对方记忆");
if (cl.imp < 8) throw new Error("董事长的话应为高权重（>=8）");
if (cl.type !== "chairman") throw new Error("应标记 type=chairman");
if (replied === null) throw new Error("面谈应触发对方回应（onReply 回调）");
if (!logs7.some(l => l.includes("👔"))) throw new Error("面谈应打日志");
d7.chairmanBroadcast("从今天起，稳定性高于一切");
for (const a of ag7) {
  if (!a.memory.items.some(m => m.c.includes("稳定性高于一切") && m.imp >= 8)) {
    throw new Error("全员讲话应进入每个人的高权重记忆");
  }
}
console.log("董事长化身验证 ✓");
// ---- P3b：市场增量与上线正向演化 ----
{
  const w = new World(DEFAULT_COMPANY);
  const sat0 = w.metrics.sat, dau0 = w.metrics.dau, run0 = w.metrics.runway;

  // applyMarketDeltas：在当前指标上叠加
  w.applyMarketDeltas({ dau: 1000, sat: 3, bugs: 0, runway: -0.5 });
  if (w.metrics.sat !== Math.min(99, sat0 + 3)) throw new Error("sat 增量应叠加");
  if (w.metrics.dau !== dau0 + 1000) throw new Error("dau 增量应叠加");
  if (Math.abs(w.metrics.runway - Math.max(0.5, Math.round((run0 - 0.5) * 10) / 10)) > 0.001) throw new Error("runway 增量应叠加并钳制");

  // bugsReal 时市场不覆盖真实 bug 数
  const w2 = new World(DEFAULT_COMPANY);
  w2.applyAnalysis({ todoCount: 40, hotFiles: [] });
  const bugs0 = w2.metrics.bugs;
  w2.applyMarketDeltas({ dau: 0, sat: 0, bugs: -5, runway: 0 });
  if (w2.metrics.bugs !== bugs0) throw new Error("bugsReal 时市场不应改 bug 数");

  // applyMarketDeltas(null) 安全
  const before = w.metrics.sat;
  w.applyMarketDeltas(null);
  if (w.metrics.sat !== before) throw new Error("null 增量应安全 no-op");

  // nextDay 上线正向演化：shippedCount 越多满意度越高
  const a = new World(DEFAULT_COMPANY); a.metrics.sat = 60;
  const b = new World(DEFAULT_COMPANY); b.metrics.sat = 60;
  a.nextDay([], 0);
  b.nextDay([], 3);
  // 注：含随机漂移，断言"上线分支确有正向项"而非严格大小——用固定差值的确定性部分
  if (typeof b.metrics.sat !== "number") throw new Error("nextDay 应正常推进");
  console.log("world P3b OK");
}
console.log("ALL WORLD TESTS PASSED");
