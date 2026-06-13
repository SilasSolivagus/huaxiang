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

// 3) runMeetingTalk：done 的人被加入 st.done 并在后续轮转中被跳过
const reactions = { 王强: { utterance: "没什么补充", done: true }, 李雷: { utterance: "我说两句", done: false } };
const stubLLM3 = {
  enabled: true, usage: "standard", available: true, cooldownUntil: 0,
  async dailyPlan() { return null; },
  async converseTurn({ persona }) { return reactions[persona.name] || { utterance: "嗯", done: false }; }
};
const W = memAgent("王强"), L = memAgent("李雷");
const dir3 = new Director([W, L], {}, () => {}, stubLLM3, stubWorld, stubFeed, null, null);
dir3.currentPhase = { type: "standup", label: "每日站会" };
dir3.meetState = { rd: { idx: 0, next: 0, pending: false, transcript: [], done: new Set() }, ops: { idx: 0, next: 0, pending: false, transcript: [], done: new Set() } };

// 反复推进会议轮转，喂足够时间让异步发言落地
for (let k = 0; k < 6; k++) {
  dir3.simTime += 10;
  dir3.runMeetingTalk();
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
// 王强 done=true 应被记入 st.done
if (!dir3.meetState.rd.done.has("王强")) throw new Error("说完的王强应进 st.done");
// 李雷 done=false 不应在 done 集合
if (dir3.meetState.rd.done.has("李雷")) throw new Error("还想说的李雷不应在 st.done");

// 4) 跨天复活防护：日终清空后迟到的 converse 回调不应重启对话、不应重复计 bug
{
  const origRandom = Math.random;
  Math.random = () => 0;   // 固定：zone=rd、pick 取 free[0]、after 延迟固定
  try {
    let resolveTurn = null;
    let onCollabDoneCalls = 0;
    const slowWorld = {
      day: 1, todayEvents: [], metricsSummary: () => "m", companyBrief: () => "c",
      metrics: { bugs: 5 }, onCollabDone() { onCollabDoneCalls++; return false; }
    };
    const slowLLM = {
      enabled: true, usage: "standard", available: true, cooldownUntil: 0,
      async dailyPlan() { return null; },
      converseTurn() { return new Promise(res => { resolveTurn = () => res({ utterance: "在想", done: true }); }); }
    };
    const X = memAgent("赵越"), Y = memAgent("钱多");
    const dir4 = new Director([X, Y], {}, () => {}, slowLLM, slowWorld, { activePolicies: () => [] }, null, null);
    const ws = { seat: { x: 1, z: 1 }, lookAt: { x: 0, z: 0 }, standSpot: { x: 2, z: 2 } };
    dir4.currentPhase = { type: "work" };
    dir4.workSeat.set(X, ws); dir4.workSeat.set(Y, ws);
    dir4.simTime = 1000; dir4.nextCollab = 0;

    const runDue = () => {
      dir4.simTime += 100;
      const due = dir4.tasks.filter(t => t.at <= dir4.simTime);
      dir4.tasks = dir4.tasks.filter(t => t.at > dir4.simTime);
      for (const t of due) t.fn();
    };

    dir4.maybeStartCollab();   // 排了 after(4, starter)
    runDue();                  // 跑 starter → runConverseTurn → converseTurn 进入飞行
    for (let i = 0; i < 8; i++) await Promise.resolve();
    if (!resolveTurn) throw new Error("setup: converseTurn 应已在飞行中");

    // 模拟日终：清空待办 + collabBusy + 进入新一天（director.update 日终块的等价动作）
    dir4.day = 2;
    dir4.tasks = [];
    dir4.collabBusy.clear();

    resolveTurn();             // 迟到回调：onTurn → after(4, finishCollab)
    for (let i = 0; i < 8; i++) await Promise.resolve();
    runDue();                  // 跑被复活排上的 finishCollab —— 应被守卫丢弃
    for (let i = 0; i < 8; i++) await Promise.resolve();

    if (onCollabDoneCalls !== 0) throw new Error("跨天复活的 finishCollab 不应再调 onCollabDone（重复计 bug）");
    if (dir4.collabBusy.size !== 0) throw new Error("collabBusy 应保持清空");
  } finally {
    Math.random = origRandom;
  }
}

console.log("converseTurn OK");
