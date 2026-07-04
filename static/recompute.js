/*
 * CNSRecompute — re-plan saved Demand-Calculator flights under current model
 * settings and recompute feasibility. Pure (no DOM): the caller supplies the
 * airport catalog + per-plane available-range. Depends on CNSRouting, CNSFlight.
 */
window.CNSRecompute = (function () {
    // Copy the planner's _manual flag onto the saved stop objects (which come from
    // /api/simulate and have lost it), matched by ident. EVERY stop is tagged
    // explicitly — manual ones `_manual`, the rest `_auto` — so recomputeFlight can tell
    // a planner-inserted stop (re-plannable) from one the operator chose (preserve). Without
    // the _auto tag a fully-auto route looks "untagged" and gets frozen instead of re-planned.
    function mergeManualFlags(savedStops, plannedStops) {
        const manualIdents = new Set((plannedStops || []).filter(s => s && s._manual).map(s => s.ident));
        return (savedStops || []).map(s => (s && manualIdents.has(s.ident)) ? { ...s, _manual: true } : { ...s, _auto: true });
    }

    // Map an engine profile.charges[] entry to the stored shape computeAirports reads.
    function _storeCharge(ch) {
        return { ident: ch.ident, name: ch.name, lat: ch.lat, lon: ch.lon, role: ch.role, at_index: ch.atIndex, energy_kwh: ch.energyKwh };
    }
    function _storeLeg(l) {
        return { from: { name: l.fromName, ident: l.fromIdent }, to: { name: l.toName, ident: l.toIdent }, distance_km: l.distKm, flight_time_h: (l.flightMin || 0) / 60, energy_kwh: l.energyKwh };
    }

    // Re-plan one saved trip under current settings; return a NEW trip with refreshed
    // route + feasibility. Training/direct skip routing. ctx = { allAirports, planeFor,
    // availableRangeKm, allowedTypes, allowedIdents, routingOptions }.
    function recomputeFlight(trip, ctx) {
        const t = { ...trip };   // full spread carries per-trip fields (rm incl.) across the rebuild, same as _manual on stops
        if (trip.tripType === 'training') { t.feasible = true; t.infeasibleReason = null; return t; }
        const plane = ctx.planeFor(trip);
        const mk = (ident, name, lat, lon) => {
            const full = ident && ctx.allAirports.find(a => a.ident === ident);
            return { ident, name, lat: +lat, lon: +lon, alternate_km: full ? full.alternate_km : undefined };
        };
        const origin = mk(trip.originIdent, trip.originName, trip.originLat, trip.originLon);
        const dest = mk(trip.destIdent, trip.destName, trip.destLat, trip.destLon);
        // Preserve ONLY stops the operator explicitly chose (_manual). Planner-inserted
        // (_auto) and legacy untagged stops are re-planned from scratch, so the recompute
        // produces the same route a fresh planner run would — not a frozen old auto-route.
        const stops = Array.isArray(trip.stops) ? trip.stops : [];
        const manualStops = stops.filter(s => s && s._manual === true)
            .map(s => mk(s.ident, s.name, s.lat, s.lon));

        const chain = window.CNSRouting.planChain({
            origin, dest, manualStops, plane,
            allowedTypes: ctx.allowedTypes, allowedIdents: ctx.allowedIdents,
            allAirports: ctx.allAirports,
            // Forward the planner's routing options (the "Prefer" control → typePenalty), or the
            // recompute diverges from the live planner: a hard-coded {} applies the DEFAULT
            // small-airport penalty, which can push a small-field route over maxStops and wrongly
            // flag a planner-feasible flight as "no route".
            maxLegKm: ctx.availableRangeKm(plane), options: ctx.routingOptions || {},
        });
        if (chain.error) { t.feasible = false; t.infeasibleReason = chain.error; return t; }

        // Circular: also re-plan the CLOSING leg (the loop closes dest → origin;
        // per the ring contract the stored dest is the LAST ring node). New
        // closing auto-stops extend the ring past the current dest, so the
        // stored dest is folded into stops (anchored — it's a kept waypoint)
        // and destIdent/destName shift to the new last ring node.
        let ringDest = dest;
        if (trip.tripType === 'circular') {
            const used = new Set([origin.ident, dest.ident, ...chain.stops.map(s => s && s.ident)].filter(Boolean));
            const seg = window.CNSRouting.planRoute({
                origin: dest, destination: origin, plane,
                allAirports: ctx.allAirports.filter(a => !used.has(a.ident)),
                allowedTypes: ctx.allowedTypes, allowedIdents: ctx.allowedIdents,
                options: Object.assign({}, ctx.routingOptions || {}, { maxLegKm: ctx.availableRangeKm(plane) }),
            });
            if (seg.error) { t.feasible = false; t.infeasibleReason = seg.error; return t; }
            const closing = (seg.stops || []).map(s => ({ ...s, _auto: true }));
            if (closing.length) {
                const ring = [...chain.stops, { ...dest, _manual: true }, ...closing];
                ringDest = ring[ring.length - 1];
                chain.stops = ring.slice(0, -1);
            }
        }

        // Re-derive energy through the SAME client engine the DES/DC display uses.
        const wps = [origin, ...chain.stops, ringDest].map(n => ({ ident: n.ident, name: n.name, lat: n.lat, lon: n.lon }));
        const prof = window.CNSFlight.simulateTrip(plane, wps, {
            tripType: trip.tripType,
            ruleMode: trip.rm || undefined,   // per-route saved regime (C1); absent -> global default
            getTargetSoc: (id) => (window.CNSDemand && window.CNSDemand.resolveTargetSoc) ? window.CNSDemand.resolveTargetSoc((window.CNSDemand.loadCfg && window.CNSDemand.loadCfg()[id]) || null) : null,
            getChargerKw: () => +trip.chargerPower || 0,
        });
        const overLeg = (prof.legs || []).findIndex(l => l.overRange);
        if (overLeg >= 0) {
            t.feasible = false;
            t.infeasibleReason = `leg ${overLeg + 1} exceeds the aircraft's range at the current settings`;
            return t;
        }
        // Persist the refreshed route. Stop coords + tags from the chain; charges/legs from the engine.
        t.stops = chain.stops.map(s => ({ ident: s.ident, name: s.name, lat: s.lat, lon: s.lon, type: s.type, iata_code: s.iata_code || '', _manual: !!s._manual, _auto: !!s._auto }));
        // A circular trip is structurally multi-leg (the closing leg exists even
        // when a replan leaves zero intermediate stops) — every consumer reads
        // its route from charges[]/legs[], which need the multiLeg path.
        t.multiLeg = trip.tripType === 'circular' ? true : chain.stops.length > 0;
        if (ringDest !== dest) {
            t.destIdent = ringDest.ident; t.destName = ringDest.name;
            t.destLat = ringDest.lat; t.destLon = ringDest.lon;
        }
        t.charges = (prof.charges || []).filter(c => (c.energyKwh || 0) > 0).map(_storeCharge);
        t.legs = (prof.legs || []).map(_storeLeg);
        t.legEnergy = (prof.legs && prof.legs[0]) ? prof.legs[0].energyKwh : trip.legEnergy;
        t.feasible = true; t.infeasibleReason = null;
        return t;
    }

    // The queue: recompute every trip (by value) and return the updated list. Pure —
    // the caller persists + re-renders. Any one trip that throws is marked infeasible
    // rather than aborting the whole pass.
    function recomputeAll(trips, ctx) {
        return (trips || []).map(t => {
            try { return recomputeFlight(t, ctx); }
            catch (e) { return { ...t, feasible: false, infeasibleReason: 'recompute error: ' + (e && e.message) }; }
        });
    }

    return { mergeManualFlags, recomputeFlight, recomputeAll };
})();
