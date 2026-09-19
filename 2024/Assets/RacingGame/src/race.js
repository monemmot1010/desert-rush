/* =====================================================================
   مدير السباق — الحالات، اللفات، الترتيب، النتائج
===================================================================== */

export const GameState = { LOADING: 0, TITLE: 1, GARAGE: 2, COUNTDOWN: 3, RACING: 4, FINISHED: 5 };

const SAMPLES_RACE = 1000; // يتزامن مع track.js

export class RaceManager {
  constructor(totalLaps = 3) {
    this.totalLaps = totalLaps;
    this.state = GameState.LOADING;
    this.time = 0;            // زمن السباق الكلي
    this.countdownT = 0;
    this.cars = [];
    this.player = null;
    this.onCountdown = null;  // (num, final)
    this.onLapComplete = null;
    this.onFinish = null;
    this.finishOrder = [];
    this.freezeInput = true;
  }

  setup(cars, player, trackLength) {
    this.cars = cars;
    this.player = player;
    this.trackLength = trackLength;
    this.time = 0;
    this.finishOrder = [];
    for (const c of cars) {
      c.lap = 0;
      c.progress = 0;
      c.finished = false;
      c.finishTime = 0;
      c.lapStart = 0;
      c.bestLap = Infinity;
      c.lastLap = 0;
      c.position = c.isPlayer ? 4 : 1;
      c.halfLaps = 0;
    }
  }

  startCountdown() {
    this.state = GameState.COUNTDOWN;
    this.countdownT = 0;
    this.freezeInput = true;
  }

  /* يُستدعى كل إطار فيزياء (بعد تحديث السيارات) */
  update(dt) {
    if (this.state === GameState.COUNTDOWN) {
      const prevT = this.countdownT;
      this.countdownT += dt;
      const remain = 3.999 - this.countdownT;
      const step = (t) => this.onCountdown && this.onCountdown(t);
      const cross = (mark) => prevT < mark && this.countdownT >= mark;
      if (cross(0.05)) step(3);
      if (cross(1)) step(2);
      if (cross(2)) step(1);
      if (cross(2.999)) { step(0); this._go(); }
    }

    if (this.state === GameState.RACING || this.state === GameState.FINISHED) {
      this.time += dt;
      this._updateProgress();
    }
  }

  _go() {
    this.state = GameState.RACING;
    this.freezeInput = false;
  }

  _updateProgress() {
    const L = this.trackLength;
    for (const c of this.cars) {
      if (c.finished) continue;
      // تقدّم مستمر بالمسافة المقطوعة على المحيط
      // عند العبور من النهاية (~999) إلى البداية (~0): أضف اللفة كاملة
      let dIdx = c.trackIdx - (c._prevIdx ?? c.trackIdx);
      if (dIdx < -SAMPLES_RACE / 2) {
        // قفزة أمامية عبر خط النهاية
        c.progress += (SAMPLES_RACE + dIdx) * (L / SAMPLES_RACE);
        if (this.state !== GameState.LOADING) this._crossFinish(c);
      } else if (dIdx > SAMPLES_RACE / 2) {
        // قفزة خلفية عبر خط النهاية (رجوع) — اطرح
        c.progress += (dIdx - SAMPLES_RACE) * (L / SAMPLES_RACE);
      } else {
        c.progress += dIdx * (L / SAMPLES_RACE);
      }
      c._prevIdx = c.trackIdx;
    }
    // الترتيب
    const sorted = [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    sorted.forEach((c, i) => { c.position = i + 1; });
  }

  _crossFinish(c) {
    // أول عبور لكل سيارة بعد الانطلاق (من خانات الانطلاق خلف الخط) يبدأ اللفة الأولى وتوقيتها
    if (!c._crossedStart) {
      c._crossedStart = true;
      c.lap = 1;
      c.lapStart = this.time;
      return;
    }
    c.lap++;
    if (c.lap === 1) {
      // أمان إضافي: لا يُحتسب عبور مزدوج بسرعة
      c.lapStart = this.time;
      return;
    }
    const lapTime = this.time - c.lapStart;
    c.lastLap = lapTime;
    c.bestLap = Math.min(c.bestLap, lapTime);
    c.lapStart = this.time;
    if (c.lap > this.totalLaps) {
      c.finished = true;
      c.finishTime = this.time;
      this.finishOrder.push(c);
      if (this.onFinish && c.isPlayer) this.onFinish(c);
    } else if (this.onLapComplete && c.isPlayer) {
      this.onLapComplete(c.lap, lapTime);
    }
  }

  get raceOver() {
    return this.player.finished;
  }
}
