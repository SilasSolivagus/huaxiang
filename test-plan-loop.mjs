import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";
import { findCollabPair } from "./js/cognition/plan.js";

function memAgent(name, zone) {
  return {
    persona: { id: name, name, role: "工程师", zone, personality: "踏实", lines: { meeting: ["占位"], collab: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("pl-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [{ text: "夸克搞活动" }], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubLLM = {
  available: true, enabled: true, usage: "standard",
  async dailyPlan({ persona, openItems }) {
    return { intentions: [
      { slot: "上午", what: `推进 ${openItems[0] || "日常"}`, with: null, kind: "investigate" },
      { slot: "下午", what: "对带宽方案", with: persona.name === "王强" ? "李雷" : null, kind: persona.name === "王强" ? "collab" : "build" }
    ]};
  }
};
const stubFeed = { activePolicies: () => ["全员降本"], takeEvents: () => [] };

// 用真实 ActionItemStore 提供 openFor
const { ActionItemStore, newActionItem } = await import("./js/cognition/actionItems.js");
const store = new ActionItemStore(); store.items = [];
store.add(newActionItem({ what: "评估带宽方案", owner: "王强", zone: "rd", day: 1, devDays: 1 }));

const agents = [memAgent("王强", "rd"), memAgent("李雷", "rd")];
const dir = new Director(agents, {}, () => {}, stubLLM, stubWorld, stubFeed, null, store);

// 1) runDailyPlans：每人挂上 plan + 写入 plan 记忆
await dir.runDailyPlans();
// 等待微任务链（stub 是同步 resolve 的 promise）
await Promise.resolve(); await Promise.resolve();
if (!agents[0].plan || agents[0].plan.intentions.length !== 2) throw new Error("王强应挂上 2 条意图的计划");
if (agents[0].plan.day !== 1) throw new Error("计划应标当日");
if (!agents[0].plan.intentions[0].what.includes("评估带宽方案")) throw new Error("计划应消费 openFor 行动项");
const planMem = agents[0].memory.items.filter(m => m.type === "plan");
if (planMem.length !== 1 || !planMem[0].c.includes("今日计划")) throw new Error("应写一条 plan 记忆");

// 2) 计划里的 collab 意图能被 findCollabPair 选出（王强→李雷）
const pair = findCollabPair(agents, a => a.plan?.day === dir.day ? a.plan : null);
if (!pair || pair.host.persona.name !== "李雷") throw new Error("应从计划配出 王强→李雷");

console.log("plan loop OK");
