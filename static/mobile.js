/*
 * CNS Mobile — minimal glue for the /m/ route.
 * ------------------------------------------------------------------------------
 * Reuses every framework-agnostic domain module from the desktop build
 * (CNSDemand, CNSRouting, CNSCharging, CNSScheduler, CNSPlanes, CNSChargers,
 * CNSSettings, CNSState, CNSUnits). Only the layout + the Google-Maps-style
 * bottom sheet are mobile-specific.
 *
 * Scope (v1): plan → simulate → result preview → add to demand. Scheduler,
 * animation modal, drag-reorder, model-settings UI, PDF and manual stops
 * are intentionally deferred — keep the surface light and discoverable.
 */
(function () {
    'use strict';

    // ---------- State -------------------------------------------------------
    const selected = { origin: null, destination: null };
    let allAirports = [];
    let map = null;
    let routeLayers = [];
    let startMarker = null, endMarker = null;
    let lastResult = null;

    // ---------- Map ---------------------------------------------------------
    function initMap() {
        map = L.map('map', { zoomControl: false, attributionControl: false }).setView([50, 8], 5);
        L.control.zoom({ position: 'topright' }).addTo(map);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 18, attribution: 'Tiles &copy; Esri'
        }).addTo(map);
    }

    async function loadAirports() {
        try {
            allAirports = await fetch('/api/airports').then(r => r.json());
        } catch (e) { console.error('airports', e); return; }
        // Plot a lightweight marker layer — circle markers, no clustering on
        // mobile (keeps the JS simple; the orange dots are recognisable).
        const layer = L.layerGroup().addTo(map);
        allAirports.forEach(a => {
            if (!isFinite(a.latitude_deg) || !isFinite(a.longitude_deg)) return;
            const m = L.circleMarker([a.latitude_deg, a.longitude_deg], {
                radius: 5, color: '#fff', weight: 1, fillColor: '#ff7800', fillOpacity: .9
            });
            m.on('click', () => openMapPopup(a, m));
            m.addTo(layer);
        });
    }

    function openMapPopup(ap, marker) {
        const html = `
            <div class="m-mappop">
              <div class="name">${ap.name}</div>
              <div class="text-muted" style="font-size:.78rem">${ap.ident || ''} ${ap.municipality ? '· ' + ap.municipality : ''}</div>
              <div class="m-mappop-btns">
                <button data-set="origin">Set as Departure</button>
                <button class="dest" data-set="destination">Set as Destination</button>
              </div>
            </div>`;
        const popup = L.popup({ closeButton: true, autoClose: true, className: 'm-mappop-wrap' })
            .setLatLng(marker.getLatLng())
            .setContent(html)
            .openOn(map);
        // Click handlers — Leaflet popup is appended to the DOM after open.
        setTimeout(() => {
            document.querySelectorAll('.m-mappop button').forEach(btn => {
                btn.addEventListener('click', () => {
                    pickAirport(btn.dataset.set, ap);
                    map.closePopup();
                });
            });
        }, 0);
    }

    // ---------- Autocomplete -----------------------------------------------
    function setupAutocomplete(inputId, listId, field) {
        const input = document.getElementById(inputId);
        const list  = document.getElementById(listId);
        const clear = document.querySelector(`button.m-clear[data-clear="${inputId}"]`);
        let current = [];
        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            selected[field] = null;
            updateSummary();
            if (clear) clear.classList.toggle('d-none', !input.value);
            if (q.length < 2) { list.classList.add('d-none'); return; }
            current = allAirports.filter(a =>
                (a.name && a.name.toLowerCase().includes(q)) ||
                (a.municipality && a.municipality.toLowerCase().includes(q)) ||
                (a.iata_code && a.iata_code.toLowerCase() === q)
            ).slice(0, 30);
            list.innerHTML = current.length
                ? current.map((a, i) => `<div class="m-ac-item" data-i="${i}"><strong>${a.name}</strong><small>${a.ident || ''} ${a.municipality ? '· ' + a.municipality : ''}</small></div>`).join('')
                : '<div class="m-ac-item text-muted">No matches</div>';
            list.classList.remove('d-none');
        });
        list.addEventListener('mousedown', e => {
            const item = e.target.closest('.m-ac-item[data-i]');
            if (!item) return;
            pickAirport(field, current[+item.dataset.i]);
        });
        list.addEventListener('touchstart', e => {
            const item = e.target.closest('.m-ac-item[data-i]');
            if (!item) return;
            e.preventDefault();
            pickAirport(field, current[+item.dataset.i]);
        }, { passive: false });
        input.addEventListener('blur', () => setTimeout(() => list.classList.add('d-none'), 200));
        if (clear) clear.addEventListener('click', () => {
            input.value = ''; selected[field] = null; clear.classList.add('d-none');
            list.classList.add('d-none'); updateSummary(); refreshSimulateButton();
        });
    }

    function pickAirport(field, ap) {
        if (!ap) return;
        selected[field] = ap;
        const inp = document.getElementById(field === 'origin' ? 'mOrigin' : 'mDestination');
        if (inp) {
            inp.value = ap.name;
            const clear = document.querySelector(`button.m-clear[data-clear="${inp.id}"]`);
            if (clear) clear.classList.remove('d-none');
        }
        document.getElementById('mOriginList').classList.add('d-none');
        document.getElementById('mDestinationList').classList.add('d-none');
        updateSummary();
        refreshSimulateButton();
        drawLivePreview();
    }

    // ---------- Live route preview -----------------------------------------
    function clearRoute() {
        routeLayers.forEach(l => map.removeLayer(l));
        routeLayers = [];
        if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
        if (endMarker)   { map.removeLayer(endMarker);   endMarker = null; }
    }
    function drawLivePreview() {
        clearRoute();
        if (!selected.origin) return;
        const o = [selected.origin.latitude_deg, selected.origin.longitude_deg];
        startMarker = L.marker(o, { title: 'Departure: ' + selected.origin.name }).addTo(map);
        if (!selected.destination) return;
        const d = [selected.destination.latitude_deg, selected.destination.longitude_deg];
        endMarker = L.marker(d, { title: 'Destination: ' + selected.destination.name }).addTo(map);
        // Quick check against plane range — red dashed if over.
        const plane = (window.PLANES_BY_ID || {})[document.getElementById('mPlane').value];
        const km = CNSRouting.haversineKm({ lat: o[0], lon: o[1] }, { lat: d[0], lon: d[1] });
        const overRange = plane && plane.range_km && km > plane.range_km;
        const line = L.polyline([o, d], overRange
            ? { color: '#dc2626', weight: 3.5, dashArray: '6 4' }
            : { color: '#0d6efd', weight: 3 });
        line.addTo(map);
        routeLayers.push(line);
    }

    // ---------- Sheet drag-to-snap ------------------------------------------
    // 3 snap states: collapsed (default), half, full. Drag the handle (or
    // the title row) to switch. Body itself is scrollable when in half/full.
    function initSheet() {
        const sheet = document.getElementById('mSheet');
        const handle = document.getElementById('mSheetHandle');
        const snaps = ['', 'snap-half', 'snap-full'];
        let snap = 0;
        function go(idx) {
            idx = Math.max(0, Math.min(2, idx));
            snap = idx;
            sheet.classList.remove('snap-half', 'snap-full');
            if (snaps[idx]) sheet.classList.add(snaps[idx]);
        }
        // Drag — bind start on the whole sheet header (grabber + summary row),
        // then track move/end on document so the touch can leave the trigger
        // element mid-drag without losing the gesture. Previously only the
        // 19px-tall grabber was a drag target and touchmove was bound to it,
        // so the moment your finger moved off the pill the drag died.
        const summary = sheet.querySelector('.m-sheet-summary');
        const dragZones = [handle, summary].filter(Boolean);
        let startY = 0, startSnap = 0, moved = false;
        const onMove = (e) => {
            const y = (e.touches ? e.touches[0].clientY : e.clientY);
            const dy = y - startY;
            if (Math.abs(dy) > 6) moved = true;
            const heights = [80, window.innerHeight * 0.48, window.innerHeight * 0.88];
            const base = window.innerHeight - heights[startSnap];
            const next = Math.max(window.innerHeight * 0.12, Math.min(window.innerHeight - 80, base + dy));
            sheet.style.transform = `translateY(${next}px)`;
        };
        const onEnd = (e) => {
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend',  onEnd);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onEnd);
            sheet.style.transition = '';
            sheet.style.transform = '';
            const y = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY);
            const dy = y - startY;
            if (Math.abs(dy) < 30) return;
            go(dy < 0 ? startSnap + 1 : startSnap - 1);
        };
        const onStart = (e) => {
            startY = (e.touches ? e.touches[0].clientY : e.clientY);
            startSnap = snap;
            moved = false;
            sheet.style.transition = 'none';
            if (e.touches) {
                document.addEventListener('touchmove', onMove, { passive: true });
                document.addEventListener('touchend',  onEnd);
            } else {
                e.preventDefault();
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup',   onEnd);
            }
        };
        dragZones.forEach(z => {
            z.addEventListener('touchstart', onStart, { passive: true });
            z.addEventListener('mousedown',  onStart);
        });
        // Tap (not drag) the grabber to cycle snap states.
        handle.addEventListener('click', () => { if (!moved) go((snap + 1) % 3); });
        // The search-stub at the top also nudges the sheet open.
        document.getElementById('mSearchStub').addEventListener('click', () => go(1));
        return { go, snap: () => snap };
    }

    // ---------- Summary line in the sheet header ---------------------------
    // Short label for an airport — IATA (3-letter) preferred, falls back to
    // ICAO (4-letter `ident`) then the first word of the name. Keeps the
    // top search-stub compact on narrow phones.
    function _shortCode(ap) {
        if (!ap) return '';
        return (ap.iata_code || ap.ident || (ap.name || '').split(/\s+/)[0]).toUpperCase();
    }

    function updateSummary() {
        const titleEl = document.getElementById('mSheetTitle');
        const subEl   = document.getElementById('mSheetSub');
        const search  = document.getElementById('mSearchLabel');
        if (lastResult) {
            titleEl.textContent = 'Trip result';
            subEl.textContent = `${selected.origin?.name || ''} → ${selected.destination?.name || ''}`;
            search.textContent = `${_shortCode(selected.origin)} → ${_shortCode(selected.destination)}`;
            return;
        }
        if (!selected.origin && !selected.destination) {
            titleEl.textContent = 'Plan a flight';
            subEl.textContent   = 'Tap to set Departure';
            search.textContent  = 'Plan a flight';
            return;
        }
        if (selected.origin && !selected.destination) {
            titleEl.textContent = selected.origin.name;
            subEl.textContent   = 'Now pick a Destination';
            search.textContent  = _shortCode(selected.origin);
            return;
        }
        if (selected.origin && selected.destination) {
            titleEl.textContent = `${selected.origin.name} → ${selected.destination.name}`;
            const km = CNSRouting.haversineKm(
                { lat: selected.origin.latitude_deg,      lon: selected.origin.longitude_deg },
                { lat: selected.destination.latitude_deg, lon: selected.destination.longitude_deg }
            );
            subEl.textContent = `${Math.round(km)} km · tap Simulate to compute`;
            search.textContent = `${_shortCode(selected.origin)} → ${_shortCode(selected.destination)}`;
        }
    }
    function refreshSimulateButton() {
        const btn = document.getElementById('mSimulateBtn');
        btn.disabled = !(selected.origin && selected.destination);
    }

    // ---------- Simulate + result ------------------------------------------
    async function simulate() {
        const errEl = document.getElementById('mError');
        errEl.classList.add('d-none');
        if (!selected.origin || !selected.destination) return;
        const planeId = document.getElementById('mPlane').value;
        const plane = (window.PLANES_BY_ID || {})[planeId];
        const origin      = { ident: selected.origin.ident,      name: selected.origin.name,      lat: selected.origin.latitude_deg,      lon: selected.origin.longitude_deg };
        const destination = { ident: selected.destination.ident, name: selected.destination.name, lat: selected.destination.latitude_deg, lon: selected.destination.longitude_deg };

        // Auto-plan stops when the direct hop exceeds the aircraft's range.
        // Keeps the mobile UX one-tap: the user picks airports, the planner
        // handles the chain transparently. If routing fails (no reachable
        // intermediate airports) the backend's error surfaces normally.
        const directKm = CNSRouting.haversineKm(origin, destination);
        let stops = null;
        if (plane && plane.range_km && directKm > plane.range_km) {
            const planRes = CNSRouting.planRoute({
                origin, destination, plane,
                allAirports,
                allowedTypes: ['small_airport', 'medium_airport', 'large_airport'],
                options: { reservePct: 0, maxStops: 10 },
            });
            if (planRes.error) {
                errEl.textContent = `${planRes.error} (route too long for this aircraft)`;
                errEl.classList.remove('d-none');
                return;
            }
            stops = planRes.stops;
        }

        const payload = {
            origin, destination,
            plane_id:   planeId,
            charger_id: document.getElementById('mCharger').value,
            trip_type:  document.getElementById('mTripType').value,
        };
        if (stops && stops.length) payload.stops = stops;

        const btn = document.getElementById('mSimulateBtn');
        const original = btn.textContent;
        btn.disabled = true; btn.textContent = 'Simulating…';
        try {
            const resp = await fetch('/api/simulate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (data.error) { errEl.textContent = data.error; errEl.classList.remove('d-none'); return; }
            // Stash inputs on the result for the Add-to-demand handler below.
            data._origin = origin; data._dest = destination;
            data._chargerId = payload.charger_id;
            data._freqN = 1;
            data._freqUnit = document.getElementById('mFreqUnit').value;
            lastResult = data;
            renderResult(data);
            drawSimulatedRoute(data);
            // Bump sheet to full so the result is fully visible.
            sheetCtl.go(2);
        } catch (e) {
            errEl.textContent = 'Network error: ' + e.message;
            errEl.classList.remove('d-none');
        } finally {
            btn.textContent = original; btn.disabled = false;
        }
    }

    function renderResult(data) {
        document.getElementById('mPlanner').classList.add('d-none');
        document.getElementById('mResult').classList.remove('d-none');
        const isRetour = data.trip_type === 'retour';
        const isMulti  = !!data.multi_leg;
        // Energy / flight time / charge time — multi-leg keeps totals in
        // total_* fields; single-leg has the per-leg field that we ×2 for
        // retour. The recharge_energy_kwh is what the airport actually
        // supplies (deficit for retour, full leg for one-way), so that's
        // what we display as "energy used (per visit)".
        const usedKwh = isMulti
            ? (data.total_recharge_energy_kwh || 0)
            : (isRetour ? (data.leg_energy_kwh || 0) * 2 : (data.leg_energy_kwh || 0));
        const flightMin = isMulti
            ? (data.total_flight_time_h || 0) * 60
            : (isRetour ? (data.flight_time_h || 0) * 60 * 2 : (data.flight_time_h || 0) * 60);
        const chargeMin = isMulti
            ? (data.total_charge_time_min || 0)
            : (data.charge_time_min || 0);
        const stopCount = isMulti && Array.isArray(data.stops) ? data.stops.length : 0;
        const tripLabel = (isRetour ? 'Round trip' : 'One-way') + (stopCount ? ` · ${stopCount} stop${stopCount === 1 ? '' : 's'}` : '');

        document.getElementById('mResEnergy').textContent  = Math.round(usedKwh);
        document.getElementById('mResFlight').textContent  = fmtDur(flightMin);
        document.getElementById('mResCharge').textContent  = fmtDur(chargeMin);
        document.getElementById('mResTrip').textContent    = tripLabel;
        // Single-leg leg distance: prefer the backend's leg_distance_km, but
        // fall back to a haversine of origin→destination if the backend omits
        // it (was a UI bug showing "—" even when the planner clearly had a
        // distance — calculation is correct; only the display was missing).
        const legKmSingle = data.leg_distance_km
            || ((data.origin && data.destination)
                ? CNSRouting.haversineKm({ lat: data.origin.lat, lon: data.origin.lon }, { lat: data.destination.lat, lon: data.destination.lon })
                : 0);
        document.getElementById('mResLeg').textContent     = isMulti ? '—' : (legKmSingle ? Math.round(legKmSingle) + ' km' : '—');
        const legs = isMulti ? (data.legs_count || (data.legs || []).length || 0) : (isRetour ? 2 : 1);
        document.getElementById('mResTotal').textContent   = Math.round(data.total_distance_km || 0) + ' km' + (legs ? ` (${legs} leg${legs === 1 ? '' : 's'})` : '');
        document.getElementById('mResPlane').textContent   = data.plane?.name || '—';
        document.getElementById('mResCharger').textContent = `${data.charger?.name || ''} (${Math.round(data.charger?.power_kw || 0)} kW)`;
        updateSummary();
    }

    function fmtDur(mins) {
        const m = Math.round(mins || 0);
        if (m < 60) return m + ' min';
        return Math.floor(m / 60) + 'h ' + (m % 60 ? (m % 60) + 'min' : '');
    }

    // Sampled-bezier "arc" between two lat/lons. `bend` is the offset of
    // the control point perpendicular to the chord (positive = up-left,
    // negative = down-right). Lifted from the desktop animation.js so
    // retour pairs (one with +bend, one with −bend) read as two parabolas
    // instead of a single overlapping line.
    function arcPoints(p1, p2, bend, seg) {
        seg = seg || 48;
        const [lat1, lon1] = p1, [lat2, lon2] = p2;
        const mlat = (lat1 + lat2) / 2, mlon = (lon1 + lon2) / 2;
        const dlat = lat2 - lat1, dlon = lon2 - lon1;
        const ctrl = [mlat - dlon * bend, mlon + dlat * bend];
        const pts = [];
        for (let i = 0; i <= seg; i++) {
            const t = i / seg, a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t * t;
            pts.push([a * lat1 + b * ctrl[0] + c * lat2, a * lon1 + b * ctrl[1] + c * lon2]);
        }
        return pts;
    }

    function drawSimulatedRoute(data) {
        clearRoute();
        const p1 = [data.origin.lat, data.origin.lon];
        const p2 = [data.destination.lat, data.destination.lon];
        startMarker = L.marker(p1).addTo(map);
        endMarker   = L.marker(p2).addTo(map);

        const isRetour = data.trip_type === 'retour';
        const stopMarkers = [];
        let mainLine;

        if (data.multi_leg && Array.isArray(data.stops) && data.stops.length) {
            // Multi-leg: polyline through all waypoints + blue stop markers.
            // For retour, return leg uses the reversed chain (dashed green) —
            // overlapping intermediate stops makes a parabolic bend less useful
            // here than for direct single-leg retours.
            const chain = [p1];
            data.stops.forEach(s => {
                chain.push([s.lat, s.lon]);
                const sm = L.circleMarker([s.lat, s.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 })
                    .bindTooltip(s.name, { sticky: true })
                    .addTo(map);
                stopMarkers.push(sm); routeLayers.push(sm);
            });
            chain.push(p2);
            mainLine = L.polyline(chain, { color: '#0d6efd', weight: 3 });
            mainLine.addTo(map); routeLayers.push(mainLine);
            if (isRetour) {
                const back = L.polyline(chain.slice().reverse(), { color: '#10b981', weight: 3, dashArray: '8 6' });
                back.addTo(map); routeLayers.push(back);
            }
        } else if (isRetour) {
            // Single-leg retour: two parabolic arcs so outbound (solid blue)
            // and return (dashed green) sit on opposite sides of the chord.
            const outArc  = arcPoints(p1, p2,  0.12);
            const backArc = arcPoints(p1, p2, -0.12);
            mainLine = L.polyline(outArc,  { color: '#0d6efd', weight: 3 });
            const back = L.polyline(backArc, { color: '#10b981', weight: 3, dashArray: '8 6' });
            mainLine.addTo(map); back.addTo(map);
            routeLayers.push(mainLine, back);
        } else {
            // Single-leg one-way: straight blue line.
            mainLine = L.polyline([p1, p2], { color: '#0d6efd', weight: 3 });
            mainLine.addTo(map); routeLayers.push(mainLine);
        }
        map.fitBounds(L.featureGroup([startMarker, endMarker, mainLine].concat(stopMarkers)).getBounds(), { padding: [40, 40], maxZoom: 8 });
    }

    function addToDemand() {
        if (!lastResult) return;
        const d = lastResult, trips = CNSDemand.loadFolder();
        const trip = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            destIdent: d._dest.ident,   destName: d._dest.name,   destLat: d._dest.lat,   destLon: d._dest.lon,
            originIdent: d._origin.ident, originName: d._origin.name, originLat: d._origin.lat, originLon: d._origin.lon,
            planeName: d.plane.name, planeId: d.plane.id, planeSvg: d.plane.svg, tripType: d.trip_type,
            chargerId: d._chargerId, chargerName: d.charger.name, chargerPower: d.charger.power_kw,
            legEnergy: d.leg_energy_kwh, battery: d.plane.battery_kwh,
            freqN: d._freqN, freqUnit: d._freqUnit,
            flightTimeH: d.flight_time_h,
            rechargeEnergy: d.recharge_energy_kwh,
        };
        trips.push(trip);
        CNSDemand.saveFolder(trips);
        const btn = document.getElementById('mAddFolderBtn');
        const orig = btn.textContent;
        btn.textContent = '✓ Added'; setTimeout(() => { btn.textContent = orig; }, 1200);
    }

    function backToPlanner() {
        document.getElementById('mResult').classList.add('d-none');
        document.getElementById('mPlanner').classList.remove('d-none');
        lastResult = null;
        updateSummary();
    }

    function resetAll() {
        selected.origin = null; selected.destination = null;
        document.getElementById('mOrigin').value = '';
        document.getElementById('mDestination').value = '';
        document.querySelectorAll('.m-clear').forEach(b => b.classList.add('d-none'));
        document.getElementById('mError').classList.add('d-none');
        lastResult = null;
        backToPlanner();
        clearRoute();
        refreshSimulateButton();
        updateSummary();
    }

    // ---------- Simplified Demand Calculator overlay -----------------------
    function openDC() {
        const ov = document.getElementById('mDCOverlay');
        if (!ov) return;
        renderDC();
        ov.classList.remove('d-none');
    }
    function closeDC() {
        document.getElementById('mDCOverlay')?.classList.add('d-none');
    }
    // Build the airport cards from the saved folder + CNSDemand. Each card
    // shows the airport name, kWh/day (capped to its own contributions),
    // peak power, and the contributing flights — tap a header to expand.
    function renderDC() {
        const list  = document.getElementById('mDCList');
        const empty = document.getElementById('mDCEmpty');
        const folder = CNSDemand.loadFolder();
        list.innerHTML = '';
        if (!folder.length) { empty.classList.remove('d-none'); return; }
        empty.classList.add('d-none');

        const airports = Object.values(CNSDemand.computeAirports());
        const flightsPerDay = t => (t.freqUnit === 'week' ? t.freqN / 7 : t.freqN);

        airports.sort((a, b) =>
            b.contribs.reduce((s, c) => s + flightsPerDay(c.t), 0) -
            a.contribs.reduce((s, c) => s + flightsPerDay(c.t), 0));

        const cfgs = CNSDemand.loadCfg();

        airports.forEach((a, idx) => {
            const ident = a.ident;
            // Energy: sum of base × freq, scaled by Model-settings grid factor
            // so peak/grid numbers respect any active realism factors.
            const gridMul = window.CNSSettings ? CNSSettings.gridDemandFactor() : 1.0;
            let dailyKwh = 0;
            a.contribs.forEach(c => { dailyKwh += (c.base || 0) * flightsPerDay(c.t); });
            const peakKw = (window.CNSScheduler && CNSScheduler.summary
                ? (CNSScheduler.summary(ident).peakKw || 0)
                : 0) * gridMul;

            const flightsRows = a.contribs.map(c => {
                const t = c.t;
                const role = (c.role || '').toUpperCase();
                const route = c.role === 'home'  ? `→ ${c.other} & back`
                            : c.role === 'stop'  ? `on ${c.other}`
                            : `from ${c.other}`;
                return `<div class="m-dc-flight">
                    <span class="lbl"><strong>${role}</strong> · ${t.planeName} · ${t.freqN}/${t.freqUnit}</span>
                    <span class="val">${Math.round((c.base || 0) * flightsPerDay(t))} kWh</span>
                </div>`;
            }).join('');

            const card = document.createElement('div');
            card.className = 'm-dc-card';
            card.innerHTML = `
                <div class="m-dc-card-head" data-toggle="${idx}">
                    <div>
                        <div class="m-dc-name">${a.name}</div>
                        <div class="m-dc-sub">${a.contribs.length} flight contribution${a.contribs.length === 1 ? '' : 's'} · ${ident}</div>
                    </div>
                    <span style="font-size:.9rem; color: var(--muted)">▾</span>
                </div>
                <div class="m-dc-stat">
                    <div><div class="lbl">Daily energy</div><div class="num">${Math.round(dailyKwh * gridMul)} kWh</div></div>
                    <div><div class="lbl">Peak power</div><div class="num">${Math.round(peakKw)} kW</div></div>
                </div>
                <div class="m-dc-flights d-none" data-body="${idx}">${flightsRows}</div>`;
            list.appendChild(card);
        });
        // Expand/collapse per card
        list.querySelectorAll('[data-toggle]').forEach(h => h.addEventListener('click', () => {
            const id = h.dataset.toggle;
            const body = list.querySelector(`[data-body="${id}"]`);
            if (body) body.classList.toggle('d-none');
        }));
    }

    // ---------- Model Settings overlay -------------------------------------
    // Mobile version of the desktop Realism/Model settings modal — same 4
    // factors, simpler chrome. Reads/writes through CNSSettings so changes
    // propagate to the planner + DC overlay live.
    function openSettings()  { syncSettingsUI(); document.getElementById('mSettingsOverlay')?.classList.remove('d-none'); }
    function closeSettings() { document.getElementById('mSettingsOverlay')?.classList.add('d-none'); }
    function syncSettingsUI() {
        if (!window.CNSSettings) return;
        const s = CNSSettings.loadAll();
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
        const sli = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        const lbl = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
        set('mSetLandingReserve', s.landingReserve.enabled);
        sli('mSetLandingSl', Math.round(s.landingReserve.minLandingSoc * 100));
        lbl('mSetLandingVal', `${Math.round(s.landingReserve.minLandingSoc * 100)}%`);
        set('mSetEfficiency', s.chargerEfficiency.enabled);
        sli('mSetEffSl', Math.round(s.chargerEfficiency.value * 100));
        lbl('mSetEffVal', `${Math.round(s.chargerEfficiency.value * 100)}%`);
        set('mSetTaper', s.chargeTaper.enabled);
        set('mSetRouting', s.routingPadding.enabled);
        sli('mSetRoutSl', Math.round(s.routingPadding.factor * 100));
        lbl('mSetRoutVal', `×${s.routingPadding.factor.toFixed(2)}`);
        // Visual emphasis on whichever rows are active.
        document.querySelectorAll('.m-set-row').forEach(r => {
            const cb = r.querySelector('input[type=checkbox]');
            r.classList.toggle('on', cb && cb.checked);
        });
    }
    function wireSettings() {
        const save = (patch) => CNSSettings.save(patch);
        const onChange = (id, fn) => document.getElementById(id)?.addEventListener('change', fn);
        const onInput  = (id, fn) => document.getElementById(id)?.addEventListener('input',  fn);
        onChange('mSetLandingReserve', e => { save({ landingReserve: { enabled: e.target.checked } });    syncSettingsUI(); });
        onInput ('mSetLandingSl',      e => { document.getElementById('mSetLandingVal').textContent = `${e.target.value}%`; });
        onChange('mSetLandingSl',      e => { save({ landingReserve: { minLandingSoc: (+e.target.value) / 100 } }); });
        onChange('mSetEfficiency',     e => { save({ chargerEfficiency: { enabled: e.target.checked } }); syncSettingsUI(); });
        onInput ('mSetEffSl',          e => { document.getElementById('mSetEffVal').textContent = `${e.target.value}%`; });
        onChange('mSetEffSl',          e => { save({ chargerEfficiency: { value: (+e.target.value) / 100 } }); });
        onChange('mSetTaper',          e => { save({ chargeTaper: { enabled: e.target.checked } });       syncSettingsUI(); });
        onChange('mSetRouting',        e => { save({ routingPadding: { enabled: e.target.checked } });    syncSettingsUI(); });
        onInput ('mSetRoutSl',         e => { document.getElementById('mSetRoutVal').textContent = `×${((+e.target.value) / 100).toFixed(2)}`; });
        onChange('mSetRoutSl',         e => { save({ routingPadding: { factor: (+e.target.value) / 100 } }); });
        // When settings change anywhere (programmatic, slider, etc.), refresh
        // the DC overlay if open and the live-route preview.
        if (window.CNSSettings && CNSSettings.subscribe) {
            CNSSettings.subscribe(() => {
                if (!document.getElementById('mDCOverlay').classList.contains('d-none')) renderDC();
                drawLivePreview();
            });
        }
    }

    // ---------- Wire everything --------------------------------------------
    let sheetCtl;
    document.addEventListener('DOMContentLoaded', async () => {
        initMap();
        await loadAirports();
        setupAutocomplete('mOrigin',      'mOriginList',      'origin');
        setupAutocomplete('mDestination', 'mDestinationList', 'destination');
        sheetCtl = initSheet();
        document.getElementById('mSimulateBtn').addEventListener('click', simulate);
        document.getElementById('mResetBtn').addEventListener('click', resetAll);
        document.getElementById('mAddFolderBtn').addEventListener('click', addToDemand);
        document.getElementById('mBackToPlannerBtn').addEventListener('click', backToPlanner);
        document.getElementById('mPlane').addEventListener('change', drawLivePreview);
        document.getElementById('mDCBtn')?.addEventListener('click', openDC);
        document.getElementById('mDCClose')?.addEventListener('click', closeDC);
        document.getElementById('mSettingsBtn')?.addEventListener('click', openSettings);
        document.getElementById('mSettingsClose')?.addEventListener('click', closeSettings);
        document.getElementById('mSetReset')?.addEventListener('click', () => {
            if (window.CNSSettings) { CNSSettings.reset(); syncSettingsUI(); }
        });
        // Wire the Model Settings overlay toggles + sliders.
        wireSettings();
        refreshSimulateButton();
        updateSummary();
        // Async catalog load (custom planes/chargers via the API)
        if (window.CNSPlanes)   { try { await CNSPlanes.load(); }   catch (e) {} }
        if (window.CNSChargers) { try { await CNSChargers.load(); } catch (e) {} }
        // Scheduler needs the charger catalog to compute peak power. Without
        // init it returns 0, which is what the DC overlay was showing.
        if (window.CNSScheduler) {
            const cat = { ...(window.CHARGERS_BY_ID || {}) };
            (CNSChargers?.list?.() || []).forEach(c => { cat[c.id] = c; });
            CNSScheduler.init({ chargers: cat });
        }
    });
})();
