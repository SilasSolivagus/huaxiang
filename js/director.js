// 导演模块：驱动模拟时钟与日程，指挥所有 Agent 工作、开会、协作、休息。
//
// Agent 隔离设计（参照斯坦福 Generative Agents）：
//  - 每句 AI 发言都是"轮到的那个人"用自己的画像 + 自己的记忆 + 自己听到的话单独生成的（✨ 标记）
//  - 别人说的话只有在听力范围内才会写入某个 Agent 的记忆
//  - 每天下班前每人生成一条反思（🪞），作为高权重记忆影响第二天
//  - 世界模型（公司/产品/市场）的公告会进入所有人记忆，员工协作也会反过来影响产品指标
// 模型不可用时一切回退到画像中的内置台词池，模拟不会停。

import { DAILY_SCHEDULE } from "./personas.js";

const MINUTES_PER_SECOND = 2.2;   // 1 秒现实时间 = 2.2 分钟模拟时间（1x 速度）
const DAY_START = 9 * 60;          // 09:00
const DAY_END = 18.5 * 60;         // 18:30 下班

const HEAR_RADIUS_MEETING = 8;     // 会议室里大家都听得到
const HEAR_RADIUS_TALK = 4.5;      // 工位/咖啡角交谈的听力范围

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
   * @param {World|null} world 可选的世界模型
   */
  constructor(agents, office, log, llm = null, world = null, feed = null) {
    this.agents = agents;
    this.office = office;
    this.log = log;
    this.llm = llm;
    this.world = world;
    this.feed = feed;

    this.day = world?.day ?? 1;
    this.clockMin = DAY_START;
    this.simTime = 0;
    this.tasks = [];
    this.currentPhase = null;
    this.meetingSpeakerIdx = 0;
    this.nextMeetingTalk = 0;
    this.speechPending = false;
    this.meetingTranscript = [];
    this.nextCollab = 0;
    this.chatterTimers = agents.map(() => 2 + Math.random() * 8);
    this.collabBusy = new Set();
    this.reflected = false;

    this._schedule = DAILY_SCHEDULE.map(s => ({ ...s, min: parseTime(s.time) }))
      .sort((a, b) => a.min - b.min);

    this.broadcastDaily();
  }

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
    return this._schedule;
  }

  findAgent(name) {
    return this.agents.find(a => a.persona.name === name);
  }

  // ---------- 记忆写入工具 ----------

  /** 给单个 agent 写记忆（带模拟时间戳） */
  remember(agent, content, importance = 3, type = "obs") {
    agent.memory?.add(content, { importance, type, day: this.day, time: this.clockLabel });
  }

  /** 说话者发言后，把这句话写入说话者和听力范围内其他人的记忆 */
  broadcastHearing(speaker, text, radius, importance = 3) {
    this.remember(speaker, `我说：「${text}」`, Math.max(2, importance - 1), "said");
    const sp = speaker.group?.position;
    for (const other of this.agents) {
      if (other === speaker) continue;
      const op = other.group?.position;
      let inRange = true;
      if (sp && op) {
        inRange = Math.hypot(sp.x - op.x, sp.z - op.z) <= radius;
      }
      if (inRange) {
        this.remember(other, `听到 ${speaker.persona.name} 说：「${text}」`, importance, "heard");
      }
    }
  }

  /** 每天开工：公司公告 + 市场事件进入所有人的记忆 */
  broadcastDaily() {
    if (!this.world) return;
    for (const ev of this.world.todayEvents) {
      this.log(`📰 ${ev.text}`, "log-meeting");
    }
    const summary = this.world.metricsSummary();
    this.log(`📊 ${summary}`);
    for (const a of this.agents) {
      this.remember(a, `公司公告：${summary}`, 5, "world");
      for (const ev of this.world.todayEvents) {
        this.remember(a, `市场动态：${ev.text}`, 7, "world");
      }
    }
  }

  /** 真实市场事件白天实时到达：作为突发新闻插入当前模拟日 */
  injectBreakingNews(ev) {
    const text = ev.summary || ev.title || "";
    if (!text) return;
    this.log(`📡 突发：${text}`, "log-meeting");
    if (this.world) this.world.todayEvents.push({ id: ev.id, text, real: true });
    for (const a of this.agents) {
      this.remember(a, `市场快讯：${text}`, 7, "world");
    }
  }

  /** 上层决策发布/撤销：高权重公告进入全员记忆 */
  announcePolicyChange({ announced = [], revoked = [] }) {
    for (const p of announced) {
      this.log(`📣 管理层决策：${p.text}`, "log-meeting");
      for (const a of this.agents) {
        this.remember(a, `管理层决策：${p.text}`, 9, "world");
      }
    }
    if (revoked.length > 0) {
      this.log(`📣 管理层调整：有 ${revoked.length} 条决策被撤销`, "log-meeting");
      for (const a of this.agents) {
        this.remember(a, `管理层撤销了之前的一条决策`, 6, "world");
      }
    }
  }

  // ---------- 隔离式发言生成 ----------

  /**
   * 让 agent 以自己的视角说一句话：AI 可用时单独生成，否则用 fallback。
   * @returns 通过 onDone(text, isAI) 回调
   */
  speakSmart(agent, scene, fallback, { radius = HEAR_RADIUS_TALK, importance = 3, logCls = "", onDone = null } = {}) {
    const finish = (text, isAI) => {
      agent.say(text, isAI ? 5 : 4);
      this.log(`${isAI ? "✨ " : ""}${agent.persona.name}：${text}`, logCls);
      this.broadcastHearing(agent, text, radius, importance);
      onDone?.(text, isAI);
    };

    if (this.llm?.available && agent.memory) {
      const transcript = this.meetingTranscript.slice(-6);
      this.llm.speak({
        persona: agent.persona,
        company: this.world?.companyBrief(),
        policies: this.feed?.activePolicies() ?? [],
        memories: agent.memory.retrieve(scene, 6),
        scene,
        transcript
      }).then(text => {
        finish(text || fallback, !!text);
      });
    } else {
      finish(fallback, false);
    }
  }

  // ---------- 主更新 ----------

  update(dt) {
    this.simTime += dt;
    this.clockMin += dt * MINUTES_PER_SECOND;

    // 17:50 之后触发每日反思（一天一次）
    if (!this.reflected && this.clockMin >= 17 * 60 + 50) {
      this.reflected = true;
      this.runReflections();
    }

    // 一天结束，开始新的一天
    if (this.clockMin >= DAY_END) {
      this.world?.nextDay(this.feed?.takeEvents(3) ?? []);
      this.day = this.world?.day ?? this.day + 1;
      this.clockMin = DAY_START;
      this.currentPhase = null;
      this.tasks = [];
      this.collabBusy.clear();
      this.meetingTranscript = [];
      this.speechPending = false;
      this.reflected = false;
      this.log(`☀️ 第 ${this.day} 天开始了`, "log-meeting");
      this.broadcastDaily();
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
    this.meetingTranscript = [];
    this.speechPending = false;
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
        this.remember(a, `参加了${phase.label}`, 3, "event");
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

  // ---------- 会议：逐人独立发言 ----------

  meetingScene(phase) {
    const goal = phase.type === "standup"
      ? "每日站会，每人同步自己的进展、计划和遇到的问题"
      : "项目评审会，讨论产品现状、市场动态、风险和下一步计划";
    return `${goal}。今天是第 ${this.day} 个工作日。`;
  }

  runMeetingTalk() {
    if (this.simTime < this.nextMeetingTalk || this.speechPending) return;
    const phase = this.currentPhase;
    const speaker = this.agents[this.meetingSpeakerIdx % this.agents.length];
    this.meetingSpeakerIdx++;
    this.nextMeetingTalk = this.simTime + 5.5 + Math.random() * 3;
    if (speaker.isBusy) return;   // 还在走路就跳过这轮

    this.speechPending = true;
    const fallback = pick(speaker.persona.lines.meeting);
    this.speakSmart(speaker, this.meetingScene(phase), fallback, {
      radius: HEAR_RADIUS_MEETING,
      importance: 4,
      logCls: "log-meeting",
      onDone: (text) => {
        this.meetingTranscript.push(`${speaker.persona.name}：${text}`);
        this.speechPending = false;
      }
    });
  }

  // ---------- 工位自言自语 / 咖啡角闲聊 ----------

  runAmbientChatter(dt, pool) {
    this.agents.forEach((a, i) => {
      this.chatterTimers[i] -= dt;
      if (this.chatterTimers[i] <= 0) {
        this.chatterTimers[i] = 14 + Math.random() * 18;
        if (!a.isBusy && !this.collabBusy.has(a.persona.id)) {
          const line = pick(a.persona.lines[pool]);
          a.say(line, 4);
          // 闲聊也会被旁边的人听到（低重要度）
          this.broadcastHearing(a, line, 3.5, 2);
        }
      }
    });
  }

  // ---------- 随机协作：两人轮流、各自视角 ----------

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
    this.remember(visitor, `我主动去找 ${host.persona.name} 讨论工作`, 4, "event");
    this.remember(host, `${visitor.persona.name} 来我工位找我讨论工作`, 4, "event");

    visitor.standAt({ ...desk.standSpot, lookAt: desk.seat }, "talk");

    const scene = `工位旁的工作讨论：${visitor.persona.name} 走到 ${host.persona.name} 的工位。结合你记得的事情聊一个具体话题。`;
    const turn = (agent, fallbackPool) => {
      this.speakSmart(agent, scene, pick(fallbackPool), {
        radius: HEAR_RADIUS_TALK,
        importance: 4,
        logCls: "log-collab",
        onDone: (text) => this.meetingTranscript.push(`${agent.persona.name}：${text}`)
      });
    };

    this.after(4, () => {
      host.faceToward(desk.standSpot.x, desk.standSpot.z);
      host.setActivity(`和 ${visitor.persona.name} 讨论中`);
      visitor.setActivity(`和 ${host.persona.name} 讨论中`);
      this.meetingTranscript = [];   // 本次协作的对话上下文
      turn(visitor, visitor.persona.lines.collab);
    });
    this.after(10, () => turn(host, host.persona.lines.collab));
    this.after(16, () => turn(visitor, ["明白了，我去改！", "好，就这么定", "这个思路可以，搞起", "OK，同步完毕"]));
    this.after(20, () => {
      if (this.currentPhase?.type === "work") {
        visitor.setActivity("在工位专注工作");
        host.setActivity("在工位专注工作");
        visitor.sitAt({ ...ownDesk.seat, lookAt: ownDesk.lookAt }, "type");
        host.faceToward(desk.lookAt.x, desk.lookAt.z);
      }
      // 协作有概率修掉产品 bug，世界状态被员工的行为改变
      if (this.world?.onCollabDone()) {
        this.log(`🔧 ${visitor.persona.name} 和 ${host.persona.name} 的讨论修复了一个 Bug（剩 ${this.world.metrics.bugs} 个）`, "log-collab");
        this.remember(visitor, `和 ${host.persona.name} 一起修复了一个产品 Bug`, 5, "event");
        this.remember(host, `和 ${visitor.persona.name} 一起修复了一个产品 Bug`, 5, "event");
      }
      this.collabBusy.delete(visitor.persona.id);
      this.collabBusy.delete(host.persona.id);
    });
  }

  // ---------- 每日反思 ----------

  runReflections() {
    if (!this.llm?.enabled || this.llm.usage === "economy") return;
    for (const a of this.agents) {
      if (!a.memory) continue;
      const digest = a.memory.todayDigest(this.day);
      if (!digest) continue;
      const day = this.day;
      this.llm.reflect({
        persona: a.persona,
        company: this.world?.companyBrief(),
        digest,
        day
      }).then(text => {
        if (text) {
          a.memory.add(`今日反思：${text}`, { importance: 8, type: "reflect", day, time: "18:00" });
          this.log(`🪞 ${a.persona.name} 的反思：${text}`, "log-collab");
        }
      });
    }
  }
}
