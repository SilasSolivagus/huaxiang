import * as THREE from "three";
import { buildOffice } from "./js/office.js";
import { PERSONAS, DAILY_SCHEDULE } from "./js/personas.js";
import { Director } from "./js/director.js";
import { World, DEFAULT_COMPANY } from "./js/world.js";
import { MemoryStream } from "./js/memory.js";
import { Board } from "./js/board.js";

const scene = new THREE.Scene();
const office = buildOffice(scene);
console.log("rd: desks=%d meetingSeats=%d coffee=%d | ops: desks=%d meetingSeats=%d coffee=%d",
  office.rd.desks.length, office.rd.meetingSeats.length, office.rd.coffeeSpots.length,
  office.ops.desks.length, office.ops.meetingSeats.length, office.ops.coffeeSpots.length);

// ---- 寻路测试：所有关键点位两两可达（含跨区）----
const pts = [
  ...office.rd.desks.map(d => d.seat),
  ...office.rd.meetingSeats,
  ...office.rd.coffeeSpots,
  ...office.ops.desks.map(d => d.seat),
  ...office.ops.meetingSeats,
  ...office.ops.coffeeSpots,
  office.ctoOffice.seat,
  office.ceoHome.seat,
  { x: 0.7, z: 0.5 }   // 跨区门洞附近
];
let fail = 0, total = 0;
for (let i = 0; i < pts.length; i++) {
  for (let j = 0; j < pts.length; j++) {
    if (i === j) continue;
    total++;
    const p = office.grid.findPath(pts[i].x, pts[i].z, pts[j].x, pts[j].z);
    if (p.length === 0) {
      fail++;
      if (fail <= 5) console.log("NO PATH:", pts[i], "->", pts[j]);
    }
  }
}
console.log(`pathfinding: ${total - fail}/${total} pairs reachable`);
if (fail > 0) throw new Error("pathfinding has unreachable pairs");

// ---- 导演调度测试：用桩 Agent 跑完 3 个模拟日 ----
class StubAgent {
  constructor(p) {
    this.persona = p;
    this.activity = "";
    this.isBusy = false;
    this.calls = { sitAt: 0, standAt: 0, say: 0 };
  }
  sitAt(seat) { this.calls.sitAt++; if (!seat || seat.x === undefined) throw new Error("bad seat " + JSON.stringify(seat)); }
  standAt(spot) { this.calls.standAt++; if (!spot || spot.x === undefined) throw new Error("bad spot"); }
  say(t) { this.calls.say++; if (typeof t !== "string") throw new Error("bad line"); }
  setActivity(l) { this.activity = l; }
  faceToward() {}
  goTo() {}
  standUp() {}
}
const agents = PERSONAS.map(p => new StubAgent(p));
const logs = [];
const director = new Director(agents, office, (m, c) => logs.push(m));

// 跑 3 天：每天 9:00-18:30 = 570 分钟，2.2 分/秒 ≈ 259 秒/天
for (let t = 0; t < 259 * 3; t += 0.1) director.update(0.1);
console.log("simulated 3 days, day counter =", director.day);
console.log("log entries:", logs.length);
console.log("agent0 calls:", JSON.stringify(agents[0].calls));

// 分区核对
const rdCount = PERSONAS.filter(p => (p.zone || "rd") === "rd").length;
const opsCount = PERSONAS.filter(p => p.zone === "ops").length;
console.log("roster: rd=%d ops=%d total=%d", rdCount, opsCount, PERSONAS.length);
if (rdCount + opsCount !== PERSONAS.length) throw new Error("zone split mismatch");
if (!PERSONAS.some(p => p.privateOffice)) throw new Error("missing CTO privateOffice");
if (!PERSONAS.some(p => p.remote)) throw new Error("missing CEO remote");

const phases = new Set();
for (const s of DAILY_SCHEDULE) phases.add(s.type);
console.log("schedule phases:", [...phases].join(","));

// ---- 看板：跑 2 天后应有进展条目和个人小结（无 LLM → 走确定性提炼）----
class MemAgent {
  constructor(p, i) { this.persona = p; this.activity = ""; this.isBusy = false; this.memory = new MemoryStream("bd-" + i); }
  sitAt() {} standAt() {} say() {} setActivity(l) { this.activity = l; } faceToward() {} goTo() {} standUp() {}
}
const bdAgents = PERSONAS.map((p, i) => new MemAgent(p, i));
const board = new Board();
const w = new World(DEFAULT_COMPANY);
const d2 = new Director(bdAgents, office, () => {}, null, w, null, board);
for (let t = 0; t < 259 * 2; t += 0.1) d2.update(0.1);
const recent = board.recent();
console.log("board days recorded:", recent.length, "| latest items:", recent[0]?.items.length ?? 0);
if (recent.length < 1) throw new Error("看板应至少记录 1 天");
if (!recent[0].items.length) throw new Error("看板当天应有条目");
const someSummary = Object.values(recent[0].summaries || {})[0];
console.log("sample personal summary:", someSummary);
if (!someSummary) throw new Error("应有个人小结");

console.log("ALL TESTS DONE");
