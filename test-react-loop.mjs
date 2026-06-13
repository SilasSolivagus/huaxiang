import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name, personality) {
  return {
    persona: { id: name, name, role: "工程师", zone: "rd", personality, lines: { meeting: ["占位"], collab: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("rx-" + name),
    said: [], say(t) { this.said.push(t); }, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubLLM = {
  enabled: true, usage: "standard", available: true, cooldownUntil: 0,
  reactCalls: [],
  async dailyPlan() { return null; },
  async react({ persona, event }) {
    this.reactCalls.push(persona.name);
    return { utterance: `${persona.name} 关注：${event.slice(0, 6)}`, action: "investigate_repo" };
  }
};
// 桩 feed：embed 让"带宽专家"与"带宽事件"最相似；repoGrep 返回命中
const grepCalls = [];
const stubFeed = {
  activePolicies: () => [],
  async embed(texts) {
    // texts[0]=事件，其余=各人画像；按是否含"带宽"给 1/0 向量
    return texts.map(t => [t.includes("带宽") ? 1 : 0, t.includes("增长") ? 1 : 0]);
  },
  async repoGrep(q) { grepCalls.push(q); return [{ file: "js/x.js", line: 3, text: "限速逻辑" }]; }
};

const A = memAgent("王强", "负责带宽和成本");      // 与带宽事件最相关
const B = memAgent("李雷", "负责带宽优化");        // 次相关
const C = memAgent("韩梅", "做用户增长活动");      // 不相关
const dir = new Director([A, B, C], {}, () => {}, stubLLM, stubWorld, stubFeed, null, null);

dir.injectBreakingNews({ id: "e1", summary: "带宽结算新规落地，CDN 成本上涨" });
// 等待 embed + react 异步链
for (let i = 0; i < 12; i++) await Promise.resolve();
await new Promise(r => setTimeout(r, 5));
for (let i = 0; i < 12; i++) await Promise.resolve();

// 全员都收到公告记忆
for (const a of [A, B, C]) {
  if (!a.memory.items.some(m => m.type === "world" && m.c.includes("市场快讯"))) throw new Error(a.persona.name + " 应收到突发公告记忆");
}
// 只有 top2（王强、李雷）反应，韩梅没反应
if (stubLLM.reactCalls.length !== 2) throw new Error("应只有 top2 反应，实际 " + stubLLM.reactCalls.length);
if (stubLLM.reactCalls.includes("韩梅")) throw new Error("不相关的韩梅不应反应");
if (!stubLLM.reactCalls.includes("王强")) throw new Error("最相关的王强应反应");
// 反应：说了话 + 写了反应记忆 + investigate_repo 触发了 repoGrep
if (A.said.length === 0) throw new Error("反应者应说一句话");
if (!A.memory.items.some(m => m.c.includes("反应"))) throw new Error("反应者应写反应记忆");
if (grepCalls.length === 0) throw new Error("investigate_repo 应触发 repoGrep");

console.log("react loop OK");
