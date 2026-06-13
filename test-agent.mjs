// 用假 canvas 桩在 Node 里烟雾测试 Agent 行为
const ctxStub = {
  fillStyle: "", font: "", textAlign: "",
  fillText() {}, measureText: (s) => ({ width: s.length * 15 }),
  clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
  arcTo() {}, closePath() {}, fill() {}
};
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub })
};

const THREE = await import("three");
const { buildOffice } = await import("./js/office.js");
const { Agent } = await import("./js/agent.js");
const { PERSONAS } = await import("./js/personas.js");

const scene = new THREE.Scene();
const office = buildOffice(scene);
const a = new Agent(PERSONAS[0], { scene, grid: office.grid });
a.setPosition(0, 6.4);

// 走到会议室座位并坐下
const seat = office.rd.meetingSeats[0];
a.sitAt(seat, "sit");
let steps = 0;
while (a.state !== "sitting" && steps < 5000) { a.update(0.05); steps++; }
console.log("reached seat:", a.state, "in", (steps * 0.05).toFixed(1), "sim-sec");
console.log("position:", a.group.position.x.toFixed(2), a.group.position.z.toFixed(2),
            "expected:", seat.x, seat.z);
if (Math.hypot(a.group.position.x - seat.x, a.group.position.z - seat.z) > 0.01) throw new Error("seat mismatch");

// 气泡
a.say("测试一条比较长的中文台词看看折行是否正常工作");
if (!a.bubble.sprite.visible) throw new Error("bubble not visible");
for (let i = 0; i < 200; i++) a.update(0.05);
if (a.bubble.sprite.visible) throw new Error("bubble did not hide");

// 起身走回工位
const desk = office.rd.desks[0];
a.sitAt({ ...desk.seat, lookAt: desk.lookAt }, "type");
steps = 0;
while (a.state !== "sitting" && steps < 5000) { a.update(0.05); steps++; }
console.log("back to desk:", a.state, "legs visible:", a.body.legs.visible);
console.log("AGENT TESTS PASSED");
