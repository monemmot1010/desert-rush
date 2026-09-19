import * as THREE from 'three';

/* =====================================================================
   نموذج القيادة الأركيد — مبني على مبادئ DESIGN.md §4:
   - الإطارات هي مصدر القوى: قوة دفع طولية + مقاومة جانبية (قبضة)
   - زاوية الانزلاق (slip) = الفرق بين اتجاه الحركة واتجاه الهيكل
   - منحنى عزم غير خطي + 5 تراسات → «نبض» تسارع محسوس
===================================================================== */

// منحنى العزم: قيمة 0..1 حسب RPM النسبي (ذروة عند 0.55، قطع عند 1.0)
function torqueCurve(r) {
  if (r < 0) r = 0;
  const rise = r / 0.55;
  const fall = Math.max(0, 1 - Math.max(0, r - 0.55) / 0.45);
  return Math.min(1, rise) * (0.25 + 0.75 * fall);
}

const GEARS = [3.4, 2.35, 1.7, 1.28, 1.0];
const WHEEL_R = 0.34;

export class CarPhysics {
  constructor(opts = {}) {
    // إعدادات شخصية السيارة
    this.maxSpeed = opts.maxSpeed ?? 71;        // م/ث ≈ 256 كم/س
    this.accelPower = opts.accelPower ?? 15.5;  // قوة المحرك الأساسية
    this.brakePower = opts.brakePower ?? 30;
    this.grip = opts.grip ?? 5.2;               // تخامد السرعة الجانبية
    this.driftGrip = opts.driftGrip ?? 1.7;     // قبضة أثناء الدرفت
    this.steerMax = opts.steerMax ?? 0.55;      // راد
    this.handling = opts.handling ?? 1.0;       // مضاعف الاستجابة

    // الحالة
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();       // سرعة عالمية
    this.heading = 0;                           // زاوية التوجيه (rad)
    this.steer = 0;                             // توجيه حالي (-1..1 مُطبَّق)
    this.speed = 0;                             // السرعة الأمامية الموقعة
    this.slip = 0;                              // زاوية الانزلاق (rad، موقعة)
    this.rpm = 0.2;
    this.gear = 1;
    this.drifting = false;
    this.onRoad = true;
    this.terrainFactor = 1;                     // 1 أسفلت، 0.55 عشب/رمل

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  reset(position, heading) {
    this.position.copy(position);
    this.heading = heading;
    this.velocity.set(0, 0, 0);
    this.speed = 0; this.steer = 0; this.slip = 0;
    this.rpm = 0.2; this.gear = 1; this.drifting = false;
  }

  /** input: { throttle:-1..1, steer:-1..1 (يمين موجب), handbrake:bool } */
  update(dt, input, surfaceGrip = 1) {
    this._fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this._right.set(this._fwd.z, 0, -this._fwd.x); // يمين الهيكل

    // ---- التوجيه: استجابة متدرجة + تقلص مع السرعة ----
    const spd01 = Math.min(1, Math.abs(this.speed) / this.maxSpeed);
    const steerLimit = THREE.MathUtils.lerp(this.steerMax, 0.11, spd01);
    const steerTarget = input.steer * steerLimit;
    const steerRate = (3.4 + 3.2 * (1 - spd01)) * this.handling;
    this.steer += THREE.MathUtils.clamp(steerTarget - this.steer, -steerRate * dt, steerRate * dt);

    // ---- سرعة أمامية وجانبية في إطار الهيكل ----
    let vF = this.velocity.dot(this._fwd);
    let vR = this.velocity.dot(this._right);

    // ---- دوران الهيكل (نموذج الدراجة المبسط) ----
    const wheelBase = 2.6;
    const dirSign = vF >= -0.5 ? 1 : -1;
    const yawRate = (vF / wheelBase) * Math.tan(this.steer) * dirSign;
    this.heading += yawRate * dt;

    // انزلاق: عندما لا تواكب السرعة الجانبية القبضة
    this.slip = Math.atan2(vR, Math.max(2.5, Math.abs(vF)));

    // ---- قوى المحرك ----
    this.drifting = input.handbrake && Math.abs(vF) > 6;
    const gripNow = (this.drifting ? this.driftGrip : this.grip) * surfaceGrip;
    this.terrainFactor = surfaceGrip;

    // RPM والترس (المعايرة: أقصى سرعة في الترس الخامس ≈ rpm 1.0)
    const wheelRpm = Math.abs(vF) / (2 * Math.PI * WHEEL_R) * 60;
    const gearRatio = GEARS[this.gear - 1];
    const targetRpm = THREE.MathUtils.clamp((wheelRpm * gearRatio) / 2000, 0.14, 1.05);
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 7);
    if (this.rpm > 0.97 && this.gear < 5) { this.gear++; this.rpm *= 0.72; }
    else if (this.rpm < 0.34 && this.gear > 1) { this.gear--; this.rpm *= 1.25; }

    const throttle = input.throttle;
    let drive = 0;
    if (throttle > 0) {
      drive = this.accelPower * torqueCurve(this.rpm) * throttle * gearRatio / GEARS[4];
    } else if (throttle < 0) {
      // فرملة أمامية أو رجوع خلفي
      drive = vF > 0.8 ? this.brakePower * throttle : this.accelPower * 0.45 * throttle;
    }
    // فرملة اليد: قفل خلفي + خفض القوة
    if (input.handbrake) drive *= 0.55;

    // مقاومات: هواء + تدحرج + خارج المسار
    const drag = 0.00075 * vF * Math.abs(vF) * (this.maxSpeed / 71);
    const roll = 0.05 * vF * (this.onRoad ? 1 : 3.4);
    let aF = drive - drag - roll;

    // ---- تكامل السرعة الطولية ----
    vF += aF * dt;
    if (throttle === 0 && Math.abs(vF) < 0.25) vF = 0;
    const hardLimit = this.maxSpeed * (this.onRoad ? 1 : 0.72);
    vF = THREE.MathUtils.clamp(vF, -14, hardLimit);

    // ---- الإطار المرجعي المحلي (يُقفل مع heading الجديد) ----
    // يلغي دوران الإطار بحيث يمثل (vF,vR) السرعة كما تراها الإطارات
    // ملاحظة: vF هنا بعد تكامل المحرك، وvR قبل القبضة
    const yaw = yawRate * dt;
    const cosY = Math.cos(-yaw), sinY = Math.sin(-yaw);
    const vFloc = cosY * vF - sinY * vR;
    const vRloc = sinY * vF + cosY * vR;

    // ---- القوة الجانبية (القبضة) في الإطار المحلي ----
    const gripAccel = gripNow * 9.81 * (this.onRoad ? 1 : 0.62);
    const dvR = -vRloc;
    const maxDV = gripAccel * dt;
    vR = vRloc + THREE.MathUtils.clamp(dvR, -maxDV, maxDV);
    // أثناء الدرفت يُسمح بزخم جانبي متبقٍ (إحساس الدرفت المضبوط)
    if (this.drifting) vR *= 0.985;
    vF = vFloc; // الإطار المحلي يُقفل السرعة الطولية مع دوران الهيكل

    // ---- إعادة تركيب السرعة العالمية ----
    this._fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this._right.set(this._fwd.z, 0, -this._fwd.x);
    this.velocity.copy(this._fwd).multiplyScalar(vF).addScaledVector(this._right, vR);
    this.velocity.y = 0;

    this.position.addScaledVector(this.velocity, dt);
    this.speed = vF;

    // عزم بصري للهيكل (للاستخدام في car.js)
    this.yawRateVisual = yawRate;
  }

  get kmh() { return Math.abs(this.speed) * 3.6; }
}
