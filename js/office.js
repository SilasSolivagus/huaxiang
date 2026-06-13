// 搭建 3D 办公室场景：两个办公地点——左侧产研区、右侧运营区，中间玻璃隔断带门洞。
// 返回各区的功能点位（工位、会议座位、咖啡角、闲逛点）、CTO 独立办公室、CEO 工位与寻路网格。

import * as THREE from "three";
import { NavGrid } from "./pathfinding.js";

const W = 38;   // 办公室宽（x 方向）
const D = 16;   // 办公室深（z 方向）

function box(w, h, d, color, opts = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts.mat })
  );
  mesh.castShadow = opts.castShadow ?? true;
  mesh.receiveShadow = opts.receiveShadow ?? true;
  return mesh;
}

function cylinder(rt, rb, h, color, seg = 16) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(rt, rb, h, seg),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeDesk(scene, x, z) {
  const g = new THREE.Group();
  const top = box(1.8, 0.08, 0.9, 0xc8a275);
  top.position.y = 0.72;
  g.add(top);
  for (const [dx, dz] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]]) {
    const leg = box(0.07, 0.72, 0.07, 0x8a6f52);
    leg.position.set(dx, 0.36, dz);
    g.add(leg);
  }
  const screen = box(0.62, 0.4, 0.04, 0x222831);
  screen.position.set(0, 1.12, -0.22);
  g.add(screen);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 0.34),
    new THREE.MeshBasicMaterial({ color: 0x9fd4ff })
  );
  glow.position.set(0, 1.12, -0.198);
  g.add(glow);
  const stand = box(0.07, 0.28, 0.07, 0x333a45);
  stand.position.set(0, 0.9, -0.24);
  g.add(stand);
  const kb = box(0.45, 0.025, 0.16, 0x3a4250);
  kb.position.set(0, 0.78, 0.1);
  g.add(kb);
  g.position.set(x, 0, z);
  scene.add(g);
  return g;
}

function makeChair(scene, x, z, ry = 0, color = 0x4a5568) {
  const g = new THREE.Group();
  const seat = box(0.46, 0.06, 0.46, color);
  seat.position.y = 0.45;
  g.add(seat);
  const back = box(0.46, 0.5, 0.06, color);
  back.position.set(0, 0.73, 0.22);
  g.add(back);
  const pole = cylinder(0.04, 0.04, 0.45, 0x2d3340);
  pole.position.y = 0.22;
  g.add(pole);
  const base = cylinder(0.24, 0.24, 0.04, 0x2d3340);
  base.position.y = 0.02;
  g.add(base);
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  scene.add(g);
  return g;
}

function makePlant(scene, x, z, scale = 1) {
  const g = new THREE.Group();
  const pot = cylinder(0.18, 0.14, 0.3, 0xb55b41);
  pot.position.y = 0.15;
  g.add(pot);
  const leaves = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.32, 1),
    new THREE.MeshStandardMaterial({ color: 0x3f9c54, roughness: 0.9, flatShading: true })
  );
  leaves.position.y = 0.58;
  leaves.castShadow = true;
  g.add(leaves);
  const leaves2 = leaves.clone();
  leaves2.position.set(0.12, 0.74, 0.06);
  leaves2.scale.setScalar(0.6);
  g.add(leaves2);
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  scene.add(g);
  return g;
}

// 一张工位 → 返回坐下点位、朝向点、协作站位
function buildWorkstation(scene, x, z) {
  makeDesk(scene, x, z);
  makeChair(scene, x, z + 0.85, Math.PI);
  return {
    seat: { x, z: z + 0.85 },
    lookAt: { x, z },
    standSpot: { x: x + 1.35, z: z + 0.9 }
  };
}

// 一张会议桌 + 两侧座位 → 返回座位点位数组
function buildMeetingTable(scene, cx, cz, tableW, perSide, tableColor = 0x9b7653) {
  const mTable = box(tableW, 0.1, 1.4, tableColor);
  mTable.position.set(cx, 0.72, cz);
  scene.add(mTable);
  const halfLegX = tableW / 2 - 0.2;
  for (const [dx, dz] of [[-halfLegX, -0.5], [halfLegX, -0.5], [-halfLegX, 0.5], [halfLegX, 0.5]]) {
    const leg = box(0.08, 0.72, 0.08, 0x6e543c);
    leg.position.set(cx + dx, 0.36, cz + dz);
    scene.add(leg);
  }
  const seats = [];
  const span = tableW - 1.2;
  const step = perSide > 1 ? span / (perSide - 1) : 0;
  const startX = cx - span / 2;
  for (let i = 0; i < perSide; i++) {
    const sx = startX + step * i;
    makeChair(scene, sx, cz - 1.2, 0, 0x806044);
    seats.push({ x: sx, z: cz - 1.2, lookAt: { x: sx, z: cz } });
    makeChair(scene, sx, cz + 1.2, Math.PI, 0x806044);
    seats.push({ x: sx, z: cz + 1.2, lookAt: { x: sx, z: cz } });
  }
  return seats;
}

// 咖啡角：吧台 + 圆桌 + 高脚凳 → 返回站位数组
function buildCoffeeCorner(scene, cx, cz) {
  const counter = box(0.8, 0.9, 2.2, 0x7a5d43);
  counter.position.set(cx + 1.9, 0.45, cz - 0.4);
  scene.add(counter);
  const machine = box(0.42, 0.5, 0.42, 0x37404d);
  machine.position.set(cx + 1.9, 1.15, cz - 0.9);
  scene.add(machine);
  const roundTop = cylinder(0.55, 0.55, 0.06, 0xc8a275, 24);
  roundTop.position.set(cx, 0.95, cz);
  scene.add(roundTop);
  const roundLeg = cylinder(0.06, 0.1, 0.95, 0x6e543c);
  roundLeg.position.set(cx, 0.47, cz);
  scene.add(roundLeg);
  const spots = [];
  for (const a of [0.4, 1.9, 3.5, 5.0]) {
    const sx = cx + Math.cos(a) * 1.05;
    const sz = cz + Math.sin(a) * 1.05;
    const stool = cylinder(0.2, 0.16, 0.55, 0xb55b41);
    stool.position.set(sx, 0.27, sz);
    scene.add(stool);
    spots.push({ x: sx, z: sz, lookAt: { x: cx, z: cz } });
  }
  return spots;
}

export function buildOffice(scene) {
  // ---------- 地板 ----------
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(W, 0.2, D),
    new THREE.MeshStandardMaterial({ color: 0xd9c4a3, roughness: 0.95 })
  );
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  scene.add(floor);

  // 产研区地毯（左）
  const rugRd = new THREE.Mesh(
    new THREE.BoxGeometry(15, 0.04, 8),
    new THREE.MeshStandardMaterial({ color: 0x7f9bb3, roughness: 1 })
  );
  rugRd.position.set(-7.5, 0.02, 1.8);
  rugRd.receiveShadow = true;
  scene.add(rugRd);

  // 运营区地毯（右）
  const rugOps = new THREE.Mesh(
    new THREE.BoxGeometry(13, 0.04, 8),
    new THREE.MeshStandardMaterial({ color: 0xc7a07f, roughness: 1 })
  );
  rugOps.position.set(9, 0.02, 1.8);
  rugOps.receiveShadow = true;
  scene.add(rugOps);

  // ---------- 外墙 ----------
  const mkWall = (w, d, x, z) => {
    const wall = box(w, 1.15, d, 0xe8e2d6);
    wall.position.set(x, 1.15 / 2, z);
    scene.add(wall);
  };
  mkWall(W, 0.25, 0, -D / 2);   // 北
  mkWall(W, 0.25, 0, D / 2);    // 南
  mkWall(0.25, D, -W / 2, 0);   // 西
  mkWall(0.25, D, W / 2, 0);    // 东

  // ---------- 玻璃隔断工具 ----------
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9fd8e8, transparent: true, opacity: 0.32, roughness: 0.2
  });
  const mkGlass = (w, d, x, z) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1.3, d), glassMat);
    wall.position.set(x, 0.65, z);
    scene.add(wall);
    const frame = box(Math.max(w, 0.1), 0.06, Math.max(d, 0.1), 0x6b7686);
    frame.position.set(x, 1.33, z);
    scene.add(frame);
  };

  // ---------- 中间隔断（x=0，留门洞 z∈[-0.5,1.5]）----------
  mkGlass(0.14, 7.5, 0, -4.25);   // 上段 z[-8,-0.5]
  mkGlass(0.14, 6.5, 0, 4.75);    // 下段 z[1.5,8]

  // ============================================================
  //  产研区（x < 0）
  // ============================================================
  const rd = { desks: [], meetingSeats: [], coffeeSpots: [], wanderSpots: [] };

  // CTO 独立办公室：西北角玻璃房 x[-18.5,-13.5] z[-8,-4.2]，门洞在南墙 x[-15.5,-14]
  mkGlass(3, 0.12, -17, -4.2);       // 南墙左段 x[-18.5,-15.5]
  mkGlass(0.5, 0.12, -13.75, -4.2);  // 南墙右段 x[-14,-13.5]
  mkGlass(0.12, 3.8, -13.5, -6.1);   // 东墙 z[-8,-4.2]
  const ctoDesk = buildWorkstation(scene, -16, -6.2);
  const ctoOffice = {
    seat: ctoDesk.seat,
    lookAt: ctoDesk.lookAt,
    standSpot: { x: -14.7, z: -5 }   // 门口附近，访客站位
  };
  // CTO 办公室标牌植物
  makePlant(scene, -17.6, -7, 0.9);

  // 产研开放工位：4 列 × 2 排 = 8 个
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const x = -12 + col * 3;
      const z = row === 0 ? -0.5 : 4;
      rd.desks.push(buildWorkstation(scene, x, z));
    }
  }

  // 产研会议室：北侧 x[-12.5,-3.5]，桌心 (-8,-6.0)
  mkGlass(3, 0.12, -11, -4.4);       // 南墙左段
  mkGlass(3, 0.12, -5, -4.4);        // 南墙右段（门洞 x[-9.5,-6.5] 留空）
  mkGlass(0.12, 3.6, -3.5, -6.2);    // 东墙
  rd.meetingSeats = buildMeetingTable(scene, -8, -6.0, 3.4, 3);

  // 产研白板
  const wb = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.1, 0.06),
    new THREE.MeshStandardMaterial({ color: 0xf7f7f2, roughness: 0.4 })
  );
  wb.position.set(-8, 1.15, -7.7);
  scene.add(wb);

  // 产研咖啡角：西南 (-15.5, 5.5)
  rd.coffeeSpots = buildCoffeeCorner(scene, -15.5, 5.5);
  rd.coffeeSpots.push({ x: -16.8, z: 6.6, lookAt: { x: -15.5, z: 5.5 } });

  rd.wanderSpots = [
    { x: -9, z: 2 }, { x: -5, z: 6 }, { x: -16, z: 1 }, { x: -2.5, z: 3 }
  ];

  // ============================================================
  //  运营区（x > 0）
  // ============================================================
  const ops = { desks: [], meetingSeats: [], coffeeSpots: [], wanderSpots: [] };

  // 运营开放工位：3 个（离谱 / 艳君 / 小月）
  for (let col = 0; col < 3; col++) {
    ops.desks.push(buildWorkstation(scene, 4 + col * 4, 4));
  }

  // CEO 工位：东北角的「老板位」(15,-5.5)，相对独立
  const ceoDesk = buildWorkstation(scene, 15, -5.5);
  const ceoHome = {
    seat: ceoDesk.seat,
    lookAt: ceoDesk.lookAt,
    standSpot: { x: 13.6, z: -4.8 },
    x: 15, z: -5.5
  };
  makePlant(scene, 17.4, -6.8, 1.0);

  // 运营会议区：北侧 x[3,11]，桌心 (7,-6.0)
  mkGlass(2.6, 0.12, 4.3, -4.4);
  mkGlass(2.6, 0.12, 9.7, -4.4);     // 门洞 x[5.6,8.4]
  ops.meetingSeats = buildMeetingTable(scene, 7, -6.0, 2.8, 2, 0x8a6a48);

  // 运营休息角（沙发 + 圆桌）：东南 (15.5,5)
  const sofa = new THREE.Group();
  const sofaBase = box(2.2, 0.45, 0.85, 0x5d7f9e);
  sofaBase.position.y = 0.25;
  sofa.add(sofaBase);
  const sofaBack = box(2.2, 0.55, 0.22, 0x517091);
  sofaBack.position.set(0, 0.62, 0.34);
  sofa.add(sofaBack);
  sofa.position.set(15.5, 0, 6.4);
  scene.add(sofa);
  ops.coffeeSpots = buildCoffeeCorner(scene, 14.5, 4.4);
  ops.coffeeSpots.push({ x: 15.5, z: 5.4, lookAt: { x: 15.5, z: 6.4 } });

  ops.wanderSpots = [
    { x: 7, z: 1.5 }, { x: 12, z: 6 }, { x: 4, z: 0.5 }, { x: 10, z: -3 }
  ];

  // ---------- 绿植点缀 ----------
  makePlant(scene, -18, 7, 1.1);
  makePlant(scene, -0.8, 7, 0.9);
  makePlant(scene, 1.2, -7, 0.9);
  makePlant(scene, 18, 7, 1.0);

  // ============================================================
  //  寻路网格
  // ============================================================
  const grid = new NavGrid(-W / 2 + 0.6, W / 2 - 0.6, -D / 2 + 0.6, D / 2 - 0.6, 0.4);

  // 中间隔断（留门洞 z[-0.5,1.5]）
  grid.blockRect(0, -4.25, 0.3, 7.5, 0.1);
  grid.blockRect(0, 4.75, 0.3, 6.5, 0.1);

  // CTO 办公室墙
  grid.blockRect(-17, -4.2, 3, 0.2, 0.1);
  grid.blockRect(-13.75, -4.2, 0.5, 0.2, 0.1);
  grid.blockRect(-13.5, -6.1, 0.2, 3.8, 0.1);
  grid.blockRect(-16, -6.2, 1.8, 0.9, 0.15);   // CTO 桌

  // 产研工位
  for (const d of rd.desks) grid.blockRect(d.lookAt.x, d.lookAt.z, 1.8, 0.9, 0.15);
  // 产研会议室墙 + 桌
  grid.blockRect(-11, -4.4, 3, 0.2, 0.1);
  grid.blockRect(-5, -4.4, 3, 0.2, 0.1);
  grid.blockRect(-3.5, -6.2, 0.2, 3.6, 0.1);
  grid.blockRect(-8, -6.0, 3.4, 1.4, 0.15);
  // 产研咖啡角
  grid.blockRect(-13.6, 5.1, 0.8, 2.2, 0.15);
  grid.blockRect(-15.5, 5.5, 0.9, 0.9, 0.1);

  // 运营工位
  for (const d of ops.desks) grid.blockRect(d.lookAt.x, d.lookAt.z, 1.8, 0.9, 0.15);
  // CEO 桌
  grid.blockRect(15, -5.5, 1.8, 0.9, 0.15);
  // 运营会议室墙 + 桌
  grid.blockRect(4.3, -4.4, 2.6, 0.2, 0.1);
  grid.blockRect(9.7, -4.4, 2.6, 0.2, 0.1);
  grid.blockRect(7, -6.0, 2.8, 1.4, 0.15);
  // 运营休息角
  grid.blockRect(15.5, 6.4, 2.2, 0.85, 0.15);
  grid.blockRect(16.4, 4.0, 0.8, 2.2, 0.15);
  grid.blockRect(14.5, 4.4, 0.9, 0.9, 0.1);

  // 绿植
  for (const [px, pz] of [[-18, 7], [-0.8, 7], [1.2, -7], [18, 7], [-17.6, -7], [17.4, -6.8]]) {
    grid.blockRect(px, pz, 0.6, 0.6, 0.1);
  }

  return { grid, rd, ops, ctoOffice, ceoHome };
}
