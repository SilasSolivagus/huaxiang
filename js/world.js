// 世界模型：公司画像、产品真实运行状态、市场环境事件。
// 状态持久化在 localStorage，跨刷新累积；员工的行为（协作修 bug 等）会反过来影响产品指标。
// 网盘/云存储行业有专属事件池（基于真实行业格局：百度网盘、夸克、阿里云盘的竞争，
// 带宽/硬件成本压力，免费额度与会员政策的舆情等）。

const WORLD_KEY = "huaxiang.world.v1";

const COMPETITORS = ["蓝鲸科技", "极点软件", "云帆网络", "迅码互动"];

// ---------------- 通用事件池 ----------------
const EVENT_POOL = [
  { id: "comp-feature", w: 10, text: (c, r) => `竞品「${r}」发布了和${c.product}类似的新功能，社区里讨论很热`, effect: m => { m.sat -= 2; } },
  { id: "comp-price", w: 6, text: (c, r) => `竞品「${r}」宣布涨价 30%，一批用户开始寻找替代品`, effect: m => { m.dau = Math.round(m.dau * 1.04); } },
  { id: "kol", w: 6, text: c => `一位行业大 V 公开推荐了${c.product}，转发量很高`, effect: m => { m.dau = Math.round(m.dau * 1.08); m.sat += 1; } },
  { id: "server-down", w: 5, text: c => `今天凌晨服务器出现故障，部分用户无法正常使用${c.product}`, effect: m => { m.serverOk = false; m.sat -= 4; } },
  { id: "complaint", w: 9, text: c => `应用商店出现一批差评，集中吐槽${c.product}的体验问题`, effect: m => { m.sat -= 3; m.bugs += 2; } },
  { id: "big-client", w: 5, text: c => `一家大客户表达了采购意向，希望两周内看到定制化方案`, effect: m => { m.runway += 0.4; } },
  { id: "industry-report", w: 6, text: c => `最新行业报告显示${c.industry}赛道增速超预期，资本关注度上升`, effect: m => { m.dau = Math.round(m.dau * 1.02); } },
  { id: "store-featured", w: 4, text: c => `${c.product}被应用商店选入推荐位，自然流量明显上涨`, effect: m => { m.dau = Math.round(m.dau * 1.1); } },
  { id: "security", w: 5, text: c => `安全社区披露了一个影响面较大的依赖库漏洞，需要尽快排查`, effect: m => { m.bugs += 4; } },
  { id: "capital-cold", w: 4, text: c => `资本市场近期对${c.industry}态度转冷，融资节奏可能放缓`, effect: m => { m.runway -= 0.3; } },
  { id: "return-users", w: 5, text: c => `上个版本的优化见效了，一批流失的老用户回来了`, effect: m => { m.dau = Math.round(m.dau * 1.04); m.sat += 2; } }
];

// ---------------- 网盘 / 云存储行业专属事件池 ----------------
const STORAGE_EVENTS = [
  { id: "free-quota-debate", w: 10, text: c => `免费用户月流量额度下调的政策又被翻出来讨论，社交平台上吵成两派`, effect: m => { m.sat -= 3; m.dau = Math.round(m.dau * 1.01); } },
  { id: "price-up", w: 7, text: c => `新一轮会员价格调整生效，客服收到大量咨询，老用户观望情绪明显`, effect: m => { m.runway += 0.5; m.sat -= 2; } },
  { id: "bandwidth-rule", w: 8, text: c => `带宽结算新规落地，CDN 结算价上调，成本压力进一步加大`, effect: m => { m.runway -= 0.4; } },
  { id: "hardware-cost", w: 6, text: c => `硬盘采购价又涨了，供应商说近期缺货，硬件成本几乎翻倍`, effect: m => { m.runway -= 0.3; } },
  { id: "quark-campus", w: 9, text: c => `夸克网盘上线新一轮校园活动，资源站里的分享链接越来越多换成了夸克`, effect: m => { m.dau = Math.round(m.dau * 0.98); } },
  { id: "baidu-throttle", w: 8, text: c => `百度网盘非会员限速又上了热搜，「不限速网盘」搜索量暴涨，新注册明显变多`, effect: m => { m.dau = Math.round(m.dau * 1.05); m.sat += 1; } },
  { id: "ali-adjust", w: 6, text: c => `阿里云盘调整权益的公告引发用户不满，一批用户正在寻找替代品`, effect: m => { m.dau = Math.round(m.dau * 1.03); } },
  { id: "resource-viral", w: 7, text: c => `有大 V 把整理好的资源合集用${c.name}链接发上社交平台，外链流量瞬间冲高`, effect: m => { m.dau = Math.round(m.dau * 1.06); m.runway -= 0.2; m.bugs += 1; } },
  { id: "regulation", w: 6, text: c => `监管部门发布网盘内容治理通知，违规外链需要限期清理，审核压力增大`, effect: m => { m.sat -= 1; m.bugs += 2; } },
  { id: "blackmarket", w: 6, text: c => `发现黑产利用免登录直链传播违规内容，需要紧急封禁一批链接`, effect: m => { m.bugs += 3; m.sat -= 2; } },
  { id: "vip-conversion", w: 6, text: c => `长期会员促销转化超预期，付费率创了新高`, effect: m => { m.runway += 0.5; m.sat += 1; } },
  { id: "speed-praise", w: 6, text: c => `「上传下载不限速第六年」的口碑帖在论坛被顶起来，老用户自发安利`, effect: m => { m.dau = Math.round(m.dau * 1.03); m.sat += 2; } },
  { id: "cluster-fault", w: 5, text: c => `凌晨存储集群一个节点故障，部分用户文件列表加载失败`, effect: m => { m.serverOk = false; m.sat -= 4; } },
  { id: "client-update", w: 5, text: c => `新版客户端上线「体积减半抵扣」功能，社区反馈不错`, effect: m => { m.sat += 2; } },
  { id: "migrate-in", w: 5, text: c => `某小网盘宣布停止服务，用户在找迁移目的地，转存请求暴增`, effect: m => { m.dau = Math.round(m.dau * 1.04); m.runway -= 0.1; } }
];

const STORAGE_RE = /网盘|云盘|云存储|存储/;

function isStorageCompany(company) {
  return STORAGE_RE.test(`${company.industry || ""}${company.product || ""}${company.name || ""}`);
}

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
  name: "123云盘",
  product: "个人云存储产品「123云盘」，主打大容量与上传下载不限速",
  industry: "个人网盘 / 云存储",
  stage: "创业公司，团队几十人，在巨头夹缝中靠口碑增长，正经历免费额度收紧与会员涨价的阵痛期",
  goal: "在带宽结算新规和硬件成本翻倍的双重压力下控住成本，提升会员付费转化，顶住夸克和百度网盘的挤压"
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
      this.metrics = isStorageCompany(this.company)
        // 网盘量级：日活百万级、靠会员收入和成本赛跑
        ? { dau: 860000, sat: 66, bugs: 27, serverOk: true, runway: 11 }
        : { dau: 1200, sat: 72, bugs: 14, serverOk: true, runway: 14 };
    }
    this.todayEvents = [];
    this.generateEvents();
  }

  get eventPool() {
    // 行业匹配时，专属事件占主导，再混入少量通用事件
    return isStorageCompany(this.company)
      ? STORAGE_EVENTS.concat(EVENT_POOL.filter(e => ["kol", "industry-report", "capital-cold"].includes(e.id)))
      : EVENT_POOL;
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

  /** 生成今日事件：优先用真实市场事件（最多 3 条），没有才虚构补位 */
  generateEvents(realEvents = []) {
    this.todayEvents = [];
    for (const ev of realEvents.slice(0, 3)) {
      // 真实事件不直接改指标（指标影响归市场反应模拟器，P3）
      this.todayEvents.push({ id: ev.id, text: ev.summary || ev.title, real: true });
    }
    if (this.todayEvents.length === 0) {
      const competitor = COMPETITORS[Math.floor(Math.random() * COMPETITORS.length)];
      const n = Math.random() < 0.45 ? 2 : 1;
      const used = new Set();
      for (let i = 0; i < n; i++) {
        const ev = pickWeighted(this.eventPool, used);
        used.add(ev.id);
        const text = ev.text(this.company, competitor);
        ev.effect(this.metrics);
        this.todayEvents.push({ id: ev.id, text });
      }
    }
    this.clampMetrics();
    this.save();
  }

  /** 进入新的一天：指标自然演化 + 新事件（realEvents 来自 sidecar） */
  nextDay(realEvents = []) {
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
    this.generateEvents(realEvents);
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
    return `今日产品数据：日活 ${m.dau.toLocaleString()}，用户满意度 ${m.sat} 分，待修 Bug ${m.bugs} 个，服务器${m.serverOk ? "运行正常" : "出现故障"}，现金还能支撑约 ${m.runway} 个月。`;
  }
}
