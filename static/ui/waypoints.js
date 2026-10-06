/* CNS v2 — ui/waypoints.js: the Waypoints trip type (custom routes). The operator clicks the map to add turning
   points (platforms, control routes) and picks airports to land and charge at; the route closes back to the
   departure unless "Back to departure" is off, when it must end on an airport. Nothing is auto-routed: a leg
   (landing to landing, through its turning points) too long for the aircraft is drawn red.

   Engine shape: the airports are the landing chain (departure + airport points, closed = circular, open =
   one-way to the last airport) and the turning points between two landings ride on that leg as legVias;
   CNSFlight.simulateTrip flies a leg through them segment by segment. */
(function () {
  const UI = window.CNSUI, S = UI.S, esc = UI.esc, fmt = UI.fmt;
  Object.assign(S, { points: [], wpClosed: true });
  const ACC = '#c4421f', BAD = '#b3261e';

  const node = a => ({ ident: a.ident, name: a.name, lat: +(a.latitude_deg ?? a.lat), lon: +(a.longitude_deg ?? a.lon) });
  const wpName = i => 'WP' + (S.points.slice(0, i + 1).filter(p => p.kind === 'wp').length);

  /** { waypoints, legVias, tripType, closed } for the engine, or { error } when the route can't be flown as set. */
  function model() {
    if (!S.origin) return { error: 'Set a departure airport' };
    if (!S.points.length) return { error: 'Click the map to add a point' };
    const land = [], legVias = []; let cur = [];
    S.points.forEach(p => { if (p.kind === 'ap') { legVias.push(cur); land.push(node(p.ap)); cur = []; } else cur.push({ lat: p.lat, lon: p.lon }); });
    if (S.wpClosed) { legVias.push(cur); return { waypoints: [node(S.origin), ...land], legVias, tripType: 'circular', closed: true }; }
    if (cur.length || !land.length) return { error: 'End on an airport, or fly back to the departure' };
    return { waypoints: [node(S.origin), ...land], legVias, tripType: 'one-way', closed: false };
  }
  /** The engine's profile of the route as drawn (the planner's own charger and charge target). */
  function profile(m) {
    m = m || model(); const p = UI.plane(); if (m.error || !p || !window.CNSFlight) return null;
    return CNSFlight.simulateTrip(p, m.waypoints, { tripType: m.tripType, legVias: m.legVias,
      getTargetSoc: () => (window.CNSDemand && CNSDemand.resolveTargetSoc ? CNSDemand.resolveTargetSoc({}) : null),
      getChargerKw: () => (UI.charger() || {}).power_kw || 0 });
  }
  /** The flown points in order, as airport-like records (map framing, the result's route line). */
  function chainRecords() {
    if (!S.origin) return [];
    const recs = [S.origin, ...S.points.map((p, i) => p.kind === 'ap' ? p.ap : { ident: wpName(i), name: wpName(i), latitude_deg: p.lat, longitude_deg: p.lon, type: 'waypoint' })];
    return S.wpClosed ? [...recs, S.origin] : recs;
  }
  /** A saved custom trip as a [lat, lon] path through its turning points (network map, replay). */
  function tripPath(t) {
    if (!t || !t.custom) return null;
    const land = [{ lat: t.originLat, lon: t.originLon }, ...(t.stops || []), ...(t.destIdent !== t.originIdent ? [{ lat: t.destLat, lon: t.destLon }] : [])];
    if (t.tripType === 'circular') land.push({ lat: t.originLat, lon: t.originLon });
    const out = [];
    land.forEach((n, i) => { if (i) ((t.legVias || [])[i - 1] || []).forEach(v => out.push([+v.lat, +v.lon])); out.push([+n.lat, +n.lon]); });
    return out;
  }

  // ---- editing ----
  const changed = () => UI.plan.onFormChange(false);
  function addPoint(lat, lon) { S.points.push({ kind: 'wp', lat: +lat.toFixed(5), lon: +lon.toFixed(5) }); changed(); }
  function addAirport(ap) { if (!S.origin) { S.origin = ap; changed(); return; } S.points.push({ kind: 'ap', ap }); changed(); }
  function remove(i) { S.points.splice(i, 1); changed(); }

  // ---- the form: points list + "Back to departure" ----
  function formHtml() {
    const m = model(), prof = m.error ? null : profile(m);
    const legOf = []; let leg = 0; S.points.forEach((p, i) => { legOf[i] = leg; if (p.kind === 'ap') leg++; });
    const bad = i => prof && prof.legs[i] && prof.legs[i].overRange;
    const rows = S.points.map((p, i) => `<div class="wpt-row${bad(legOf[i]) ? ' bad' : ''}"><span class="k ${p.kind}">${p.kind === 'ap' ? '<svg class="ic"><use href="#i-plane"/></svg>' : '◆'}</span>
      <span class="n">${p.kind === 'ap' ? esc(p.ap.name) + ' <small>land + charge</small>' : `${wpName(i)} <small class="num">${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? 'E' : 'W'}</small>`}</span>
      <span class="icao">${p.kind === 'ap' ? esc(p.ap.ident) : ''}</span><button class="x" data-act="wpRm" data-i="${i}" title="Remove this point"><svg class="ic"><use href="#i-x"/></svg></button></div>`).join('');
    const legs = prof ? prof.legs : [];
    const sum = prof ? `<div class="route"><div class="rh ${legs.some(l => l.overRange) ? 'bad' : ''}"><span><b>Custom route</b> · ${legs.length} leg${legs.length === 1 ? '' : 's'} · <span class="num">${fmt.dist(prof.totals.distKm)}</span></span><span>${legs.some(l => l.overRange) ? 'a leg is too long for this aircraft' : 'fits the aircraft'}</span></div>
      ${legs.map((l, i) => `<div class="stop ${l.overRange ? 'bad' : ''}"><span class="n num">${String(i + 1).padStart(2, '0')}</span><span>${esc(l.fromIdent)} → ${esc(l.toIdent)}${(m.legVias[i] || []).length ? ` <i class="tt">${m.legVias[i].length} pt</i>` : ''}</span><span class="d num">${fmt.dist(l.distKm)}${l.overRange ? ' <b style="color:var(--danger)">⚠</b>' : ''}</span><span></span></div>`).join('')}</div>` : '';
    return `${rows || '<div class="hint" style="margin:6px 0 0">Click the map to add a turning point; use an airport\'s Stop button to land and charge there.</div>'}
      <label class="wpclose"><input type="checkbox" data-act="wpClosed" ${S.wpClosed ? 'checked' : ''}> Back to departure</label>${m.error && S.points.length ? `<div class="hint" style="color:var(--danger)">${esc(m.error)}</div>` : ''}${sum}`;
  }

  // ---- the map: path, draggable turning points, red legs, labels ----
  let wired = false, lastDot = 0;
  function wire() {
    if (wired || !UI.map.map) return; wired = true;
    UI.map.map.on('click', e => {
      if (S.mode !== 'plan' || S.trip !== 'waypoints' || !S.origin || Date.now() - lastDot < 300) return;
      if (UI.planner && UI.planner.pickPending && UI.planner.pickPending()) return;
      addPoint(e.latlng.lat, e.latlng.lng);
    });
  }
  function draw(layer, fit) {
    wire(); if (!S.origin) return;
    const L = UI.G, m = model(), prof = m.error ? null : profile(m), map = UI.map.map, ll = a => [+(a.latitude_deg ?? a.lat), +(a.longitude_deg ?? a.lon)];
    const arc = UI.map.arcPath || (pts => pts);
    // legs: landing to landing through its turning points; a red, dashed leg is too long for the aircraft
    const land = m.error ? null : [m.waypoints[0], ...m.waypoints.slice(1), ...(m.closed ? [m.waypoints[0]] : [])];
    const legPaths = land ? land.slice(1).map((b, i) => [ll(land[i]), ...(m.legVias[i] || []).map(ll), ll(b)]) : [chainRecords().map(ll)];
    legPaths.forEach((pts, i) => { const bad = !!(prof && prof.legs[i] && prof.legs[i].overRange), path = arc(pts);
      layer.addLayer(L.polyline(path, { pane: 'rt', interactive: false, color: '#fff', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round' }));
      layer.addLayer(L.polyline(path, { pane: 'rt', interactive: false, color: bad ? BAD : ACC, weight: bad ? 3 : 2, opacity: 1, dashArray: bad ? '7 6' : null, lineCap: 'round', lineJoin: 'round' }));
      layer.addLayer(L.polyline(arc(pts.slice(-2)), { pane: 'rt', interactive: false, opacity: 0, arrowEnd: true }));   // the arrowhead where it arrives
      const l = prof && prof.legs[i]; if (!S.showLabels || !l) return;
      const mid = pts[Math.floor((pts.length - 1) / 2)], nxt = pts[Math.floor((pts.length - 1) / 2) + 1], at = [(mid[0] + nxt[0]) / 2, (mid[1] + nxt[1]) / 2];
      layer.addLayer(L.marker(at, { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="leglbl num${bad ? ' bad' : ''}">${bad ? 'Too long · ' : ''}${fmt.dist(l.distKm)} · ${fmt.min(l.flightMin)} · ${fmt.r(l.energyKwh)} kWh</div>` }) })); });
    // the departure, airport stops and draggable turning points
    layer.addLayer(L.marker(ll(S.origin), { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: '<div class="ep"></div>', iconSize: [11, 11], iconAnchor: [5.5, 5.5] }) }));
    S.points.forEach((p, i) => {
      if (p.kind === 'ap') { layer.addLayer(L.marker(ll(p.ap), { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: '<div class="ep stop"></div>', iconSize: [11, 11], iconAnchor: [5.5, 5.5] }) })); return; }
      const mk = L.marker([p.lat, p.lon], { pane: 'pins', draggable: true, title: wpName(i) + ': drag to move', icon: L.divIcon({ className: '', html: `<div class="wpt-mk"><span>${wpName(i)}</span></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }) });
      mk.on('dragend', ev => { const q = ev.target.getLatLng(); S.points[i] = { kind: 'wp', lat: +q.lat.toFixed(5), lon: +q.lng.toFixed(5) }; changed(); });
      layer.addLayer(mk); });
    if (fit && map) { const b = L.latLngBounds(chainRecords().map(ll)); if (b.isValid()) map.fitBounds(b, { paddingTopLeft: [460, 60], paddingBottomRight: [40, 120], maxZoom: 9 }); }
  }

  // ---- simulate: the engine is the whole calculation (the server model has no turning points) ----
  function simulate() {
    const m = model();
    if (m.error) { S.err = m.error; S.result = null; S.profile = null; S.rail = 'form'; UI.render(); return; }
    const prof = profile(m), p = UI.plane(), ch = UI.charger(), T = prof.totals, last = m.waypoints[m.waypoints.length - 1];
    const stops = (m.closed ? m.waypoints.slice(1, -1) : m.waypoints.slice(1, -1)).map(n => Object.assign({ _manual: true }, n));
    const dest = m.closed ? (m.waypoints.length > 1 ? last : m.waypoints[0]) : last;
    S.result = {
      trip_type: m.tripType, plane: { name: p.name, id: p.id, svg: p.svg, battery_kwh: p.battery_kwh, range_km: p.range_km, speed_kmh: p.speed_kmh },
      charger: { id: ch.id, name: ch.name, power_kw: ch.power_kw }, leg_energy_kwh: (prof.legs[0] || {}).energyKwh || 0,
      multi_leg: m.closed || stops.length > 0, stops, flight_time_h: T.flightMin / 60, total_flight_time_h: T.flightMin / 60, total_distance_km: T.distKm,
      recharge_energy_kwh: T.gridKwh, total_recharge_energy_kwh: T.gridKwh, total_charge_time_min: T.chargeMin,
      legs: prof.legs.map(l => ({ from: { name: l.fromName, ident: l.fromIdent }, to: { name: l.toName, ident: l.toIdent }, distance_km: l.distKm, flight_time_h: l.flightMin / 60, energy_kwh: l.energyKwh })),
      charges: prof.charges.map(c => ({ ident: c.ident, name: c.name, lat: c.lat, lon: c.lon, role: c.role, at_index: c.atIndex, energy_kwh: c.energyKwh })),
      _origin: node(S.origin), _dest: dest, _wps: m.waypoints, _legVias: m.legVias,
      _custom: { legVias: m.legVias, closed: m.closed, points: S.points.map(q => q.kind === 'ap' ? { kind: 'ap', ident: q.ap.ident } : q) },
      _chargerId: S.chargerId, _freqN: Math.max(1, Math.min(2000, S.freq)), _freqUnit: S.per,
    };
    S.profile = prof; S.err = ''; S.rail = 'result'; S.open = { route: true, charging: false, calc: false };
    UI.render(); UI.map.drawRoute(false);
  }
  /** Back from a saved custom trip (Plan › edit a network route). */
  function restore(t) {
    const by = UI.byId(); S.wpClosed = t.closed !== false;
    S.points = ((t.customPoints || [])).map(q => q.kind === 'ap' ? (by[q.ident] ? { kind: 'ap', ap: by[q.ident] } : null) : { kind: 'wp', lat: +q.lat, lon: +q.lon }).filter(Boolean);
  }

  document.addEventListener('click', e => { const t = e.target.closest('[data-act=wpRm]'); if (t) remove(+t.dataset.i); });
  document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.act === 'wpClosed') { S.wpClosed = e.target.checked; changed(); } });

  UI.waypoints = { model, profile, chainRecords, tripPath, formHtml, draw, simulate, restore, addPoint, addAirport, noteDotClick: () => { lastDot = Date.now(); } };
})();
