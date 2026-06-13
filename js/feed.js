// 与本地 sidecar 的连接：探测、快照、SSE 实时事件、政策同步。
// sidecar 不在线（如 GitHub Pages 或 http-server 直开）时所有方法安全降级，
// 模拟自动回到纯虚构模式——这是 P0 级约束：模拟永不因数据面缺席而停摆。

const SEEN_KEY = "huaxiang.policies.seen.v1";
const POLICY_POLL_MS = 30000;

/**
 * 纯函数：对比「上次见过的政策状态」和「当前政策列表」。
 * seen: { [id]: lastActive }；current: [{id, text, active}]
 * 返回 { announced: [policy], revoked: [id] }
 */
export function diffPolicies(seen, current) {
  const announced = current.filter(p => p.active && seen[p.id] === undefined);
  const revoked = Object.keys(seen).filter(
    id => seen[id] && !current.some(p => p.id === id && p.active)
  );
  return { announced, revoked };
}

function loadSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch { return {}; }
}

function saveSeen(seen) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
}

export class Feed {
  constructor() {
    this.online = false;
    this.pending = [];        // 已到达、未投递进模拟的真实事件
    this.policies = [];       // 现行政策 [{id, text, active}]
    this.onBreaking = null;   // (event) => void   模拟运行中实时到达
    this.onPolicyChange = null; // ({announced, revoked: [id]}) => void
    this.onStatus = null;     // (online: boolean) => void
  }

  /** 探测 sidecar；在线则拉快照、开 SSE、起政策轮询。返回是否在线。 */
  async connect() {
    try {
      const res = await fetch("/api/health", { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.online = true;
    } catch {
      this.online = false;
      this.onStatus?.(false);
      return false;
    }
    this.onStatus?.(true);

    try {
      const snap = await (await fetch("/api/snapshot")).json();
      this.pending.push(...(snap.events || []));
      this.syncPolicies(snap.policies || []);
    } catch (e) {
      console.warn("快照拉取失败：", e);
    }

    const es = new EventSource("/api/stream");
    es.onmessage = e => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (this.onBreaking) {
        try { this.onBreaking(ev); } finally { this.ack([ev.id]); }
      } else {
        this.pending.push(ev);
      }
    };
    es.onerror = () => { /* EventSource 自带重连 */ };

    setInterval(async () => {
      try {
        this.syncPolicies(await (await fetch("/api/policies")).json());
      } catch {}
    }, POLICY_POLL_MS);

    return true;
  }

  /** 政策对账：发现新政策/撤销则回调，并更新本地已见标记 */
  syncPolicies(current) {
    this.policies = current;
    const seen = loadSeen();
    const diff = diffPolicies(seen, current);
    if (diff.announced.length || diff.revoked.length) {
      this.onPolicyChange?.(diff);
    }
    const next = {};
    for (const p of current) next[p.id] = p.active;
    for (const id of diff.revoked) next[id] = false;
    saveSeen(next);
  }

  /** 取走最多 max 条待投递事件并向 sidecar 确认消费 */
  takeEvents(max = 3) {
    const taken = this.pending.splice(0, max);
    if (taken.length) this.ack(taken.map(e => e.id));
    return taken;
  }

  /** 现行政策文本列表（注入发言上下文用） */
  activePolicies() {
    return this.policies.filter(p => p.active).map(p => p.text);
  }

  /** 文本批量转向量：在线则走 sidecar 本地模型，离线/失败返回 null（调用方回退 bigram） */
  async embed(texts) {
    if (!this.online || !texts || texts.length === 0) return null;
    try {
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts })
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.vectors) ? data.vectors : null;
    } catch {
      return null;
    }
  }

  /** 取静态分析指标（文件数/TODO/热点），离线返回 null */
  async analysis() {
    if (!this.online) return null;
    try {
      const res = await fetch("/api/analysis");
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /** 取每日仓库摘要文本，离线返回 null */
  async repoDigest() {
    if (!this.online) return null;
    try {
      const res = await fetch("/api/repo/digest");
      if (!res.ok) return null;
      const data = await res.json();
      return data.text || null;
    } catch { return null; }
  }

  /** 代码检索，返回 [{file,line,text}] 或 null */
  async repoGrep(q) {
    if (!this.online || !q) return null;
    try {
      const res = await fetch(`/api/repo/grep?q=${encodeURIComponent(q)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.hits) ? data.hits : null;
    } catch { return null; }
  }

  ack(ids) {
    if (!this.online || !ids.length) return;
    fetch("/api/events/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids })
    }).catch(() => {});
  }
}
