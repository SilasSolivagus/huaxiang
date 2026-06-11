// 搭建 3D 办公室场景，并返回各功能点位（工位、会议室座位、咖啡角等）与寻路网格。

import * as THREE from "three";
import { NavGrid } from "./pathfinding.js";

const W = 23;   // 办公室宽（x 方向）
const D = 15;   // 办公室深（z 方向）

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
  // 显示器
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
  // 键盘
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

export function buildOffice(scene) {
  // ---------- 地板 ----------
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(W, 0.2, D),
    new THREE.MeshStandardMaterial({ color: 0xd9c4a3, roughness: 0.95 })
  );
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  scene.add(floor);

  // 工作区地毯
  const rug = new THREE.Mesh(
    new THREE.BoxGeometry(10.4, 0.04, 9),
    new THREE.MeshStandardMaterial({ color: 0x7f9bb3, roughness: 1 })
  );
  rug.position.set(-5.5, 0.02, -0.8);
  rug.receiveShadow = true;
  scene.add(rug);

  // 咖啡角地毯
  const rug2 = new THREE.Mesh(
    new THREE.BoxGeometry(5.6, 0.04, 4),
    new THREE.MeshStandardMaterial({ color: 0xc77f5e, roughness: 1 })
  );
  rug2.position.set(7.8, 0.02, 5);
  rug2.receiveShadow = true;
  scene.add(rug2);

  // ---------- 外墙（矮墙，方便俯视） ----------
  const wallMat = { mat: { color: 0xe8e2d6 } };
  const wallH = 1.15;
  const mkWall = (w, d, x, z) => {
    const wall = box(w, wallH, d, 0xe8e2d6);
    wall.position.set(x, wallH / 2, z);
    scene.add(wall);
  };
  mkWall(W, 0.25, 0, -D / 2);          // 北
  mkWall(W, 0.25, 0, D / 2);           // 南
  mkWall(0.25, D, -W / 2, 0);          // 西
  mkWall(0.25, D, W / 2, 0);           // 东

  // ---------- 会议室隔断（玻璃墙） ----------
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9fd8e8, transparent: true, opacity: 0.32, roughness: 0.2
  });
  const mkGlass = (w, d, x, z) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1.3, d), glassMat);
    wall.position.set(x, 0.65, z);
    scene.add(wall);
    // 玻璃顶框
    const frame = box(Math.max(w, 0.1), 0.06, Math.max(d, 0.1), 0x6b7686);
    frame.position.set(x, 1.33, z);
    scene.add(frame);
  };
  // 西侧玻璃墙：x=3.5, z 从 -7.5 到 -1
  mkGlass(0.12, 6.5, 3.5, -4.25);
  // 南侧玻璃墙：z=-1，x 从 5.2 到 11.5（留出门洞 3.5~5.2）
  mkGlass(6.3, 0.12, 8.35, -1);

  // ---------- 工位（2 排 × 3）----------
  // 每个工位：desk 在前，椅子在 +z 侧，人坐下后面向 -z（朝向显示器）
  const deskDefs = [
    { x: -9,   z: -3.5 }, { x: -5.5, z: -3.5 }, { x: -2, z: -3.5 },
    { x: -9,   z: 1.5  }, { x: -5.5, z: 1.5  }, { x: -2, z: 1.5 }
  ];
  const desks = [];
  for (const d of deskDefs) {
    makeDesk(scene, d.x, d.z);
    makeChair(scene, d.x, d.z + 0.85, Math.PI); // 椅背朝 +z
    desks.push({
      seat: { x: d.x, z: d.z + 0.85 },          // 坐下的位置
      lookAt: { x: d.x, z: d.z },               // 坐下后面向桌子
      standSpot: { x: d.x + 1.35, z: d.z + 0.9 } // 同事过来协作时站的位置
    });
  }

  // ---------- 会议室 ----------
  const mTable = box(3.4, 0.1, 1.4, 0x9b7653);
  mTable.position.set(7.25, 0.72, -4.2);
  scene.add(mTable);
  for (const [dx, dz] of [[-1.5, -0.5], [1.5, -0.5], [-1.5, 0.5], [1.5, 0.5]]) {
    const leg = box(0.08, 0.72, 0.08, 0x6e543c);
    leg.position.set(7.25 + dx, 0.36, -4.2 + dz);
    scene.add(leg);
  }
  const meetingSeats = [];
  const seatXs = [6.05, 7.25, 8.45];
  for (const sx of seatXs) {
    makeChair(scene, sx, -5.4, 0, 0x806044);
    meetingSeats.push({ x: sx, z: -5.4, lookAt: { x: sx, z: -4.2 } });
  }
  for (const sx of seatXs) {
    makeChair(scene, sx, -3.0, Math.PI, 0x806044);
    meetingSeats.push({ x: sx, z: -3.0, lookAt: { x: sx, z: -4.2 } });
  }
  // 白板
  const wbBoard = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.1, 0.06),
    new THREE.MeshStandardMaterial({ color: 0xf7f7f2, roughness: 0.4 })
  );
  wbBoard.position.set(7.25, 1.15, -7.28);
  scene.add(wbBoard);
  const wbFrame = box(2.36, 1.24, 0.04, 0x6b7686);
  wbFrame.position.set(7.25, 1.15, -7.32);
  scene.add(wbFrame);
  // 白板上的"字"
  for (let i = 0; i < 4; i++) {
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7 + Math.random() * 0.9, 0.05),
      new THREE.MeshBasicMaterial({ color: [0x4f8cff, 0xe05a4e, 0x3dbf7a, 0x333][i % 4] })
    );
    line.position.set(6.6 + Math.random() * 0.6, 1.45 - i * 0.2, -7.24);
    scene.add(line);
  }

  // ---------- 咖啡角 ----------
  const counter = box(0.8, 0.9, 2.6, 0x7a5d43);
  counter.position.set(10.7, 0.45, 4.6);
  scene.add(counter);
  const machine = box(0.42, 0.5, 0.42, 0x37404d);
  machine.position.set(10.7, 1.15, 4.0);
  scene.add(machine);
  const mugColors = [0xe05a4e, 0x4f8cff, 0xf0a93c];
  mugColors.forEach((c, i) => {
    const mug = cylinder(0.06, 0.05, 0.1, c, 10);
    mug.position.set(10.7, 0.95, 4.8 + i * 0.3);
    scene.add(mug);
  });
  // 圆桌 + 高脚凳
  const roundTop = cylinder(0.55, 0.55, 0.06, 0xc8a275, 24);
  roundTop.position.set(7.6, 0.95, 5.1);
  scene.add(roundTop);
  const roundLeg = cylinder(0.06, 0.1, 0.95, 0x6e543c);
  roundLeg.position.set(7.6, 0.47, 5.1);
  scene.add(roundLeg);

  const coffeeSpots = [];
  const stoolAngles = [0.4, 1.9, 3.5, 5.0];
  for (const a of stoolAngles) {
    const sx = 7.6 + Math.cos(a) * 1.05;
    const sz = 5.1 + Math.sin(a) * 1.05;
    const stool = cylinder(0.2, 0.16, 0.55, 0xb55b41);
    stool.position.set(sx, 0.27, sz);
    scene.add(stool);
    coffeeSpots.push({ x: sx, z: sz, lookAt: { x: 7.6, z: 5.1 } });
  }
  // 咖啡机旁站位
  coffeeSpots.push({ x: 9.9, z: 4.1, lookAt: { x: 10.7, z: 4.0 } });
  coffeeSpots.push({ x: 9.9, z: 5.2, lookAt: { x: 10.7, z: 4.6 } });

  // ---------- 绿植与装饰 ----------
  makePlant(scene, -10.8, -6.8, 1.2);
  makePlant(scene, -10.8, 6.8, 1.1);
  makePlant(scene, 2.6, 6.8, 1.0);
  makePlant(scene, 10.9, -0.2, 1.1);
  makePlant(scene, 4.1, -6.9, 0.9);

  // 沙发（休息区）
  const sofa = new THREE.Group();
  const sofaBase = box(2.2, 0.45, 0.85, 0x5d7f9e);
  sofaBase.position.y = 0.25;
  sofa.add(sofaBase);
  const sofaBack = box(2.2, 0.55, 0.22, 0x517091);
  sofaBack.position.set(0, 0.62, 0.34);
  sofa.add(sofaBack);
  for (const dx of [-1.0, 1.0]) {
    const arm = box(0.22, 0.6, 0.85, 0x517091);
    arm.position.set(dx + (dx > 0 ? 0.1 : -0.1), 0.35, 0);
    sofa.add(arm);
  }
  sofa.position.set(5.6, 0, 6.7);
  scene.add(sofa);

  // ---------- 寻路网格 ----------
  const grid = new NavGrid(-W / 2 + 0.5, W / 2 - 0.5, -D / 2 + 0.5, D / 2 - 0.5, 0.4);
  // 工位桌子
  for (const d of deskDefs) grid.blockRect(d.x, d.z, 1.8, 0.9, 0.15);
  // 会议桌
  grid.blockRect(7.25, -4.2, 3.4, 1.4, 0.15);
  // 玻璃墙
  grid.blockRect(3.5, -4.25, 0.12, 6.5, 0.2);
  grid.blockRect(8.35, -1, 6.3, 0.12, 0.2);
  // 咖啡角家具
  grid.blockRect(10.7, 4.6, 0.8, 2.6, 0.15);
  grid.blockRect(7.6, 5.1, 0.9, 0.9, 0.1);
  // 沙发与绿植
  grid.blockRect(5.6, 6.7, 2.2, 0.85, 0.15);
  grid.blockRect(-10.8, -6.8, 0.6, 0.6, 0.1);
  grid.blockRect(-10.8, 6.8, 0.6, 0.6, 0.1);
  grid.blockRect(2.6, 6.8, 0.6, 0.6, 0.1);
  grid.blockRect(10.9, -0.2, 0.6, 0.6, 0.1);
  grid.blockRect(4.1, -6.9, 0.5, 0.5, 0.1);

  // 自由走动的闲逛点
  const wanderSpots = [
    { x: -5.5, z: 5.5 }, { x: 0.8, z: 3.5 }, { x: -10, z: -0.5 },
    { x: 1.5, z: -5.5 }, { x: 0.5, z: 0 }, { x: -3, z: 5.8 }
  ];

  return { desks, meetingSeats, coffeeSpots, wanderSpots, grid };
}
