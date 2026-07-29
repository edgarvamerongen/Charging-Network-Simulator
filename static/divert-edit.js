/*
 * CNSDivertEdit — manual divert editing (PR #28 design, v1: diverts only).
 * ---------------------------------------------------------------------------
 * One resolver decides every arrival node's divert; the manual choice is the
 * only stored state (`node.divertOverride`, a suitable airport ident):
 *
 *   divertFor(node) = byIdent[node.divertOverride]        // 1. manual (drag / ALT pick)
 *                  ?? nearestSuitable(node, ...)          // 2. live-computed client-side
 *                  ?? byIdent[node.alternate_ident]       // 3. baked DB value
 *
 * Tier 2 also fixes a gap: airports with a blank baked alternate get no divert
 * reserve today; now they get a live-computed one. Suitability is INJECTED by
 * the host (CNSRunway hasData+fits for the selected aircraft; powered-lift is
 * exempt — an eVTOL may divert anywhere, ruled 2026-07-29).
 *
 * The map surface mirrors range-graph.js: own layers, deps injected once,
 * mutates nothing directly — dragging/picking calls back `onChange(nodeKey,
 * ident|null)` and the HOST stamps the override + recomputes the route.
 * The pure core (divertFor / nearestSuitable / divertReserveKm / legInfeasible)
 * is DOM-free and node-tested (tests/js_divert.test.mjs).
 */
window.CNSDivertEdit = (function () {
    'use strict';

    // ---- pure core -----------------------------------------------------------

    function nearestSuitable(point, airports, isSuitable, excludeIdent) {
        if (!point || !isFinite(+point.lat) || !isFinite(+point.lon) || !Array.isArray(airports)) return null;
        let best = null, bestKm = Infinity;
        for (const a of airports) {
            if (!a || a.ident === excludeIdent) continue;
            const lat = +a.latitude_deg, lon = +a.longitude_deg;
            if (!isFinite(lat) || !isFinite(lon)) continue;
            if (typeof isSuitable === 'function' && !isSuitable(a)) continue;
            const km = _hk(point, { lat, lon });
            if (km < bestKm) { bestKm = km; best = a; }
        }
        return best;
    }

    // Resolver: manual ident -> live nearest-suitable -> baked DB alternate.
    // ctx = { byIdent, airports, isSuitable }
    function divertFor(node, ctx) {
        if (!node || !ctx) return null;
        if (node.divertOverride && ctx.byIdent[node.divertOverride]) return ctx.byIdent[node.divertOverride];
        const full = node.ident ? ctx.byIdent[node.ident] : null;
        const self = { lat: +(node.lat != null ? node.lat : full && full.latitude_deg), lon: +(node.lon != null ? node.lon : full && full.longitude_deg) };
        const live = nearestSuitable(self, ctx.airports || [], ctx.isSuitable, node.ident);
        if (live) return live;
        const baked = full && full.alternate_ident ? ctx.byIdent[full.alternate_ident] : null;
        return baked || null;
    }

    function divertReserveKm(node, ctx) {
        const alt = divertFor(node, ctx);
        if (!alt || !node) return 0;
        const full = node.ident ? (ctx.byIdent[node.ident] || node) : node;
        const from = { lat: +(node.lat != null ? node.lat : full.latitude_deg), lon: +(node.lon != null ? node.lon : full.longitude_deg) };
        return _hk(from, { lat: +alt.latitude_deg, lon: +alt.longitude_deg });
    }

    // A leg into a node is infeasible when its length + that node's divert
    // reserve exceed the aircraft's available reach (same test the router runs).
    function legInfeasible(legKm, reserveKm, rangeKm) {
        return (Number(legKm) || 0) + (Number(reserveKm) || 0) > (Number(rangeKm) || 0) + 1e-9;
    }

    function _hk(a, b) {
        if (window.CNSRouting && CNSRouting.haversineKm) return CNSRouting.haversineKm(a, b);
        const R = 6371, r = (d) => d * Math.PI / 180;
        const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }

    // ---- map surface -----------------------------------------------------------

    let _deps = null, _layers = [], _pick = null;   // _pick = nodeKey awaiting a map pick (ALT mode)

    function init(deps) { _deps = deps || null; }

    function clear() {
        if (_deps && _deps.map) _layers.forEach(l => _deps.map.removeLayer(l));
        _layers = [];
    }

    // RESOLVE context: v1 keeps display + reserve consistent — manual ?? baked
    // (the live nearest-suitable tier only powers drag-snapping and ALT pick
    // validation; promoting it to the reserve path is the flagged follow-up).
    function _ctx() {
        return { byIdent: _deps.airportByIdent, airports: [], isSuitable: _deps.isSuitable() };
    }
    // SNAP pool: the full catalog, filtered by the injected suitability.
    function _snap(point, excludeIdent) {
        return nearestSuitable(point, _deps.airports(), _deps.isSuitable(), excludeIdent);
    }

    // Draw the divert overlay for the current chain — line + DRAGGABLE purple
    // marker + live distance label per arrival node (chain[0] departs full).
    // Replaces drawAlternates' static markers when the module is initialised.
    function render(chain) {
        if (!_deps || !_deps.map || !window.L) return;
        clear();
        const ctx = _ctx();
        (chain || []).forEach((n, i) => {
            if (i === 0 || !n) return;
            const full = n.ident ? _deps.airportByIdent[n.ident] : null;
            const from = { lat: +(n.lat != null ? n.lat : full && full.latitude_deg), lon: +(n.lon != null ? n.lon : full && full.longitude_deg) };
            if (!isFinite(from.lat)) return;
            const alt = divertFor(n, ctx);
            if (!alt) return;
            const to = { lat: +alt.latitude_deg, lon: +alt.longitude_deg };
            const line = L.polyline([[from.lat, from.lon], [to.lat, to.lon]], {
                color: '#7c3aed', weight: 2.5, dashArray: '5 6', opacity: 0.9, interactive: false,
            }).addTo(_deps.map);
            const km0 = _hk(from, to);
            const overridden = !!n.divertOverride;
            const icon = L.divIcon({
                className: 'divert-marker-wrap', iconSize: [16, 16], iconAnchor: [8, 8],
                html: `<div class="divert-marker${overridden ? ' manual' : ''}" title="drag to change divert"></div>`,
            });
            const m = L.marker([to.lat, to.lon], { icon, draggable: true, zIndexOffset: 900 });
            m.bindTooltip(`${alt.ident} · ${_fmt(km0)}${overridden ? ' · manual' : ''}`,
                { permanent: true, direction: 'top', offset: [0, -8], className: 'alt-dist-label' });
            m.on('drag', (e) => {
                const p = e.target.getLatLng();
                const cur = { lat: p.lat, lon: p.lng };
                line.setLatLngs([[from.lat, from.lon], [p.lat, p.lng]]);
                const snap = _snap(cur, n.ident);
                const reserve = snap ? _hk(from, { lat: +snap.latitude_deg, lon: +snap.longitude_deg }) : _hk(from, cur);
                m.setTooltipContent(`${snap ? snap.ident : '—'} · ${_fmt(reserve)}`);
                if (typeof _deps.onDragFeedback === 'function') _deps.onDragFeedback(n, reserve, i);
            });
            m.on('dragend', (e) => {
                const p = e.target.getLatLng();
                const snap = _snap({ lat: p.lat, lon: p.lng }, n.ident);
                if (snap && typeof _deps.onChange === 'function') _deps.onChange(n, snap.ident);
                else render(chain);   // no suitable target — revert to the resolved divert
            });
            m.addTo(_deps.map);
            _layers.push(line, m);
        });
    }

    // ALT mode: the next airport the user opens on the map becomes this node's
    // divert (one-shot; host calls notifyAirportPick from its card-open hook).
    function startAltPick(node) { _pick = node || null; }
    function cancelAltPick() { _pick = null; }
    function pickPending() { return _pick != null; }
    function notifyAirportPick(airport) {
        if (_pick == null || !airport || !_deps) return false;
        const ok = _deps.isSuitable()(airport);
        if (!ok) return false;                       // unsuitable pick — stay in pick mode
        const node = _pick; _pick = null;
        if (typeof _deps.onChange === 'function') _deps.onChange(node, airport.ident);
        return true;
    }

    function _fmt(km) { return (typeof fmtDist === 'function') ? fmtDist(km) : `${Math.round(km)} km`; }

    return {
        init, render, clear,
        startAltPick, cancelAltPick, pickPending, notifyAirportPick,
        divertFor, nearestSuitable, divertReserveKm, legInfeasible,
    };
})();
