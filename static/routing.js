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
    function routedKm(a, b, plane) {
        const f = (window.CNSSettings && CNSSettings.routingFactor) ? CNSSettings.routingFactor(plane) : 1.0;
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
        const route  = (window.CNSSettings ? CNSSettings.routingFactor(plane) : 1.0);   // identity for VFR
        // Alternates are still planned/shown for every aircraft; only planes whose
        // published range already INCLUDES reserves skip the range DEDUCTION —
        // for everyone else leg + alternate must fit the AVAILABLE range, since
        // the landing reserve stays intact at the alternate (settings gate).
        const requireAlt = (window.CNSSettings && CNSSettings.alternateReserveEnabled)
                         ? CNSSettings.alternateReserveEnabled(plane) : false;
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
            // Manual divert (CNSDivertEdit): the host stamps the chosen divert's raw
            // km onto the node — a user's pick beats the baked catalog alternate.
            if (n.divertOverrideKm != null && isFinite(+n.divertOverrideKm)) return (+n.divertOverrideKm) / route;
            const km = (n.ident != null && altByIdent.has(n.ident))
                     ? altByIdent.get(n.ident)
                     : (+n.alternate_km || 0);
            return km / route;
        };
        // A return trip flies every leg back too, landing at the airport it left from, so with
        // options.bothWays a leg must fit the LARGER of its two ends' divert reserves.
        // In the plan's wind (CNSSettings.windLeg) a leg needs its AIR km: ground km × TAS/GS for its course, plus the
        // arrival's divert reserve at the worst-case headwind (the divert's own direction isn't modelled). Still air: 1.
        const wWorst = (window.CNSSettings && CNSSettings.windWorstFactor) ? CNSSettings.windWorstFactor(+plane.speed_kmh || 0) : 1;
        // The divert is flown from the arrival to ITS alternate, so its air km scale with the wind on that course (a
        // tailwind helps, a headwind costs, a wind the aircraft can't make headway against rules the leg out). Only an
        // alternate whose position is unknown falls back to the worst case, a straight headwind.
        const windOn = wWorst !== 1 && !options.divertStillAir;   // divertStillAir: the planner's "would it fly without the wind on the diverts?" probe
        const apById = new Map();
        if (requireAlt && windOn) for (const a of allAirports) if (a && a.ident != null) apById.set(a.ident, a);
        const dwCache = new Map();
        const divertWind = (pb, nb) => {
            if (!windOn || !nb) return 1;
            if (dwCache.has(nb)) return dwCache.get(nb);
            const rec = nb.ident != null ? apById.get(nb.ident) : null;
            const altId = nb.divertOverride || nb.alternate_ident || (rec && rec.alternate_ident);
            const alt = altId ? apById.get(altId) : null;
            const f = alt ? divertWindFactor(pb, { lat: +alt.latitude_deg, lon: +alt.longitude_deg }, plane).factor : wWorst;
            dwCache.set(nb, f); return f;
        };
        const need = (pa, na, pb, nb, d) => { const ak = altReserveKm(nb); return d * windFactor(pa, pb, plane) + (ak > 0 ? ak * divertWind(pb, nb) : 0); };
        const legNeed = (pa, na, pb, nb, d) => options.bothWays ? Math.max(need(pa, na, pb, nb, d), need(pb, nb, pa, na, d)) : need(pa, na, pb, nb, d);
        // Caller may pass an explicit max straight-line leg (the planner's "available
        // range", already incl. reserve + routing padding, or a per-flight override).
        const maxLeg = options.maxLegKm != null ? options.maxLegKm
                     : rng * usable * (1 - options.reservePct) / route;
        if (maxLeg <= 0) return { stops: [], totalDistanceKm: 0, legCount: 0, error: 'Aircraft has no usable range.' };

        const O = { lat: origin.lat, lon: origin.lon };
        const D = { lat: destination.lat, lon: destination.lon };
        const direct = haversineKm(O, D);
        if (legNeed(O, origin, D, destination, direct) <= maxLeg) return { stops: [], totalDistanceKm: direct, legCount: 1 };

        // Too far to search: any route needs at least ⌈direct · fBest / maxLeg⌉ legs (fBest: air km per ground km in the
        // most favourable wind, a straight tailwind; 1 in still air). Past maxStops + 1 legs there is nothing to find, so
        // say so now: with the world's ~48,000 airports a search across continents would never finish.
        const wind = (window.CNSSettings && CNSSettings.loadAll) ? CNSSettings.loadAll().wind : null;
        const fBest = (wind && wind.enabled && CNSSettings.windLeg) ? Math.min(1, CNSSettings.windLeg(((+wind.fromDeg || 0) + 180) % 360, +plane.speed_kmh || 0).factor || 1) : 1;
        const minStops = Math.ceil(direct * fBest / maxLeg - 1e-9) - 1;
        if (minStops > options.maxStops) {
            return { stops: [], totalDistanceKm: 0, legCount: 0,
                error: `Too far for this aircraft: ${Math.round(direct).toLocaleString('en')} km needs at least ${minStops} stops (the limit is ${options.maxStops}). Pick a longer-range aircraft or a closer destination.` };
        }

        const skip = new Set();
        if (origin.ident) skip.add(origin.ident);
        if (destination.ident) skip.add(destination.ident);

        // Candidate airports inside the origin/destination ellipse for a detour cap.
        // Powered-lift (type ~ VTOL) needs no runway at all — both runway gates are
        // wing-borne concerns, so an eVTOL may stop at ANY airport (ruled).
        const poweredLift = /vtol/i.test(String(plane.type || ''));
        function candidates(cap) {
            const C = [];
            for (const a of allAirports) {
                if (!allowedSet.has(a.type) && !allowedIdents.has(a.ident)) continue;
                if (!poweredLift && !hasRunwayData(a)) continue;
                if (!poweredLift && !fitsRunwayReq(plane, a)) continue;
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
        // No leg reaches further over the ground than maxLeg / fBest (fBest: the most favourable wind, ≤ 1), so a node's
        // neighbours lie within that many km: the search only looks at airports in that latitude window (and longitude,
        // cheaply), not at every candidate. Same result as the all-pairs scan, far fewer distance checks.
        const reachKm = maxLeg / fBest, reachDeg = reachKm / 111.19 + 1e-6, cosReach = Math.cos(Math.min(Math.PI, reachKm / 6371.0088));
        /** The flight graph over {origin} ∪ C ∪ {dest}: node positions, unit vectors, and each node's flyable
         *  neighbours (wind + divert reserve) through a grid of reach-sized cells. */
        function graph(C) {
            const N = C.length, ORIG = 0, DEST = N + 1;
            const pos  = (i) => i === ORIG ? O : i === DEST ? D : C[i - 1].ap;
            const obj  = (i) => i === ORIG ? origin : i === DEST ? destination : C[i - 1].a;
            const R = Math.PI / 180, ux = new Float64Array(N + 2), uy = new Float64Array(N + 2), uz = new Float64Array(N + 2);
            for (let i = 0; i <= N + 1; i++) { const p = pos(i), la = p.lat * R, lo = p.lon * R; ux[i] = Math.cos(la) * Math.cos(lo); uy[i] = Math.cos(la) * Math.sin(lo); uz[i] = Math.sin(la); }
            const cell = reachDeg, nLon = Math.max(1, Math.ceil(360 / cell)), grid = new Map();
            const cy = (lat) => Math.floor((lat + 90) / cell), cx = (lon) => ((Math.floor((((lon + 180) % 360) + 360) % 360 / cell)) % nLon);
            for (let j = 1; j <= N; j++) { const p = pos(j), key = cy(p.lat) * nLon + cx(p.lon); let b = grid.get(key); if (!b) grid.set(key, b = []); b.push(j); }
            /** fn(j, d) for every node j ≠ i a leg from i can fly to (d = great-circle km); `skip(j)` prunes before any maths. */
            function eachLeg(i, skip, fn) {
                const from = pos(i), test = (j) => {
                    if (skip(j) || ux[i] * ux[j] + uy[i] * uy[j] + uz[i] * uz[j] < cosReach - 1e-12) return;   // beyond any leg's reach: no trig
                    const d = haversineKm(from, pos(j));
                    if (d > reachKm || legNeed(from, obj(i), pos(j), obj(j), d) > maxLeg) return;   // not flyable incl. wind + divert reserve
                    fn(j, d);
                };
                // the widest longitude gap a leg of reachKm can span at the poleward edge of the window (exact on the sphere)
                const cosLat = Math.cos(Math.min(90, Math.abs(from.lat) + reachDeg) * Math.PI / 180), sh = Math.sin(reachKm / 6371.0088 / 2) / Math.max(cosLat, 1e-9);
                const lonWin = sh >= 1 ? 360 : 2 * Math.asin(sh) * 180 / Math.PI + 1e-6;
                const y0 = cy(from.lat), x0 = cx(from.lon), dx = lonWin >= 180 ? Math.ceil(nLon / 2) : Math.ceil(lonWin / cell);
                const xs = new Set(); for (let k = -dx; k <= dx; k++) xs.add(((x0 + k) % nLon + nLon) % nLon);
                for (let y = y0 - 1; y <= y0 + 1; y++) for (const x of xs) { const b = grid.get(y * nLon + x); if (b) for (const j of b) if (j !== i) test(j); }
                if (i !== DEST) test(DEST);
            }
            return { N, ORIG, DEST, pos, obj, eachLeg };
        }
        /** Can the destination be reached at all through C? One flood fill: reachability doesn't depend on the corridor
         *  width (C is the widest) or on the type preference, so an impossible route is answered once, not re-searched. */
        function reachable(C) {
            const G = graph(C), seen = new Uint8Array(G.N + 2), stack = [G.ORIG]; seen[G.ORIG] = 1;
            while (stack.length) { const i = stack.pop(); if (i === G.DEST) return true;
                G.eachLeg(i, (j) => seen[j] === 1, (j) => { seen[j] = 1; stack.push(j); }); }
            return false;
        }
        function searchWith(typePen) {
            function astar(C) {
                const G = graph(C), N = G.N, ORIG = G.ORIG, DEST = G.DEST, pos = G.pos;
                const type = (i) => (i === ORIG || i === DEST) ? null : C[i - 1].a.type;
                const g    = new Array(N + 2).fill(Infinity);   // best cost origin→i
                const came = new Array(N + 2).fill(-1);
                const done = new Array(N + 2).fill(false);
                // binary min-heap on f
                const heap = [], push = (e) => { heap.push(e); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p].f <= e.f) break; heap[k] = heap[p]; k = p; } heap[k] = e; };
                const pop = () => { const top = heap[0], last = heap.pop(), n = heap.length; if (n) { let k = 0;
                    for (;;) { const l = 2 * k + 1, r = l + 1; let m = k, fm = last.f;
                        if (l < n && heap[l].f < fm) { m = l; fm = heap[l].f; } if (r < n && heap[r].f < fm) m = r;
                        if (m === k) break; heap[k] = heap[m]; k = m; }
                    heap[k] = last; } return top; };
                g[ORIG] = 0;
                // f = g + h: h = the straight line to the destination + the stop penalties the stops still ahead must pay
                // (at least ⌈h · fBest / maxLeg⌉ − 1 of them): still a lower bound, so the route is the same, found sooner
                const h = (km) => km + Math.max(0, Math.ceil(km * fBest / maxLeg - 1e-9) - 1) * options.stopPenaltyKm;
                push({ i: ORIG, f: h(direct) });
                while (heap.length) {
                    const i = pop().i;
                    if (done[i]) continue;                       // stale duplicate
                    if (i === DEST) break;                       // optimal path to dest is finalised
                    done[i] = true;
                    G.eachLeg(i, (j) => done[j], (j, d) => {
                        const pen = (j === DEST) ? 0 : options.stopPenaltyKm + (typePen[type(j)] || 0);
                        const t = g[i] + d + pen;
                        if (t < g[j]) { g[j] = t; came[j] = i; push({ i: j, f: t + h(haversineKm(pos(j), D)) }); }
                    });
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
        if (!reachable(candidates(options.detourCap * WIDEN[WIDEN.length - 1]))) {
            return { stops: [], totalDistanceKm: 0, legCount: 0,
                error: 'No reachable route with the current filter — enable more airport types or pick a longer-range aircraft.' };
        }
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

    // Initial great-circle TRUE course a -> b in degrees (0-360); a and b are {lat, lon}.
    function courseDeg(a, b) {
        const R = Math.PI / 180, la1 = +a.lat * R, la2 = +b.lat * R, dl = (+b.lon - +a.lon) * R;
        return (Math.atan2(Math.sin(dl) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)) / R + 360) % 360;
    }
    // Air km flown per ground km on a -> b in the plan's wind (CNSSettings.windLeg); 1 in still air.
    function windFactor(a, b, plane) {
        const S = window.CNSSettings;
        return (S && S.windLeg && plane) ? S.windLeg(courseDeg(a, b), +plane.speed_kmh || 0).factor : 1;
    }

    /** The wind on a divert from `from` to its alternate `alt` ({lat, lon}): { factor (air km per ground km; Infinity
     *  when the aircraft can't make the divert in this wind), ok, course (°T) }. Still air: factor 1. */
    function divertWindFactor(from, alt, plane) {
        const S = window.CNSSettings, course = courseDeg(from, alt);
        if (!(S && S.windLeg && plane)) return { factor: 1, ok: true, course };
        const w = S.windLeg(course, +plane.speed_kmh || 0);
        return { factor: w.ok ? w.factor : Infinity, ok: !!w.ok, course };
    }

    return { planRoute, planChain, haversineKm, routedKm, courseDeg, windFactor, divertWindFactor };
})();
