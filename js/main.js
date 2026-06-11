// 入口：渲染器、相机、灯光、交互与主循环。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PERSONAS } from "./personas.js";
import { buildOffice } from "./office.js";
import { Agent } from "./agent.js";
import { Director } from "./director.js";

// ---------- 渲染器 ----------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x232936);
scene.fog = new THREE.Fog(0x232936, 32, 60);

// ---------- 相机与控制 ----------
const camera = new THREE.PerspectiveCamera(
  50, window.innerWidth / window.innerHeight, 0.1, 100
);
camera.position.set(0, 15, 14.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 34;
controls.maxPolarAngle = Math.PI / 2 - 0.1;
controls.enablePan = true;

// ---------- 灯光 ----------
scene.add(new THREE.HemisphereLight(0xffffff, 0x55606e, 0.85));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
sun.position.set(9, 16, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -16;
sun.shadow.camera.right = 16;
sun.shadow.camera.top = 16;
sun.shadow.camera.bottom = -16;
sun.shadow.camera.far = 45;
sun.shadow.bias = -0.0005;
scene.add(sun);

// ---------- 场景与人物 ----------
const office = buildOffice(scene);
const world = { scene, grid: office.grid };

const agents = PERSONAS.map((p, i) => {
  const a = new Agent(p, world);
  // 初始从办公室门口（南侧）走进来
  a.setPosition(-1 + i * 0.8, 6.4);
  return a;
});

// 用于点击拾取
const pickMeshes = [];
agents.forEach(a => {
  a.group.traverse(obj => {
    if (obj.isMesh) {
      obj.userData.agent = a;
      pickMeshes.push(obj);
    }
  });
});

// ---------- 事件日志 ----------
const logBody = document.getElementById("event-log-body");
function log(msg, cls = "") {
  const item = document.createElement("div");
  item.className = `log-item ${cls}`;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = director ? director.clockLabel : "09:00";
  item.appendChild(time);
  item.appendChild(document.createTextNode(msg));
  logBody.prepend(item);
  while (logBody.children.length > 60) logBody.lastChild.remove();
}

const director = new Director(agents, office, log);
log("☀️ 第 1 天开始了，团队陆续到岗", "log-meeting");

// ---------- 顶部 UI ----------
const timeLabel = document.getElementById("time-label");
const dayLabel = document.getElementById("day-label");
const phaseLabel = document.getElementById("phase-label");

let simSpeed = 1;
document.querySelectorAll("#speed-controls button").forEach(btn => {
  btn.addEventListener("click", () => {
    simSpeed = Number(btn.dataset.speed);
    document.querySelectorAll("#speed-controls button")
      .forEach(b => b.classList.toggle("active", b === btn));
  });
});

document.getElementById("log-toggle").addEventListener("click", () => {
  const el = document.getElementById("event-log");
  el.classList.toggle("collapsed");
  document.getElementById("log-toggle").textContent =
    el.classList.contains("collapsed") ? "＋" : "－";
});

// ---------- 成员栏 ----------
const roster = document.getElementById("roster");
const chipActivity = new Map();
agents.forEach(a => {
  const chip = document.createElement("div");
  chip.className = "roster-chip";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = `#${a.persona.color.toString(16).padStart(6, "0")}`;
  dot.textContent = a.persona.name[0];
  const info = document.createElement("span");
  info.textContent = a.persona.name;
  const act = document.createElement("span");
  act.className = "activity";
  chip.append(dot, info, act);
  chip.addEventListener("click", () => selectAgent(a));
  roster.appendChild(chip);
  chipActivity.set(a, act);
});

// ---------- 人物卡片 ----------
const profileCard = document.getElementById("profile-card");
let selectedAgent = null;

function selectAgent(a) {
  selectedAgent = a;
  profileCard.classList.remove("hidden");
  const avatar = document.getElementById("profile-avatar");
  avatar.style.background = `#${a.persona.color.toString(16).padStart(6, "0")}`;
  avatar.textContent = a.persona.name[0];
  document.getElementById("profile-name").textContent = a.persona.name;
  document.getElementById("profile-role").textContent = a.persona.role;
  document.getElementById("profile-personality").textContent = a.persona.personality;
}

document.getElementById("profile-close").addEventListener("click", () => {
  selectedAgent = null;
  profileCard.classList.add("hidden");
});

// ---------- 点击拾取人物 ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;

renderer.domElement.addEventListener("pointerdown", e => {
  downPos = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener("pointerup", e => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 8) return; // 拖动视角，不算点击
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickMeshes, false);
  if (hits.length > 0 && hits[0].object.userData.agent) {
    selectAgent(hits[0].object.userData.agent);
  }
});

// ---------- 提示自动隐藏 ----------
setTimeout(() => {
  const hint = document.getElementById("hint");
  if (hint) hint.style.opacity = "0";
}, 8000);

// ---------- 自适应 ----------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- 主循环 ----------
const clock = new THREE.Clock();
let uiTimer = 0;

function tick() {
  requestAnimationFrame(tick);
  const realDt = Math.min(clock.getDelta(), 0.05);
  const dt = realDt * simSpeed;

  if (dt > 0) {
    director.update(dt);
    for (const a of agents) a.update(dt);
  }

  // 选中人物时镜头轻轻跟随
  if (selectedAgent) {
    const p = selectedAgent.group.position;
    controls.target.lerp(new THREE.Vector3(p.x, 0.6, p.z), 0.04);
    document.getElementById("profile-status").textContent =
      `📍 ${selectedAgent.activity}`;
  }

  // 低频刷新 UI
  uiTimer += realDt;
  if (uiTimer > 0.5) {
    uiTimer = 0;
    timeLabel.textContent = director.clockLabel;
    dayLabel.textContent = `第 ${director.day} 天`;
    phaseLabel.textContent = director.phaseLabel;
    for (const a of agents) chipActivity.get(a).textContent = a.activity;
  }

  controls.update();
  renderer.render(scene, camera);
}

tick();
