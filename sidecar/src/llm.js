// sidecar 自用 LLM 客户端：只做一件事——给资讯条目批量打相关性分 + 写摘要。
// 接口形状与前端 js/llm.js 保持一致（anthropic / openai 兼容），但 key 来自环境变量。

export class SidecarLLM {
  constructor(env = process.env, fetchFn = fetch) {
    this.provider = env.SIDECAR_PROVIDER || "anthropic";
    this.apiKey = env.SIDECAR_API_KEY || "";
    this.model = env.SIDECAR_MODEL || "";
    this.baseUrl = (env.SIDECAR_BASE_URL || "").replace(/\/+$/, "");
    this.fetch = fetchFn;
  }

  get enabled() {
    return !!(this.apiKey && this.model);
  }

  async chatRaw(system, user, maxTokens = 1500) {
    if (this.provider === "openai") {
      const base = this.baseUrl || "https://api.openai.com/v1";
      const res = await this.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: user }]
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    const res = await this.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.content || []).find(b => b.type === "text")?.text ?? "";
  }

  /**
   * 批量打分：items = [{title, snippet}]，返回与 items 等长的数组
   * （每项 {relevance, summary, suggestedImpact} 或 null），整体失败返回 null。
   */
  async scoreBatch(items, companyBrief) {
    if (!this.enabled || items.length === 0) return null;
    const system =
      `你是市场情报分析员。公司背景：${companyBrief}\n` +
      `对下面每条资讯：判断它与这家公司经营的相关程度 relevance（0~10 整数，无关给 0~3，` +
      `行业相关给 4~6，直接影响公司给 7~10）；写一条不超过 120 字的中文摘要 summary` +
      `（说清发生了什么、和公司的关系）；可选给出 suggestedImpact（对 dau/sat/bugs/runway 的方向性影响）。\n` +
      `只输出 JSON 数组，不要任何其他文字。格式示例：` +
      `[{"i":0,"relevance":8,"summary":"……","suggestedImpact":{"sat":-1}}]`;
    const user = items
      .map((it, i) => `${i}. ${it.title}\n${String(it.snippet || "").slice(0, 200)}`)
      .join("\n\n");
    try {
      const text = await this.chatRaw(system, user);
      const clean = text.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
      const arr = JSON.parse(clean);
      if (!Array.isArray(arr)) return null;
      const out = new Array(items.length).fill(null);
      for (const r of arr) {
        if (Number.isInteger(r.i) && r.i >= 0 && r.i < items.length) {
          out[r.i] = {
            relevance: Math.max(0, Math.min(10, Number(r.relevance) || 0)),
            summary: String(r.summary || items[r.i].title).slice(0, 160),
            suggestedImpact: r.suggestedImpact ?? null
          };
        }
      }
      return out;
    } catch (e) {
      console.warn("scoreBatch 失败：", e.message);
      return null;
    }
  }
}
