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
    //   'origin'   — a one-way departure hub: the aircraft leaves FULL, so it
    //                contributes no charging demand here — listed for completeness.
    //   'stop'     — an intermediate charging stop on a multi-leg trip
    //   null       — this airport isn't touched by the trip
    function roleAt(trip, ident) {
        if (trip.tripType === 'training') {
            return trip.originIdent === ident ? 'training' : null;
        }
        if (trip.destIdent === ident) return 'dest';
        if (trip.originIdent === ident && trip.tripType === 'retour') return 'home';
        if (trip.originIdent === ident) return 'origin';   // one-way departure hub (departs full → 0 charging)
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
        // Group flights into airports by a STABLE key. Normally that key is the
        // ICAO `ident`, which is unique per airport. But if a waypoint ever
        // reaches here WITHOUT an ident (a hand-edited or legacy stop, or a
        // backend stop emitted with no code), an empty ident would make EVERY
        // such airport collapse onto one and the same key — so only the first
        // would ever show and all the others would silently disappear from the
        // calculator. Falling back to the name, then the coordinates, gives each
        // airport its own key. When a real ident is present this is unchanged.
        const keyFor = (ident, name, lat, lon) =>
            (ident && String(ident).trim()) ||
            (name && String(name).trim()) ||
            `@${lat},${lon}`;
        const ensure = (ident, name, lat, lon) => {
            const key = keyFor(ident, name, lat, lon);
            return airports[key] || (airports[key] = { ident: ident || key, name, lat, lon, contribs: [] });
        };

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
                    if (!c) return;   // keep real charge events even if they lack an ident — ensure() keys them by name/coords instead of dropping them
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
                // A one-way departure leaves FULL, so it contributes no CHARGING
                // (the charge is attributed where the plane last landed — a 'dest'
                // contribution — and adding one here would double-count). It still
                // gets a zero-energy 'origin' contribution so the departure hub is
                // listed in the DC with its take-off rotation instead of vanishing.
                // (Retour origins charge as 'home' via the charges loop above.)
                if (t.tripType !== 'retour') {
                    ensure(t.originIdent, t.originName, t.originLat, t.originLon)
                        .contribs.push({ t, role: 'origin', other: t.destName, base: 0 });
                }
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
                // One-way single-leg: the departure leaves FULL, so the arrival top-up
                // at the DEST is the only CHARGING attributed. The origin still gets a
                // zero-energy 'origin' contribution so the departure hub appears in the
                // DC (listed + its take-off rotation) instead of vanishing — no charging,
                // by construction (base 0), so totals are unchanged.
                ensure(t.destIdent, t.destName, t.destLat, t.destLon)
                    .contribs.push({ t, role: 'dest', other: t.originName, base: t.legEnergy });
                ensure(t.originIdent, t.originName, t.originLat, t.originLon)
                    .contribs.push({ t, role: 'origin', other: t.destName, base: 0 });
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

    // Resolve the EFFECTIVE charge target for an airport: the per-airport
    // (LOCAL) target wins; otherwise fall back to the GLOBAL default from model
    // settings. Returns null only when neither is set (chargeTarget factor off)
    // → pure deficit charging, the original behaviour. Energy math uses THIS;
    // the per-airport control keeps reading the raw `targetSocFromCfg` so it can
    // still show "Auto" when no local override exists.
    function resolveTargetSoc(cfg) {
        const local = targetSocFromCfg(cfg);
        if (local != null) return local;
        return (window.CNSSettings && window.CNSSettings.chargeTargetDefault)
            ? window.CNSSettings.chargeTargetDefault() : null;
    }


    return {
        loadFolder, saveFolder, loadCfg, saveCfg,
        flightsPerDay, batteryOf, roleAt, tripsAt, energyAt,
        computeAirports, updateTrip,
        defaultChargerFleet, targetSocFromCfg, resolveTargetSoc,
    };
})();
