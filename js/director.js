// 导演模块：驱动模拟时钟与日程，指挥所有 Agent 工作、开会、协作、休息。

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
   */
  constructor(agents, office, log) {
    this.agents = agents;
    this.office = office;
    this.log = log;

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

    this.schedule = DAILY_SCHEDULE.map(s => ({ ...s, min: parseTime(s.time) }))
      .sort((a, b) => a.min - b.min);
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
    const { desks, meetingSeats, coffeeSpots } = this.office;

    if (phase.type === "work") {
      this.log(`💼 ${phase.time} ${phase.label}，大家回到工位`);
      this.agents.forEach((a, i) => {
        const desk = desks[i % desks.length];
        a.setActivity("在工位专注工作");
        this.after(Math.random() * 2, () => a.sitAt(desk.seat ? { ...desk.seat, lookAt: desk.lookAt } : desk, "type"));
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

  // ---------- 会议轮流发言 ----------
  runMeetingTalk() {
    if (this.simTime < this.nextMeetingTalk) return;
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

    // 协作对话脚本：来访者 → 主人 → 来访者，然后回工位
    this.after(4, () => {
      host.faceToward(desk.standSpot.x, desk.standSpot.z);
      host.setActivity(`和 ${visitor.persona.name} 讨论中`);
      visitor.setActivity(`和 ${host.persona.name} 讨论中`);
      visitor.say(pick(visitor.persona.lines.collab), 4);
    });
    this.after(9, () => {
      host.say(pick(host.persona.lines.collab), 4);
    });
    this.after(14, () => {
      visitor.say(pick(["明白了，我去改！", "好，就这么定", "这个思路可以，搞起", "OK，同步完毕"]), 3.5);
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
