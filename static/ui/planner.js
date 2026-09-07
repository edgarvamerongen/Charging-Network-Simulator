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
  function terminus() { if (!S.origin || (S.trip !== 'training' && !S.dest)) return null; return { origin: wp(S.origin), dest: wp(S.trip === 'training' ? S.origin : S.dest) }; }
  function ringChain(t) { return isCircular() ? [t.origin, ...S.planned.stops, t.dest, ...S.planned.closing, t.origin] : [t.origin, ...S.planned.stops, t.dest]; }
  function chain() {   // airport records (with latitude_deg) for the map and the rail
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
  function alternatesChain() { const t = terminus(); if (!t || S.trip === 'training') return []; return stampDiverts(ringChain(t).map(n => Object.assign({}, n))); }

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
    const c = ringChain(t);
    for (let i = 0; i < c.length - 1; i++) { const d = R().haversineKm(c[i], c[i + 1]); if (d + altReserveKm(c[i + 1]) > maxLeg) P.legIssues.push(i); }
    if (P.legIssues.length) { const n = P.legIssues.length; P.error = `${n} leg${n > 1 ? 's' : ''} exceed${n > 1 ? '' : 's'} the aircraft's range — add or change a stop.`; }
  }
  function recomputeRoute() {
    const P = S.planned; P.stops = []; P.closing = []; P.error = null; P.legIssues = []; P.source = 'auto';
    if (S.trip === 'training') return;
    const t = terminus(); const p = plane(); if (!t || !p || !R()) { validateRoute(); return; }
    const manual = S.stops.filter(Boolean).map(a => wp(UI.byId()[a.ident] || a));
    P.source = manual.length ? 'user' : 'auto';
    stampDiverts([t.origin, t.dest, ...manual]);
    const chainRes = R().planChain({ origin: t.origin, dest: t.dest, manualStops: manual, plane: p, allowedTypes: allowedTypes(), allAirports: UI.airports(), allowedIdents: plannerAllowedIdents(), blacklist: S.blacklist, maxLegKm: availableRangeKm(p), options: routingOptions() });
    // The ROUTER's message is the truthful one when it could not chain the route at all — the
    // classic shows plannedError (with a remedy) or its hard-fail copy, never the leg-gate line
    // ('add or change a stop' is meaningless when no stop exists that would fix it).
    if (chainRes.error && manual.length === 0) { validateRoute(); P.error = chainRes.error; return; }
    P.stops = chainRes.stops || []; stampDiverts(P.stops);
    if (isCircular()) {
      const used = new Set([t.origin.ident, t.dest.ident, ...P.stops.map(s => s && s.ident)].filter(Boolean));
      const seg = R().planRoute({ origin: t.dest, destination: t.origin, plane: p, allAirports: UI.airports().filter(ap => !used.has(ap.ident) && !S.blacklist.has(ap.ident)), allowedTypes: allowedTypes(), allowedIdents: plannerAllowedIdents(), options: Object.assign({}, routingOptions(), { maxLegKm: availableRangeKm(p) }) });
      if (seg.error) { if (!P.error) P.error = seg.error; } else P.closing = (seg.stops || []).map(s => Object.assign({}, s, { _auto: true }));
    }
    validateRoute();
  }
  const replan = () => recomputeRoute();
  function noRouteRemedy() {
    const enabled = allowedTypes(); const allTypes = ['large_airport', 'medium_airport', 'small_airport']; const disabled = allTypes.filter(x => !enabled.includes(x)); const netOn = S.showAssets;
    const t = terminus(); const p = plane(); if (!t || !p || !R()) return null;
    const maxLeg = availableRangeKm(p); const c = ringChain(t);
    const segments = (S.planned.stops.length || isCircular()) ? S.planned.legIssues.map(i => [c[i], c[i + 1]]) : [[t.origin, t.dest]];
    if (!segments.length) return null;
    const used = new Set(c.map(x => x && x.ident).filter(Boolean)); const filtered = UI.airports().filter(ap => !used.has(ap.ident) && !S.blacklist.has(ap.ident));
    const probe = (types, idents) => segments.every(([a, b]) => { if (!a || !b) return false; const r = R().planRoute({ origin: a, destination: b, plane: p, allAirports: filtered, allowedTypes: types, allowedIdents: idents, options: Object.assign({}, routingOptions(), { maxLegKm: maxLeg }) }); return !r.error; });
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
    if (window.CNSDivertEdit) CNSDivertEdit.init({ map: UI.map.map, airportByIdent: UI.byId(), airports: () => UI.airports(), isSuitable: () => divertSuitable(), onChange: onDivertChange, onDragFeedback: () => {} });
    if (window.CNSRangeGraph) CNSRangeGraph.init({ map: UI.map.map, getReachKm: () => availableRangeKm(plane()) || 0, airports: () => UI.airports(), allowedFor: () => { const types = allowedTypes(); const ids = plannerAllowedIdents(); return ap => types.includes(ap.type) || ids.has(ap.ident); } });
  }
  function altPick(ident) { const full = UI.byId()[ident]; if (!full || !window.CNSDivertEdit) return; CNSDivertEdit.startAltPick({ ident, lat: +full.latitude_deg, lon: +full.longitude_deg }); UI.toast('Click an airport on the map to use it as the divert for ' + ident); }
  function altReset(ident) { delete S.divertOverrides[ident]; replan(); UI.render(); UI.map.drawRoute(false); UI.map.drawAlternates(); }
  function pickPending() { return !!(window.CNSDivertEdit && CNSDivertEdit.pickPending && CNSDivertEdit.pickPending()); }
  function notifyAirportPick(ap) { if (window.CNSDivertEdit && CNSDivertEdit.notifyAirportPick) CNSDivertEdit.notifyAirportPick(ap); }

  UI.planner = { availableRangeKm, availRangeShownKm, terminus, ringChain, chain, validateRoute, recomputeRoute, replan, noRouteRemedy, divertSuitable, divertOverrideKm, stampDiverts, alternatesChain, allowedTypes, plannerAllowedIdents, fullNetworkIdents, routingOptions, initMap, altPick, altReset, pickPending, notifyAirportPick, wp };
})();
