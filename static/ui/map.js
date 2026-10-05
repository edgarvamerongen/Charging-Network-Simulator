/* CNS v2 — ui/map.js: Leaflet map + furniture in the Instrument language. */
(function () {
  const UI = window.CNSUI, S = UI.S;
  let map, BASES, dots = {}, assetLayer, routeLayer, netLayer, dotRenderer, hiLayer;
  // Dot geometry mirrors the classic (index.html:4318-4335): the size encodes the airport
  // class and the radii are the CLICK targets — halving them halves the hit test.
  const DOT = { large_airport: { r: 6.5, o: .55 }, medium_airport: { r: 4.2, o: .5 }, small_airport: { r: 3.1, o: .35 } };
  // Continental zoom reads as a field of small dots; zoomed in (z ≥ 8) they carry their
  // full, clickable size — the classic's _dotScale.
  const dotScale = () => { const z = map.getZoom(); return z >= 8 ? .9 : z >= 6 ? .7 : .5; };
  function rescaleDots() { const s = dotScale(); Object.values(dots).forEach(g => g.eachLayer(m => { if (m._dotR) m.setRadius(m._dotR * s); })); }
  function popupHtml(a) {
    const rw = a.rwy_paved_m || a.rwy_grass_m || a.rwy_unknown_m; const p = UI.plane();
    const fit = (window.CNSRunway && CNSRunway.suitability && p) ? CNSRunway.suitability(p, a) : null;
    const nm = UI.esc(UI.planeShort(p ? p.name : '')), need = fit && /need (.+)$/.exec(fit.label || '');
    const fitTxt = !fit ? '' : fit.state === 'ok' ? `Runway suits the ${nm}` : fit.state === 'unknown' ? `Runway fit for the ${nm}: no data`
      : fit.state === 'short' ? `Runway too short for the ${nm}${need ? ' (needs ' + UI.esc(need[1]) + ')' : ''}` : `No suitable runway for the ${nm}`;
    const fitHtml = fit ? `<div class="m ${fit.state === 'ok' || fit.state === 'unknown' ? '' : 'bad'}">${fitTxt}</div>` : '';
    return `<div class="pp"><img class="pp-photo" src="/api/airport-photo/${encodeURIComponent(a.ident)}" alt="" onerror="this.remove()"><div class="t"><span>${UI.esc(a.name)}</span><span class="ic2">${UI.esc(a.ident)}${a.iata_code ? ' · ' + UI.esc(a.iata_code) : ''}</span></div>
      <div class="m">${UI.esc(a.municipality || '')}${a.municipality ? ' · ' : ''}${UI.esc((a.type || '').replace('_', ' '))}${rw ? ' · runway ' + Math.round(rw) + ' m' : ' · no runway data'}</div>${fitHtml}
      <div class="acts"><button onclick="setOrigin(airportByIdent['${UI.esc(a.ident)}']);CNSUI.map.closePopup()">Departure</button><button onclick="setDest(airportByIdent['${UI.esc(a.ident)}']);CNSUI.map.closePopup()">Destination</button><button onclick="setStop(airportByIdent['${UI.esc(a.ident)}']);CNSUI.map.closePopup()">Stop</button></div></div>`;
  }
  function init() {
    // NO preferCanvas: it gives every custom pane its OWN full-size <canvas>, and a canvas
    // swallows every pointer event over its whole box — the rt (400) and net (380) canvases
    // then covered the dots (350) and the airport dots became unclickable. Like the classic
    // (index.html:2486, 4310) the dots get ONE shared canvas renderer and everything else
    // draws as SVG, whose root Leaflet marks pointer-events:none — it can never cover a dot.
    map = L.map('map', { zoomControl: false, zoomSnap: .25 }).setView([51.6, 6.5], 6.25);
    // The arrowhead a one-way leg ends in, just short of the airport it flies to: an SVG line-end marker, so it keeps
    // its size and the leg's heading at every zoom and never sits under the leg label (mid-leg).
    document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><marker id="cnsDir" viewBox="0 0 14 12" markerWidth="14" markerHeight="12" refX="21" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M2 2 12 6 2 10Z" fill="#c4421f" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></marker></defs></svg>');
    map.attributionControl.setPosition('bottomleft');   // bottom-right sat under the timeline bar; the tile terms want it visible
    // M2: one control (and the F key) frames the route in Plan mode, the network in Network mode.
    const FitCtl = L.Control.extend({ options: { position: 'topright' }, onAdd() {
      const b = L.DomUtil.create('button', 'map-fit'); b.type = 'button'; b.title = 'Fit the map to the route or network (F)'; b.setAttribute('aria-label', 'Fit the map to the route or network');
      b.innerHTML = '<svg class="ic"><use href="#i-fit"/></svg>Fit<kbd>F</kbd>';
      L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b, 'click', e => { L.DomEvent.stop(e); fit(); }); return b; } });
    new FitCtl().addTo(map);
    const key = (UI.D && UI.D.cartoKeyQs) || '';
    BASES = {
      light: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Esri, HERE, Garmin, © OSM' }),
      street: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png' + key, { maxZoom: 19, attribution: '© OSM © CARTO' }),
      sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Esri, Maxar, Earthstar' })
    };
    BASES[S.base] ? BASES[S.base].addTo(map) : BASES.light.addTo(map);
    map.createPane('dots').style.zIndex = 350; map.createPane('net').style.zIndex = 380; map.createPane('rt').style.zIndex = 400; map.createPane('pins').style.zIndex = 450;
    // One shared canvas for ~7,800 dots (SVG would crawl); tolerance widens the hit test the
    // way the classic's white stroke does (Leaflet adds weight/2 + renderer tolerance).
    dotRenderer = L.canvas({ pane: 'dots', padding: 0.4, tolerance: 3 });
    ['large_airport', 'medium_airport', 'small_airport'].forEach(t => dots[t] = L.layerGroup()); assetLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup().addTo(map); netLayer = L.layerGroup().addTo(map);
    hiLayer = L.layerGroup().addTo(map);   // the open airport's ring — ties the expanded ledger row to the map
    map.on('zoomend', () => { rescaleDots(); applyVisibility(); if (S.mode === 'network') drawNet(); });   // network labels are placed in screen space
    drawAirports(); drawAssets();
  }
  function drawAirports() {
    Object.values(dots).forEach(g => g.clearLayers());
    const s = dotScale();
    UI.airports().forEach(a => { const d = DOT[a.type] || DOT.small_airport;
      const m = L.circleMarker(UI.ll(a), { renderer: dotRenderer, pane: 'dots', radius: d.r * s, fillColor: '#4a4d6e', fillOpacity: d.o, color: '#fff', weight: 1.25, opacity: .45 });
      m._dotR = d.r;   // base radius — rescaled on zoom by rescaleDots()
      m.bindPopup(() => popupHtml(a), { offset: [0, -2] });
      m.on('click', () => { if (UI.waypoints) UI.waypoints.noteDotClick(); if (UI.planner && UI.planner.pickPending()) { UI.planner.notifyAirportPick(a); map.closePopup(); } });
      (dots[a.type] || dots.small_airport).addLayer(m); });
    applyVisibility();
  }
  // Size filters drive both the dots and the planner's stop pool (as in the classic); small
  // airfields additionally wait for zoom ≥ 7.5 so 6,000 canvas dots don't blanket the continent.
  function applyVisibility() {
    const z = map.getZoom();
    Object.entries(dots).forEach(([t, g]) => { const want = S.allowedTypes.includes(t) && (t !== 'small_airport' || z >= 7.5); if (want && !map.hasLayer(g)) g.addTo(map); if (!want && map.hasLayer(g)) map.removeLayer(g); });
  }
  function drawAlternates() { if (!window.CNSDivertEdit || !UI.planner) return; if (S.showAlternates && S.mode === 'plan') CNSDivertEdit.render(UI.planner.alternatesChain()); else CNSDivertEdit.clear(); }
  function drawAssets() {
    assetLayer.clearLayers(); if (!S.showAssets) return;
    Object.values(UI.assets()).forEach(x => { const a = UI.byId()[x.icao]; if (!a) return;
      const construction = x.status === 'construction';
      // The teardrop stands ABOVE its airport (anchor at the tail's tip), so the airfield dot under it stays clickable.
      const m = L.marker(UI.ll(a), { pane: 'pins', title: x.name, icon: L.divIcon({ className: '', html: `<div class="nrg-pin${construction ? ' construction' : ''}"><div class="head"><img src="/pics/logos/NRG2fly_icon_circle_inv.png" alt=""></div><div class="tail"></div></div>`, iconSize: [0, 0], iconAnchor: [0, 0] }) });
      m.bindPopup(`<div class="pp"><div class="t"><span>${UI.esc(x.name)}</span><span class="ic2">${UI.esc(x.icao)}</span></div><div class="m">${UI.esc(x.network || 'NRG2FLY')} charging${construction ? ' · under construction' : ''} · ${(x.plugs || []).length} plug${(x.plugs || []).length === 1 ? '' : 's'}</div>
        <div class="plugs">${(x.plugs || []).map(p => `<div><span>${UI.esc(p.label)} · ${UI.esc(p.connector)}</span><b class="num">${p.power_kw} kW</b></div>`).join('')}</div></div>`);
      assetLayer.addLayer(m); });
  }
  // Distance to SHOW on a leg label: the ROUTED leg (great-circle × routing padding) + the
  // fixed SID/STAR pad, i.e. the classic's _dispKm (index.html:4596-4601) and the same number
  // the result table prints — a raw great-circle here reads as a second, contradicting distance.
  // One implementation, in the shell (app.js:70); this only adapts [lat, lon] pairs to it.
  const dispKm = (a, b) => UI.dispKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
  /** Great-circle arc between two [lat, lon] points (spherical interpolation, n+1 points). */
  function arc(a, b, n) {
    const R = Math.PI / 180, la1 = a[0] * R, lo1 = a[1] * R, la2 = b[0] * R, lo2 = b[1] * R;
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    if (!(d > 1e-9)) return [a, b];
    n = n || Math.max(8, Math.min(64, Math.round(d * 6371 / 25)));   // one point per ~25 km, 8..64
    const out = [];
    for (let i = 0; i <= n; i++) { const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2), y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2), z = A * Math.sin(la1) + B * Math.sin(la2);
      out.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / R, Math.atan2(y, x) / R]); }
    return out;
  }
  const arcPath = pts => { const o = []; for (let i = 0; i < pts.length - 1; i++) { const seg = arc(pts[i], pts[i + 1]); o.push(...(i ? seg.slice(1) : seg)); } return o; };
  const arcMid = (a, b) => arc(a, b, 2)[1];
  /** Initial great-circle TRUE course a → b in whole degrees, printed as charts do (001–360°). */
  const trk = (a, b) => { const R = Math.PI / 180, la1 = a[0] * R, la2 = b[0] * R, dl = (b[1] - a[1]) * R;
    const c = Math.round(Math.atan2(Math.sin(dl) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)) / R + 360) % 360;
    return String(c || 360).padStart(3, '0') + '°'; };
  /** Bottom padding so a fit never hides behind the timeline drawer (open: its height; closed: its bar). */
  function drawerPad() {
    const d = document.getElementById('drawer'); if (!d) return 80;
    /* While the drawer is still sliding open its rect lags; --drawer-h is the height the timeline set,
       so a fit that follows an open never lands a network behind the drawer. */
    const r = d.getBoundingClientRect(); let h = window.innerHeight - r.top;
    if (d.classList.contains('open')) { const t = parseFloat(getComputedStyle(d).getPropertyValue('--drawer-h')); if (t > h) h = t + Math.max(0, window.innerHeight - r.bottom); }
    return Math.max(80, Math.round(h) + 24);
  }
  // The part of the map nothing covers. Floating shell: the rail (420 px + margins) on the left and the
  // timeline drawer at the bottom sit ON the map. Docked prototype (?proto): they sit beside it, so the
  // whole map container is free and a fit only needs air.
  const docked = () => document.body.classList.contains('proto');
  const pads = () => docked() ? { paddingTopLeft: [48, 48], paddingBottomRight: [48, 48] } : { paddingTopLeft: [460, 60], paddingBottomRight: [40, drawerPad()] };
  function inFree(latlngs) {
    const size = map.getSize(), left = docked() ? 12 : 444, bottom = docked() ? size.y - 12 : size.y - drawerPad() + 24;   // drawerPad() adds 24 px of air
    return latlngs.every(ll => { const pt = map.latLngToContainerPoint(ll); return pt.x >= left && pt.x <= size.x - 12 && pt.y >= 12 && pt.y <= bottom; });
  }
  function drawRoute(fit) {
    routeLayer.clearLayers(); const c = UI.chain();
    if (S.trip === 'waypoints' && UI.waypoints) { UI.waypoints.draw(routeLayer, fit); return; }   // custom route: its own drawing
    if (S.trip === 'training' && S.origin) { const p = UI.plane(); const r = ((p.training_range_km || 60) / 2) * 1000; routeLayer.addLayer(L.circle(UI.ll(S.origin), { pane: 'rt', interactive: false, radius: r, color: '#c4421f', weight: 2, fillColor: '#c4421f', fillOpacity: .06, dashArray: '4 6' })); if (fit) fitRoute(false); return; }
    if (c.length < 2) return;
    const pts = c.map(UI.ll); const path = arcPath(pts);
    routeLayer.addLayer(L.polyline(path, { pane: 'rt', interactive: false, color: '#fff', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round' }));
    routeLayer.addLayer(L.polyline(path, { pane: 'rt', interactive: false, color: '#c4421f', weight: 2, opacity: 1, lineCap: 'round', lineJoin: 'round' }));
    c.forEach((a, i) => { const stop = i > 0 && i < c.length - 1; routeLayer.addLayer(L.marker(UI.ll(a), { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="ep${stop ? ' stop' : ''}"></div>`, iconSize: [11, 11], iconAnchor: [5.5, 5.5] }) })); });
    const legs = UI.plan && UI.plan.legsForMap ? UI.plan.legsForMap() : null;
    // Charted as ICAO Annex 4 draws routes: a leg flown one way carries an arrowhead in the direction of flight; a
    // return flies every leg both ways, a two-way route, so no arrow and the track in both directions on its label.
    const back = S.trip === 'retour';
    for (let i = 0; i < pts.length - 1; i++) {
      if (!back) { const leg = L.polyline(arc(pts[i], pts[i + 1]), { pane: 'rt', interactive: false, opacity: 0 });   // carries the arrowhead where it arrives (#cnsDir)
        leg.on('add', () => leg._path.setAttribute('marker-end', 'url(#cnsDir)')); routeLayer.addLayer(leg); }
      if (!S.showLabels) continue;
      const mid = arcMid(pts[i], pts[i + 1]); /* on the arc, not the chord */ let txt = UI.fmt.dist(dispKm(pts[i], pts[i + 1]));
      if (legs && legs[i]) txt = `${UI.fmt.dist(legs[i].distKm)} · ${UI.fmt.min(legs[i].flightMin)} · ${UI.fmt.r(legs[i].energyKwh)} kWh`;
      if (S.showTracks) txt = `${trk(pts[i], pts[i + 1])}${back ? '/' + trk(pts[i + 1], pts[i]) : ''}T · ${txt}`;   // Map › Tracks, off by default
      routeLayer.addLayer(L.marker(mid, { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="leglbl num">${txt}</div>`, iconSize: [0, 0] }) })); }
    if (fit) fitRoute(false);
  }
  /** Frame the plan route (a training flight: its circuit area) into the map the rail and the timeline leave free. */
  function fitRoute(animate) {
    const c = UI.chain(); if (!c.length) return;
    const pad = Object.assign(pads(), { animate: !!animate });
    if (S.trip === 'training' && S.origin) { const r = ((UI.plane().training_range_km || 60) / 2) * 1000; map.fitBounds(L.latLng(UI.ll(S.origin)).toBounds(r * 2.6), pad); return; }
    if (c.length < 2) { map.panTo(UI.ll(c[0]), { animate: !!animate }); return; }
    map.fitBounds(L.latLngBounds(arcPath(c.map(UI.ll))), Object.assign({ maxZoom: 9 }, pad));
  }
  /** Every airport of the plan chain inside the free map: right of the rail, above the timeline, on screen. */
  function routeInView() { const c = UI.chain(); return !c.length || inFree(c.map(UI.ll)); }
  function ensureRouteVisible() { if (!routeInView()) fitRoute(true); }
  /** Every airport of the network (or of the isolated airport's routes) inside the free map. */
  function netInView() { const pts = []; netLayer.eachLayer(l => { if (l.getLatLngs && (!S.filter || l.options.opacity > .5)) pts.push(...l.getLatLngs()); }); return !pts.length || inFree(pts); }   // every arc point: a return route starts AND ends at its base
  /** After a layout change (the docked timeline opening, closing or resizing): re-frame only what fell out of view. */
  function ensureVisible() { if (S.mode === 'network') { if (!netInView()) fitNet(); } else ensureRouteVisible(); }
  function fit() { if (S.mode === 'network') fitNet(); else fitRoute(true); }
  if (typeof document !== 'undefined') document.addEventListener('keydown', e => {
    if ((e.key !== 'f' && e.key !== 'F') || e.metaKey || e.ctrlKey || e.altKey || !map) return;
    if (e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
    if (!document.getElementById('modal').hidden || !document.getElementById('cmdk').hidden) return;
    e.preventDefault(); fit();
  });
  /** The network on the map. In Network mode it encodes the network (audit P5): a route is as wide as it
      is busy and every network airport is an ink disc sized by its flights per day, with its ICAO code;
      the airports around it fade (CSS). In Plan mode the routes stay a thin backdrop. */
  function drawNet() {
    netLayer.clearLayers(); if (!S.showNet || !window.CNSDemand) return;
    const net = S.mode === 'network', perAp = {}, lit = new Set();
    // An isolated airport lights its routes; Plan mode with no route drawn lights nothing (a reset plan is a clean slate).
    // ONE selected airport: the isolated one, else the open ledger row. It gets the ring, its network lights up.
    const sel = S.filter || Object.keys(S.openAp).find(k => S.openAp[k]) || '';
    const fl = net ? sel : UI.chain().length > 1 ? S.filter : '';
    CNSDemand.loadFolder().forEach(t => { const cp = UI.waypoints && UI.waypoints.tripPath(t);   // a custom route: through its turning points
      const pts = cp || [[t.originLat, t.originLon], ...(t.stops || []).map(s => [s.lat, s.lon]), [t.destLat, t.destLon]].filter(p => p[0] != null && p[1] != null);
      if (!cp && t.tripType === 'circular') pts.push([t.originLat, t.originLon]);   // a ring closes home; a return flies its stops back, the line it already has
      if (pts.length < 2) return; const idents = [t.originIdent, ...(t.stops || []).map(s => s.ident), t.destIdent].filter(Boolean);
      const hit = !fl || idents.includes(fl), f = CNSDemand.flightsPerDay ? CNSDemand.flightsPerDay(t) : 1;
      idents.forEach(id => { perAp[id] = (perAp[id] || 0) + f; if (hit) lit.add(id); });
      const w = net ? Math.min(6, 1 + 1.1 * Math.sqrt(f)) : 1.5;
      netLayer.addLayer(L.polyline(arcPath(pts), { pane: 'net', interactive: false, color: '#32326E', weight: hit && fl ? w + .5 : w, opacity: fl ? (hit ? .8 : .12) : (net ? .55 : .45), lineCap: 'round' })); });
    highlightAirports(net && sel ? [sel] : []);
    if (!net) return;
    const isolate = id => { S.filter = S.filter === id ? '' : id; if (S.filter) S.openAp = { [id]: true }; UI.render(); drawNet(); fitNet(); };
    const aps = Object.entries(perAp).map(([id, f]) => ({ id, f, a: UI.byId()[id] })).filter(x => x.a).sort((x, y) => y.f - x.f);
    // Labels never cover one another or another airport's disc (a click must reach the airport it names): the
    // busiest airports label first, a label that would collide goes to the other side of its disc, else it is
    // left out and the disc's tooltip names the airport. Placed in screen space, so zoomend re-runs this.
    const taken = [], clear = b => !taken.some(q => b[0] < q[2] && q[0] < b[2] && b[1] < q[3] && q[1] < b[3]);
    aps.forEach(x => { x.r = 5;   /* one size: a route's width carries its traffic */ x.pt = map.latLngToContainerPoint(UI.ll(x.a)); taken.push([x.pt.x - x.r, x.pt.y - x.r, x.pt.x + x.r, x.pt.y + x.r]); });
    aps.forEach(x => { const w = 7 * x.id.length + 8, R = [x.pt.x + x.r + 3, x.pt.y - 8, x.pt.x + x.r + 3 + w, x.pt.y + 8], Lb = [x.pt.x - x.r - 3 - w, x.pt.y - 8, x.pt.x - x.r - 3, x.pt.y + 8];
      x.side = clear(R) ? 'left' : clear(Lb) ? 'right' : null; if (x.side) taken.push(x.side === 'left' ? R : Lb); });
    aps.forEach(({ id, a, r, side }) => { const on = !!fl && lit.has(id), tip = S.filter === id ? 'Show all airports' : 'Show ' + id + ' in the network';
      netLayer.addLayer(L.circleMarker(UI.ll(a), { pane: 'net', radius: r, fillColor: '#32326E', fillOpacity: on ? .9 : .25, color: '#fff', weight: 1.5, opacity: on ? 1 : .4, bubblingMouseEvents: false }).on('click', () => isolate(id)).bindTooltip(side ? tip : id + ': ' + tip.toLowerCase(), { direction: 'top', offset: [0, -r] }));
      if (side) netLayer.addLayer(L.marker(UI.ll(a), { pane: 'pins', keyboard: false, title: tip, icon: L.divIcon({ className: '', html: `<div class="netlbl${on ? '' : ' dim'}" style="${side}:${Math.round(r + 3)}px">${UI.esc(id)}</div>`, iconSize: [0, 0] }) }).on('click', () => isolate(id))); });
  }
  function highlightAirports(idents) {
    if (!hiLayer) return;
    hiLayer.clearLayers();
    const by = UI.byId(); const s = dotScale();
    (idents || []).forEach(id => { const a = by[id]; if (!a) return;
      hiLayer.addLayer(L.circleMarker(UI.ll(a), { pane: 'rt', interactive: false, radius: Math.max(11, 12 * s), fillColor: '#32326E', fillOpacity: .10, color: '#32326E', weight: 2, opacity: .95 }));
    });
  }
  // The rail (420 px + margins) on the left and the timeline drawer at the bottom are both kept clear.
  function fitNet() { const pts = []; netLayer.eachLayer(l => { if (l.getLatLngs) pts.push(...l.getLatLngs()); }); if (pts.length) map.fitBounds(L.latLngBounds(pts), Object.assign(pads(), { maxZoom: 8, animate: false })); }
  function setBase(n) { Object.values(BASES).forEach(b => map.removeLayer(b)); (BASES[n] || BASES.light).addTo(map); S.base = n; }
  function flyTo(a) { map.flyTo(UI.ll(a), Math.max(map.getZoom(), 8)); setTimeout(() => L.popup({ offset: [0, -2] }).setLatLng(UI.ll(a)).setContent(popupHtml(a)).openOn(map), 400); }
  // The divert overlay belongs to the route: it hides and returns WITH it, so Network mode
  // never carries the alternates of a route it does not draw (drawAlternates() reads S.mode,
  // which setMode has already flipped by the time it hides/shows the route layer).
  function hideRoute() { if (map.hasLayer(routeLayer)) map.removeLayer(routeLayer); drawAlternates(); }
  function showRoute() { if (!map.hasLayer(routeLayer)) routeLayer.addTo(map); drawAlternates(); }
  UI.map = { arcPath, init, drawAssets, drawRoute, drawNet, fitNet, fitRoute, fit, routeInView, ensureRouteVisible, ensureVisible, setBase, flyTo, applyVisibility, drawAlternates, highlightAirports,
             closePopup: () => map.closePopup(), hideRoute, showRoute, get map() { return map; } };
})();
