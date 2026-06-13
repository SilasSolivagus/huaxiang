// 本地 embedding 服务：懒加载 transformers.js 模型，批量产出归一化句向量。
// extractor 依赖注入：真实用 transformers.js pipeline（Task 3 接入），测试用假函数。

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {string} model 模型名
 * @param {{extractor?: (texts:string[]) => Promise<number[][]>}} deps
 */
export function createEmbedder(model, deps = {}) {
  let pipe = null, loading = null;
  async function realExtractor(texts) {
    if (!pipe) {
      if (!loading) {
        const { pipeline } = await import("@xenova/transformers");
        loading = pipeline("feature-extraction", model).then(p => { pipe = p; return p; });
      }
      await loading;
    }
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist();   // [[...], [...]]
  }
  const extractor = deps.extractor || realExtractor;

  async function embed(texts) {
    const list = (texts || []).map(t => String(t || ""));
    if (list.length === 0) return [];
    if (!extractor) throw new Error("embedder not ready");
    return await extractor(list);
  }

  return { model, embed };
}
