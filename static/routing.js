/*
 * CNSRouting — multi-stop "charging stops" planner.
 * -------------------------------------------------------------------
 *
 * planRoute({ origin, destination, plane, options, allowedTypes, allAirports })
 *   → { stops, totalDistanceKm, legCount, error? }
 *
 * STRATEGY: A* shortest-path on a range-constrained graph. Nodes are the
 * origin, the destination, and every candidate airport; an edge joins two
 * nodes only when the leg is flyable on a single charge (≤ maxLeg), weighted
 * by its great-circle distance. A* minimises
 *
 *      Σ leg distance  +  Σ_stops ( stopPenaltyKm + typePenalty[type] )
 *
 * so DISTANCE dominates, with a small nudge against gratuitous extra stops and
 * a configurable preference for certain airport types (the UI "Prefer" control,
 * passed through opts.options.typePenalty). The heuristic is the straight-line
 * distance to the destination — admissible and consistent — so A* returns the
 * optimal route for that cost, not a locally-greedy guess.
 *
 * Candidate airports are pre-pruned to an ellipse around the origin–destination
 * line (detour ≤ detourCap × direct) which keeps the graph tiny; the corridor
 * widens automatically when no route fits, and the search stops widening once
 * the result is provably as short as any wider corridor could contain.
 *
 * No DOM, no localStorage — pure logic so any UI (current vanilla, future
 * React) can drive it.
 */
window.CNSRouting = (function () {
    function haversineKm(a, b) {
        const R = 6371, toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }
    // Routed (flown) distance = great-circle x routing padding. The pad scalar is applied
    // HERE so display callers don't each re-apply it; haversineKm itself stays pure
    // great-circle for the reach math (range/route) and the map arc.
    function routedKm(a, b) {
        const f = (window.CNSSettings && CNSSettings.routingFactor) ? CNSSettings.routingFactor() : 1.0;
        return haversineKm(a, b) * f;
    }

    // Defaults — tweakable via opts.options
    const DEFAULTS = {
        reservePct: 0,                  // legacy; reserve now flows through CNSSettings.usableFraction
        detourCap: 1.4,                 // corridor: keep airports within 1.4× the direct distance
        stopPenaltyKm: 25,              // each intermediate stop costs this many equivalent-km (small nudge to fewer stops)
        typePenalty: {                  // per-stop preference surcharge (equivalent-km); UI "Prefer" control overrides this
            'medium_airport': 0,
            'large_airport':  50,
            'small_airport':  150
        },
        maxStops: 10                    // refuse routes that need more than this
    };
    const WIDEN = [1.0, 1.3, 1.8, 3.0];  // corridor multipliers (× detourCap), tried in order until optimal

    function _ap(a) { return { lat: a.latitude_deg, lon: a.longitude_deg }; }

    function planRoute(opts) {
        const { origin, destination, plane, allAirports } = opts;
        const allowedSet = new Set(opts.allowedTypes || []);
        const options = Object.assign({}, DEFAULTS, opts.options || {});
        const typePen = Object.assign({}, DEFAULTS.typePenalty, options.typePenalty || {});

        if (!origin || !destination || !plane || !allAirports) {
            return { stops: [], totalDistanceKm: 0, legCount: 0, error: 'Missing inputs.' };
        }
        const rng = Number(plane.range_km) || 0;
        if (rng <= 0) return { stops: [], totalDistanceKm: 0, legCount: 0, error: 'Aircraft has no range.' };

        // Realism factors: reserves cap usable range, routing padding shrinks reach.
        const usable = (window.CNSSettings ? CNSSettings.usableFraction(plane) : 1.0);
        const route  = (window.CNSSettings ? CNSSettings.routingFactor() : 1.0);
        const requireAlt = (window.CNSSettings && CNSSettings.alternateReserveEnabled)
                         ? CNSSettings.alternateReserveEnabled() : false;
        // Per-airport divert reserve. Every ARRIVAL node (each stop + the
        // destination) must arrive holding enough charge to reach its nearest
        // airport — that airport's pre-baked great-circle `alternate_km`. We
        // divide by `route` so the short divert is NOT inflated by cruise
        // airways padding (a divert is flown near-direct). Built once and only
        // when the toggle is on, so the planner is identical when off.
        const altByIdent = new Map();
        if (requireAlt) {
            for (const a of allAirports) {
                if (a && a.ident != null) altByIdent.set(a.ident, +a.alternate_km || 0);
            }
        }
        const altReserveKm = (n) => {
            if (!requireAlt || !n) return 0;
            const km = (n.ident != null && altByIdent.has(n.ident))
                     ? altByIdent.get(n.ident)
                     : (+n.alternate_km || 0);
            return km / route;
        };
        // Caller may pass an explicit max straight-line leg (the planner's "available
        // range", already incl. reserve + routing padding, or a per-flight override).
        const maxLeg = options.maxLegKm != null ? options.maxLegKm
                     : rng * usable * (1 - options.reservePct) / route;
        if (maxLeg <= 0) return { stops: [], totalDistanceKm: 0, legCount: 0, error: 'Aircraft has no usable range.' };

        const O = { lat: origin.lat, lon: origin.lon };
        const D = { lat: destination.lat, lon: destination.lon };
        const direct = haversineKm(O, D);
        if (direct <= maxLeg - altReserveKm(destination)) return { stops: [], totalDistanceKm: direct, legCount: 1 };

        const skip = new Set();
        if (origin.ident) skip.add(origin.ident);
        if (destination.ident) skip.add(destination.ident);

        // Candidate airports inside the origin/destination ellipse for a detour cap.
        function candidates(cap) {
            const C = [];
            for (const a of allAirports) {
                if (!allowedSet.has(a.type)) continue;
                if (a.ident && skip.has(a.ident)) continue;
                if (a.latitude_deg == null || a.longitude_deg == null) continue;
                const ap = _ap(a);
                if (haversineKm(O, ap) + haversineKm(ap, D) <= cap * direct) C.push({ a, ap });
            }
            return C;
        }

        // A* over {origin} ∪ C ∪ {dest}. Returns { order, C, distKm } or null.
        function astar(C) {
            const N = C.length, ORIG = 0, DEST = N + 1;
            const pos  = (i) => i === ORIG ? O : i === DEST ? D : C[i - 1].ap;
            const type = (i) => (i === ORIG || i === DEST) ? null : C[i - 1].a.type;
            const obj  = (i) => i === ORIG ? origin : i === DEST ? destination : C[i - 1].a;
            const g    = new Array(N + 2).fill(Infinity);   // best cost origin→i
            const came = new Array(N + 2).fill(-1);
            const done = new Array(N + 2).fill(false);
            g[ORIG] = 0;
            const open = [{ i: ORIG, f: direct }];          // f = g + straight-line-to-dest (admissible)
            while (open.length) {
                let b = 0; for (let k = 1; k < open.length; k++) if (open[k].f < open[b].f) b = k;
                const i = open.splice(b, 1)[0].i;
                if (done[i]) continue;                       // stale duplicate
                if (i === DEST) break;                       // optimal path to dest is finalised
                done[i] = true;
                const from = pos(i);
                const relax = (j) => {
                    if (done[j]) return;
                    const d = haversineKm(from, pos(j));
                    if (d + altReserveKm(obj(j)) > maxLeg) return;   // not flyable incl. divert reserve
                    const pen = (j === DEST) ? 0 : options.stopPenaltyKm + (typePen[type(j)] || 0);
                    const t = g[i] + d + pen;
                    if (t < g[j]) { g[j] = t; came[j] = i; open.push({ i: j, f: t + haversineKm(pos(j), D) }); }
                };
                for (let j = 1; j <= N; j++) relax(j);
                relax(DEST);
            }
            if (g[DEST] === Infinity) return null;

            const order = [];
            for (let i = DEST; i !== -1; i = came[i]) order.push(i);
            order.reverse();                                  // ORIG … DEST
            let distKm = 0;                                   // actual flown distance (penalties excluded)
            for (let k = 0; k < order.length - 1; k++) distKm += haversineKm(pos(order[k]), pos(order[k + 1]));
            return { order, C, distKm };
        }

        // Widen the corridor until the best route is provably unbeatable (its flown
        // distance ≤ cap × direct, so no airport outside the ellipse could shorten it).
        let best = null;
        for (const mult of WIDEN) {
            const cap = options.detourCap * mult;
            const res = astar(candidates(cap));
            if (!res) continue;
            if (!best || res.distKm < best.distKm) best = res;
            if (res.distKm <= cap * direct) break;
        }
        if (!best) {
            return { stops: [], totalDistanceKm: 0, legCount: 0,
                error: 'No reachable route with the current filter — enable more airport types or pick a longer-range aircraft.' };
        }

        const stops = [];
        for (let k = 1; k < best.order.length - 1; k++) {
            const a = best.C[best.order[k] - 1].a;
            stops.push({
                ident: a.ident, name: a.name, type: a.type,
                lat: a.latitude_deg, lon: a.longitude_deg, iata_code: a.iata_code || ''
            });
        }
        if (stops.length > options.maxStops) {
            return { stops: [], totalDistanceKm: 0, legCount: 0,
                error: `Route needs more than ${options.maxStops} stops — try enabling more airport types or pick a longer-range aircraft.` };
        }

        return { stops, totalDistanceKm: best.distKm, legCount: stops.length + 1 };
    }

    return { planRoute, haversineKm, routedKm };
})();
