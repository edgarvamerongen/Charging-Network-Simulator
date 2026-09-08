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
    const fitHtml = fit ? `<div class="m ${fit.state === 'ok' ? '' : fit.state === 'unknown' ? '' : 'bad'}">${UI.esc(UI.planeShort(p.name))}: ${UI.esc(fit.label || fit.state)}</div>` : '';
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
    map.on('zoomend', () => { rescaleDots(); applyVisibility(); });
    drawAirports(); drawAssets();
  }
  function drawAirports() {
    Object.values(dots).forEach(g => g.clearLayers());
    const s = dotScale();
    UI.airports().forEach(a => { const d = DOT[a.type] || DOT.small_airport;
      const m = L.circleMarker(UI.ll(a), { renderer: dotRenderer, pane: 'dots', radius: d.r * s, fillColor: '#4a4d6e', fillOpacity: d.o, color: '#fff', weight: 1.25, opacity: .45 });
      m._dotR = d.r;   // base radius — rescaled on zoom by rescaleDots()
      m.bindPopup(() => popupHtml(a), { offset: [0, -2] });
      m.on('click', () => { if (UI.planner && UI.planner.pickPending()) { UI.planner.notifyAirportPick(a); map.closePopup(); } });
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
      const m = L.marker(UI.ll(a), { pane: 'pins', icon: L.divIcon({ className: '', html: `<div class="nrg-pin${construction ? ' construction' : ''}"><div class="head"><img src="/pics/logos/NRG2fly_icon_circle_inv.png" alt=""></div><div class="tail"></div></div>`, iconSize: [0, 0], iconAnchor: [0, 0] }) });
      m.bindPopup(`<div class="pp"><div class="t"><span>${UI.esc(x.name)}</span><span class="ic2">${UI.esc(x.icao)}</span></div><div class="m">${UI.esc(x.network || 'NRG2FLY')} charging${construction ? ' · under construction' : ''} · ${(x.plugs || []).length} plug${(x.plugs || []).length === 1 ? '' : 's'}</div>
        <div class="plugs">${(x.plugs || []).map(p => `<div><span>${UI.esc(p.label)} · ${UI.esc(p.connector)}</span><b class="num">${p.power_kw} kW</b></div>`).join('')}</div></div>`);
      assetLayer.addLayer(m); });
  }
  function hav(a, b) { const R = 6371, dL = (b[0] - a[0]) * Math.PI / 180, dN = (b[1] - a[1]) * Math.PI / 180, x = Math.sin(dL / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dN / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  // Distance to SHOW on a leg label: the ROUTED leg (great-circle × routing padding) + the
  // fixed SID/STAR pad, i.e. the classic's _dispKm (index.html:4596-4601) and the same number
  // the result table prints — a raw great-circle here reads as a second, contradicting distance.
  // Prefers the shell's shared helper when one exists (UI.dispKm), so both stay in step.
  function dispKm(a, b) {
    const A = { lat: a[0], lon: a[1], latitude_deg: a[0], longitude_deg: a[1] }, B = { lat: b[0], lon: b[1], latitude_deg: b[0], longitude_deg: b[1] };
    if (typeof UI.dispKm === 'function') { try { const v = UI.dispKm(A, B); if (isFinite(v) && v > 0) return v; } catch (e) {} }
    const p = UI.plane();
    const sid = (window.CNSSettings && CNSSettings.sidStarPaddingKm) ? CNSSettings.sidStarPaddingKm(p) : 0;
    if (window.CNSRouting && CNSRouting.routedKm) return CNSRouting.routedKm(A, B, p) + sid;
    return hav(a, b) + sid;
  }
  function drawRoute(fit) {
    routeLayer.clearLayers(); const c = UI.chain();
    if (S.trip === 'training' && S.origin) { const p = UI.plane(); const r = ((p.training_range_km || 60) / 2) * 1000; routeLayer.addLayer(L.circle(UI.ll(S.origin), { pane: 'rt', interactive: false, radius: r, color: '#d84c26', weight: 2, fillColor: '#d84c26', fillOpacity: .06, dashArray: '4 6' })); if (fit) map.fitBounds(L.latLng(UI.ll(S.origin)).toBounds(r * 2.6), { paddingTopLeft: [360, 60], animate: false }); return; }
    if (c.length < 2) return;
    const pts = c.map(UI.ll);
    routeLayer.addLayer(L.polyline(pts, { pane: 'rt', interactive: false, color: '#fff', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round' }));
    routeLayer.addLayer(L.polyline(pts, { pane: 'rt', interactive: false, color: '#d84c26', weight: 2, opacity: 1, lineCap: 'round', lineJoin: 'round' }));
    if (S.trip === 'retour') routeLayer.addLayer(L.polyline(pts, { pane: 'rt', interactive: false, color: '#fff', weight: 2, opacity: .9, dashArray: '6 8', lineCap: 'butt' }));
    c.forEach((a, i) => { const stop = i > 0 && i < c.length - 1; routeLayer.addLayer(L.marker(UI.ll(a), { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="ep${stop ? ' stop' : ''}"></div>`, iconSize: [11, 11], iconAnchor: [5.5, 5.5] }) })); });
    const legs = UI.plan && UI.plan.legsForMap ? UI.plan.legsForMap() : null;
    for (let i = 0; S.showLabels && i < pts.length - 1; i++) { const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]; let txt = UI.fmt.dist(dispKm(pts[i], pts[i + 1]));
      if (legs && legs[i]) txt = `${UI.fmt.dist(legs[i].distKm)} · ${UI.fmt.h(legs[i].flightMin)} h · ${UI.fmt.r(legs[i].energyKwh)} kWh`;
      routeLayer.addLayer(L.marker(mid, { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="leglbl num">${txt}</div>`, iconSize: [0, 0] }) })); }
    if (fit) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [360, 60], paddingBottomRight: [40, 80], maxZoom: 9, animate: false });
  }
  function drawNet() {
    netLayer.clearLayers(); if (!S.showNet || !window.CNSDemand) return;
    CNSDemand.loadFolder().forEach(t => { const pts = [[t.originLat, t.originLon], ...(t.stops || []).map(s => [s.lat, s.lon]), [t.destLat, t.destLon]].filter(p => p[0] != null && p[1] != null);
      if (t.tripType === 'retour' || t.tripType === 'circular') pts.push([t.originLat, t.originLon]);
      if (pts.length < 2) return; const idents = [t.originIdent, ...(t.stops || []).map(s => s.ident), t.destIdent];
      const hit = !S.filter || idents.includes(S.filter);
      netLayer.addLayer(L.polyline(pts, { pane: 'net', interactive: false, color: '#32326E', weight: hit && S.filter ? 2 : 1.5, opacity: S.filter ? (hit ? .8 : .12) : .45 })); });
  }
  function highlightAirports(idents) {
    if (!hiLayer) return;
    hiLayer.clearLayers();
    const by = UI.byId(); const s = dotScale();
    (idents || []).forEach(id => { const a = by[id]; if (!a) return;
      hiLayer.addLayer(L.circleMarker(UI.ll(a), { pane: 'rt', interactive: false, radius: Math.max(11, 12 * s), fillColor: '#32326E', fillOpacity: .10, color: '#32326E', weight: 2, opacity: .95 }));
    });
  }
  function fitNet() { const pts = []; netLayer.eachLayer(l => { if (l.getLatLngs) pts.push(...l.getLatLngs()); }); if (pts.length) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [560, 60], paddingBottomRight: [40, 80], maxZoom: 8, animate: false }); }
  function setBase(n) { Object.values(BASES).forEach(b => map.removeLayer(b)); (BASES[n] || BASES.light).addTo(map); S.base = n; }
  function flyTo(a) { map.flyTo(UI.ll(a), Math.max(map.getZoom(), 8)); setTimeout(() => L.popup({ offset: [0, -2] }).setLatLng(UI.ll(a)).setContent(popupHtml(a)).openOn(map), 400); }
  // The divert overlay belongs to the route: it hides and returns WITH it, so Network mode
  // never carries the alternates of a route it does not draw (drawAlternates() reads S.mode,
  // which setMode has already flipped by the time it hides/shows the route layer).
  function hideRoute() { if (map.hasLayer(routeLayer)) map.removeLayer(routeLayer); drawAlternates(); }
  function showRoute() { if (!map.hasLayer(routeLayer)) routeLayer.addTo(map); drawAlternates(); }
  UI.map = { init, drawAirports, drawAssets, drawRoute, drawNet, fitNet, setBase, flyTo, applyVisibility, drawAlternates, highlightAirports,
             closePopup: () => map.closePopup(), hideRoute, showRoute, get map() { return map; } };
})();
