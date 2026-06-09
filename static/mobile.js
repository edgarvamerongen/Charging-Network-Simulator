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

    // HTML-escape every data string interpolated into innerHTML below. Airport
    // names are server data, but custom aircraft/charger names are user input —
    // escaping keeps a hostile name from becoming markup.
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ---------- State -------------------------------------------------------
    const selected = { origin: null, destination: null };
    let allAirports = [];
    let map = null;
    let routeLayers = [];
    let startMarker = null, endMarker = null;
    let lastResult = null;
    // Marker cluster + zoom/size filter bookkeeping.
    let clusterLayer = null;
    let airportMarkers = [];          // { ap, marker } — built once, added/removed on zoom
    let clusterRefreshTimer = null;
    // Range ring (L.circle around the origin) + its current picker role.
    let rangeRing = null;
    let pickerRole = null;            // 'origin' | 'destination' while #mPicker is open
    let pickerMatches = [];           // current filtered list backing #mPickerList

    // Respect the user's reduced-motion preference for map fly + JS animation.
    const prefersReducedMotion = !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // Single-arg vibrate helper — guarded so unsupported browsers no-op.
    function buzz(pattern) { if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} } }
    // aria-live announcer for screen readers.
    function announce(msg) {
        const el = document.getElementById('mLiveRegion');
        if (el) el.textContent = msg;
    }

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
        // Cluster ~7,800 circle markers (Leaflet.markercluster, loaded before
        // this script) instead of a flat layerGroup. Markers are built once and
        // added/removed from the cluster by a zoom/size filter so dense
        // low-zoom views stay readable and snappy.
        clusterLayer = L.markerClusterGroup({
            chunkedLoading: true,
            showCoverageOnHover: false,
            maxClusterRadius: 50,
            // Reduced-motion: skip the cluster spiderfy/zoom animations.
            animate: !prefersReducedMotion,
        }).addTo(map);
        airportMarkers = [];
        allAirports.forEach(a => {
            if (!isFinite(a.latitude_deg) || !isFinite(a.longitude_deg)) return;
            const m = L.circleMarker([a.latitude_deg, a.longitude_deg], {
                radius: 5, color: '#fff', weight: 1, fillColor: '#ff7800', fillOpacity: .9
            });
            m.on('click', () => openMapPopup(a, m));
            airportMarkers.push({ ap: a, marker: m });
        });
        // Debounced recompute on pan/zoom — only the markers appropriate to the
        // current zoom (by airport `.type`) are kept in the cluster.
        const debounced = () => {
            clearTimeout(clusterRefreshTimer);
            clusterRefreshTimer = setTimeout(refreshClusterMarkers, 150);
        };
        map.on('zoomend', debounced);
        map.on('moveend', debounced);
        refreshClusterMarkers();
    }

    // Decide whether an airport should be visible at the given zoom, keyed off
    // its `.type` field (verified against /api/airports: 'large_airport',
    // 'medium_airport', 'small_airport'; defensive for 'heliport',
    // 'seaplane_base', 'closed' which the European dataset omits).
    function airportVisibleAtZoom(ap, zoom) {
        const t = ap.type || '';
        if (t === 'closed') return zoom >= 11;
        if (t === 'large_airport') return true;                  // always
        if (t === 'medium_airport') return zoom >= 6;
        if (t === 'small_airport') return zoom >= 8;
        if (t === 'heliport' || t === 'seaplane_base') return zoom >= 10;
        // Unknown types: treat like small airports so nothing silently vanishes.
        return zoom >= 8;
    }

    function refreshClusterMarkers() {
        if (!clusterLayer) return;
        const zoom = map.getZoom();
        const add = [], remove = [];
        airportMarkers.forEach(({ ap, marker }) => {
            const want = airportVisibleAtZoom(ap, zoom);
            const has = clusterLayer.hasLayer(marker);
            if (want && !has) add.push(marker);
            else if (!want && has) remove.push(marker);
        });
        if (remove.length) clusterLayer.removeLayers(remove);
        if (add.length) clusterLayer.addLayers(add);
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

    // ---------- Airport picker (full-screen overlay) -----------------------
    // Shared filter predicate over name / municipality / iata — same fields the
    // old autocomplete used. Returns the first 30 matches for a query.
    function filterAirports(q) {
        q = (q || '').trim().toLowerCase();
        if (q.length < 2) return [];
        return allAirports.filter(a =>
            (a.name && a.name.toLowerCase().includes(q)) ||
            (a.municipality && a.municipality.toLowerCase().includes(q)) ||
            (a.iata_code && a.iata_code.toLowerCase() === q)
        ).slice(0, 30);
    }

    // Render matches into #mPickerList reusing the existing .m-ac-item markup
    // (so the row look matches the rest of the app).
    function renderPickerList(matches) {
        const list = document.getElementById('mPickerList');
        if (!list) return;
        pickerMatches = matches;
        list.innerHTML = matches.length
            ? matches.map((a, i) => `<div class="m-ac-item" data-i="${i}"><strong>${esc(a.name)}</strong><small>${esc(a.ident || '')} ${a.municipality ? '· ' + esc(a.municipality) : ''}</small></div>`).join('')
            : '<div class="m-ac-item text-muted">No matches</div>';
    }

    // Open the full-screen picker for a role ('origin' | 'destination').
    function openPicker(role) {
        pickerRole = role;
        const picker = document.getElementById('mPicker');
        const title  = document.getElementById('mPickerTitle');
        const input  = document.getElementById('mPickerInput');
        if (title) title.textContent = role === 'origin' ? 'Set departure' : 'Set destination';
        if (input) input.value = '';
        renderPickerList([]);
        if (picker) picker.classList.remove('d-none');
        // Focus after the overlay paints so the mobile keyboard reliably opens.
        if (input) setTimeout(() => input.focus(), 50);
    }
    function closePicker() {
        pickerRole = null;
        document.getElementById('mPicker')?.classList.add('d-none');
    }

    // Reflect the selected airport into a chip's label/code (chips replaced the
    // removed #mOrigin/#mDestination text inputs).
    function updateChip(role) {
        const chip = document.getElementById(role === 'origin' ? 'mOriginChip' : 'mDestChip');
        if (!chip) return;
        const labelEl = chip.querySelector('.m-chip-label');
        const codeEl  = chip.querySelector('.m-chip-code');
        const ap = selected[role];
        if (ap) {
            if (labelEl) labelEl.textContent = ap.name;
            if (codeEl)  codeEl.textContent  = _shortCode(ap);
            chip.classList.add('is-filled');
            chip.classList.remove('is-placeholder');
        } else {
            if (labelEl) labelEl.textContent = role === 'origin' ? 'Set departure' : 'Set destination';
            if (codeEl)  codeEl.textContent  = '';
            chip.classList.remove('is-filled');
            chip.classList.add('is-placeholder');
        }
    }

    function pickAirport(role, ap) {
        if (!ap) return;
        selected[role] = ap;
        updateChip(role);
        closePicker();
        updateSummary();
        refreshSimulateButton();
        drawLivePreview();
        updateRangeRing();
        // After a pick, rest the sheet at half so the planner is comfortably visible.
        if (sheetCtl) sheetCtl.go(1);
    }

    // Swap origin/destination and re-sync everything that depends on them.
    function swapAirports() {
        const tmp = selected.origin;
        selected.origin = selected.destination;
        selected.destination = tmp;
        updateChip('origin');
        updateChip('destination');
        updateSummary();
        refreshSimulateButton();
        drawLivePreview();
        updateRangeRing();
        buzz(10);
    }

    // ---------- Range ring --------------------------------------------------
    // L.circle around the origin with radius = plane.range_km × 1000 m. Driven
    // by #mRangeToggle, redrawn on origin change and #mPlane change.
    function updateRangeRing() {
        if (rangeRing) { map.removeLayer(rangeRing); rangeRing = null; }
        const toggle = document.getElementById('mRangeToggle');
        if (!toggle || !toggle.checked) return;
        if (!selected.origin) return;
        const plane = (window.PLANES_BY_ID || {})[document.getElementById('mPlane').value];
        if (!plane || !plane.range_km) return;
        rangeRing = L.circle(
            [selected.origin.latitude_deg, selected.origin.longitude_deg],
            { radius: plane.range_km * 1000, className: 'm-range-ring', interactive: false }
        ).addTo(map);
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
            if (idx !== snap) buzz(8);     // haptic tick on snap-state change
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
    // Show an error in the #mError card (text in #mErrorText) and optionally
    // populate the #mErrorActions slot with action buttons. `actions` is an
    // array of { label, onClick }.
    function showError(msg, actions) {
        const card = document.getElementById('mError');
        const txt  = document.getElementById('mErrorText');
        const acts = document.getElementById('mErrorActions');
        if (txt) txt.textContent = msg;
        else if (card) card.textContent = msg;     // defensive fallback
        if (acts) {
            acts.innerHTML = '';
            (actions || []).forEach(a => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'm-btn-secondary';
                b.textContent = a.label;
                b.addEventListener('click', a.onClick);
                acts.appendChild(b);
            });
        }
        if (card) {
            card.classList.remove('d-none');
            // Make sure it's actually seen: open the sheet and scroll to the card
            // (errors otherwise land below the Simulate button, off-screen at half).
            if (sheetCtl) sheetCtl.go(2);
            const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
            requestAnimationFrame(() => card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }));
        }
        announce(msg);
        buzz([12, 60, 12]);
    }
    function clearError() {
        document.getElementById('mError')?.classList.add('d-none');
        const acts = document.getElementById('mErrorActions');
        if (acts) acts.innerHTML = '';
    }
    // Action that opens the aircraft picker so the user can choose a longer-range
    // plane — used by the soft-fail path (no "enable more airport types" copy on
    // mobile, since that control doesn't exist here).
    function focusPlaneAction() {
        return {
            label: 'Change aircraft',
            onClick: () => {
                if (sheetCtl) sheetCtl.go(1);
                const sel = document.getElementById('mPlane');
                if (sel) { sel.focus(); if (sel.showPicker) { try { sel.showPicker(); } catch (e) {} } }
            },
        };
    }

    async function simulate() {
        clearError();
        if (!selected.origin || !selected.destination) return;
        const planeId = document.getElementById('mPlane').value;
        const plane = (window.PLANES_BY_ID || {})[planeId];
        const origin      = { ident: selected.origin.ident,      name: selected.origin.name,      lat: selected.origin.latitude_deg,      lon: selected.origin.longitude_deg };
        const destination = { ident: selected.destination.ident, name: selected.destination.name, lat: selected.destination.latitude_deg, lon: selected.destination.longitude_deg };

        // Auto-plan stops when the direct hop exceeds the aircraft's range.
        // Keeps the mobile UX one-tap: the user picks airports, the planner
        // handles the chain transparently. If routing fails (no reachable
        // intermediate airports) we surface actionable copy — never the old
        // "enable more airport types" line (no such control on mobile).
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
                const planeName = (plane && plane.name) || 'aircraft';
                showError(
                    `A ${planeName} can't reach ${destination.name} (${Math.round(directKm)} km) even with charging stops. Try a longer-range aircraft or a closer destination.`,
                    [focusPlaneAction()]
                );
                buzz([20, 80, 20]);
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

        // Frequency — how often this trip flies (per day / per week).
        const freqN = +(document.getElementById('mFreqN').value || 1);

        const btn = document.getElementById('mSimulateBtn');
        const original = btn.textContent;
        const skeleton = document.getElementById('mResultSkeleton');
        // Reveal the result pane (so the skeleton is visible) and show it during
        // the await; hide on success or error.
        document.getElementById('mPlanner').classList.add('d-none');
        document.getElementById('mResult').classList.remove('d-none');
        if (skeleton) skeleton.classList.remove('d-none');
        btn.disabled = true; btn.textContent = 'Simulating…';
        try {
            const resp = await fetch('/api/simulate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (data.error) {
                if (skeleton) skeleton.classList.add('d-none');
                // Backend rejected the trip — return to the planner and show
                // actionable copy. When it's a reach/range problem, steer the
                // user to a longer-range aircraft (never "enable airport types",
                // which has no control on mobile). Otherwise surface the backend
                // message verbatim.
                document.getElementById('mResult').classList.add('d-none');
                document.getElementById('mPlanner').classList.remove('d-none');
                const planeName = (plane && plane.name) || 'aircraft';
                const rangey = /range|reach|exceed|too long|leg /i.test(data.error || '');
                showError(
                    rangey
                        ? `A ${planeName} can't reach ${destination.name} (${Math.round(directKm)} km) even with charging stops. Try a longer-range aircraft or a closer destination.`
                        : data.error,
                    rangey ? [focusPlaneAction()] : []
                );
                buzz([20, 80, 20]);
                return;
            }
            // Stash inputs on the result for the Add-to-demand handler below.
            data._origin = origin; data._dest = destination;
            data._chargerId = payload.charger_id;
            data._freqN = freqN;
            data._freqUnit = document.getElementById('mFreqUnit').value;
            lastResult = data;
            if (skeleton) skeleton.classList.add('d-none');
            renderResult(data);
            drawSimulatedRoute(data);
            // Bump sheet to full so the result is fully visible.
            sheetCtl.go(2);
            buzz(15);    // success tick
        } catch (e) {
            if (skeleton) skeleton.classList.add('d-none');
            // Back to the planner so the error card is shown in context.
            document.getElementById('mResult').classList.add('d-none');
            document.getElementById('mPlanner').classList.remove('d-none');
            showError('Network error: ' + e.message);
            buzz([20, 80, 20]);
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

        renderStopCards(data);

        // Concise aria-live summary for screen readers.
        const announceStops = isMulti ? stopCount : 0;
        announce(`Route ready: ${announceStops} stop${announceStops === 1 ? '' : 's'}, ${fmtDur(flightMin)}.`);

        updateSummary();
    }

    // Render one .m-stop-card per leg/stop into #mStopCards. Multi-leg uses the
    // backend's per-leg `legs` + `charges`; single-leg synthesises one card for
    // the destination from the per-leg fields. Degrades gracefully when per-leg
    // data is absent (no charger kW / dwell / SoC rows).
    function renderStopCards(data) {
        const host = document.getElementById('mStopCards');
        if (!host) return;
        host.innerHTML = '';
        const powerKw = data.charger?.power_kw || 0;
        const battery = data.plane?.battery_kwh || 0;

        const metaRow = (label, value) =>
            `<div class="m-stop-meta"><span class="lbl">${esc(label)}</span><span class="val">${esc(value)}</span></div>`;

        const cardHtml = (name, code, metas) => `
            <div class="m-stop-card">
                <div class="m-stop-head">
                    <span class="m-stop-name">${esc(name) || '—'}</span>
                    <span class="m-stop-code">${esc(code) || ''}</span>
                </div>
                ${metas.join('')}
            </div>`;

        if (data.multi_leg && Array.isArray(data.charges) && data.charges.length) {
            // One card per charge event (each intermediate stop + destination).
            const legs = Array.isArray(data.legs) ? data.legs : [];
            host.innerHTML = data.charges.map(c => {
                const metas = [];
                if (powerKw) metas.push(metaRow('Charger', `${Math.round(powerKw)} kW`));
                if (isFinite(c.charge_time_min)) metas.push(metaRow('Dwell', fmtDur(c.charge_time_min)));
                // Arrival SoC: battery state on arrival = (battery − energy of the
                // leg that lands here) / battery. legs[i] lands at chain index i+1,
                // so the leg feeding charge at_index k is legs[k-1].
                const legIdx = (c.at_index || 0) - 1;
                const leg = legs[legIdx];
                if (battery && leg && isFinite(leg.energy_kwh)) {
                    const soc = Math.max(0, (battery - leg.energy_kwh) / battery) * 100;
                    metas.push(metaRow('Arrival SoC', `${Math.round(soc)}%`));
                }
                return cardHtml(c.name, _codeFromIdent(c.ident, c.name), metas);
            }).join('');
            return;
        }

        // Single-leg: a single destination card from per-leg fields.
        const dest = data._dest || data.destination || {};
        const metas = [];
        if (powerKw) metas.push(metaRow('Charger', `${Math.round(powerKw)} kW`));
        if (isFinite(data.charge_time_min)) metas.push(metaRow('Dwell', fmtDur(data.charge_time_min)));
        if (battery && isFinite(data.leg_energy_kwh)) {
            const soc = Math.max(0, (battery - data.leg_energy_kwh) / battery) * 100;
            metas.push(metaRow('Arrival SoC', `${Math.round(soc)}%`));
        }
        // Only render a card if we have something meaningful (graceful degrade).
        if (metas.length) {
            host.innerHTML = cardHtml(dest.name, _codeFromIdent(dest.ident, dest.name), metas);
        }
    }

    // Short code from an ident/name (the result payload doesn't carry iata_code
    // for stops, so fall back to ident then first word of the name).
    function _codeFromIdent(ident, name) {
        return (ident || (name || '').split(/\s+/)[0] || '').toUpperCase();
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
        map.fitBounds(
            L.featureGroup([startMarker, endMarker, mainLine].concat(stopMarkers)).getBounds(),
            // Reduced-motion: snap to the bounds without a fly animation.
            { padding: [40, 40], maxZoom: 8, animate: !prefersReducedMotion }
        );
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
        clearError();
        lastResult = null;
        updateSummary();
    }

    function resetAll() {
        selected.origin = null; selected.destination = null;
        // Reset the chips back to their empty labels (text inputs are gone).
        updateChip('origin');
        updateChip('destination');
        clearError();
        lastResult = null;
        backToPlanner();
        clearRoute();
        updateRangeRing();
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
                    <span class="lbl"><strong>${esc(role)}</strong> · ${esc(t.planeName)} · ${esc(t.freqN)}/${esc(t.freqUnit)}</span>
                    <span class="val">${Math.round((c.base || 0) * flightsPerDay(t))} kWh</span>
                </div>`;
            }).join('');

            const card = document.createElement('div');
            card.className = 'm-dc-card';
            card.innerHTML = `
                <div class="m-dc-card-head" data-toggle="${idx}">
                    <div>
                        <div class="m-dc-name">${esc(a.name)}</div>
                        <div class="m-dc-sub">${a.contribs.length} flight contribution${a.contribs.length === 1 ? '' : 's'} · ${esc(ident)}</div>
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

    // ---------- Picker wiring ----------------------------------------------
    // Chips open the full-screen #mPicker; typing filters allAirports; tapping a
    // row calls pickAirport(role, ap).
    function initPicker() {
        const input = document.getElementById('mPickerInput');
        const list  = document.getElementById('mPickerList');
        document.getElementById('mOriginChip')?.addEventListener('click', () => openPicker('origin'));
        document.getElementById('mDestChip')?.addEventListener('click', () => openPicker('destination'));
        document.getElementById('mPickerClose')?.addEventListener('click', closePicker);
        document.getElementById('mSwapBtn')?.addEventListener('click', swapAirports);
        if (input) input.addEventListener('input', () => renderPickerList(filterAirports(input.value)));
        const choose = (e) => {
            const item = e.target.closest('.m-ac-item[data-i]');
            if (!item) return;
            if (e.type === 'touchstart') e.preventDefault();
            pickAirport(pickerRole, pickerMatches[+item.dataset.i]);
        };
        if (list) {
            list.addEventListener('mousedown', choose);
            list.addEventListener('touchstart', choose, { passive: false });
        }
    }

    // ---------- Wire everything --------------------------------------------
    let sheetCtl;
    document.addEventListener('DOMContentLoaded', async () => {
        initMap();
        await loadAirports();
        initPicker();
        sheetCtl = initSheet();
        document.getElementById('mSimulateBtn').addEventListener('click', simulate);
        document.getElementById('mResetBtn').addEventListener('click', resetAll);
        document.getElementById('mAddFolderBtn').addEventListener('click', addToDemand);
        document.getElementById('mBackToPlannerBtn').addEventListener('click', backToPlanner);
        // Aircraft change refreshes both the live preview and the range ring.
        document.getElementById('mPlane').addEventListener('change', () => { drawLivePreview(); updateRangeRing(); });
        // Range-ring toggle.
        document.getElementById('mRangeToggle')?.addEventListener('change', updateRangeRing);
        document.getElementById('mDCBtn')?.addEventListener('click', openDC);
        document.getElementById('mDCClose')?.addEventListener('click', closeDC);
        // DC empty-state CTA → close the overlay and open the planner sheet at half.
        document.getElementById('mDCPlanBtn')?.addEventListener('click', () => { closeDC(); sheetCtl.go(1); });
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
