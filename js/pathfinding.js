// 简单网格 A* 寻路，供人物在办公室里绕开家具行走。

export class NavGrid {
  /**
   * @param {number} minX 世界坐标范围
   * @param {number} maxX
   * @param {number} minZ
   * @param {number} maxZ
   * @param {number} cell 网格大小（世界单位）
   */
  constructor(minX, maxX, minZ, maxZ, cell = 0.5) {
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.cols = Math.ceil((maxX - minX) / cell);
    this.rows = Math.ceil((maxZ - minZ) / cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
  }

  toCell(x, z) {
    return {
      c: Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell))),
      r: Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.minZ) / this.cell)))
    };
  }

  toWorld(c, r) {
    return {
      x: this.minX + (c + 0.5) * this.cell,
      z: this.minZ + (r + 0.5) * this.cell
    };
  }

  /** 将一个世界坐标矩形标记为障碍，pad 为额外留出的半径 */
  blockRect(cx, cz, w, d, pad = 0.25) {
    const x0 = cx - w / 2 - pad, x1 = cx + w / 2 + pad;
    const z0 = cz - d / 2 - pad, z1 = cz + d / 2 + pad;
    const a = this.toCell(x0, z0), b = this.toCell(x1, z1);
    for (let r = a.r; r <= b.r; r++) {
      for (let c = a.c; c <= b.c; c++) {
        this.blocked[r * this.cols + c] = 1;
      }
    }
  }

  isBlocked(c, r) {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return true;
    return this.blocked[r * this.cols + c] === 1;
  }

  /** 找到离 (c,r) 最近的可走格子 */
  nearestOpen(c, r) {
    if (!this.isBlocked(c, r)) return { c, r };
    for (let radius = 1; radius < 12; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
          if (!this.isBlocked(c + dc, r + dr)) return { c: c + dc, r: r + dr };
        }
      }
    }
    return { c, r };
  }

  /**
   * A* 寻路。返回世界坐标点数组（不含起点），找不到则返回空数组。
   */
  findPath(x0, z0, x1, z1) {
    let start = this.toCell(x0, z0);
    let goal = this.toCell(x1, z1);
    start = this.nearestOpen(start.c, start.r);
    goal = this.nearestOpen(goal.c, goal.r);

    const key = (c, r) => r * this.cols + c;
    const open = new Map();
    const gScore = new Map();
    const cameFrom = new Map();
    const startKey = key(start.c, start.r);
    const goalKey = key(goal.c, goal.r);

    const h = (c, r) => Math.abs(c - goal.c) + Math.abs(r - goal.r);
    gScore.set(startKey, 0);
    open.set(startKey, h(start.c, start.r));

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let found = false;
    let guard = this.cols * this.rows * 4;

    while (open.size > 0 && guard-- > 0) {
      // 取 f 值最小的节点
      let curKey = -1, best = Infinity;
      for (const [k, f] of open) {
        if (f < best) { best = f; curKey = k; }
      }
      if (curKey === goalKey) { found = true; break; }
      open.delete(curKey);

      const cc = curKey % this.cols;
      const cr = Math.floor(curKey / this.cols);
      const g0 = gScore.get(curKey);

      for (const [dc, dr] of dirs) {
        const nc = cc + dc, nr = cr + dr;
        if (this.isBlocked(nc, nr)) continue;
        // 禁止斜穿障碍角
        if (dc !== 0 && dr !== 0 && (this.isBlocked(cc + dc, cr) || this.isBlocked(cc, cr + dr))) continue;
        const nk = key(nc, nr);
        const ng = g0 + (dc !== 0 && dr !== 0 ? 1.414 : 1);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          cameFrom.set(nk, curKey);
          open.set(nk, ng + h(nc, nr));
        }
      }
    }

    if (!found) return [];

    // 回溯路径
    const cells = [];
    let k = goalKey;
    while (k !== startKey) {
      cells.push(k);
      k = cameFrom.get(k);
      if (k === undefined) return [];
    }
    cells.reverse();

    // 路径平滑：合并同方向的点
    const pts = [];
    let prevDir = null;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i] % this.cols;
      const r = Math.floor(cells[i] / this.cols);
      const pc = i === 0 ? start.c : cells[i - 1] % this.cols;
      const pr = i === 0 ? start.r : Math.floor(cells[i - 1] / this.cols);
      const dir = `${c - pc},${r - pr}`;
      if (dir !== prevDir && pts.length > 0) {
        // 方向变化，保留上一个点
      } else if (pts.length > 0) {
        pts.pop();
      }
      pts.push(this.toWorld(c, r));
      prevDir = dir;
    }
    // 终点精确到目标位置（若目标格未被阻挡）
    const gw = this.toWorld(goal.c, goal.r);
    if (Math.hypot(gw.x - x1, gw.z - z1) < this.cell * 1.5) {
      pts[pts.length - 1] = { x: x1, z: z1 };
    }
    return pts;
  }
}
