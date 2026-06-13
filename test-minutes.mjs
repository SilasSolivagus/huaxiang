import { normalizeMinutes, minutesEmpty, minutesToText } from "./js/cognition/minutes.js";

// --- normalizeMinutes：对象输入 ---
const m1 = normalizeMinutes({
  decisions: ["上线限速优化", ""],
  risks: ["带宽成本上升"],
  actionItems: [
    { owner: "王强", what: "评估带宽方案" },
    { owner: "", what: "补单元测试" },
    { owner: "李雷", what: "" }   // 无 what → 丢弃
  ]
});
if (m1.decisions.length !== 1) throw new Error("空决议应被过滤");
if (m1.actionItems.length !== 2) throw new Error("无 what 的行动项应被丢弃，应剩 2 条");
if (m1.actionItems[1].owner !== "") throw new Error("允许 owner 为空");

// --- normalizeMinutes：JSON 字符串（含 ```json 围栏）---
const m2 = normalizeMinutes('```json\n{"decisions":["a"],"risks":[],"actionItems":[]}\n```');
if (m2.decisions[0] !== "a") throw new Error("应能解析带围栏的 JSON 字符串");

// --- normalizeMinutes：垃圾输入 → 空结构 ---
const m3 = normalizeMinutes("not json at all");
if (!minutesEmpty(m3)) throw new Error("垃圾输入应得空纪要");
if (!minutesEmpty(normalizeMinutes(null))) throw new Error("null 应得空纪要");
if (!minutesEmpty(normalizeMinutes([1, 2, 3]))) throw new Error("数组应得空纪要");

// --- 各列上限 4 条 ---
const m4 = normalizeMinutes({ decisions: ["1", "2", "3", "4", "5"], risks: [], actionItems: [] });
if (m4.decisions.length !== 4) throw new Error("决议应截断到 4 条");

// --- minutesToText：人类可读，含三段标题 ---
const text = minutesToText(m1);
if (!text.includes("【决议】") || !text.includes("【行动项】")) throw new Error("正文应含分段标题");
if (!text.includes("王强：评估带宽方案")) throw new Error("行动项应渲染 owner");

// --- Feed.writeArtifact / readArtifacts（桩 fetch）---
import { Feed } from "./js/feed.js";

const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url, method: opts?.method || "GET", body: opts?.body });
  if (String(url).startsWith("/api/artifacts") && (!opts || opts.method === undefined || opts.method === "GET")) {
    return { ok: true, json: async () => ({ artifacts: [{ id: "art_1", type: "minutes", day: 4, content: "X" }] }) };
  }
  return { ok: true, json: async () => ({ id: "art_new" }) };
};

const feed = new Feed();
feed.online = true;
const w = await feed.writeArtifact({ type: "minutes", day: 4, content: "决议X" });
if (!w || w.id !== "art_new") throw new Error("writeArtifact 应返回创建结果");
const postCall = calls.find(c => c.method === "POST");
if (!postCall || postCall.url !== "/api/artifacts") throw new Error("应 POST /api/artifacts");

const list = await feed.readArtifacts({ type: "minutes", day: 4 });
if (!Array.isArray(list) || list[0].id !== "art_1") throw new Error("readArtifacts 应返回数组");
const getCall = calls.find(c => c.method === "GET" && c.url.includes("type=minutes"));
if (!getCall || !getCall.url.includes("day=4")) throw new Error("GET URL 应含 type=minutes&day=4");

// 离线降级：不发请求、返回 null
const offline = new Feed();
offline.online = false;
if (await offline.writeArtifact({ type: "minutes", content: "x" }) !== null) throw new Error("离线 writeArtifact 应返回 null");
if (await offline.readArtifacts() !== null) throw new Error("离线 readArtifacts 应返回 null");

// --- Director 收割纪要：行动项进负责人记忆 + 产出物落库 ---
import { Director } from "./js/director.js";
import { MemoryStream } from "./js/memory.js";

function memAgent(name, zone) {
  return {
    persona: { id: name, name, role: "工程师", zone, lines: { meeting: ["占位"] } },
    activity: "", isBusy: false, memory: new MemoryStream("mt-" + name),
    say() {}, setActivity() {}, sitAt() {}, standAt() {}, faceToward() {}, goTo() {}, standUp() {},
    group: { position: { x: 0, z: 0 } }
  };
}

const stubWorld = { day: 1, todayEvents: [], metricsSummary: () => "指标平稳", companyBrief: () => "测试公司" };
const stubLLM = {
  available: true,
  async minutes() {
    return {
      decisions: ["上线限速优化"],
      risks: ["带宽成本上升"],
      actionItems: [
        { owner: "王强", what: "评估带宽方案" },
        { owner: "查无此人", what: "本条应被忽略" }
      ]
    };
  }
};
const written = [];
const stubFeed = { writeArtifact: (d) => { written.push(d); return Promise.resolve({ id: "art_x" }); }, activePolicies: () => [] };

const dAgents = [memAgent("王强", "rd"), memAgent("李雷", "rd")];
const dir = new Director(dAgents, {}, () => {}, stubLLM, stubWorld, stubFeed, null);
dir.meetState.rd.transcript = ["王强：要不要上限速优化？", "李雷：可以，但留意带宽成本"];
await dir.finishMeetings({ type: "standup", label: "每日站会" });

const wangActions = dAgents[0].memory.items.filter(m => m.type === "action");
if (wangActions.length !== 1) throw new Error("王强应有 1 条行动项记忆，实际 " + wangActions.length);
if (!wangActions[0].c.includes("评估带宽方案")) throw new Error("行动项内容不对：" + wangActions[0].c);

const leiActions = dAgents[1].memory.items.filter(m => m.type === "action");
if (leiActions.length !== 0) throw new Error("李雷无对应行动项，不应有 action 记忆");

if (written.length !== 1 || written[0].type !== "minutes") throw new Error("应写 1 条 minutes 产出物");
if (written[0].day !== 1) throw new Error("产出物 day 应为 1");
if (!written[0].content.includes("上线限速优化")) throw new Error("产出物正文应含决议");
if (!written[0].meta || written[0].meta.zone !== "rd") throw new Error("产出物 meta 应含 zone=rd");

// 发言记录太短（<2 句）→ 不收割
const dir2 = new Director([memAgent("赵六", "rd")], {}, () => {}, stubLLM, stubWorld, stubFeed, null);
dir2.meetState.rd.transcript = ["赵六：没什么补充"];
const before = written.length;
await dir2.finishMeetings({ type: "standup", label: "每日站会" });
if (written.length !== before) throw new Error("发言记录过短不应生成纪要");

console.log("director minutes integration OK");

console.log("minutes helpers OK");
