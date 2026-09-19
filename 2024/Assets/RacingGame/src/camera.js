import * as THREE from 'three';

/* الكاميرا: مطاردة ناعمة + FOV ديناميكي + اهتزاز (DESIGN.md §6) */

const MODES = [
  { name: 'مطاردة', dist: 6.4, height: 2.5, lookAhead: 5.5, fovNear: 62, fovFar: 78 },
  { name: 'بعيدة', dist: 9.5, height: 3.6, lookAhead: 7.5, fovNear: 55, fovFar: 68 },
  { name: 'غطسة', dist: 4.6, height: 1.55, lookAhead: 4.5, fovNear: 66, fovFar: 82 },
];

export class ChaseCamera {
  constructor(camera) {
    this.cam = camera;
    this.mode = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.shake = 0;
    this._started = false;
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  toggleMode() {
    this.mode = (this.mode + 1) % MODES.length;
    this._started = false;
    return MODES[this.mode].name;
  }

  addShake(v) { this.shake = Math.min(1.4, this.shake + v); }

  update(dt, car) {
    const p = car.physics;
    const M = MODES[this.mode];

    const spd01 = Math.min(1, p.kmh / 260);
    const dist = M.dist + spd01 * 1.6;
    const height = M.height + spd01 * 0.5;

    // اتجاه الحركة (أثبت من heading البحت أثناء الانزلاق)
    this._dir.set(Math.sin(p.heading), 0, Math.cos(p.heading));

    // الموضع المثالي خلف السيارة
    this._tmp.copy(p.position).addScaledVector(this._dir, -dist);
    this._tmp.y = p.position.y + height;

    const k = this._started ? Math.min(1, dt * (5.2 - spd01 * 2.2)) : 1;
    this.pos.lerp(this._tmp, k);
    if (!this._started) { this.pos.copy(this._tmp); this._started = true; }

    // النظرة أمام السيارة
    this._tmp.copy(p.position).addScaledVector(this._dir, M.lookAhead);
    this._tmp.y = p.position.y + 0.9;
    this.look.lerp(this._tmp, Math.min(1, dt * 7));

    // الاهتزاز: من السرعة + من الأحداث
    this.shake *= Math.pow(0.002, dt);
    const speedShake = spd01 * spd01 * 0.05;
    const total = this.shake + speedShake;
    const t = performance.now() / 1000;
    const ox = (Math.sin(t * 47.3) * 0.14 + Math.sin(t * 13.1) * 0.08) * total;
    const oy = (Math.sin(t * 41.7) * 0.10 + Math.sin(t * 17.3) * 0.06) * total;

    this.cam.position.set(this.pos.x + ox, this.pos.y + oy, this.pos.z);
    this.cam.lookAt(this.look);

    // FOV ديناميكي مع السرعة
    const fov = THREE.MathUtils.lerp(M.fovNear, M.fovFar, spd01);
    if (Math.abs(this.cam.fov - fov) > 0.01) {
      this.cam.fov = fov;
      this.cam.updateProjectionMatrix();
    }
  }

  snapBehind(car) {
    const p = car.physics;
    const M = MODES[this.mode];
    this._dir.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    this.pos.copy(p.position).addScaledVector(this._dir, -M.dist);
    this.pos.y = p.position.y + M.height;
    this.look.copy(p.position).addScaledVector(this._dir, M.lookAhead);
    this.look.y = p.position.y + 0.9;
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    this._started = true;
  }
}
