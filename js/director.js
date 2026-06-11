// 导演模块：驱动模拟时钟与日程，指挥所有 Agent 工作、开会、协作、休息。
// 若传入已启用的 LLMClient，会议发言与协作讨论将由模型根据画像实时生成（带 ✨ 标记），
// 模型不可用时自动回退到画像中的内置台词池。

import { DAILY_SCHEDULE } from "./personas.js";

const MINUTES_PER_SECOND = 2.2;   // 1 秒现实时间 = 2.2 分钟模拟时间（1x 速度）
const DAY_START = 9 * 60;          // 09:00
const DAY_END = 18.5 * 60;         // 18:30 下班

function parseTime(str) {
  const [h, m] = str.split(":").map(Number);
  return h * 60 + m;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class Director {
  /**
   * @param {Agent[]} agents
   * @param {object} office buildOffice 的返回值
   * @param {(msg: string, cls?: string) => void} log 事件日志回调
   * @param {LLMClient|null} llm 可选的模型客户端
   */
  constructor(agents, office, log, llm = null) {
    this.agents = agents;
    this.office = office;
    this.log = log;
    this.llm = llm;

    this.day = 1;
    this.clockMin = DAY_START;       // 当前模拟时间（分钟）
    this.simTime = 0;                // 累计模拟秒数（用于定时任务）
    this.tasks = [];                 // { at, fn } 定时任务队列
    this.currentPhase = null;
    this.meetingSpeakerIdx = 0;
    this.nextMeetingTalk = 0;
    this.nextCollab = 0;
    this.chatterTimers = agents.map(() => 2 + Math.random() * 8);
    this.collabBusy = new Set();     // 正在协作中的 agent id
    this.meetingScript = [];         // AI 生成的会议发言队列
    this.meetingScriptToken = 0;     // 防止过期请求写入
  }

  /** 延迟 delay 模拟秒后执行 fn */
  after(delay, fn) {
    this.tasks.push({ at: this.simTime + delay, fn });
  }

  get clockLabel() {
    const h = Math.floor(this.clockMin / 60);
    const m = Math.floor(this.clockMin % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  get phaseLabel() {
    return this.currentPhase ? this.currentPhase.label : "工作时间";
  }

  get schedule() {
    if (!this._schedule) {
      this._schedule = DAILY_SCHEDULE.map(s => ({ ...s, min: parseTime(s.time) }))
        .sort((a, b) => a.min - b.min);
    }
    return this._schedule;
  }

  findAgent(name) {
    return this.agents.find(a => a.persona.name === name);
  }

  /** 主更新入口，dt 为已乘过速度倍率的模拟秒 */
  update(dt) {
    this.simTime += dt;
    this.clockMin += dt * MINUTES_PER_SECOND;

    // 一天结束，开始新的一天
    if (this.clockMin >= DAY_END) {
      this.day += 1;
      this.clockMin = DAY_START;
      this.currentPhase = null;
      this.tasks = [];
      this.collabBusy.clear();
      this.meetingScript = [];
      this.log(`☀️ 第 ${this.day} 天开始了`, "log-meeting");
    }

    // 执行到期的定时任务
    if (this.tasks.length > 0) {
      const due = this.tasks.filter(t => t.at <= this.simTime);
      this.tasks = this.tasks.filter(t => t.at > this.simTime);
      for (const t of due) t.fn();
    }

    // 检查日程切换
    let active = this.schedule[0];
    for (const s of this.schedule) {
      if (this.clockMin >= s.min) active = s;
    }
    if (!this.currentPhase || this.currentPhase.label !== active.label) {
      this.applyPhase(active);
    }

    // 阶段持续行为
    const type = this.currentPhase?.type;
    if (type === "standup" || type === "review") {
      this.runMeetingTalk();
    } else if (type === "work") {
      this.runAmbientChatter(dt, "work");
      this.maybeStartCollab();
    } else if (type === "lunch" || type === "social") {
      this.runAmbientChatter(dt, "coffee");
    }
  }

  // ---------- 阶段切换 ----------
  applyPhase(phase) {
    this.currentPhase = phase;
    this.collabBusy.clear();
    this.meetingScript = [];
    this.meetingScriptToken++;
    const { desks, meetingSeats, coffeeSpots } = this.office;

    if (phase.type === "work") {
      this.log(`💼 ${phase.time} ${phase.label}，大家回到工位`);
      this.agents.forEach((a, i) => {
        const desk = desks[i % desks.length];
        a.setActivity("在工位专注工作");
        this.after(Math.random() * 2, () => a.sitAt({ ...desk.seat, lookAt: desk.lookAt }, "type"));
      });
      this.nextCollab = this.simTime + 8 + Math.random() * 10;
    } else if (phase.type === "standup" || phase.type === "review") {
      this.log(`📋 ${phase.time} ${phase.label}开始，全员前往会议室`, "log-meeting");
      this.agents.forEach((a, i) => {
        const seat = meetingSeats[i % meetingSeats.length];
        a.setActivity(`参加${phase.label}`);
        this.after(Math.random() * 2.5, () => a.sitAt(seat, "sit"));
      });
      this.meetingSpeakerIdx = Math.floor(Math.random() * this.agents.length);
      this.nextMeetingTalk = this.simTime + 6;
      this.requestMeetingScript(phase);
    } else if (phase.type === "lunch" || phase.type === "social") {
      const verb = phase.type === "lunch" ? "吃午饭" : "喝咖啡放松";
      this.log(`☕ ${phase.time} ${phase.label}，大家去咖啡角${verb}`);
      this.agents.forEach((a, i) => {
        const spot = coffeeSpots[i % coffeeSpots.length];
        a.setActivity(phase.type === "lunch" ? "在咖啡角吃午饭" : "在咖啡角闲聊");
        this.after(Math.random() * 3, () => a.standAt(spot, "talk"));
      });
    }
  }

  // ---------- AI 生成会议剧本 ----------
  requestMeetingScript(phase) {
    if (!this.llm?.enabled) return;
    const token = this.meetingScriptToken;
    const participants = this.agents.map(a => a.persona);
    this.llm.dialogue({
      scene: `办公室${phase.label}（${phase.type === "standup" ? "每人同步进展和遇到的问题" : "评审项目方案，讨论风险和改进点"}），今天是团队的第 ${this.day} 个工作日`,
      participants,
      turns: Math.min(10, this.agents.length * 2)
    }).then(turns => {
      if (turns && token === this.meetingScriptToken) {
        this.meetingScript = turns;
      }
    });
  }

  // ---------- 会议轮流发言 ----------
  runMeetingTalk() {
    if (this.simTime < this.nextMeetingTalk) return;

    // 优先消费 AI 剧本
    const scripted = this.meetingScript.shift();
    if (scripted) {
      const speaker = this.findAgent(scripted.name);
      if (speaker && !speaker.isBusy) {
        speaker.say(scripted.text, 5);
        this.log(`✨ ${speaker.persona.name}：${scripted.text}`, "log-meeting");
        this.nextMeetingTalk = this.simTime + 5.5 + Math.random() * 2;
        return;
      }
    }

    // 回退：内置台词轮流发言
    const speaker = this.agents[this.meetingSpeakerIdx % this.agents.length];
    if (!speaker.isBusy) {
      const line = pick(speaker.persona.lines.meeting);
      speaker.say(line, 4.5);
      this.log(`${speaker.persona.name}：${line}`, "log-meeting");
    }
    this.meetingSpeakerIdx++;
    this.nextMeetingTalk = this.simTime + 5 + Math.random() * 3;
  }

  // ---------- 工位自言自语 / 咖啡角闲聊 ----------
  runAmbientChatter(dt, pool) {
    this.agents.forEach((a, i) => {
      this.chatterTimers[i] -= dt;
      if (this.chatterTimers[i] <= 0) {
        this.chatterTimers[i] = 14 + Math.random() * 18;
        if (!a.isBusy && !this.collabBusy.has(a.persona.id)) {
          a.say(pick(a.persona.lines[pool]), 4);
        }
      }
    });
  }

  // ---------- 随机协作事件 ----------
  maybeStartCollab() {
    if (this.simTime < this.nextCollab) return;
    this.nextCollab = this.simTime + 22 + Math.random() * 25;

    const free = this.agents.filter(a => !this.collabBusy.has(a.persona.id) && !a.isBusy);
    if (free.length < 2) return;
    const visitor = pick(free);
    const host = pick(free.filter(a => a !== visitor));
    if (!host) return;

    const hostIdx = this.agents.indexOf(host);
    const desk = this.office.desks[hostIdx % this.office.desks.length];
    const visitorIdx = this.agents.indexOf(visitor);
    const ownDesk = this.office.desks[visitorIdx % this.office.desks.length];

    this.collabBusy.add(visitor.persona.id);
    this.collabBusy.add(host.persona.id);

    visitor.setActivity(`去找 ${host.persona.name} 讨论`);
    this.log(`🤝 ${visitor.persona.name} 去找 ${host.persona.name} 协作讨论`, "log-collab");

    visitor.standAt({ ...desk.standSpot, lookAt: desk.seat }, "talk");

    // 尝试用 AI 生成三句对话（来访者 → 主人 → 来访者），不可用则用台词池
    let script = null;
    if (this.llm?.enabled) {
      this.llm.dialogue({
        scene: `${visitor.persona.name} 走到 ${host.persona.name} 的工位讨论工作`,
        participants: [visitor.persona, host.persona],
        turns: 3,
        order: [visitor.persona.name, host.persona.name, visitor.persona.name]
      }).then(turns => { script = turns; });
    }

    const sayTurn = (agent, idx, fallback) => {
      const text = script?.[idx]?.text || fallback;
      agent.say(text, 4);
      if (script?.[idx]) {
        this.log(`✨ ${agent.persona.name}：${text}`, "log-collab");
      }
    };

    this.after(4, () => {
      host.faceToward(desk.standSpot.x, desk.standSpot.z);
      host.setActivity(`和 ${visitor.persona.name} 讨论中`);
      visitor.setActivity(`和 ${host.persona.name} 讨论中`);
      sayTurn(visitor, 0, pick(visitor.persona.lines.collab));
    });
    this.after(9, () => {
      sayTurn(host, 1, pick(host.persona.lines.collab));
    });
    this.after(14, () => {
      sayTurn(visitor, 2, pick(["明白了，我去改！", "好，就这么定", "这个思路可以，搞起", "OK，同步完毕"]));
    });
    this.after(18, () => {
      // 仅当仍处于工作阶段才返回工位（期间可能切到开会等阶段）
      if (this.currentPhase?.type === "work") {
        visitor.setActivity("在工位专注工作");
        host.setActivity("在工位专注工作");
        visitor.sitAt({ ...ownDesk.seat, lookAt: ownDesk.lookAt }, "type");
        host.faceToward(desk.lookAt.x, desk.lookAt.z);
      }
      this.collabBusy.delete(visitor.persona.id);
      this.collabBusy.delete(host.persona.id);
    });
  }
}
