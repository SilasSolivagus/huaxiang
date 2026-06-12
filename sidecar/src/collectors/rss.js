// RSS 采集器：拉源 → URL 去重 → LLM 批量打分摘要 → 过阈值入库。
// 所有依赖注入（parser/llm/store），便于离线测试。

export async function runRssOnce({ feeds, parser, llm, store, companyBrief, threshold = 6, log = console.log }) {
  let fetched = 0;
  let inserted = 0;
  for (const feedUrl of feeds) {
    let parsed;
    try {
      parsed = await parser.parseURL(feedUrl);
    } catch (e) {
      log(`RSS 拉取失败 ${feedUrl}: ${e.message}`);
      continue;
    }
    const items = (parsed.items || []).filter(it => it.link && it.title).slice(0, 30);
    fetched += items.length;

    const freshLinks = store.filterUnseen(items.map(it => it.link));
    const fresh = items.filter(it => freshLinks.includes(it.link)).slice(0, 10);
    if (fresh.length === 0) continue;
    store.markSeen(fresh.map(it => it.link));

    const scored = await llm.scoreBatch(
      fresh.map(it => ({ title: it.title, snippet: it.contentSnippet || "" })),
      companyBrief
    );
    if (!scored) continue; // 无 key 或解析失败：本轮放弃（URL 已 seen，不会反复积压）

    fresh.forEach((it, i) => {
      const s = scored[i];
      if (s && s.relevance >= threshold) {
        store.add({
          source: "rss",
          title: it.title,
          summary: s.summary,
          url: it.link,
          relevance: s.relevance,
          suggestedImpact: s.suggestedImpact
        });
        inserted++;
      }
    });
  }
  return { fetched, inserted };
}
