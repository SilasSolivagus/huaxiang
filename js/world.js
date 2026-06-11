// 世界模型：公司画像、产品真实运行状态、市场环境事件。
// 状态持久化在 localStorage，跨刷新累积；员工的行为（协作修 bug 等）会反过来影响产品指标。

const WORLD_KEY = "huaxiang.world.v1";

const COMPETITORS = ["蓝鲸科技", "极点软件", "云帆网络", "迅码互动"];

// 市场事件池：text 接收 (公司配置, 竞品名)，effect 在事件发生当天作用于指标
const EVENT_POOL = [
  { id: "comp-feature", w: 10, text: (c, r) => `竞品「${r}」发布了和${c.product}类似的新功能，社区里讨论很热`, effect: m => { m.sat -= 2; } },
  { id: "comp-price", w: 6, text: (c, r) => `竞品「${r}」宣布涨价 30%，一批用户开始寻找替代品`, effect: m => { m.dau = Math.round(m.dau * 1.04); } },
  { id: "kol", w: 6, text: c => `一位行业大 V 公开推荐了${c.product}，转发量很高`, effect: m => { m.dau = Math.round(m.dau * 1.08); m.sat += 1; } },
  { id: "server-down", w: 5, text: c => `今天凌晨服务器出现故障，部分用户无法登录${c.product}`, effect: m => { m.serverOk = false; m.sat -= 4; } },
  { id: "complaint", w: 9, text: c => `应用商店出现一批差评，集中吐槽${c.product}的加载速度`, effect: m => { m.sat -= 3; m.bugs += 2; } },
  { id: "big-client", w: 5, text: c => `一家大客户表达了采购意向，希望两周内看到定制化方案`, effect: m => { m.runway += 0.4; } },
  { id: "industry-report", w: 6, text: c => `最新行业报告显示${c.industry}赛道增速超预期，资本关注度上升`, effect: m => { m.dau = Math.round(m.dau * 1.02); } },
  { id: "poach", w: 4, text: (c, r) => `听说竞品「${r}」在挖同行业的工程师，团队里有人收到了猎头电话`, effect: () => {} },
  { id: "store-featured", w: 4, text: c => `${c.product}被应用商店选入推荐位，自然流量明显上涨`, effect: m => { m.dau = Math.round(m.dau * 1.1); } },
  { id: "security", w: 5, text: c => `安全社区披露了一个影响面较大的依赖库漏洞，需要尽快排查`, effect: m => { m.bugs += 4; } },
  { id: "capital-cold", w: 4, text: c => `资本市场近期对${c.industry}态度转冷，融资节奏可能放缓`, effect: m => { m.runway -= 0.3; } },
  { id: "return-users", w: 5, text: c => `上个版本的优化见效了，一批流失的老用户回来了`, effect: m => { m.dau = Math.round(m.dau * 1.04); m.sat += 2; } },
  { id: "viral-case", w: 4, text: c => `有用户用${c.product}做出了出圈的案例，被多家媒体报道`, effect: m => { m.dau = Math.round(m.dau * 1.06); } },
  { id: "churn-warning", w: 6, text: c => `数据看板显示本周用户留存率下滑，需要找原因`, effect: m => { m.sat -= 2; } }
];

function pickWeighted(pool, exclude = new Set()) {
  const candidates = pool.filter(e => !exclude.has(e.id));
  const total = candidates.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of candidates) {
    r -= e.w;
    if (r <= 0) return e;
  }
  return candidates[candidates.length - 1];
}

function hasStorage() {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

export const DEFAULT_COMPANY = {
  name: "星图科技",
  product: "团队协作 SaaS「星图」",
  industry: "企业协作软件",
  stage: "A 轮创业公司，团队规模 20 人左右",
  goal: "三个月内把日活翻倍，并签下第一批付费大客户"
};

export class World {
  constructor(company = DEFAULT_COMPANY) {
    this.company = { ...DEFAULT_COMPANY, ...company };
    const saved = this.load();
    if (saved) {
      this.day = saved.day;
      this.metrics = saved.metrics;
    } else {
      this.day = 1;
      this.metrics = { dau: 1200, sat: 72, bugs: 14, serverOk: true, runway: 14 };
    }
    this.todayEvents = [];
    this.generateEvents();
  }

  load() {
    if (!hasStorage()) return null;
    try {
      const raw = localStorage.getItem(WORLD_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.metrics && s.day >= 1) return s;
      }
    } catch {}
    return null;
  }

  save() {
    if (!hasStorage()) return;
    localStorage.setItem(WORLD_KEY, JSON.stringify({ day: this.day, metrics: this.metrics }));
  }

  static reset() {
    if (hasStorage()) localStorage.removeItem(WORLD_KEY);
  }

  /** 生成今日 1~2 个市场事件并应用其影响 */
  generateEvents() {
    this.todayEvents = [];
    const competitor = COMPETITORS[Math.floor(Math.random() * COMPETITORS.length)];
    const n = Math.random() < 0.45 ? 2 : 1;
    const used = new Set();
    for (let i = 0; i < n; i++) {
      const ev = pickWeighted(EVENT_POOL, used);
      used.add(ev.id);
      const text = ev.text(this.company, competitor);
      ev.effect(this.metrics);
      this.todayEvents.push({ id: ev.id, text });
    }
    this.clampMetrics();
    this.save();
  }

  /** 进入新的一天：指标自然演化 + 新事件 */
  nextDay() {
    const m = this.metrics;
    // 服务器故障第二天恢复
    if (!m.serverOk) m.serverOk = true;
    // 自然漂移：满意度带动日活，bug 多拖累满意度
    m.dau = Math.round(m.dau * (1 + (m.sat - 70) / 800 + (Math.random() * 0.05 - 0.02)));
    m.bugs += Math.floor(Math.random() * 6) - 2;
    m.sat += Math.floor(Math.random() * 5) - 2 + (m.bugs > 22 ? -2 : 0);
    m.runway -= 0.05;
    this.clampMetrics();
    this.day += 1;
    this.generateEvents();
  }

  clampMetrics() {
    const m = this.metrics;
    m.dau = Math.max(50, m.dau);
    m.sat = Math.min(99, Math.max(5, m.sat));
    m.bugs = Math.max(0, m.bugs);
    m.runway = Math.max(0.5, Math.round(m.runway * 10) / 10);
  }

  /** 员工协作完成：有概率修掉 bug */
  onCollabDone() {
    if (this.metrics.bugs > 0 && Math.random() < 0.35) {
      this.metrics.bugs -= 1;
      this.metrics.sat += this.metrics.bugs < 10 ? 1 : 0;
      this.clampMetrics();
      this.save();
      return true;
    }
    return false;
  }

  /** 给 AI 的公司背景简介 */
  companyBrief() {
    const c = this.company;
    return `${c.name}，${c.stage}，主营产品是${c.product}（${c.industry}赛道）。当前经营目标：${c.goal}。`;
  }

  /** 给 AI 和公告用的当日数据摘要 */
  metricsSummary() {
    const m = this.metrics;
    return `今日产品数据：日活 ${m.dau}，用户满意度 ${m.sat} 分，待修 Bug ${m.bugs} 个，服务器${m.serverOk ? "运行正常" : "出现故障"}，现金还能支撑约 ${m.runway} 个月。`;
  }
}
