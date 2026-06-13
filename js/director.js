// 导演模块：驱动模拟时钟与日程，指挥两个办公地点（产研区 rd / 运营区 ops）的 Agent
// 工作、开会、协作、休息。
//
// 两地点设计：
//  - 每个 Agent 有 persona.zone（rd / ops），各自在本区工位、本区会议室、本区咖啡角活动
//  - CTO（privateOffice）工作时在独立办公室，参加产研区会议
//  - CEO（remote）常驻运营区；约每月一次，CTO 跨区去运营区与 CEO 当面同步
//
// Agent 隔离设计（参照斯坦福 Generative Agents）：
//  - 每句 AI 发言都是"轮到的那个人"用自己的画像 + 自己的记忆 + 自己听到的话单独生成的（✨）
//  - 别人说的话只有在听力范围内才会写入某个 Agent 的记忆
//  - 每天下班前每人生成一条反思（🪞），作为高权重记忆影响第二天
//  - 世界模型（公司/产品/市场）公告进入所有人记忆，员工协作也会反过来影响产品指标
// 模型不可用时一切回退到画像中的内置台词池，模拟不会停。

import { DAILY_SCHEDULE } from "./personas.js";
import { buildItems, composeAgentSummary } from "./board.js";

const MINUTES_PER_SECOND = 2.2;   // 1 秒现实时间 = 2.2 分钟模拟时间（1x 速度）
const DAY_START = 9 * 60;          // 09:00
const DAY_END = 18.5 * 60;         // 18:30 下班

const HEAR_RADIUS_MEETING = 8;     // 会议室里大家都听得到
const HEAR_RADIUS_TALK = 4.5;      // 工位/咖啡角交谈的听力范围

const ZONES = ["rd", "ops"];

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
   * @param {object} office buildOffice 的返回值 { grid, rd, ops, ctoOffice, ceoHome }
   * @param {(msg: string, cls?: string) => void} log 事件日志回调
   * @param {LLMClient|null} llm 可选的模型客户端
   * @param {World|null} world 可选的世界模型
   * @param {Feed|null} feed 可选的真实数据源
   */
  constructor(agents, office, log, llm = null, world = null, feed = null, board = null) {
    this.agents = agents;
    this.office = office;
    this.log = log;
    this.llm = llm;
    this.world = world;
    this.feed = feed;
    this.board = board;

    this.todayRecord = freshRecord();   // 当日事实累积（给看板）
    this.todayHighlights = [];          // 当日会议/协作发言摘录（给看板 AI）

    this.day = world?.day ?? 1;
    this.clockMin = DAY_START;
    this.simTime = 0;
    this.tasks = [];
    this.currentPhase = null;
    this.meetState = { rd: freshMeet(), ops: freshMeet() };
    this.workSeat = new Map();      // agent -> { seat, lookAt, standSpot } 本工作阶段的座位
    this.nextCollab = 0;
    this.chatterTimers = agents.map(() => 2 + Math.random() * 8);
    this.collabBusy = new Set();
    this.reflected = false;
    this.ctoVisitDay = -1;          // 上次触发 CTO→CEO 月度同步的天

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

  /** 某个办公区的全体成员 */
  crewInZone(zone) {
    return this.agents.filter(a => (a.persona.zone || "rd") === zone);
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
    for (const ev of this.world.todayEvents) this.todayRecord.market.push(ev.text);
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
    this.todayRecord.breaking.push(text);
    for (const a of this.agents) {
      this.remember(a, `市场快讯：${text}`, 7, "world");
    }
  }

  /** 上层决策发布/撤销：高权重公告进入全员记忆 */
  announcePolicyChange({ announced = [], revoked = [] }) {
    for (const p of announced) {
      this.log(`📣 管理层决策：${p.text}`, "log-meeting");
      this.todayRecord.policies.push(p.text);
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
   * transcript 是这场对话/会议已经说过的话（用于上下文），各区/各场独立。
   */
  speakSmart(agent, scene, fallback, { radius = HEAR_RADIUS_TALK, importance = 3, logCls = "", transcript = [], onDone = null } = {}) {
    const finish = (text, isAI) => {
      agent.say(text, isAI ? 5 : 4);
      this.log(`${isAI ? "✨ " : ""}${agent.persona.name}：${text}`, logCls);
      this.broadcastHearing(agent, text, radius, importance);
      // 会议/协作的发言留作当日简报素材
      if (logCls === "log-meeting" || logCls === "log-collab") {
        this.todayHighlights.push(`${agent.persona.name}：${text}`);
        if (this.todayHighlights.length > 40) this.todayHighlights.shift();
      }
      onDone?.(text, isAI);
    };

    if (this.llm?.available && agent.memory) {
      this.llm.speak({
        persona: agent.persona,
        company: this.world?.companyBrief(),
        policies: this.feed?.activePolicies() ?? [],
        memories: agent.memory.retrieve(scene, 6),
        scene,
        transcript: transcript.slice(-6)
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
      this.runDailyDigest(this.day);   // 先沉淀今天的看板，再翻篇
      this.world?.nextDay(this.feed?.takeEvents(3) ?? []);
      this.day = this.world?.day ?? this.day + 1;
      this.clockMin = DAY_START;
      this.currentPhase = null;
      this.tasks = [];
      this.collabBusy.clear();
      this.meetState = { rd: freshMeet(), ops: freshMeet() };
      this.workSeat.clear();
      this.reflected = false;
      this.todayRecord = freshRecord();
      this.todayHighlights = [];
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

  // ---------- 阶段切换（按区放置）----------

  applyPhase(phase) {
    this.currentPhase = phase;
    this.collabBusy.clear();
    this.meetState = { rd: freshMeet(), ops: freshMeet() };
    this.workSeat.clear();

    if (phase.type === "work") {
      this.log(`💼 ${phase.time} ${phase.label}，各自回到工位`);
      for (const zone of ZONES) {
        const z = this.office[zone];
        let di = 0;
        for (const a of this.crewInZone(zone)) {
          let ws;
          if (a.persona.privateOffice) ws = this.office.ctoOffice;
          else if (a.persona.remote) ws = this.office.ceoHome;
          else ws = z.desks[di++ % z.desks.length];
          this.workSeat.set(a, ws);
          a.setActivity(a.persona.privateOffice ? "在独立办公室工作" : "在工位专注工作");
          this.after(Math.random() * 2, () => a.sitAt({ ...ws.seat, lookAt: ws.lookAt }, "type"));
        }
      }
      this.nextCollab = this.simTime + 8 + Math.random() * 10;
      // 月度 CTO→CEO 跨区同步：每 30 天，下午开工时触发一次
      if (this.day % 30 === 0 && this.ctoVisitDay !== this.day && phase.time === "13:00") {
        this.ctoVisitDay = this.day;
        this.after(6 + Math.random() * 4, () => this.startCtoCeoSync());
      }
    } else if (phase.type === "standup" || phase.type === "review") {
      this.log(`📋 ${phase.time} ${phase.label}开始，两个区各自进会议室`, "log-meeting");
      for (const zone of ZONES) {
        const seats = this.office[zone].meetingSeats;
        const crew = this.crewInZone(zone);
        crew.forEach((a, i) => {
          const seat = seats[i % seats.length];
          a.setActivity(`参加${phase.label}`);
          this.remember(a, `参加了${phase.label}`, 3, "event");
          this.after(Math.random() * 2.5, () => a.sitAt(seat, "sit"));
        });
        this.meetState[zone].idx = Math.floor(Math.random() * Math.max(1, crew.length));
        this.meetState[zone].next = this.simTime + 6;
      }
    } else if (phase.type === "lunch" || phase.type === "social") {
      const verb = phase.type === "lunch" ? "吃午饭" : "喝咖啡放松";
      this.log(`☕ ${phase.time} ${phase.label}，各区去咖啡角${verb}`);
      for (const zone of ZONES) {
        const spots = this.office[zone].coffeeSpots;
        this.crewInZone(zone).forEach((a, i) => {
          const spot = spots[i % spots.length];
          a.setActivity(phase.type === "lunch" ? "在咖啡角吃午饭" : "在咖啡角闲聊");
          this.after(Math.random() * 3, () => a.standAt(spot, "talk"));
        });
      }
    }
  }

  // ---------- 会议：两个区各自逐人独立发言 ----------

  meetingScene(phase, zone) {
    if (zone === "ops") {
      const goal = phase.type === "standup"
        ? "运营团队每日站会，同步运营数据、客服反馈和 B 端进展"
        : "运营团队评审会，复盘活动效果、用户口碑和商业化进展";
      return `${goal}。今天是第 ${this.day} 个工作日。`;
    }
    const goal = phase.type === "standup"
      ? "产研团队每日站会，每人同步进展、技术/产品计划和遇到的问题"
      : "产研团队项目评审会，讨论产品现状、市场动态、技术风险和下一步计划";
    return `${goal}。今天是第 ${this.day} 个工作日。`;
  }

  runMeetingTalk() {
    for (const zone of ZONES) {
      const st = this.meetState[zone];
      if (this.simTime < st.next || st.pending) continue;
      const crew = this.crewInZone(zone);
      if (crew.length === 0) continue;
      const speaker = crew[st.idx % crew.length];
      st.idx++;
      st.next = this.simTime + 5.5 + Math.random() * 3;
      if (speaker.isBusy) continue;
      st.pending = true;
      const fallback = pick(speaker.persona.lines.meeting);
      this.speakSmart(speaker, this.meetingScene(this.currentPhase, zone), fallback, {
        radius: HEAR_RADIUS_MEETING,
        importance: 4,
        logCls: "log-meeting",
        transcript: st.transcript,
        onDone: (text) => {
          st.transcript.push(`${speaker.persona.name}：${text}`);
          st.pending = false;
        }
      });
    }
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
          this.broadcastHearing(a, line, 3.5, 2);
          // 运营经理离谱偶尔甩锅，话传到产研团队耳朵里
          if (a.persona.id === "lipu" && pool === "work" && Math.random() < 0.4) {
            for (const r of this.crewInZone("rd")) {
              if (r.persona.id !== "he") {
                this.remember(r, `听说运营的离谱又在甩锅，说产研没配合好`, 4, "heard");
              }
            }
          }
        }
      }
    });
  }

  // ---------- 随机协作：同区两人轮流、各自视角 ----------

  maybeStartCollab() {
    if (this.simTime < this.nextCollab) return;
    this.nextCollab = this.simTime + 22 + Math.random() * 25;

    const zone = Math.random() < 0.7 ? "rd" : "ops";   // 产研区动作更多
    const free = this.crewInZone(zone).filter(a =>
      !this.collabBusy.has(a.persona.id) && !a.isBusy &&
      !a.persona.privateOffice && !a.persona.remote && this.workSeat.has(a));
    if (free.length < 2) return;
    const visitor = pick(free);
    const host = pick(free.filter(a => a !== visitor));
    if (!host) return;

    const desk = this.workSeat.get(host);
    const ownDesk = this.workSeat.get(visitor);

    this.collabBusy.add(visitor.persona.id);
    this.collabBusy.add(host.persona.id);

    visitor.setActivity(`去找 ${host.persona.name} 讨论`);
    this.log(`🤝 ${visitor.persona.name} 去找 ${host.persona.name} 协作讨论`, "log-collab");
    this.remember(visitor, `我主动去找 ${host.persona.name} 讨论工作`, 4, "event");
    this.remember(host, `${visitor.persona.name} 来我工位找我讨论工作`, 4, "event");

    visitor.standAt({ ...desk.standSpot, lookAt: desk.seat }, "talk");

    const tx = [];   // 本次协作的对话上下文
    const scene = `工位旁的工作讨论：${visitor.persona.name} 走到 ${host.persona.name} 的工位。结合你记得的事情聊一个具体话题。`;
    const turn = (agent, fallbackPool) => {
      this.speakSmart(agent, scene, pick(fallbackPool), {
        radius: HEAR_RADIUS_TALK,
        importance: 4,
        logCls: "log-collab",
        transcript: tx,
        onDone: (text) => tx.push(`${agent.persona.name}：${text}`)
      });
    };

    this.after(4, () => {
      host.faceToward(desk.standSpot.x, desk.standSpot.z);
      host.setActivity(`和 ${visitor.persona.name} 讨论中`);
      visitor.setActivity(`和 ${host.persona.name} 讨论中`);
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
      const bugFixed = !!this.world?.onCollabDone();
      if (bugFixed) {
        this.log(`🔧 ${visitor.persona.name} 和 ${host.persona.name} 的讨论修复了一个 Bug（剩 ${this.world.metrics.bugs} 个）`, "log-collab");
        this.remember(visitor, `和 ${host.persona.name} 一起修复了一个产品 Bug`, 5, "event");
        this.remember(host, `和 ${visitor.persona.name} 一起修复了一个产品 Bug`, 5, "event");
        this.todayRecord.bugsFixed++;
      }
      this.todayRecord.collabs.push({ visitor: visitor.persona.name, host: host.persona.name, bugFixed });
      this.collabBusy.delete(visitor.persona.id);
      this.collabBusy.delete(host.persona.id);
    });
  }

  // ---------- 月度：CTO 跨区去运营找 CEO 同步 ----------

  startCtoCeoSync() {
    const cto = this.agents.find(a => a.persona.privateOffice);
    const ceo = this.agents.find(a => a.persona.remote);
    if (!cto || !ceo) return;
    if (this.collabBusy.has(cto.persona.id) || this.collabBusy.has(ceo.persona.id)) return;
    if (this.currentPhase?.type !== "work") return;

    this.collabBusy.add(cto.persona.id);
    this.collabBusy.add(ceo.persona.id);
    const home = this.office.ceoHome;

    this.log(`🤝 ${cto.persona.name} 跨区去运营找 ${ceo.persona.name} 做月度同步`, "log-collab");
    this.remember(cto, `我去运营那边找 ${ceo.persona.name} 做月度同步`, 5, "event");
    this.remember(ceo, `${cto.persona.name} 过来跟我同步产研进展和重大决策`, 5, "event");
    cto.setActivity(`去运营找 ${ceo.persona.name} 同步`);
    cto.standAt({ ...home.standSpot, lookAt: home.seat }, "talk");

    const tx = [];
    const scene = `月度当面同步：${cto.persona.name}（CTO）来到运营这边，和 ${ceo.persona.name}（CEO）对一次产研进展、风险和重大决策。`;
    const turn = (agent, pool) => this.speakSmart(agent, scene, pick(pool), {
      radius: HEAR_RADIUS_TALK, importance: 5, logCls: "log-collab",
      transcript: tx, onDone: (t) => tx.push(`${agent.persona.name}：${t}`)
    });

    this.after(7, () => {
      ceo.faceToward(home.standSpot.x, home.standSpot.z);
      ceo.setActivity(`和 ${cto.persona.name} 同步`);
      cto.setActivity(`和 ${ceo.persona.name} 同步`);
      turn(ceo, ceo.persona.lines.meeting);
    });
    this.after(13, () => turn(cto, cto.persona.lines.meeting));
    this.after(19, () => turn(ceo, ["产研那边你盯着，我放心", "就按你说的来", "行，这事定了", "辛苦你跑一趟"]));
    this.after(25, () => {
      const office = this.office.ctoOffice;
      cto.setActivity("回独立办公室工作");
      cto.sitAt({ ...office.seat, lookAt: office.lookAt }, "type");
      ceo.faceToward(home.lookAt.x, home.lookAt.z);
      this.collabBusy.delete(cto.persona.id);
      this.collabBusy.delete(ceo.persona.id);
    });
  }

  // ---------- 每日看板简报 ----------

  /** 每个模拟日结束：沉淀每人当日小结 + 团队进展/决策/应对条目，写入看板 */
  runDailyDigest(day) {
    if (!this.board) return;
    const summaries = {};
    for (const a of this.agents) {
      if (!a.memory) continue;
      const items = a.memory.items.filter(m => m.day === day);
      if (items.length) summaries[a.persona.id] = composeAgentSummary(items);
    }
    const r = this.todayRecord;
    const facts =
      `市场动态：${[...r.breaking, ...r.market].join("；") || "无"}\n` +
      `管理层决策：${r.policies.join("；") || "无"}\n` +
      `今日修复 Bug：${r.bugsFixed} 个，协作 ${r.collabs.length} 次`;
    const fallback = buildItems(r);

    const commit = (items) => {
      const list = items && items.length ? items : fallback;
      this.board.recordDay(day, list, summaries);
      if (list.length) this.log(`📑 第 ${day} 天小结：${list.length} 条进展/决策/应对已入看板`, "log-meeting");
    };

    if (this.llm?.available) {
      this.llm.digestDay({ company: this.world?.companyBrief(), day, facts, highlights: this.todayHighlights })
        .then(items => commit(items))
        .catch(() => commit(null));
    } else {
      commit(null);
    }
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

function freshMeet() {
  return { idx: 0, next: 0, pending: false, transcript: [] };
}

function freshRecord() {
  return { market: [], breaking: [], policies: [], collabs: [], bugsFixed: 0 };
}
