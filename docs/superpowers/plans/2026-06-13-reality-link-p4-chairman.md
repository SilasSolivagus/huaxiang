# 现实连接 P4（董事长化身：进入世界）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户以「董事长」化身进入这个 3D 世界：① 点击任一 Agent 发起**单独面谈**——化身走过去，你打的话进入对方（及听力范围内同事）的高权重记忆，对方当场回应；② 对全员**讲话**（如会议/公司级指令）——所有人记住。你的话作为高权重记忆，会被对方后续的发言/反思检索到，真正影响他之后的言行（这也是斯坦福论文评估 Agent 的「采访」方法）。产出物浏览已由现有「进展看板」覆盖（按天的进展/决策/应对 + 个人小结），本期不另做。

**Architecture:** director 新增 chairman 方法（`recordChairmanLine` 按位置写入听力范围记忆、`interview` 触发对方回应、`chairmanBroadcast` 全员）——纯记忆/回应逻辑，可单测。前端 main.js 复用现有 `Agent` 类造一个**非自主**的化身（金色，不进 director 的自主循环、不进点击拾取），由用户操作走动；profile 卡加「面谈」入口 + 内联输入框，另有一个常驻「董事长讲话」输入条对全员喊话。化身的 3D 走动与 DOM 对话框是浏览器层（无头环境跑不了），只做 `node --check` + 手动冒烟。

**Tech Stack:** 纯前端 ES Module + 现有 Agent/Director；沿用 `test-*.mjs`。

**约定：**
- 当前分支 main；本计划在新分支 `feature/p4-chairman` 执行，每任务一 commit
- 化身不进 `agents` 数组（不被 director 自主驱动）、不进 `pickMeshes`（点它不弹卡片）
- 你的话用高权重（importance 8）写入记忆，type 标 `"chairman"`，自动被记忆检索影响后续
- commit message 末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: director 化身方法（记忆/回应逻辑）

**Files:**
- Modify: `js/director.js`
- Test: 追加到 `test-world.mjs`

- [ ] **Step 1: 在 `test-world.mjs` 末尾（ALL WORLD TESTS PASSED 之前，StubAgent 定义之后）追加失败测试**

```js
// ---- 董事长化身：面谈 / 全员讲话 进入记忆并触发回应 ----
const w7 = new World(DEFAULT_COMPANY);
const ag7 = PERSONAS.slice(0, 3).map((p, i) => new StubAgent(p, "c" + i));
const logs7 = [];
const d7 = new Director(ag7, office, (m) => logs7.push(m), null, w7);

// 面谈：目标记住董事长的话（高权重），并触发一次回应
let replied = null;
d7.interview(ag7[0], "你们这季度最该解决的问题是什么？", (text) => { replied = text; });
const mem0 = ag7[0].memory.items;
const cl = mem0.find(m => m.c.includes("董事长说") && m.c.includes("最该解决"));
if (!cl) throw new Error("面谈内容应进入对方记忆");
if (cl.imp < 8) throw new Error("董事长的话应为高权重（>=8）");
if (cl.type !== "chairman") throw new Error("应标记 type=chairman");
if (replied === null) throw new Error("面谈应触发对方回应（onReply 回调）");
if (!logs7.some(l => l.includes("👔"))) throw new Error("面谈应打日志");

// 全员讲话：所有人都记住
d7.chairmanBroadcast("从今天起，稳定性高于一切");
for (const a of ag7) {
  if (!a.memory.items.some(m => m.c.includes("稳定性高于一切") && m.imp >= 8)) {
    throw new Error("全员讲话应进入每个人的高权重记忆");
  }
}
console.log("董事长化身验证 ✓");
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/silas/huaxiang && node test-world.mjs`
Expected: FAIL（`d7.interview is not a function`）

- [ ] **Step 3: 修改 `js/director.js`，在 `announcePolicyChange` 方法之后新增三个方法**

```js
  // ---------- 董事长化身：用户进入世界 ----------

  /** 董事长在某位置开口：听力范围内的 Agent 记住（高权重） */
  recordChairmanLine(text, pos, { radius = HEAR_RADIUS_TALK, importance = 8 } = {}) {
    for (const a of this.agents) {
      const op = a.group?.position;
      let inRange = true;
      if (pos && op) inRange = Math.hypot(pos.x - op.x, pos.z - op.z) <= radius;
      if (inRange) this.remember(a, `董事长说：「${text}」`, importance, "chairman");
    }
  }

  /** 单独面谈：把董事长的话写进对方（及近旁同事）记忆，并触发对方回应 */
  interview(target, text, onReply = null) {
    if (!target || !text) return;
    this.log(`👔 董事长对 ${target.persona.name} 说：${text}`, "log-meeting");
    this.recordChairmanLine(text, target.group?.position, { radius: HEAR_RADIUS_TALK, importance: 8 });
    const scene = `董事长来到你面前单独面谈，刚对你说：「${text}」。请你以本人身份认真回应董事长。`;
    this.speakSmart(target, scene, pick(target.persona.lines.meeting), {
      radius: HEAR_RADIUS_TALK, importance: 6, logCls: "log-meeting", onDone: onReply
    });
  }

  /** 对全员讲话（会议发言 / 公司级指令）：所有人高权重记住 */
  chairmanBroadcast(text) {
    if (!text) return;
    this.log(`👔 董事长发言：${text}`, "log-meeting");
    for (const a of this.agents) this.remember(a, `董事长说：「${text}」`, 8, "chairman");
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /Users/silas/huaxiang && node test-world.mjs && node test-sim.mjs`
Expected: 含 `董事长化身验证 ✓` 与 `ALL WORLD TESTS PASSED`；test-sim 正常

- [ ] **Step 5: Commit**

```bash
cd /Users/silas/huaxiang
git add js/director.js test-world.mjs
git commit -m "feat(director): chairman interview / broadcast into agent memory"
```

---

### Task 2: main.js 造化身实体

**Files:**
- Modify: `js/main.js`

- [ ] **Step 1: 在 `js/main.js` 创建 agents 之后（约第 83-96 行 `const agents = personas.map(...)` 块之后、`const pickMeshes` 之前）插入化身创建**

```js
// 董事长化身：复用 Agent 类，但不加入自主 agents 数组、不加入点击拾取
const chairmanPersona = {
  id: "chairman", name: "董事长", role: "董事长",
  color: 0xffce54, skin: 0xf2c9a4, hair: 0x2a2a2a,
  personality: "公司董事长，偶尔到场视察、面谈、发话。",
  lines: { work: ["继续"], meeting: ["大家辛苦"], collab: ["嗯"], coffee: ["随便聊聊"] }
};
const chairman = new Agent(chairmanPersona, sceneWorld);
chairman.setPosition(0, 7);   // 从门口入场
```

- [ ] **Step 2: 在主循环 tick 里更新化身**

找到 `for (const a of agents) a.update(dt);`（约第 394 行），在其后加：

```js
    chairman.update(dt);
```

- [ ] **Step 3: 语法检查**

Run: `cd /Users/silas/huaxiang && node --check js/main.js && echo "main.js OK"`
Expected: main.js OK

- [ ] **Step 4: Commit**

```bash
cd /Users/silas/huaxiang
git add js/main.js
git commit -m "feat(frontend): chairman avatar entity (non-autonomous)"
```

---

### Task 3: 化身交互 UI（面谈 + 全员讲话）

**Files:**
- Modify: `index.html`
- Modify: `css/style.css`
- Modify: `js/main.js`

- [ ] **Step 1: 在 `index.html` 的 profile 卡里加「面谈」入口与内联输入**

找到 profile-card 里 `<button id="profile-close">✕</button>` 之后、`profile-summary-title` 之前，加入面谈区（放在 profile-status 之后即可）。具体：在 `<div id="profile-status"></div>` 之后插入：

```html
      <div id="profile-talk-row">
        <button id="profile-talk-btn">👔 面谈</button>
      </div>
      <div id="profile-talk-box" class="hidden">
        <input id="profile-talk-input" type="text" placeholder="以董事长身份对 TA 说…" maxlength="100" />
        <button id="profile-talk-send">说</button>
      </div>
```

并在 profile-card 之外（比如 `#hint` 之前）加一个常驻的「董事长讲话」条：

```html
    <div id="chairman-bar">
      <span class="cb-icon">👔</span>
      <input id="chairman-input" type="text" placeholder="董事长对全员讲话（如开会发话）…" maxlength="120" />
      <button id="chairman-send">讲话</button>
    </div>
```

- [ ] **Step 2: 在 `css/style.css` 末尾追加样式**

```css
/* ---------- 董事长化身交互 ---------- */
#profile-talk-row { margin-top: 10px; }
#profile-talk-btn, #chairman-send, #profile-talk-send {
  border: none; border-radius: 8px; padding: 5px 12px; cursor: pointer;
  background: #ffce54; color: #1a1d24; font-size: 12px; font-weight: 600;
}
#profile-talk-box { margin-top: 8px; display: flex; gap: 6px; }
#profile-talk-box.hidden { display: none; }
#profile-talk-input { flex: 1; min-width: 0; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); color: #e8edf4; padding: 5px 8px; font-size: 12px; }

#chairman-bar {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: 14px;
  display: flex; gap: 8px; align-items: center; z-index: 13;
  background: rgba(20, 24, 32, 0.85); backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 206, 84, 0.4); border-radius: 999px; padding: 6px 10px;
}
.cb-icon { font-size: 14px; }
#chairman-input { width: 280px; max-width: 50vw; border: none; background: transparent; color: #e8edf4; font-size: 13px; outline: none; }
@media (max-width: 640px) { #chairman-bar { width: calc(100vw - 24px); } #chairman-input { width: auto; flex: 1; } }
```

- [ ] **Step 3: 在 `js/main.js` 接线面谈与讲话**

在 `selectAgent` / profile 相关代码附近（`profile-close` 监听之后）加入面谈逻辑：

```js
// ---------- 董事长面谈 ----------
const talkBtn = document.getElementById("profile-talk-btn");
const talkBox = document.getElementById("profile-talk-box");
const talkInput = document.getElementById("profile-talk-input");

talkBtn.addEventListener("click", () => {
  if (!selectedAgent) return;
  talkBox.classList.remove("hidden");
  talkInput.focus();
  // 化身走到对方附近
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

// 关闭卡片时收起面谈输入
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
```

注意：`profile-close` 已有一个点击监听（清空 selectedAgent、隐藏卡片）；新增的这个监听是**追加**（addEventListener 可叠加），只负责收起面谈框，不要删除或覆盖原监听。

- [ ] **Step 4: 语法检查**

Run: `cd /Users/silas/huaxiang && node --check js/main.js && echo "main.js OK"`
Expected: main.js OK

- [ ] **Step 5: 手动冒烟（真机浏览器，sidecar 托管）**

```bash
cd /Users/silas/huaxiang/sidecar && lsof -ti :7878 | xargs kill 2>/dev/null; nohup node --env-file-if-exists=.env src/server.js > /tmp/p4-smoke.log 2>&1 & sleep 2
echo "打开 http://127.0.0.1:7878/ 手动验证"
```
浏览器验证：① 金色董事长化身在场；② 点某个小人 → 卡片出现「👔 面谈」→ 点它，化身走过去 → 输入框出现，打字回车 → 化身气泡显示你的话、对方气泡回应、右下角日志出现 👔 行；③ 底部「董事长讲话」条输入回车 → 全员收到（日志 👔）；④ 点开对方记忆流，能看到「董事长说：「…」」。完成后 `kill %1`。

- [ ] **Step 6: Commit**

```bash
cd /Users/silas/huaxiang
git add index.html css/style.css js/main.js
git commit -m "feat(frontend): chairman interview + broadcast UI"
```

---

### Task 4: README + 全量回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 `README.md` 的竞品监控那段 `>` 之后追加**

```markdown
> 你也能进去：页面里有一个金色的「董事长」化身。点任一同事 → 卡片上点「👔 面谈」，化身会走过去，你打的话进入对方（及旁边同事）的**高权重记忆**、对方当场回应；底部「董事长讲话」条可对全员喊话（比如开会发话）。你的话会被对方之后的发言和反思检索到，真正影响他后面的言行——这也是斯坦福生成式 Agent 论文里「采访 Agent」的玩法。
```

- [ ] **Step 2: 全量回归**

```bash
cd /Users/silas/huaxiang && for t in test-board test-feed test-world test-sim test-agent; do printf "%s: " "$t"; node $t.mjs 2>/dev/null | tail -1; done
cd /Users/silas/huaxiang/sidecar && node --test 2>&1 | grep -E "^# (pass|fail)"
cd /Users/silas/huaxiang && node --check js/main.js && echo "main.js OK"
```
Expected: 前端 5 脚本全绿（test-world 含「董事长化身验证 ✓」）；sidecar 仍 55 pass（未改动）；main.js 语法 OK。

- [ ] **Step 3: Commit**

```bash
cd /Users/silas/huaxiang
git add README.md
git commit -m "docs: chairman avatar (interview + broadcast)"
```

---

## 验收清单（对照 spec P4）

- [x] 用户角色化身（董事长，3D 在场，非自主）（Task 2）
- [x] 单独面谈：化身走到对方、你的话进高权重记忆、对方回应（Task 1, 3）
- [x] 参加会议/全员讲话：对全员高权重广播（Task 1, 3）
- [x] 你的话影响后续：高权重记忆被检索/反思采纳（Task 1，自动经现有记忆系统）
- [x] 产出物浏览：由现有「进展看板」覆盖（按天进展/决策/应对 + 个人小结），本期不另做
- 浏览器层（3D 化身走动、DOM 对话）仅 `node --check` + 手动冒烟，逻辑层（director 方法）已单测
