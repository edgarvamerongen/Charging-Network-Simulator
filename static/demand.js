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
    //   'dest'  — the trip arrives here (one-way or retour destination)
    //   'home'  — the trip's home base (retour origin only)
    //   'stop'  — an intermediate charging stop on a multi-leg trip
    //   null    — this airport isn't touched by the trip
    function roleAt(trip, ident) {
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
                // Keep `other` aligned with the legacy single-leg semantics so
                // renderFolder's row builder reads cleanly. The "multi-leg" suffix
                // in the Trip column already signals the multi-stop nature.
                t.charges.forEach((c, idx) => {
                    if (!c || !c.ident) return;
                    const a = ensure(c.ident, c.name, c.lat, c.lon);
                    const other =
                        c.role === 'home' ? t.destName :
                        c.role === 'dest' ? t.originName :
                                            `${t.originName} → ${t.destName}`;   // 'stop' row reads "on {route}"
                    a.contribs.push({
                        t, role: c.role, other,
                        base: numOf(c, 'energy_kwh'),
                        chargeIdx: idx
                    });
                });
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

    return {
        loadFolder, saveFolder, loadCfg, saveCfg,
        flightsPerDay, batteryOf, roleAt, tripsAt, energyAt,
        computeAirports, updateTrip
    };
})();
