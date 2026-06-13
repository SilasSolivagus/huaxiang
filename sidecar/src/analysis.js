// 静态分析：文件数、TODO/FIXME 数、按行数排序的复杂度热点文件。
// 只读：用 ripgrep 统计，不安装依赖、不执行仓库脚本。

const SRC_EXT = /\.(js|mjs|ts|tsx|jsx|py|go|java|rs|c|cpp|h|css|html|vue)$/;

export async function analyzeRepo(repo, { hotN = 8 } = {}) {
  const files = await repo.tree(2000);
  const srcFiles = files.filter(f => SRC_EXT.test(f));

  // TODO / FIXME 计数：rg -c 输出每文件命中数 "file:count"
  let todoCount = 0;
  try {
    const out = await repo.run("rg", ["-c", "-i", "--", "TODO|FIXME|HACK|XXX", repo.root], repo.root);
    for (const line of String(out).split("\n").filter(Boolean)) {
      const n = Number(line.slice(line.lastIndexOf(":") + 1));
      if (Number.isFinite(n)) todoCount += n;
    }
  } catch (e) {
    if (e.code !== 1) todoCount = 0;   // 退出码 1 = 无命中
  }

  // 复杂度热点：按行数排序的最大源文件（行数是粗略的复杂度代理）
  const counted = [];
  for (const f of srcFiles.slice(0, 800)) {
    try {
      const { text } = await repo.readFile(f, 200000);
      counted.push({ path: f, lines: text.split("\n").length });
    } catch {}
  }
  counted.sort((a, b) => b.lines - a.lines);

  return {
    fileCount: files.length,
    srcFileCount: srcFiles.length,
    todoCount,
    hotFiles: counted.slice(0, hotN),
    at: null   // 时间戳由调用方在落地时补
  };
}
