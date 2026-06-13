// sidecar HTTP 服务：API + SSE + 静态托管前端。
// buildApp 纯组装（可测试)；直接运行本文件时连真实依赖并启动采集循环。
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Parser from "rss-parser";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { PolicyStore } from "./policyStore.js";
import { SidecarLLM } from "./llm.js";
import { runRssOnce } from "./collectors/rss.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = join(__dirname, "..");
const FRONTEND_ROOT = join(SIDECAR_ROOT, "..");

export function loadConfig() {
  const defaults = {
    port: 7878, company: "", feeds: [], relevanceThreshold: 6, rssIntervalMinutes: 30,
    repoPath: "", repoDigestMaxCommits: 10
  };
  const path = join(SIDECAR_ROOT, "config.json");
  if (!existsSync(path)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    console.warn("config.json 解析失败，使用默认配置：", e.message);
    return defaults;
  }
}

export function buildApp({ eventStore, policyStore, status, repo = null, analysisProvider = null, digestProvider = null }) {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, today: eventStore.todayCount(), collectors: status.collectors, repo: status.repo });
  });

  app.get("/api/snapshot", (req, res) => {
    res.json({ events: eventStore.listUnconsumed(), policies: policyStore.list() });
  });

  app.post("/api/events/ack", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ acked: eventStore.ack(ids) });
  });

  app.get("/api/stream", (req, res) => {
    res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    res.write(":connected\n\n");
    const unsub = eventStore.subscribe(ev => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const hb = setInterval(() => res.write(":hb\n\n"), 25000);
    req.on("close", () => { unsub(); clearInterval(hb); });
  });

  app.get("/api/policies", (req, res) => res.json(policyStore.list(req.query.all === "1")));
  app.post("/api/policies", (req, res) => {
    try {
      res.json(policyStore.create(req.body?.text));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.delete("/api/policies/:id", (req, res) => res.json({ ok: policyStore.deactivate(req.params.id) }));

  // ---------- 代码仓库（只读，需配置 repoPath）----------
  const repoGuard = (req, res, next) => {
    if (!repo) return res.status(503).json({ error: "repo 未配置（在 config.json 设置 repoPath）" });
    next();
  };

  app.get("/api/repo/tree", repoGuard, async (req, res) => {
    try { res.json({ files: await repo.tree() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/repo/file", repoGuard, async (req, res) => {
    try { res.json(await repo.readFile(String(req.query.path || ""))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/repo/grep", repoGuard, async (req, res) => {
    try { res.json({ hits: await repo.grep(String(req.query.q || "")) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/repo/log", repoGuard, async (req, res) => {
    try { res.json({ commits: await repo.log(Number(req.query.n) || 10) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/repo/digest", repoGuard, async (req, res) => {
    try { res.json({ text: digestProvider ? await digestProvider() : "" }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/analysis", repoGuard, async (req, res) => {
    try { res.json(analysisProvider ? await analysisProvider() : {}); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 静态托管仓库根，但屏蔽点文件（.git 等）与 sidecar 自身（源码/数据库）。
  // 必须对解码后的路径判断——express.static 内部会解码百分号编码。
  app.use((req, res, next) => {
    let decoded;
    try { decoded = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
    const segs = decoded.split("/");
    if (segs.some(s => s.startsWith(".")) || segs[1] === "sidecar") return res.status(403).end();
    next();
  });
  app.use(express.static(FRONTEND_ROOT, { dotfiles: "deny" }));
  return app;
}

// 直接运行：node --env-file-if-exists=.env src/server.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const db = openDb(join(SIDECAR_ROOT, "data", "huaxiang.db"));
  const eventStore = new EventStore(db);
  const policyStore = new PolicyStore(db);
  const llm = new SidecarLLM();
  const parser = new Parser({ timeout: 10000 });

  let repo = null;
  let repoReason = "未配置 repoPath（见 config.example.json）";
  if (cfg.repoPath) {
    try {
      const { createRepoService } = await import("./repo.js");
      repo = createRepoService(cfg.repoPath);
      repoReason = null;
    } catch (e) {
      repoReason = `repoPath 无效：${e.message}`;
    }
  }

  const rssReason = !llm.enabled
    ? "未配置 SIDECAR_API_KEY / SIDECAR_MODEL（见 .env.example）"
    : cfg.feeds.length === 0
      ? "config.json 未配置 feeds（见 config.example.json）"
      : null;
  const status = {
    collectors: { rss: { enabled: !rssReason, lastRun: null, lastResult: null, reason: rssReason } },
    repo: { enabled: !!repo, path: cfg.repoPath || "", reason: repoReason }
  };

  const { analyzeRepo } = await import("./analysis.js");
  const { repoDigest } = await import("./digest.js");
  const app = buildApp({
    eventStore, policyStore, status, repo,
    analysisProvider: repo ? () => analyzeRepo(repo) : null,
    digestProvider: repo ? () => repoDigest(repo, { maxCommits: cfg.repoDigestMaxCommits }) : null
  });
  app.listen(cfg.port, "127.0.0.1", () => {
    console.log(`sidecar 运行中：http://127.0.0.1:${cfg.port}（办公室页面也从这里打开）`);
    if (rssReason) console.log(`⚠️ RSS 采集器未启用：${rssReason}`);
    if (repoReason) console.log(`ℹ️ 代码仓库未挂载：${repoReason}`);
    else console.log(`📂 已挂载只读代码仓库：${cfg.repoPath}`);
  });

  async function rssTick() {
    if (!status.collectors.rss.enabled) return;
    status.collectors.rss.lastRun = Date.now();
    try {
      status.collectors.rss.lastResult = await runRssOnce({
        feeds: cfg.feeds, parser, llm, store: eventStore,
        companyBrief: cfg.company, threshold: cfg.relevanceThreshold
      });
      console.log(`RSS 采集完成：抓 ${status.collectors.rss.lastResult.fetched} 条，入库 ${status.collectors.rss.lastResult.inserted} 条`);
    } catch (e) {
      status.collectors.rss.lastResult = { error: e.message };
      console.warn("RSS 采集异常：", e.message);
    }
  }
  rssTick();
  setInterval(rssTick, cfg.rssIntervalMinutes * 60 * 1000);
}
