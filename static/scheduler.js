/*
 * CNS Daily Scheduler — per-airport rotation timeline for one operating day.
 * ------------------------------------------------------------------------------
 * Self-contained (easy to debug / extend). Reads trips from
 * localStorage['cns_folder'], per-airport charger config from
 * localStorage['cns_airport_cfg'], and persists desired take-off times to
 * localStorage['cns_schedule'].
 *
 * CORE CONCEPT — a ROTATION:
 *   One lane = one physical aircraft. A ROTATION is its complete, indivisible
 *   cycle: depart → charge at destination → fly back → full recharge at base.
 *
 *   [fly out]──[charge @ dest]──[fly back]──[recharge @ home]
 *
 * TWO HARD CONSTRAINTS, resolved together:
 *   1. Same aircraft can't overlap itself — a lane's rotations are sequential.
 *   2. A charger serves one aircraft at a time — with N chargers at an airport,
 *      at most N can charge simultaneously. If a plane arrives and every charger
 *      is busy it WAITS; the wait ELONGATES that rotation (and pushes the
 *      aircraft's later rotations). Different aircraft may fly at the same time.
 *   Charging order: when several planes compete, the LOWER-CAPACITY aircraft
 *   charges first (quicker charge → frees the charger sooner → offloads the airport).
 *
 * Charge times/energies are sized by the charger the AIRPORT provides (its fleet,
 * assigned via charging.js) — never the trip's own simulation charger.
 */
window.CNSScheduler = (function () {
    const FOLDER_KEY = 'cns_folder', SCHED_KEY = 'cns_schedule', CFG_KEY = 'cns_airport_cfg';
    const DAY_START = 7 * 60, DAY_END = 23 * 60, SPAN = DAY_END - DAY_START;
    const SNAP = 5, PX = 1.05, LANE_H = 46, LABEL_W = 150;

    let catalog = {};
    let onChange = null;

    const loadTrips = () => { try { return JSON.parse(localStorage.getItem(FOLDER_KEY) || '[]'); } catch (e) { return []; } };
    const loadSched = () => { try { return JSON.parse(localStorage.getItem(SCHED_KEY) || '{}'); } catch (e) { return {}; } };
    const saveSched = (s) => localStorage.setItem(SCHED_KEY, JSON.stringify(s));
    const loadCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } };

    const num = (t, k, d = 0) => { const v = Number(t[k]); return isFinite(v) ? v : d; };
    const batteryOf = (t) => t.battery != null ? num(t, 'battery') : 2 * num(t, 'legEnergy');
    const fmtTime = (m) => { const c = Math.max(0, Math.round(m)); return String(Math.floor(c / 60)).padStart(2, '0') + ':' + String(c % 60).padStart(2, '0'); };
    const fmtDur = (min) => { const m = Math.ceil(min - 1e-9) || 0; return m <= 60 ? m + ' min' : (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m / 60}h`); };
    const shorten = (s, n = 16) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');

    function roleAt(trip, ident) {
        if (trip.destIdent === ident) return 'dest';
        if (trip.originIdent === ident && trip.tripType === 'retour') return 'home';
        if (trip.multiLeg && Array.isArray(trip.stops) && trip.stops.some(s => s && s.ident === ident)) return 'stop';
        return null;
    }
    function tripsAt(ident) { return loadTrips().filter(t => roleAt(t, ident)); }

    // Does a freq>1 trip mean SEPARATE aircraft (a fleet, flying in parallel)
    // or ONE aircraft doing sequential rotations?
    //   • one-way  → always separate (the plane lands at the dest and stays).
    //   • retour   → user's choice via trip.fleetMode; defaults to 'separate'
    //                (an operator adding "3/day" usually means 3 tails).
    //   • training → defaults to 'shared' (a school plane flies N sessions),
    //                unless the user picked 'separate'.
    function fleetSeparate(trip) {
        if (trip.tripType === 'one-way') return true;
        if (trip.fleetMode === 'separate') return true;
        if (trip.fleetMode === 'shared') return false;
        return trip.tripType === 'retour';   // unset default
    }

    // Per-trip engine FlightProfile (CNSFlight), cached + busted on folder/cfg/settings
    // change. The scheduler reads charge ENERGIES from this; it keeps its OWN timing/queue
    // logic. Returns null only for unresolvable old saves (no coords/spec) -> those contribute
    // 0 charge energy. Target-SoC resolver matches the per-airport context.
    let _profStamp = null; const _profCache = {};
    function _tripProfile(trip, rotOpts) {
        if (!trip || !window.CNSFlight || !CNSFlight.profileForTrip) return null;
        const stamp = (localStorage.getItem(FOLDER_KEY) || '') + '¦' + (localStorage.getItem(CFG_KEY) || '') + '¦' + _settingsStamp();
        if (stamp !== _profStamp) { _profStamp = stamp; for (const k in _profCache) delete _profCache[k]; }
        // Default key === trip.id (existing callers unchanged + cached). Per-rotation variants
        // (interim-deficit charging) fold the engine opts into the key so each is cached distinctly.
        const key = rotOpts ? (trip.id + '¦' + (rotOpts.departSocFrac != null ? rotOpts.departSocFrac : 1) + '¦' + (rotOpts.terminusToFull === false ? 0 : 1)) : trip.id;
        if (!(key in _profCache)) {
            const getTargetSoc = (id) => (window.CNSDemand && CNSDemand.resolveTargetSoc) ? CNSDemand.resolveTargetSoc(loadCfg()[id] || null) : null;
            _profCache[key] = CNSFlight.profileForTrip(trip, {
                getTargetSoc,
                departSocFrac: rotOpts ? rotOpts.departSocFrac : undefined,
                terminusToFull: rotOpts ? rotOpts.terminusToFull : undefined,
            });
        }
        return _profCache[key];
    }

    // ---------- per-airport charger context (memoised on folder + cfg + model settings) ----------
    let _stamp = null, _ctx = {};
    function _settingsStamp() {
        // Settings affect every computed phase, so changing them must bust the
        // cache. CNSSettings stores everything under a single key; we hash that.
        return window.CNSSettings ? (localStorage.getItem(CNSSettings.KEY) || '') : '';
    }
    function getContext(ident) {
        const s = (localStorage.getItem(FOLDER_KEY) || '') + '¦' + (localStorage.getItem(CFG_KEY) || '') + '¦' + _settingsStamp();
        if (s !== _stamp) { _stamp = s; _ctx = {}; }
        if (!_ctx[ident]) _ctx[ident] = buildContext(ident);
        return _ctx[ident];
    }
    function buildContext(ident) {
        const cfg = loadCfg()[ident] || {};
        const targetSoc = (window.CNSDemand && CNSDemand.resolveTargetSoc)
            ? CNSDemand.resolveTargetSoc(cfg) : (cfg.fullCharge ? 1.0 : null);
        const trips = tripsAt(ident);
        // Default fleet = union of every distinct charger used by trips touching
        // this airport (so a hub with mixed aircraft doesn't get bottlenecked by
        // the first trip's single charger). User-customised cfg wins.
        const fleetIds = (cfg.chargers && cfg.chargers.length)
            ? cfg.chargers
            : (window.CNSDemand && CNSDemand.defaultChargerFleet
                ? CNSDemand.defaultChargerFleet(trips.map(t => ({ t })))
                : (trips[0] ? [trips[0].chargerId] : []));
        const fleet = fleetIds.map(id => catalog[id]).filter(Boolean);
        // Aircraft list: use the cross-airport-aware energy helper so the
        // charger plan reflects the operator's target-SoC choices on both ends.
        const aircraft = trips.map((t, i) => {
            const prof = _tripProfile(t);
            // Charger-independent per-airport energy from the engine (planCharging ranks by
            // size, so this only feeds charge time + peak). 0 for a rare unresolvable trip.
            // forcedChargerId → planCharging pins this flight to its chosen
            // charger here (manual-first); the resulting power feeds powers[t.id].
            return { _i: i, energy: prof ? prof.energyAt(ident) : 0, size: batteryOf(t), forcedChargerId: t.chargerOverride };
        });
        const powers = {};
        if (window.CNSCharging && fleet.length) {
            const plan = CNSCharging.planCharging(fleet, aircraft);
            trips.forEach((t, i) => { const a = plan.assignments[i]; powers[t.id] = (a && a.power) || 0; });
        } else {
            trips.forEach(t => { powers[t.id] = fleet[0] ? fleet[0].power_kw : 0; });
        }
        // fleetPowers = the ACTUAL physical chargers (their kW), biggest first.
        // The global sim binds each to a pool slot so peak draw can never
        // exceed the installed total (the old anonymous-slot pool let two
        // parallel charges both bill the 400 kW charger → impossible 800 kW).
        const fleetPowers = fleet.map(c => c.power_kw || 0).sort((a, b) => b - a);
        return { targetSoc, fullCharge: targetSoc === 1.0, powers, fleetPowers, fleetSize: Math.max(1, fleet.length) };
    }
    function fleetSizeAt(ident) { return getContext(ident).fleetSize; }

    // ---------- model factors (cascade if CNSSettings is loaded) ----------
    const _rs = () => (window.CNSSettings || null);
    const _route   = () => _rs() ? CNSSettings.routingFactor() : 1.0;
    const _chargeMin = (energy, power, batt, soc) => {
        if (!_rs() || !power) return power ? energy / power * 60 : 0;
        return CNSSettings.chargeTimeMin(energy, power, batt, soc);
    };
    // Battery acceptance cap: a small pack can't absorb an over-sized charger.
    // `power` here must already be the charger's nameplate; the result is the
    // EFFECTIVE power used for both charge time and peak draw. Identity when the
    // acceptance toggle is off. Pass the plane's c_rate (catalog) when known.
    const _cRateOf = (trip) => ((window.PLANES_BY_ID || {})[trip.planeId] || trip || {}).c_rate;
    const _effPower = (power, batt, cRate) =>
        (_rs() && CNSSettings.effectiveChargePower) ? CNSSettings.effectiveChargePower(power, batt, cRate) : (power || 0);
    // Nameplate power of the charger a flight manually pinned (forcedChargerId),
    // or 0 when it isn't pinned / the pinned charger isn't in the catalog. The
    // global sim uses this to claim a bay of the pinned power (manual-first).
    const _forcedPower = (trip) => {
        const id = trip && trip.chargerOverride;
        return (id && catalog[id]) ? (catalog[id].power_kw || 0) : 0;
    };

    // ---------- rotation timeline (airport-driven charge times; viewIdent flags atX) ----------
    // tripPhases takes a `ctx` that resolves, per airport, the charger power and
    // the SoC target to charge to. It defaults to the DES context (_desContext):
    // each airport's assigned charger from planCharging + its saved SoC target.
    // (The results-panel preview now builds its breakdown from CNSFlight, not here.)
    function _desContext(trip) {
        return {
            chargerAt: (id) => getContext(id).powers[trip.id] || 0,
            targetAt:  (id) => getContext(id).targetSoc,
        };
    }
    // Interim-deficit charging: a shared aircraft flying a route >1x/day tops the base to 100% only
    // on the day's FINAL rotation; interim rotations charge to the away-stop target. Build the <=3
    // distinct rotation phase-templates — first departs full, interim departs the previous terminus
    // SoC, last departs that SoC but tops to full. (Default opts keep non-shared lanes on one template.)
    function _rotationTemplates(trip) {
        const first = tripPhases(trip, null, null, { departSocFrac: 1, terminusToFull: false });
        const frac = (first.terminusDepartFrac != null) ? first.terminusDepartFrac : 1;
        const interim = tripPhases(trip, null, null, { departSocFrac: frac, terminusToFull: false });
        const last = tripPhases(trip, null, null, { departSocFrac: frac, terminusToFull: true });
        return { first, interim, last };
    }

    // Daily charging MINUTES a trip needs at `ident` — the reporting figure (demand drawer + PDF).
    // Shared >1x/day lane: sum the per-rotation charge minutes (first + (N-2)*interim + last) from the
    // rotation templates (SoC-aware via R7, same planCharging charger as ctx.chargerAt). Else: the
    // single-rotation minutes * flightsPerDay (fractional — weekly trips stay amortised, NOT integer
    // instancesPerDay). Daily kWh is conserved and stays on flightsPerDay at the call sites.
    function dailyChargeMinutesAt(trip, ident) {
        if (!trip) return 0;
        const minsAt = (tpl) => (tpl && tpl.ph ? tpl.ph : []).reduce((s, p) => (p.kind === 'charge' && p.ident === ident) ? s + (p.dur || 0) : s, 0);
        const N = instanceStarts(trip).length;
        if (!fleetSeparate(trip) && N > 1) {
            const { first, interim, last } = _rotationTemplates(trip);
            return minsAt(first) + Math.max(0, N - 2) * minsAt(interim) + minsAt(last);
        }
        const fpd = (window.CNSDemand && CNSDemand.flightsPerDay) ? CNSDemand.flightsPerDay(trip)
            : (trip.freqUnit === 'week' ? (num(trip, 'freqN')) / 7 : num(trip, 'freqN'));
        return minsAt(tripPhases(trip, null)) * fpd;
    }

    function tripPhases(trip, viewIdent, ctx, rotOpts) {
        if (trip.multiLeg) return _multiLegPhases(trip, viewIdent, ctx, rotOpts);
        ctx = ctx || _desContext(trip);
        const legs = trip.tripType === 'retour' ? 2 : 1;
        const route = _route();
        const legMin = num(trip, 'flightTimeH') * 60 / legs * route;
        const batt = batteryOf(trip);
        const cRate = _cRateOf(trip);

        const ph = []; let off = 0;
        ph.push({ kind: 'fly', leg: 'out', start: off, dur: legMin, label: 'Fly to ' + trip.destName }); off += legMin;

        // Charge energy at each end comes from the engine via energyAt(ident) — which also
        // resolves TRAINING (its charge role is 'training', not 'dest'). An unresolvable trip
        // (no profile) contributes 0; app-saved trips always carry coords + spec, so that's
        // reachable only by pathological pre-migration localStorage the coord-rebuild missed.
        const prof = _tripProfile(trip, rotOpts);
        const destEnergy = prof ? prof.energyAt(trip.destIdent) : 0;
        const destArr = prof ? ((prof.charges.find(c => c.ident === trip.destIdent) || {}).arrivalSocFrac ?? null) : null;
        const destPower = _effPower(ctx.chargerAt(trip.destIdent), batt, cRate);
        const destMin = _chargeMin(destEnergy, destPower, batt, destArr);
        const forcedPower = _forcedPower(trip);
        if (destMin > 0) { ph.push({ kind: 'charge', at: 'dest', ident: trip.destIdent, name: trip.destName, atX: viewIdent === trip.destIdent, start: off, dur: destMin, power: destPower, energy: destEnergy, arrivalFrac: destArr, forcedPower, label: 'Charge @ ' + trip.destName }); off += destMin; }

        if (trip.tripType === 'retour') {
            ph.push({ kind: 'fly', leg: 'back', start: off, dur: legMin, label: 'Fly back to ' + trip.originName }); off += legMin;
            const homeEnergy = prof ? prof.energyAt(trip.originIdent) : 0;
            const homeArr = prof ? ((prof.charges.find(c => c.ident === trip.originIdent && c.role === 'home') || {}).arrivalSocFrac ?? null) : null;
            const homePower = _effPower(ctx.chargerAt(trip.originIdent), batt, cRate);
            const homeMin = _chargeMin(homeEnergy, homePower, batt, homeArr);
            if (homeMin > 0) { ph.push({ kind: 'charge', at: 'home', ident: trip.originIdent, name: trip.originName, atX: viewIdent === trip.originIdent, start: off, dur: homeMin, power: homePower, energy: homeEnergy, arrivalFrac: homeArr, forcedPower, label: 'Recharge @ ' + trip.originName }); off += homeMin; }
        }
        return { ph, total: off, terminusDepartFrac: prof ? ((prof.charges.find(c => c.isTerminal) || {}).departSocFrac ?? null) : null };
    }

    // Multi-leg trip: walk the backend-precomputed legs[] and charges[]. Each
    // entry in charges[i] is the charge event AT chain[i+1] (= the end of legs[i]).
    // Charge POWER is the per-airport assigned charger (so toggling the airport's
    // fleet updates the rotation live), but the energy is what _simulate_multi
    // computed when the trip was added.
    function _multiLegPhases(trip, viewIdent, ctx, rotOpts) {
        ctx = ctx || _desContext(trip);
        const ph = []; let off = 0;
        const legs = Array.isArray(trip.legs) ? trip.legs : [];
        const charges = Array.isArray(trip.charges) ? trip.charges : [];
        const route = _route();
        const batt = batteryOf(trip);
        const cRate = _cRateOf(trip);
        // Reserve-aware forward walk: each stop charges only what's needed for the
        // NEXT leg + landing reserve (or its SoC target); the terminal tops up to
        // full. Same path for panel + DES — only ctx.targetAt differs (saved cfg
        // vs none). (Using the raw backend charges here was the earlier bug: a
        // big-battery plane charged 0 en route and dumped everything at the
        // destination, collapsing its travel time to flight-only.)
        // Charge energies come from the engine profile (charger-independent forward-SoC walk
        // with per-airport targets); recompute stays only as the null-profile fallback (old saves).
        const prof = _tripProfile(trip, rotOpts);
        const liveCharges = prof
            ? prof.charges.map(c => ({ ident: c.ident, name: c.name, role: c.role, energy_kwh: c.energyKwh, arrival_frac: c.arrivalSocFrac }))
            : [];
        legs.forEach((leg, i) => {
            const legMin = (Number(leg.flight_time_h) || 0) * 60 * route;
            const toName = (leg.to && leg.to.name) || '';
            ph.push({ kind: 'fly', leg: i, start: off, dur: legMin, label: 'Fly to ' + toName });
            off += legMin;
            const c = liveCharges[i] || charges[i];
            if (!c) return;
            const power = _effPower(ctx.chargerAt(c.ident), batt, cRate);
            const energy = Number(c.energy_kwh) || 0;     // recompute already applied routing padding
            const arrFrac = (c.arrival_frac != null) ? c.arrival_frac : null;
            const dur = _chargeMin(energy, power, batt, arrFrac);
            if (dur > 0) {
                ph.push({
                    kind: 'charge', at: c.role, ident: c.ident, name: c.name,
                    atX: viewIdent === c.ident,
                    atIdx: i + 1,                        // chain index — used by animation.js to position the plane
                    start: off, dur, power, energy, arrivalFrac: arrFrac, forcedPower: _forcedPower(trip),
                    label: 'Charge @ ' + c.name
                });
                off += dur;
            }
        });
        return { ph, total: off, terminusDepartFrac: prof ? ((prof.charges.find(c => c.isTerminal) || {}).departSocFrac ?? null) : null };
    }
    function phasesAnim(trip) { return tripPhases(trip, null); }
    function rotationLength(trip) { return tripPhases(trip, null).total || 30; }

    function instancesPerDay(trip) {
        const n = num(trip, 'freqN', 1);
        return trip.freqUnit === 'week' ? Math.max(1, Math.round(n / 7)) : Math.max(1, Math.round(n));
    }

    // Take-off times are stored 1:1 with what's displayed (no hidden re-sequencing —
    // that caused drift). Defaults are laid out back-to-back; thereafter the
    // slot-based drag keeps a lane's rotations from ever overlapping.
    function instanceStarts(trip) {
        const dur = rotationLength(trip);
        const sched = loadSched();
        const n = instancesPerDay(trip);
        let arr = sched[trip.id];
        if (!Array.isArray(arr) || arr.length !== n) {
            // Default lay-out depends on whether the instances are the SAME
            // aircraft repeating or DIFFERENT aircraft:
            //   • one-way freq>1 → each flight is a separate plane that can
            //     depart in parallel, so default them all to 07:00 (the
            //     charger queue at the destination, if any, then staggers
            //     them naturally in the global sim).
            //   • retour/training → one aircraft flying sequential rotations,
            //     so lay them back-to-back (it can't start the next until the
            //     previous one lands).
            const parallel = fleetSeparate(trip) && n > 1;
            arr = [];
            for (let k = 0; k < n; k++) arr.push(parallel ? DAY_START : Math.min(DAY_END, DAY_START + k * dur));
            sched[trip.id] = arr; saveSched(sched);
        }
        return arr.slice();
    }

    // =====================================================================
    // GLOBAL DISCRETE-EVENT SIMULATION  (single source of truth)
    // ---------------------------------------------------------------------
    // The whole network is simulated ONCE. Every consumer (per-airport
    // scheduler, summary/peak, PDF report) then reads from this result, so
    // they can never disagree. The key property the old per-airport solver
    // lacked: a queue wait an aircraft incurs at airport A pushes its
    // ARRIVAL at airport B later — because an aircraft's rotation is one
    // continuous timeline across every airport it touches, not a fresh
    // calculation per airport.
    //
    // Model:
    //   • A LANE is one physical aircraft. retour/training aircraft fly
    //     sequential rotations (return home each cycle); a freq>1 one-way
    //     schedule needs a separate aircraft per flight, so each gets its
    //     own lane (matches the prior semantic split).
    //   • Each airport has a POOL of N chargers (one aircraft at a time).
    //   • Charge events are processed in global ARRIVAL-time order (FCFS).
    //     Claiming a charger updates its free-time; the wait elongates the
    //     aircraft's rotation, shifting every later phase — including
    //     arrivals at downstream airports.
    //
    // Output per lane → rotations[] → phases[] with ACTUAL absolute-minute
    // start times, so views just draw what the simulation says.
    // =====================================================================
    let _globalStamp = null, _globalCache = null;

    function _globalKey() {
        return (localStorage.getItem(FOLDER_KEY) || '') + '¦' +
               (localStorage.getItem(CFG_KEY) || '') + '¦' +
               (localStorage.getItem(SCHED_KEY) || '') + '¦' + _settingsStamp();
    }

    function runGlobal() {
        const stamp = _globalKey();
        if (stamp === _globalStamp && _globalCache) return _globalCache;
        _globalStamp = stamp;

        // 1. Build lanes (aircraft) with their canonical phase template.
        const lanes = [];
        loadTrips().forEach(t => {
            const { ph, total } = tripPhases(t, null);     // charges carry .ident
            const starts = instanceStarts(t);
            const base = { trip: t, ph, total, cap: batteryOf(t), cRate: _cRateOf(t) };
            if (fleetSeparate(t) && starts.length > 1) {
                // Separate aircraft (fleet) → one lane each, can fly in parallel.
                starts.forEach((d, k) => lanes.push({ ...base, desired: [d], planeIdx: k + 1, planeTotal: starts.length, schedSlot: k }));
            } else {
                // One shared aircraft doing sequential rotations → a single lane. When it flies >1x/day,
                // only the FINAL rotation tops the base to 100% (interim-deficit); rotTpl carries the
                // <=3 per-rotation phase-templates, else null (single template == today).
                const rotTpl = (starts.length > 1) ? _rotationTemplates(t) : null;
                lanes.push({ ...base, desired: starts, rotTpl });
            }
        });

        // 2. Charger pools — one slot per PHYSICAL charger, carrying its real
        //    power. A charge sizes its duration by the charger it actually
        //    claims, and peak draw is the sum of in-use slot powers, so it's
        //    bounded by the installed fleet.
        const pools = {};
        const poolOf = (ident) => {
            if (!pools[ident]) {
                const fp = getContext(ident).fleetPowers;
                const powers = (fp && fp.length) ? fp : [0];
                pools[ident] = powers.map(p => ({ power: p, freeAt: -Infinity }));
            }
            return pools[ident];
        };

        // 3. Per-lane runtime state: rotation records with mutable actual times.
        lanes.forEach(L => {
            const N = L.desired.length;
            // Per-rotation phase template: non-shared lanes reuse the single base template (== today);
            // a shared >1x/day lane assigns first/interim/last so interim rotations charge less.
            const tplFor = (k) => {
                if (!L.rotTpl) return { ph: L.ph, total: L.total };
                if (k === 0) return L.rotTpl.first;
                if (k === N - 1) return L.rotTpl.last;
                return L.rotTpl.interim;
            };
            L.rotations = L.desired.map((d, k) => {
                const tpl = tplFor(k);
                const seg = [];                            // ph indices that are real charges (per template)
                tpl.ph.forEach((p, i) => { if (p.kind === 'charge' && p.dur > 0) seg.push(i); });
                return {
                    takeoff: d, end: d, cumShift: 0, nextC: 0, tpl, _chargeSeg: seg,
                    // actual-timed copy of every phase (start filled in as we go)
                    phases: tpl.ph.map(p => ({
                        kind: p.kind, ident: p.ident || null, atRole: p.at,
                        start: 0, dur: p.dur, power: p.power || 0, energy: p.energy || 0,
                        atIdx: p.atIdx, label: p.label, wait: 0,
                    })),
                };
            });
        });

        // 4. Event queue ordered by arrival time. Each event = the next
        //    pending charge of (lane li, rotation k). Insertion-sorted; event
        //    counts are small (hundreds at most) so this is plenty fast.
        const pq = [];
        const pushEv = (e) => {
            let lo = 0, hi = pq.length;
            while (lo < hi) { const m = (lo + hi) >> 1; if (pq[m].arrival <= e.arrival) lo = m + 1; else hi = m; }
            pq.splice(lo, 0, e);
        };

        // Seed the next charge of a rotation (or finalise it + chain to the
        // lane's next rotation when no charges remain).
        function advance(li, k) {
            const L = lanes[li], rot = L.rotations[k];
            if (rot.nextC >= rot._chargeSeg.length) {
                rot.end = rot.takeoff + rot.tpl.total + rot.cumShift;
                if (k + 1 < L.desired.length) {
                    const next = L.rotations[k + 1];
                    next.takeoff = Math.max(L.desired[k + 1], rot.end);   // no self-overlap
                    advance(li, k + 1);
                }
                return;
            }
            const ci = rot._chargeSeg[rot.nextC];
            // cumShift = waits + (actual charger dur − baked dur) accumulated so
            // far this rotation, so a later charge's arrival reflects how long
            // the actual chargers really took, not the planCharging estimate.
            const arrival = rot.takeoff + rot.tpl.ph[ci].start + rot.cumShift;
            pushEv({ li, k, ci, arrival });
        }
        lanes.forEach((L, li) => advance(li, 0));

        // 5. Process charge arrivals in time order: claim the earliest-free
        //    charger, record the wait, push the rotation's next charge.
        while (pq.length) {
            const e = pq.shift();
            const L = lanes[e.li], rot = L.rotations[e.k], pool = poolOf(rot.tpl.ph[e.ci].ident);
            // MANUAL-FIRST: if this flight pinned a charger, claim a bay of that
            // power (the earliest-free one), waiting for it if every matching bay
            // is busy. A pin whose charger isn't in this airport's fleet leaves
            // bi < 0 and falls through to the automatic rule, so it can never
            // deadlock the sim.
            let bi = -1;
            const forced = rot.tpl.ph[e.ci].forcedPower || 0;
            if (forced) {
                for (let i = 0; i < pool.length; i++) {
                    if (pool[i].power !== forced) continue;
                    if (bi < 0 || pool[i].freeAt < pool[bi].freeAt) bi = i;
                }
            }
            // Otherwise claim the MOST POWERFUL charger free at arrival (operators
            // plug into the fastest open bay). pool is ordered power-desc, so the
            // first free slot scanning from the top is the strongest one available
            // now. If every charger is busy, wait for whichever frees earliest.
            if (bi < 0) {
                for (let i = 0; i < pool.length; i++) if (pool[i].freeAt <= e.arrival) { bi = i; break; }
                if (bi < 0) { bi = 0; for (let i = 1; i < pool.length; i++) if (pool[i].freeAt < pool[bi].freeAt) bi = i; }
            }
            const start = Math.max(e.arrival, pool[bi].freeAt);
            // Size this charge by the PHYSICAL charger it claimed — not the
            // planCharging estimate. Power is the slot's nameplate, capped by the
            // battery's acceptance (C-rate) so the recorded draw and duration are
            // both physical. The bay is still occupied for the (capped) duration.
            const power = _effPower(pool[bi].power, L.cap, L.cRate);
            const dur = _chargeMin(rot.tpl.ph[e.ci].energy, power, L.cap, rot.tpl.ph[e.ci].arrivalFrac);
            pool[bi].freeAt = start + dur;
            const phase = rot.phases[e.ci];
            phase.start = start;                 // ACTUAL charge start (queue wait already in)
            phase.dur = dur;                      // ACTUAL duration on the claimed charger
            phase.power = power;                  // ACTUAL draw — used for peak
            phase.wait = start - e.arrival;       // queue wait at THIS airport
            // Shift the rest of the rotation by the wait AND by any difference
            // between the actual charger duration and the baked estimate.
            rot.cumShift += phase.wait + (dur - rot.tpl.ph[e.ci].dur);
            rot.nextC += 1;
            advance(e.li, e.k);
        }

        // 6. Forward-walk each rotation to stamp actual start times on the
        //    NON-charge (fly) phases — each begins where the previous ended.
        //    Charge starts are already actual; the gap before a charge (its
        //    queue wait) is captured in phase.wait for the renderer.
        lanes.forEach(L => L.rotations.forEach(rot => {
            let t = rot.takeoff;
            rot.tpl.ph.forEach((p, i) => {
                const ph = rot.phases[i];
                if (ph.kind === 'charge' && ph.dur > 0) {
                    t = ph.start + ph.dur;        // charge body already placed at actual start
                } else {
                    ph.start = t; t += ph.dur;
                }
            });
            rot.end = t;
        }));

        _globalCache = { lanes, pools };
        return _globalCache;
    }

    // Per-airport view derived from the global simulation. Returns the lanes
    // (aircraft) that touch `ident`, each with its rotations expressed as
    // actual-timed phases relative to that rotation's take-off (so the
    // renderer can place an instance at `takeoff` and lay phases inside it).
    function rotationsAt(ident) {
        const g = runGlobal();
        const out = [];
        g.lanes.forEach(L => {
            if (!roleAt(L.trip, ident)) return;
            out.push({
                trip: L.trip, planeIdx: L.planeIdx, planeTotal: L.planeTotal,
                schedSlot: L.schedSlot, desired: L.desired,
                rotations: L.rotations.map(rot => {
                    // Build a render-ready phase list relative to take-off,
                    // inserting an explicit 'wait' bar wherever the aircraft
                    // queued for a charger at THIS airport.
                    const rel = [];
                    rot.phases.forEach(ph => {
                        const relStart = ph.start - rot.takeoff;
                        if (ph.kind === 'charge' && ph.wait > 0) {
                            // A queue wait fills the gap before a charge. If it
                            // happened HERE it's the amber "waiting for charger"
                            // bar; if it happened at another airport on this
                            // rotation it's a neutral "queued elsewhere" bar so
                            // the lane has no unexplained blank space.
                            const here = ph.ident === ident;
                            rel.push({
                                kind: here ? 'wait' : 'waitElsewhere',
                                start: relStart - ph.wait, dur: ph.wait,
                                label: here ? 'Waiting for free charger'
                                            : 'Queued at ' + String(ph.label || 'another airport').replace(/^Charge @ /, ''),
                            });
                        }
                        rel.push({
                            kind: ph.kind,
                            atX: ph.kind === 'charge' && ph.ident === ident,
                            start: relStart, dur: ph.dur, power: ph.power, energy: ph.energy,
                            atIdx: ph.atIdx, label: ph.label,
                        });
                    });
                    return { takeoff: rot.takeoff, end: rot.end, phases: rel };
                }),
            });
        });
        return out;
    }

    function summary(ident) {
        const g = runGlobal();
        const evs = [];
        let latest = DAY_START;
        g.lanes.forEach(L => {
            if (!roleAt(L.trip, ident)) return;
            L.rotations.forEach(rot => {
                rot.phases.forEach(ph => {
                    if (ph.kind === 'charge' && ph.ident === ident && ph.dur > 0 && ph.power) {
                        evs.push({ tm: ph.start, d: ph.power });
                        evs.push({ tm: ph.start + ph.dur, d: -ph.power });
                    }
                });
                if (rot.end > latest) latest = rot.end;
            });
        });
        evs.sort((a, b) => a.tm - b.tm || a.d - b.d);
        let cur = 0, peak = 0;
        evs.forEach(e => { cur += e.d; if (cur > peak) peak = cur; });
        return { peakKw: peak, latestEnd: latest, overflow: latest > DAY_END };
    }
    function peakPowerKw(ident) { return summary(ident).peakKw; }

    // ---------- rendering ----------
    function renderInto(container, ident) {
        if (!container) return;
        const rows = rotationsAt(ident);             // actual-timed, from the global sim
        container.innerHTML = '';
        if (!rows.length) { container.innerHTML = '<p class="text-muted small mb-0">No flights touch this airport yet.</p>'; return; }

        const sched = loadSched();
        const ids = new Set(loadTrips().map(t => t.id));
        let pruned = false;
        Object.keys(sched).forEach(k => { if (!ids.has(k)) { delete sched[k]; pruned = true; } });
        if (pruned) saveSched(sched);

        const legend = document.createElement('div');
        legend.className = 'est-note mb-2';
        legend.innerHTML =
            'Each bar is one <strong>rotation</strong> (a single aircraft: depart → charge → return → recharge). Same aircraft can\'t overlap itself; a charger serves one plane at a time. Drag to reschedule.<br>' +
            '<span style="display:inline-block;width:11px;height:11px;background:#0d6efd;border-radius:2px;vertical-align:middle"></span> flying' +
            ' &nbsp;<span style="display:inline-block;width:11px;height:11px;background:#198754;border-radius:2px;vertical-align:middle"></span> charging here' +
            ' &nbsp;<span style="display:inline-block;width:11px;height:11px;background:#9bd3ad;border-radius:2px;vertical-align:middle"></span> charging elsewhere' +
            ' &nbsp;<span style="display:inline-block;width:11px;height:11px;background:repeating-linear-gradient(45deg,#f0ad4e,#f0ad4e 3px,#fbe4c4 3px,#fbe4c4 6px);border-radius:2px;vertical-align:middle"></span> waiting for charger' +
            ' &nbsp;<span style="display:inline-block;width:11px;height:11px;background:repeating-linear-gradient(45deg,#cbd5e1,#cbd5e1 3px,#eef2f6 3px,#eef2f6 6px);border-radius:2px;vertical-align:middle"></span> queued at another airport';
        container.appendChild(legend);

        // extend the timeline if any actual rotation spills past 23:00
        let maxMin = DAY_END;
        rows.forEach(row => row.rotations.forEach(rot => { if (rot.end > maxMin) maxMin = rot.end; }));
        const lastHour = Math.min(30, Math.max(23, Math.ceil(maxMin / 60)));

        const scroll = document.createElement('div');
        scroll.style.overflowX = 'auto';
        const inner = document.createElement('div');
        inner.style.minWidth = (LABEL_W + (lastHour * 60 - DAY_START) * PX + 16) + 'px';
        inner.style.position = 'relative';

        const axis = document.createElement('div');
        axis.style.cssText = `position:relative;height:16px;margin-left:${LABEL_W}px`;
        for (let h = 7; h <= lastHour; h++) {
            const x = (h * 60 - DAY_START) * PX;
            const lbl = document.createElement('div');
            lbl.textContent = String(h).padStart(2, '0');
            lbl.style.cssText = `position:absolute;left:${x}px;top:0;font-size:.65rem;color:#999;transform:translateX(-50%)`;
            axis.appendChild(lbl);
        }
        inner.appendChild(axis);

        const chart = document.createElement('div');
        chart.style.cssText = `position:relative;height:${rows.length * LANE_H}px;border:1px solid #eee;border-radius:6px`;
        for (let h = 7; h <= lastHour; h++) {
            const x = LABEL_W + (h * 60 - DAY_START) * PX;
            const line = document.createElement('div');
            line.style.cssText = `position:absolute;left:${x}px;top:0;bottom:0;width:1px;background:#f1f1f1`;
            chart.appendChild(line);
        }

        rows.forEach((row, li) => {
            const trip = row.trip;
            const role = roleAt(trip, ident);
            const roleLabel = role === 'home' ? 'departure' : role === 'stop' ? 'stop' : 'destination';
            const lane = document.createElement('div');
            lane.style.cssText = `position:absolute;left:0;right:0;top:${li * LANE_H}px;height:${LANE_H}px;border-top:${li ? '1px solid #f4f4f4' : 'none'}`;

            const label = document.createElement('div');
            label.title = `${trip.originName} → ${trip.destName} (${trip.planeName})`;
            label.style.cssText = `position:absolute;left:0;width:${LABEL_W}px;height:100%;padding:4px 8px;box-sizing:border-box;overflow:hidden;font-size:.74rem;line-height:1.15`;
            const subRight = row.planeIdx
                ? `aircraft ${row.planeIdx} of ${row.planeTotal}`
                : `${row.rotations.length}/day`;
            label.innerHTML = `<div style="font-weight:600">${shorten(trip.originName)} → ${shorten(trip.destName)}</div>` +
                `<div class="text-muted" style="font-size:.68rem">${trip.planeName} · ${roleLabel}${trip.multiLeg ? ' · multi-leg' : ''} · ${subRight}</div>`;
            lane.appendChild(label);

            const track = document.createElement('div');
            track.style.cssText = `position:absolute;left:${LABEL_W}px;right:0;top:0;bottom:0`;
            row.rotations.forEach((rot, k) => {
                // Each rotation's phases are already actual-timed (relative to
                // its take-off) by the global sim — including any 'wait' bars
                // for queueing. The renderer just lays them out; no per-airport
                // re-derivation. A delay upstream is already baked into this
                // rotation's take-off, so the bars sit at globally-consistent
                // clock positions.
                const schedSlot = (row.schedSlot != null) ? row.schedSlot : k;
                track.appendChild(buildInstance(trip, schedSlot, rot.takeoff, rot.phases));
            });
            lane.appendChild(track);
            chart.appendChild(lane);
        });

        inner.appendChild(chart);
        scroll.appendChild(inner);
        container.appendChild(scroll);
    }

    function buildInstance(trip, idx, start, ph) {
        const total = ph.reduce((m, p) => Math.max(m, p.start + p.dur), 0) || 30;
        const inst = document.createElement('div');
        inst.style.cssText = `position:absolute;top:9px;height:28px;width:${total * PX}px;cursor:grab;touch-action:none`;
        inst._start = start;

        ph.forEach(p => {
            const bar = document.createElement('div');
            let bg = '#0d6efd';
            if (p.kind === 'charge') bg = p.atX ? '#198754' : '#9bd3ad';
            if (p.kind === 'wait') bg = 'repeating-linear-gradient(45deg,#f0ad4e,#f0ad4e 4px,#fbe4c4 4px,#fbe4c4 8px)';
            if (p.kind === 'waitElsewhere') bg = 'repeating-linear-gradient(45deg,#cbd5e1,#cbd5e1 4px,#eef2f6 4px,#eef2f6 8px)';
            bar.style.cssText = `position:absolute;top:0;height:100%;left:${p.start * PX}px;width:${Math.max(2, p.dur * PX)}px;background:${bg};border-radius:3px;border:1px solid rgba(0,0,0,.12)`;
            inst.appendChild(bar);
        });

        const place = (s) => {
            inst.style.left = ((s - DAY_START) * PX) + 'px';
            const overflow = (s + total) > DAY_END;
            inst.style.outline = overflow ? '2px solid #dc3545' : 'none';
            const lines = [`${trip.originName} → ${trip.destName} — rotation`, `Take-off ${fmtTime(s)}`];
            ph.slice().sort((a, b) => a.start - b.start).forEach(p => {
                const icon = p.kind === 'fly' ? '✈' : (p.kind === 'wait' ? '⏳' : (p.kind === 'waitElsewhere' ? '🅿' : '⚡'));
                lines.push(`${icon} ${p.label}: ${fmtDur(p.dur)} (${fmtTime(s + p.start)}–${fmtTime(s + p.start + p.dur)})`);
            });
            if (overflow) lines.push('⚠ extends past 23:00 closing time');
            inst.title = lines.join('\n');
        };
        place(start);

        inst.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            try { inst.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            inst.style.cursor = 'grabbing'; inst.style.opacity = '.85'; inst.style.zIndex = '5';

            // Free move; on release the lane re-cascades so rotations slide along and
            // never overlap (a single aircraft can't be in two states at once).
            const startX = e.clientX, origStart = inst._start;
            const move = (ev) => {
                let s = origStart + (ev.clientX - startX) / PX;
                s = Math.max(DAY_START, Math.min(DAY_END, Math.round(s / SNAP) * SNAP));
                inst._start = s; place(s);
            };
            const up = () => {
                inst.style.cursor = 'grab'; inst.style.opacity = '1'; inst.style.zIndex = '';
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                const s2 = loadSched();
                if (!Array.isArray(s2[trip.id])) s2[trip.id] = [];
                s2[trip.id][idx] = inst._start; saveSched(s2);
                if (onChange) onChange();   // re-cascade lane + recompute charger waits / peak
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        });
        return inst;
    }

    function init(opts) {
        opts = opts || {};
        catalog = opts.chargers || {};
        onChange = opts.onChange || null;
        _stamp = null; _ctx = {}; _globalStamp = null; _globalCache = null;
    }

    return { init, renderInto, peakPowerKw, summary, tripsAt, phasesAnim, instanceStarts, roleAt, runGlobal, rotationsAt, tripPhases, dailyChargeMinutesAt, DAY_START, DAY_END, SPAN };
})();
