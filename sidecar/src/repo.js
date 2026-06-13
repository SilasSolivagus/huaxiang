// 只读代码仓库服务：路径白名单 + tree/readFile/grep/log。
// 命令一律用 execFile（无 shell，杜绝注入）、带超时；只读，永不执行仓库内脚本。
import { realpathSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFile } from "node:child_process";

function defaultRun(cmd, args, cwd) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { err.stdout = stdout; return rej(err); }
      res(stdout);
    });
  });
}

export function createRepoService(rootPath, deps = {}) {
  const run = deps.run || defaultRun;
  let root;
  try { root = realpathSync(resolve(rootPath)); } catch { root = resolve(rootPath); }

  function resolveInside(rel) {
    const str = String(rel || "");
    if (/^[/\\]/.test(str)) throw new Error("path escapes repo root");
    const cleaned = str;
    const abs = resolve(root, cleaned);
    let real;
    try { real = realpathSync(abs); } catch { real = abs; }   // 文件不存在时按规范化路径判断
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error("path escapes repo root");
    }
    return real;
  }

  // 文件清单：用 ripgrep --files（自动遵守 .gitignore、跳过 node_modules/.git），相对路径
  async function tree(maxFiles = 400) {
    let out;
    try { out = await run("rg", ["--files"], root); }
    catch (e) { if (e.code === 1) return []; throw e; }
    return out.split("\n").map(s => s.trim()).filter(Boolean).slice(0, maxFiles);
  }

  // 读单文件：白名单校验 + 截断
  async function readFile(rel, maxBytes = 20000) {
    const abs = resolveInside(rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error("not a file");
    const full = readFileSync(abs, "utf8");
    const truncated = full.length > maxBytes;
    return { path: rel, text: truncated ? full.slice(0, maxBytes) : full, truncated, bytes: st.size };
  }

  return { root, run, resolveInside, tree, readFile };
}
