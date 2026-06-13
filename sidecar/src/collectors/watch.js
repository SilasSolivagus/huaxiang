// 竞品页面 diff 监控：抓页面 → 提取正文 → 与上次快照比对 → 有变化且相关则入库为「竞品动态」事件。
// 所有依赖注入（fetchPage/llm/store/pageStore），便于离线测试。

/** 从 HTML 提取可读正文：剔除 script/style/标签，解码常见实体，压缩空白 */
export function extractText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url); }
}

/**
 * 跑一轮竞品页监控：逐 URL 抓取 → 提取正文 → 比对快照 → 有变化且相关则入库。
 */
export async function runWatchOnce({ urls, fetchPage, llm, store, pageStore, companyBrief, threshold = 6, log = console.log }) {
  let checked = 0, changed = 0, inserted = 0;
  for (const url of urls) {
    let html;
    try { html = await fetchPage(url); }
    catch (e) { log(`竞品页抓取失败 ${url}: ${e.message}`); continue; }
    checked++;
    const text = extractText(html);
    if (!text) continue;

    const prev = pageStore.lastHash(url);
    const cur = pageStore.save(url, text);
    if (!prev || prev === cur) continue;   // 首次基线 / 无变化
    changed++;

    const host = hostOf(url);
    const title = `竞品「${host}」页面更新`;
    const scored = await llm.scoreBatch([{ title, snippet: text.slice(0, 400) }], companyBrief);
    if (!scored || !scored[0]) continue;
    if (scored[0].relevance >= threshold) {
      store.add({
        source: "watch",
        title,
        summary: scored[0].summary,
        url,
        relevance: scored[0].relevance,
        suggestedImpact: scored[0].suggestedImpact
      });
      inserted++;
    }
  }
  return { checked, changed, inserted };
}
