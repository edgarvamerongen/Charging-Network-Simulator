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
    function _ruleMode() { const s = _settings(); return s && s.ruleMode ? s.ruleMode() : 'ifr'; }
    function _ifrCapable(plane) { const ps = window.CNSPlaneSchema; return (ps && ps.ifrCapable) ? !!ps.ifrCapable(plane) : true; }
    // Great-circle usable range for a regime: gross×(1−min_soc) − reserve(regime). The min-SoC
    // floor follows the Route-settings slider (minSoc = 1 − usableFraction: default 0.30 —
    // identical to the schema constant — and 0 with the toggle off), so ONE control drives both
    // the energy floor and the reach. Falls back to the old flat usableFraction reach if the
    // schema module isn't loaded (keeps the pre-cutover node harness alive).
    function _usableRangeKm(plane, regime) {
        const ps = window.CNSPlaneSchema; const div = +plane.divert_km || 0;
        if (!(ps && ps.usableRange)) return (+plane.range_km || 0) * _usableFraction(plane);
        const f = _usableFraction(plane);
        return ps.usableRange(plane, regime, null, { alternateKm: div, minSoc: (f > 0 && f <= 1) ? (1 - f) : undefined });
    }
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
        if (tripType === 'circular') {
            return waypoints.concat([waypoints[0]]);         // close the ring: O..stops..D..O
        }
        return waypoints.slice();                            // one-way: O..stops..D  (training handled separately)
    }

    // ---- the single reach seam (P3): planner UI, router and displays all read these ----
    function effectiveRegime(plane, ruleMode) {
        return _ifrCapable(plane) ? (ruleMode || _ruleMode()) : 'vfr';
    }
    // Regime planning range (incl. the IFR flat divert), BEFORE the sidStar/route carve —
    // this is the figure surfaces DISPLAY ("usable range"); never display plane.range_km (gross).
    function planningRangeKm(plane, opts) {
        return _usableRangeKm(plane, effectiveRegime(plane, opts && opts.ruleMode));
    }
    // The reach the router ENFORCES per leg: sidStar carved out, routing factor applied (IFR only).
    function availableRangeKm(plane, opts) {
        const regime = effectiveRegime(plane, opts && opts.ruleMode);
        const route = (regime === 'ifr') ? _routingFactor() : 1.0;
        const sid = (regime === 'ifr') ? _sidStarKm() : 0;
        return (route > 0) ? Math.max(0, _usableRangeKm(plane, regime) - sid) / route : 0;
    }

    function simulateTrip(plane, waypoints, opts) {
        opts = opts || {};
        const tripType = opts.tripType || 'one-way';
        const training = tripType === 'training';
        // VFR/IFR regime — a PROFILE, not just a reserve. Per-route value when given, else the global
        // default; VFR-only aircraft (ifr_capable=false) are forced VFR. Airways padding (routing extension
        // + SID/STAR) is IFR-only; VFR flies near the great-circle, so both drop to identity in VFR.
        const regime = _ifrCapable(plane) ? (opts.ruleMode || _ruleMode()) : 'vfr';
        const route = (regime === 'ifr') ? _routingFactor() : 1.0;    // airways routing extension — IFR only
        const sidStar = (regime === 'ifr') ? _sidStarKm() : 0;        // SID/STAR terminal pad (km/leg) — IFR only
        const grid = _gridDemandFactor();
        const batt = Math.max(0, +plane.battery_kwh || 0);
        const range = Math.max(0, +plane.range_km || 0);
        const speed = Math.max(0, +plane.speed_kmh || 0);
        const usableFrac = _usableFraction(plane);                    // min-SoC floor (battery-health reserve, 30% default) — the chargeable/usable ENERGY
        const usable = batt * usableFrac;                             // usable ENERGY for charge + training caps (down to the floor). The regime hold reserve shortens the REACH (availRangeKm), NOT this — else a short-endurance trainer (Velis) wrongly shows 0 usable.
        const reserve = batt - usable;
        const ePerKm = range > 0 ? batt / range : 0;
        const cRate = plane.c_rate;                                   // vestigial; effectiveChargePower handles null
        const availRangeKm = availableRangeKm(plane, { ruleMode: opts.ruleMode });   // the seam — identical math, one owner. The flat plane.divert_km folds into this reach; per-node alternates count only their excess (routing.js divertExcessKm).
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

        // ---- ONE-WAY / RETOUR / CIRCULAR: forward-SoC walk over the expanded chain ---------------
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
        const turnIdx = (tripType === 'retour' || tripType === 'circular') ? (waypoints.length - 1) : -1;   // chain index of the turnaround (dest); for circular only the closing leg lies past it

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
            const isReturn = (turnIdx >= 0) && (i + 1 > turnIdx);
            const role = isTerminal ? ((tripType === 'retour' || tripType === 'circular') ? 'home' : 'dest')
                       : (i + 1 === turnIdx ? 'dest' : 'stop');
            const powerKw = _effectiveChargePower(getChargerKw(node.ident), batt, cRate);
            const chargeMin = _chargeTimeMin(chargeE, powerKw, batt, batt > 0 ? arrival / batt : 0);   // [R7] SoC-aware
            const targetFrac = (isTerminal && terminusToFull) ? 1 : (getTarget(node.ident) != null ? getTarget(node.ident) : (batt > 0 ? Math.min(1, departTo / batt) : 0));
            profile.charges.push({
                atIndex: i + 1, ident: node.ident, name: node.name, lat: +node.lat, lon: +node.lon,
                role, direction: isReturn ? 'back' : 'out',
                arrivalSocFrac: batt > 0 ? arrival / batt : 0, targetSocFrac: targetFrac, departSocFrac: batt > 0 ? (arrival + chargeE) / batt : 0,
                energyKwh: chargeE, gridKwh: chargeE * grid, powerKw, chargeMin, isTerminal,
            });
            if (chargeMin > 0) { profile.phases.push({ kind: 'charge', chargeIndex: profile.charges.length - 1, start: off, dur: chargeMin, ident: node.ident, label: (isTerminal && (tripType === 'retour' || tripType === 'circular') ? 'Recharge @ ' : 'Charge @ ') + node.name }); off += chargeMin; }
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
    // Resolve the PHYSICS plane for a saved trip. A trip may predate a catalog data
    // revision (e.g. Beta 500 -> 630 kg cutover): for a KNOWN catalog plane (planeId
    // resolves in PLANES_BY_ID) the catalog's range_km/speed_kmh/battery_kwh are
    // authoritative — the trip's own copies are a stale snapshot and are ignored, so
    // old saved flights auto-heal to current physics on recompute. A trip whose planeId
    // does NOT resolve (a CNSPlanes-registered custom plane, or a deleted/unknown one)
    // keeps its own carried physics exactly as before — there is no separate "custom"
    // flag anywhere in the codebase; catalog membership IS the detection (mirrors the
    // cat lookup profileForTrip and report.js._usedPlanes already use). Non-physics
    // fields (training_range_km, c_rate, name, …) keep the trip-first/catalog-fallback
    // precedence unchanged. Catalog extras the schema build-down needs (divert_km,
    // ifr_capable, class, measurements, min_landing_soc, surfaces_ok) ride along from
    // `cat` whenever it resolved, so CNSFlight.planningRangeKm/effectiveRegime on the
    // returned plane see the same inputs the spec card does.
    //
    // The one and only precedence owner for BOTH live consumers (profileForTrip below) and
    // any lighter caller that just needs a resolved plane object (e.g. a future regime chip)
    // — profileForTrip assembles its plane via THIS function, not its own literal, so
    // scheduler.js/report.js/index.html (all going through profileForTrip) see the heal too.
    //
    // trip.battery (NOT trip.battery_kwh) is the real on-the-wire field name: every writer
    // (flight-entry.js:23, index.html:5435/5649, mobile.js:747) persists it as
    // `battery: d.plane.battery_kwh`, and every other reader (demand.js, scheduler.js,
    // report.js) reads `t.battery` — confirmed by grep across the whole codebase.
    function tripPlane(trip) {
        if (!trip) return null;
        const cat = (window.PLANES_BY_ID || {})[trip.planeId] || null;
        const isCat = !!cat;   // known catalog plane -> its physics are authoritative
        return Object.assign({}, cat, {
            id: trip.planeId,
            name: trip.planeName != null ? trip.planeName : (cat && cat.name),
            range_km: isCat ? cat.range_km : (trip.range_km != null ? trip.range_km : (cat && cat.range_km)),
            speed_kmh: isCat ? cat.speed_kmh : (trip.speed_kmh != null ? trip.speed_kmh : (cat && cat.speed_kmh)),
            battery_kwh: isCat ? cat.battery_kwh : (trip.battery != null ? trip.battery : (cat && cat.battery_kwh)),
            c_rate: trip.c_rate != null ? trip.c_rate : (cat && cat.c_rate),
            training_range_km: trip.trainingRangeKm != null ? trip.trainingRangeKm : (cat && cat.training_range_km),
        });
    }

    // Rebuild a FlightProfile for a SAVED folder trip: geometry from persisted coords,
    // plane from the saved spec (R4) or the catalog (planeId), per-AIRPORT target via
    // opts.getTargetSoc. Returns null (caller falls back to the legacy math) when the
    // trip lacks coords or a resolvable plane spec.
    function profileForTrip(trip, opts) {
        opts = opts || {};
        if (!trip || trip.originLat == null || trip.originLon == null) return null;
        try {
            const plane = tripPlane(trip) || {};
            if (!plane.range_km || !plane.battery_kwh) return null;
            const wp = (x) => ({ ident: x.ident, name: x.name, lat: x.lat, lon: x.lon });
            const o = { ident: trip.originIdent, name: trip.originName, lat: trip.originLat, lon: trip.originLon };
            const d = { ident: trip.destIdent, name: trip.destName, lat: trip.destLat, lon: trip.destLon };
            const stops = (trip.stops || []).map(wp);
            const waypoints = (trip.tripType === 'training') ? [wp(o)] : [wp(o), ...stops, wp(d)];
            return simulateTrip(plane, waypoints, {
                tripType: trip.tripType,
                ruleMode: trip.rm || undefined,         // per-route saved regime (C1); absent -> global default
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

    return { simulateTrip, _expandChain, tripPlane, profileForTrip, chargeEnergyAt, effectiveRegime, planningRangeKm, availableRangeKm };
})();
