import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name) {
  return {
    persona: { id: name, name, role: "工程师", zone: "rd", personality: "踏实", lines: { meeting: ["占位"], collab: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("cv-" + name),
    said: [], say(t) { this.said.push(t); }, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [], metricsSummary: () => "日活 80 万", companyBrief: () => "测试公司" };
const stubFeed = { activePolicies: () => [], async embed() { return null; } };

// 1) llm 可用：converseTurn 说话 + 回调带 done
const stubLLM1 = {
  enabled: true, usage: "standard", available: true, cooldownUntil: 0,
  async dailyPlan() { return null; },
  async converseTurn() { return { utterance: "我觉得限速能上", done: true }; }
};
const A = memAgent("王强");
const dir1 = new Director([A], {}, () => {}, stubLLM1, stubWorld, stubFeed, null, null);
let cb = null;
await dir1.converseTurn(A, "讨论场景", "兜底台词", { logCls: "log-collab", transcript: [], onTurn: (text, done) => { cb = { text, done }; } });
if (!A.said.includes("我觉得限速能上")) throw new Error("应说出模型台词");
if (!cb || cb.text !== "我觉得限速能上" || cb.done !== true) throw new Error("onTurn 应回调 {text, done=true}");

// 2) llm 不可用：回退 fallback、done=false
const stubLLM2 = { enabled: false, usage: "standard", available: false, async dailyPlan() { return null; } };
const B = memAgent("李雷");
const dir2 = new Director([B], {}, () => {}, stubLLM2, stubWorld, stubFeed, null, null);
let cb2 = null;
await dir2.converseTurn(B, "场景", "我的兜底台词", { logCls: "log-collab", transcript: [], onTurn: (t, d) => { cb2 = { t, d }; } });
if (!B.said.includes("我的兜底台词")) throw new Error("无 llm 应说兜底台词");
if (!cb2 || cb2.d !== false) throw new Error("无 llm 时 done 应为 false");

console.log("converseTurn OK");
