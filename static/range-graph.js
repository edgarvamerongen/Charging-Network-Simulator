/*
 * CNSRangeGraph — "what's reachable from here" overlay.
 *
 * Clicking an airport draws a hub-and-spoke graph of every (large/medium) airport
 * reachable in ONE hop with the current aircraft — WYSIWYG: great-circle ≤
 * _availableRangeKm (the planner's leg check) AND in the SAME allowed pool the
 * live A* router may use (size filter + NRG network). A spoke is exactly a leg
 * the planner would accept — no type exceptions; show small, get small.
 *
 * Orthogonal by design: this module owns ONE Leaflet layer in its OWN pane and
 * mutates nothing else. Host state is injected via init() — it never reaches into
 * planner/airport state. Map hue discipline: navy = world, so the whole graph is
 * navy (--brand-ink); blue (route) and orange (NRG2FLY) untouched.
 *
 * Depends on: CNSRouting is loaded before this file; escHtml is defined later by
 * each shell and is only referenced at render time (never at load time), so it
 * must stay a call-time reference.
 *
 * Integration surface (everything else is internal):
 *   1. <script src="/static/range-graph.js">
 *   2. CNSRangeGraph.init({ map, getReachKm, airports, allowedFor })   // once, after map setup
 *   3. CNSRangeGraph.show(ident) from setOrigin/setDest/setStop (the route-set)
 *   4. a "Range graph" toggle (#fReachGraph) in Map Options + the .rg-lbl label CSS
 */
window.CNSRangeGraph = (function () {
    'use strict';
    const PANE = 'rangeGraphPane';
    const NAVY = '#2b2f5a';                 // --brand-ink: the map's "world" hue
    const SPOKE_MAX = 200;                  // density guard: large fields first, then medium, then small (longest runway first)
    const RANK = { large_airport: 0, medium_airport: 1 };   // everything else ranks after these
    const RWY = ['paved', 'grass', 'gravel', 'dirt', 'water', 'unknown'];
    const longestRwy = (a) => Math.max(0, ...RWY.map((c) => +a['rwy_' + c + '_m'] || 0));
    const LABEL_TYPES = { large_airport: 1 };               // ICAO labels on the big hubs only (readability)

    let _map = null, _layer = null, _getReachKm = null, _getAirports = null, _allowedFor = null, _windAt = null, _activeIdent = null, _lastIdent = null;

    // ---- pure + testable: airports within `reachKm` great-circle of `from` (excl. self) ----
    function airportsInRange(from, reachKm, airports) {
        if (!from || !(reachKm > 0) || !Array.isArray(airports)) return [];
        const F = { lat: +from.latitude_deg, lon: +from.longitude_deg };
        if (!isFinite(F.lat) || !isFinite(F.lon)) return [];
        const out = [];
        for (const a of airports) {
            if (!a || a.ident === from.ident) continue;
            const lat = +a.latitude_deg, lon = +a.longitude_deg;
            if (!isFinite(lat) || !isFinite(lon)) continue;
            const km = CNSRouting.haversineKm(F, { lat, lon });
            if (km <= reachKm) out.push({ ap: a, km });
        }
        return out;
    }

    function init(opts) {
        opts = opts || {};
        _map = opts.map; _getReachKm = opts.getReachKm; _getAirports = opts.airports; _allowedFor = opts.allowedFor; _windAt = opts.windAt || null;   // windAt(courseDeg) → air km per ground km
        if (!_map || !window.L) return;
        if (!_map.getPane(PANE)) {
            _map.createPane(PANE);
            _map.getPane(PANE).style.zIndex = 620;         // above airport dots (overlayPane 400), below saved/route (645/650)
            _map.getPane(PANE).style.pointerEvents = 'none';
        }
        _layer = L.layerGroup([], { pane: PANE }).addTo(_map);
        // self-wired lifecycle — the module owns it all; the planner only calls show()
        const toggle = document.getElementById('fReachGraph');                        // Map Options on/off
        if (toggle) toggle.addEventListener('change', () => { (toggle.checked && _lastIdent) ? show(_lastIdent) : clear(); });
        document.querySelectorAll('.airport-filter').forEach((c) => c.addEventListener('change', refresh));   // WYSIWYG: size filter
        const net = document.getElementById('nrgChargerToggle'); if (net) net.addEventListener('change', refresh);   // WYSIWYG: NRG network pool
        const planeSel = document.getElementById('plane');
        if (planeSel) planeSel.addEventListener('change', refresh);                    // aircraft → range changed
        if (window.CNSSettings && CNSSettings.subscribe) CNSSettings.subscribe(refresh);  // reserves/padding changed
        const reset = document.getElementById('planReset');
        if (reset) reset.addEventListener('click', () => { _lastIdent = null; clear(); });   // route cleared → graph cleared
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clear(); });
        _map.on('click', clear);   // click anywhere on the map (not an airport) → dismiss the graph
        _map.on('moveend', refresh);   // spokes cover what is in view, so a pan or zoom redraws them
    }

    function clear() { if (_layer) _layer.clearLayers(); _activeIdent = null; }
    function refresh() { if (_activeIdent) show(_activeIdent); }
    function _enabled() { const cb = document.getElementById('fReachGraph'); return !!(cb && cb.checked); }

    function _label(ll, text) {
        return L.marker(ll, {
            pane: PANE, interactive: false, keyboard: false,
            icon: L.divIcon({ className: 'rg-lbl', iconSize: [0, 0], html: '<span>' + text + '</span>' }),
        });
    }

    // The point `km` along true course `deg` from p (great circle) as [lat, lon].
    function _dest(p, deg, km) {
        const R = Math.PI / 180, d = km / 6371.0088, b = deg * R, la1 = p.lat * R, lo1 = p.lon * R;
        const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
        const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
        return [la2 / R, lo2 / R];
    }
    function show(ident) {
        if (!_map || !_layer || !window.L) return;
        _lastIdent = ident;
        if (!_enabled()) { clear(); return; }              // off in Map Options → nothing drawn
        const airports = (typeof _getAirports === 'function') ? (_getAirports() || []) : [];
        const from = airports.find((a) => a && a.ident === ident);
        const reachKm = (typeof _getReachKm === 'function') ? (+_getReachKm() || 0) : 0;
        if (!from || !(reachKm > 0)) { clear(); return; }
        clear();
        _activeIdent = ident;
        const hub = [+from.latitude_deg, +from.longitude_deg];

        // faint dashed reach boundary. In wind the reach is AIR km: over the ground it is reachKm × GS/TAS per
        // bearing (short upwind, long downwind), so the ring becomes that shape; still air keeps the circle.
        const F = { lat: hub[0], lon: hub[1] }, fAt = (c) => (_windAt ? _windAt(c) : 1);
        const groundReach = (c) => reachKm / fAt(c);
        const ringStyle = { color: NAVY, weight: 1.2, opacity: 0.30, dashArray: '5 6', fill: false, pane: PANE, interactive: false };
        let maxGround = reachKm;
        const windy = !!_windAt && [0, 90, 180, 270].some((c) => Math.abs(fAt(c) - 1) > 1e-9);
        if (windy) {
            const ring = [];
            for (let c = 0; c < 360; c += 5) { const g = groundReach(c); maxGround = Math.max(maxGround, g); ring.push(_dest(F, c, g)); }
            _layer.addLayer(L.polygon(ring, ringStyle));
        } else _layer.addLayer(L.circle(hub, Object.assign({ radius: reachKm * 1000 }, ringStyle)));

        // spokes + halos + labels.
        // WYSIWYG: spoke to EXACTLY the airports the live A* router may use — the same
        // allowed pool (size filter OR NRG network). No type exceptions.
        const allowed = (typeof _allowedFor === 'function') ? _allowedFor() : () => true;
        // Only airports in view get a spoke (off-screen ones can't be seen); if more than SPOKE_MAX are, the
        // bigger fields win: large, medium, then small by longest runway, nearest first within a class.
        const view = _map.getBounds().pad(0.05), rank = (a) => RANK[a.type] ?? 2;
        const reach = airportsInRange(from, maxGround, airports)
            .filter((r) => r.km <= groundReach(CNSRouting.courseDeg(F, { lat: +r.ap.latitude_deg, lon: +r.ap.longitude_deg })))
            .filter((r) => allowed(r.ap) && view.contains([+r.ap.latitude_deg, +r.ap.longitude_deg]))
            .sort((a, b) => rank(a.ap) - rank(b.ap) || (rank(a.ap) === 2 ? longestRwy(b.ap) - longestRwy(a.ap) : 0) || a.km - b.km)
            .slice(0, SPOKE_MAX);
        reach.forEach(({ ap }) => {
            const to = [+ap.latitude_deg, +ap.longitude_deg];
            _layer.addLayer(L.polyline([hub, to], { color: '#ffffff', weight: 3, opacity: 0.30, pane: PANE, interactive: false }));   // casing for satellite legibility
            _layer.addLayer(L.polyline([hub, to], { color: NAVY, weight: 1.4, opacity: 0.6, pane: PANE, interactive: false }));
            _layer.addLayer(L.circleMarker(to, { radius: 7.5, color: '#ffffff', weight: 3.5, opacity: 0.5, fill: false, pane: PANE, interactive: false }));   // white halo casing
            _layer.addLayer(L.circleMarker(to, { radius: 7.5, color: NAVY, weight: 1.8, opacity: 0.95, fill: false, pane: PANE, interactive: false }));   // navy halo around the world dot
            if (LABEL_TYPES[ap.type]) _layer.addLayer(_label(to, escHtml(ap.ident)));
        });

        // hub: enlarged solid navy + soft halo
        _layer.addLayer(L.circleMarker(hub, { radius: 11, color: NAVY, weight: 1, opacity: 0.18, fill: false, pane: PANE, interactive: false }));
        _layer.addLayer(L.circleMarker(hub, { radius: 6.5, color: '#fff', weight: 2, fillColor: NAVY, fillOpacity: 1, opacity: 1, pane: PANE, interactive: false }));
    }

    return { init, show, refresh, clear, airportsInRange };
})();
