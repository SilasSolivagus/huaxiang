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
import { minutesEmpty, minutesToText } from "./cognition/minutes.js";
import { newActionItem } from "./cognition/actionItems.js";
import { findCollabPair, planSummaryText } from "./cognition/plan.js";
import { shouldReflect, formatMemoriesWithIds } from "./cognition/reflect.js";
import { cosineTopK, bigramTopK } from "./cognition/react.js";

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
  constructor(agents, office, log, llm = null, world = null, feed = null, board = null, actionItems = null) {
    this.agents = agents;
    this.office = office;
    this.log = log;
    this.llm = llm;
    this.world = world;
    this.feed = feed;
    this.board = board;
    this.actionItems = actionItems;
    this.pendingMarketFeedback = [];   // 上一日市场反馈，次日开工广播进全员记忆
    this.todayMarketFeedback = [];      // 昨夜市场反馈文本（供今日计划快照）

    this.todayRecord = freshRecord();   // 当日事实累积（给看板）
    this.todayHighlights = [];          // 当日会议/协作发言摘录（给看板 AI）
    this.repoDigest = null;          // 每日仓库摘要（来自 sidecar）

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
    this.runDailyPlans();
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
    if (this.pendingMarketFeedback.length) {
      // 只广播「产生日早于今天」的反馈——确保市场反馈确定性地次日才回流，而非依赖异步时序
      const ready = this.pendingMarketFeedback.filter(f => f.day < this.day);
      this.todayMarketFeedback = ready.map(f => f.text);
      for (const f of ready) {
        this.log(`💬 市场反馈：${f.text}`, "log-meeting");
        for (const a of this.agents) this.remember(a, `市场反馈：${f.text}`, 7, "world");
      }
      this.pendingMarketFeedback = this.pendingMarketFeedback.filter(f => f.day >= this.day);
    }
  }

  /** 从 feed 摄入真实仓库状态：分析指标喂给世界模型，摘要存下来注入会议 */
  async refreshRepoState() {
    if (!this.feed) return;
    try {
      const a = await this.feed.analysis?.();
      if (a && this.world) this.world.applyAnalysis(a);
      const d = await this.feed.repoDigest?.();
      if (d) this.repoDigest = d;
    } catch { /* sidecar 不可用：保持纯模拟，不注入 */ }
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
    this.runReactions(text);
  }

  /** 突发事件：挑最相关的 2 人各做一次反应，其余人只有公告记忆。 */
  runReactions(text) {
    if (!this.llm?.enabled || this.llm.usage === "economy") return;
    this.rankAgentsByRelevance(text).then(ranked => {
      for (const a of ranked.slice(0, 2)) {
        this.llm.react({ persona: a.persona, company: this.world?.companyBrief?.(), event: text })
          .then(r => { if (r) this.applyReaction(a, r, text); })
          .catch(() => {});
      }
    }).catch(() => {});
  }

  /** 按事件与各人画像的相关度排序（embedding 余弦优先，离线回退 bigram）。 */
  async rankAgentsByRelevance(text) {
    const personas = this.agents.map(a => `${a.persona.role}。${a.persona.personality || ""}`);
    let vecs = null;
    if (this.feed?.embed) {
      try { vecs = await this.feed.embed([text, ...personas]); } catch { vecs = null; }
    }
    const order = (Array.isArray(vecs) && vecs.length === personas.length + 1)
      ? cosineTopK(vecs[0], vecs.slice(1), this.agents.length)
      : bigramTopK(text, personas, this.agents.length);
    return order.map(i => this.agents[i]);
  }

  /** 应用一个轻动作（不移动 3D 身体）：说话+广播+记忆，按 action 产生跨人/查代码效果。 */
  applyReaction(a, r, text) {
    const u = r.utterance;
    if (u) {
      a.say?.(u, 5);
      this.log(`⚡ ${a.persona.name}（对突发反应）：${u}`, "log-collab");
      this.broadcastHearing(a, u, HEAR_RADIUS_TALK, 5);
    }
    this.remember(a, `我对突发「${text.slice(0, 18)}…」的反应：${u || r.action}`, 6, "event");
    if (r.action === "investigate_repo" && this.feed?.repoGrep) {
      const term = DOMAIN_TERMS[Math.floor(Math.random() * DOMAIN_TERMS.length)];
      this.feed.repoGrep(term).then(hits => {
        const note = codeRefNote(hits);
        if (note) this.remember(a, `因突发去查了代码${note}`, 5, "event");
      }).catch(() => {});
    } else if (r.action === "call_meeting") {
      this.log(`📣 ${a.persona.name} 提议就这事碰个短会`, "log-meeting");
      for (const o of this.crewInZone(a.persona.zone || "rd")) {
        if (o !== a) this.remember(o, `${a.persona.name} 提议就「${text.slice(0, 16)}」碰个短会`, 5, "heard");
      }
    } else if (r.action === "goto_colleague") {
      this.log(`🤝 ${a.persona.name} 想找人对一下这事`, "log-collab");
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
      agent.memory.retrieve(scene, 6).then(memories =>
        this.llm.speak({
          persona: agent.persona,
          company: this.world?.companyBrief(),
          policies: this.feed?.activePolicies() ?? [],
          memories,
          scene,
          transcript: transcript.slice(-6)
        })
      ).then(text => {
        finish(text || fallback, !!text);
      }).catch(() => finish(fallback, false));
    } else {
      finish(fallback, false);
    }
  }

  /**
   * 多轮讨论的一轮发言（仿 speakSmart，但回调带 done 让调用方决定是否继续）。
   * 返回 Promise 便于测试 await。无 llm 时说 fallback、done=false。
   */
  converseTurn(agent, scene, fallback, { radius = HEAR_RADIUS_TALK, importance = 4, logCls = "", transcript = [], onTurn = null } = {}) {
    const finish = (text, isAI, done) => {
      if (text) {
        agent.say(text, isAI ? 5 : 4);
        this.log(`${isAI ? "✨ " : ""}${agent.persona.name}：${text}`, logCls);
        this.broadcastHearing(agent, text, radius, importance);
        if (logCls === "log-meeting" || logCls === "log-collab") {
          this.todayHighlights.push(`${agent.persona.name}：${text}`);
          if (this.todayHighlights.length > 40) this.todayHighlights.shift();
        }
      }
      onTurn?.(text, done);
    };
    if (this.llm?.available && agent.memory) {
      return agent.memory.retrieve(scene, 6).then(memories =>
        this.llm.converseTurn({
          persona: agent.persona,
          company: this.world?.companyBrief(),
          policies: this.feed?.activePolicies() ?? [],
          memories, scene, transcript: transcript.slice(-6)
        })
      ).then(res => {
        const r = res || {};
        finish(r.utterance || fallback, !!r.utterance, !!r.done);
      }).catch(() => finish(fallback, false, false));
    }
    finish(fallback, false, false);
    return Promise.resolve();
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
      const shipped = this.actionItems ? this.actionItems.advance(this.day + 1) : [];
      this.world?.nextDay(this.feed?.takeEvents(3) ?? [], shipped.length);
      this.day = this.world?.day ?? this.day + 1;
      this.runMarketReaction(shipped);
      this.clockMin = DAY_START;
      this.currentPhase = null;
      this.tasks = [];
      this.collabBusy.clear();
      // 会议纪要在「离开会议相位」时已收割（见 update 的相位切换钩子）；这里直接重置即可。
      // 隐式契约：日程里每个会议相位后都跟一个非会议相位且早于 DAY_END——若将来把会议排到收尾，需在此先收割。
      this.meetState = { rd: freshMeet(), ops: freshMeet() };
      this.workSeat.clear();
      this.reflected = false;
      this.todayRecord = freshRecord();
      this.todayHighlights = [];
      this.log(`☀️ 第 ${this.day} 天开始了`, "log-meeting");
      this.refreshRepoState().then(() => { this.broadcastDaily(); this.runDailyPlans(); });
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
      if (this.currentPhase && (this.currentPhase.type === "standup" || this.currentPhase.type === "review")) {
        this.finishMeetings(this.currentPhase);
      }
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
    const base = `${goal}。今天是第 ${this.day} 个工作日。`;
    return this.repoDigest ? `${base}\n代码仓库近况：${this.repoDigest}` : base;
  }

  runMeetingTalk() {
    for (const zone of ZONES) {
      const st = this.meetState[zone];
      if (this.simTime < st.next || st.pending) continue;
      const crew = this.crewInZone(zone);
      if (crew.length === 0) continue;
      if (!st.done) st.done = new Set();
      if (st.done.size >= crew.length) continue;   // 全员都表示没有补充，会议安静收尾
      // 轮转挑下一个还没说"完"、且不忙的人
      let speaker = null, tries = 0;
      while (tries < crew.length) {
        const cand = crew[st.idx % crew.length];
        st.idx++;
        tries++;
        if (!st.done.has(cand.persona.id) && !cand.isBusy) { speaker = cand; break; }
      }
      if (!speaker) continue;
      st.next = this.simTime + 5.5 + Math.random() * 3;
      st.pending = true;
      const fallback = pick(speaker.persona.lines.meeting);
      this.converseTurn(speaker, this.meetingScene(this.currentPhase, zone), fallback, {
        radius: HEAR_RADIUS_MEETING,
        importance: 4,
        logCls: "log-meeting",
        transcript: st.transcript,
        onTurn: (text, done) => {
          st.transcript.push(`${speaker.persona.name}：${text}`);
          if (done) st.done.add(speaker.persona.id);
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
    let visitor, host, planTopic = "";
    const pair = findCollabPair(free, a => (a.plan?.day === this.day ? a.plan : null));
    if (pair) {
      visitor = pair.visitor; host = pair.host; planTopic = pair.topic || "";
    } else {
      visitor = pick(free);
      host = pick(free.filter(a => a !== visitor));
    }
    if (!host) return;

    const desk = this.workSeat.get(host);
    const ownDesk = this.workSeat.get(visitor);

    this.collabBusy.add(visitor.persona.id);
    this.collabBusy.add(host.persona.id);
    const startDay = this.day;   // 跨天/相位切换后悬挂的 converse 链据此丢弃，防"复活"到新一天

    visitor.setActivity(`去找 ${host.persona.name} 讨论`);
    this.log(`🤝 ${visitor.persona.name} 去找 ${host.persona.name} 协作讨论`, "log-collab");
    this.remember(visitor, `我主动去找 ${host.persona.name} 讨论工作`, 4, "event");
    this.remember(host, `${visitor.persona.name} 来我工位找我讨论工作`, 4, "event");

    visitor.standAt({ ...desk.standSpot, lookAt: desk.seat }, "talk");

    const tx = [];   // 本次协作的对话上下文
    let codeNote = "";
    if (zone === "rd" && this.feed?.repoGrep) {
      const term = DOMAIN_TERMS[Math.floor(Math.random() * DOMAIN_TERMS.length)];
      this.feed.repoGrep(term).then(hits => { codeNote = codeRefNote(hits); }).catch(() => {});
    }
    const sceneBase = `工位旁的工作讨论：${visitor.persona.name} 走到 ${host.persona.name} 的工位。` +
      (planTopic ? `${visitor.persona.name}今天本就计划找人聊「${planTopic}」。` : "") +
      `结合你记得的事情聊一个具体话题。`;
    // 多轮 converse：每轮发言者自行决定是否说完，上限 6 轮（无 llm 回退定轮台词，3 轮收尾）
    const maxTurns = this.llm?.available ? 6 : 3;
    const speakers = [visitor, host];
    const closers = ["明白了，我去改！", "好，就这么定", "这个思路可以，搞起", "OK，同步完毕"];
    let turnNo = 0;

    const finishCollab = () => {
      // 已跨天或 collabBusy 已被相位切换/日终清空：这是悬挂链的迟到回调，丢弃，别动旧工位/重复计 bug
      if (this.day !== startDay || !this.collabBusy.has(visitor.persona.id)) return;
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
    };

    const runConverseTurn = () => {
      // 已跨天或 collabBusy 已清：丢弃悬挂的 converse 链，不再发言/排程
      if (this.day !== startDay || !this.collabBusy.has(visitor.persona.id)) return;
      const speaker = speakers[turnNo % 2];
      const isLast = turnNo >= maxTurns - 1;
      const fallback = isLast ? pick(closers) : pick(speaker.persona.lines.collab);
      this.converseTurn(speaker, sceneBase + codeNote, fallback, {
        radius: HEAR_RADIUS_TALK,
        importance: 4,
        logCls: "log-collab",
        transcript: tx,
        onTurn: (text, done) => {
          tx.push(`${speaker.persona.name}：${text}`);
          turnNo++;
          if (done || turnNo >= maxTurns) this.after(4, finishCollab);
          else this.after(4.5 + Math.random() * 2.5, runConverseTurn);
        }
      });
    };

    this.after(4, () => {
      host.faceToward(desk.standSpot.x, desk.standSpot.z);
      host.setActivity(`和 ${visitor.persona.name} 讨论中`);
      visitor.setActivity(`和 ${host.persona.name} 讨论中`);
      runConverseTurn();
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

  // ---------- 每日反思（反思树）----------

  /** 下班前：重要度累积过阈值者，从近期记忆提问→逐题生成带证据洞见，存为反思记忆（全员入队）。 */
  runReflections() {
    if (!this.llm?.enabled || this.llm.usage === "economy") return;
    const company = this.world?.companyBrief?.();
    for (const a of this.agents) {
      if (!a.memory || !shouldReflect(a.memory.items)) continue;
      const day = this.day;
      const memories = formatMemoriesWithIds(a.memory.items);
      const validIds = a.memory.items.filter(m => m.id != null).map(m => m.id);
      this.llm.reflectQuestions({ persona: a.persona, company, memories })
        .then(questions => {
          if (!questions || !questions.length) return;
          for (const q of questions.slice(0, 3)) {
            this.llm.reflectInsight({ persona: a.persona, company, question: q, memories })
              .then(r => {
                if (!r || !r.insight) return;
                const evidence = r.evidence.filter(id => validIds.includes(id));
                a.memory.add(`反思：${r.insight}`, { importance: 8, type: "reflect", day, time: "18:00", evidence });
                const cite = evidence.length ? `（依据 #${evidence.join("、#")}）` : "";
                this.log(`🪞 ${a.persona.name}：${r.insight}${cite}`, "log-collab");
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }
  }

  // ---------- 会议纪要：离开会议相位时收割本场发言 ----------

  /** 两个区分别根据本场发言记录生成结构化纪要。返回 Promise（便于测试 await）。 */
  finishMeetings(phase) {
    const jobs = [];
    for (const zone of ZONES) {
      const transcript = this.meetState[zone]?.transcript ?? [];
      if (transcript.length < 2) continue;   // 实质讨论太少，不值得成文
      jobs.push(this.runMeetingMinutes(zone, phase, transcript.slice()));
    }
    return Promise.all(jobs);
  }

  /** 调模型生成一区纪要 → 写产出物库 + 行动项进负责人记忆 + 日志。 */
  runMeetingMinutes(zone, phase, transcript) {
    if (!this.llm?.available) return Promise.resolve();
    const day = this.day;
    const scene = this.meetingScene(phase, zone);
    return this.llm.minutes({ company: this.world?.companyBrief(), day, scene, transcript })
      .then(m => {
        if (minutesEmpty(m)) return;
        this.feed?.writeArtifact?.({
          type: "minutes", day, content: minutesToText(m),
          meta: { zone, phase: phase.label, decisions: m.decisions, risks: m.risks, actionItems: m.actionItems }
        });
        const crew = this.crewInZone(zone);
        for (const item of m.actionItems) {
          const owner = item.owner ? this.findAgent(item.owner) : null;
          if (owner && crew.includes(owner)) {
            this.remember(owner, `行动项（${phase.label}）：${item.what}`, 7, "action");
          }
          this.actionItems?.add(newActionItem({ what: item.what, owner: item.owner, zone, day }));
        }
        this.log(`📋 ${phase.label}纪要：${m.decisions.length} 决议 / ${m.risks.length} 风险 / ${m.actionItems.length} 行动项`, "log-meeting");
      })
      .catch(() => {});
  }

  /** 每日开工：每人基于反思+今晨快照+名下未完成行动项定计划，挂到 agent 并写高权重记忆。 */
  runDailyPlans() {
    if (!this.llm?.enabled || this.llm.usage === "economy") return;
    const company = this.world?.companyBrief?.();
    const policies = this.feed?.activePolicies?.() ?? [];
    const snapshot = [
      this.world?.metricsSummary?.(),
      this.world?.todayEvents?.length ? "今日动态：" + this.world.todayEvents.map(e => e.text).join("；") : "",
      this.todayMarketFeedback?.length ? "昨夜市场反馈：" + this.todayMarketFeedback.join("；") : "",
      policies.length ? "现行政策：" + policies.join("；") : "",
      this.repoDigest ? "代码近况：" + this.repoDigest : ""
    ].filter(Boolean).join("\n");
    const day = this.day;
    for (const a of this.agents) {
      if (!a.memory) continue;
      const reflection = lastReflection(a);
      const openItems = (this.actionItems?.openFor(a.persona.name) ?? []).map(i => i.what);
      this.llm.dailyPlan({ persona: a.persona, company, reflection, snapshot, openItems })
        .then(plan => {
          if (!plan || !plan.intentions.length) return;
          if (a.plan?.day === day) return;   // 当日已生成，跳过重复
          a.plan = { ...plan, day };
          this.remember(a, `今日计划：${planSummaryText(plan)}`, 7, "plan");
        })
        .catch(() => {});
    }
  }

  /** 日终市场反应：上线改进喂模型 → 指标增量落到 world + 市场反馈排进次日全员记忆。 */
  runMarketReaction(shipped = []) {
    if (!this.llm?.available || !this.world) return Promise.resolve();
    const shippedTexts = shipped.map(s => s.what);
    return this.llm.marketReaction({
      company: this.world.companyBrief?.(),
      day: this.day,
      metrics: this.world.metricsSummary?.(),
      shipped: shippedTexts,
      realEvents: (this.world.todayEvents || []).map(e => e.text),
      policies: this.feed?.activePolicies?.() ?? []
    }).then(r => {
      if (!r) return;
      this.world.applyMarketDeltas(r.deltas);
      // 打上产生日（当前已是新一天）：次日 broadcastDaily 才会回流进全员记忆
      if (r.competitorMove) this.pendingMarketFeedback.push({ day: this.day, text: r.competitorMove });
      for (const fb of r.feedback) this.pendingMarketFeedback.push({ day: this.day, text: fb });
      const reason = r.reasons[0] ? `（${r.reasons[0]}）` : "";
      this.log(`📈 市场反应：满意度 ${fmtDelta(r.deltas.sat)}、日活 ${fmtDelta(r.deltas.dau)}${reason}`, "log-meeting");
    }).catch(() => {});
  }
}

function freshMeet() {
  return { idx: 0, next: 0, pending: false, transcript: [], done: new Set() };
}

function freshRecord() {
  return { market: [], breaking: [], policies: [], collabs: [], bugsFixed: 0 };
}

const DOMAIN_TERMS = ["限速", "带宽", "直链", "上传", "下载", "分享", "存储", "会员"];

function fmtDelta(n) {
  const v = Number(n) || 0;
  return v > 0 ? `+${v}` : `${v}`;
}

function lastReflection(agent) {
  const items = agent.memory?.items?.filter(m => m.type === "reflect") ?? [];
  const last = items[items.length - 1];
  return last ? String(last.c).replace(/^(今日反思|反思)：/, "") : "";
}

export function codeRefNote(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return "";
  const h = hits[0];
  if (!h || !h.file) return "";
  return `（讨论中翻了下代码：${h.file}:${h.line} ${String(h.text || "").trim().slice(0, 40)}）`;
}
