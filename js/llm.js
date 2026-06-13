// LLM 客户端：为每个 Agent 独立生成第一人称发言与每日反思。
// 隔离原则：每次调用只携带"这个人自己的画像 + 他自己检索出的记忆 + 他听到的对话"，
// 模型扮演单个角色，而不是上帝视角写整场剧本。
//
// 提供商：
//   anthropic — Claude API（浏览器直连，需 anthropic-dangerous-direct-browser-access 头）
//   openai    — OpenAI 兼容接口（DeepSeek、Kimi、通义、智谱等，填对应 baseUrl）
// 内置串行队列 + 限流 + 出错冷却：不可用时返回 null，调用方回退内置台词。

import { normalizeMinutes } from "./cognition/minutes.js";
import { normalizeMarketReaction } from "./cognition/market.js";
import { normalizePlan } from "./cognition/plan.js";
import { parseQuestions, parseInsight } from "./cognition/reflect.js";

const ERROR_COOLDOWN_MS = 60000;
const USAGE_INTERVALS = { economy: 999999999, standard: 4500, immersive: 2200 };

export class LLMClient {
  constructor(modelCfg) {
    this.cfg = modelCfg || {};
    this.usage = this.cfg.usage || "standard";
    this.minInterval = USAGE_INTERVALS[this.usage] ?? 4500;
    this.queue = Promise.resolve();
    this.queueLen = 0;
    this.lastCallAt = 0;
    this.cooldownUntil = 0;
    this.lastError = null;
  }

  get enabled() {
    return !!(this.cfg.enabled && this.cfg.apiKey && this.cfg.model && this.usage !== "economy");
  }

  /** 当前是否值得发起新请求（队列不深、不在冷却中） */
  get available() {
    return this.enabled && this.queueLen < 3 && Date.now() >= this.cooldownUntil;
  }

  /** 串行执行 + 节流：保证请求之间至少间隔 minInterval */
  enqueue(fn) {
    this.queueLen++;
    const run = this.queue.then(async () => {
      const wait = this.lastCallAt + this.minInterval - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastCallAt = Date.now();
      return fn();
    });
    this.queue = run.catch(() => {}).then(() => { this.queueLen--; });
    return run;
  }

  async chatRaw(system, user, maxTokens = 512) {
    if (this.cfg.provider === "openai") {
      const base = (this.cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.cfg.apiKey}`
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }

    // Anthropic Claude API（浏览器直连）
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("请求被模型安全策略拒绝");
    const textBlock = (data.content || []).find(b => b.type === "text");
    return textBlock?.text ?? "";
  }

  /**
   * 以某个角色的身份生成一句发言（第一人称、信息隔离）。
   * @param {object} opts {
   *   persona: {name, role, personality},
   *   company: string,        公司背景简介
   *   memories: string[],     这个人自己检索出的相关记忆
   *   scene: string,          当前场景描述
   *   transcript: string[],   他刚刚听到的对话（最近几句）
   * }
   * @returns {Promise<string|null>}
   */
  async speak({ persona, company, policies = [], memories = [], scene, transcript = [] }) {
    if (!this.available) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在一个办公室模拟中扮演「${persona.name}」（${persona.role}）。` +
          `你的性格画像：${persona.personality || "暂无"}。\n` +
          (company ? `你所在的公司：${company}\n` : "") +
          (policies.length
            ? `现行公司政策（管理层指令，你的发言和决定必须与之相符）：\n${policies.map(p => "- " + p).join("\n")}\n`
            : "") +
          `规则：你只知道下面提供的你自己的记忆和你刚听到的话，不要编造你不可能知道的信息。` +
          `用第一人称说一句话，口语化、符合你的性格，不超过 40 个字。只输出这句话本身，不要引号、不要名字前缀。`;
        const user =
          (memories.length ? `你记得的相关事情：\n${memories.map(m => "- " + m).join("\n")}\n\n` : "") +
          `当前场景：${scene}\n` +
          (transcript.length ? `你刚听到的对话：\n${transcript.join("\n")}\n` : "") +
          `\n现在轮到你开口。`;
        const text = (await this.chatRaw(system, user, 256)).trim()
          .replace(/^["「『]|["」』]$/g, "")
          .replace(new RegExp(`^${persona.name}[:：]\\s*`), "");
        this.lastError = null;
        return text ? text.slice(0, 60) : null;
      } catch (e) {
        console.warn("发言生成失败，回退台词池：", e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /**
   * 团队当日简报：把当天的事实和讨论高亮，提炼成结构化的「进展 / 决策 / 应对」条目。
   * @param {object} opts { company, day, facts: string, highlights: string[] }
   * @returns {Promise<Array<{type,text}>|null>} 失败/不可用返回 null（调用方回退确定性提炼）
   */
  async digestDay({ company, day, facts, highlights = [] }) {
    if (!this.available) return null;
    return this.enqueue(async () => {
      try {
        const system =
          (company ? `公司背景：${company}\n` : "") +
          `你是团队助理，请把第 ${day} 天发生的事提炼成 2~5 条关键条目。每条标注类型：` +
          `「进展」（做出来的成果/对齐的事）、「决策」（拍板的方向/政策）、「应对」（针对市场动态采取的态度或动作）。` +
          `每条不超过 40 字，具体、可读。只输出 JSON 数组，形如 ` +
          `[{"type":"进展","text":"……"},{"type":"应对","text":"……"}]，不要任何其他文字。`;
        const user =
          `当天事实：\n${facts || "（无）"}\n\n` +
          (highlights.length ? `当天讨论摘录：\n${highlights.slice(0, 20).join("\n")}\n` : "");
        const raw = await this.chatRaw(system, user, 700);
        const clean = raw.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
        const arr = JSON.parse(clean);
        if (!Array.isArray(arr)) return null;
        this.lastError = null;
        return arr
          .filter(r => r && ["进展", "决策", "应对"].includes(r.type) && r.text)
          .map(r => ({ type: r.type, text: String(r.text).slice(0, 140) }))
          .slice(0, 6);
      } catch (e) {
        console.warn("当日简报生成失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /**
   * 反思树·第一步：从近期记忆提出 2~3 个值得想清楚的问题。批量语义：靠 enqueue 串行节流，全员都排队。
   * @param {object} opts { persona, company, memories: string }  memories 是带编号的记忆清单
   * @returns {Promise<string[]|null>}
   */
  async reflectQuestions({ persona, company, memories }) {
    if (!this.enabled || Date.now() < this.cooldownUntil || !memories) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}），性格：${persona.personality || "暂无"}。` +
          (company ? `公司背景：${company}\n` : "") +
          `下面是你最近记得的事（每条带编号）。请从中提出 2~3 个你最该想清楚的问题（关于工作、协作、产品方向）。` +
          `只输出 JSON 字符串数组，如 ["问题1","问题2"]。不要其他文字。`;
        const raw = await this.chatRaw(system, `你最近记得的事：\n${memories}`, 300);
        this.lastError = null;
        return parseQuestions(raw);
      } catch (e) {
        console.warn("反思提问失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /**
   * 反思树·第二步：针对一个问题，结合带编号记忆给出洞见并标注证据编号。
   * @param {object} opts { persona, company, question, memories: string }
   * @returns {Promise<{insight,evidence}|null>}
   */
  async reflectInsight({ persona, company, question, memories }) {
    if (!this.enabled || Date.now() < this.cooldownUntil) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}）。针对问题，结合下面带编号的记忆，给出一条具体、能指导明天行动的洞见，` +
          `并标注你主要依据了哪几条记忆的编号。只输出 JSON：{"insight":"≤50字洞见","evidence":[依据的记忆编号]}。不要其他文字。`;
        const raw = await this.chatRaw(system, `问题：${question}\n\n带编号的记忆：\n${memories}`, 300);
        this.lastError = null;
        return parseInsight(raw);
      } catch (e) {
        console.warn("反思洞见失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /**
   * 会议纪要：根据一场会议的发言记录，提炼结构化纪要。
   * @param {object} opts { company, day, scene, transcript: string[] }
   * @returns {Promise<{decisions,risks,actionItems}|null>} 失败/不可用/无记录返回 null
   */
  async minutes({ company, day, scene, transcript = [] }) {
    if (!this.available || transcript.length === 0) return null;
    return this.enqueue(async () => {
      try {
        const system =
          (company ? `公司背景：${company}\n` : "") +
          `你是会议记录员。根据下面这场会议的发言记录，提炼结构化纪要。` +
          `只输出 JSON，形如 {"decisions":["…"],"risks":["…"],"actionItems":[{"owner":"姓名","what":"待办"}]}。` +
          `decisions=会上拍板的决定，risks=暴露的风险或隐患，actionItems=明确的待办（owner 必须是发言记录里出现过的人名）。` +
          `每项不超过 40 字，各列最多 4 条，没有就给空数组。不要输出 JSON 以外的任何文字。`;
        const user = `会议场景：${scene}\n这是第 ${day} 个工作日。\n\n发言记录：\n${transcript.join("\n")}`;
        const raw = await this.chatRaw(system, user, 700);
        this.lastError = null;
        return normalizeMinutes(raw);
      } catch (e) {
        console.warn("会议纪要生成失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /**
   * 市场反应模拟：模型扮演"市场"，根据团队当日行为与产品状态输出结构化反应。
   * @param {object} opts { company, day, metrics, shipped: string[], realEvents: string[], policies: string[] }
   * @returns {Promise<{deltas,reasons,feedback,competitorMove}|null>} 失败/不可用返回 null（调用方回退纯规则）
   */
  async marketReaction({ company, day, metrics, shipped = [], realEvents = [], policies = [] }) {
    if (!this.available) return null;
    return this.enqueue(async () => {
      try {
        const system =
          (company ? `公司背景：${company}\n` : "") +
          `你扮演"市场"。根据团队第 ${day} 天的动作和产品现状，给出当天市场的真实反应。` +
          `只输出 JSON：{"deltas":{"dau":整数,"sat":-10~10,"bugs":-20~20,"runway":-2~2},` +
          `"reasons":["指标为何这么变"],"feedback":["应用商店/社交/客服口吻的真实反馈片段"],"competitorMove":"竞品可能的跟进或 null"}。` +
          `deltas 是在当前指标上的增量、要克制合理（dau 增量不超过现日活的 10%）；feedback 2~4 条、每条像真实用户/客户的一句话；没有就空数组/null。不要输出 JSON 以外的任何文字。`;
        const user =
          `当前产品数据：${metrics}\n` +
          (shipped.length ? `今天上线的改进：\n${shipped.map(s => "- " + s).join("\n")}\n` : "今天没有新改进上线。\n") +
          (realEvents.length ? `当天市场动态：\n${realEvents.map(e => "- " + e).join("\n")}\n` : "") +
          (policies.length ? `现行政策：\n${policies.map(p => "- " + p).join("\n")}\n` : "");
        const raw = await this.chatRaw(system, user, 700);
        this.lastError = null;
        return normalizeMarketReaction(raw);
      } catch (e) {
        console.warn("市场反应生成失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /**
   * 每日计划：以某角色身份给今天定 1~3 条 intentions。
   * @param {object} opts { persona, company, reflection, snapshot, openItems: string[] }
   * @returns {Promise<{intentions}|null>} 失败/不可用返回 null
   */
  async dailyPlan({ persona, company, reflection, snapshot, openItems = [] }) {
    // 不用 available（含 queueLen<3）——开工时全员一次性发起，靠 enqueue 串行+节流自然铺开，
    // 否则只有前几个入队、其余被丢，违背"每人每日 1 次"。仍保留 enabled 与错误冷却门。
    if (!this.enabled || Date.now() < this.cooldownUntil) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}），性格：${persona.personality || "暂无"}。` +
          (company ? `公司背景：${company}\n` : "") +
          `现在是早上开工，请给自己定今天的计划。结合昨日反思、今晨情况和你名下没做完的事，` +
          `只输出 JSON：{"intentions":[{"slot":"上午/下午/全天","what":"具体一件事","with":"要找的同事名或null","kind":"investigate/collab/build/review/ops/rest"}]}。` +
          `最多 3 条、要具体可执行；需要协作就把 with 填同事名、kind 设 collab。不要输出 JSON 以外的任何文字。`;
        const user =
          (reflection ? `昨日反思：${reflection}\n` : "") +
          (snapshot ? `今晨情况：\n${snapshot}\n` : "") +
          (openItems.length ? `你名下未完成的行动项：\n${openItems.map(s => "- " + s).join("\n")}\n` : "");
        const raw = await this.chatRaw(system, user, 500);
        this.lastError = null;
        return normalizePlan(raw);
      } catch (e) {
        console.warn("每日计划生成失败：", e.message || e);
        this.lastError = String(e.message || e);
        this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        return null;
      }
    });
  }

  /** 测试连接（管理后台用），返回 { ok, message } */
  async test() {
    if (!this.cfg.apiKey || !this.cfg.model) {
      return { ok: false, message: "请先填写 API Key 和模型名" };
    }
    try {
      const text = await this.chatRaw(
        "你是连接测试助手，请只回复四个字。",
        "请回复：连接成功",
        32
      );
      return { ok: true, message: `连接成功，模型回复：${text.slice(0, 40)}` };
    } catch (e) {
      return { ok: false, message: `连接失败：${String(e.message || e).slice(0, 160)}` };
    }
  }
}
