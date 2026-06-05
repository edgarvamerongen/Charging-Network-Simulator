/*
 * CNS charging assignment — FIRST-CUT heuristic.
 * ------------------------------------------------------------------
 * This file is deliberately isolated so the assignment logic is easy to
 * read and replace with something smarter later.
 *
 * Rules implemented here (per spec):
 *   0. MANUAL-FIRST. A flight may pin the charger it uses (forcedChargerId).
 *      Pinned flights are bolted to their charger BEFORE the automatic
 *      heuristic runs, so a user's choice always wins and the two selection
 *      paths never fight over a slot. A pin that names a charger this airport
 *      doesn't have is ignored (the flight falls back to automatic).
 *   1. A charger charges ONE aircraft at a time, and fully
 *      (charge time = energy to add / charger power).
 *   2. Low-power chargers serve low-power (smaller) aircraft; high-power
 *      chargers serve the bigger aircraft. We achieve this by ranking both
 *      lists and pairing biggest-with-biggest, smallest-with-smallest.
 *   3. If there are more aircraft than chargers, aircraft wrap around and
 *      share a charger (this represents sequential / queued charging).
 *
 * Inputs:
 *   chargers : [{ id, name, power_kw }]            the airport's fleet
 *   aircraft : [{ name, energy, size, ...extra }]  one entry per aircraft to charge
 *                - energy : kWh that must be delivered to this aircraft
 *                - size   : ranking key (e.g. battery kWh) — bigger = "higher power"
 *                - forcedChargerId : optional id of a charger in the fleet this
 *                                    flight MUST use (manual override; see rule 0)
 *
 * Output:
 *   {
 *     assignments: [{ aircraft, charger, power, chargeTimeMin }],  // same order as input aircraft
 *     peakPower,   // kW drawn if every in-use charger runs at once. A charger
 *                  // assigned only to a 0-energy aircraft (one that passes through
 *                  // an airport without charging) is NOT "in use" — it draws nothing.
 *     queued,      // how many aircraft exceed the number of chargers
 *     numChargers
 *   }
 */
window.CNSCharging = (function () {
    function planCharging(chargers, aircraft) {
        const sortedChargers = chargers
            .map((c, i) => ({ ...c, _slot: i }))
            .sort((a, b) => b.power_kw - a.power_kw);
        const n = sortedChargers.length;
        // First charger of each id, used to resolve a flight's manual pin.
        const chargerById = {};
        sortedChargers.forEach(c => { if (c.id != null && !(c.id in chargerById)) chargerById[c.id] = c; });

        const assignments = new Array(aircraft.length);
        const usedSlots = new Set();

        // ---- Rule 0: MANUAL-FIRST. Pin flights to their chosen charger before
        // the automatic heuristic touches a slot. A pin naming a charger this
        // airport doesn't have is dropped here, so the flight rejoins the
        // automatic pool below instead of fighting for a non-existent slot.
        const autoOrder = [];
        aircraft.forEach((ac, i) => {
            const forced = ac && ac.forcedChargerId ? chargerById[ac.forcedChargerId] : null;
            if (forced) {
                usedSlots.add(forced._slot);
                const power = forced.power_kw;
                assignments[i] = {
                    aircraft: ac, charger: forced, power, forced: true,
                    chargeTimeMin: power ? (ac.energy / power) * 60 : Infinity
                };
            } else {
                autoOrder.push(i);
            }
        });

        // ---- Rules 2 & 3: AUTOMATIC for everything not pinned. Rank the
        // remaining aircraft biggest-first and pair them with the fleet
        // (wrapping when there are more aircraft than chargers). Original order
        // is remembered so the caller can line assignments back up with its rows.
        const ranked = autoOrder
            .map(i => ({ ac: aircraft[i], i }))
            .sort((x, y) => y.ac.size - x.ac.size);

        ranked.forEach((entry, rank) => {
            const charger = n ? sortedChargers[rank % n] : null;
            // Only a charger that actually delivers energy contributes to peak draw.
            // A pass-through aircraft (arrives with enough charge -> energy 0) is still
            // assigned a charger for ordering, but draws nothing, so its slot must NOT
            // count toward peakPower — otherwise an airport a flight merely overflies
            // shows a phantom peak equal to its charger's nameplate (0 kWh but 60 kW).
            if (charger && entry.ac.energy > 0) usedSlots.add(charger._slot);
            const power = charger ? charger.power_kw : 0;
            assignments[entry.i] = {
                aircraft: entry.ac,
                charger,
                power,
                chargeTimeMin: power ? (entry.ac.energy / power) * 60 : Infinity
            };
        });

        const peakPower = sortedChargers
            .filter(c => usedSlots.has(c._slot))
            .reduce((sum, c) => sum + c.power_kw, 0);

        return {
            assignments,
            peakPower,
            queued: Math.max(0, aircraft.length - n),
            numChargers: n
        };
    }

    return { planCharging };
})();
