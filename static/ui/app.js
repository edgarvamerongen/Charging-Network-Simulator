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
    allChargers: false, picking: false, open: { route: true, charging: false, calc: false }, openAp: {},
    acFilters: { type: null, propulsion: null, status: null }, acFilterOpen: false, availOverride: null
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
  const r = v => (U() && U().r) ? U().r(v) : (Math.ceil(v - 1e-9) || 0);   // the classic rounds UP everywhere (CNSUnits.r)
  const fmt = {
    km, ukm, r,
    // Distances round UP everywhere, like the classic's CNSUnits.fmtDist (static/units.js:30-33).
    dist: v => r(km(v)).toLocaleString('en') + ' ' + ukm(),
    h: min => { const m = r(min); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); },
    min: m => m >= 60 ? fmt.h(m) + ' h' : r(m) + ' min',
    eur: v => v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    kw: v => v >= 1000 ? (v / 1000).toFixed(1) + ' MW' : Math.round(v) + ' kW',
    kwh: v => v >= 1000 ? (v / 1000).toFixed(1) + ' MWh' : Math.round(v) + ' kWh'
  };
  const perDay = f => f.per === 'day' || f.freqUnit === 'day' ? +(f.freq ?? f.freqN ?? 1) : +(f.freq ?? f.freqN ?? 1) / 7;
  const planeShort = n => String(n || '').replace(/^Beta /, '').split(' — ')[0].replace(/ \(.*\)$/, '');
  const shortName = n => String(n || '').replace(/\s+(International\s+)?Airport$/i, '').replace(/\s+Airfield$/i, '');
  // Photo precedence, verbatim from the classic's _planeImg (index.html:3645): the Notion-synced
  // photo wins over the committed pics/ file; NEITHER means no <img> at all (a bare /pics/ 404s).
  const planeImg = p => (p && p.image_url) ? p.image_url : (p && p.image ? '/pics/' + String(p.image).split('/').map(encodeURIComponent).join('/') : '');
  // Legacy / scenario / share-link plane ids that are not catalog row ids (the prototype catalog's).
  const PLANE_ALIAS = { beta_plane: 'beta_alia', vaeridion: 'vaeridion_microliner', vaeridion_light: 'vaeridion_microliner_9_seats' };
  /** id → a REAL catalog row id: exact row · airframe (aircraft_id) · alias map · name match. null when nothing matches. */
  function resolvePlaneId(id) {
    const k = String(id == null ? '' : id).trim(); if (!k) return null;
    if (PLANES.some(p => p.id === k)) return k;
    const byGroup = PLANES.find(p => String(p.aircraft_id || '') === k); if (byGroup) return byGroup.id;
    const alias = PLANE_ALIAS[k];
    if (alias) { if (PLANES.some(p => p.id === alias)) return alias; const g = PLANES.find(p => String(p.aircraft_id || '') === alias); if (g) return g.id; }
    const words = k.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return null;
    const re = new RegExp(words.join('.*'), 'i');
    const byName = PLANES.find(p => re.test(String(p.name || ''))); return byName ? byName.id : null;
  }
  // An unknown id resolves through the alias map rather than silently becoming PLANES[0] — the range
  // gate must never evaluate a different aircraft than the one the caller named (TIMELINE-9/SHELL-1).
  const plane = () => PLANES.find(p => p.id === S.planeId) || (S.planeId ? PLANES.find(p => p.id === resolvePlaneId(S.planeId)) : null) || PLANES[0];
  const charger = () => CHARGERS.find(c => c.id === S.chargerId) || CHARGERS[0];
  const ll = a => [a.latitude_deg ?? a.lat, a.longitude_deg ?? a.lon];
  // The distance to SHOW in every planning aid: the classic's _dispKm (index.html:4596-4601) —
  // routed (great-circle × airways padding) + the fixed SID/STAR pad, i.e. the engine's per-leg distKm.
  function dispKm(a, b) {
    const P = x => ({ lat: +(x.latitude_deg ?? x.lat), lon: +(x.longitude_deg ?? x.lon) });
    const A = P(a), B = P(b), p = plane();
    const sid = (window.CNSSettings && CNSSettings.sidStarPaddingKm) ? CNSSettings.sidStarPaddingKm(p) : 0;
    if (window.CNSRouting && CNSRouting.routedKm) return CNSRouting.routedKm(A, B, p) + sid;
    const R = 6371, dL = (B.lat - A.lat) * Math.PI / 180, dN = (B.lon - A.lon) * Math.PI / 180;
    const x = Math.sin(dL / 2) ** 2 + Math.cos(A.lat * Math.PI / 180) * Math.cos(B.lat * Math.PI / 180) * Math.sin(dN / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x)) + sid;
  }
  const chain = () => {
    if (CNSUI.planner) return CNSUI.planner.chain();
    const st = S.stops.filter(Boolean);
    if (S.trip === 'training') return S.origin ? [S.origin] : [];
    const c = [S.origin, ...st, S.dest].filter(Boolean);
    if (S.trip === 'circular' && S.origin && S.dest) c.push(S.origin);
    return c;
  };
  // The topbar count belongs to the FOLDER, not to the Network render: Plan-mode adds and removals
  // must move it too (the classic's drawer subtitle updates on every folder notify).
  function netCount() { if (!hasDoc) return; const e = $('#netCount'); if (!e) return; const n = (window.CNSDemand && CNSDemand.loadFolder) ? CNSDemand.loadFolder().length : 0; e.textContent = n || ''; }
  function folderChanged() { netCount(); if (window.CNSState && CNSState.notify) CNSState.notify(CNSState.KEYS.folder); if (window.CNSScheduler && CNSScheduler.runGlobal) CNSScheduler.runGlobal(); }
  // ---- one modal surface for every dialog (v2 language, no Bootstrap) ----
  // Autofocus only fields whose keyboard default action is typing: a range slider or a select
  // would silently CHANGE a persisted model value on the first arrow key (the classic focuses the
  // dialog container instead). Nothing typable → focus the box itself so Escape/Tab still work.
  const TYPABLE = '#modalBox input[type=text],#modalBox input[type=number],#modalBox input[type=search],#modalBox input:not([type]),#modalBox textarea';
  const modal = { open(html) { const m = $('#modal'); const box = $('#modalBox'); box.innerHTML = html; m.hidden = false; const f = $(TYPABLE); setTimeout(() => { if (f) f.focus(); else { box.setAttribute('tabindex', '-1'); box.focus(); } }, 30); }, close() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }, isOpen() { return !$('#modal').hidden; } };
  if (hasDoc) document.addEventListener('click', e => { if (e.target.closest('[data-modal=close]') || e.target.classList.contains('modal-dim')) modal.close(); });
  if (hasDoc) document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.isOpen()) modal.close(); });
  function toast(t) { if (!hasDoc) return; const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => e.classList.remove('show'), 2200); }

  // ---- aircraft catalog model: airframe groups (profile rows), filters, knobs ----
  // Mirrors the classic picker (index.html AIRCRAFT_GROUPS): rows sharing aircraft_id are one
  // airframe; each row is a profile (label × regime × propulsion). Filters narrow airframes.
  const aircraft = (() => {
    const DIMS = ['type', 'propulsion', 'status'];
    const norm = v => String(v == null ? '' : v).trim();
    const groups = () => { const order = [], by = {}; PLANES.forEach(p => { const k = p.aircraft_id || p.id; if (!by[k]) { by[k] = []; order.push(k); } by[k].push(p); }); return order.map(k => ({ key: k, entries: by[k] })); };
    const values = (g, dim) => { const out = []; g.entries.forEach(p => { const v = norm(p[dim]); if (v && !out.includes(v)) out.push(v); }); return out; };
    const matches = (g, f) => DIMS.every(d => !(f && f[d]) || values(g, d).includes(f[d]));
    const dims = () => DIMS.map(d => { const vals = []; groups().forEach(g => values(g, d).forEach(v => { if (!vals.includes(v)) vals.push(v); })); return { key: d, values: vals }; }).filter(d => d.values.length >= 2);
    const visible = f => groups().filter(g => matches(g, f || {}));
    const groupOf = id => groups().find(g => g.entries.some(p => p.id === id)) || null;
    const pick = (g, want) => {   // best profile row for the wanted {label, regime, propulsion}; relaxes in that order
      want = want || {}; const L = p => norm(p.profile_label), R = p => norm(p.regime), M = p => norm(p.propulsion);
      const tries = [e => L(e) === want.label && R(e) === want.regime && M(e) === want.propulsion, e => L(e) === want.label && R(e) === want.regime, e => R(e) === want.regime && M(e) === want.propulsion, e => L(e) === want.label, e => R(e) === want.regime, e => M(e) === want.propulsion];
      for (const t of tries) { const e = g.entries.find(t); if (e) return e; } return g.entries[0]; };
    return { DIMS, groups, values, dims, visible, groupOf, pick, matches };
  })();

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
  // Mutate the index objects IN PLACE: CNSScheduler.init captures window.CHARGERS_BY_ID by
  // reference, so reassigning it after a custom charger loads leaves the scheduler holding the
  // old object and every custom charger reads as unpowered in the timeline (SHELL-7).
  function syncIndex(obj, list) { Object.keys(obj).forEach(k => { if (!list.some(x => x.id === k)) delete obj[k]; }); list.forEach(x => { obj[x.id] = x; }); return obj; }
  function rebuildIndexes() {
    window.PLANES_BY_ID = syncIndex(window.PLANES_BY_ID || {}, PLANES);
    window.CHARGERS_BY_ID = syncIndex(window.CHARGERS_BY_ID || {}, CHARGERS);
    window.airportByIdent = AP_BY_ID;       // report.js reads window.airportByIdent — dangling in the classic shell
  }
  window.escHtml = esc;
  window.folderMap = null;                  // tour.js reads it; the replay map sets it in phase 3
  window.renderFolder = () => { if (CNSUI.render) CNSUI.render(); };   // buildshare.js calls it after a restore
  // The classic closes the airport card and starts the reach graph from the picked endpoint in
  // exactly these three setters (index.html:2714, 2716-2720, 2740, 2748) — do the same in one place,
  // so the dot popup, the fly-to popup and the palette all behave alike. A double close is harmless.
  function afterPick(ap) {
    if (CNSUI.map && CNSUI.map.closePopup) { try { CNSUI.map.closePopup(); } catch (e) {} }
    CNSUI.plan && CNSUI.plan.onFormChange(true);
    if (ap && ap.ident && window.CNSRangeGraph && CNSRangeGraph.show) CNSRangeGraph.show(ap.ident);
  }
  window.setOrigin = ap => { S.origin = ap; afterPick(ap); };
  window.setDest = ap => { S.dest = ap; afterPick(ap); };
  window.setStop = ap => { S.stops.push(ap); afterPick(ap); };
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
    CNSUI.timeline.render(); netCount();
    $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  }
  function setMode(m) {
    S.mode = m; document.body.classList.toggle('net', m === 'network');
    if (m === 'network') CNSUI.map.hideRoute(); else CNSUI.map.showRoute();
    CNSUI.map.drawAlternates();               // the divert overlay follows the route it belongs to
    render(); if (m === 'network') { CNSUI.map.drawNet(); CNSUI.map.fitNet(); }
  }
  // A failed catalog/airport fetch used to leave the rail blank forever with an unhandled
  // rejection; the operator must always see WHY (the classic's form is server-rendered).
  function bootFailed(e) {
    console.error('[v2] boot failed', e);
    try {
      const b = $('#railBody'); if (b) b.innerHTML = `<div class="sec err">The airport database could not be loaded (${esc(e && e.message || e)}). Check the connection and reload.</div>`;
      const f = $('#railFoot'); if (f) f.innerHTML = `<div class="btns"><button class="btn p" onclick="location.reload()">Reload</button></div>`;
      toast('Could not load the airport database');
    } catch (e2) { /* the DOM itself is gone — nothing left to say it in */ }
  }
  async function boot() {
    if (!hasDoc) return;
    try { await _boot(); } catch (e) { bootFailed(e); }
  }
  async function _boot() {
    if (window.CNSChargers) { try { await CNSChargers.load(); (CNSChargers.list() || []).forEach(c => { if (!CHARGERS.find(x => x.id === c.id)) CHARGERS.push(Object.assign({ type: 'Custom', image: '' }, c)); }); } catch (e) { console.warn('[v2] custom chargers unavailable', e); } }
    const [aps, assets] = await Promise.all([fetch('/api/airports').then(r => r.json()), fetch('/api/airport-chargers').then(r => r.json()).catch(() => ({}))]);
    _setAirports(aps); ASSETS = assets || {};
    if (window.CNSScheduler) CNSScheduler.init({ chargers: window.CHARGERS_BY_ID, onChange: () => render() });
    if (window.CNSAnimation) CNSAnimation.init();
    CNSUI.map.init(); if (CNSUI.planner) CNSUI.planner.initMap();
    _applyDefaults(); if (CNSUI.planner) CNSUI.planner.replan();
    render(); CNSUI.map.drawRoute(true); CNSUI.map.drawNet(); CNSUI.map.drawAlternates();
    if (window.CNSUnits && CNSUnits.onChange) CNSUnits.onChange(() => { render(); CNSUI.map.drawRoute(false); });
    if (window.CNSSettings && CNSSettings.subscribe) CNSSettings.subscribe(() => { if (CNSUI.planner) CNSUI.planner.replan(); if (S.result) CNSUI.plan.resimulate(); render(); CNSUI.map.drawRoute(false); if (CNSUI.network) CNSUI.network.recomputeAllDebounced(); });
    if (CNSUI.tour) CNSUI.tour.maybeWelcome(); if (CNSUI.settings) CNSUI.settings.badge();
    if (D.shareState) { try { await CNSUI.share.applyState(D.shareState); } catch (e) { console.warn('[v2] share restore failed', e); toast('This share link could not be opened'); } }
    // deep links kept from the prototype: #result #multi #network (+ :ICAO isolation later)
    const [h, focusAp, view] = location.hash.replace('#', '').split(':');
    if (h === 'multi') { S.dest = AP_BY_ID['EDDM'] || S.dest; S.stops = [AP_BY_ID['EDDF']].filter(Boolean); await CNSUI.plan.simulate(); }
    if (h === 'result') await CNSUI.plan.simulate();
    if (h === 'network') setMode('network');
    if (h === 'big') await CNSUI.network.loadScenario('regional');
    if (h === 'hub') await CNSUI.network.loadScenario('hub');
    if (h === 'training') await CNSUI.network.loadScenario('training');
    if (focusAp && AP_BY_ID[focusAp]) { S.filter = focusAp; S.openAp[focusAp] = true; setMode('network'); }
    if (view === 'fleet') { S.lanes = 'fleet'; $('#drawer').classList.add('open'); CNSUI.timeline.render(); }
    if (h === 'filters') { S.acFilterOpen = true; render(); }
    if (h === 'settings') CNSUI.settings.open();
    if (h === 'welcome') CNSUI.tour.welcome();
    if (h === 'tour') setTimeout(() => CNSUI.tour.start(), 600);
    document.addEventListener('click', e => { const b = e.target.closest('#modeSeg button'); if (b) setMode(b.dataset.mode); });
  }

  return { S, PLANES, CHARGERS, SEED, D, airports: () => AIRPORTS, byId: () => AP_BY_ID, assets: () => ASSETS,
           $, $$, esc, fmt, perDay, planeShort, shortName, plane, charger, ll, chain, toast, search, aircraft,
           planeImg, resolvePlaneId, dispKm, netCount,
           render, setMode, boot, rebuildIndexes, folderChanged, modal, _setAirports, _applyDefaults };
})();
