// 管理后台逻辑：人物画像增删改 + 模型配置 + 导入导出，全部读写 localStorage。

import { loadConfig, saveConfig, resetConfig, defaultConfig, MAX_PERSONAS } from "./store.js";
import { LLMClient } from "./llm.js";
import { MemoryStream } from "./memory.js";
import { World } from "./world.js";

let config = loadConfig();

const $ = id => document.getElementById(id);

// ---------- 公司设定 ----------
const COMPANY_FIELDS = ["name", "industry", "product", "stage", "goal"];

function renderCompany() {
  for (const f of COMPANY_FIELDS) $(`c-${f}`).value = config.company?.[f] || "";
}

function collectCompany() {
  config.company = config.company || {};
  for (const f of COMPANY_FIELDS) {
    const v = $(`c-${f}`).value.trim();
    if (v) config.company[f] = v;
  }
}

$("btn-clear-memory").addEventListener("click", () => {
  if (confirm("确定清空所有人物的记忆流，并把产品指标重置回第 1 天吗？\n（人物画像和模型配置不受影响）")) {
    MemoryStream.clearAll();
    World.reset();
    alert("已清空。返回办公室后将从第 1 天重新开始。");
  }
});

// ---------- 模型设置 ----------
const MODEL_HINTS = {
  anthropic: "推荐 claude-opus-4-8；想省钱可用 claude-haiku-4-5",
  openai: "按服务商文档填写，如 deepseek-chat、moonshot-v1-8k、qwen-plus"
};

function renderModel() {
  const m = config.model;
  $("m-enabled").checked = !!m.enabled;
  $("m-provider").value = m.provider || "anthropic";
  $("m-key").value = m.apiKey || "";
  $("m-model").value = m.model || "";
  $("m-baseurl").value = m.baseUrl || "";
  const usage = document.querySelector(`input[name="usage"][value="${m.usage || "standard"}"]`);
  if (usage) usage.checked = true;
  updateProviderUI();
}

function updateProviderUI() {
  const p = $("m-provider").value;
  $("row-baseurl").hidden = p !== "openai";
  $("m-model-hint").textContent = MODEL_HINTS[p];
  $("m-model").placeholder = p === "anthropic" ? "claude-opus-4-8" : "deepseek-chat";
}

function collectModel() {
  config.model = {
    enabled: $("m-enabled").checked,
    provider: $("m-provider").value,
    apiKey: $("m-key").value.trim(),
    model: $("m-model").value.trim(),
    baseUrl: $("m-baseurl").value.trim(),
    usage: document.querySelector('input[name="usage"]:checked')?.value || "standard"
  };
}

$("m-provider").addEventListener("change", updateProviderUI);

$("btn-test").addEventListener("click", async () => {
  collectModel();
  const result = $("test-result");
  result.className = "";
  result.textContent = "测试中…";
  const client = new LLMClient(config.model);
  const { ok, message } = await client.test();
  result.className = ok ? "ok" : "err";
  result.textContent = message;
});

// ---------- 人物管理 ----------
const PALETTE = ["#e05a4e", "#4f8cff", "#3dbf7a", "#b86fd9", "#f0a93c", "#5a6b7f", "#e26fa0", "#41b8c4"];

function renderPersonas() {
  const list = $("persona-list");
  list.innerHTML = "";
  config.personas.forEach((p, i) => list.appendChild(personaCard(p, i)));
  $("persona-count").textContent = `（${config.personas.length}/${MAX_PERSONAS} 人）`;
  $("btn-add").style.display = config.personas.length >= MAX_PERSONAS ? "none" : "";
}

function personaCard(p, i) {
  const card = document.createElement("div");
  card.className = "persona-card";
  card.innerHTML = `
    <div class="persona-head">
      <span class="persona-dot" style="background:${p.color}">${(p.name || "？")[0]}</span>
      <span class="persona-title">${p.name || "新成员"} · ${p.role || "未设置职位"}</span>
      <button class="persona-remove">删除</button>
    </div>
    <div class="persona-fields">
      <div class="field-pair">
        <div class="form-row">
          <label>姓名</label>
          <input type="text" data-field="name" value="" placeholder="例如：林晓" />
        </div>
        <div class="form-row">
          <label>职位</label>
          <input type="text" data-field="role" value="" placeholder="例如：产品经理" />
        </div>
      </div>
      <div class="form-row">
        <label>画像描述（性格、习惯、口头禅…会交给 AI 用来生成对话）</label>
        <textarea data-field="personality" placeholder="例如：雷厉风行，永远在推进度，口头禅是「这个需求很简单」…"></textarea>
      </div>
      <div class="color-row">
        <span class="color-item">衣服 <input type="color" data-field="color" /></span>
        <span class="color-item">头发 <input type="color" data-field="hair" /></span>
        <span class="color-item">肤色 <input type="color" data-field="skin" /></span>
      </div>
    </div>`;

  // 填值（用 value 属性赋值避免 HTML 转义问题）
  card.querySelector('[data-field="name"]').value = p.name || "";
  card.querySelector('[data-field="role"]').value = p.role || "";
  card.querySelector('[data-field="personality"]').value = p.personality || "";
  card.querySelector('[data-field="color"]').value = p.color || "#4f8cff";
  card.querySelector('[data-field="hair"]').value = p.hair || "#2b2b2b";
  card.querySelector('[data-field="skin"]').value = p.skin || "#f2c9a4";

  // 字段变更直接写回内存中的 config
  card.querySelectorAll("[data-field]").forEach(el => {
    el.addEventListener("input", () => {
      config.personas[i][el.dataset.field] = el.value;
      if (el.dataset.field === "name" || el.dataset.field === "role") {
        card.querySelector(".persona-title").textContent =
          `${config.personas[i].name || "新成员"} · ${config.personas[i].role || "未设置职位"}`;
        card.querySelector(".persona-dot").textContent = (config.personas[i].name || "？")[0];
      }
      if (el.dataset.field === "color") {
        card.querySelector(".persona-dot").style.background = el.value;
      }
    });
  });

  card.querySelector(".persona-remove").addEventListener("click", () => {
    if (config.personas.length <= 1) {
      alert("至少保留 1 个人物");
      return;
    }
    if (confirm(`确定删除「${p.name || "该成员"}」吗？`)) {
      config.personas.splice(i, 1);
      renderPersonas();
    }
  });

  return card;
}

$("btn-add").addEventListener("click", () => {
  if (config.personas.length >= MAX_PERSONAS) return;
  const i = config.personas.length;
  config.personas.push({
    id: `custom-${Date.now()}`,
    name: "",
    role: "",
    personality: "",
    color: PALETTE[i % PALETTE.length],
    hair: "#2b2b2b",
    skin: "#f2c9a4"
  });
  renderPersonas();
  const cards = document.querySelectorAll(".persona-card");
  cards[cards.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- 保存 / 重置 / 导入导出 ----------
$("btn-save").addEventListener("click", () => {
  collectModel();
  collectCompany();
  // 校验
  for (const p of config.personas) {
    if (!p.name?.trim()) {
      alert("有人物还没填姓名，请补全后再保存");
      return;
    }
  }
  if (config.model.enabled && (!config.model.apiKey || !config.model.model)) {
    alert("已勾选启用 AI，但 API Key 或模型名为空。请补全，或先取消勾选。");
    return;
  }
  saveConfig(config);
  $("save-status").textContent = "已保存 ✓";
  setTimeout(() => { location.href = "index.html"; }, 400);
});

$("btn-reset").addEventListener("click", () => {
  if (confirm("确定恢复默认的人物阵容和公司设定吗？\n（你填的 API Key 和模型配置会保留）")) {
    const keepModel = { ...config.model, ...collectModelValues() };
    resetConfig();
    config = defaultConfig();
    config.model = { ...config.model, ...keepModel };
    renderModel();
    renderCompany();
    renderPersonas();
  }
});

/** 不写回 config，仅收集当前表单里的模型配置 */
function collectModelValues() {
  return {
    enabled: $("m-enabled").checked,
    provider: $("m-provider").value,
    apiKey: $("m-key").value.trim(),
    model: $("m-model").value.trim(),
    baseUrl: $("m-baseurl").value.trim(),
    usage: document.querySelector('input[name="usage"]:checked')?.value || "standard"
  };
}

$("btn-export").addEventListener("click", () => {
  collectModel();
  collectCompany();
  // 导出时不带 API Key，避免误分享泄露
  const out = JSON.parse(JSON.stringify(config));
  out.model.apiKey = "";
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "huaxiang-config.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("btn-import").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.personas) || imported.personas.length === 0) {
      throw new Error("文件里没有人物数据");
    }
    const keepKey = config.model.apiKey;          // 保留本机已填的 Key
    config = { ...defaultConfig(), ...imported };
    config.personas = imported.personas.slice(0, MAX_PERSONAS);
    if (!config.model.apiKey) config.model.apiKey = keepKey;
    renderModel();
    renderCompany();
    renderPersonas();
    alert(`导入成功：${config.personas.length} 个人物。记得点「保存」生效。`);
  } catch (err) {
    alert(`导入失败：${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------- 初始化 ----------
renderModel();
renderCompany();
renderPersonas();

// ---------- 上层决策（需要 sidecar） ----------
async function initPolicies() {
  const offline = $("policy-offline");
  const list = $("policy-list");
  const statusEl = $("policy-status");

  async function refresh() {
    try {
      const policies = await (await fetch("/api/policies")).json();
      $("policy-count").textContent = `（现行 ${policies.length} 条）`;
      list.innerHTML = policies.length === 0
        ? '<p class="hint">还没有现行决策。</p>'
        : "";
      for (const p of policies) {
        const row = document.createElement("div");
        row.className = "form-row policy-row";
        const span = document.createElement("span");
        span.textContent = `📣 ${p.text}`;
        const btn = document.createElement("button");
        btn.className = "ghost danger";
        btn.textContent = "撤销";
        btn.addEventListener("click", async () => {
          if (!confirm(`确定撤销这条决策吗？\n「${p.text}」`)) return;
          try {
            await fetch(`/api/policies/${p.id}`, { method: "DELETE" });
          } catch {
            alert("撤销失败：无法连接 sidecar");
            return;
          }
          refresh();
        });
        row.append(span, btn);
        list.appendChild(row);
      }
    } catch {
      $("policy-count").textContent = "";
      list.innerHTML = '<p class="hint">⚠️ 读取决策失败，sidecar 可能已停止运行。</p>';
    }
  }

  try {
    const health = await (await fetch("/api/health", { signal: AbortSignal.timeout(2000) })).json();
    if (!health.ok) throw new Error("bad health");
    const rss = health.collectors?.rss;
    if (rss && !rss.enabled && rss.reason) {
      offline.hidden = false;
      offline.textContent = `ℹ️ sidecar 已连接，但 RSS 采集器未启用：${rss.reason}`;
    }
  } catch {
    offline.hidden = false;
    $("btn-policy-publish").disabled = true;
    $("policy-text").disabled = true;
    return;
  }

  await refresh();

  $("btn-policy-publish").addEventListener("click", async () => {
    const text = $("policy-text").value.trim();
    if (!text) { alert("请先写下决策内容"); return; }
    let res;
    try {
      res = await fetch("/api/policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text })
      });
    } catch {
      alert("发布失败：无法连接 sidecar");
      return;
    }
    if (res.ok) {
      $("policy-text").value = "";
      statusEl.textContent = "已发布 ✓（返回办公室后 30 秒内生效）";
      setTimeout(() => { statusEl.textContent = ""; }, 4000);
      refresh();
    } else {
      alert(`发布失败：${(await res.json()).error || res.status}`);
    }
  });
}

initPolicies();
