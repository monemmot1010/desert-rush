/* =====================================================================
   HUD — تحديثات الواجهة العربية (عداد، خريطة، ترتيب، مؤقتات، أسهم)
===================================================================== */

const $ = id => document.getElementById(id);

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a0 - a1) > 180 ? 1 : 0;
  const sweep = a1 < a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function formatTime(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

export class HUD {
  constructor(track) {
    this.track = track;
    this.rpmBg = $('rpm-arc-bg');
    this.rpmArc = $('rpm-arc');
    const bg = arcPath(50, 50, 44, 205, -25);
    this.rpmBg.setAttribute('d', bg);
    this.rpmArc.setAttribute('d', arcPath(50, 50, 44, 205, 204.5));

    this.mm = $('minimap').getContext('2d');
    const mmInfo = track.minimapPath(344, 344, 26);
    this.mmPath = mmInfo.pts;
    this.mmProject = mmInfo.project;

    this.lastStandingsKey = '';
    this.toastTimer = null;
    this.cornerVisible = false;
  }

  show() { $('hud').classList.add('on'); }
  hide() { $('hud').classList.remove('on'); }

  toast(text, ms = 1600) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  flash(strength = 0.35) {
    const el = $('flash');
    el.style.transition = 'none';
    el.style.opacity = strength;
    requestAnimationFrame(() => {
      el.style.transition = 'opacity .45s ease';
      el.style.opacity = 0;
    });
  }

  updateSpeed(physics) {
    $('hud-speed').textContent = Math.round(physics.kmh);
    $('hud-gear').textContent = physics.speed < -0.5 ? 'R' : String(physics.gear);
    const rpmN = Math.min(1, Math.max(0.02, physics.rpm));
    const endA = 205 - 230 * rpmN;
    this.rpmArc.setAttribute('d', arcPath(50, 50, 44, 205, endA));
    this.rpmArc.setAttribute('stroke', rpmN > 0.9 ? '#ff3b2f' : '#ff7a1a');
  }

  updateRace(player, cars, raceTime, totalLaps) {
    $('hud-lap').textContent = `${Math.min(totalLaps, Math.max(1, player.lap))}/${totalLaps}`;
    $('hud-pos').textContent = player.position;
    const curT = player.finished ? player.lastLap : (raceTime - player.lapStart);
    $('hud-laptime').textContent = formatTime(curT * 1000);
    $('hud-best').textContent = isFinite(player.bestLap) ? formatTime(player.bestLap * 1000) : '—';

    // الترتيب الحي
    const key = cars.map(c => `${c.name}:${c.position}`).join('|');
    if (key !== this.lastStandingsKey) {
      this.lastStandingsKey = key;
      const el = $('standings');
      el.innerHTML = '';
      for (const c of cars) {
        const row = document.createElement('div');
        row.className = 'standing-row' + (c.isPlayer ? ' me' : '');
        row.innerHTML = `<span class="rank">${c.position}</span><span class="nm">${c.name}</span>`;
        el.appendChild(row);
      }
    }
  }

  updateMinimap(cars) {
    const ctx = this.mm;
    ctx.clearRect(0, 0, 344, 344);
    // المسار
    ctx.beginPath();
    this.mmPath.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 7;
    ctx.stroke();
    // خط البداية
    const [sx, sy] = this.mmProject(this.track.pos[0].x, this.track.pos[0].z);
    ctx.fillStyle = '#fff';
    ctx.fillRect(sx - 4, sy - 4, 8, 8);

    for (const c of cars) {
      const [x, y] = this.mmProject(c.physics.position.x, c.physics.position.z);
      ctx.beginPath();
      ctx.arc(x, y, c.isPlayer ? 8 : 6, 0, 7);
      ctx.fillStyle = c.isPlayer ? '#ffb347' : (c.color || '#999');
      ctx.fill();
      if (c.isPlayer) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
    }
  }

  updateCornerArrow(car, track) {
    const idx = car.trackIdx;
    // ابحث عن منعطف قادم ضمن 150م
    const ds = track.length / 1000;
    let cornerIdx = -1;
    for (let d = 6; d < 150 / ds; d++) {
      const j = (idx + d) % 1000;
      if (Math.abs(track.kappa[j]) > 0.011) { cornerIdx = j; break; }
    }
    const el = $('next-corner');
    if (cornerIdx < 0) {
      if (this.cornerVisible) { el.classList.remove('on'); this.cornerVisible = false; }
      return;
    }
    const tA = track.tan[idx], tB = track.tan[(cornerIdx + 12) % 1000];
    const cross = tA.x * tB.z - tA.z * tB.x;
    const dot = tA.x * tB.x + tA.z * tB.z;
    const angle = Math.atan2(cross, dot); // + = يسار
    const deg = -angle * 180 / Math.PI;
    $('corner-arrow').style.transform = `rotate(${deg}deg)`;
    if (!this.cornerVisible) { el.classList.add('on'); this.cornerVisible = true; }
  }

  setVignette(v) { $('vignette').style.opacity = v.toFixed(2); }
}

