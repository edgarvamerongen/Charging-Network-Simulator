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
  // Each streak lives on the earth (lat/lon) and travels along the wind's true bearing, a great circle, so on the
  // globe the drift curves with it and pans/zooms with the map. Its speed and length stay fixed on SCREEN (subtle at
  // every zoom): each frame it moves the geographic distance that measures that many pixels where it is.
  const drift = (function () {
    let cv, ctx, raf = 0, w = null, P = [];
    const R = Math.PI / 180, EARTH = 6371.0088;
    const gmap = () => (UI.map && UI.map.map) || null;
    /** The point `km` along true course `brg` (°) from {lat, lng}. */
    function dest(p, brg, km) {
      const d = km / EARTH, b = brg * R, la1 = p.lat * R, lo1 = p.lng * R;
      const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
      const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
      return { lat: la2 / R, lng: ((lo2 / R + 540) % 360) - 180 };
    }
    // On the globe only the near side shows: a streak more than ~80° of arc from the view's centre is behind it.
    function visible(m, p) {
      if (m.getZoom() >= 5) return true;
      const c = m.getCenter(), cosd = Math.sin(c.lat * R) * Math.sin(p.lat * R) + Math.cos(c.lat * R) * Math.cos(p.lat * R) * Math.cos((p.lng - c.lng) * R);
      return cosd > Math.cos(80 * R);
    }
    const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    // Where the drift says nothing and draws oddly, it fades out: towards the poles (a compass bearing fans into a star
    // there) and towards the globe's rim (streaks foreshorten and stretch).
    function edgeFade(m, p) {
      const pole = 1 - smooth(65, 78, Math.abs(p.lat));
      if (m.getZoom() >= 5 || pole <= 0) return pole;
      const c = m.getCenter(), arc = Math.acos(Math.max(-1, Math.min(1, Math.sin(c.lat * R) * Math.sin(p.lat * R) + Math.cos(c.lat * R) * Math.cos(p.lat * R) * Math.cos((p.lng - c.lng) * R)))) / R;
      return pole * (1 - smooth(55, 75, arc));
    }
    function size() { const m = document.getElementById('map'); if (!cv || !m) return; const r = m.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; cv.width = r.width * dpr; cv.height = r.height * dpr; cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    // A new streak at a random point of the map. On the globe a screen point off the sphere unprojects to its rim, so a
    // spawn counts only when it projects back to (about) where it was picked.
    function spawn(p, m, W, H) {
      for (let k = 0; k < 6; k++) {
        const x = Math.random() * W, y = Math.random() * H, ll = m.containerPointToLatLng({ x, y });
        if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) continue;
        const back = m.latLngToContainerPoint(ll);
        if (Math.abs(back.x - x) < 2 && Math.abs(back.y - y) < 2 && visible(m, ll)) { p.lat = ll.lat; p.lng = ll.lng; p.a = 0; p.on = true; return; }
      }
      p.on = false; p.a = Math.random() * 60;   // nothing on the earth here (all sky): try again shortly
    }
    function seed() { const m = gmap(), W = cv.clientWidth, H = cv.clientHeight; P = Array.from({ length: Math.round(W * H / 6000) }, () => ({ lat: 0, lng: 0, a: 0, on: false }));
      if (m) P.forEach(p => { spawn(p, m, W, H); p.a = Math.random() * 120; }); }
    function frame() {
      raf = requestAnimationFrame(frame); if (document.hidden || !w) return;
      const m = gmap(); if (!m) return;
      const W = cv.clientWidth, H = cv.clientHeight, to = (+w.fromDeg + 180) % 360;
      const v = 0.5 + w.kt / 50 * 1.8, L = 9 + w.kt / 50 * 18;   // pixels per frame and streak length: as before, fixed on screen
      ctx.clearRect(0, 0, W, H); ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      for (const p of P) {
        p.a += 1;
        if (!p.on) { if (p.a > 60) spawn(p, m, W, H); continue; }
        // the local scale: km per pixel along the wind here (a 1 km step, measured on screen)
        const h = m.latLngToContainerPoint(p), probe = m.latLngToContainerPoint(dest(p, to, 1)), pxPerKm = Math.hypot(probe.x - h.x, probe.y - h.y);
        if (!(pxPerKm > 1e-6)) { spawn(p, m, W, H); continue; }
        const q = dest(p, to, v / pxPerKm); p.lat = q.lat; p.lng = q.lng;
        const head = m.latLngToContainerPoint(p);
        if (p.a > 120 || !visible(m, p) || head.x < -20 || head.x > W + 20 || head.y < -20 || head.y > H + 20) { spawn(p, m, W, H); continue; }
        const edge = edgeFade(m, p); if (edge <= 0.01) { if (Math.abs(p.lat) > 78) spawn(p, m, W, H); continue; }
        const tail = m.latLngToContainerPoint(dest(p, (to + 180) % 360, L / pxPerKm));
        const fade = Math.sin(Math.PI * p.a / 120) * edge;   // each streak fades in and out over its short life, and near poles/rim
        ctx.strokeStyle = `rgba(50,50,110,${(0.38 * fade).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(tail.x, tail.y); ctx.stroke();
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
