// 每日仓库动态摘要：最近提交 + 待办热点 + 大文件。给 Agent 当作"今天代码侧发生了什么"的素材。
import { analyzeRepo } from "./analysis.js";

export async function repoDigest(repo, { maxCommits = 10 } = {}) {
  const [commits, analysis] = await Promise.all([
    repo.log(maxCommits).catch(() => []),
    analyzeRepo(repo).catch(() => null)
  ]);

  const lines = [];
  lines.push(`最近提交（${commits.length} 条）：`);
  for (const c of commits) lines.push(`  - ${c.hash} ${c.subject}`);
  if (analysis) {
    lines.push(`代码规模：${analysis.fileCount} 个文件，源码 ${analysis.srcFileCount} 个；待办标记 ${analysis.todoCount} 处。`);
    if (analysis.hotFiles.length) {
      lines.push(`体量最大的文件：${analysis.hotFiles.slice(0, 3).map(f => `${f.path}(${f.lines}行)`).join("、")}`);
    }
  }
  return lines.join("\n");
}
