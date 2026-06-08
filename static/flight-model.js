/*
 * CNSFlight — the unified flight engine.  simulateTrip(plane, waypoints, opts) -> FlightProfile
 * ---------------------------------------------------------------------------------------------
 * One pure forward-SoC walk that every view READS (no DOM / localStorage / fetch). Layered on
 * settings.js + routing.js. Replaces the divergent math in sim.py / scheduler.js+demand.js /
 * index.html _legEst / report.js.  Built to docs/unified-flight-model-decisions.md (G1, R1-R12):
 *
 *   R1  engine OWNS waypoint expansion — caller passes origin+stops+dest (never pre-mirrored);
 *       the engine derives the retour return leg + the training loop from opts.tripType.
 *   D6  origin/base departs at 100%; the terminus (one-way dest / retour home / training origin)
 *       always recharges to 100%; the charge target governs ONLY away-from-base intermediate stops.
 *   R2  per-node target via opts.getTargetSoc(ident) -> 0..1 | null  (keys by ident; twice-visited ok).
 *   R5  padding is the FLOWN path: leg ENERGY + TIME are x routingFactor; geographic DISTANCE is not.
 *       over-range when padded leg energy > usable battery (flagged, never aborted — R6).
 *   R3  charge time here is a preview/TEMPLATE (chargeTimeMin); the DES re-sizes per claimed charger.
 *   R8  reserve/usable from the global CNSSettings.usableFraction only.
 *   R9  no 'charge <= previous leg' clamp — a terminal top-up may exceed the last leg (carried deficit).
 *
 * FlightProfile (units explicit):
 *   { tripType, multiLeg, training, battery_kwh, usable_kwh, reserve_kwh, availRangeKm,
 *     routingFactor, gridDemandFactor,
 *     nodes:   [{ ident,name,lat,lon, role, departSocFrac, billable }],   // role 'origin' billable:false
 *     legs:    [{ fromIdent,fromName,toIdent,toName, rawKm, distKm, flightMin, energyKwh,   // rawKm=great-circle; distKm=ROUTED (rawKm*pad)
 *                 socStartFrac, socEndFrac, overRange, legIndex }],   // routing padding lands on distKm, so energyKwh==ePerKm*distKm & flightMin==distKm/speed
 *     charges: [{ atIndex, ident,name,lat,lon, role, direction, arrivalSocFrac, targetSocFrac,
 *                 departSocFrac, energyKwh, gridKwh, powerKw, chargeMin, isTerminal }],
 *     phases:  [{ kind:'fly'|'charge', legIndex?, chargeIndex?, start, dur, ident?, label }],
 *     totals:  { rawKm, distKm, flightMin, chargeMin, enRouteMin, terminalMin, travelMin,
 *                energyUsedKwh, gridKwh, avgUsageKwhPer100km },
 *     terminal:{ name,ident, arrivalSocFrac, targetSocFrac, energyKwh, chargeMin },
 *     energyAt(ident)->kWh, errors:[] }
 */
window.CNSFlight = (function () {
    function _settings() { return window.CNSSettings || null; }
    function _routingFactor() { const s = _settings(); return s && s.routingFactor ? s.routingFactor() : 1; }
    function _sidStarKm() { const s = _settings(); return s && s.sidStarPaddingKm ? s.sidStarPaddingKm() : 0; }
    function _usableFraction(plane) { const s = _settings(); return s && s.usableFraction ? s.usableFraction(plane) : 1; }
    function _gridDemandFactor() { const s = _settings(); return s && s.gridDemandFactor ? s.gridDemandFactor() : 1; }
    function _chargeTargetDefault() { const s = _settings(); return s && s.chargeTargetDefault ? s.chargeTargetDefault() : null; }
    function _effectiveChargePower(kw, batt, cr) { const s = _settings(); return (s && s.effectiveChargePower) ? s.effectiveChargePower(kw, batt, cr) : (kw || 0); }
    function _chargeTimeMin(e, kw, batt, soc) { const s = _settings(); return (s && s.chargeTimeMin) ? s.chargeTimeMin(e, kw, batt, soc) : (kw ? 60 * e / kw : 0); }
    function _haversineKm(a, b) {
        if (window.CNSRouting && CNSRouting.haversineKm) return CNSRouting.haversineKm(a, b);
        const R = 6371, toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }
    const _pt = (w) => ({ lat: +w.lat, lon: +w.lon });

    // ---- [R1] expand the caller's origin+stops+dest into the actually-visited chain ----------
    function _expandChain(waypoints, tripType) {
        if (tripType === 'retour') {
            const stops = waypoints.slice(1, -1);
            const back = stops.slice().reverse();
            return waypoints.concat(back, [waypoints[0]]);   // O..stops..D..reversed-stops..O
        }
        return waypoints.slice();                            // one-way: O..stops..D  (training handled separately)
    }

    function simulateTrip(plane, waypoints, opts) {
        opts = opts || {};
        const tripType = opts.tripType || 'one-way';
        const training = tripType === 'training';
        const route = _routingFactor();
        const sidStar = _sidStarKm();                                 // fixed km added to EACH leg (SID/STAR); 0 when off
        const grid = _gridDemandFactor();
        const batt = Math.max(0, +plane.battery_kwh || 0);
        const range = Math.max(0, +plane.range_km || 0);
        const speed = Math.max(0, +plane.speed_kmh || 0);
        const usableFrac = _usableFraction(plane);
        const usable = batt * usableFrac;
        const reserve = batt - usable;
        const ePerKm = range > 0 ? batt / range : 0;
        const cRate = plane.c_rate;                                   // vestigial; effectiveChargePower handles null
        const availRangeKm = (range > 0 && route > 0) ? Math.max(0, range * usableFrac - sidStar) / route : 0;   // geographic reach (fixed SID/STAR pad eats into it before routing scales)
        const getTarget = (typeof opts.getTargetSoc === 'function') ? opts.getTargetSoc : (() => _chargeTargetDefault());
        const getChargerKw = (typeof opts.getChargerKw === 'function') ? opts.getChargerKw : (() => +opts.chargerKw || 0);
        // Interim-deficit charging (per-rotation opts supplied by the scheduler): a shared aircraft
        // flying this route >1x/day may depart a non-first rotation below full, and a non-final rotation
        // tops the terminus only to the away-stop target instead of 100%. Defaults reproduce D6 exactly.
        const departSocFrac = (opts.departSocFrac != null && isFinite(+opts.departSocFrac)) ? Math.max(0, Math.min(1, +opts.departSocFrac)) : 1;
        const terminusToFull = (opts.terminusToFull === false) ? false : true;

        const errors = [];
        const profile = {
            tripType, multiLeg: false, training,
            battery_kwh: batt, usable_kwh: usable, reserve_kwh: reserve, availRangeKm,
            routingFactor: route, sidStarKm: sidStar, gridDemandFactor: grid,
            nodes: [], legs: [], charges: [], phases: [],
            totals: { rawKm: 0, distKm: 0, flightMin: 0, chargeMin: 0, enRouteMin: 0, terminalMin: 0, travelMin: 0, energyUsedKwh: 0, gridKwh: 0, avgUsageKwhPer100km: 0 },
            terminal: null, errors,
        };
        profile.energyAt = function (ident) { return profile.charges.filter(c => c.ident === ident).reduce((s, c) => s + c.energyKwh, 0); };

        // ---- TRAINING: closed loop, one charge at the origin (energy capped at usable; UNpadded per G4a/R7) ----
        if (training) {
            const o = waypoints[0];
            const trainKm = Math.max(0, +opts.trainingRangeKm || +plane.training_range_km || 0);
            const consumed = Math.min(ePerKm * trainKm, usable);     // pattern flight burn (unchanged by charging policy)
            const depart = departSocFrac * batt;                      // departs full (departSocFrac=1) unless an interim rotation
            const arrival = Math.max(0, depart - consumed);
            // terminus: full (default), or — interim rotation (terminusToFull=false) — only enough for the
            // next pattern (= consumed, the route repeats) + reserve, honouring any per-airport target.
            const tgt = getTarget(o.ident);
            const departTo = terminusToFull ? batt
                : Math.min(batt, (tgt != null) ? Math.max(tgt * batt, consumed + reserve) : (consumed + reserve));
            const chargeE = Math.max(0, departTo - arrival);
            const powerKw = _effectiveChargePower(getChargerKw(o.ident), batt, cRate);
            const chargeMin = _chargeTimeMin(chargeE, powerKw, batt, batt > 0 ? arrival / batt : 0);   // [R7] SoC-aware
            const arrFrac = batt > 0 ? arrival / batt : 0;
            const depFrac = batt > 0 ? Math.min(1, departTo / batt) : 0;
            const tgtFrac = terminusToFull ? 1 : (tgt != null ? tgt : depFrac);
            profile.nodes.push({ ident: o.ident, name: o.name, lat: +o.lat, lon: +o.lon, role: 'origin', departSocFrac: departSocFrac, billable: false });
            const flightMin = speed > 0 ? (trainKm * route) / speed * 60 : 0;   // pattern flight time IS padded (flown path)
            profile.legs.push({ fromIdent: o.ident, fromName: o.name, toIdent: o.ident, toName: o.name, rawKm: trainKm, distKm: trainKm, flightMin, energyKwh: consumed, socStartFrac: batt > 0 ? depart / batt : 0, socEndFrac: arrFrac, overRange: consumed > usable + 1e-9, legIndex: 0 });
            profile.charges.push({ atIndex: 0, ident: o.ident, name: o.name, lat: +o.lat, lon: +o.lon, role: 'training', direction: 'out', arrivalSocFrac: arrFrac, targetSocFrac: tgtFrac, departSocFrac: depFrac, energyKwh: chargeE, gridKwh: chargeE * grid, powerKw, chargeMin, isTerminal: true });
            profile.phases.push({ kind: 'fly', legIndex: 0, start: 0, dur: flightMin, ident: o.ident, label: 'Training pattern' });
            if (chargeMin > 0) profile.phases.push({ kind: 'charge', chargeIndex: 0, start: flightMin, dur: chargeMin, ident: o.ident, label: 'Recharge @ ' + o.name });
            profile.totals = { rawKm: trainKm, distKm: trainKm, flightMin, chargeMin, enRouteMin: 0, terminalMin: chargeMin, travelMin: flightMin, energyUsedKwh: consumed, gridKwh: chargeE * grid, avgUsageKwhPer100km: trainKm > 0 ? consumed / (trainKm * route) * 100 : 0 };
            profile.terminal = { name: o.name, ident: o.ident, arrivalSocFrac: arrFrac, targetSocFrac: tgtFrac, energyKwh: chargeE, chargeMin };
            return profile;
        }

        // ---- ONE-WAY / RETOUR: forward-SoC walk over the expanded chain --------------------------
        const chain = _expandChain(waypoints, tripType);
        profile.multiLeg = (waypoints.length > 2);
        const nLegs = chain.length - 1;
        const origin = chain[0];

        // legs: rawKm = great-circle (geographic); distKm = ROUTED length (rawKm * pad).
        // Routing padding lands on the LENGTH; energy + time + reach all derive from the
        // flown distance (single-count), so distKm, energyKwh and flightMin reconcile. (R5)
        for (let i = 0; i < nLegs; i++) {
            const a = chain[i], b = chain[i + 1];
            const rawKm = _haversineKm(_pt(a), _pt(b));          // great-circle (geographic)
            const distKm = rawKm * route + sidStar;              // ROUTED length: airways multiplier, then fixed SID/STAR terminal km
            const energyKwh = ePerKm * distKm;                   // flown — derives from the routed length
            const flightMin = speed > 0 ? distKm / speed * 60 : 0;   // flown — derives from the routed length
            const overRange = energyKwh > usable + 1e-9;          // [R5] padded energy > usable
            if (overRange) errors.push({ kind: 'over-range', legIndex: i, energyKwh, usable });
            profile.legs.push({ fromIdent: a.ident, fromName: a.name, toIdent: b.ident, toName: b.name, rawKm, distKm, flightMin, energyKwh, socStartFrac: 0, socEndFrac: 0, overRange, legIndex: i });
        }
        const retourMidIdx = (tripType === 'retour') ? (waypoints.length - 1) : -1;   // chain index of the turnaround (dest)

        // origin node — departs FULL, billable:false (D6); multi-leg one-way bills no origin charge
        profile.nodes.push({ ident: origin.ident, name: origin.name, lat: +origin.lat, lon: +origin.lon, role: 'origin', departSocFrac: departSocFrac, billable: false });

        let socKwh = departSocFrac * batt;                        // [D6] origin departs full (departSocFrac=1) unless an interim rotation overrides it
        let off = 0;
        for (let i = 0; i < nLegs; i++) {
            const leg = profile.legs[i];
            leg.socStartFrac = batt > 0 ? socKwh / batt : 0;
            profile.phases.push({ kind: 'fly', legIndex: i, start: off, dur: leg.flightMin, ident: leg.toIdent, label: 'Fly to ' + leg.toName });
            off += leg.flightMin;
            const arrival = Math.max(0, socKwh - leg.energyKwh);  // clamp to 0, not reserve
            leg.socEndFrac = batt > 0 ? arrival / batt : 0;

            const node = chain[i + 1];
            const isTerminal = (i === nLegs - 1);
            let departTo;
            if (isTerminal && terminusToFull) {
                departTo = batt;                                  // [D6] terminus fills to 100%
            } else {
                // A non-terminal stop charges for the NEXT leg; an interim terminus (terminusToFull=false,
                // the route repeats) charges for the next FLIGHT = this trip's first leg. Both honour the target.
                const nextLeg = isTerminal ? profile.legs[0].energyKwh : profile.legs[i + 1].energyKwh;
                const tgt = getTarget(node.ident);
                departTo = (tgt != null) ? Math.max(tgt * batt, nextLeg + reserve) : (nextLeg + reserve);
                departTo = Math.min(departTo, batt);
            }
            const chargeE = Math.max(0, departTo - arrival);      // [R9] no clamp to prev leg
            const isReturn = (retourMidIdx >= 0) && (i + 1 > retourMidIdx);
            const role = isTerminal ? (tripType === 'retour' ? 'home' : 'dest')
                       : (i + 1 === retourMidIdx ? 'dest' : 'stop');
            const powerKw = _effectiveChargePower(getChargerKw(node.ident), batt, cRate);
            const chargeMin = _chargeTimeMin(chargeE, powerKw, batt, batt > 0 ? arrival / batt : 0);   // [R7] SoC-aware
            const targetFrac = (isTerminal && terminusToFull) ? 1 : (getTarget(node.ident) != null ? getTarget(node.ident) : (batt > 0 ? Math.min(1, departTo / batt) : 0));
            profile.charges.push({
                atIndex: i + 1, ident: node.ident, name: node.name, lat: +node.lat, lon: +node.lon,
                role, direction: isReturn ? 'back' : 'out',
                arrivalSocFrac: batt > 0 ? arrival / batt : 0, targetSocFrac: targetFrac, departSocFrac: batt > 0 ? (arrival + chargeE) / batt : 0,
                energyKwh: chargeE, gridKwh: chargeE * grid, powerKw, chargeMin, isTerminal,
            });
            if (chargeMin > 0) { profile.phases.push({ kind: 'charge', chargeIndex: profile.charges.length - 1, start: off, dur: chargeMin, ident: node.ident, label: (isTerminal && tripType === 'retour' ? 'Recharge @ ' : 'Charge @ ') + node.name }); off += chargeMin; }
            socKwh = arrival + chargeE;
        }

        // ---- totals + terminal ----
        const chargeMins = profile.charges.map(c => c.chargeMin);
        const terminal = profile.charges.length ? profile.charges[profile.charges.length - 1] : null;
        const T = profile.totals;
        T.rawKm = profile.legs.reduce((s, l) => s + l.rawKm, 0);
        T.distKm = profile.legs.reduce((s, l) => s + l.distKm, 0);
        T.flightMin = profile.legs.reduce((s, l) => s + l.flightMin, 0);
        T.chargeMin = chargeMins.reduce((s, m) => s + m, 0);
        T.enRouteMin = chargeMins.slice(0, -1).reduce((s, m) => s + m, 0);
        T.terminalMin = terminal ? terminal.chargeMin : 0;
        T.travelMin = T.flightMin + T.enRouteMin;
        T.energyUsedKwh = profile.charges.reduce((s, c) => s + c.energyKwh, 0);
        T.gridKwh = T.energyUsedKwh * grid;
        T.avgUsageKwhPer100km = T.distKm > 0 ? (T.energyUsedKwh) / T.distKm * 100 : 0;   // distKm already routed -> no extra *route (value unchanged)
        profile.terminal = terminal ? { name: terminal.name, ident: terminal.ident, arrivalSocFrac: terminal.arrivalSocFrac, targetSocFrac: terminal.targetSocFrac, energyKwh: terminal.energyKwh, chargeMin: terminal.chargeMin } : null;
        return profile;
    }

    // ---- saved-trip adapters (shared by the demand drawer + the PDF report) -------
    // Rebuild a FlightProfile for a SAVED folder trip: geometry from persisted coords,
    // plane from the saved spec (R4) or the catalog (planeId), per-AIRPORT target via
    // opts.getTargetSoc. Returns null (caller falls back to the legacy math) when the
    // trip lacks coords or a resolvable plane spec.
    function profileForTrip(trip, opts) {
        opts = opts || {};
        if (!trip || trip.originLat == null || trip.originLon == null) return null;
        try {
            const cat = (window.PLANES_BY_ID || {})[trip.planeId] || {};
            const plane = {
                battery_kwh: trip.battery != null ? trip.battery : cat.battery_kwh,
                range_km: trip.range_km != null ? trip.range_km : cat.range_km,
                speed_kmh: trip.speed_kmh != null ? trip.speed_kmh : cat.speed_kmh,
                c_rate: trip.c_rate,
                training_range_km: trip.trainingRangeKm != null ? trip.trainingRangeKm : cat.training_range_km,
            };
            if (!plane.range_km || !plane.battery_kwh) return null;
            const wp = (x) => ({ ident: x.ident, name: x.name, lat: x.lat, lon: x.lon });
            const o = { ident: trip.originIdent, name: trip.originName, lat: trip.originLat, lon: trip.originLon };
            const d = { ident: trip.destIdent, name: trip.destName, lat: trip.destLat, lon: trip.destLon };
            const stops = (trip.stops || []).map(wp);
            const waypoints = (trip.tripType === 'training') ? [wp(o)] : [wp(o), ...stops, wp(d)];
            return simulateTrip(plane, waypoints, {
                tripType: trip.tripType,
                getTargetSoc: opts.getTargetSoc,
                getChargerKw: opts.getChargerKw || (() => 0),
                trainingRangeKm: plane.training_range_km,
                departSocFrac: opts.departSocFrac,      // per-rotation (scheduler); undefined -> default 1
                terminusToFull: opts.terminusToFull,    // per-rotation (scheduler); undefined -> default true
            });
        } catch (err) { if (window.console) console.warn('[CNSFlight] saved-trip profile failed; legacy fallback:', err); return null; }
    }
    // The charge energy (kWh) a demand contribution draws at its airport, off a profile
    // from profileForTrip. Multi-leg maps by chargeIdx (position-indexed, so a retour stop
    // visited twice resolves); single-leg by role. null -> caller uses the legacy math.
    function chargeEnergyAt(profile, contrib) {
        if (!profile || !contrib) return null;
        const t = contrib.t || {};
        const ch = t.multiLeg
            ? (contrib.chargeIdx != null ? (profile.charges || [])[contrib.chargeIdx] : null)
            : (profile.charges || []).find(x => x.role === contrib.role);
        return ch ? ch.energyKwh : null;
    }

    return { simulateTrip, _expandChain, profileForTrip, chargeEnergyAt };
})();
