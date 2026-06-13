import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name) {
  const a = {
    persona: { id: name, name, role: "工程师", zone: "rd", personality: "踏实", lines: { meeting: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("rt-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
  a.memory.items = [];
  return a;
}

const stubWorld = { day: 2, todayEvents: [], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubLLM = {
  enabled: true, usage: "standard", cooldownUntil: 0,
  qCalls: 0, iCalls: 0,
  async dailyPlan() { return null; },
  async reflectQuestions() { this.qCalls++; return ["带宽成本怎么控？", "限速口碑如何保住？"]; },
  async reflectInsight({ question, memories }) {
    this.iCalls++;
    // 引用记忆清单里出现的第一个编号作为证据
    const m = memories.match(/\[(\d+)\]/);
    return { insight: "针对「" + question.slice(0, 6) + "」的洞见", evidence: m ? [Number(m[1])] : [] };
  }
};

const A = memAgent("王强");   // 重要度足够（>40）
A.memory.add("市场动态：夸克搞活动", { importance: 7, type: "world", day: 2, time: "09:00" });
A.memory.add("行动项：评估带宽方案", { importance: 7, type: "action", day: 2, time: "10:00" });
A.memory.add("公司公告：满意度下滑", { importance: 7, type: "world", day: 2, time: "11:00" });
A.memory.add("听到 李雷 说带宽要爆", { importance: 7, type: "heard", day: 2, time: "14:00" });
A.memory.add("董事长说要控成本", { importance: 9, type: "chairman", day: 2, time: "15:00" });
const B = memAgent("李雷");   // 重要度不足
B.memory.add("日常工作", { importance: 3, type: "obs", day: 2, time: "09:00" });

const dir = new Director([A, B], {}, () => {}, stubLLM, stubWorld, null, null, null);
dir.runReflections();
// 等待异步链（stub 同步 resolve）
for (let i = 0; i < 8; i++) await Promise.resolve();

// 王强应生成反思（2 问 × 1 洞见 = 2 条 reflect 记忆，带证据）
const reflects = A.memory.items.filter(m => m.type === "reflect");
if (reflects.length !== 2) throw new Error("王强应有 2 条反思，实际 " + reflects.length);
if (!reflects.every(r => Array.isArray(r.evidence) && r.evidence.length >= 1)) throw new Error("反思应带证据引用");
if (stubLLM.qCalls !== 1) throw new Error("王强应提问 1 次");

// 李雷重要度不足，不反思
if (B.memory.items.some(m => m.type === "reflect")) throw new Error("李雷重要度不足不应反思");

console.log("reflect tree OK");
