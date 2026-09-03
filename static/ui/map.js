/* CNS v2 — ui/map.js: Leaflet map + furniture in the Instrument language. */
(function () {
  const UI = window.CNSUI, S = UI.S;
  let map, BASES, dotsBig, dotsSmall, assetLayer, routeLayer, netLayer;
  const DOT = { large_airport: { r: 3.6, o: .55 }, medium_airport: { r: 2.6, o: .5 }, small_airport: { r: 1.8, o: .35 } };
  function popupHtml(a) {
    const rw = a.rwy_paved_m || a.rwy_grass_m || a.rwy_unknown_m;
    return `<div class="pp"><div class="t"><span>${UI.esc(a.name)}</span><span class="ic2">${UI.esc(a.ident)}${a.iata_code ? ' · ' + UI.esc(a.iata_code) : ''}</span></div>
      <div class="m">${UI.esc(a.municipality || '')}${a.municipality ? ' · ' : ''}${UI.esc((a.type || '').replace('_', ' '))}${rw ? ' · runway ' + Math.round(rw) + ' m' : ' · no runway data'}</div>
      <div class="acts"><button onclick="setOrigin(airportByIdent['${UI.esc(a.ident)}'])">Departure</button><button onclick="setDest(airportByIdent['${UI.esc(a.ident)}'])">Destination</button><button onclick="setStop(airportByIdent['${UI.esc(a.ident)}'])">Stop</button></div></div>`;
  }
  function init() {
    map = L.map('map', { zoomControl: false, preferCanvas: true, zoomSnap: .25 }).setView([51.6, 6.5], 6.25);
    const key = (UI.D && UI.D.cartoKeyQs) || '';
    BASES = {
      light: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Esri, HERE, Garmin, © OSM' }),
      street: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png' + key, { maxZoom: 19, attribution: '© OSM © CARTO' }),
      sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Esri, Maxar, Earthstar' })
    };
    BASES[S.base] ? BASES[S.base].addTo(map) : BASES.light.addTo(map);
    map.createPane('dots').style.zIndex = 350; map.createPane('net').style.zIndex = 380; map.createPane('rt').style.zIndex = 400; map.createPane('pins').style.zIndex = 450;
    dotsBig = L.layerGroup().addTo(map); dotsSmall = L.layerGroup(); assetLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup().addTo(map); netLayer = L.layerGroup().addTo(map);
    map.on('zoomend', () => { const want = S.showSmall || map.getZoom() >= 7.5; if (want && !map.hasLayer(dotsSmall)) dotsSmall.addTo(map); if (!want && map.hasLayer(dotsSmall)) map.removeLayer(dotsSmall); });
    drawAirports(); drawAssets();
  }
  function drawAirports() {
    dotsBig.clearLayers(); dotsSmall.clearLayers();
    UI.airports().forEach(a => { const d = DOT[a.type] || DOT.small_airport;
      const m = L.circleMarker(UI.ll(a), { pane: 'dots', radius: d.r, weight: 0, fillColor: '#4a4d6e', fillOpacity: d.o });
      m.bindPopup(() => popupHtml(a), { offset: [0, -2] });
      (a.type === 'small_airport' ? dotsSmall : dotsBig).addLayer(m); });
  }
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
  function drawRoute(fit) {
    routeLayer.clearLayers(); const c = UI.chain();
    if (S.trip === 'training' && S.origin) { const p = UI.plane(); const r = ((p.training_range_km || 60) / 2) * 1000; routeLayer.addLayer(L.circle(UI.ll(S.origin), { pane: 'rt', radius: r, color: '#d84c26', weight: 2, fillColor: '#d84c26', fillOpacity: .06, dashArray: '4 6' })); if (fit) map.fitBounds(L.latLng(UI.ll(S.origin)).toBounds(r * 2.6), { paddingTopLeft: [360, 60], animate: false }); return; }
    if (c.length < 2) return;
    const pts = c.map(UI.ll);
    routeLayer.addLayer(L.polyline(pts, { pane: 'rt', color: '#fff', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round' }));
    routeLayer.addLayer(L.polyline(pts, { pane: 'rt', color: '#d84c26', weight: 2, opacity: 1, lineCap: 'round', lineJoin: 'round' }));
    if (S.trip === 'retour') routeLayer.addLayer(L.polyline(pts, { pane: 'rt', color: '#fff', weight: 2, opacity: .9, dashArray: '6 8', lineCap: 'butt' }));
    c.forEach((a, i) => { const stop = i > 0 && i < c.length - 1; routeLayer.addLayer(L.marker(UI.ll(a), { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="ep${stop ? ' stop' : ''}"></div>`, iconSize: [11, 11], iconAnchor: [5.5, 5.5] }) })); });
    const legs = UI.plan && UI.plan.legsForMap ? UI.plan.legsForMap() : null;
    for (let i = 0; i < pts.length - 1; i++) { const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]; let txt = UI.fmt.dist(hav(pts[i], pts[i + 1]));
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
      netLayer.addLayer(L.polyline(pts, { pane: 'net', color: '#32326E', weight: hit && S.filter ? 2 : 1.5, opacity: S.filter ? (hit ? .8 : .12) : .45 })); });
  }
  function fitNet() { const pts = []; netLayer.eachLayer(l => { if (l.getLatLngs) pts.push(...l.getLatLngs()); }); if (pts.length) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [560, 60], paddingBottomRight: [40, 80], maxZoom: 8, animate: false }); }
  function setBase(n) { Object.values(BASES).forEach(b => map.removeLayer(b)); (BASES[n] || BASES.light).addTo(map); S.base = n; }
  function flyTo(a) { map.flyTo(UI.ll(a), Math.max(map.getZoom(), 8)); setTimeout(() => L.popup({ offset: [0, -2] }).setLatLng(UI.ll(a)).setContent(popupHtml(a)).openOn(map), 400); }
  UI.map = { init, drawAirports, drawAssets, drawRoute, drawNet, fitNet, setBase, flyTo, showSmall: v => { S.showSmall = v; map.fire('zoomend'); },
             hideRoute: () => map.hasLayer(routeLayer) && map.removeLayer(routeLayer), showRoute: () => !map.hasLayer(routeLayer) && routeLayer.addTo(map), get map() { return map; } };
})();
