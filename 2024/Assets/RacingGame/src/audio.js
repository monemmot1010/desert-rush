import * as THREE from 'three';

/* الصوت — DESIGN.md §7
   - المحرك: ملف Kenney الحقيقي (loop) + طبقة مركبة WebAudio
   - الصرير: ملف skid حقيقي حلقي
   - الرياح: ضجيج مُرشَّح يعلو مع السرعة
   - العد والاصطدام: ملفات/توليد
*/

const AUDIO_SRC = {
  engine: ['assets/audio/engine.m4a', 'assets/audio/engine.ogg'],
  motorcycle: ['assets/audio/engine-motorcycle.m4a', 'assets/audio/engine-motorcycle.ogg'],
  skid: ['assets/audio/skid.m4a', 'assets/audio/skid.ogg'],
  impact: ['assets/audio/impact.m4a', 'assets/audio/impact.ogg'],
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buffers = {};
    this.enabled = true;
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);

    // تحميل المخازن بجميع الصيغ
    await Promise.all(Object.entries(AUDIO_SRC).map(async ([key, urls]) => {
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const ab = await res.arrayBuffer();
          this.buffers[key] = await this.ctx.decodeAudioData(ab);
          break;
        } catch (e) { /* جرّب الصيغة التالية */ }
      }
    }));

    this._buildEngineLayer();
    this._buildWind();
    this.ready = true;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _buildEngineLayer() {
    const ctx = this.ctx;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    // طبقة مركبة: تذبذبان بفاصل أوكتاف + ضجيج خفيف
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    this.oscGain1 = ctx.createGain(); this.oscGain1.gain.value = 0.35;
    this.oscGain2 = ctx.createGain(); this.osc2.type === 'square' && (this.oscGain2.gain.value = 0.12);
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 900;
    this.osc1.connect(this.oscGain1).connect(this.engFilter);
    this.osc2.connect(this.oscGain2).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.osc1.start(); this.osc2.start();

    // مصدر الملف الحقيقي
    this.engineSrc = null;
    this.engineFileGain = ctx.createGain(); this.engineFileGain.gain.value = 0;
    this.engineFileGain.connect(this.master);
  }

  _buildWind() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = buf; this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 480; this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.windSrc.start();
  }

  /* حلقة محرك لكل سيارة (الملف الحقيقي + pitch من RPM) */
  attachCar(car, useFile = true) {
    if (!this.ready) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.engine || null;
    if (!src.buffer) return;
    src.loop = true;
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    src.connect(gain).connect(this.master);
    src.start();
    car._engine = { src, gain };
    car._engineFile = useFile;
  }

  detachCar(car) {
    if (car._engine) { try { car._engine.src.stop(); } catch (e) {} car._engine = null; }
  }

  updateCar(car, isPlayer) {
    if (!this.ready || !car._engine) return;
    const p = car.physics;
    const kmh = p.kmh;
    const spd01 = Math.min(1, kmh / 260);
    const throttle = car._lastThrottle ?? 0;

    // pitch من RPM (منطق Kenney: 0.5 → 3.0 + 0.2 عند الدواسة)
    let pitch = 0.55 + spd01 * 2.1 + (throttle > 0.1 ? 0.15 : 0);
    if (p.drifting) pitch += 0.1;
    const gainTarget = isPlayer ? (0.11 + spd01 * 0.16 + (throttle > 0.1 ? 0.06 : 0)) : Math.max(0.0, 0.075 - car.distToCam * 0.0022);
    car._engine.gain.gain.setTargetAtTime(Math.max(0, gainTarget), this.ctx.currentTime, 0.08);
    car._engine.src.playbackRate.setTargetAtTime(pitch, this.ctx.currentTime, 0.06);

    // الطبقة المركبة للاعب فقط
    if (isPlayer) {
      const base = 42 + spd01 * 148;               // هرتز
      this.osc1.frequency.setTargetAtTime(base, this.ctx.currentTime, 0.05);
      this.osc2.frequency.setTargetAtTime(base * 0.5 + 2, this.ctx.currentTime, 0.05);
      const vol = 0.045 + spd01 * 0.075 + (throttle > 0.1 ? 0.035 : 0);
      this.engGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.07);
      this.engFilter.frequency.setTargetAtTime(600 + spd01 * 1900, this.ctx.currentTime, 0.08);
    }
  }

  setSkid(car, intensity) {
    if (!this.ready) return;
    if (intensity <= 0.01) {
      if (car._skidNode) {
        car._skidNode.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      }
      return;
    }
    if (!car._skidNode) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers.skid;
      if (!src.buffer) return;
      src.loop = true;
      const gain = this.ctx.createGain(); gain.gain.value = 0;
      src.connect(gain).connect(this.master);
      src.start();
      car._skidNode = { src, gain };
    }
    car._skidNode.gain.gain.setTargetAtTime(Math.min(0.5, intensity * 0.4), this.ctx.currentTime, 0.06);
    car._skidNode.src.playbackRate.setTargetAtTime(0.9 + Math.min(1.4, car.physics.kmh / 180), this.ctx.currentTime, 0.1);
  }

  setWind(kmh) {
    if (!this.ready) return;
    const s01 = Math.min(1, kmh / 260);
    this.windGain.gain.setTargetAtTime(s01 * s01 * 0.12, this.ctx.currentTime, 0.15);
  }

  countdownBeep(final) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = final ? 1180 : 780;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.5 : 0.16));
    osc.connect(gain).connect(this.master);
    osc.start(t); osc.stop(t + 0.55);
  }

  playImpact(strength) {
    if (!this.ready || !this.buffers.impact) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.impact;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;
    const gain = this.ctx.createGain();
    gain.gain.value = Math.min(0.5, strength * 0.06);
    src.connect(gain).connect(this.master);
    src.start();
  }
}
