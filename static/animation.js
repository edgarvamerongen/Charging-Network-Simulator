/*
 * CNS Flight Animation — replays the daily schedule on the flights map.
 * ------------------------------------------------------------------------------
 * Self-contained; depends only on Leaflet (L) and CNSScheduler for the timeline.
 * When the flights-map modal opens for an airport, a clock runs 07:00 → 23:00 and
 * loops. Each scheduled flight instance is a plane (its type's SVG) that flies its
 * trajectory and PAUSES while charging. Planes move along the drawn path, so a
 * faster aircraft (shorter flight time over the same distance) visibly moves
 * quicker. Default tempo: 20 real seconds per simulated hour, adjustable.
 */
window.CNSAnimation = (function () {
    const DAY_START = 7 * 60, DAY_END = 23 * 60, SPAN = DAY_END - DAY_START;

    let map = null, layer = null, items = [], raf = null;
    let secPerHour = 20, anchorReal = 0, anchorClock = DAY_START, clockEl = null;

    // ---------- geometry ----------
    function arcPoints(p1, p2, bend, seg = 48) {
        const [lat1, lon1] = p1, [lat2, lon2] = p2;
        const mlat = (lat1 + lat2) / 2, mlon = (lon1 + lon2) / 2;
        const dlat = lat2 - lat1, dlon = lon2 - lon1;
        const ctrl = [mlat - dlon * bend, mlon + dlat * bend];
        const pts = [];
        for (let i = 0; i <= seg; i++) { const t = i / seg, a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t * t; pts.push([a * lat1 + b * ctrl[0] + c * lat2, a * lon1 + b * ctrl[1] + c * lon2]); }
        return pts;
    }
    function bearing(a, b) {
        const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
        const f1 = toRad(a[0]), f2 = toRad(b[0]), dl = toRad(b[1] - a[1]);
        const y = Math.sin(dl) * Math.cos(f2);
        const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }
    const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    function alongPath(pts, f) {
        if (!pts || pts.length < 2) return [pts && pts[0] || [0, 0], 0];
        const x = Math.max(0, Math.min(1, f)) * (pts.length - 1);
        const i = Math.min(pts.length - 2, Math.floor(x));
        return [lerp(pts[i], pts[i + 1], x - i), bearing(pts[i], pts[i + 1])];
    }
    const fmtTime = (m) => CNSUnits.fmtClock(m);   // single source of truth in units.js

    // ---------- icons ----------
    function planeIcon(svg) {
        const inner = svg
            ? `<img src="/pics/plane_svgs/${svg}" style="width:30px;height:30px;display:block">`
            : `<div style="width:14px;height:14px;background:#444;border:2px solid #fff;border-radius:50%"></div>`;
        return L.divIcon({ className: 'cns-plane-icon', html: `<div class="cns-plane">${inner}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    }

    function ensureStyles() {
        if (document.getElementById('cns-anim-style')) return;
        const s = document.createElement('style');
        s.id = 'cns-anim-style';
        s.textContent = `
            .cns-plane-icon { background: none; border: none; }
            .cns-plane { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
            .cns-plane img { filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
            .cns-plane.charging { box-shadow: 0 0 0 3px rgba(25,135,84,.55); animation: cnsPulse 1s ease-in-out infinite; }
            @keyframes cnsPulse { 0%,100% { box-shadow: 0 0 0 2px rgba(25,135,84,.5); } 50% { box-shadow: 0 0 0 7px rgba(25,135,84,.15); } }`;
        document.head.appendChild(s);
    }

    // ---------- build ----------
    // Build the full waypoint chain for a trip (handles single-leg + multi-leg).
    function _chain(t) {
        const o = [+t.originLat, +t.originLon], d = [+t.destLat, +t.destLon];
        if (!t.multiLeg) {
            return t.tripType === 'retour' ? [o, d, o] : [o, d];
        }
        const stops = (t.stops || []).map(s => [+s.lat, +s.lon]);
        const out = [o, ...stops, d];
        if (t.tripType === 'retour') return out.concat(stops.slice().reverse(), [o]);
        if (t.tripType === 'circular') return out.concat([o]);   // close the ring
        return out;
    }

    function drawContext(ident) {
        const trips = CNSScheduler.tripsAt(ident);
        const pts = [];
        trips.forEach(t => {
            const o = [+t.originLat, +t.originLon], d = [+t.destLat, +t.destLon];
            if (t.multiLeg) {
                // straight polyline through every waypoint; back-leg dashed for retour;
                // circular closes the loop with the final leg back home
                const chainOut = [o, ...(t.stops || []).map(s => [+s.lat, +s.lon]), d];
                if (t.tripType === 'circular') chainOut.push(o);
                L.polyline(chainOut, { color: '#9ab', weight: 2, opacity: .6 }).addTo(layer);
                if (t.tripType === 'retour') {
                    L.polyline(chainOut.slice().reverse(), { color: '#9ab', weight: 2, opacity: .5, dashArray: '6 5' }).addTo(layer);
                }
                (t.stops || []).forEach(s => {
                    L.circleMarker([+s.lat, +s.lon], { radius: 5, color: '#000', weight: 1, fillColor: '#2563eb', fillOpacity: .9 })
                        .bindTooltip(s.name).addTo(layer);
                    pts.push([+s.lat, +s.lon]);
                });
            } else if (t.tripType === 'retour') {
                L.polyline(arcPoints(o, d, 0.12),  { color: '#9ab', weight: 2, opacity: .6 }).addTo(layer);
                L.polyline(arcPoints(o, d, -0.12), { color: '#9ab', weight: 2, opacity: .6, dashArray: '6 5' }).addTo(layer);
            } else {
                L.polyline([o, d], { color: '#9ab', weight: 2, opacity: .6 }).addTo(layer);
            }
            [[o, t.originName], [d, t.destName]].forEach(([p, nm]) =>
                L.circleMarker(p, { radius: 5, color: '#000', weight: 1, fillColor: '#ff7800', fillOpacity: .9 }).bindTooltip(nm).addTo(layer));
            pts.push(o, d);
        });
        if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25));
    }

    function buildItems(ident) {
        items = [];
        CNSScheduler.tripsAt(ident).forEach(t => {
            const o = [+t.originLat, +t.originLon], d = [+t.destLat, +t.destLon];
            if (!isFinite(o[0]) || !isFinite(d[0])) return;
            const chain = _chain(t);
            // Per-leg path: single-leg retour uses arcs (visual continuity with the
            // map); everything else is straight segments between adjacent waypoints.
            let legPaths;
            if (t.multiLeg) {
                legPaths = [];
                for (let i = 0; i < chain.length - 1; i++) legPaths.push([chain[i], chain[i + 1]]);
            } else if (t.tripType === 'retour') {
                legPaths = [arcPoints(o, d, 0.12), arcPoints(o, d, -0.12).slice().reverse()];
            } else {
                legPaths = [[o, d]];
            }
            const { ph, total } = CNSScheduler.phasesAnim(t);
            CNSScheduler.instanceStarts(t).forEach(start => {
                const marker = L.marker(o, { icon: planeIcon(t.planeSvg), interactive: false, opacity: 0, zIndexOffset: 1000 }).addTo(layer);
                items.push({ trip: t, start, ph, total, o, d, chain, legPaths, marker });
            });
        });
    }

    function update(clock) {
        items.forEach(it => {
            const lt = clock - it.start;
            if (lt < 0 || lt > it.total) { it.marker.setOpacity(0); return; }
            it.marker.setOpacity(1);
            const p = it.ph.find(ph => lt >= ph.start && lt <= ph.start + ph.dur) || it.ph[it.ph.length - 1];
            let latlng, brng = 0, charging = false;
            if (p.kind === 'fly') {
                const f = p.dur ? (lt - p.start) / p.dur : 1;
                let path;
                if (typeof p.leg === 'number') {                                   // multi-leg
                    path = it.legPaths[p.leg] || [it.chain[p.leg], it.chain[p.leg + 1]];
                } else {                                                            // single-leg ('out' / 'back')
                    path = p.leg === 'out' ? it.legPaths[0] : (it.legPaths[1] || [it.d, it.o]);
                }
                const r = alongPath(path, f); latlng = r[0]; brng = r[1];
            } else {
                // charge phase — park the plane at the relevant waypoint
                if (typeof p.atIdx === 'number') latlng = it.chain[p.atIdx];        // multi-leg
                else latlng = p.at === 'dest' ? it.d : it.o;                        // single-leg
                charging = true;
            }
            it.marker.setLatLng(latlng);
            const el = it.marker.getElement();
            if (el) {
                const img = el.querySelector('img');
                if (img) img.style.transform = `rotate(${brng}deg)`;
                const wrap = el.querySelector('.cns-plane');
                if (wrap) wrap.classList.toggle('charging', charging);
            }
        });
    }

    function currentClock() {
        const now = performance.now() / 1000;
        let c = anchorClock + (now - anchorReal) * (60 / secPerHour);
        return DAY_START + (((c - DAY_START) % SPAN) + SPAN) % SPAN;   // wrap into the day
    }

    function loop() {
        const clock = currentClock();
        if (clockEl) clockEl.textContent = fmtTime(clock);
        update(clock);
        raf = requestAnimationFrame(loop);
    }

    // ---------- public ----------
    function start(leafletMap, ident, opts) {
        stop();
        ensureStyles();
        map = leafletMap;
        layer = L.layerGroup().addTo(map);
        clockEl = (opts && opts.clockEl) || null;
        if (opts && opts.speed) secPerHour = opts.speed;
        drawContext(ident);
        buildItems(ident);
        anchorReal = performance.now() / 1000;
        anchorClock = DAY_START;
        raf = requestAnimationFrame(loop);
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        if (layer && map) map.removeLayer(layer);
        layer = null; items = [];
    }

    function setSpeed(s) {
        const clock = currentClock();           // keep the clock continuous across a speed change
        secPerHour = s;
        anchorClock = clock;
        anchorReal = performance.now() / 1000;
    }

    function init() { ensureStyles(); }

    return { init, start, stop, setSpeed };
})();
