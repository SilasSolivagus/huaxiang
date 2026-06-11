// LLM 客户端：为模拟中的会议、协作生成实时对话。
// 支持两种提供商：
//   anthropic — Claude API（浏览器直连，需 anthropic-dangerous-direct-browser-access 头）
//   openai    — OpenAI 兼容接口（DeepSeek、Kimi、通义、智谱等均可，填对应 baseUrl）
// 内置限流与冷却：调用失败或过于频繁时返回 null，调用方自动退回内置台词。

const MIN_INTERVAL_MS = 6000;     // 两次请求之间的最小间隔
const ERROR_COOLDOWN_MS = 60000;  // 出错后的冷却时间

export class LLMClient {
  constructor(modelCfg) {
    this.cfg = modelCfg || {};
    this.busy = false;
    this.lastCallAt = 0;
    this.cooldownUntil = 0;
    this.lastError = null;
  }

  get enabled() {
    return !!(this.cfg.enabled && this.cfg.apiKey && this.cfg.model);
  }

  /** 是否当前可以发起请求（供调用方决定走 AI 还是台词池） */
  get available() {
    const now = Date.now();
    return this.enabled && !this.busy && now >= this.cooldownUntil &&
      now - this.lastCallAt >= MIN_INTERVAL_MS;
  }

  async chatRaw(system, user, maxTokens = 1024) {
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
   * 生成一段多人对话。
   * @param {object} opts { scene, participants: [{name, role, personality}], turns, order? }
   * @returns {Promise<Array<{name, text}>|null>} 失败/限流时返回 null
   */
  async dialogue({ scene, participants, turns = 6, order = null }) {
    if (!this.available) return null;
    this.busy = true;
    this.lastCallAt = Date.now();
    try {
      const system =
        "你是一个 3D 办公室模拟游戏的对话编剧。根据人物画像生成简短、自然、口语化的中文办公室对话，" +
        "要符合每个人的性格和职位，可以互相回应、偶尔幽默。只输出 JSON 数组，不要任何其他文字。";
      const roster = participants
        .map(p => `- ${p.name}（${p.role}）：${p.personality || "暂无描述"}`)
        .join("\n");
      const orderHint = order
        ? `发言顺序必须严格为：${order.join(" → ")}。`
        : "发言人可以自由穿插，但每人至少说一句。";
      const user =
        `场景：${scene}\n\n人物画像：\n${roster}\n\n` +
        `请生成 ${turns} 句按顺序的发言。${orderHint}每句不超过 40 个字。\n` +
        `输出格式：[{"name":"姓名","text":"发言内容"}]`;

      const raw = await this.chatRaw(system, user, 1500);
      const parsed = parseDialogue(raw, participants.map(p => p.name));
      this.lastError = null;
      return parsed;
    } catch (e) {
      console.warn("LLM 对话生成失败，回退到内置台词：", e);
      this.lastError = String(e.message || e);
      this.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      return null;
    } finally {
      this.busy = false;
    }
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

/** 解析模型输出为 [{name,text}]，容忍代码块围栏和多余文字 */
function parseDialogue(raw, validNames) {
  if (!raw) return null;
  let s = raw.replace(/```(json)?/g, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  s = s.slice(start, end + 1);
  let arr;
  try {
    arr = JSON.parse(s);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = arr
    .filter(t => t && typeof t.text === "string" && t.text.trim())
    .map(t => ({
      name: validNames.includes(t.name) ? t.name : validNames[0],
      text: t.text.trim().slice(0, 60)
    }));
  return out.length > 0 ? out : null;
}
