import * as THREE from 'three';

/* =====================================================================
   الحلبة «وادي الشمس» — مسار مغلق من 30 نقطة تحكم
   التصميم مبني على مبدأ «الإيقاع»: مستقيم طويل → منعطفات متتابعة →
   شعري → مستقيم خلفي → منحنى مسرع (انظر DESIGN.md §5)
===================================================================== */

const ROAD_HALF = 7.0;          // نصف عرض الطريق (14م)
const SAMPLES = 1000;           // عدد نقاط أخذ العينات على المسار

/* ---------- محمّل نسيج مشترك ---------- */
function loadTex(url, srgb = false) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// نقاط التحكم (س، ص، ع) — ص = الارتفاع
const CONTROL_POINTS = [
  [0, 0, -170], [70, 0, -175], [135, 1, -160], [180, 2, -120],
  [195, 3, -70], [185, 3, -20], [150, 2, 15], [110, 1, 30],
  [70, 0, 40], [35, 0, 60], [20, 1, 100], [45, 2, 140],
  [90, 3, 155], [140, 3, 150], [175, 2, 120], [210, 1, 95],
  [250, 0, 90], [290, 0, 110], [305, 1, 150], [290, 2, 195],
  [250, 2, 215], [205, 1, 210], [170, 0, 185], [130, 0, 175],
  [85, 0, 185], [45, 1, 205], [10, 2, 195], [-35, 2, 160],
  [-55, 1, 110], [-60, 0, 55], [-50, 0, 0], [-35, 0, -90],
];

export class Track {
  constructor() {
    this.halfWidth = ROAD_HALF;
    this.group = new THREE.Group();

    // المنحنى المغلق
    const pts = CONTROL_POINTS.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    this.length = this.curve.getLength();

    // أخذ العينات بالتساوي القوسي
    this.pos = []; this.tan = []; this.kappa = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < SAMPLES; i++) {
      const u = i / SAMPLES;
      this.pos.push(this.curve.getPointAt(u));
      this.tan.push(this.curve.getTangentAt(u).normalize());
    }
    // الانحناء (منصف الدائرة المارة بثلاث نقاط) — على المستوى الأفقي
    for (let i = 0; i < SAMPLES; i++) {
      const p0 = this.pos[(i - 1 + SAMPLES) % SAMPLES], p1 = this.pos[i], p2 = this.pos[(i + 1) % SAMPLES];
      const ax = p0.x, az = p0.z, bx = p1.x, bz = p1.z, cx = p2.x, cz = p2.z;
      const abx = bx - ax, abz = bz - az, bcx = cx - bx, bcz = cz - bz, cax = ax - cx, caz = az - cz;
      // انحناء موقّع (موجب = منعطف يسار) لتقطيع القمة من الجهة الصحيحة
      const cr = abx * bcz - abz * bcx;
      const la = Math.hypot(abx, abz), lb = Math.hypot(bcx, bcz), lc = Math.hypot(cax, caz);
      this.kappa.push(Math.abs(cr) < 1e-6 ? 0 : (2 * cr) / (la * lb * lc));
    }
    // تنعيم الانحناء
    const kSmooth = this.kappa.slice();
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < SAMPLES; i++) {
        kSmooth[i] = (this.kappa[(i - 1 + SAMPLES) % SAMPLES] + 2 * this.kappa[i] + this.kappa[(i + 1) % SAMPLES]) / 4;
      }
      this.kappa = kSmooth.slice();
    }

    // خط السباق (إزاحة جانبية منجزة نحو داخل المنعطفات)
    this._buildRacingLine();
    // سرعات AI المستهدفة من الانحناء (حد أدنى أمان + فرملة استباقية)
    this._buildSpeedProfile();

    this._buildRoad();
    this._buildTerrain();
    this._buildDecorations();
  }

  /* ---------- خط السباق ---------- */
  _buildRacingLine() {
    const maxOff = this.halfWidth - 2.4;
    const off = new Float32Array(SAMPLES);
    for (let iter = 0; iter < 400; iter++) {
      const next = new Float32Array(SAMPLES);
      for (let i = 0; i < SAMPLES; i++) {
        const prev = off[(i - 1 + SAMPLES) % SAMPLES], nx = off[(i + 1) % SAMPLES];
        let v = off[i] + ((prev + nx) / 2 - off[i]) * 0.22;
        // ميل نحو داخل المنعطف (إشارة الانحناء تحدد الجهة)
        const k = this.kappa[i];
        v += k * 900 * 0.0012; // سحب لطيف نحو الداخل
        next[i] = THREE.MathUtils.clamp(v, -maxOff, maxOff);
      }
      off.set(next);
    }
    this.raceOffsets = off;
    this.raceLine = [];
    for (let i = 0; i < SAMPLES; i++) this.raceLine.push(this._lateralPoint(i, off[i]));
  }

  _lateralPoint(i, lat) {
    const t = this.tan[i];
    const left = new THREE.Vector3(-t.z, 0, t.x); // يسار المسار
    return this.pos[i].clone().addScaledVector(left, lat);
  }

  /* ---------- ملف سرعة AI ---------- */
  _buildSpeedProfile() {
    // سقف القبضة بهامش أمان: يسمح بالتذبذب والخطأ البشري دون خروج عن المسار
    const LAT_MAX = 16, V_MAX = 71, A_ACC = 9.5, A_DEC = 13;
    const v = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) {
      const k = Math.max(Math.abs(this.kappa[i]), 1e-4);
      v[i] = Math.min(V_MAX, Math.sqrt(LAT_MAX / k));
    }
    const ds = this.length / SAMPLES;
    // مرور عكسي: فرملة استباقية قبل المنعطف
    for (let n = 0; n < SAMPLES * 2; n++) {
      const i = SAMPLES - 1 - (n % SAMPLES);
      const j = (i + 1) % SAMPLES;
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * A_DEC * ds));
    }
    // مرور أمامي: تسارع محدود بعد المنعطف
    for (let n = 0; n < SAMPLES * 2; n++) {
      const i = n % SAMPLES;
      const j = (i + 1) % SAMPLES;
      v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * A_ACC * ds));
    }
    this.vProfile = v;
  }

  /* ---------- شبكة الطريق ---------- */
  _buildRoad() {
    const N = SAMPLES;
    // --- سطح الأسفلت ---
    const roadGeo = new THREE.BufferGeometry();
    const rv = new Float32Array(N * 2 * 3);
    const ruv = new Float32Array(N * 2 * 2);
    const idx = [];
    for (let i = 0; i < N; i++) {
      const t = this.tan[i];
      const left = new THREE.Vector3(-t.z, 0, t.x);
      const p = this.pos[i];
      const l = p.clone().addScaledVector(left, this.halfWidth);
      const r = p.clone().addScaledVector(left, -this.halfWidth);
      rv.set([l.x, l.y + 0.02, l.z], i * 6);
      rv.set([r.x, r.y + 0.02, r.z], i * 6 + 3);
      const vv = (i * this.length) / N / 9;
      ruv.set([0, vv], i * 4); ruv.set([1, vv], i * 4 + 2);
      const a = i * 2, b = i * 2 + 1, c = ((i + 1) % N) * 2, d = ((i + 1) % N) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
    roadGeo.setAttribute('position', new THREE.BufferAttribute(rv, 3));
    roadGeo.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
    roadGeo.setIndex(idx);
    roadGeo.computeVertexNormals();
    // أسفلت PBR حقيقي (ambientCG Asphalt022 — CC0): لون + ملمس + خشونة
    const asphalt = new THREE.MeshStandardMaterial({
      map: loadTex('assets/tex/asphalt_color.jpg', true),
      normalMap: loadTex('assets/tex/asphalt_nor.jpg'),
      roughnessMap: loadTex('assets/tex/asphalt_rough.jpg'),
      roughness: 1.0, metalness: 0.0,
    });
    asphalt.normalScale.set(0.85, 0.85);
    this.group.add(new THREE.Mesh(roadGeo, asphalt));

    // --- خطوط الحواف البيضاء ---
    this.group.add(this._edgeStrip(this.halfWidth - 0.55, this.halfWidth - 0.15, '#e8e8e8'));
    this.group.add(this._edgeStrip(-(this.halfWidth - 0.15), -(this.halfWidth - 0.55), '#e8e8e8'));

    // --- خط منقط بالمنتصف ---
    this.group.add(this._centerDashes());

    // --- أرصفة حمراء/بيضاء عند المنعطفات ---
    this._buildCurbs();

    // --- خط النهاية (نسيج شطرنجي) + بوابة ---
    this._buildStartLine();
  }

  _edgeStrip(from, to, color) {
    const N = SAMPLES;
    const geo = new THREE.BufferGeometry();
    const v = new Float32Array(N * 2 * 3);
    const idx = [];
    for (let i = 0; i < N; i++) {
      const t = this.tan[i];
      const left = new THREE.Vector3(-t.z, 0, t.x);
      const p = this.pos[i];
      const a = p.clone().addScaledVector(left, from);
      const b = p.clone().addScaledVector(left, to);
      v.set([a.x, a.y + 0.03, a.z], i * 6);
      v.set([b.x, b.y + 0.03, b.z], i * 6 + 3);
      const A = i * 2, B = i * 2 + 1, C = ((i + 1) % N) * 2, D = ((i + 1) % N) * 2 + 1;
      idx.push(A, C, B, B, C, D);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  }

  _centerDashes() {
    const pts = [], idx = [];
    const dashLen = Math.floor(4 / (this.length / SAMPLES));
    const gap = Math.floor(4 / (this.length / SAMPLES));
    let i = 0, vi = 0;
    while (i < SAMPLES) {
      for (let d = 0; d < dashLen && i < SAMPLES; d++, i++) {
        const t = this.tan[i];
        const left = new THREE.Vector3(-t.z, 0, t.x);
        const p = this.pos[i];
        const a = p.clone().addScaledVector(left, 0.22);
        const b = p.clone().addScaledVector(left, -0.22);
        pts.push(a.x, a.y + 0.035, a.z, b.x, b.y + 0.035, b.z);
        if (d < dashLen - 1) {
          const A = vi, B = vi + 1, C = vi + 2, D = vi + 3;
          idx.push(A, C, B, B, C, D);
        }
        vi += 2;
      }
      i += gap;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#dcd6c8' }));
  }

  _buildCurbs() {
    const ds = this.length / SAMPLES;
    const chunk = Math.max(2, Math.floor(2.2 / ds)); // شريحة كل ~2.2م
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    const positions = [], colors = [], idx = [];
    const cRed = new THREE.Color('#c8352a'), cWhite = new THREE.Color('#f2efe8');
    let vi = 0;
    let i = 0;
    while (i < SAMPLES) {
      const k = Math.abs(this.kappa[i]);
      const run = Math.min(chunk * (1 + Math.floor(Math.random() * 2)), SAMPLES - i);
      if (k > 0.0075) {
        // رصيف على الجهتين لهذه الشريحة
        const col = (Math.floor(i / chunk) % 2 === 0) ? cRed : cWhite;
        for (const side of [1, -1]) {
          for (let s = 0; s < run; s++) {
            const j = (i + s) % SAMPLES;
            const t = this.tan[j];
            const left = new THREE.Vector3(-t.z, 0, t.x);
            const p = this.pos[j];
            const a = p.clone().addScaledVector(left, side * this.halfWidth);
            const b = p.clone().addScaledVector(left, side * (this.halfWidth + 1.25));
            positions.push(a.x, a.y + 0.06, a.z, b.x, b.y + 0.14, b.z);
            colors.push(col.r, col.g, col.b, col.r, col.g, col.b);
          }
          for (let s = 0; s < run - 1; s++) {
            const A = vi + s * 2, B = A + 1, C = A + 2, D = A + 3;
            idx.push(A, C, B, B, C, D);
          }
          vi += run * 2;
        }
      }
      i += run;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    this.group.add(mesh);
  }

  _buildStartLine() {
    // شريط الشطرنج عند نقطة البداية
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const cw = 16;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#111' : '#f5f5f5';
      ctx.fillRect(x * cw, y * cw, cw, cw);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const t0 = this.tan[0];
    const left = new THREE.Vector3(-t0.z, 0, t0.x);
    const p0 = this.pos[0];
    const geo = new THREE.PlaneGeometry(this.halfWidth * 2, 3.2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -Math.atan2(t0.x, t0.z);
    mesh.position.copy(p0).add(new THREE.Vector3(0, 0.045, 0));
    this.group.add(mesh);

    // بوابة البداية
    const gantry = new THREE.Group();
    const pillarG = new THREE.CylinderGeometry(0.45, 0.55, 9, 10);
    const pillarM = new THREE.MeshStandardMaterial({ color: '#3a3f46', roughness: 0.5, metalness: 0.6 });
    const pL = new THREE.Mesh(pillarG, pillarM); pL.position.set(this.halfWidth + 1.2, 4.5, 0);
    const pR = new THREE.Mesh(pillarG, pillarM); pR.position.set(-(this.halfWidth + 1.2), 4.5, 0);
    // لافتة «الانطلاق»
    const bannerCanvas = document.createElement('canvas');
    bannerCanvas.width = 1024; bannerCanvas.height = 128;
    const bc = bannerCanvas.getContext('2d');
    const grad = bc.createLinearGradient(0, 0, 1024, 0);
    grad.addColorStop(0, '#e8540a'); grad.addColorStop(1, '#ff9a2a');
    bc.fillStyle = grad; bc.fillRect(0, 0, 1024, 128);
    bc.fillStyle = '#fff'; bc.font = '900 72px Cairo, sans-serif';
    bc.textAlign = 'center'; bc.textBaseline = 'middle';
    bc.fillText('ســرعــة الــصحــراء', 512, 70);
    const bannerTex = new THREE.CanvasTexture(bannerCanvas);
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(this.halfWidth * 2 + 4, 2.2, 0.3),
      new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.6 })
    );
    banner.position.set(0, 8.6, 0);
    gantry.add(pL, pR, banner);
    gantry.position.copy(p0);
    gantry.rotation.y = Math.atan2(t0.x, t0.z);
    this.group.add(gantry);
  }

  /* ---------- التضاريس: رمل بإزاحة رأسية حقيقية + تسطيح حول المضمار ---------- */
  _buildTerrain() {
    const SIZE = 1300, SEG = 140, CX = 122, CZ = 20, HALF = SIZE / 2;

    // شبكة تجزئة مكانية لاستعلام أقرب نقطة مضمار بسرعة
    const CELL = 40;
    const grid = new Map();
    const gkey = (gx, gz) => gx + ':' + gz;
    for (let i = 0; i < SAMPLES; i++) {
      const k = gkey(Math.floor(this.pos[i].x / CELL), Math.floor(this.pos[i].z / CELL));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const _best = { d: Infinity, y: 0, i: 0 };
    const distToTrack = (x, z) => {
      _best.d = Infinity;
      const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
      let found = false;
      for (let ox = -1; ox <= 1 && !found; ox++) for (let oz = -1; oz <= 1; oz++) {
        const arr = grid.get(gkey(gx + ox, gz + oz));
        if (!arr) continue;
        found = true;
        for (const i of arr) {
          const dx = this.pos[i].x - x, dz = this.pos[i].z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < _best.d) { _best.d = d2; _best.y = this.pos[i].y; _best.i = i; }
        }
      }
      if (!found || _best.d > 90 * 90) { // صحراء عميقة: مسح خشن
        for (let i = 0; i < SAMPLES; i += 8) {
          const dx = this.pos[i].x - x, dz = this.pos[i].z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < _best.d) { _best.d = d2; _best.y = this.pos[i].y; _best.i = i; }
        }
      }
      return Math.sqrt(_best.d);
    };

    // ضوضاء قيمية FBM + عرف (ridge) لكثبان حقيقية
    const hash2 = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
    const vnoise = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    const fbm = (x, y) => { let f = 0, amp = 0.5, s = 1; for (let o = 0; o < 4; o++) { f += amp * vnoise(x * s, y * s); s *= 2.03; amp *= 0.5; } return f; };

    const W0 = 26, W1 = 75; // نطاق التسطيح حول المضمار
    const smooth = (t) => t * t * (3 - 2 * t);
    const terrainH = (x, z) => {
      const d = distToTrack(x, z);
      const big = fbm(x * 0.004 + 7.3, z * 0.004 + 2.1);
      const ridge = 1 - Math.abs(2 * vnoise(x * 0.0025 + 11, z * 0.0025 + 5) - 1);
      let h = big * 11 + ridge * ridge * 9 - 7;
      const dc = Math.hypot(x - CX, z - CZ);
      if (dc > 470) h += (dc - 470) * 0.055 * (0.5 + big); // سلسلة جبال أفقية
      if (d < W1) {
        const t = smooth(Math.min(1, Math.max(0, (d - W0) / (W1 - W0))));
        h = _best.y * (1 - t) + h * t;
      }
      return h;
    };
    // نسخة استعلام سريعة للسيارات (نفس الدالة)
    this.terrainHeight = terrainH;

    // بناء الشبكة
    const N = SEG + 1;
    const positions = new Float32Array(N * N * 3);
    const uvs = new Float32Array(N * N * 2);
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = CX - HALF + (i / SEG) * SIZE;
      const z = CZ - HALF + (j / SEG) * SIZE;
      const k = j * N + i;
      positions[k * 3] = x; positions[k * 3 + 1] = terrainH(x, z); positions[k * 3 + 2] = z;
      uvs[k * 2] = (i / SEG) * (SIZE / 14); uvs[k * 2 + 1] = (j / SEG) * (SIZE / 14);
    }
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    // تلوين بالارتفاع والانحدار (يُضرب بلون نسيج الرمل)
    const pos3 = geo.attributes.position, nor = geo.attributes.normal;
    const colors = new Float32Array(N * N * 3);
    const cLow = new THREE.Color(0.72, 0.58, 0.40), cHigh = new THREE.Color(1.06, 1.0, 0.9), cRock = new THREE.Color(0.52, 0.47, 0.42);
    const tmpC = new THREE.Color();
    for (let k = 0; k < N * N; k++) {
      const h = pos3.getY(k), ny = nor.getY(k);
      tmpC.copy(cLow).lerp(cHigh, THREE.MathUtils.clamp((h + 6) / 18, 0, 1));
      if (ny < 0.88) tmpC.lerp(cRock, THREE.MathUtils.clamp((0.88 - ny) * 4, 0, 0.85));
      colors[k * 3] = tmpC.r; colors[k * 3 + 1] = tmpC.g; colors[k * 3 + 2] = tmpC.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      map: loadTex('assets/tex/sand_color.jpg', true),
      normalMap: loadTex('assets/tex/sand_nor.jpg'),
      roughnessMap: loadTex('assets/tex/sand_rough.jpg'),
      roughness: 1.0, metalness: 0.0, vertexColors: true,
    });
    mat.normalScale.set(0.8, 0.8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildDecorations() {
    const g = this.group;
    const H = this.terrainHeight;
    // مسارات صخرية (Mesas) متشوهة بالضوضاء بدل الكرات المفلطحة
    const mesaMat = new THREE.MeshStandardMaterial({ color: '#b98f5e', roughness: 1 });
    for (let i = 0; i < 11; i++) {
      const ang = (i / 11) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 400 + Math.random() * 160;
      const cx = 122 + Math.cos(ang) * dist, cz = 20 + Math.sin(ang) * dist;
      const geo = new THREE.CylinderGeometry(26 + Math.random() * 22, 40 + Math.random() * 26, 22 + Math.random() * 16, 11, 4);
      const pv = geo.attributes.position;
      for (let k = 0; k < pv.count; k++) {
        const x = pv.getX(k), y = pv.getY(k), z = pv.getZ(k);
        const s = 1 + 0.16 * Math.sin(x * 0.11 + z * 0.13) + 0.1 * Math.cos(y * 0.31 + x * 0.07);
        pv.setXYZ(k, x * s, y * (1 + 0.1 * Math.sin(z * 0.09)), z * s);
      }
      geo.computeVertexNormals();
      const mesa = new THREE.Mesh(geo, mesaMat);
      mesa.position.set(cx, H(cx, cz) + 2, cz);
      mesa.castShadow = true; mesa.receiveShadow = true;
      g.add(mesa);
    }
    // صخور جيوديسية (Icosahedron بلا كمال)
    const rockMat = new THREE.MeshStandardMaterial({ color: '#9c7d55', roughness: 0.95 });
    for (let i = 0; i < 80; i++) {
      const p = this._randomOffTrackPoint(16, 260);
      if (!p) continue;
      const s = 0.8 + Math.random() * 2.8;
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), rockMat);
      const rp = rock.geometry.attributes.position;
      for (let k = 0; k < rp.count; k++) {
        rp.setXYZ(k, rp.getX(k) * (0.78 + Math.random() * 0.44), rp.getY(k) * (0.7 + Math.random() * 0.5), rp.getZ(k) * (0.78 + Math.random() * 0.44));
      }
      rock.geometry.computeVertexNormals();
      rock.position.set(p.x, H(p.x, p.z) + s * 0.3, p.z);
      rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      rock.castShadow = true;
      g.add(rock);
    }
    // أقماع مرور عند مداخل المنعطفات الحادة
    const coneMat = new THREE.MeshStandardMaterial({ color: '#ff5a1f', roughness: 0.6 });
    const coneG = new THREE.ConeGeometry(0.32, 0.85, 10);
    for (let i = 0; i < SAMPLES; i++) {
      if (Math.abs(this.kappa[i]) > 0.013 && i % 14 === 0) {
        const t = this.tan[i];
        const left = new THREE.Vector3(-t.z, 0, t.x);
        const p = this.pos[i];
        for (const side of [1, -1]) {
          const c = new THREE.Mesh(coneG, coneMat);
          c.position.copy(p).addScaledVector(left, side * (this.halfWidth + 2.2));
          c.position.y = H(c.position.x, c.position.z) + 0.42;
          c.castShadow = true;
          g.add(c);
        }
      }
    }
    // صبّار بسيط
    const cacMat = new THREE.MeshStandardMaterial({ color: '#5e7d4a', roughness: 0.9 });
    for (let i = 0; i < 46; i++) {
      const p = this._randomOffTrackPoint(14, 220);
      if (!p) continue;
      const cac = new THREE.Group();
      const h = 2.2 + Math.random() * 2.4;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.4, h, 8), cacMat);
      trunk.position.y = h / 2;
      trunk.castShadow = true;
      cac.add(trunk);
      if (Math.random() > 0.35) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, h * 0.5, 8), cacMat);
        arm.position.set(0.62, h * 0.55, 0); arm.rotation.z = -0.5;
        arm.castShadow = true;
        cac.add(arm);
      }
      cac.position.set(p.x, H(p.x, p.z), p.z);
      cac.rotation.y = Math.random() * Math.PI * 2;
      g.add(cac);
    }
  }

  _randomOffTrackPoint(minDist, maxDist) {
    for (let tries = 0; tries < 12; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = minDist + Math.random() * (maxDist - minDist);
      const cx = 110 + Math.cos(ang) * dist;
      const cz = 20 + Math.sin(ang) * dist;
      let ok = true;
      for (let i = 0; i < SAMPLES; i += 6) {
        const dx = this.pos[i].x - cx, dz = this.pos[i].z - cz;
        if (dx * dx + dz * dz < (minDist * minDist)) { ok = false; break; }
      }
      if (ok) return new THREE.Vector3(cx, 0, cz);
    }
    return null;
  }

  /* ---------- استعلامات ---------- */
  // أقرب نقطة على المسار (بحث بنافذة حول hint، مع بحث كامل عند الفقد)
  nearest(p, hintIdx = 0) {
    let best = -1, bestD = Infinity;
    const win = 180; // ≈ 300م: يغطي أقصى تنقل بين إطارين حتى بسرعات قصوى
    for (let d = -win; d <= win; d++) {
      const i = ((hintIdx + d) % SAMPLES + SAMPLES) % SAMPLES;
      const dx = this.pos[i].x - p.x, dz = this.pos[i].z - p.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestD) { bestD = dist; best = i; }
    }
    if (bestD > 2500) { // فقد المسار (بعيد > 50م) → بحث كامل
      for (let i = 0; i < SAMPLES; i++) {
        const dx = this.pos[i].x - p.x, dz = this.pos[i].z - p.z;
        const dist = dx * dx + dz * dz;
        if (dist < bestD) { bestD = dist; best = i; }
      }
    }
    const t = this.tan[best];
    const left = new THREE.Vector3(-t.z, 0, t.x);
    const lateral = (p.x - this.pos[best].x) * left.x + (p.z - this.pos[best].z) * left.z;
    return { idx: best, dist: Math.sqrt(bestD), lateral };
  }

  isOnRoad(lateral) { return Math.abs(lateral) <= this.halfWidth + 0.4; }

  // مواقع خط الانطلاق (4 خانات، اللاعب أخيرها)
  gridSlot(n) {
    const back = 8 + n * 6.5;
    const u = (((0 - back / this.length) % 1) + 1) % 1;
    const i = Math.floor(u * SAMPLES) % SAMPLES;
    const t = this.tan[i];
    const fwd = t.clone().setY(0).normalize();
    const left = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const lat = (n % 2 === 0) ? 3.2 : -3.2;
    const p = this.pos[i].clone().addScaledVector(left, lat);
    const heading = Math.atan2(fwd.x, fwd.z);
    return { position: p, heading };
  }

  // نقاط الخريطة المصغرة
  minimapPath(w, h, pad = 14) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of this.pos) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const sx = (w - pad * 2) / (maxX - minX);
    const sz = (h - pad * 2) / (maxZ - minZ);
    const s = Math.min(sx, sz);
    const ox = (w - (maxX - minX) * s) / 2, oz = (h - (maxZ - minZ) * s) / 2;
    const pts = this.pos.filter((_, i) => i % 8 === 0).map(p => [
      ox + (p.x - minX) * s, oz + (p.z - minZ) * s,
    ]);
    return { pts, project: (x, z) => [ox + (x - minX) * s, oz + (z - minZ) * s] };
  }
}
