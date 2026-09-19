import * as THREE from 'three';

/* =====================================================================
   الذكاء الاصطناعي — «الخط المثالي + نقاط الفرملة» (DESIGN.md §4.2)
   كل خصم يتبع raceLine بسرعة هدف من انحناء المسار، مع شخصية مختلفة.
===================================================================== */

const SAMPLES_H = 1000; // يتزامن مع track.js (مؤقتاً مكرر لتجنب استيراد دائري)

export class AIController {
  constructor(car, track, personality = {}) {
    this.car = car;
    this.track = track;
    this.speedMul = personality.speedMul ?? 0.93;   // كفاءة عمومية
    this.aggression = personality.aggression ?? 0.5; // جرأة على الدرفت/التجاوز
    this.wobbleAmp = personality.wobbleAmp ?? 0.5;   // تذبذب بشري
    this.reaction = personality.reaction ?? 1.0;      // سرعة استجابة

    this.avoidLat = 0;
    this.steerSm = 0;
    this.wobblePhase = Math.random() * 10;
    this.stuckTimer = 0;
    this.recoverTimer = 0;
    this._input = { throttle: 0, steer: 0, handbrake: false };
  }

  sampleIdx(idx) { return ((idx % SAMPLES_H) + SAMPLES_H) % SAMPLES_H; }

  /** يعيد { throttle, steer, handbrake } */
  compute(dt, allCars) {
    const car = this.car;
    const p = car.physics;
    const track = this.track;

    if (car.finished) {
      // بعد النهاية: يستمر بالقيادة بهدوء
      this._input.throttle = 0.35;
      this._input.steer = 0;
      this._input.handbrake = false;
      return this._input;
    }

    const idx = this.sampleIdx(car.trackIdx);

    // ---- التعافي من الالتصاق ----
    if (Math.abs(p.speed) < 1.5 && !car.finished) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    if (this.stuckTimer > 2.2) { this.recoverTimer = 1.4; this.stuckTimer = 0; }
    if (this.recoverTimer > 0) {
      this.recoverTimer -= dt;
      this._input.throttle = -1;
      this._input.steer = -Math.sign(p.steer || 1);
      this._input.handbrake = false;
      return this._input;
    }

    // نقطة النظر (pure pursuit) — نظرة أقصر تعني توجيهاً أهدأ
    const ds = track.length / SAMPLES_H;
    const aheadM = 9 + Math.abs(p.speed) * 0.42; // مسافة نظرة بالأمتار
    const aheadIdx = this.sampleIdx(idx + Math.round(aheadM / ds));
    const target = track.raceLine[aheadIdx];

    // إزاحة جانبية: تذبذب بشري + تجنب
    this.wobblePhase += dt * (0.6 + this.wobbleAmp * 0.4);
    let latShift = Math.sin(this.wobblePhase * 1.3) * this.wobbleAmp * 1.1;

    // ---- تجنب السيارات أمامي ----
    const fwd = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
    for (const other of allCars) {
      if (other === car) continue;
      const toOther = other.physics.position.clone().sub(p.position);
      const dist = toOther.length();
      if (dist > 16 || dist < 0.01) continue;
      const along = toOther.dot(fwd);
      if (along < 0.5) continue; // خلفي: تجاهل
      const side = toOther.dot(new THREE.Vector3(fwd.z, 0, -fwd.x));
      if (Math.abs(side) < 2.6) {
        // أمامه في مساري → أنحّي جانبياً
        latShift += (side >= 0 ? -1 : 1) * (14 - dist) * 0.28 * this.aggression;
      }
    }
    this.avoidLat += (latShift - this.avoidLat) * Math.min(1, dt * 3);

    // نقطة هدف مُزاحة جانبياً — مقيّدة دائماً داخل حواف الطريق
    const tan = track.tan[aheadIdx];
    const leftV = new THREE.Vector3(-tan.z, 0, tan.x);
    const latCombined = THREE.MathUtils.clamp(
      track.raceOffsets[aheadIdx] + this.avoidLat,
      -(track.halfWidth - 1.6), (track.halfWidth - 1.6)
    );
    const centerIdx = aheadIdx;
    const centerP = track.pos[centerIdx];
    const aim = centerP.clone().addScaledVector(leftV, latCombined);

    // ---- التوجيه: pursuit + تصحيح الخطأ الجانبي (أسلوب Stanley) ----
    const toAim = aim.clone().sub(p.position); toAim.y = 0;
    const angleErr = Math.atan2(
      toAim.x * fwd.z - toAim.z * fwd.x,   // مركبة جانبية (يمين موجب)
      toAim.dot(fwd)
    );
    // الخطأ الجانبي: موجب = السيارة يسار خط السباق → وجّه يميناً (موجب)
    // قانون Stanley: atan2(k·e, v) — يتقلص مع السرعة تلقائياً فيبقى مستقراً
    const latErr = car.lateral - track.raceOffsets[idx];
    const latSteer = Math.atan2(0.9 * latErr, Math.max(6, Math.abs(p.speed)));
    const steerDesired = angleErr * 1.5 * this.reaction + THREE.MathUtils.clamp(latSteer, -0.3, 0.3);
    // «يد السائق»: مرشح تمرير منخفض يمنع التأرجح السريع لتوجيه pursuit البعيد
    this.steerSm += (steerDesired - this.steerSm) * Math.min(1, dt * 9);
    let steer = THREE.MathUtils.clamp(this.steerSm, -1, 1);

    // ---- السرعة المستهدفة: فرملة استباقية بمسافة فرملة فيزيائية كاملة ----
    // لكل نقطة أمامية: أقصى سرعة مسموحة الآن = sqrt(v_هدف² + 2·a·المسافة)
    const A_DEC_AI = 12.5;
    let vTargetBase = Infinity;
    let distAcc = 0;
    const maxLook = 30 + (p.speed * p.speed) / (2 * A_DEC_AI);
    for (let j = 1; distAcc < maxLook && j < 1200; j++) {
      distAcc += ds;
      const jj = this.sampleIdx(idx + j);
      const vj = track.vProfile[jj];
      const allowed = Math.sqrt(vj * vj + 2 * A_DEC_AI * distAcc);
      if (allowed < vTargetBase) vTargetBase = allowed;
    }
    vTargetBase *= this.speedMul;
    let vTarget = vTargetBase * (1 + Math.sin(this.wobblePhase * 0.7) * 0.015);
    // خارج الطريق: قلّل السرعة كثيراً ليسهل العودة
    if (!p.onRoad) vTarget = Math.min(vTarget, 22);

    let throttle = 0;
    const vAbs = Math.abs(p.speed);
    if (vAbs < vTarget - 1.2) throttle = 1;
    else if (vAbs > vTarget + 1.8) throttle = -1;
    else throttle = 0.35;

    // درفت مقصود أحياناً في المنعطفات الحادة (لمسة شخصية)
    const sharpCorner = Math.abs(track.kappa[aheadIdx]) > 0.014;
    const handbrake = sharpCorner && vAbs > vTargetBase * 1.06 && this.aggression > 0.62 && p.onRoad;

    // إن خرج عن المسار، عُد بقوة (عتبة قريبة للتصحيح المبكر)
    if (Math.abs(car.lateral) > track.halfWidth + 1.2) {
      steer = THREE.MathUtils.clamp(-car.lateral * 0.25, -1, 1);
      throttle = Math.min(throttle, 0.3);
    }

    this._input.throttle = throttle;
    this._input.steer = steer;
    this._input.handbrake = handbrake;
    return this._input;
  }
}
