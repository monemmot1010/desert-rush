import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CarPhysics } from './carPhysics.js?cb=12';

/* =====================================================================
   السيارة: نموذج GLB حقيقي (فيراري 458 — DRACO) + فيزياء + مؤثرات
===================================================================== */

const draco = new DRACOLoader();
draco.setDecoderPath('lib/three/libs/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

function loadGLB(url) {
  return new Promise((resolve, reject) => loader.load(url, g => resolve(g), undefined, reject));
}

// نسيج دائرة ناعمة للدخان
function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,.32)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Car {
  /**
   * @param url ملف GLB
   * @param tint لون تعديل خفيف للجسم
   * @param physOpts خصائص فيزيائية
   */
  constructor(url, name, isPlayer, physOpts = {}, tint = null) {
    this.name = name;
    this.isPlayer = isPlayer;
    this.tint = tint;
    this.physics = new CarPhysics(physOpts);
    this.group = new THREE.Group();      // الجذر في العالم
    this.container = new THREE.Group();  // النموذج (يدور مع heading)
    this.group.add(this.container);
    this.ready = false;

    // مؤثرات
    this.smokeTexture = makeSmokeTexture();
    this.smokePool = [];
    this.skidLeft = null; this.skidRight = null;
    this._lastSkidL = new THREE.Vector3(); this._lastSkidR = new THREE.Vector3();
    this._hasSkidL = false; this._hasSkidR = false;

    // حالة سباق (تديرها race.js)
    this.lap = 0;
    this.progress = 0;         // لفة * طول + مؤشر
    this.trackIdx = 0;
    this.lateral = 0;
    this.finished = false;
    this.finishTime = 0;
    this.lapStart = 0;
    this.bestLap = Infinity;
    this.lastLap = 0;
    this.position = 4;
    this.wrongWay = false;

    this._load(url);
  }

  async _load(url) {
    const gltf = await loadGLB(url);
    const model = gltf.scene;

    // تطبيع الحجم: طول مستهدف 4.2م
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = 4.2 / Math.max(size.z, size.x, 0.001);
    model.scale.setScalar(scale);

    // اكتشاف اتجاه المقدمة من فرق مواقع العجلات الأمامية/الخلفية (فيراري wheel_fl..rr)
    let frontZ = 0, rearZ = 0;
    model.traverse(o => {
      if (o.name === 'wheel_fl' || o.name === 'wheel_fr') frontZ += o.position.z;
      if (o.name === 'wheel_rl' || o.name === 'wheel_rr') rearZ += o.position.z;
    });
    if (!frontZ && !rearZ) {
      // احتياط: تسمية Kenney
      model.traverse(o => {
        if (o.name === 'wheel-front-left' || o.name === 'wheel-front-right') frontZ += o.position.z;
        if (o.name === 'wheel-back-left' || o.name === 'wheel-back-right') rearZ += o.position.z;
      });
    }
    if (frontZ < rearZ) model.rotation.y = Math.PI; // المقدمة نحو +Z

    // جمع العجلات والجسم + رفع جودة المواد
    this.wheels = {};
    this.body = null;
    model.updateMatrixWorld(true);
    const wheelNames = { wheel_fl: 'fl', wheel_fr: 'fr', wheel_rl: 'bl', wheel_rr: 'br', 'wheel-front-left': 'fl', 'wheel-front-right': 'fr', 'wheel-back-left': 'bl', 'wheel-back-right': 'br' };
    model.traverse(o => {
      o.castShadow = true; o.receiveShadow = false;
      if (wheelNames[o.name]) this.wheels[wheelNames[o.name]] = o;
      else if (o.name === 'body') this.body = o;
      if (o.isMesh) {
        o.material = this._upgradeMaterial(o.material.clone());
        o.material.shadowSide = THREE.FrontSide;
      }
    });
    this.model = model;
    this.container.add(model);

    // علامات انزلاق (شريطا حلقة لكل جانب)
    this._initSkids();
    this.ready = true;
  }

  /** رفع جودة مواد GLB إلى PBR حقيقي + صباغة الجسم بلون السيارة */
  _upgradeMaterial(m) {
    const name = (m.name || '').toLowerCase();
    if (name.includes('body_color') || name === 'body') {
      // صاج: Physical + clearcoat ⇒ انعكاس السماء الفعلي على الصاج
      return new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(this.tint ?? '#c2231d'), metalness: 0.9, roughness: 0.32,
        clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.5,
      });
    }
    if (name.includes('tire')) {
      m.metalness = 0.0; m.roughness = 0.95; m.color = new THREE.Color(0x121212);
    } else if (name.includes('glass')) {
      m.metalness = 1.0; m.roughness = 0.06; m.envMapIntensity = 2.2;
    } else if (name.includes('chrome') || name.includes('metal')) {
      m.metalness = 1.0; m.roughness = 0.18; m.envMapIntensity = 1.6;
    } else if (name.includes('light') && !name.includes('interior')) {
      m.emissive = new THREE.Color(0xfff2cf); m.emissiveIntensity = 0.35; m.roughness = 0.2;
    } else {
      m.envMapIntensity = 1.1;
    }
    return m;
  }

  _initSkids() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x151210, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide,
    });
    const makeStrip = () => {
      const MAXQ = 240; // عدد المقاطع في حلقة
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(MAXQ * 6 * 3); // كل مقطع = رباعي (6 رؤوس)
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      return { mesh, pos, write: 0, max: MAXQ, hasPrev: false, prev: new THREE.Vector3() };
    };
    this.skidLeft = makeStrip();
    this.skidRight = makeStrip();
    this._attached = false;
  }

  _ensureAttached() {
    if (!this._attached && this.group.parent) {
      this.group.parent.add(this.skidLeft.mesh, this.skidRight.mesh);
      this._attached = true;
    }
  }

  _pushSkid(strip, center) {
    if (!strip.hasPrev) { strip.prev.copy(center); strip.hasPrev = true; return; }
    const a = strip.prev, b = center;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.09) return;            // قريب جداً: لا شيء
    if (len > 3.5) { strip.prev.copy(b); return; } // قفزة (تيليبورت/لفة جديدة)
    const nx = (-dz / len) * 0.09, nz = (dx / len) * 0.09;
    const y = 0.05;
    const i = strip.write * 18;
    const tri = [
      a.x + nx, y, a.z + nz, b.x + nx, y, b.z + nz, a.x - nx, y, a.z - nz,
      a.x - nx, y, a.z - nz, b.x + nx, y, b.z + nz, b.x - nx, y, b.z - nz,
    ];
    strip.pos.set(tri, i);
    strip.write = (strip.write + 1) % strip.max;
    strip.prev.copy(b);
    strip.mesh.geometry.attributes.position.needsUpdate = true;
  }

  _endSkid(strip) { strip.hasPrev = false; }

  /* ---------- جزيئات الدخان ---------- */
  _spawnSmoke(pos, dusty) {
    let s = this.smokePool.find(o => !o.alive);
    if (!s) {
      if (this.smokePool.length >= 46) return;
      const mat = new THREE.SpriteMaterial({
        map: this.smokeTexture, transparent: true, depthWrite: false, rotation: Math.random() * 6.28,
      });
      s = { sprite: new THREE.Sprite(mat), alive: false, t: 0, life: 1, grow: 1 };
      this.smokePool.push(s);
      this.group.parent?.add(s.sprite);
    }
    s.alive = true; s.t = 0;
    s.life = 0.7 + Math.random() * 0.5;
    s.grow = 1.6 + Math.random() * 1.4;
    s.sprite.position.copy(pos);
    s.sprite.material.color.set(dusty ? 0xc9a878 : 0xffffff);
    s.sprite.material.rotation = Math.random() * 6.28;
    s.sprite.material.opacity = dusty ? 0.5 : 0.62;
  }

  _updateSmoke(dt) {
    for (const s of this.smokePool) {
      if (!s.alive) continue;
      s.t += dt;
      const k = s.t / s.life;
      if (k >= 1) { s.alive = false; s.sprite.visible = false; continue; }
      s.sprite.visible = true;
      const sc = 0.6 + k * s.grow;
      s.sprite.scale.set(sc, sc, 1);
      s.sprite.position.y += dt * 1.1;
      s.sprite.material.opacity = (1 - k) * 0.55;
    }
  }

  /* ---------- التحديث الكلي ---------- */
  update(dt, input, track, cameraPos) {
    if (!this.ready) return;
    const p = this.physics;

    // موقع أقرب نقطة على المسار (قبل الفيزياء لتحديد السطح)
    const near = track.nearest(p.position, this.trackIdx);
    this.trackIdx = near.idx;
    this.lateral = near.lateral;
    p.onRoad = track.isOnRoad(near.lateral);

    // فيزياء (مع معامل سطح: أسفلت أو رمل)
    p.update(dt, input, p.onRoad ? 1 : 0.55);

    // ارتفاع الأرض: سطح الطريق، أو التضاريس الحقيقية (خارج نطاق التسطيح)
    const roadY = track.pos[near.idx].y;
    const apron = 22;
    const absLat = Math.abs(near.lateral);
    let groundY;
    if (absLat <= track.halfWidth) groundY = roadY;
    else if (absLat <= track.halfWidth + apron) {
      const t = (absLat - track.halfWidth) / apron;
      const terrY = track.terrainHeight
        ? track.terrainHeight(p.position.x, p.position.z)
        : 0;
      groundY = roadY * (1 - t) * (1 - t) + terrY * (1 - (1 - t) * (1 - t));
    } else {
      groundY = track.terrainHeight ? track.terrainHeight(p.position.x, p.position.z) : 0;
    }

    // تنعيم الارتفاع
    p.position.y += (groundY - p.position.y) * Math.min(1, dt * 10);
    p.groundY = groundY;

    // تطبيق على الجذر
    this.group.position.copy(p.position);

    // دوران الهيكل: الاتجاه + انحراف بصري حسب الانزلاق
    this.container.rotation.y = p.heading;
    const slipVis = THREE.MathUtils.clamp(-p.slip * 0.55, -0.5, 0.5);
    this.container.rotation.y += slipVis * (this.isPlayer ? 1 : 0.8);

    // ميلان الجسم (pitch من التسارع، roll من التوجيه)
    if (this.body) {
      const accel = p.speed - (this._prevSpeed ?? 0);
      this._prevSpeed = p.speed;
      const pitch = THREE.MathUtils.lerp(this.body.rotation.x, THREE.MathUtils.clamp(-accel * 0.05, -0.09, 0.09), Math.min(1, dt * 6));
      const roll = THREE.MathUtils.lerp(this.body.rotation.z, THREE.MathUtils.clamp(p.steer * p.speed * 0.006, -0.1, 0.1), Math.min(1, dt * 5));
      this.body.rotation.x = pitch;
      this.body.rotation.z = roll;
    }

    // العجلات: دوران + توجيه أمامي
    const wheelSpin = (p.speed / 0.34) * dt;
    for (const key of ['fl', 'fr', 'bl', 'br']) {
      const w = this.wheels[key];
      if (!w) continue;
      w.rotation.x += wheelSpin;
    }
    const steerVis = p.steer * 1.1;
    if (this.wheels.fl) this.wheels.fl.rotation.y = steerVis;
    if (this.wheels.fr) this.wheels.fr.rotation.y = steerVis;

    // ---------- المؤثرات ----------
    const slipMag = Math.abs(p.slip);
    const slipping = (slipMag > 0.22 || (p.drifting && p.kmh > 25)) && p.kmh > 30;
    const rearL = this.group.position.clone()
      .addScaledVector(new THREE.Vector3(Math.sin(p.heading + Math.PI / 2), 0, Math.cos(p.heading + Math.PI / 2)), 0.85)
      .addScaledVector(new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading)), -1.5);
    const rearR = rearL.clone().addScaledVector(new THREE.Vector3(Math.sin(p.heading + Math.PI / 2), 0, Math.cos(p.heading + Math.PI / 2)), -1.7);

    if (slipping && Math.random() < 0.75) {
      this._spawnSmoke(rearL.clone().add(new THREE.Vector3(0, 0.25, 0)), !p.onRoad);
      if (Math.random() < 0.8) this._spawnSmoke(rearR.clone().add(new THREE.Vector3(0, 0.25, 0)), !p.onRoad);
    }
    this._updateSmoke(dt);

    // علامات الانزلاق على الأسفلت فقط
    if (slipping && p.onRoad) {
      this._ensureAttached();
      this._pushSkid(this.skidLeft, rearL);
      this._pushSkid(this.skidRight, rearR);
    } else { this._endSkid(this.skidLeft); this._endSkid(this.skidRight); }
  }
}
