// 入口：渲染器、相机、灯光、交互与主循环。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { loadConfig, runtimePersonas } from "./store.js";
import { LLMClient } from "./llm.js";
import { World } from "./world.js";
import { MemoryStream } from "./memory.js";
import { buildOffice } from "./office.js";
import { Agent } from "./agent.js";
import { Director } from "./director.js";
import { Feed } from "./feed.js";
import { Board } from "./board.js";
import { ActionItemStore } from "./cognition/actionItems.js";
import { addActivity } from "./activityLog.js";

// 从管理后台保存的配置加载人物画像、模型设置与公司设定
const config = loadConfig();
const personas = runtimePersonas(config);
const llm = new LLMClient(config.model);
const world = new World(config.company);

// ---------- 渲染器 ----------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 更柔和、更有层次的影调
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b3340);
scene.fog = new THREE.Fog(0x2b3340, 52, 96);

// 室内环境光照（PBR 反射），低多边形也能立刻通透有质感
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ---------- 相机与控制 ----------
const camera = new THREE.PerspectiveCamera(
  50, window.innerWidth / window.innerHeight, 0.1, 120
);
camera.position.set(0, 21, 20);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6;
controls.maxDistance = 54;
controls.maxPolarAngle = Math.PI / 2 - 0.1;
controls.enablePan = true;

// ---------- 灯光 ----------
// 暖色天光 + 冷色地面反光，营造室内氛围
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x39414e, 0.55));
// 主光（暖）：投影覆盖整个加宽后的场景
const sun = new THREE.DirectionalLight(0xffe8c4, 2.1);
sun.position.set(14, 24, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22;
sun.shadow.camera.right = 22;
sun.shadow.camera.top = 16;
sun.shadow.camera.bottom = -16;
sun.shadow.camera.far = 72;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
// 补光（冷）：压暗面提亮，减少死黑
const fill = new THREE.DirectionalLight(0xbcd4ff, 0.45);
fill.position.set(-12, 14, -10);
scene.add(fill);

// ---------- 场景与人物 ----------
const office = buildOffice(scene);
const sceneWorld = { scene, grid: office.grid };

// 初始按办公区分散落位（南侧靠墙），随后第一个工作阶段各自走到工位
let rdSpawn = 0, opsSpawn = 0;
const agents = personas.map((p) => {
  const a = new Agent(p, sceneWorld);
  if ((p.zone || "rd") === "ops") {
    a.setPosition(4 + (opsSpawn % 4) * 2.4, 6.6);
    opsSpawn++;
  } else {
    a.setPosition(-15 + (rdSpawn % 6) * 2.4, 6.7);
    rdSpawn++;
  }
  // 每个 Agent 一条独立的记忆流（隔离的核心）
  a.memory = new MemoryStream(p.id);
  return a;
});

// 董事长化身：复用 Agent 类，但不加入自主 agents 数组、不加入点击拾取
const chairmanPersona = {
  id: "chairman", name: "董事长", role: "董事长",
  color: 0xffce54, skin: 0xf2c9a4, hair: 0x2a2a2a,
  personality: "公司董事长，偶尔到场视察、面谈、发话。",
  lines: { work: ["继续"], meeting: ["大家辛苦"], collab: ["嗯"], coffee: ["随便聊聊"] }
};
const chairman = new Agent(chairmanPersona, sceneWorld);
chairman.setPosition(0, 7);   // 从门口入场

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
let director = null;   // Director 构造期间就会调用 log，先声明再赋值
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
  addActivity({ day: director ? director.day : world.day, time: director ? director.clockLabel : "09:00", text: msg, cls });
}

log(`☀️ 第 ${world.day} 天开始了，团队陆续到岗`, "log-meeting");
const feed = new Feed();
const board = new Board();
const actionItems = new ActionItemStore();
director = new Director(agents, office, log, llm, world, feed, board, actionItems);
board.onUpdate = () => renderBoard();

// 给每个 Agent 的记忆流接上 sidecar 本地 embedding（离线自动回退 bigram）
for (const a of agents) {
  if (a.memory) a.memory.setEmbedder(texts => feed.embed(texts));
}

feed.onBreaking = ev => director.injectBreakingNews(ev);
feed.onPolicyChange = ch => director.announcePolicyChange(ch);
feed.onStatus = on => {
  const chip = document.getElementById("feed-chip");
  if (!chip) return;
  chip.textContent = on ? "📡数据" : "📡离线";
  chip.classList.toggle("on", on);
  chip.title = on
    ? "已连接本地 sidecar，真实市场动态实时进入办公室"
    : "未检测到 sidecar，运行纯虚构模式（启动方式见 README）";
};
feed.connect().then(ok => {
  if (!ok) return;
  director.refreshRepoState();   // 开局补摄入真实仓库指标与摘要（构造时 feed 尚未连上）
  log("📡 已连接本地数据服务，真实市场动态将实时进入办公室", "log-meeting");
  // 开场把积压的真实事件（最多 2 条）作为突发新闻陆续放出
  feed.takeEvents(2).forEach((ev, i) => {
    setTimeout(() => director.injectBreakingNews(ev), 4000 + i * 9000);
  });
});
if (llm.enabled) {
  log(`✨ AI 对话已启用（${config.model.model}），会议和协作将实时生成对话`, "log-collab");
}

// AI 状态指示
const aiChip = document.getElementById("ai-chip");
if (aiChip) {
  aiChip.textContent = llm.enabled ? "✨AI" : "AI关";
  aiChip.classList.toggle("on", llm.enabled);
  aiChip.title = llm.enabled
    ? `AI 对话已启用：${config.model.model}`
    : "AI 对话未启用，点击右侧 ⚙ 进入管理后台配置模型";
}

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
  renderSummary(a);
}

// 个人当日小结（来自看板）
function renderSummary(a) {
  const box = document.getElementById("profile-summary");
  if (!box) return;
  const s = board.summaryFor(a.persona.id);
  box.textContent = s ? `第${s.day}天：${s.text}` : "今天还没有小结，下班后生成。";
}

document.getElementById("profile-close").addEventListener("click", () => {
  selectedAgent = null;
  profileCard.classList.add("hidden");
});

// ---------- 董事长面谈 ----------
const talkBtn = document.getElementById("profile-talk-btn");
const talkBox = document.getElementById("profile-talk-box");
const talkInput = document.getElementById("profile-talk-input");

talkBtn.addEventListener("click", () => {
  if (!selectedAgent) return;
  talkBox.classList.remove("hidden");
  talkInput.focus();
  const p = selectedAgent.group.position;
  chairman.goTo({ x: p.x + 1.2, z: p.z + 1.2 }, () => chairman.faceToward(p.x, p.z));
});

function sendInterview() {
  const text = talkInput.value.trim();
  if (!text || !selectedAgent) return;
  chairman.say(text, 5);
  director.interview(selectedAgent, text);
  talkInput.value = "";
}
document.getElementById("profile-talk-send").addEventListener("click", sendInterview);
talkInput.addEventListener("keydown", e => { if (e.key === "Enter") sendInterview(); });

document.getElementById("profile-close").addEventListener("click", () => {
  talkBox.classList.add("hidden");
});

// ---------- 董事长全员讲话 ----------
const cInput = document.getElementById("chairman-input");
function sendBroadcast() {
  const text = cInput.value.trim();
  if (!text) return;
  chairman.say(text, 5);
  director.chairmanBroadcast(text);
  cInput.value = "";
}
document.getElementById("chairman-send").addEventListener("click", sendBroadcast);
cInput.addEventListener("keydown", e => { if (e.key === "Enter") sendBroadcast(); });

// 选中人物的记忆流展示（隔离的可视化：每个人记得的事情各不相同）
function renderMemories(a) {
  const box = document.getElementById("profile-memories");
  if (!box || !a.memory) return;
  const items = a.memory.recent(5);
  box.innerHTML = items.length === 0
    ? '<div class="mem-empty">还没有记忆</div>'
    : items.map(m =>
        `<div class="mem-item${m.type === "reflect" ? " mem-reflect" : ""}">` +
        `<span class="mem-time">第${m.day}天 ${m.time}</span>${escapeHtml(m.c)}</div>`
      ).join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

// ---------- 进展看板 ----------
const boardPanel = document.getElementById("board");
const TYPE_CLASS = { "进展": "bi-progress", "决策": "bi-decision", "应对": "bi-response" };

function renderBoard() {
  const list = document.getElementById("board-list");
  const empty = document.getElementById("board-empty");
  if (!list) return;
  const days = board.recent(8);
  if (days.length === 0) {
    empty.style.display = "";
    list.innerHTML = "";
  } else {
    empty.style.display = "none";
    list.innerHTML = days.map(d =>
      `<div class="board-day"><div class="board-day-h">第 ${d.day} 天</div>` +
      d.items.map((it, i) =>
        `<div class="board-item${board.isNew(d.day, i) ? " is-new" : ""}">` +
        `<span class="bi-tag ${TYPE_CLASS[it.type] || ""}">${it.type}</span>` +
        `${escapeHtml(it.text)}</div>`
      ).join("") + `</div>`
    ).join("");
  }
  // 未看条目数角标（仅在面板收起时提示）
  const badge = document.getElementById("board-new");
  const n = board.newCount();
  if (n > 0 && boardPanel.classList.contains("collapsed")) {
    badge.textContent = n;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

document.getElementById("board-toggle").addEventListener("click", () => {
  boardPanel.classList.toggle("collapsed");
  const collapsed = boardPanel.classList.contains("collapsed");
  document.getElementById("board-toggle").textContent = collapsed ? "＋" : "－";
  if (!collapsed) { board.markSeen(); }   // 展开即视为已看
  renderBoard();
});

// 手机默认收起看板
if (window.innerWidth < 640) {
  boardPanel.classList.add("collapsed");
  document.getElementById("board-toggle").textContent = "＋";
}
renderBoard();

// ---------- 公司仪表盘 ----------
const dash = {
  panel: document.getElementById("dashboard"),
  name: document.getElementById("dash-company"),
  product: document.getElementById("dash-product"),
  metrics: document.getElementById("dash-metrics"),
  events: document.getElementById("dash-events")
};

if (dash.panel) {
  dash.name.textContent = `🏢 ${world.company.name}`;
  dash.product.textContent = world.company.product;
  document.getElementById("dash-toggle").addEventListener("click", () => {
    dash.panel.classList.toggle("collapsed");
    document.getElementById("dash-toggle").textContent =
      dash.panel.classList.contains("collapsed") ? "＋" : "－";
  });
  // 手机上默认收起
  if (window.innerWidth < 640) {
    dash.panel.classList.add("collapsed");
    document.getElementById("dash-toggle").textContent = "＋";
  }
}

function renderDashboard() {
  if (!dash.panel) return;
  const m = world.metrics;
  dash.metrics.innerHTML =
    metric("日活", m.dau.toLocaleString()) +
    metric("满意度", `${m.sat} 分`, m.sat < 60 ? "bad" : m.sat > 80 ? "good" : "") +
    metric(world.bugsReal ? "Bug📂" : "Bug", `${m.bugs} 个`, m.bugs > 22 ? "bad" : m.bugs < 8 ? "good" : "") +
    metric("服务器", m.serverOk ? "正常" : "故障", m.serverOk ? "good" : "bad") +
    metric("现金跑道", `${m.runway} 个月`, m.runway < 6 ? "bad" : "");
  dash.events.innerHTML = world.todayEvents
    .map(e => `<div class="dash-event">${e.real ? "📡" : "🎭"} ${escapeHtml(e.text)}</div>`)
    .join("");
}

function metric(label, value, cls = "") {
  return `<div class="dash-metric ${cls}"><span>${label}</span><b>${value}</b></div>`;
}

renderDashboard();

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
    chairman.update(dt);
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
    renderDashboard();
    if (selectedAgent) { renderMemories(selectedAgent); renderSummary(selectedAgent); }
  }

  controls.update();
  renderer.render(scene, camera);
}

tick();
