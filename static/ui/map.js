/* CNS v2 — ui/map.js: the map + furniture in the Instrument language. MapLibre GL (a globe when zoomed out)
   behind ui/gl.js, which speaks the bit of Leaflet this file draws with (L = CNSGL.L; zooms are Leaflet's). */
(function () {
  const UI = window.CNSUI, S = UI.S, L = window.CNSGL.L;
  UI.G = L;   // the drawing API for the other v2 modules (waypoints, range graph, alternates editor)
  let map, assetLayer, routeLayer, netLayer, hiLayer;
  const TYPE_IDX = { small_airport: 0, medium_airport: 1, large_airport: 2 };
  // Dot geometry mirrors the classic (index.html:4318-4335): the size encodes the airport
  // class and the radii are the CLICK targets — halving them halves the hit test.
  const DOT = { large_airport: { r: 6.5, o: .55 }, medium_airport: { r: 4.2, o: .5 }, small_airport: { r: 3.1, o: .35 } };
  // Continental zoom reads as a field of small dots; zoomed in (z ≥ 8) they carry their
  // full, clickable size — the classic's _dotScale.
  const dotScale = () => { const z = map.getZoom(); return z >= 8 ? .9 : z >= 6 ? .7 : .5; };
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
    if (!window.CNSGL.supported() || !window.maplibregl) {   // no WebGL: say so where the map would be; the rail keeps working
      const el = document.getElementById('map'); if (el) el.innerHTML = '<div class="map-nogl">The map needs WebGL, which this browser has switched off or does not support. Planning, the network and the reports still work.</div>';
      return;
    }
    map = window.CNSGL.map('map', { center: [51.6, 6.5], zoom: 6.25, globe: S.globe !== false });
    // M2: one control (and the F key) frames the route in Plan mode, the network in Network mode.
    map.ml.addControl({ onAdd() { const b = document.createElement('button'); b.type = 'button'; b.className = 'map-fit'; b.title = 'Fit the map to the route or network (F)'; b.setAttribute('aria-label', 'Fit the map to the route or network');
      b.innerHTML = '<svg class="ic"><use href="#i-fit"/></svg>Fit<kbd>F</kbd>'; b.addEventListener('click', e => { e.stopPropagation(); fit(); }); const w = document.createElement('div'); w.className = 'maplibregl-ctrl'; w.appendChild(b); return w; }, onRemove() {} }, 'top-right');
    map.createPane('dots').style.zIndex = 350; map.createPane('net').style.zIndex = 380; map.createPane('rt').style.zIndex = 400; map.createPane('pins').style.zIndex = 450;
    assetLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup().addTo(map); netLayer = L.layerGroup().addTo(map);
    hiLayer = L.layerGroup().addTo(map);   // the open airport's ring — ties the expanded ledger row to the map
    map.on('zoomend', () => { if (S.mode === 'network') drawNet(); });   // network labels are placed in screen space
    map.whenReady(() => { addBases(); drawAirports(); });
    drawAssets();
  }
  const key = () => (UI.D && UI.D.cartoKeyQs) || '';
  const BASE_DEF = {
    light: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'], maxzoom: 16, attribution: 'Esri, HERE, Garmin, © OSM' },
    street: { tiles: ['a', 'b', 'c', 'd'].map(s => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`), maxzoom: 19, attribution: '© OSM © CARTO', keyed: true },
    sat: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 18, attribution: 'Esri, Maxar, Earthstar' },
  };
  function addBases() {
    Object.entries(BASE_DEF).forEach(([n, d]) => { const id = 'base-' + n;
      map.ml.addSource(id, { type: 'raster', tileSize: 256, maxzoom: d.maxzoom, attribution: d.attribution, tiles: d.keyed ? d.tiles.map(t => t + key()) : d.tiles });
      map.ml.addLayer({ id, type: 'raster', source: id, layout: { visibility: n === (BASE_DEF[S.base] ? S.base : 'light') ? 'visible' : 'none' } }, firstOverlay()); });
  }
  const firstOverlay = () => (map.ml.getStyle().layers.find(l => l.id !== 'bg' && !l.id.startsWith('base-')) || {}).id;
  // Every airport as one GPU circle layer (~48,000 worldwide): radius by class and zoom, the size filters and the
  // small-field zoom gate as a layer filter, faded behind the network in Network mode.
  const rad = k => ['*', k, ['match', ['get', 't'], 2, DOT.large_airport.r, 1, DOT.medium_airport.r, DOT.small_airport.r]];   // radius by class × zoom scale
  function drawAirports() {
    if (!map) return;
    const feats = UI.airports().map((a, i) => ({ type: 'Feature', properties: { i, t: TYPE_IDX[a.type] ?? 0 }, geometry: { type: 'Point', coordinates: [+a.longitude_deg, +a.latitude_deg] } }));
    const data = { type: 'FeatureCollection', features: feats };
    if (map.ml.getSource('ap')) { map.ml.getSource('ap').setData(data); applyVisibility(); return; }
    map.ml.addSource('ap', { type: 'geojson', data });
    map.ml.addLayer({ id: 'ap-dots', type: 'circle', source: 'ap', paint: {
      'circle-radius': ['step', ['zoom'], rad(.5), 5, rad(.7), 7, rad(.9)],   // the zoom step has to be the outer expression
      'circle-color': '#4a4d6e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.25, 'circle-pitch-alignment': 'map' } }, firstAfterBases());
    map.placeRaw('ap-dots', 350);
    map.addInteractiveLayer('ap-dots', f => { const a = UI.airports()[f.properties.i]; if (!a) return;
      if (UI.waypoints) UI.waypoints.noteDotClick();
      if (UI.planner && UI.planner.pickPending()) { UI.planner.notifyAirportPick(a); map.closePopup(); return; }
      map.openPopup(popupHtml(a), UI.ll(a), { offset: [0, -2] }); });
    applyVisibility();
  }
  const firstAfterBases = () => (map.ml.getStyle().layers.find(l => l.id !== 'bg' && !l.id.startsWith('base-')) || {}).id;
  // Size filters drive both the dots and the planner's stop pool (as in the classic); small
  // airfields additionally wait for zoom ≥ 7.5 so they don't blanket the continent.
  function applyVisibility() {
    if (!map || !map.ml.getLayer('ap-dots')) return;
    const want = S.allowedTypes.map(t => TYPE_IDX[t]);
    map.ml.setFilter('ap-dots', ['all', ['in', ['get', 't'], ['literal', want]], ['any', ['!=', ['get', 't'], 0], ['>=', ['zoom'], 6.5]]]);
    const fade = S.mode === 'network' ? .3 : 1;   // the network's own discs carry Network mode
    map.ml.setPaintProperty('ap-dots', 'circle-opacity', ['*', fade, ['match', ['get', 't'], 2, DOT.large_airport.o, 1, DOT.medium_airport.o, DOT.small_airport.o]]);
    map.ml.setPaintProperty('ap-dots', 'circle-stroke-opacity', .45 * fade);
  }
  function drawAlternates() { if (!window.CNSDivertEdit || !UI.planner || !map) return; if (S.showAlternates && S.mode === 'plan') CNSDivertEdit.render(UI.planner.alternatesChain()); else CNSDivertEdit.clear(); }
  function drawAssets() {
    if (!map) return;
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
    if (!map) return;
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
      if (!back) routeLayer.addLayer(L.polyline(arc(pts[i], pts[i + 1]), { pane: 'rt', interactive: false, opacity: 0, arrowEnd: true }));   // the arrowhead where it arrives
      if (!S.showLabels) continue;
      const mid = arcMid(pts[i], pts[i + 1]); /* on the arc, not the chord */ let txt = UI.fmt.dist(dispKm(pts[i], pts[i + 1]));
      if (legs && legs[i]) txt = `${UI.fmt.dist(legs[i].distKm)} · ${UI.fmt.min(legs[i].flightMin)} · ${UI.fmt.r(legs[i].energyKwh)} kWh`;
      if (S.showTracks) txt = `${trk(pts[i], pts[i + 1])}${back ? '/' + trk(pts[i + 1], pts[i]) : ''}T · ${txt}`;   // Map › Tracks, off by default
      routeLayer.addLayer(L.marker(mid, { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="leglbl num">${txt}</div>`, iconSize: [0, 0] }) })); }
    if (fit) fitRoute(false);
  }
  /** Frame the plan route (a training flight: its circuit area) into the map the rail and the timeline leave free. */
  function fitRoute(animate) {
    const c = UI.chain(); if (!c.length || !map) return;
    const pad = Object.assign(pads(), { animate: !!animate });
    if (S.trip === 'training' && S.origin) { const r = ((UI.plane().training_range_km || 60) / 2) * 1000; map.fitBounds(L.latLng(UI.ll(S.origin)).toBounds(r * 2.6), pad); return; }
    if (c.length < 2) { map.panTo(UI.ll(c[0]), { animate: !!animate }); return; }
    map.fitBounds(L.latLngBounds(arcPath(c.map(UI.ll))), Object.assign({ maxZoom: 9 }, pad));
  }
  /** Every airport of the plan chain inside the free map: right of the rail, above the timeline, on screen. */
  function routeInView() { const c = UI.chain(); return !c.length || !map || inFree(c.map(UI.ll)); }
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
    if (!map) return;
    netLayer.clearLayers(); applyVisibility(); if (!S.showNet || !window.CNSDemand) return;
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
    if (!hiLayer || !map) return;
    hiLayer.clearLayers();
    const by = UI.byId(); const s = dotScale();
    (idents || []).forEach(id => { const a = by[id]; if (!a) return;
      hiLayer.addLayer(L.circleMarker(UI.ll(a), { pane: 'rt', interactive: false, radius: Math.max(11, 12 * s), fillColor: '#32326E', fillOpacity: .10, color: '#32326E', weight: 2, opacity: .95 }));
    });
  }
  // The rail (420 px + margins) on the left and the timeline drawer at the bottom are both kept clear.
  function fitNet() { if (!map) return; const pts = []; netLayer.eachLayer(l => { if (l.getLatLngs) pts.push(...l.getLatLngs()); }); if (pts.length) map.fitBounds(L.latLngBounds(pts), Object.assign(pads(), { maxZoom: 8, animate: false })); }
  function setBase(n) { S.base = BASE_DEF[n] ? n : 'light'; if (!map) return; map.whenReady(() => Object.keys(BASE_DEF).forEach(k => map.ml.getLayer('base-' + k) && map.ml.setLayoutProperty('base-' + k, 'visibility', k === S.base ? 'visible' : 'none'))); }
  function setGlobe(on) { S.globe = !!on; if (map) map.setGlobe(S.globe); }
  function flyTo(a) { if (!map) return; map.flyTo(UI.ll(a), Math.max(map.getZoom(), 8)); setTimeout(() => L.popup({ offset: [0, -2] }).setLatLng(UI.ll(a)).setContent(popupHtml(a)).openOn(map), 950); }
  // The divert overlay belongs to the route: it hides and returns WITH it, so Network mode
  // never carries the alternates of a route it does not draw (drawAlternates() reads S.mode,
  // which setMode has already flipped by the time it hides/shows the route layer).
  function hideRoute() { if (!map) return; if (map.hasLayer(routeLayer)) map.removeLayer(routeLayer); drawAlternates(); }
  function showRoute() { if (!map) return; if (!map.hasLayer(routeLayer)) routeLayer.addTo(map); drawAlternates(); }
  UI.map = { arcPath, init, drawAssets, drawAirports, drawRoute, drawNet, fitNet, fitRoute, fit, routeInView, ensureRouteVisible, ensureVisible, setBase, setGlobe, flyTo, applyVisibility, drawAlternates, highlightAirports,
             closePopup: () => map && map.closePopup(), hideRoute, showRoute, get map() { return map; },
             // test hooks (tests/ui): what is drawn, which airport dots are rendered (with their screen position), the basemap shown
             drawn: () => (map ? map.drawn() : []),
             dots: () => { if (!map || !map.ml.getLayer('ap-dots')) return []; const A = UI.airports(), r = map.ml.getContainer().getBoundingClientRect(), seen = new Set();
               return map.ml.queryRenderedFeatures({ layers: ['ap-dots'] }).filter(f => !seen.has(f.properties.i) && seen.add(f.properties.i)).map(f => { const a = A[f.properties.i], p = map.latLngToContainerPoint(UI.ll(a)); return { ident: a.ident, type: a.type, x: r.left + p.x, y: r.top + p.y }; }); },
             baseShown: () => (map ? Object.keys(BASE_DEF).find(k => map.ml.getLayer('base-' + k) && map.ml.getLayoutProperty('base-' + k, 'visibility') === 'visible') : null) };
})();
