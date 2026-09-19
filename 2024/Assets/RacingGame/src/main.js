import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Track } from './track.js?cb=12';
import { Car } from './car.js?cb=12';
import { AIController } from './ai.js?cb=12';
import { ChaseCamera } from './camera.js?cb=12';
import { AudioEngine } from './audio.js?cb=12';
import { HUD, formatTime } from './hud.js?cb=12';
import { RaceManager, GameState } from './race.js?cb=12';

/* =====================================================================
   سرعة الصحراء — الملف الجامع
===================================================================== */

const $ = (id) => document.getElementById(id);
const app = $('app');

/* ---------- العرض ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xe3c79c, 320, 1000);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(0, 5, -186);

/* ---------- سماء HDR 4K حقيقية (Poly Haven — CC0) ---------- */
new RGBELoader().load('assets/sky/desert_4k.hdr', (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = tex;
  scene.background = tex;
  scene.environmentIntensity = 0.85;
  assetLoaded('تم تحميل السماء 4K');
});

/* ---------- الإضاءة + ظلال متتبعة ---------- */
const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
sun.position.set(120, 150, -80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.near = 10; sc.far = 420;
sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x8a6b4a, 0.5));

/* ---------- البوست-بروسيس: MSAA + Bloom + تدرج سينمائي ---------- */
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  type: THREE.HalfFloatType, samples: 4,
});
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 0.82);
composer.addPass(bloom);

// تدرج سينمائي مخصص: vignette + aberration + grain + درجة لون صحراوية
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },   // 0..1 مع السرعة
    uDrift: { value: 0 },   // 0..1 مع الانزلاق
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uSpeed; uniform float uDrift;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      // انحراف لوني يتنفس مع السرعة والانزلاق
      float ab = (0.0012 + uSpeed * 0.0026 + uDrift * 0.002) * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;
      // درجة صحراوية: رفع لطيف للدفء في الظلال والتشبع
      col = mix(col, col * vec3(1.045, 1.0, 0.945), 0.5);
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 1.12);
      col = clamp((col - 0.5) * 1.06 + 0.5 + 0.012, 0.0, 1.0);
      // vignette
      col *= 1.0 - smoothstep(0.32, 0.85, r2 * 2.0) * 0.38;
      // film grain
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 61.7) - 0.5;
      col += g * (0.028 + uSpeed * 0.02);
      gl_FragColor = vec4(col, 1.0);
    }`,
};
const gradePass = new ShaderPass(GradeShader);
composer.addPass(gradePass);
composer.addPass(new OutputPass());

/* ---------- الحلبة ---------- */
const track = new Track();
scene.add(track.group);

/* ---------- السيارات (فيراري 458 GLB حقيقية بصبغات مختلفة) ---------- */
const CAR_DEFS = [
  {
    url: 'assets/cars/ferrari.glb', name: 'صقر', color: '#d8342a',
    ai: { speedMul: 0.965, aggression: 0.7, wobbleAmp: 0.45, reaction: 1.05 },
    phys: { maxSpeed: 68, accelPower: 15.2, grip: 5.3, driftGrip: 1.7 },
  },
  {
    url: 'assets/cars/ferrari.glb', name: 'عاصفة', color: '#2f8f4e',
    ai: { speedMul: 0.955, aggression: 0.45, wobbleAmp: 0.7, reaction: 0.95 },
    phys: { maxSpeed: 70, accelPower: 14.6, grip: 5.0, driftGrip: 1.6 },
  },
  {
    url: 'assets/cars/ferrari.glb', name: 'رعد', color: '#6a3fb8',
    ai: { speedMul: 0.945, aggression: 0.6, wobbleAmp: 0.55, reaction: 1.0 },
    phys: { maxSpeed: 72, accelPower: 15.8, grip: 4.7, driftGrip: 1.55 },
  },
  {
    url: 'assets/cars/ferrari.glb', name: 'أنت', color: '#e88f1a',
    ai: null,
    phys: { maxSpeed: 71, accelPower: 15.5, grip: 5.2, driftGrip: 1.7 },
  },
];

let selectedCar = 3;
const cars = CAR_DEFS.map((d, i) => {
  const car = new Car(d.url, d.name, false, d.phys, d.color);
  const s = track.gridSlot(i);
  car.physics.reset(s.position, s.heading);
  car.trackIdx = track.nearest(s.position, 0).idx;
  car.group.position.copy(s.position);
  car.color = d.color;
  return car;
});
let player = cars[3];

/* ---------- الأنظمة ---------- */
let ais = cars.map(() => null);
const chase = new ChaseCamera(camera);
const audio = new AudioEngine();
const hud = new HUD(track);
const race = new RaceManager(3);

/* ---------- شاشة التحميل ---------- */
let loadedCount = 0;
const totalAssets = cars.length + 1;
function assetLoaded(label) {
  loadedCount++;
  $('load-fill').style.width = `${(loadedCount / totalAssets) * 100}%`;
  if (label) $('load-tip').textContent = label;
  if (loadedCount >= totalAssets) setTimeout(showTitle, 400);
}
cars.forEach((c, i) => {
  const w = setInterval(() => {
    if (c.ready) { clearInterval(w); assetLoaded(`تم تحميل سيارة ${CAR_DEFS[i].name}`); }
  }, 120);
});

function showTitle() {
  race.state = GameState.TITLE;
  showScreen('title');
}

/* ---------- الإدخال ---------- */
const keys = {};
addEventListener('keydown', (e) => {
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  keys[e.code] = true;
  if (e.code === 'KeyV') {
    const m = chase.toggleMode();
    if (race.state >= GameState.COUNTDOWN) hud.toast('كاميرا: ' + m);
  }
  if (e.code === 'KeyR' && race.state >= GameState.COUNTDOWN) restartRace();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

function readPlayerInput() {
  if (race.freezeInput && race.state !== GameState.FINISHED) {
    return { throttle: 0, steer: 0, handbrake: false };
  }
  if (race.state === GameState.FINISHED) {
    // قيادة تلقائية هادئة بعد خط النهاية
    const idx = (player.trackIdx + 34) % 1000;
    const aim = track.raceLine[idx];
    const p = player.physics;
    const toX = aim.x - p.position.x, toZ = aim.z - p.position.z;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const cross = toX * fz - toZ * fx;
    const dot = toX * fx + toZ * fz;
    return { throttle: 0.32, steer: Math.atan2(cross, dot) * 1.4, handbrake: false };
  }
  return {
    throttle: (keys['ArrowUp'] ? 1 : 0) - (keys['ArrowDown'] ? 1 : 0),
    steer: (keys['ArrowRight'] ? 1 : 0) - (keys['ArrowLeft'] ? 1 : 0),
    handbrake: !!keys['Space'],
  };
}

/* ---------- تدفق الشاشات ---------- */
const screens = {
  loading: $('screen-loading'),
  title: $('screen-title'),
  garage: $('screen-garage'),
  results: $('screen-results'),
};
function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
}

function buildGarage() {
  const row = $('car-row');
  row.innerHTML = '';
  CAR_DEFS.forEach((d, i) => {
    const pct = (v, lo, hi) => Math.round(Math.min(1, Math.max(0.15, (v - lo) / (hi - lo))) * 100);
    const card = document.createElement('div');
    card.className = 'car-card' + (i === selectedCar ? ' selected' : '');
    card.innerHTML = `
      <div class="car-swatch" style="background:${d.color}"></div>
      <div class="car-name">${d.name === 'أنت' ? 'سيارتك' : d.name}</div>
      <div class="car-stats">
        <div class="stat-row"><span class="stat-label">السرعة</span><div class="stat-bar"><div class="stat-fill" style="width:${pct(d.phys.maxSpeed, 64, 73)}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">التسارع</span><div class="stat-bar"><div class="stat-fill" style="width:${pct(d.phys.accelPower, 13.5, 16.5)}%"></div></div></div>
        <div class="stat-row"><span class="stat-label">التماسك</span><div class="stat-bar"><div class="stat-fill" style="width:${pct(d.phys.grip, 4.4, 5.6)}%"></div></div></div>
      </div>`;
    card.addEventListener('click', () => { selectedCar = i; buildGarage(); });
    row.appendChild(card);
  });
}

/* ---------- إدارة السباق ---------- */
function clearSkids() {
  for (const c of cars) {
    for (const s of [c.skidLeft, c.skidRight]) {
      if (s) { s.pos.fill(0); s.mesh.geometry.attributes.position.needsUpdate = true; s.write = 0; s.hasPrev = false; }
    }
  }
}

function showCountdown(n) {
  const el = $('cd-num');
  el.textContent = n > 0 ? String(n) : 'انطلق!';
  el.style.color = n === 0 ? '#8dff9a' : '#fff';
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function startRace() {
  showScreen(null);
  hud.show();
  const playerIdx = selectedCar;
  player = cars[playerIdx];
  cars.forEach((c, i) => { c.isPlayer = i === playerIdx; });
  ais = cars.map((c, i) =>
    (i === playerIdx || !CAR_DEFS[i].ai) ? null : new AIController(c, track, CAR_DEFS[i].ai)
  );

  // خط الانطلاق: اللاعب في الخانة الأخيرة
  let slot = 0;
  for (const c of cars) {
    if (c.isPlayer) continue;
    const s = track.gridSlot(slot++);
    c.physics.reset(s.position, s.heading);
    c.trackIdx = track.nearest(s.position, c.trackIdx).idx;
    c.group.position.copy(s.position);
  }
  const ps = track.gridSlot(slot);
  player.physics.reset(ps.position, ps.heading);
  player.trackIdx = track.nearest(ps.position, player.trackIdx).idx;
  player.group.position.copy(ps.position);
  chase.snapBehind(player);
  clearSkids();

  race.setup(cars, player, track.length);
  race.onCountdown = (n) => { showCountdown(n); audio.countdownBeep(n === 0); };
  race.onLapComplete = (lap, t) => {
    if (t <= player.bestLap + 1) hud.toast('🔥 أفضل لفة! ' + formatTime(t * 1000));
    else hud.toast(`اكتملت اللفة ${lap - 1} من ${race.totalLaps}`);
  };
  race.onFinish = () => {
    hud.toast('🏁 خط النهاية!');
    setTimeout(showResults, 2000);
  };
  race.startCountdown();

  audio.init().then(() => { for (const c of cars) audio.attachCar(c); });
  audio.resume();
}

function restartRace() { startRace(); }

function showResults() {
  const rows = [...cars].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    const pa = a.lap * track.length + a.trackIdx * (track.length / 1000);
    const pb = b.lap * track.length + b.trackIdx * (track.length / 1000);
    return pb - pa;
  });
  const list = $('results-list');
  list.innerHTML = '';
  rows.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'result-row' + (c.isPlayer ? ' me' : '');
    const time = c.finished ? formatTime(c.finishTime * 1000) : 'لم يُنهِ';
    row.innerHTML = `<span class="r-rank">${i + 1}</span><span>${c.name}</span><span class="r-time">${time}</span>`;
    list.appendChild(row);
  });
  const titles = { 1: '🏆 المركز الأول!', 2: '🥈 المركز الثاني!', 3: '🥉 المركز الثالث!' };
  $('results-title').textContent = titles[player.position] || 'النتائج النهائية';
  $('results-sub').textContent =
    `أفضل لفة: ${isFinite(player.bestLap) ? formatTime(player.bestLap * 1000) : '—'}` +
    (player.finished ? ` • الزمن الإجمالي: ${formatTime(player.finishTime * 1000)}` : '');
  showScreen('results');
}

$('btn-start').addEventListener('click', () => {
  audio.init();
  audio.resume();
  race.state = GameState.GARAGE;
  buildGarage();
  showScreen('garage');
});
$('btn-race').addEventListener('click', () => startRace());
$('btn-again').addEventListener('click', () => startRace());
$('btn-garage').addEventListener('click', () => {
  race.state = GameState.GARAGE;
  showScreen('garage');
});

/* ---------- كاميرا العنوان المدارية ---------- */
function orbitCamera(t) {
  const c = track.pos[0];
  const a = t * 0.1;
  camera.position.set(c.x + Math.cos(a) * 48, 15 + Math.sin(t * 0.23) * 3, c.z + Math.sin(a) * 48);
  camera.lookAt(c.x, 2, c.z);
  if (Math.abs(camera.fov - 55) > 0.01) { camera.fov = 55; camera.updateProjectionMatrix(); }
}

/* ---------- السير بالمقلوب ---------- */
let wrongWayT = 0, wrongWayLast = -10;
const _tanV = new THREE.Vector3();
function checkWrongWay(dt) {
  if (race.state !== GameState.RACING) { wrongWayT = 0; return; }
  _tanV.copy(track.tan[player.trackIdx]);
  const dot = player.physics.velocity.dot(_tanV);
  if (dot < -2.5 && player.physics.kmh > 12) wrongWayT += dt; else wrongWayT = 0;
  if (wrongWayT > 1.4 && race.time - wrongWayLast > 6) {
    hud.toast('⚠️ السير بالاتجاه المعاكس!');
    wrongWayLast = race.time;
  }
}

/* ---------- الحلقة الرئيسية (فيزياء ثابتة 120Hz) ---------- */
const FIXED = 1 / 120;
let acc = 0, prevT = performance.now();

function stepSim(dt, pInput) {
  // أثناء العد التنازلي: الجميع مجمّد (وليس اللاعب فقط) حتى لا تنطلق AI مبكراً
  const frozen = race.freezeInput && race.state !== GameState.FINISHED;
  const zero = { throttle: 0, steer: 0, handbrake: false };
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    let input;
    if (frozen) input = zero;
    else if (car.isPlayer) input = pInput;
    else input = ais[i] ? ais[i].compute(dt, cars) : zero;
    car.update(dt, input, track);
    car._lastThrottle = input.throttle;
  }
  race.update(dt); // بعد تحديث السيارات ليكون كشف العبور دقيقاً
  // صندوق الظل يتبع اللاعب (≈ 3.4سم/تكسل بدل 13سم)
  const pp = player.physics.position;
  sun.target.position.set(pp.x, 0, pp.z);
  sun.position.set(pp.x + 120, 150, pp.z - 80);
  // ارتطام مغادرة الطريق
  if (player.physics.onRoad) player._offroadPlayed = false;
  else if (!player._offroadPlayed && player.physics.kmh > 45) {
    player._offroadPlayed = true;
    audio.playImpact(0.6);
    chase.addShake(0.35);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const frameDt = Math.min(0.05, (now - prevT) / 1000);
  prevT = now;

  const pInput = readPlayerInput();

  acc += frameDt;
  while (acc >= FIXED) {
    stepSim(FIXED, pInput);
    acc -= FIXED;
  }

  if (race.state === GameState.TITLE || race.state === GameState.GARAGE || race.state === GameState.LOADING) {
    orbitCamera(now / 1000);
  } else {
    chase.update(frameDt, player);
  }

  // الصوت
  for (const c of cars) {
    c.distToCam = c.group.position.distanceTo(camera.position);
    audio.updateCar(c, c.isPlayer);
    const slipMag = Math.abs(c.physics.slip);
    const skidding = slipMag > 0.22 && c.physics.kmh > 30 && c.physics.onRoad && c.distToCam < 70;
    audio.setSkid(c, skidding ? slipMag : 0);
  }
  audio.setWind(player.physics.kmh);

  // HUD
  if (race.state >= GameState.COUNTDOWN) {
    hud.updateSpeed(player.physics);
    hud.updateRace(player, cars, race.time, race.totalLaps);
    hud.updateMinimap(cars);
    hud.updateCornerArrow(player, track);
    const spd01 = Math.min(1, player.physics.kmh / 260);
    hud.setVignette(spd01 * spd01 * 0.5 + (player.physics.onRoad ? 0 : 0.28));
    // تغذية التدرج السينمائي بالسرعة والانزلاق
    gradePass.uniforms.uSpeed.value = spd01;
    gradePass.uniforms.uDrift.value = Math.min(1, Math.abs(player.physics.slip) / 0.8);
  }
  gradePass.uniforms.uTime.value = now / 1000;
  checkWrongWay(frameDt);

  composer.render();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

buildGarage();
animate();

// نقطة فحص للتطوير/الاختبار (لا تؤثر على اللعب)
window.__dbg = { ver: 'hq1', cars, player: () => player, track, race, stepSim, GameState, getAis: () => ais, AIController, startRace, selectedCar: () => selectedCar, setSelectedCar: (i) => { selectedCar = i; }, gradePass, composer,
  /** سباق محاكى كامل: يُشغّل سباقاً حقيقياً ويقود اللاعب بالذكاء الاصطناعي حتى نهايته */
  simAI: (maxSeconds = 110, speedMul = 1.0) => new Promise((resolve, reject) => {
    if (!window.__dbg) return reject(new Error('no dbg'));
    const { cars: C, track: T, race: R, GameState: G } = window.__dbg;
    try { startRace(); } catch (e) { return reject(e); }
    R.freezeInput = false;
    const ctrl = new AIController(player, T, { speedMul, aggression: 0.5, wobbleAmp: 0.5 });
    let offRoad = 0, steps = 0, maxLat = 0;
    const ZERO = { throttle: 0, steer: 0, handbrake: false };
    const STEP = () => {
      for (let k = 0; k < Math.floor(60 / 0.9) && steps < maxSeconds * 120; k++, steps++) {
        const input = player.finished ? ZERO : ctrl.compute(1 / 120, C);
        stepSim(1 / 120, input);
        if (!player.physics.onRoad && player.physics.kmh > 20) offRoad++;
        maxLat = Math.max(maxLat, Math.abs(player.lateral));
      }
      if (player.finished || steps >= maxSeconds * 120) {
        resolve({
          finished: player.finished, finishTime: +player.finishTime.toFixed(2),
          bestLap: isFinite(player.bestLap) ? +player.bestLap.toFixed(2) : null,
          laps: player.lap, position: player.position,
          offRoadPct: +(100 * offRoad / Math.max(1, steps)).toFixed(1),
          maxLat: +maxLat.toFixed(1), simSeconds: +(steps / 120).toFixed(1),
          standings: [...C].sort((a, b) => (b.finished - a.finished) || (b.progress - a.progress))
            .map(c => `${c.name}:${c.lap}لفة${c.finished ? '✓' : ''}`),
        });
      } else requestAnimationFrame(STEP);
    };
    requestAnimationFrame(STEP);
  }),
};
