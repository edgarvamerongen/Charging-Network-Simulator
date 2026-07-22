/*
 * CNSRouting — multi-stop "charging stops" planner.
 * -------------------------------------------------------------------
 *
 * planRoute({ origin, destination, plane, options, allowedTypes, allowedIdents, allAirports })
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
 * Candidates also require runway data (rwy_<cat>_m fields): an airport whose
 * runways are unverifiable is never planned as a charging stop.
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

    // Airports without runway data are un-plannable: never picked as auto stops,
    // whichever pool arm (size class or NRG ident) admits them. Waypoints the user
    // fixed — origin, destination, manual stops — are chain endpoints, not
    // candidates, so explicit picks are unaffected. Dependency-free twin of
    // CNSRunway.hasData (this file loads standalone in node tests — keep in sync).
    const RWY_COLS = ['rwy_paved_m', 'rwy_grass_m', 'rwy_gravel_m', 'rwy_dirt_m', 'rwy_water_m', 'rwy_unknown_m'];
    function hasRunwayData(a) {
        for (const k of RWY_COLS) { const v = +a[k]; if (isFinite(v) && v > 0) return true; }
        return false;
    }
    // Per-aircraft landability: reject a candidate when its KNOWN runway data
    // proves the plane cannot land — required surface absent, or present but
    // shorter than the minimum (null min = surface required, any length).
    // A plane without runway_req stays permissive; data ABSENCE is handled by
    // hasRunwayData above. Dependency-free twin of CNSRunway.fits — keep in sync.
    function fitsRunwayReq(plane, a) {
        const req = plane && plane.runway_req;
        if (!req || typeof req !== 'object') return true;
        if (!hasRunwayData(a)) return true;
        for (const cat of Object.keys(req)) {
            const v = +a['rwy_' + cat + '_m'];
            const have = (isFinite(v) && v > 0) ? v : 0;
            const need = req[cat];
            if (have > 0 && (need == null || have >= need)) return true;
        }
        return false;
    }

    function planRoute(opts) {
        const { origin, destination, plane, allAirports } = opts;
        const allowedSet = new Set(opts.allowedTypes || []);
        // WYSIWYG pool: idents admitted regardless of type — the live planner passes
        // the shown NRG2fly charger sites; the DC recompute passes the full network.
        const allowedIdents = opts.allowedIdents instanceof Set
            ? opts.allowedIdents : new Set(opts.allowedIdents || []);
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
                if (!allowedSet.has(a.type) && !allowedIdents.has(a.ident)) continue;
                if (!hasRunwayData(a)) continue;
                if (!fitsRunwayReq(plane, a)) continue;
                if (a.ident && skip.has(a.ident)) continue;
                if (a.latitude_deg == null || a.longitude_deg == null) continue;
                const ap = _ap(a);
                if (haversineKm(O, ap) + haversineKm(ap, D) <= cap * direct) C.push({ a, ap });
            }
            return C;
        }

        // A* over {origin} ∪ C ∪ {dest} for a given per-type penalty. Returns the best
        // { order, C, distKm } across widening corridors, or null. Wrapped in searchWith so the
        // caller can re-run it with the type preference dropped (the soft-bias fallback below).
        function searchWith(typePen) {
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
            return best;
        }

        // Type preference is a SOFT bias, not a hard rule: honour it first, but if the preferred
        // route would need more than maxStops (or none is found), retry with the preference
        // dropped so a route that actually exists is returned (e.g. a small-field-only corridor
        // a "prefer medium" search would otherwise push past the stop cap). The preference still
        // wins whenever it yields a route within maxStops.
        const tooMany = (b) => !!b && (b.order.length - 2) > options.maxStops;
        let best = searchWith(typePen);
        if (Object.values(typePen).some(v => v > 0) && (!best || tooMany(best))) {
            const fallback = searchWith({});   // pure distance, no per-type penalty
            if (fallback && (!best || !tooMany(fallback))) best = fallback;
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

    // Build a full stop chain that PRESERVES the caller's manual stops and auto-fills
    // each gap between them with planRoute. This is the exact chain-build the live
    // planner uses; index.html's recomputeRoute and CNSRecompute both call it so the
    // re-planning path is identical by construction (not two implementations agreeing).
    //   manualStops: [{ ident, name, lat, lon, alternate_km, ... }]  (order preserved)
    //   allowedIdents passes through unchanged to each gap's planRoute call.
    // Returns { stops: [ …each tagged _manual or _auto ], legCount, error }.
    function planChain(opts) {
        const { origin, dest, plane, allAirports } = opts;
        const manualStops = (opts.manualStops || []).map(s => ({ ...s, _manual: true }));
        const allowedTypes = opts.allowedTypes || [];
        const blacklist = opts.blacklist instanceof Set ? opts.blacklist : new Set(opts.blacklist || []);
        const maxLegKm = opts.maxLegKm;
        const chain = [origin, ...manualStops, dest];
        const usedIdents = new Set(chain.map(p => p && p.ident).filter(Boolean));
        const stops = [];
        for (let i = 0; i < chain.length - 1; i++) {
            const filtered = allAirports.filter(a => !usedIdents.has(a.ident) && !blacklist.has(a.ident));
            const seg = planRoute({
                origin: chain[i], destination: chain[i + 1], plane,
                allAirports: filtered, allowedTypes, allowedIdents: opts.allowedIdents,
                options: Object.assign({}, opts.options || {}, { maxLegKm }),
            });
            if (seg.error && manualStops.length === 0) {
                return { stops: [], legCount: 0, error: seg.error };
            }
            (seg.stops || []).forEach(s => { stops.push({ ...s, _auto: true }); if (s.ident) usedIdents.add(s.ident); });
            if (i < chain.length - 2) stops.push(manualStops[i]);   // the manual anchor ending this gap
        }
        return { stops, legCount: stops.length + 1, error: null };
    }

    return { planRoute, planChain, haversineKm, routedKm };
})();
