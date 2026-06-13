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

  return { root, run, resolveInside };
}
