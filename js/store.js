// 配置存取：人物画像 + 模型设置统一保存在浏览器 localStorage。
// 管理后台（admin.html）写入，办公室页面（index.html）读取。

import { PERSONAS } from "./personas.js";
import { DEFAULT_COMPANY } from "./world.js";

const STORAGE_KEY = "huaxiang.config.v1";

function toHexStr(n) {
  return "#" + n.toString(16).padStart(6, "0");
}

function toHexNum(s) {
  if (typeof s === "number") return s;
  return parseInt(String(s).replace("#", ""), 16) || 0x888888;
}

/** 默认配置（颜色以 #rrggbb 字符串保存，便于 JSON 序列化和颜色选择器使用） */
export function defaultConfig() {
  return {
    personas: PERSONAS.map(p => ({
      ...p,
      color: toHexStr(p.color),
      skin: toHexStr(p.skin),
      hair: toHexStr(p.hair)
    })),
    model: {
      enabled: false,
      provider: "anthropic",          // anthropic | openai（OpenAI 兼容接口）
      apiKey: "",
      model: "claude-opus-4-8",
      baseUrl: "",                     // 仅 OpenAI 兼容接口需要，如 https://api.deepseek.com/v1
      usage: "standard"                // economy | standard | immersive：AI 用量档位
    },
    company: { ...DEFAULT_COMPANY }    // 公司设定（世界模型用）
  };
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && Array.isArray(cfg.personas) && cfg.personas.length > 0 && cfg.model) {
        // 旧版本配置补全新增字段
        const def = defaultConfig();
        cfg.model = { ...def.model, ...cfg.model };
        cfg.company = { ...def.company, ...(cfg.company || {}) };
        return cfg;
      }
    }
  } catch (e) {
    console.warn("配置读取失败，使用默认配置", e);
  }
  return defaultConfig();
}

export function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function resetConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

// 通用台词池：自定义人物没写台词时的兜底
const DEFAULT_LINES = {
  work: ["专注搞定这个任务", "今天进展不错", "再核对一遍细节", "这个问题有点意思"],
  meeting: ["我这边进展正常", "这个方向我同意", "有个风险需要注意一下", "我补充一点想法"],
  collab: ["这块我们对齐一下", "你看这样处理行吗？", "我有个想法跟你商量"],
  coffee: ["今天天气不错", "最近有点忙啊", "周末有什么安排？"]
};

/** 把存储格式转换为模拟运行时需要的格式（数字颜色 + 保证台词池齐全） */
export function runtimePersonas(cfg) {
  return cfg.personas.map((p, i) => ({
    id: p.id || `p${i}`,
    name: p.name || `成员${i + 1}`,
    role: p.role || "同事",
    personality: p.personality || "",
    color: toHexNum(p.color),
    skin: toHexNum(p.skin || "#f2c9a4"),
    hair: toHexNum(p.hair || "#2b2b2b"),
    lines: {
      work: p.lines?.work?.length ? p.lines.work : DEFAULT_LINES.work,
      meeting: p.lines?.meeting?.length ? p.lines.meeting : DEFAULT_LINES.meeting,
      collab: p.lines?.collab?.length ? p.lines.collab : DEFAULT_LINES.collab,
      coffee: p.lines?.coffee?.length ? p.lines.coffee : DEFAULT_LINES.coffee
    }
  }));
}

export const MAX_PERSONAS = 8;
