/*
 * CNS Daily Scheduler — per-airport rotation timeline for one operating day.
 * ------------------------------------------------------------------------------
 * Self-contained (easy to debug / extend). Reads trips from
 * localStorage['cns_folder'], per-airport charger config from
 * localStorage['cns_airport_cfg'], and persists desired take-off times to
 * localStorage['cns_schedule'].
 *
 * CORE CONCEPT — a ROTATION:
 *   One lane = one physical aircraft. A ROTATION is its complete, indivisible
 *   cycle: depart → charge at destination → fly back → full recharge at base.
 *
 *   [fly out]──[charge @ dest]──[fly back]──[recharge @ home]
 *
 * TWO HARD CONSTRAINTS, resolved together:
 *   1. Same aircraft can't overlap itself — a lane's rotations are sequential.
 *   2. A charger serves one aircraft at a time — with N chargers at an airport,
 *      at most N can charge simultaneously. If a plane arrives and every charger
 *      is busy it WAITS; the wait ELONGATES that rotation (and pushes the
 *      aircraft's later rotations). Different aircraft may fly at the same time.
 *   Charging order: when several planes compete, the LOWER-CAPACITY aircraft
 *   charges first (quicker charge → frees the charger sooner → offloads the airport).
 *
 * Charge times/energies are sized by the charger the AIRPORT provides (its fleet,
 * assigned via charging.js) — never the trip's own simulation charger.
 */
window.CNSScheduler = (function () {
    const FOLDER_KEY = 'cns_folder', SCHED_KEY = 'cns_schedule', CFG_KEY = 'cns_airport_cfg';
    const DAY_START = 7 * 60, DAY_END = 23 * 60, SPAN = DAY_END - DAY_START;
    const SNAP = 5, PX = 1.05, LANE_H = 46, LABEL_W = 150;

    let catalog = {};
    let onChange = null;

    const loadTrips = () => { try { return JSON.parse(localStorage.getItem(FOLDER_KEY) || '[]'); } catch (e) { return []; } };
    const loadSched = () => { try { return JSON.parse(localStorage.getItem(SCHED_KEY) || '{}'); } catch (e) { return {}; } };
    const saveSched = (s) => localStorage.setItem(SCHED_KEY, JSON.stringify(s));
    const loadCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } };

    const num = (t, k, d = 0) => { const v = Number(t[k]); return isFinite(v) ? v : d; };
    const batteryOf = (t) => t.battery != null ? num(t, 'battery') : 2 * num(t, 'legEnergy');
    const fmtTime = (m) => { const c = Math.max(0, Math.round(m)); return String(Math.floor(c / 60)).padStart(2, '0') + ':' + String(c % 60).padStart(2, '0'); };
    const fmtDur = (min) => { const m = Math.ceil(min - 1e-9) || 0; return m <= 60 ? m + ' min' : (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m / 60}h`); };
    const shorten = (s, n = 16) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');

    function roleAt(trip, ident) {
        if (trip.destIdent === ident) return 'dest';
        if (trip.originIdent === ident && trip.tripType === 'retour') return 'home';
        if (trip.multiLeg && Array.isArray(trip.stops) && trip.stops.some(s => s && s.ident === ident)) return 'stop';
        return null;
    }
    function tripsAt(ident) { return loadTrips().filter(t => roleAt(t, ident)); }

    function energyAt(trip, ident, fullCharge) {
        const leg = num(trip, 'legEnergy'), batt = batteryOf(trip);
        const role = roleAt(trip, ident);
        if (role === 'home') return Math.min(2 * leg, batt);
        if (trip.tripType !== 'retour') return leg;
        return fullCharge ? leg : Math.max(0, 2 * leg - batt);
    }

    // ---------- per-airport charger context (memoised on folder + cfg + realism settings) ----------
    let _stamp = null, _ctx = {};
    function _settingsStamp() {
        // Settings affect every computed phase, so changing them must bust the
        // cache. CNSSettings stores everything under a single key; we hash that.
        return window.CNSSettings ? (localStorage.getItem(CNSSettings.KEY) || '') : '';
    }
    function getContext(ident) {
        const s = (localStorage.getItem(FOLDER_KEY) || '') + '¦' + (localStorage.getItem(CFG_KEY) || '') + '¦' + _settingsStamp();
        if (s !== _stamp) { _stamp = s; _ctx = {}; }
        if (!_ctx[ident]) _ctx[ident] = buildContext(ident);
        return _ctx[ident];
    }
    function buildContext(ident) {
        const cfg = loadCfg()[ident] || {};
        const targetSoc = (window.CNSDemand && CNSDemand.targetSocFromCfg)
            ? CNSDemand.targetSocFromCfg(cfg) : (cfg.fullCharge ? 1.0 : null);
        const trips = tripsAt(ident);
        // Default fleet = union of every distinct charger used by trips touching
        // this airport (so a hub with mixed aircraft doesn't get bottlenecked by
        // the first trip's single charger). User-customised cfg wins.
        const fleetIds = (cfg.chargers && cfg.chargers.length)
            ? cfg.chargers
            : (window.CNSDemand && CNSDemand.defaultChargerFleet
                ? CNSDemand.defaultChargerFleet(trips.map(t => ({ t })))
                : (trips[0] ? [trips[0].chargerId] : []));
        const fleet = fleetIds.map(id => catalog[id]).filter(Boolean);
        // Aircraft list: use the cross-airport-aware energy helper so the
        // charger plan reflects the operator's target-SoC choices on both ends.
        const aircraft = trips.map((t, i) => {
            const plane = (window.PLANES_BY_ID || {})[t.planeId] || t;
            const usable = _usableB({ ...t, planeId: t.planeId }) || batteryOf(t);
            const batt = batteryOf(t);
            const leg = num(t, 'legEnergy') * _route();
            const role = roleAt(t, ident);
            const otherIdent = role === 'home' ? t.destIdent
                             : role === 'dest' ? t.originIdent
                             : null;
            const otherCfg = otherIdent ? (loadCfg()[otherIdent] || null) : null;
            const targetOther = (window.CNSDemand && CNSDemand.targetSocFromCfg)
                ? CNSDemand.targetSocFromCfg(otherCfg) : (otherCfg && otherCfg.fullCharge ? 1.0 : null);
            const energy = (window.CNSDemand && CNSDemand.deliveredEnergy && !t.multiLeg)
                ? CNSDemand.deliveredEnergy(t, role, leg, batt, usable, targetSoc, targetOther)
                : energyAt(t, ident, targetSoc === 1.0);
            return { _i: i, energy, size: batt };
        });
        const powers = {};
        if (window.CNSCharging && fleet.length) {
            const plan = CNSCharging.planCharging(fleet, aircraft);
            trips.forEach((t, i) => { const a = plan.assignments[i]; powers[t.id] = (a && a.power) || 0; });
        } else {
            trips.forEach(t => { powers[t.id] = fleet[0] ? fleet[0].power_kw : 0; });
        }
        return { targetSoc, fullCharge: targetSoc === 1.0, powers, fleetSize: Math.max(1, fleet.length) };
    }
    function fleetSizeAt(ident) { return getContext(ident).fleetSize; }

    // ---------- realism factors (cascade if CNSSettings is loaded) ----------
    const _rs = () => (window.CNSSettings || null);
    const _route   = () => _rs() ? CNSSettings.routingFactor() : 1.0;
    const _usableB = (trip) => {
        if (!_rs()) return batteryOf(trip);
        const plane = (window.PLANES_BY_ID || {})[trip.planeId] || trip;
        return batteryOf(trip) * CNSSettings.usableFraction(plane);
    };
    const _chargeMin = (energy, power, batt) => {
        if (!_rs() || !power) return power ? energy / power * 60 : 0;
        return CNSSettings.chargeTimeMin(energy, power, batt);
    };

    // ---------- rotation timeline (airport-driven charge times; viewIdent flags atX) ----------
    function tripPhases(trip, viewIdent) {
        if (trip.multiLeg) return _multiLegPhases(trip, viewIdent);
        const legs = trip.tripType === 'retour' ? 2 : 1;
        const route = _route();
        const legMin = num(trip, 'flightTimeH') * 60 / legs * route;
        const leg = num(trip, 'legEnergy') * route;
        const batt = batteryOf(trip);
        const usableBatt = _usableB(trip);

        const ph = []; let off = 0;
        ph.push({ kind: 'fly', leg: 'out', start: off, dur: legMin, label: 'Fly to ' + trip.destName }); off += legMin;

        // Energy at each end uses CNSDemand.deliveredEnergy so the cross-airport
        // SoC targets stay consistent with the demand drawer + PDF.
        const dctx = getContext(trip.destIdent);
        const hctx = trip.tripType === 'retour' ? getContext(trip.originIdent) : null;
        const destEnergy = window.CNSDemand && CNSDemand.deliveredEnergy
            ? CNSDemand.deliveredEnergy(trip, 'dest', leg, batt, usableBatt, dctx.targetSoc, hctx ? hctx.targetSoc : null)
            : (trip.tripType === 'retour' ? (dctx.fullCharge ? leg : Math.max(0, 2 * leg - usableBatt)) : leg);
        const destPower = dctx.powers[trip.id] || 0;
        const destMin = _chargeMin(destEnergy, destPower, batt);
        if (destMin > 0) { ph.push({ kind: 'charge', at: 'dest', atX: viewIdent === trip.destIdent, start: off, dur: destMin, power: destPower, energy: destEnergy, label: 'Charge @ ' + trip.destName }); off += destMin; }

        if (trip.tripType === 'retour') {
            ph.push({ kind: 'fly', leg: 'back', start: off, dur: legMin, label: 'Fly back to ' + trip.originName }); off += legMin;
            const homeEnergy = window.CNSDemand && CNSDemand.deliveredEnergy
                ? CNSDemand.deliveredEnergy(trip, 'home', leg, batt, usableBatt, hctx.targetSoc, dctx.targetSoc)
                : Math.min(2 * leg, usableBatt);
            const homePower = hctx.powers[trip.id] || 0;
            const homeMin = _chargeMin(homeEnergy, homePower, batt);
            if (homeMin > 0) { ph.push({ kind: 'charge', at: 'home', atX: viewIdent === trip.originIdent, start: off, dur: homeMin, power: homePower, energy: homeEnergy, label: 'Recharge @ ' + trip.originName }); off += homeMin; }
        }
        return { ph, total: off };
    }

    // Multi-leg trip: walk the backend-precomputed legs[] and charges[]. Each
    // entry in charges[i] is the charge event AT chain[i+1] (= the end of legs[i]).
    // Charge POWER is the per-airport assigned charger (so toggling the airport's
    // fleet updates the rotation live), but the energy is what _simulate_multi
    // computed when the trip was added.
    function _multiLegPhases(trip, viewIdent) {
        const ph = []; let off = 0;
        const legs = Array.isArray(trip.legs) ? trip.legs : [];
        const charges = Array.isArray(trip.charges) ? trip.charges : [];
        const route = _route();
        const batt = batteryOf(trip);
        const usableBatt = _usableB(trip);
        // Recompute per-stop charge energies using the per-airport SoC targets
        // (cascades through every downstream stop in one forward walk).
        const liveCharges = (window.CNSDemand && CNSDemand.recomputeMultiLegCharges)
            ? CNSDemand.recomputeMultiLegCharges(trip, (id) => {
                const c = loadCfg()[id];
                return (window.CNSDemand.targetSocFromCfg ? CNSDemand.targetSocFromCfg(c) : (c && c.fullCharge ? 1.0 : null));
              }, usableBatt)
            : charges;
        legs.forEach((leg, i) => {
            const legMin = (Number(leg.flight_time_h) || 0) * 60 * route;
            const toName = (leg.to && leg.to.name) || '';
            ph.push({ kind: 'fly', leg: i, start: off, dur: legMin, label: 'Fly to ' + toName });
            off += legMin;
            const c = liveCharges[i] || charges[i];
            if (!c) return;
            const ctx = getContext(c.ident);
            const power = ctx.powers[trip.id] || 0;
            const energy = Number(c.energy_kwh) || 0;     // already recomputed with route + targets
            const dur = _chargeMin(energy, power, batt);
            if (dur > 0) {
                ph.push({
                    kind: 'charge', at: c.role,
                    atX: viewIdent === c.ident,
                    atIdx: i + 1,                        // chain index — used by animation.js to position the plane
                    start: off, dur, power, energy,
                    label: 'Charge @ ' + c.name
                });
                off += dur;
            }
        });
        return { ph, total: off };
    }
    function phasesAnim(trip) { return tripPhases(trip, null); }
    function rotationLength(trip) { return tripPhases(trip, null).total || 30; }

    function instancesPerDay(trip) {
        const n = num(trip, 'freqN', 1);
        return trip.freqUnit === 'week' ? Math.max(1, Math.round(n / 7)) : Math.max(1, Math.round(n));
    }

    // Take-off times are stored 1:1 with what's displayed (no hidden re-sequencing —
    // that caused drift). Defaults are laid out back-to-back; thereafter the
    // slot-based drag keeps a lane's rotations from ever overlapping.
    function instanceStarts(trip) {
        const dur = rotationLength(trip);
        const sched = loadSched();
        const n = instancesPerDay(trip);
        let arr = sched[trip.id];
        if (!Array.isArray(arr) || arr.length !== n) {
            arr = []; for (let k = 0; k < n; k++) arr.push(Math.min(DAY_END, DAY_START + k * dur));
            sched[trip.id] = arr; saveSched(sched);
        }
        return arr.slice();
    }

    // ---------- charger queue: assign charges to N chargers, lower-capacity first ----------
    function simulateChargers(events, N) {
        const waits = {};
        if (!events.length) return waits;
        const n = Math.max(1, N);
        const free = new Array(n).fill(-Infinity);
        const done = new Set();
        while (done.size < events.length) {
            let ci = 0; for (let i = 1; i < n; i++) if (free[i] < free[ci]) ci = i;
            const cf = free[ci];
            const pending = events.filter(e => !done.has(e.key));
            const readyNow = pending.filter(e => e.ready <= cf);
            const job = readyNow.length
                ? readyNow.sort((a, b) => a.cap - b.cap || a.ready - b.ready)[0]   // lower capacity charges first
                : pending.sort((a, b) => a.ready - b.ready)[0];
            const start = Math.max(job.ready, cf);
            waits[job.key] = start - job.ready;
            free[ci] = start + job.dur;
            done.add(job.key);
        }
        return waits;
    }

    // Resolve an airport: take-offs + per-instance charge wait, honouring both
    // same-aircraft sequencing and charger occupancy (fixed-point iteration).
    let _resStamp = null, _resCache = {};
    function resolveAirport(ident) {
        const stamp = (localStorage.getItem(FOLDER_KEY) || '') + '¦' + (localStorage.getItem(CFG_KEY) || '') + '¦' + (localStorage.getItem(SCHED_KEY) || '') + '¦' + _settingsStamp();
        if (stamp !== _resStamp) { _resStamp = stamp; _resCache = {}; }
        if (_resCache[ident]) return _resCache[ident];

        const N = fleetSizeAt(ident);
        // A multi-leg trip can have MULTIPLE atX charges per rotation (a retour stop
        // visited outbound + return = 2 charges at the same airport). Each lane
        // therefore carries an array of atX charges; the queue and the cascade fan
        // out over (instance k) × (charge ci).
        //
        // SEMANTIC SPLIT: a lane represents one AIRCRAFT. For retour and training
        // trips the same aircraft can do multiple rotations in a day (it returns
        // home each time). For one-way trips the plane lands at the destination
        // and stays — each flight in a freq>1 one-way schedule therefore needs a
        // separate aircraft, i.e. its own lane. We split here.
        const lanes = [];
        tripsAt(ident).forEach(t => {
            const { ph, total } = tripPhases(t, ident);
            const atXCharges = [];
            ph.forEach(p => {
                if (p.kind === 'charge' && p.atX) atXCharges.push({ offset: p.start, dur: p.dur, power: p.power });
            });
            const starts = instanceStarts(t);
            const isOneWay = t.tripType === 'one-way';
            if (isOneWay && starts.length > 1) {
                // One lane per flight (= per aircraft). Carry the plane index so
                // the renderer can label it "plane 1 of N".
                starts.forEach((d, k) => {
                    lanes.push({
                        trip: t, ph, total, atXCharges,
                        cap: batteryOf(t), desired: [d],
                        planeIdx: k + 1, planeTotal: starts.length, schedSlot: k,
                    });
                });
            } else {
                lanes.push({ trip: t, ph, total, atXCharges, cap: batteryOf(t), desired: starts });
            }
        });
        const keyOf = (li, k) => li + ':' + k;
        const evKey = (li, k, ci) => keyOf(li, k) + ':' + ci;

        const takeoffs = {};
        lanes.forEach((L, li) => L.desired.forEach((d, k) => { takeoffs[keyOf(li, k)] = d; }));
        let waits = {};
        for (let it = 0; it < 6; it++) {
            // 1) charger queue — each atX charge in each instance is one event.
            //    Its `ready` time accumulates the waits of prior charges in the same
            //    rotation (since each wait pushes the rest of the chain right).
            const events = [];
            lanes.forEach((L, li) => {
                if (!L.atXCharges.length) return;
                L.desired.forEach((d, k) => {
                    let cumWait = 0;
                    L.atXCharges.forEach((ch, ci) => {
                        if (ch.dur <= 0) return;
                        events.push({ key: evKey(li, k, ci), ready: takeoffs[keyOf(li, k)] + ch.offset + cumWait, dur: ch.dur, cap: L.cap });
                        cumWait += (waits[evKey(li, k, ci)] || 0);
                    });
                });
            });
            const newWaits = simulateChargers(events, N);
            // 2) cascade: a lane's rotation footprint = canonical total + ALL its waits.
            let moved = false;
            lanes.forEach((L, li) => {
                const order = [...L.desired.keys()].sort((a, b) => L.desired[a] - L.desired[b]);
                let prevEnd = -Infinity;
                order.forEach(k => {
                    const totalWait = L.atXCharges.reduce((s, _ch, ci) => s + (newWaits[evKey(li, k, ci)] || 0), 0);
                    const foot = L.total + totalWait;
                    const st = Math.max(L.desired[k], prevEnd);
                    if (Math.abs((takeoffs[keyOf(li, k)] || 0) - st) > 0.01) moved = true;
                    takeoffs[keyOf(li, k)] = st; prevEnd = st + foot;
                });
            });
            waits = newWaits;
            if (!moved) break;
        }

        const res = { lanes, takeoffs, waits, keyOf, evKey };
        _resCache[ident] = res;
        return res;
    }

    function summary(ident) {
        const { lanes, takeoffs, waits, keyOf, evKey } = resolveAirport(ident);
        const evs = [];
        let latest = DAY_START;
        lanes.forEach((L, li) => {
            L.desired.forEach((d, k) => {
                const to = takeoffs[keyOf(li, k)];
                // accumulate prior waits in this rotation so each charge sits at the right slot
                let cumWait = 0;
                L.atXCharges.forEach((ch, ci) => {
                    const w = waits[evKey(li, k, ci)] || 0;
                    if (ch.dur > 0 && ch.power) {
                        const cs = to + ch.offset + cumWait + w;
                        evs.push({ tm: cs, d: ch.power });
                        evs.push({ tm: cs + ch.dur, d: -ch.power });
                    }
                    cumWait += w;
                });
                const end = to + L.total + cumWait;
                if (end > latest) latest = end;
            });
        });
        evs.sort((a, b) => a.tm - b.tm || a.d - b.d);
        let cur = 0, peak = 0;
        evs.forEach(e => { cur += e.d; if (cur > peak) peak = cur; });
        return { peakKw: peak, latestEnd: latest, overflow: latest > DAY_END };
    }
    function peakPowerKw(ident) { return summary(ident).peakKw; }

    // ---------- rendering ----------
    function renderInto(container, ident) {
        if (!container) return;
        const res = resolveAirport(ident);
        container.innerHTML = '';
        if (!res.lanes.length) { container.innerHTML = '<p class="text-muted small mb-0">No flights touch this airport yet.</p>'; return; }

        const sched = loadSched();
        const ids = new Set(loadTrips().map(t => t.id));
        let pruned = false;
        Object.keys(sched).forEach(k => { if (!ids.has(k)) { delete sched[k]; pruned = true; } });
        if (pruned) saveSched(sched);

        const legend = document.createElement('div');
        legend.className = 'est-note mb-2';
        legend.innerHTML =
            'Each bar is one <strong>rotation</strong> (a single aircraft: depart → charge → return → recharge). Same aircraft can\'t overlap itself; a charger serves one plane at a time. Drag to reschedule.<br>' +
            '<span style="display:inline-block;width:11px;height:11px;background:#0d6efd;border-radius:2px;vertical-align:middle"></span> flying' +
            ' &nbsp;<span style="display:inline-block;width:11px;height:11px;background:#198754;border-radius:2px;vertical-align:middle"></span> charging here' +
            ' &nbsp;<span style="display:inline-block;width:11px;height:11px;background:#9bd3ad;border-radius:2px;vertical-align:middle"></span> charging elsewhere' +
            ' &nbsp;<span style="display:inline-block;width:11px;height:11px;background:repeating-linear-gradient(45deg,#f0ad4e,#f0ad4e 3px,#fbe4c4 3px,#fbe4c4 6px);border-radius:2px;vertical-align:middle"></span> waiting for charger';
        container.appendChild(legend);

        // extend the timeline if cascaded rotations spill past 23:00, so none get clipped
        let maxMin = DAY_END;
        res.lanes.forEach((L, li) => L.desired.forEach((d, k) => {
            const totalWait = L.atXCharges.reduce((s, _ch, ci) => s + (res.waits[res.evKey(li, k, ci)] || 0), 0);
            const end = res.takeoffs[res.keyOf(li, k)] + L.total + totalWait;
            if (end > maxMin) maxMin = end;
        }));
        const lastHour = Math.min(30, Math.max(23, Math.ceil(maxMin / 60)));

        const scroll = document.createElement('div');
        scroll.style.overflowX = 'auto';
        const inner = document.createElement('div');
        inner.style.minWidth = (LABEL_W + (lastHour * 60 - DAY_START) * PX + 16) + 'px';
        inner.style.position = 'relative';

        const axis = document.createElement('div');
        axis.style.cssText = `position:relative;height:16px;margin-left:${LABEL_W}px`;
        for (let h = 7; h <= lastHour; h++) {
            const x = (h * 60 - DAY_START) * PX;
            const lbl = document.createElement('div');
            lbl.textContent = String(h).padStart(2, '0');
            lbl.style.cssText = `position:absolute;left:${x}px;top:0;font-size:.65rem;color:#999;transform:translateX(-50%)`;
            axis.appendChild(lbl);
        }
        inner.appendChild(axis);

        const chart = document.createElement('div');
        chart.style.cssText = `position:relative;height:${res.lanes.length * LANE_H}px;border:1px solid #eee;border-radius:6px`;
        for (let h = 7; h <= lastHour; h++) {
            const x = LABEL_W + (h * 60 - DAY_START) * PX;
            const line = document.createElement('div');
            line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#f1f1f1`;
            chart.appendChild(line);
        }

        res.lanes.forEach((L, li) => {
            const trip = L.trip;
            const role = roleAt(trip, ident);
            const roleLabel = role === 'home' ? 'home' : role === 'stop' ? 'stop' : 'arrival';
            const lane = document.createElement('div');
            lane.style.cssText = `position:absolute;left:0;right:0;top:${li * LANE_H}px;height:${LANE_H}px;border-top:${li ? '1px solid #f4f4f4' : 'none'}`;

            const label = document.createElement('div');
            label.title = `${trip.originName} → ${trip.destName} (${trip.planeName})`;
            label.style.cssText = `position:absolute;left:0;width:${LABEL_W}px;height:100%;padding:4px 8px;box-sizing:border-box;overflow:hidden;font-size:.74rem;line-height:1.15`;
            // For split one-way lanes (one aircraft per flight) the sub-label
            // shows "aircraft k of N" instead of "N/day" — clearer that each
            // bar represents a distinct plane, not a repeated rotation.
            const subRight = L.planeIdx
                ? `aircraft ${L.planeIdx} of ${L.planeTotal}`
                : `${L.desired.length}/day`;
            label.innerHTML = `<div style="font-weight:600">${shorten(trip.originName)} → ${shorten(trip.destName)}</div>` +
                `<div class="text-muted" style="font-size:.68rem">${trip.planeName} · ${roleLabel}${trip.multiLeg ? ' · multi-leg' : ''} · ${subRight}</div>`;
            lane.appendChild(label);

            const track = document.createElement('div');
            track.style.cssText = `position:absolute;left:${LABEL_W}px;right:0;top:0;bottom:0`;
            L.desired.forEach((d, k) => {
                const takeoff = res.takeoffs[res.keyOf(li, k)];
                let iph = L.ph;
                // For each atX charge in this rotation, insert a wait phase before it
                // if the queue says so (multi-leg trips can have multiple atX charges).
                const atXIdxs = [];
                L.ph.forEach((p, i) => { if (p.kind === 'charge' && p.atX) atXIdxs.push(i); });
                let anyWait = false;
                for (let ci = 0; ci < atXIdxs.length; ci++) {
                    if ((res.waits[res.evKey(li, k, ci)] || 0) > 0) { anyWait = true; break; }
                }
                if (anyWait) {
                    iph = L.ph.map(p => ({ ...p }));
                    const origLen = iph.length;
                    atXIdxs.forEach((origChIdx, ci) => {
                        const w = res.waits[res.evKey(li, k, ci)] || 0;
                        if (w <= 0) return;
                        const cs = iph[origChIdx].start;             // already shifted by any prior waits
                        for (let i = origChIdx; i < origLen; i++) iph[i].start += w;
                        iph.push({ kind: 'wait', start: cs, dur: w, label: 'Waiting for free charger' });
                    });
                }
                // For split one-way lanes (planeIdx set), the original schedule
                // slot is in L.schedSlot — passing `k` (always 0 for split lanes)
                // would clobber slot 0 every time the user drags any of the planes.
                const schedSlot = (L.schedSlot != null) ? L.schedSlot : k;
                track.appendChild(buildInstance(trip, schedSlot, takeoff, iph));
            });
            lane.appendChild(track);
            chart.appendChild(lane);
        });

        inner.appendChild(chart);
        scroll.appendChild(inner);
        container.appendChild(scroll);
    }

    function buildInstance(trip, idx, start, ph) {
        const total = ph.reduce((m, p) => Math.max(m, p.start + p.dur), 0) || 30;
        const inst = document.createElement('div');
        inst.style.cssText = `position:absolute;top:9px;height:28px;width:${total * PX}px;cursor:grab;touch-action:none`;
        inst._start = start;

        ph.forEach(p => {
            const bar = document.createElement('div');
            let bg = '#0d6efd';
            if (p.kind === 'charge') bg = p.atX ? '#198754' : '#9bd3ad';
            if (p.kind === 'wait') bg = 'repeating-linear-gradient(45deg,#f0ad4e,#f0ad4e 4px,#fbe4c4 4px,#fbe4c4 8px)';
            bar.style.cssText = `position:absolute;top:0;height:100%;left:${p.start * PX}px;width:${Math.max(2, p.dur * PX)}px;background:${bg};border-radius:3px;border:1px solid rgba(0,0,0,.12)`;
            inst.appendChild(bar);
        });

        const place = (s) => {
            inst.style.left = ((s - DAY_START) * PX) + 'px';
            const overflow = (s + total) > DAY_END;
            inst.style.outline = overflow ? '2px solid #dc3545' : 'none';
            const lines = [`${trip.originName} → ${trip.destName} — rotation`, `Take-off ${fmtTime(s)}`];
            ph.slice().sort((a, b) => a.start - b.start).forEach(p => {
                const icon = p.kind === 'fly' ? '✈' : (p.kind === 'wait' ? '⏳' : '⚡');
                lines.push(`${icon} ${p.label}: ${fmtDur(p.dur)} (${fmtTime(s + p.start)}–${fmtTime(s + p.start + p.dur)})`);
            });
            if (overflow) lines.push('⚠ extends past 23:00 closing time');
            inst.title = lines.join('\n');
        };
        place(start);

        inst.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            try { inst.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            inst.style.cursor = 'grabbing'; inst.style.opacity = '.85'; inst.style.zIndex = '5';

            // Free move; on release the lane re-cascades so rotations slide along and
            // never overlap (a single aircraft can't be in two states at once).
            const startX = e.clientX, origStart = inst._start;
            const move = (ev) => {
                let s = origStart + (ev.clientX - startX) / PX;
                s = Math.max(DAY_START, Math.min(DAY_END, Math.round(s / SNAP) * SNAP));
                inst._start = s; place(s);
            };
            const up = () => {
                inst.style.cursor = 'grab'; inst.style.opacity = '1'; inst.style.zIndex = '';
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                const s2 = loadSched();
                if (!Array.isArray(s2[trip.id])) s2[trip.id] = [];
                s2[trip.id][idx] = inst._start; saveSched(s2);
                if (onChange) onChange();   // re-cascade lane + recompute charger waits / peak
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        });
        return inst;
    }

    function init(opts) {
        opts = opts || {};
        catalog = opts.chargers || {};
        onChange = opts.onChange || null;
        _stamp = null; _ctx = {}; _resStamp = null; _resCache = {};
    }

    return { init, renderInto, peakPowerKw, summary, tripsAt, phasesAnim, instanceStarts, roleAt, resolveAirport, tripPhases, DAY_START, DAY_END, SPAN };
})();
