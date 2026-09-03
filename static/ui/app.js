/* CNS v2 — ui/app.js: state, catalogs, airports, search, formatters, the engine adapter, boot.
   Everything renders from `S`; persistent state lives in the engines' localStorage keys. */
window.CNSUI = (function () {
  const D = window.CNS_DATA || { planes: [], chargers: [], cartoKeyQs: '', shareState: null };
  const PLANES = (D.planes || []).slice();
  const CHARGERS = (D.chargers || []).slice();
  const SEED = { origin: 'EHLE', dest: 'EDDF' };
  const S = {
    mode: 'plan', rail: 'form', planeId: null, chargerId: null,
    origin: null, dest: null, stops: [], trip: 'one-way', freq: 1, per: 'day',
    result: null, profile: null, busy: false, err: '',
    filter: '', lanes: 'airports', showDep: false,
    base: 'light', showSmall: false, showAssets: true, showNet: true,
    allChargers: false, picking: false, open: { route: true, charging: false, calc: false }, openAp: {}
  };
  let AIRPORTS = [], AP_BY_ID = {}, ASSETS = {};

  // ---- helpers ------------------------------------------------------------
  const hasDoc = typeof document !== 'undefined';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const U = () => window.CNSUnits || null;
  const nautical = () => !!(U() && U().isNautical && U().isNautical());
  const km = v => nautical() ? v / 1.852 : v;
  const ukm = () => nautical() ? 'NM' : 'km';
  const fmt = {
    km, ukm,
    dist: v => Math.round(km(v)).toLocaleString('en') + ' ' + ukm(),
    h: min => { const m = Math.round(min); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); },
    min: m => m >= 60 ? fmt.h(m) + ' h' : Math.round(m) + ' min',
    eur: v => v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    kw: v => v >= 1000 ? (v / 1000).toFixed(1) + ' MW' : Math.round(v) + ' kW',
    kwh: v => v >= 1000 ? (v / 1000).toFixed(1) + ' MWh' : Math.round(v) + ' kWh'
  };
  const perDay = f => f.per === 'day' || f.freqUnit === 'day' ? +(f.freq ?? f.freqN ?? 1) : +(f.freq ?? f.freqN ?? 1) / 7;
  const planeShort = n => String(n || '').replace(/^Beta /, '').split(' — ')[0].replace(/ \(.*\)$/, '');
  const shortName = n => String(n || '').replace(/\s+(International\s+)?Airport$/i, '').replace(/\s+Airfield$/i, '');
  const plane = () => PLANES.find(p => p.id === S.planeId) || PLANES[0];
  const charger = () => CHARGERS.find(c => c.id === S.chargerId) || CHARGERS[0];
  const ll = a => [a.latitude_deg ?? a.lat, a.longitude_deg ?? a.lon];
  const chain = () => {
    const st = S.stops.filter(Boolean);
    if (S.trip === 'training') return S.origin ? [S.origin] : [];
    const c = [S.origin, ...st, S.dest].filter(Boolean);
    if (S.trip === 'circular' && S.origin && S.dest) c.push(S.origin);
    return c;
  };
  function toast(t) { if (!hasDoc) return; const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => e.classList.remove('show'), 2200); }

  // ---- airport search (client-side over /api/airports) ---------------------
  const RANK = { large_airport: 0, medium_airport: 1, small_airport: 2 };
  function search(q) {
    q = (q || '').trim().toLowerCase(); if (q.length < 2) return [];
    const out = [];
    for (const a of AIRPORTS) {
      const id = a.ident.toLowerCase(), ia = (a.iata_code || '').toLowerCase(), nm = a.name.toLowerCase(), mu = (a.municipality || '').toLowerCase();
      let r; if (q === id || q === ia) r = 0; else if (nm.startsWith(q) || mu.startsWith(q)) r = 1; else if (nm.split(' ').some(w => w.startsWith(q))) r = 2; else if (nm.includes(q) || mu.includes(q) || id.startsWith(q)) r = 3; else continue;
      out.push([r, RANK[a.type] ?? 3, a]);
    }
    return out.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2].name.localeCompare(y[2].name)).slice(0, 8).map(x => x[2]);
  }

  // ---- engine adapter: names the engines read off `window` -----------------
  function rebuildIndexes() {
    window.PLANES_BY_ID = Object.fromEntries(PLANES.map(p => [p.id, p]));
    window.CHARGERS_BY_ID = Object.fromEntries(CHARGERS.map(c => [c.id, c]));
    window.airportByIdent = AP_BY_ID;       // report.js reads window.airportByIdent — dangling in the classic shell
  }
  window.escHtml = esc;
  window.folderMap = null;                  // tour.js reads it; the replay map sets it in phase 3
  window.setOrigin = ap => { S.origin = ap; CNSUI.plan && CNSUI.plan.onFormChange(true); };
  window.setDest = ap => { S.dest = ap; CNSUI.plan && CNSUI.plan.onFormChange(true); };
  window.setStop = ap => { S.stops.push(ap); CNSUI.plan && CNSUI.plan.onFormChange(true); };
  rebuildIndexes();

  function _setAirports(list) { AIRPORTS = list.filter(a => a.ident && a.latitude_deg != null); AP_BY_ID = {}; AIRPORTS.forEach(a => AP_BY_ID[a.ident] = a); rebuildIndexes(); }
  function _applyDefaults() {
    const beta = PLANES.find(p => /^beta/i.test(p.id)) || PLANES[0];
    S.planeId = beta ? beta.id : null;
    const dc = beta && beta.default_charger_id; S.chargerId = (dc && CHARGERS.find(c => c.id === dc)) ? dc : (CHARGERS[0] && CHARGERS[0].id);
    S.origin = AP_BY_ID[SEED.origin] || null; S.dest = AP_BY_ID[SEED.dest] || null;
  }

  // ---- render + boot -------------------------------------------------------
  function render() {
    if (!hasDoc) return;
    $('#rail').classList.toggle('wide', S.mode === 'network');
    if (S.mode === 'network') CNSUI.network.render(); else CNSUI.plan.render();
    CNSUI.timeline.render();
    $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  }
  function setMode(m) {
    S.mode = m; document.body.classList.toggle('net', m === 'network');
    if (m === 'network') CNSUI.map.hideRoute(); else CNSUI.map.showRoute();
    render(); if (m === 'network') { CNSUI.map.drawNet(); CNSUI.map.fitNet(); }
  }
  async function boot() {
    if (!hasDoc) return;
    if (window.CNSChargers) { try { await CNSChargers.load(); (CNSChargers.list() || []).forEach(c => { if (!CHARGERS.find(x => x.id === c.id)) CHARGERS.push(Object.assign({ type: 'Custom', image: '' }, c)); }); } catch (e) { console.warn('[v2] custom chargers unavailable', e); } }
    const [aps, assets] = await Promise.all([fetch('/api/airports').then(r => r.json()), fetch('/api/airport-chargers').then(r => r.json()).catch(() => ({}))]);
    _setAirports(aps); ASSETS = assets || {};
    if (window.CNSScheduler) CNSScheduler.init({ chargers: window.CHARGERS_BY_ID, onChange: () => render() });
    if (window.CNSAnimation) CNSAnimation.init();
    CNSUI.map.init();
    _applyDefaults();
    render(); CNSUI.map.drawRoute(true); CNSUI.map.drawNet();
    if (window.CNSUnits && CNSUnits.onChange) CNSUnits.onChange(() => { render(); CNSUI.map.drawRoute(false); });
    if (window.CNSSettings && CNSSettings.subscribe) CNSSettings.subscribe(() => { if (S.result) CNSUI.plan.resimulate(); render(); });
    // deep links kept from the prototype: #result #multi #network (+ :ICAO isolation later)
    const [h] = location.hash.replace('#', '').split(':');
    if (h === 'multi') { S.dest = AP_BY_ID['EDDM'] || S.dest; S.stops = [AP_BY_ID['EDDF']].filter(Boolean); await CNSUI.plan.simulate(); }
    if (h === 'result') await CNSUI.plan.simulate();
    if (h === 'network') setMode('network');
    document.addEventListener('click', e => { const b = e.target.closest('#modeSeg button'); if (b) setMode(b.dataset.mode); });
  }

  return { S, PLANES, CHARGERS, SEED, D, airports: () => AIRPORTS, byId: () => AP_BY_ID, assets: () => ASSETS,
           $, $$, esc, fmt, perDay, planeShort, shortName, plane, charger, ll, chain, toast, search,
           render, setMode, boot, rebuildIndexes, _setAirports, _applyDefaults };
})();
