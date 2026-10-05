/* CNS v2 — ui/wind.js: the Wind control in the topbar (one wind for the whole plan, CNSSettings.wind) and a
   very subtle drift of streaks over the map while it is on, so it reads as active at a glance (not a weather map:
   the plan's wind is uniform, so every streak moves the same way at a speed that grows with the wind). */
(function () {
  const UI = window.CNSUI, $ = UI.$, ST = () => window.CNSSettings;
  const get = () => (ST() && ST().loadAll().wind) || { enabled: false, fromDeg: 270, kt: 20 };
  const deg3 = v => String(Math.round(v) % 360).padStart(3, '0') + '°';

  function sync() {
    const w = get(), on = !!w.enabled;
    $('#windState').textContent = on ? `${deg3(w.fromDeg)} ${w.kt} kt` : 'off';
    $('#windBtn').classList.toggle('on', on);
    $('#windOn').checked = on; $('#windDir').value = w.fromDeg; $('#windKt').value = w.kt;
    $('#windDirV').textContent = deg3(w.fromDeg) + 'T'; $('#windKtV').textContent = w.kt + ' kt';
    $('#windRose').style.transform = `rotate(${(+w.fromDeg + 180) % 360}deg)`;   // the arrow points where the air goes
    $$('#windDd input[type=range]').forEach(i => { i.disabled = !on; });
    drift.set(on ? w : null);
  }
  const $$ = UI.$$;
  // Any change re-plans like a Model setting does (the settings subscription re-runs the route and network).
  function save(patch) { ST().save({ wind: Object.assign({}, get(), patch) }); sync(); }

  document.addEventListener('click', e => {
    const btn = e.target.closest('#windBtn'), dd = $('#windDd');
    if (btn) { dd.classList.toggle('open'); return; }
    if (dd.classList.contains('open') && !dd.contains(e.target)) dd.classList.remove('open');
  });
  document.addEventListener('change', e => { if (e.target.id === 'windOn') save({ enabled: e.target.checked }); });
  document.addEventListener('input', e => {
    if (e.target.id === 'windDir') { $('#windDirV').textContent = deg3(e.target.value) + 'T'; $('#windRose').style.transform = `rotate(${(+e.target.value + 180) % 360}deg)`; }
    if (e.target.id === 'windKt') $('#windKtV').textContent = e.target.value + ' kt';
  });
  document.addEventListener('change', e => { if (e.target.id === 'windDir' || e.target.id === 'windKt') save({ fromDeg: +$('#windDir').value, kt: +$('#windKt').value }); });

  // ---- the drift: short streaks moving downwind over the map, on a canvas that takes no clicks ----
  const drift = (function () {
    let cv, ctx, raf = 0, w = null, P = [];
    function size() { const m = document.getElementById('map'); if (!cv || !m) return; const r = m.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; cv.width = r.width * dpr; cv.height = r.height * dpr; cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    function seed() { const W = cv.clientWidth, H = cv.clientHeight; P = Array.from({ length: Math.round(W * H / 9000) }, () => ({ x: Math.random() * W, y: Math.random() * H, a: Math.random() * 120 })); }
    function frame() {
      raf = requestAnimationFrame(frame); if (document.hidden || !w) return;
      const W = cv.clientWidth, H = cv.clientHeight, to = (+w.fromDeg + 180) * Math.PI / 180;
      const v = 0.35 + w.kt / 50 * 1.4, dx = Math.sin(to) * v, dy = -Math.cos(to) * v, L = 6 + w.kt / 50 * 14;   // north up: screen y grows southward
      ctx.clearRect(0, 0, W, H); ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      for (const p of P) {
        p.x += dx; p.y += dy; p.a += 1;
        if (p.a > 120 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) { p.x = Math.random() * W; p.y = Math.random() * H; p.a = 0; }
        const fade = Math.sin(Math.PI * p.a / 120);   // each streak fades in and out over its short life
        ctx.strokeStyle = `rgba(50,50,110,${(0.22 * fade).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - dx / v * L, p.y - dy / v * L); ctx.stroke();
      }
    }
    function set(next) {
      w = next;
      if (!w) { if (raf) cancelAnimationFrame(raf); raf = 0; if (cv) cv.hidden = true; return; }
      if (!cv) { cv = document.createElement('canvas'); cv.id = 'windDrift'; cv.setAttribute('aria-hidden', 'true'); document.getElementById('map').appendChild(cv); ctx = cv.getContext('2d'); window.addEventListener('resize', () => { size(); seed(); }); }
      cv.hidden = false; size(); seed(); if (!raf) frame();
    }
    return { set };
  })();

  if (ST() && ST().subscribe) ST().subscribe(sync);   // Model settings › Reset also resets the wind
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync); else sync();
  UI.wind = { sync };
})();
