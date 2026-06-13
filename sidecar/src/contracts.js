// 事件契约：B 接口三契约之一。所有进入事件总线的数据必须经过这里归一化。
import { createHash, randomUUID } from "node:crypto";

const SOURCES = new Set(["rss", "search", "watch", "manual", "policy"]);

export function urlHash(url) {
  return createHash("sha256").update(String(url)).digest("hex");
}

function clampRelevance(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 5;
}

export function normalizeArtifact(raw) {
  if (!raw || typeof raw !== "object") throw new Error("artifact must be an object");
  const type = String(raw.type || "").trim();
  if (!type) throw new Error("artifact.type required");
  const content = String(raw.content || "").trim();
  if (!content) throw new Error("artifact.content required");
  return {
    id: raw.id || `art_${randomUUID().slice(0, 8)}`,
    ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : Date.now(),
    type: type.slice(0, 40),
    day: Number.isFinite(Number(raw.day)) ? Number(raw.day) : 0,
    content: content.slice(0, 4000),
    meta: raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta) ? raw.meta : null
  };
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") throw new Error("event must be an object");
  const title = String(raw.title || "").trim();
  if (!title) throw new Error("event.title required");
  if (!SOURCES.has(raw.source)) throw new Error(`bad event.source: ${raw.source}`);
  return {
    id: raw.id || `evt_${randomUUID().slice(0, 8)}`,
    ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : Date.now(),
    source: raw.source,
    kind: raw.kind || "market",
    title: title.slice(0, 200),
    summary: String(raw.summary || title).trim().slice(0, 200),
    url: raw.url ? String(raw.url) : null,
    relevance: clampRelevance(raw.relevance),
    suggestedImpact: raw.suggestedImpact ?? null,
    consumed: false
  };
}
