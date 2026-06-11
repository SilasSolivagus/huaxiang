// 3D 小人（Agent）：负责人物建模、行走寻路、坐下/起立、头顶气泡与动画。

import * as THREE from "three";

const WALK_SPEED = 1.7;

// ---------- 头顶名牌 ----------
function makeNameTag(persona) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(15,18,24,0.72)";
  roundRect(ctx, 28, 6, 200, 52, 26);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 28px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(persona.name, 128, 32);
  ctx.fillStyle = "#9fc3ff";
  ctx.font = "18px sans-serif";
  ctx.fillText(persona.role, 128, 53);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(1.5, 0.375, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 对话气泡 ----------
function makeBubbleSprite() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(2.6, 1.3, 1);
  sprite.visible = false;
  sprite.renderOrder = 11;
  return { sprite, canvas, tex };
}

function drawBubble(bubble, text) {
  const ctx = bubble.canvas.getContext("2d");
  ctx.clearRect(0, 0, 512, 256);

  // 按字符折行（适配中文）
  ctx.font = "30px sans-serif";
  const maxW = 400;
  const lines = [];
  let cur = "";
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxW) {
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
    if (lines.length >= 3) break;
  }
  if (cur && lines.length < 3) lines.push(cur);

  const lineH = 40;
  const padX = 26, padY = 20;
  const boxW = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  const x0 = (512 - boxW) / 2;
  const y0 = 200 - boxH;

  ctx.fillStyle = "rgba(255,255,255,0.96)";
  roundRect(ctx, x0, y0, boxW, boxH, 18);
  ctx.fill();
  // 气泡小尾巴
  ctx.beginPath();
  ctx.moveTo(246, 200 - 2);
  ctx.lineTo(266, 200 - 2);
  ctx.lineTo(256, 226);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#1d2530";
  ctx.textAlign = "center";
  lines.forEach((l, i) => {
    ctx.fillText(l, 256, y0 + padY + (i + 0.78) * lineH - 8);
  });
  bubble.tex.needsUpdate = true;
}

// ---------- 人物建模 ----------
function buildBody(persona) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });

  // 腿
  const legs = new THREE.Group();
  const legGeo = new THREE.BoxGeometry(0.13, 0.34, 0.15);
  const legL = new THREE.Mesh(legGeo, mat(0x39414e));
  legL.position.set(-0.09, 0.17, 0);
  const legR = legL.clone();
  legR.position.x = 0.09;
  legL.castShadow = legR.castShadow = true;
  legs.add(legL, legR);
  g.add(legs);

  // 身体（衣服颜色）
  const upper = new THREE.Group();
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.21, 0.46, 12),
    mat(persona.color)
  );
  torso.position.y = 0.57;
  torso.castShadow = true;
  upper.add(torso);

  // 手臂
  const armGeo = new THREE.BoxGeometry(0.09, 0.34, 0.1);
  const armL = new THREE.Mesh(armGeo, mat(persona.color));
  armL.position.set(-0.25, 0.6, 0);
  const armR = armL.clone();
  armR.position.x = 0.25;
  armL.castShadow = armR.castShadow = true;
  upper.add(armL, armR);

  // 头
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.165, 16, 14), mat(persona.skin));
  head.position.y = 0.97;
  head.castShadow = true;
  upper.add(head);

  // 头发（上半球壳）
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.175, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    mat(persona.hair)
  );
  hair.position.y = 0.99;
  upper.add(hair);

  // 眼睛
  const eyeGeo = new THREE.SphereGeometry(0.022, 8, 8);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.06, 0.99, -0.15);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.06;
  upper.add(eyeL, eyeR);

  g.add(upper);
  return { group: g, legs, legL, legR, armL, armR, upper, head };
}

export class Agent {
  constructor(persona, world) {
    this.persona = persona;
    this.world = world; // { scene, grid }
    this.activity = "整理工位";

    const body = buildBody(persona);
    this.body = body;
    this.group = new THREE.Group();
    this.group.add(body.group);

    this.nameTag = makeNameTag(persona);
    this.nameTag.position.y = 1.5;
    this.group.add(this.nameTag);

    this.bubble = makeBubbleSprite();
    this.bubble.sprite.position.y = 2.15;
    this.group.add(this.bubble.sprite);

    world.scene.add(this.group);

    // 行为状态
    this.state = "idle";     // idle | walking | sitting | standing
    this.path = [];
    this.onArrive = null;
    this.targetRotY = 0;
    this.bubbleTimer = 0;
    this.animTime = Math.random() * 10;
    this.pose = "stand";     // stand | sit | type | talk
  }

  setPosition(x, z) {
    this.group.position.set(x, 0, z);
  }

  faceToward(x, z) {
    const dx = x - this.group.position.x;
    const dz = z - this.group.position.z;
    if (Math.abs(dx) + Math.abs(dz) > 1e-4) {
      this.targetRotY = Math.atan2(dx, dz);
    }
  }

  /** 寻路走到目标点 */
  goTo(target, onArrive = null) {
    this.standUp();
    const p = this.group.position;
    this.path = this.world.grid.findPath(p.x, p.z, target.x, target.z);
    if (this.path.length === 0) {
      this.path = [{ x: target.x, z: target.z }];
    }
    this.state = "walking";
    this.pose = "stand";
    this.onArrive = onArrive;
  }

  /** 走到座位旁并坐下 */
  sitAt(seat, pose = "sit") {
    this.goTo(seat, () => {
      this.group.position.set(seat.x, 0, seat.z);
      this.state = "sitting";
      this.pose = pose;
      this.body.legs.visible = false;
      this.body.upper.position.y = -0.26;
      if (seat.lookAt) this.faceToward(seat.lookAt.x, seat.lookAt.z);
    });
  }

  /** 走到站位并面向某处（协作/喝咖啡用） */
  standAt(spot, pose = "talk") {
    this.goTo(spot, () => {
      this.state = "standing";
      this.pose = pose;
      if (spot.lookAt) this.faceToward(spot.lookAt.x, spot.lookAt.z);
    });
  }

  standUp() {
    if (this.state === "sitting") {
      this.body.legs.visible = true;
      this.body.upper.position.y = 0;
    }
    this.state = "idle";
    this.pose = "stand";
  }

  say(text, seconds = 4) {
    drawBubble(this.bubble, text);
    this.bubble.sprite.visible = true;
    this.bubbleTimer = seconds;
  }

  setActivity(label) {
    this.activity = label;
  }

  get isBusy() {
    return this.state === "walking";
  }

  update(dt) {
    this.animTime += dt;

    // 气泡计时
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) this.bubble.sprite.visible = false;
    }

    // 行走
    if (this.state === "walking" && this.path.length > 0) {
      const p = this.group.position;
      const wp = this.path[0];
      const dx = wp.x - p.x, dz = wp.z - p.z;
      const dist = Math.hypot(dx, dz);
      const step = WALK_SPEED * dt;
      if (dist <= step) {
        p.x = wp.x;
        p.z = wp.z;
        this.path.shift();
        if (this.path.length === 0) {
          this.state = "idle";
          const cb = this.onArrive;
          this.onArrive = null;
          if (cb) cb();
        }
      } else {
        p.x += (dx / dist) * step;
        p.z += (dz / dist) * step;
        this.targetRotY = Math.atan2(dx, dz);
      }
    }

    // 平滑转身
    let dr = this.targetRotY - this.group.rotation.y;
    while (dr > Math.PI) dr -= Math.PI * 2;
    while (dr < -Math.PI) dr += Math.PI * 2;
    this.group.rotation.y += dr * Math.min(1, dt * 10);

    // ---------- 姿态动画 ----------
    const t = this.animTime;
    const b = this.body;
    if (this.state === "walking") {
      const s = Math.sin(t * 10);
      b.legL.rotation.x = s * 0.7;
      b.legR.rotation.x = -s * 0.7;
      b.armL.rotation.x = -s * 0.6;
      b.armR.rotation.x = s * 0.6;
      b.group.position.y = Math.abs(Math.sin(t * 10)) * 0.04;
    } else {
      b.legL.rotation.x = 0;
      b.legR.rotation.x = 0;
      b.group.position.y = 0;
      if (this.pose === "type") {
        // 打字：双手前伸微动，头部专注屏幕
        b.armL.rotation.x = -1.1 + Math.sin(t * 13) * 0.08;
        b.armR.rotation.x = -1.1 + Math.cos(t * 15) * 0.08;
        b.head.position.y = 0.97 + Math.sin(t * 1.5) * 0.008;
      } else if (this.pose === "talk") {
        // 交谈：偶尔比划，轻微点头
        b.armL.rotation.x = Math.sin(t * 2.2) * 0.18 - 0.15;
        b.armR.rotation.x = Math.cos(t * 1.8) * 0.22 - 0.2;
        b.head.position.y = 0.97 + Math.sin(t * 3) * 0.012;
      } else if (this.pose === "sit") {
        // 开会聆听：手放桌上
        b.armL.rotation.x = -0.9;
        b.armR.rotation.x = -0.9;
        b.head.position.y = 0.97 + Math.sin(t * 1.2 + 1) * 0.008;
      } else {
        // 站立呼吸
        b.armL.rotation.x = 0;
        b.armR.rotation.x = 0;
        b.head.position.y = 0.97 + Math.sin(t * 1.5) * 0.01;
      }
    }
  }
}
