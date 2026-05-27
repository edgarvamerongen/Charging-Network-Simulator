/*
 * CNSDemand — the per-airport demand model: pure data + logic, no DOM.
 * --------------------------------------------------------------------
 *   • Folder/cfg storage (saved flights + per-airport charger config).
 *   • Helpers for role/energy a flight contributes at a given airport.
 *   • computeAirports(): groups all saved flights into per-airport demand.
 *
 * This is the layer any future UI (the current vanilla one, React, Svelte)
 * sits on top of. Backend-agnostic; the only inputs are localStorage.
 *
 * Depends on: CNSState (load earlier).
 */
window.CNSDemand = (function () {
    const FKEY = CNSState.KEYS.folder;
    const CKEY = CNSState.KEYS.cfg;

    const loadFolder = () => CNSState.getJSON(FKEY, []);
    const saveFolder = (f) => CNSState.setJSON(FKEY, f);
    const loadCfg = () => CNSState.getJSON(CKEY, {});
    const saveCfg = (c) => CNSState.setJSON(CKEY, c);

    const flightsPerDay = t => t.freqUnit === 'week' ? t.freqN / 7 : t.freqN;

    const numOf = (t, k, d = 0) => { const v = Number(t[k]); return isFinite(v) ? v : d; };
    const batteryOf = (t) => t.battery != null ? numOf(t, 'battery') : 2 * numOf(t, 'legEnergy');

    // Role this trip plays at `ident`:
    //   'training' — training pattern based at this airport (origin = destination)
    //   'dest'     — the trip arrives here (one-way or retour destination)
    //   'home'     — the trip's home base (retour origin only)
    //   'stop'     — an intermediate charging stop on a multi-leg trip
    //   null       — this airport isn't touched by the trip
    function roleAt(trip, ident) {
        if (trip.tripType === 'training') {
            return trip.originIdent === ident ? 'training' : null;
        }
        if (trip.destIdent === ident) return 'dest';
        if (trip.originIdent === ident && trip.tripType === 'retour') return 'home';
        if (trip.multiLeg && Array.isArray(trip.stops) && trip.stops.some(s => s && s.ident === ident)) return 'stop';
        return null;
    }

    function tripsAt(ident) { return loadFolder().filter(t => roleAt(t, ident)); }

    // Energy the airport must deliver per flight (per the relief / fullCharge model).
    // For multi-leg trips, sum the backend-precomputed charges at this airport
    // (a retour symmetric stop is visited twice, so its energy is the sum of both visits).
    function energyAt(trip, ident, fullCharge) {
        if (trip.multiLeg && Array.isArray(trip.charges)) {
            return trip.charges
                .filter(c => c && c.ident === ident)
                .reduce((sum, c) => sum + numOf(c, 'energy_kwh'), 0);
        }
        const leg = numOf(trip, 'legEnergy'), batt = batteryOf(trip);
        const role = roleAt(trip, ident);
        if (role === 'home') return Math.min(2 * leg, batt);
        if (trip.tripType !== 'retour') return leg;     // one-way arrival: a full leg
        return fullCharge ? leg : Math.max(0, 2 * leg - batt);
    }

    // Group every saved flight into the airports it touches, with its base
    // demand contribution at each one. The UI then layers on per-airport
    // charger assignment (charging.js) for charge times + peak.
    function computeAirports() {
        const airports = {};
        const ensure = (ident, name, lat, lon) =>
            airports[ident] || (airports[ident] = { ident, name, lat, lon, contribs: [] });

        loadFolder().forEach(t => {
            // Multi-leg trip: each backend-precomputed charge event becomes one
            // contribution at its airport. A retour stop visited outbound + return
            // is two distinct contributions at the same airport.
            if (t.multiLeg && Array.isArray(t.charges) && t.charges.length) {
                // For retour, charges after the destination are on the return leg —
                // the stop label flips direction so it's clear the plane is heading
                // back. (Energy can also differ between visits because the plane
                // arrives with different remaining battery each time.)
                const nStops = (t.stops || []).length;
                const retourMidIdx = (t.tripType === 'retour') ? nStops + 1 : null;
                t.charges.forEach((c, idx) => {
                    if (!c || !c.ident) return;
                    const a = ensure(c.ident, c.name, c.lat, c.lon);
                    const isReturnVisit = (retourMidIdx !== null) && (Number(c.at_index) > retourMidIdx);
                    const other =
                        c.role === 'home' ? t.destName :
                        c.role === 'dest' ? t.originName :
                        isReturnVisit     ? `${t.destName} → ${t.originName}`
                                          : `${t.originName} → ${t.destName}`;
                    a.contribs.push({
                        t, role: c.role, other,
                        base: numOf(c, 'energy_kwh'),
                        chargeIdx: idx,
                        direction: isReturnVisit ? 'back' : 'out'
                    });
                });
                return;
            }
            // Training path: a single contribution at the home base. The base
            // value is the per-flight recharge already capped at usable battery
            // by sim.py; the role tag drives the demand-drawer label.
            if (t.tripType === 'training') {
                ensure(t.originIdent, t.originName, t.originLat, t.originLon)
                    .contribs.push({ t, role: 'training', other: t.originName, base: numOf(t, 'legEnergy') });
                return;
            }
            // Legacy single-leg path (unchanged behaviour)
            const battery = t.battery ?? t.legEnergy * 2;
            if (t.tripType === 'retour') {
                ensure(t.originIdent, t.originName, t.originLat, t.originLon)
                    .contribs.push({ t, role: 'home', other: t.destName, base: Math.min(2 * t.legEnergy, battery) });
                ensure(t.destIdent, t.destName, t.destLat, t.destLon)
                    .contribs.push({ t, role: 'dest', other: t.originName, base: Math.max(0, 2 * t.legEnergy - battery) });
            } else {
                ensure(t.destIdent, t.destName, t.destLat, t.destLon)
                    .contribs.push({ t, role: 'dest', other: t.originName, base: t.legEnergy });
            }
        });
        return airports;
    }

    function updateTrip(id, patch) {
        const trips = loadFolder();
        const t = trips.find(x => x.id === id);
        if (!t) return;
        Object.assign(t, patch);
        saveFolder(trips);
    }

    // Default charger fleet for an airport, *unless* the user has configured one
    // explicitly. Returns the UNION of every distinct charger used by trips
    // touching this airport — that way a hub serving Pipistrels AND Betas gets
    // BOTH chargers by default, instead of inheriting only the first one
    // (which is what happened pre-fix and caused Beta planes to home-charge on
    // a Pipistrel-grade 40 kW unit).
    function defaultChargerFleet(airportContribs) {
        if (!Array.isArray(airportContribs) || !airportContribs.length) return [];
        const seen = [];
        airportContribs.forEach(c => {
            const id = c && c.t && c.t.chargerId;
            if (id && !seen.includes(id)) seen.push(id);
        });
        return seen;
    }

    // Per-airport "departure SoC target" used by the new slider control. Returns
    // a number in [0,1] when the operator has set a target, or `null` for the
    // default deficit behaviour. Old cfgs with the legacy `fullCharge: true`
    // toggle migrate transparently to `targetDepartureSoc: 1.0`.
    function targetSocFromCfg(cfg) {
        if (!cfg) return null;
        if (cfg.targetDepartureSoc != null && isFinite(+cfg.targetDepartureSoc)) {
            return Math.max(0, Math.min(1, +cfg.targetDepartureSoc));
        }
        if (cfg.fullCharge) return 1.0;
        return null;
    }

    // Energy that THIS airport's chargers deliver per flight, considering the
    // operator-set departure-SoC target at BOTH ends of a retour trip.
    //
    // Inputs:
    //   trip          — the saved trip (uses tripType, multiLeg, etc.)
    //   role          — 'home' | 'dest' | 'stop'
    //   legKwh        — per-leg energy consumed (already padded for routing if applicable)
    //   batteryKwh    — nameplate battery
    //   usableKwh     — battery × usableFraction (battery × (1 − reserve))
    //   targetCurrent — null or 0..1, target at THIS airport
    //   targetOther   — null or 0..1, target at the OTHER airport (for HOME, the dest's target)
    //
    // The retour helper does a full forward-walk of the cycle with BOTH ends'
    // targets clamped to the minimum feasible (dep ≥ leg + reserve). That way
    // arrival SoCs follow physically from the clamped departure SoCs, energy
    // conservation holds (DEST_kWh + HOME_kWh = 2×leg always), AND the slider
    // can't produce an infeasible scenario where the plane departs with less
    // SoC than the next leg requires.
    function deliveredEnergy(trip, role, legKwh, batteryKwh, usableKwh, targetCurrent, targetOther) {
        const leg = Math.max(0, +legKwh || 0);
        const batt = Math.max(0, +batteryKwh || 0);
        const usable = Math.min(batt, Math.max(0, +usableKwh || batt));
        const reserve = batt - usable;

        // Training: pattern loop, energy capped at usable battery (the most you
        // can extract in a single session). Origin charges that back.
        if (trip.tripType === 'training') {
            return Math.min(leg, usable);
        }
        // One-way arrival: airport tops the plane up to the target (default 100%).
        if (trip.tripType !== 'retour') {
            const arrival = Math.max(0, batt - leg);
            const target = (targetCurrent != null ? targetCurrent : 1.0) * batt;
            return Math.max(0, target - arrival);
        }
        // Retour: full forward-walk with clamped targets at BOTH ends.
        const homeTargetRaw = role === 'home' ? targetCurrent : targetOther;
        const destTargetRaw = role === 'dest' ? targetCurrent : targetOther;
        const minDep = leg + reserve;                      // minimum departure SoC at either airport

        // HOME's effective departure SoC. If the operator didn't set a target,
        // default to a full charge. Either way, never below the minimum needed
        // to safely fly the outbound leg.
        const depHome = Math.max((homeTargetRaw != null ? homeTargetRaw : 1.0) * batt, minDep);
        // Arrival at DEST is whatever's left after the outbound leg.
        const arrivalDest = Math.max(0, depHome - leg);
        // DEST's effective departure SoC. If no target, charge ONLY if arrival
        // isn't enough for the return leg + reserve (deficit mode). With a target
        // set, depart at that SoC (still clamped to safe minimum).
        const depDest = destTargetRaw != null
            ? Math.max(destTargetRaw * batt, minDep)
            : Math.max(arrivalDest, minDep);
        const arrivalHome = Math.max(0, depDest - leg);

        if (role === 'dest') return Math.max(0, depDest - arrivalDest);
        if (role === 'home') return Math.max(0, depHome - arrivalHome);
        return leg;
    }

    // Walk a multi-leg trip's chain forward, applying per-airport SoC targets
    // and routing padding live, and return a NEW charges[] array with updated
    // energy_kwh values. The original trip data is left untouched. Used by
    // every multi-leg consumer (demand drawer, scheduler, PDF) so a slider
    // change at one stop propagates correctly through every downstream stop.
    //
    // The forward walk:
    //   • depart origin at full SoC (or origin's target SoC if set)
    //   • for each leg: consume leg energy, arrive at next waypoint
    //   • at each intermediate stop: charge to max(target * batt, next_leg + reserve)
    //   • at the terminal: charge to (target * batt) or full if no target set
    //   • soc_after_charge becomes the departure SoC for the next leg
    //
    // getTargetSoc(ident) → number 0..1 or null  (the caller provides the lookup).
    // usableBattKwh = battery × usableFraction (or just battery if reserves are off).
    function recomputeMultiLegCharges(trip, getTargetSoc, usableBattKwh) {
        if (!trip || !trip.multiLeg) return trip ? trip.charges : null;
        const legs = Array.isArray(trip.legs) ? trip.legs : [];
        const baseCharges = Array.isArray(trip.charges) ? trip.charges : [];
        if (!legs.length || !baseCharges.length) return baseCharges.slice();
        const batt = trip.battery || (trip.legEnergy * 2) || 0;
        if (batt <= 0) return baseCharges.slice();
        const usable = Math.min(batt, Math.max(0, +usableBattKwh || batt));
        const reserve = batt - usable;
        const route = (window.CNSSettings ? CNSSettings.routingFactor() : 1.0);

        // Depart origin at the originating airport's target SoC (default = full).
        const originTarget = getTargetSoc(trip.originIdent);
        let socKwh = (originTarget != null ? originTarget : 1.0) * batt;

        const out = baseCharges.map((c, i) => {
            const legE = ((legs[i] && legs[i].energy_kwh) || 0) * route;
            const arrival = Math.max(0, socKwh - legE);
            const isLast = (i === legs.length - 1);
            const stopTarget = getTargetSoc(c.ident);

            let departure;
            if (isLast) {
                departure = (stopTarget != null ? stopTarget : 1.0) * batt;
            } else {
                const nextLegE = ((legs[i + 1] && legs[i + 1].energy_kwh) || 0) * route;
                const minDeparture = nextLegE + reserve;
                departure = (stopTarget != null ? Math.max(stopTarget * batt, minDeparture) : minDeparture);
            }
            // Plane can't depart with more than full battery.
            departure = Math.min(departure, batt);
            const chargeE = Math.max(0, departure - arrival);
            socKwh = arrival + chargeE;     // next leg's departure SoC

            return { ...c, energy_kwh: +chargeE.toFixed(2) };
        });
        return out;
    }

    return {
        loadFolder, saveFolder, loadCfg, saveCfg,
        flightsPerDay, batteryOf, roleAt, tripsAt, energyAt,
        computeAirports, updateTrip,
        defaultChargerFleet, targetSocFromCfg, deliveredEnergy,
        recomputeMultiLegCharges,
    };
})();
