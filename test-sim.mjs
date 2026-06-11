import * as THREE from "three";
import { buildOffice } from "./js/office.js";
import { PERSONAS, DAILY_SCHEDULE } from "./js/personas.js";
import { Director } from "./js/director.js";

const scene = new THREE.Scene();
const office = buildOffice(scene);
console.log("office built: desks=%d meetingSeats=%d coffeeSpots=%d",
  office.desks.length, office.meetingSeats.length, office.coffeeSpots.length);

// ---- 寻路测试：所有关键点位两两可达 ----
const pts = [
  ...office.desks.map(d => d.seat),
  ...office.desks.map(d => d.standSpot),
  ...office.meetingSeats,
  ...office.coffeeSpots,
  ...office.wanderSpots,
  { x: 0, z: 6.4 } // 出生点
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
console.log("sample logs:", logs.slice(0, 6).join(" | "));
const a0 = agents[0];
console.log("agent0 calls:", JSON.stringify(a0.calls));
const phases = new Set();
for (const s of DAILY_SCHEDULE) phases.add(s.type);
console.log("schedule phases:", [...phases].join(","));
console.log("ALL TESTS DONE");
