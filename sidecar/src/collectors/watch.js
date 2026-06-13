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
