// 事件契约：B 接口三契约之一。所有进入事件总线的数据必须经过这里归一化。
import { createHash, randomUUID } from "node:crypto";

const SOURCES = new Set(["rss", "search", "watch", "manual", "policy"]);

export function urlHash(url) {
  return createHash("sha256").update(String(url)).digest("hex");
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") throw new Error("event must be an object");
  const title = String(raw.title || "").trim();
  if (!title) throw new Error("event.title required");
  if (!SOURCES.has(raw.source)) throw new Error(`bad event.source: ${raw.source}`);
  return {
    id: raw.id || `evt_${randomUUID().slice(0, 8)}`,
    ts: Number(raw.ts) || Date.now(),
    source: raw.source,
    kind: raw.kind || "market",
    title: title.slice(0, 200),
    summary: String(raw.summary || title).trim().slice(0, 200),
    url: raw.url ? String(raw.url) : null,
    relevance: Math.max(0, Math.min(10, Number(raw.relevance ?? 5) || 0)),
    suggestedImpact: raw.suggestedImpact ?? null,
    consumed: false
  };
}
