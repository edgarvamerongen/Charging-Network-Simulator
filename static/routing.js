/*
 * CNSRouting — multi-stop "charging stops" planner.
 * -------------------------------------------------------------------
 *
 * planRoute({ origin, destination, plane, options, allowedTypes, allAirports })
 *   → { stops, totalDistanceKm, legCount, error? }
 *
 * STRATEGY: greedy max-reach with a soft preference for medium-sized airports.
 * From the current position, look at airports that
 *   (a) are in `allowedTypes` (i.e. visible on the user's map filter),
 *   (b) are within the aircraft's effective range,
 *   (c) make meaningful progress toward the destination.
 * Score each candidate by `progress_km − typePenalty[type]`. Pick the best,
 * jump there, repeat until the destination is in range.
 *
 * The greedy strategy naturally minimises the number of stops while the type
 * penalty biases the planner toward medium airports (and large > small) —
 * those are the ones most likely to actually have charging infrastructure.
 *
 * No DOM, no localStorage — pure logic so any UI (current vanilla, future
 * React) can drive it.
 *
 * Algorithm note: a Dijkstra/DP variant on a "within-range graph" would give
 * provably optimal results, but on European routes the greedy converges in
 * 1–3 stops and is dramatically simpler. Easy to upgrade later.
 */
window.CNSRouting = (function () {
    function haversineKm(a, b) {
        const R = 6371, toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }

    // Defaults — tweakable via opts.options
    const DEFAULTS = {
        reservePct: 0,                                                  // fly to 0 km (user-confirmed)
        minProgressFraction: 0.5,                                       // first pass: require ≥50 % of range progress per leg
        typePenalty: {
            'medium_airport': 0,
            'large_airport':  50,                                       // a large beats a medium only if it's >50 km farther
            'small_airport':  150                                       // small avoided unless no choice
        },
        maxStops: 10                                                    // safety: refuse routes that need more than this
    };

    function _ap(a) { return { lat: a.latitude_deg, lon: a.longitude_deg }; }

    function planRoute(opts) {
        const { origin, destination, plane, allAirports } = opts;
        const allowedSet = new Set(opts.allowedTypes || []);
        const options = Object.assign({}, DEFAULTS, opts.options || {});

        if (!origin || !destination || !plane || !allAirports) {
            return { stops: [], totalDistanceKm: 0, legCount: 0, error: 'Missing inputs.' };
        }
        const rng = Number(plane.range_km) || 0;
        if (rng <= 0) return { stops: [], totalDistanceKm: 0, legCount: 0, error: 'Aircraft has no range.' };
        // Apply realism factors when available: reserves cap usable range,
        // routing padding shrinks effective reach (since real distance > GC).
        const usable = (window.CNSSettings ? CNSSettings.usableFraction(plane) : 1.0);
        const route  = (window.CNSSettings ? CNSSettings.routingFactor() : 1.0);
        const maxLeg = rng * usable * (1 - options.reservePct) / route;

        const totalDirect = haversineKm(origin, destination);
        if (totalDirect <= maxLeg) {
            return { stops: [], totalDistanceKm: totalDirect, legCount: 1 };
        }

        const used = new Set();
        if (origin.ident) used.add(origin.ident);
        if (destination.ident) used.add(destination.ident);

        const stops = [];
        let current = { lat: origin.lat, lon: origin.lon };
        let guard = 0;

        while (haversineKm(current, destination) > maxLeg) {
            if (++guard > options.maxStops) {
                return { stops: [], totalDistanceKm: 0, legCount: 0,
                    error: `Route needs more than ${options.maxStops} stops — try enabling more airport types or pick a longer-range aircraft.` };
            }
            const distToDest = haversineKm(current, destination);

            // 1st pass: corridor between `minProgressFraction × range` and `maxLeg`, closer to dest
            const corridor = [];
            const reachable = [];
            for (const a of allAirports) {
                if (!allowedSet.has(a.type)) continue;
                if (a.ident && used.has(a.ident)) continue;
                if (!a.latitude_deg || !a.longitude_deg) continue;
                const ap = _ap(a);
                const dC = haversineKm(current, ap);
                if (dC > maxLeg) continue;
                const dD = haversineKm(ap, destination);
                if (dD >= distToDest) continue;
                reachable.push({ a, ap, dC, dD });
                if (dC >= maxLeg * options.minProgressFraction) corridor.push({ a, ap, dC, dD });
            }
            const pool = corridor.length ? corridor : reachable;

            if (!pool.length) {
                return { stops: [], totalDistanceKm: 0, legCount: 0,
                    error: 'No reachable airport with the current filter — enable more airport types and try again.' };
            }

            // pick the best by score = progress − typePenalty
            let best = null, bestScore = -Infinity;
            for (const c of pool) {
                const progress = distToDest - c.dD;                     // km closer to the destination
                const penalty = options.typePenalty[c.a.type] || 0;
                const score = progress - penalty;
                if (score > bestScore) { bestScore = score; best = c; }
            }

            stops.push({
                ident: best.a.ident, name: best.a.name, type: best.a.type,
                lat: best.a.latitude_deg, lon: best.a.longitude_deg,
                iata_code: best.a.iata_code || ''
            });
            if (best.a.ident) used.add(best.a.ident);
            current = best.ap;
        }

        // total distance along the chain
        const chain = [origin, ...stops, destination];
        let total = 0;
        for (let i = 0; i < chain.length - 1; i++) total += haversineKm(chain[i], chain[i + 1]);

        return { stops, totalDistanceKm: total, legCount: stops.length + 1 };
    }

    return { planRoute, haversineKm };
})();
