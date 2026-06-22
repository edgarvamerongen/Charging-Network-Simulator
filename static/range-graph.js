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
 * mutates nothing else. Dependencies are injected via init() — it never reaches
 * into planner/routing/airport state. Map hue discipline: navy = world, so the
 * whole graph is navy (--brand-ink); blue (route) and orange (NRG2FLY) untouched.
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
    const SPOKE_MAX = 250;                  // density guard — nearest N reachable airports (perf backstop)
    const LABEL_TYPES = { large_airport: 1 };               // ICAO labels on the big hubs only (readability)

    let _map = null, _layer = null, _getReachKm = null, _getAirports = null, _allowedFor = null, _activeIdent = null, _lastIdent = null;

    // ---- pure: great-circle distance (km) ----
    function _haversineKm(a, b) {
        const R = 6371, rad = (x) => x * Math.PI / 180;
        const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    }
    function _hk(a, b) {
        return (window.CNSRouting && CNSRouting.haversineKm) ? CNSRouting.haversineKm(a, b) : _haversineKm(a, b);
    }

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
            const km = _hk(F, { lat, lon });
            if (km <= reachKm) out.push({ ap: a, km });
        }
        return out;
    }

    function init(opts) {
        opts = opts || {};
        _map = opts.map; _getReachKm = opts.getReachKm; _getAirports = opts.airports; _allowedFor = opts.allowedFor;
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

        // faint dashed range ring (the true reach boundary)
        _layer.addLayer(L.circle(hub, {
            radius: reachKm * 1000, color: NAVY, weight: 1.2, opacity: 0.30, dashArray: '5 6',
            fill: false, pane: PANE, interactive: false,
        }));

        // spokes + halos + labels.
        // WYSIWYG: spoke to EXACTLY the airports the live A* router may use — the same
        // allowed pool (size filter OR NRG network). No type exceptions.
        const allowed = (typeof _allowedFor === 'function') ? _allowedFor() : () => true;
        const reach = airportsInRange(from, reachKm, airports)
            .filter((r) => allowed(r.ap))
            .sort((a, b) => a.km - b.km)
            .slice(0, SPOKE_MAX);
        reach.forEach(({ ap }) => {
            const to = [+ap.latitude_deg, +ap.longitude_deg];
            _layer.addLayer(L.polyline([hub, to], { color: '#ffffff', weight: 3, opacity: 0.30, pane: PANE, interactive: false }));   // casing for satellite legibility
            _layer.addLayer(L.polyline([hub, to], { color: NAVY, weight: 1.4, opacity: 0.6, pane: PANE, interactive: false }));
            _layer.addLayer(L.circleMarker(to, { radius: 7.5, color: '#ffffff', weight: 3.5, opacity: 0.5, fill: false, pane: PANE, interactive: false }));   // white halo casing
            _layer.addLayer(L.circleMarker(to, { radius: 7.5, color: NAVY, weight: 1.8, opacity: 0.95, fill: false, pane: PANE, interactive: false }));   // navy halo around the world dot
            if (LABEL_TYPES[ap.type]) _layer.addLayer(_label(to, _esc(ap.ident)));
        });

        // hub: enlarged solid navy + soft halo
        _layer.addLayer(L.circleMarker(hub, { radius: 11, color: NAVY, weight: 1, opacity: 0.18, fill: false, pane: PANE, interactive: false }));
        _layer.addLayer(L.circleMarker(hub, { radius: 6.5, color: '#fff', weight: 2, fillColor: NAVY, fillOpacity: 1, opacity: 1, pane: PANE, interactive: false }));
    }

    function toggle(ident) { if (_activeIdent === ident) clear(); else show(ident); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    return { init, show, clear, toggle, refresh, airportsInRange, _haversineKm };
})();
