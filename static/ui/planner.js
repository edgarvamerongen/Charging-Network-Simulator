/* CNS v2 — ui/planner.js: suggested-route planner, range gates, divert overrides.
   A port of index.html 2809–3178 (validateRoute / recomputeRoute / smartReplan / _noRouteRemedy)
   with the same function names and the same CNSRouting / CNSSettings / CNSRunway / CNSDivertEdit
   calls; only the DOM reads became state reads. */
(function () {
  const UI = window.CNSUI, S = UI.S;
  Object.assign(S, {
    planned: { stops: [], closing: [], error: null, legIssues: [], source: 'auto' },
    divertOverrides: {}, blacklist: new Set(), bias: 'medium-large-small',
    showAlternates: false, showLabels: true, allowedTypes: ['large_airport', 'medium_airport']
  });
  const R = () => window.CNSRouting, ST = () => window.CNSSettings;
  const wp = a => ({ ident: a.ident, name: a.name, type: a.type, lat: +(a.latitude_deg ?? a.lat), lon: +(a.longitude_deg ?? a.lon), iata_code: a.iata_code || '', alternate_km: a.alternate_km, alternate_ident: a.alternate_ident });
  const plane = () => UI.plane();
  const isCircular = () => S.trip === 'circular';
  const ORDERS = {
    'medium-large-small': { medium_airport: 0, large_airport: 50, small_airport: 150 },
    'large-medium-small': { large_airport: 0, medium_airport: 50, small_airport: 150 },
    'small-medium-large': { small_airport: 0, medium_airport: 50, large_airport: 150 },
    'none': { medium_airport: 0, large_airport: 0, small_airport: 0 }
  };

  // ---- range gates (climb-aware, route factor, SID/STAR pad, per-flight override) ----
  function usableFrac(p) { return (ST() && p) ? ST().usableFraction(p) : 1; }
  function availableRangeKm(p) {
    p = p || plane(); if (!p || !p.range_km) return null;
    const route = ST() ? ST().routingFactor(p) : 1;
    const sid = (ST() && ST().sidStarPaddingKm) ? ST().sidStarPaddingKm(p) : 0;
    const flownMax = (window.CNSFlight && CNSFlight.maxFlownLegKm) ? CNSFlight.maxFlownLegKm(p) : p.range_km * usableFrac(p);
    const base = S.availOverride != null ? S.availOverride : flownMax / route;
    return Math.max(0, base - sid / route);
  }
  function availRangeShownKm(p) { p = p || plane(); const a = availableRangeKm(p); if (a == null) return null; const route = ST() ? ST().routingFactor(p) : 1; const sid = (ST() && ST().sidStarPaddingKm) ? ST().sidStarPaddingKm(p) : 0; return a * route + sid; }

  // ---- terminus + chain ----
  function terminus() { if (!S.origin || S.trip === 'waypoints' || (S.trip !== 'training' && !S.dest)) return null; /* a custom route is never auto-routed */ return { origin: wp(S.origin), dest: wp(S.trip === 'training' ? S.origin : S.dest) }; }
  function ringChain(t) { return isCircular() ? [t.origin, ...S.planned.stops, t.dest, ...S.planned.closing, t.origin] : [t.origin, ...S.planned.stops, t.dest]; }
  function chain() {   // airport records (with latitude_deg) for the map and the rail
    if (S.trip === 'waypoints') return UI.waypoints ? UI.waypoints.chainRecords() : [S.origin].filter(Boolean);
    if (S.trip === 'training') return S.origin ? [S.origin] : [];
    const t = terminus(); if (!t) return [S.origin].filter(Boolean);
    return ringChain(t).map(n => UI.byId()[n.ident] || n);
  }

  // ---- diverts ----
  function divertSuitable() { const p = plane(); const lift = /vtol/i.test(String((p && p.type) || '')); return ap => !!(ap && isFinite(+ap.latitude_deg) && (lift || !window.CNSRunway || (CNSRunway.hasData(ap) && CNSRunway.fits(p, ap)))); }
  function divertOverrideKm(node) {
    const ov = node && node.ident ? S.divertOverrides[node.ident] : null; const alt = ov ? UI.byId()[ov] : null; if (!alt) return null;
    const self = UI.byId()[node.ident] || node; const from = { lat: +(node.lat != null ? node.lat : self.latitude_deg), lon: +(node.lon != null ? node.lon : self.longitude_deg) };
    return R().haversineKm(from, { lat: +alt.latitude_deg, lon: +alt.longitude_deg });
  }
  function stampDiverts(nodes) { (nodes || []).forEach(n => { if (!n || !n.ident) return; const ov = S.divertOverrides[n.ident]; if (ov) { n.divertOverride = ov; const km = divertOverrideKm(n); if (km != null) n.divertOverrideKm = km; } else { delete n.divertOverride; delete n.divertOverrideKm; } }); return nodes; }
  // A return trip lands back at the origin: append it, since the overlay skips the first node (it departs).
  function alternatesChain() { const t = terminus(); if (!t || S.trip === 'training') return []; const c = ringChain(t); if (S.trip === 'retour') c.push(t.origin); return stampDiverts(c.map(n => Object.assign({}, n))); }

  // ---- pools ----
  const allowedTypes = () => S.allowedTypes.slice();
  const fullNetworkIdents = () => new Set(Object.keys(UI.assets() || {}));
  const plannerAllowedIdents = () => S.showAssets ? fullNetworkIdents() : new Set();
  const routingOptions = () => ({ typePenalty: ORDERS[S.bias] || ORDERS['medium-large-small'] });

  // ---- validate / plan ----
  function validateRoute() {
    const P = S.planned; P.legIssues = []; P.error = null;
    const t = terminus(); const p = plane(); if (!t || !p) return;
    const route = ST() ? ST().routingFactor(p) : 1; const maxLeg = availableRangeKm(p);
    const requireAlt = !!(ST() && ST().alternateReserveEnabled && ST().alternateReserveEnabled(p));
    const altReserveKm = w => { if (!requireAlt || !w) return 0; const ovKm = divertOverrideKm(w); if (ovKm != null) return ovKm / route; const full = w.ident ? UI.byId()[w.ident] : null; const km = (full && full.alternate_km != null) ? +full.alternate_km : (+w.alternate_km || 0); return (isFinite(km) ? km : 0) / route; };
    const c = ringChain(t), back = S.trip === 'retour';   // a return trip flies each leg back too, landing at c[i]
    // In the plan's wind a leg needs its air km (routing.js windFactor) + the arrival's divert in the wind ON ITS OWN
    // COURSE, to that airport's alternate (the manual pick, else the catalog's); the worst-case headwind only when the
    // alternate is unknown. A leg that only fails on its divert in this wind says so: change the wind or the divert.
    const ww = ST() && ST().windWorstFactor ? ST().windWorstFactor(+p.speed_kmh || 0) : 1;
    const divertOf = b => { const id = (b && b.ident && S.divertOverrides[b.ident]) || ((b && UI.byId()[b.ident]) || {}).alternate_ident || (b && b.alternate_ident); return id ? UI.byId()[id] : null; };
    const legNeed = (a, b, d) => { const ak = altReserveKm(b), alt = divertOf(b), air = d * R().windFactor(a, b, p);
      const w = alt ? R().divertWindFactor(b, { lat: +alt.latitude_deg, lon: +alt.longitude_deg }, p) : { factor: ww, ok: true };
      return { total: air + (ak > 0 ? ak * w.factor : 0), still: air + ak, ak, alt, w, b }; };
    const windy = [];
    for (let i = 0; i < c.length - 1; i++) { const d = R().haversineKm(c[i], c[i + 1]), out = legNeed(c[i], c[i + 1], d), ret = back ? legNeed(c[i + 1], c[i], d) : null;
      const worst = ret && ret.total > out.total ? ret : out;
      if (worst.total > maxLeg) { P.legIssues.push(i); if (worst.still <= maxLeg && worst.ak > 0 && worst.alt) windy.push(worst); } }
    if (P.legIssues.length) { const n = P.legIssues.length; P.error = windy.length ? divertWindNote(windy[0]) : `${n} leg${n > 1 ? 's' : ''} exceed${n > 1 ? '' : 's'} the aircraft's range. Add or change a stop.`; }
  }
  /** When the router finds no route in wind: would it find one with the diverts flown in still air? Then the wind on
      the diverts is what rules the route out, and the operator should hear that (one extra search, only on failure). */
  function divertWindHint(t, manual, p) {
    const w = (ST() && ST().loadAll) ? ST().loadAll().wind : null;
    if (!w || !w.enabled || !(+w.kt > 0) || !(ST().alternateReserveEnabled && ST().alternateReserveEnabled(p))) return '';
    const r = R().planChain({ origin: t.origin, dest: t.dest, manualStops: manual, plane: p, allowedTypes: allowedTypes(), allAirports: UI.airports(), allowedIdents: plannerAllowedIdents(), blacklist: S.blacklist, maxLegKm: availableRangeKm(p), options: Object.assign(routingOptions(), { bothWays: S.trip === 'retour', divertStillAir: true }) });
    return r && !r.error ? `No route in this wind: it flies in still air, but ${Math.round(+w.kt)} kt from ${String(Math.round(+w.fromDeg) % 360).padStart(3, '0')}° makes the diverts too costly. Change the wind, or pick other diverts (Map › Alternates).` : '';
  }
  /** The notice for a leg that only fails on its divert in the plan's wind. */
  function divertWindNote(x) {
    const w = (ST() && ST().loadAll) ? ST().loadAll().wind : {}, fmt = UI.fmt, wind = `${Math.round(+w.kt || 0)} kt from ${String(Math.round(+w.fromDeg || 0) % 360).padStart(3, '0')}°`;
    const what = x.w.ok ? `needs ${fmt.dist(x.ak * x.w.factor)} of range into the wind (${fmt.dist(x.ak)} in still air)` : `can't be flown: the aircraft can't make headway against it`;
    return `In this wind (${wind}) the divert from ${x.b.ident} to ${x.alt.ident} ${what}. Change the wind, or pick another divert for ${x.b.ident} (Map › Alternates).`;
  }
  function recomputeRoute() {
    const P = S.planned; P.stops = []; P.closing = []; P.error = null; P.legIssues = []; P.source = 'auto';
    if (S.trip === 'training' || S.trip === 'waypoints') return;
    const t = terminus(); const p = plane(); if (!t || !p || !R()) { validateRoute(); return; }
    const manual = S.stops.filter(Boolean).map(a => wp(UI.byId()[a.ident] || a));
    P.source = manual.length ? 'user' : 'auto';
    stampDiverts([t.origin, t.dest, ...manual]);
    const chainRes = R().planChain({ origin: t.origin, dest: t.dest, manualStops: manual, plane: p, allowedTypes: allowedTypes(), allAirports: UI.airports(), allowedIdents: plannerAllowedIdents(), blacklist: S.blacklist, maxLegKm: availableRangeKm(p), options: Object.assign(routingOptions(), { bothWays: S.trip === 'retour' }) });
    // The ROUTER's message is the truthful one when it could not chain the route at all — the
    // classic shows plannedError (with a remedy) or its hard-fail copy, never the leg-gate line
    // ('add or change a stop' is meaningless when no stop exists that would fix it).
    if (chainRes.error && manual.length === 0) { validateRoute(); P.error = divertWindHint(t, manual, p) || chainRes.error; return; }
    P.stops = chainRes.stops || []; stampDiverts(P.stops);
    if (isCircular()) {
      const used = new Set([t.origin.ident, t.dest.ident, ...P.stops.map(s => s && s.ident)].filter(Boolean));
      const seg = R().planRoute({ origin: t.dest, destination: t.origin, plane: p, allAirports: UI.airports().filter(ap => !used.has(ap.ident) && !S.blacklist.has(ap.ident)), allowedTypes: allowedTypes(), allowedIdents: plannerAllowedIdents(), options: Object.assign({}, routingOptions(), { maxLegKm: availableRangeKm(p) }) });
      if (seg.error) { if (!P.error) P.error = seg.error; } else P.closing = (seg.stops || []).map(s => Object.assign({}, s, { _auto: true }));
    }
    validateRoute();
  }
  const replan = () => recomputeRoute();
  // The remedy probes re-search the failing legs with more airport types; every render of the route panel asks, so the
  // answer is kept per route + settings (with small fields across an ocean one probe is a big search).
  const _remedy = new Map();
  function noRouteRemedy() {
    const enabled = allowedTypes(); const allTypes = ['large_airport', 'medium_airport', 'small_airport']; const disabled = allTypes.filter(x => !enabled.includes(x)); const netOn = S.showAssets;
    const t = terminus(); const p = plane(); if (!t || !p || !R()) return null;
    const maxLeg = availableRangeKm(p); const c = ringChain(t);
    const segments = (S.planned.stops.length || isCircular()) ? S.planned.legIssues.map(i => [c[i], c[i + 1]]) : [[t.origin, t.dest]];
    if (!segments.length) return null;
    const key = [segments.map(([a, b]) => (a && a.ident) + '>' + (b && b.ident)).join(','), S.trip, p.id, maxLeg, enabled.join(), netOn, [...S.blacklist].join(), JSON.stringify(ST() ? ST().loadAll() : 0)].join('|');
    if (_remedy.has(key)) return _remedy.get(key);
    const out = remedyFor(segments, c, p, maxLeg, enabled, allTypes, disabled, netOn);
    if (_remedy.size > 200) _remedy.clear(); _remedy.set(key, out); return out;
  }
  function remedyFor(segments, c, p, maxLeg, enabled, allTypes, disabled, netOn) {
    const used = new Set(c.map(x => x && x.ident).filter(Boolean)); const filtered = UI.airports().filter(ap => !used.has(ap.ident) && !S.blacklist.has(ap.ident));
    const probe = (types, idents) => segments.every(([a, b]) => { if (!a || !b) return false; const r = R().planRoute({ origin: a, destination: b, plane: p, allAirports: filtered, allowedTypes: types, allowedIdents: idents, options: Object.assign(routingOptions(), { maxLegKm: maxLeg, bothWays: S.trip === 'retour' }) }); return !r.error; });
    if (disabled.length && probe(allTypes, plannerAllowedIdents())) return 'types';
    if (!netOn && probe(enabled, fullNetworkIdents())) return 'network';
    if (disabled.length && !netOn && probe(allTypes, fullNetworkIdents())) return 'both';
    return null;
  }

  // ---- map hooks: divert editor + reach graph ----
  function onDivertChange(node, ident) { if (ident) S.divertOverrides[node.ident] = ident; else delete S.divertOverrides[node.ident]; replan(); UI.render(); UI.map.drawRoute(false); UI.map.drawAlternates(); }
  function initMap() {
    // divert-edit.js calls these as THUNKS (static/divert-edit.js:88, 95, 154) — the classic passes
    // `airports: () => allAirports, isSuitable: () => _divertSuitable()` (index.html:6616-6620).
    // Passing values instead threw on every drag and made an ALT pick impossible.
    if (window.CNSDivertEdit) CNSDivertEdit.init({ map: UI.map.map, L: UI.G, airportByIdent: UI.byId(), airports: () => UI.airports(), isSuitable: () => divertSuitable(), onChange: onDivertChange });
    if (window.CNSRangeGraph) CNSRangeGraph.init({ map: UI.map.map, L: UI.G, getReachKm: () => availableRangeKm(plane()) || 0, windAt: c => (ST() && ST().windLeg ? ST().windLeg(c, +(plane() || {}).speed_kmh || 0).factor : 1), airports: () => UI.airports(), allowedFor: () => { const types = allowedTypes(); const ids = plannerAllowedIdents(), lands = divertSuitable(); return ap => lands(ap) && (types.includes(ap.type) || ids.has(ap.ident)); } });   // the router's pool: size or network, AND a runway this aircraft can use (as the classic)
  }
  function altPick(ident) { const full = UI.byId()[ident]; if (!full || !window.CNSDivertEdit) return; CNSDivertEdit.startAltPick({ ident, lat: +full.latitude_deg, lon: +full.longitude_deg }); UI.toast('Click an airport on the map to use it as the divert for ' + ident); }
  function altReset(ident) { delete S.divertOverrides[ident]; replan(); UI.render(); UI.map.drawRoute(false); UI.map.drawAlternates(); }
  function pickPending() { return !!(window.CNSDivertEdit && CNSDivertEdit.pickPending && CNSDivertEdit.pickPending()); }
  function notifyAirportPick(ap) { if (window.CNSDivertEdit && CNSDivertEdit.notifyAirportPick) CNSDivertEdit.notifyAirportPick(ap); }

  /** How aircraft `p` would fly the route on the form: { stops } or { none }, from the same chain-build the planner
      runs (memoised: the picker asks for every aircraft at once). null with no route, or for training/circular. */
  const _fit = new Map();
  function fitFor(p) {
    const t = terminus(); if (!t || !p || !R() || S.trip === 'training' || S.trip === 'circular') return null;
    const key = [t.origin.ident, t.dest.ident, S.trip, p.id, S.planeId === p.id ? S.availOverride : '', allowedTypes().join(), S.showAssets, [...S.blacklist].join(), JSON.stringify(ST() ? ST().loadAll() : 0)].join('|');
    if (_fit.has(key)) return _fit.get(key);
    const keep = S.availOverride; if (p.id !== S.planeId) S.availOverride = null;   // a per-flight override belongs to the selected aircraft only
    let out;
    try { const r = R().planChain({ origin: t.origin, dest: t.dest, manualStops: [], plane: p, allowedTypes: allowedTypes(), allAirports: UI.airports(), allowedIdents: plannerAllowedIdents(), blacklist: S.blacklist, maxLegKm: availableRangeKm(p), options: Object.assign(routingOptions(), { bothWays: S.trip === 'retour' }) });
      out = r.error ? { none: true } : { stops: (r.stops || []).length }; }
    finally { S.availOverride = keep; }
    if (_fit.size > 500) _fit.clear(); _fit.set(key, out); return out;
  }

  UI.planner = { fitFor, availableRangeKm, availRangeShownKm, terminus, chain, replan, noRouteRemedy, divertSuitable, alternatesChain, plannerAllowedIdents, routingOptions, initMap, altPick, altReset, pickPending, notifyAirportPick, wp };
})();
