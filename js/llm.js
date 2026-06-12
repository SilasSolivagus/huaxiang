// LLM 客户端：为每个 Agent 独立生成第一人称发言与每日反思。
// 隔离原则：每次调用只携带"这个人自己的画像 + 他自己检索出的记忆 + 他听到的对话"，
// 模型扮演单个角色，而不是上帝视角写整场剧本。
//
// 提供商：
//   anthropic — Claude API（浏览器直连，需 anthropic-dangerous-direct-browser-access 头）
//   openai    — OpenAI 兼容接口（DeepSeek、Kimi、通义、智谱等，填对应 baseUrl）
// 内置串行队列 + 限流 + 出错冷却：不可用时返回 null，调用方回退内置台词。

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

  /** 每日反思：把当天经历提炼成 1~2 条感悟（高权重记忆） */
  async reflect({ persona, company, digest, day }) {
    if (!this.available || !digest) return null;
    return this.enqueue(async () => {
      try {
        const system =
          `你在扮演「${persona.name}」（${persona.role}），性格画像：${persona.personality || "暂无"}。` +
          (company ? `公司背景：${company}\n` : "") +
          `下面是你今天（第 ${day} 天）经历的事情。请以第一人称写下 1 条你今天最重要的感悟或决定，` +
          `不超过 50 个字，要具体、能指导你明天的行动。只输出这条感悟本身。`;
        const text = (await this.chatRaw(system, `今天的经历：\n${digest}`, 256)).trim();
        this.lastError = null;
        return text ? text.slice(0, 70) : null;
      } catch (e) {
        console.warn("反思生成失败：", e);
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
