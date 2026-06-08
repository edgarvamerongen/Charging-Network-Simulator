/*
 * CNS charging assignment — FIRST-CUT heuristic.
 * ------------------------------------------------------------------
 * This file is deliberately isolated so the assignment logic is easy to
 * read and replace with something smarter later.
 *
 * Rules implemented here (per spec):
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

        // Rank aircraft biggest-first, but remember their original order so the
        // caller can line assignments back up with its rows.
        const ranked = aircraft
            .map((ac, i) => ({ ac, i }))
            .sort((x, y) => y.ac.size - x.ac.size);

        const assignments = new Array(aircraft.length);
        const usedSlots = new Set();

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
