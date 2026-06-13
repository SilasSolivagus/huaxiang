import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";
import { ActionItemStore, newActionItem } from "./js/cognition/actionItems.js";

function memAgent(name, zone) {
  return {
    persona: { id: name, name, role: "工程师", zone, lines: { meeting: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("ml-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = {
  day: 1, todayEvents: [],
  metricsSummary: () => "日活 80 万，满意度 60", companyBrief: () => "测试公司",
  deltasApplied: null, applyMarketDeltas(d) { this.deltasApplied = d; }
};
const stubLLM = {
  available: true,
  async minutes() { return { decisions: ["上线限速优化"], risks: [], actionItems: [{ owner: "王强", what: "评估带宽方案" }] }; },
  async marketReaction() { return { deltas: { dau: 5000, sat: 2, bugs: 0, runway: 0 }, reasons: ["上线见效"], feedback: ["应用商店：变快了！"], competitorMove: null }; }
};
const stubFeed = { writeArtifact: () => Promise.resolve({}), activePolicies: () => [], takeEvents: () => [] };

// 1) 生成纪要时登记行动项
const agents = [memAgent("王强", "rd"), memAgent("李雷", "rd")];
const store = new ActionItemStore(); store.items = [];
const dir = new Director(agents, {}, () => {}, stubLLM, stubWorld, stubFeed, null, store);
dir.meetState.rd.transcript = ["王强：上不上限速优化？", "李雷：上，注意成本"];
await dir.finishMeetings({ type: "standup", label: "每日站会" });
if (store.byStatus("todo").length !== 1) throw new Error("纪要应登记 1 条 todo 行动项，实际 " + store.byStatus("todo").length);
if (store.items[0].what !== "评估带宽方案") throw new Error("行动项内容不对");

// 2) 市场反应：上线项喂模型，deltas 落到 world，反馈排进次日
store.items = [{ id: "x", what: "改限速", owner: "王强", zone: "rd", status: "dev", createdDay: 1, devDays: 1, shipDay: 2, shippedDay: null }];
const shipped = store.advance(2);   // dev→shipped
if (shipped.length !== 1) throw new Error("应有 1 条上线");
await dir.runMarketReaction(shipped);
if (!stubWorld.deltasApplied || stubWorld.deltasApplied.dau !== 5000) throw new Error("市场 deltas 应落到 world");
if (!dir.pendingMarketFeedback || dir.pendingMarketFeedback.length !== 1) throw new Error("反馈应排进次日队列");

// 3) 次日 broadcastDaily 把市场反馈写进全员记忆并清空队列
stubWorld.metricsSummary = () => "日活 80.5 万";
dir.broadcastDaily();
const got = agents[0].memory.items.filter(m => m.c.includes("应用商店：变快了"));
if (got.length !== 1) throw new Error("市场反馈应进全员记忆");
if (dir.pendingMarketFeedback.length !== 0) throw new Error("广播后队列应清空");

console.log("market loop OK");
