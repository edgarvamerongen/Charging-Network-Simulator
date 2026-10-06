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
 *   Take-offs are AUTOMATIC unless the user fixed one (dragged it): the scheduler
 *   delays an automatic departure rather than let the aircraft queue at a charger
 *   (departure first). Waiting is left only where that can't absorb it (a busy
 *   day, too few chargers) and for fixed take-offs, which fly exactly as set.
 *   Charging order: first come, first served; each charge takes the charger slot
 *   that finishes it first.
 *
 * Charge times/energies are sized by the charger the AIRPORT provides (its fleet,
 * assigned via charging.js) — never the trip's own simulation charger.
 */
window.CNSScheduler = (function () {
    const FOLDER_KEY = 'cns_folder', SCHED_KEY = 'cns_schedule', CFG_KEY = 'cns_airport_cfg';
    const DAY_START = 7 * 60, DAY_END = 23 * 60, SPAN = DAY_END - DAY_START;
    const SNAP = 5, PX = 1.05, LANE_H = 46, LABEL_W = 150;
    // Hard upper bound on rotations/day per trip. A frequency typo or paste
    // (e.g. "10000") otherwise fans out into that many lanes, rotation records,
    // DOM rows and animated map markers — with O(n^2) event-queue work — which
    // locks up the browser tab. No real schedule needs anywhere near this many
    // daily rotations, so we clamp here, the single chokepoint every entry
    // point (desktop, mobile, restored localStorage) flows through.
    const MAX_INSTANCES_PER_DAY = 200;

    let catalog = {};
    let onChange = null;

    const loadTrips = () => CNSState.getJSON(FOLDER_KEY, []);
    // cns_schedule holds, per trip, one take-off per rotation: a number is a FIXED take-off, null an
    // automatic one (see _storedStarts). Schedules saved before automatic placement (no _v) held a
    // number in every slot, the 07:00 / back-to-back default included: a slot still on that default
    // becomes automatic, anything else was dragged there and stays fixed.
    const loadSched = () => {
        const s = CNSState.getJSON(SCHED_KEY, {}) || {};
        if (s._v === 2) return s;
        const out = { _v: 2 }, trips = loadTrips();
        Object.keys(s).forEach(id => {
            const t = trips.find(x => x.id === id), arr = s[id];
            if (!t || !Array.isArray(arr)) return;
            const def = _defaultLayout(t, arr.length);
            out[id] = arr.map((v, k) => (typeof v === 'number' && isFinite(v) && Math.abs(v - def[k]) > 0.5) ? v : null);
        });
        saveSched(out);
        return out;
    };
    const saveSched = (s) => CNSState.setJSON(SCHED_KEY, s);
    let _cfgOverride = null;   // set only inside whatIfChargers()
    const loadCfg = () => _cfgOverride || CNSState.getJSON(CFG_KEY, {});

    const num = (t, k, d = 0) => { const v = Number(t[k]); return isFinite(v) ? v : d; };
    // Trip battery + the role a trip plays at an airport are CNSDemand's model (demand.js
    // loads first in every shell); referenced inline, like the CNSUnits formatters below.
    const batteryOf = (t) => CNSDemand.batteryOf(t);
    const roleAt = (t, ident) => CNSDemand.roleAt(t, ident);
    const shorten = (s, n = 16) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');
    // Clock + duration formatting live in CNSUnits (single source of truth). They're
    // only used in the DOM-render paths below, where units.js is always loaded first;
    // referenced inline (not at module-eval) so the vm test harness, which loads this
    // module without CNSUnits, never trips over them.
    const fmtTime = (m) => CNSUnits.fmtClock(m);
    const fmtDur = (m) => CNSUnits.fmtDuration(m);
    // HTML-escape before interpolating a name into innerHTML. Custom aircraft
    // names are user input; falls back to a local impl if the page didn't define
    // a shared one.
    const esc = (s) => (window.escHtml ? window.escHtml(s) : String(s ?? '').replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

    function tripsAt(ident) { return loadTrips().filter(t => roleAt(t, ident)); }

    // Does a freq>1 trip mean SEPARATE aircraft (a fleet, flying in parallel)
    // or ONE aircraft doing sequential rotations?
    //   • one-way  → always separate (the plane lands at the dest and stays).
    //   • retour / circular → user's choice via trip.fleetMode; defaults to
    //                'separate' (an operator adding "3/day" usually means 3 tails).
    //   • training → defaults to 'shared' (a school plane flies N sessions),
    //                unless the user picked 'separate'.
    function fleetSeparate(trip) {
        if (trip.tripType === 'one-way') return true;
        if (trip.fleetMode === 'separate') return true;
        if (trip.fleetMode === 'shared') return false;
        return trip.tripType === 'retour' || trip.tripType === 'circular';   // unset default
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
            return { _i: i, energy: prof ? prof.energyAt(ident) : 0, size: batteryOf(t), forcedChargerId: t.chargerOverride, nChargers: _nChOf(t) };
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
    const _route   = (plane) => _rs() ? CNSSettings.routingFactor(plane) : 1.0;   // identity for VFR planes
    // Catalog plane for a trip (regime / max_charge_kw gates) — trips persist only planeId.
    const _planeOf = (trip) => (window.PLANES_BY_ID || {})[trip && trip.planeId] || trip || {};
    const _chargeMin = (energy, power, batt, soc) => {
        if (!_rs() || !power) return power ? energy / power * 60 : 0;
        return CNSSettings.chargeTimeMin(energy, power, batt, soc);
    };
    // The draw `t` minutes into that charge (the taper _chargeMin integrates); flat without settings.
    const _powerAt = (t, energy, power, batt, soc) =>
        (_rs() && CNSSettings.chargePowerAt) ? CNSSettings.chargePowerAt(t, energy, power, batt, soc) : power;
    // Chargers this trip's aircraft draws AT ONCE (catalog simultaneous_charging;
    // 1 for everyone else). Single source: CNSFlight.nChargers — the engine applies
    // the same count to its charge times, planCharging books this many bays, and
    // the global sim claims this many physical slots.
    const _nChOf = (trip) => (window.CNSFlight && CNSFlight.nChargers)
        ? CNSFlight.nChargers((window.PLANES_BY_ID || {})[trip.planeId] || trip || {}) : 1;
    // Battery acceptance cap: a small pack can't absorb an over-sized charger.
    // `power` here must already be the charger's nameplate; the result is the
    // EFFECTIVE power used for both charge time and peak draw. Identity when the
    // acceptance toggle is off. The C-rate is the global CNSSettings one.
    const _effPower = (power, batt, maxKw) =>
        (_rs() && CNSSettings.effectiveChargePower) ? CNSSettings.effectiveChargePower(power, batt, maxKw) : (power || 0);
    const _maxKwOf = (trip) => _planeOf(trip).max_charge_kw;   // published OEM acceptance cap (may be null)
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

    function tripPhases(trip, viewIdent, ctx, rotOpts) {
        if (trip.multiLeg) return _multiLegPhases(trip, viewIdent, ctx, rotOpts);
        ctx = ctx || _desContext(trip);
        const legs = trip.tripType === 'retour' ? 2 : 1;
        const route = _route(_planeOf(trip));
        const legMin = num(trip, 'flightTimeH') * 60 / legs * route;
        const batt = batteryOf(trip);

        const ph = []; let off = 0;
        ph.push({ kind: 'fly', leg: 'out', start: off, dur: legMin, label: 'Fly to ' + trip.destName }); off += legMin;

        // Charge energy at each end comes from the engine via energyAt(ident) — which also
        // resolves TRAINING (its charge role is 'training', not 'dest'). An unresolvable trip
        // (no profile) contributes 0; app-saved trips always carry coords + spec, so that's
        // reachable only by pathological pre-migration localStorage the coord-rebuild missed.
        const prof = _tripProfile(trip, rotOpts);
        const destEnergy = prof ? prof.energyAt(trip.destIdent) : 0;
        const destArr = prof ? ((prof.charges.find(c => c.ident === trip.destIdent) || {}).arrivalSocFrac ?? null) : null;
        const destPower = _effPower(ctx.chargerAt(trip.destIdent), batt, _maxKwOf(trip));
        const destMin = _chargeMin(destEnergy, destPower, batt, destArr);
        const forcedPower = _forcedPower(trip);
        if (destMin > 0) { ph.push({ kind: 'charge', at: 'dest', ident: trip.destIdent, name: trip.destName, atX: viewIdent === trip.destIdent, start: off, dur: destMin, power: destPower, energy: destEnergy, arrivalFrac: destArr, forcedPower, label: 'Charge @ ' + trip.destName }); off += destMin; }

        if (trip.tripType === 'retour') {
            ph.push({ kind: 'fly', leg: 'back', start: off, dur: legMin, label: 'Fly back to ' + trip.originName }); off += legMin;
            const homeEnergy = prof ? prof.energyAt(trip.originIdent) : 0;
            const homeArr = prof ? ((prof.charges.find(c => c.ident === trip.originIdent && c.role === 'home') || {}).arrivalSocFrac ?? null) : null;
            const homePower = _effPower(ctx.chargerAt(trip.originIdent), batt, _maxKwOf(trip));
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
        const route = _route(_planeOf(trip));
        const batt = batteryOf(trip);
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
            const power = _effPower(ctx.chargerAt(c.ident), batt, _maxKwOf(trip));
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
        const perDay = trip.freqUnit === 'week' ? Math.round(n / 7) : Math.round(n);
        // Clamp to [1, MAX]: floors NaN/0/negatives to 1 and caps runaway
        // frequencies so the scheduler/animation can never be asked to build an
        // unbounded number of rotations (see MAX_INSTANCES_PER_DAY).
        if (!(perDay >= 1)) return 1;
        return Math.min(MAX_INSTANCES_PER_DAY, perDay);
    }

    // Stored take-offs of a trip's rotations: a number is FIXED (the user dragged it), null is
    // AUTOMATIC (the global sim places it). Missing or resized (frequency change) → all automatic.
    function _storedStarts(trip) {
        const sched = loadSched(), n = instancesPerDay(trip);
        const arr = sched[trip.id];
        if (Array.isArray(arr) && arr.length === n) return arr.map(v => (typeof v === 'number' && isFinite(v)) ? v : null);
        sched[trip.id] = new Array(n).fill(null); saveSched(sched);
        return sched[trip.id].slice();
    }

    // The nominal lay-out before any queueing: SEPARATE aircraft (a fleet) all leave at 07:00, ONE
    // aircraft flies its rotations back to back (it can't start the next until the previous one
    // lands). It was the stored default before take-offs were placed automatically.
    function _defaultLayout(trip, n) {
        const parallel = fleetSeparate(trip) && n > 1, dur = parallel ? 0 : rotationLength(trip);
        const arr = [];
        for (let k = 0; k < n; k++) arr.push(parallel ? DAY_START : Math.min(DAY_END, DAY_START + k * dur));
        return arr;
    }

    // Actual take-off of each of a trip's rotations as the day is flown (automatic ones where the
    // scheduler placed them); the nominal lay-out for a trip that isn't in the network.
    function instanceStarts(trip) {
        const ls = runGlobal().lanes.filter(L => L.trip.id === trip.id);
        if (!ls.length) return _defaultLayout(trip, instancesPerDay(trip));
        return ls[0].schedSlot != null ? ls.map(L => L.rotations[0].takeoff) : ls[0].rotations.map(r => r.takeoff);
    }

    /** Fix rotation k of a trip at take-off `t` (minutes), or hand it back to automatic placement
        (t = null). One aircraft's earlier rotations are fixed where they fly now, so fixing a later
        rotation never reshuffles the start of its day. */
    function setTakeoff(tripId, k, t) {
        const trip = loadTrips().find(x => x.id === tripId);
        if (!trip) return;
        const sched = loadSched(), n = instancesPerDay(trip);
        const arr = (Array.isArray(sched[tripId]) && sched[tripId].length === n) ? sched[tripId].slice() : new Array(n).fill(null);
        if (t != null && !(fleetSeparate(trip) && n > 1)) {
            const L = runGlobal().lanes.find(x => x.trip.id === tripId);
            for (let j = 0; L && j < k; j++) if (typeof arr[j] !== 'number') arr[j] = Math.round(L.rotations[j].takeoff);
        }
        arr[k] = (t == null) ? null : Math.round(t);
        sched[tripId] = arr; saveSched(sched);
    }
    /** Every take-off back to automatic placement. */
    function releaseAll() { saveSched({ _v: 2 }); }
    /** Number of fixed take-offs in the network. */
    function fixedCount() {
        const s = loadSched();
        return loadTrips().reduce((c, t) => { const a = s[t.id]; return c + (Array.isArray(a) && a.length === instancesPerDay(t) ? a.filter(v => typeof v === 'number').length : 0); }, 0);
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
    //   • Each airport has a POOL of N chargers (one aircraft at a time),
    //     each with a calendar of the charges booked on it.
    //   • Charge events are processed in ARRIVAL-time order (FCFS); each
    //     charge takes the slot that FINISHES it first. A queue wait
    //     elongates the aircraft's rotation, shifting every later phase —
    //     including arrivals at downstream airports.
    //   • FIXED take-offs (dragged by the user) are flown first, exactly as
    //     set. AUTOMATIC ones are then fitted around them and leave as much
    //     later as they can without finishing any later (departure first),
    //     so they land when their charger is free instead of queueing.
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

    // A charger's calendar: the charges booked on it, {s, e} sorted by start.
    const _freeOver = (bay, s, e) => !bay.busy.some(iv => iv.s < e && s < iv.e);
    function _insert(bay, iv) {
        let i = bay.busy.length;
        while (i && bay.busy[i - 1].s > iv.s) i--;
        bay.busy.splice(i, 0, iv);
        return { bay, iv };
    }
    const _book = (bay, s, e) => _insert(bay, { s, e });
    // The slot that STARTS last for a charge that must end by `bound` (as late as
    // possible): at the bound and at every earlier moment a booking starts, the
    // bays free for the whole charge before it (strongest `want` for a multi-
    // charger aircraft). A stronger bay charges faster, so it can start later.
    function _slotBefore(pool, bays, bound, want, durOf) {
        const ends = [bound];
        bays.forEach(i => pool[i].busy.forEach(iv => { if (iv.s < bound) ends.push(iv.s); }));
        ends.sort((x, y) => y - x);
        let best = null;
        for (const t of ends) {
            if (best && t <= best.start) break;                // an earlier end can't start later
            const sets = want === 1 ? bays.map(i => [i])
                : [bays.filter(i => _freeOver(pool[i], t - 1e-6, t)).slice(0, want)];
            sets.forEach(set => {
                if (set.length < want) return;
                const dur = durOf(set), s = t - dur;
                if (!set.every(i => _freeOver(pool[i], s, t))) return;
                if (!best || s > best.start + 1e-6) best = { set, start: s, dur };
            });
        }
        return best;
    }
    // The slot that FINISHES first for a charge arriving at `a` (minimal charging
    // time): at the arrival and at every later moment a booking ends, the bays
    // free for the whole charge. A multi-charger aircraft (`want` > 1) takes the
    // strongest `want` bays free at that moment. The earlier start wins a tie,
    // then the stronger bay (bays are power-desc).
    // ponytail: rescans the calendars per candidate (O(bookings²) per charge);
    // index them if a network ever books thousands of charges a day.
    function _slot(pool, bays, a, want, durOf) {
        const times = [a];
        bays.forEach(i => pool[i].busy.forEach(iv => { if (iv.e > a) times.push(iv.e); }));
        times.sort((x, y) => x - y);
        let best = null;
        for (const t of times) {
            if (best && t >= best.start + best.dur) break;     // a later start can't finish first
            const sets = want === 1 ? bays.map(i => [i])
                : [bays.filter(i => _freeOver(pool[i], t, t + 1e-6)).slice(0, want)];
            sets.forEach(set => {
                if (set.length < want) return;
                const dur = durOf(set);
                if (!set.every(i => _freeOver(pool[i], t, t + dur))) return;
                if (!best || t + dur < best.start + best.dur - 1e-6) best = { set, start: t, dur };
            });
        }
        return best;
    }

    // One schedule of the whole network (the plan: take-offs, charge order, bays).
    function _simulate() {
        // 1. Build lanes (aircraft) with their canonical phase template. `desired`
        //    holds each rotation's FIXED take-off, or null where it is automatic.
        const lanes = [];
        // Infeasible flights (recompute marked feasible:false — no valid route at current
        // settings) don't fly, so they contribute no lane, peak, or rotation. Legacy trips
        // have no `feasible` field → undefined !== false keeps them, unchanged.
        loadTrips().filter(t => t.feasible !== false).forEach(t => {
            const { ph, total } = tripPhases(t, null);     // charges carry .ident
            const starts = _storedStarts(t);
            const base = { trip: t, ph, total, cap: batteryOf(t), nCh: _nChOf(t), maxKw: _maxKwOf(t) };
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
        //    power and its calendar. A charge sizes its duration by the charger
        //    it actually claims, and peak draw is the sum of in-use slot powers,
        //    so it's bounded by the installed fleet.
        const pools = {};
        const poolOf = (ident) => {
            if (!pools[ident]) {
                const fp = getContext(ident).fleetPowers;
                const powers = (fp && fp.length) ? fp : [0];
                pools[ident] = powers.map(p => ({ power: p, busy: [] }));
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
                    takeoff: 0, end: 0, cumShift: 0, nextC: 0, tpl, _chargeSeg: seg, fixed: d != null,
                    // actual-timed copy of every phase (start filled in as we go)
                    phases: tpl.ph.map(p => ({
                        kind: p.kind, ident: p.ident || null, atRole: p.at,
                        start: 0, dur: p.dur, power: p.power || 0, energy: p.energy || 0,
                        atIdx: p.atIdx, label: p.label, wait: 0, queue: 0,
                    })),
                };
            });
            // Every rotation up to the lane's last FIXED take-off flies in phase A,
            // the automatic rest in phase B (one aircraft keeps its order).
            L.nFixed = 1 + L.desired.reduce((m, d, k) => (d != null ? k : m), -1);
        });

        // 4. One event-driven pass over lane rotations [from, to): charge arrivals
        //    in time order (FCFS), insertion-sorted (event counts are small), each
        //    claiming the slot that finishes first.
        function pass(runs) {
            const pq = [];
            const pushEv = (e) => {
                let lo = 0, hi = pq.length;
                while (lo < hi) { const m = (lo + hi) >> 1; if (pq[m].arrival <= e.arrival) lo = m + 1; else hi = m; }
                pq.splice(lo, 0, e);
            };
            // Seed the next charge of a rotation (or finalise it + chain to the
            // lane's next rotation when no charges remain).
            function advance(li, k, to) {
                const L = lanes[li], rot = L.rotations[k];
                if (rot.nextC >= rot._chargeSeg.length) {
                    rot.end = rot.takeoff + rot.tpl.total + rot.cumShift;
                    if (k + 1 < to) {
                        const next = L.rotations[k + 1];
                        next.takeoff = Math.max(L.desired[k + 1] ?? DAY_START, rot.end);   // no self-overlap
                        advance(li, k + 1, to);
                    }
                    return;
                }
                const ci = rot._chargeSeg[rot.nextC];
                // cumShift = waits + (actual charger dur − baked dur) accumulated so
                // far this rotation, so a later charge's arrival reflects how long
                // the actual chargers really took, not the planCharging estimate.
                pushEv({ li, k, ci, to, arrival: rot.takeoff + rot.tpl.ph[ci].start + rot.cumShift });
            }
            runs.forEach(({ li, from, to }) => {
                const L = lanes[li], rot = L.rotations[from];
                rot.takeoff = Math.max(L.desired[from] ?? DAY_START, from ? L.rotations[from - 1].end : -Infinity);
                advance(li, from, to);
            });
            while (pq.length) {
                const e = pq.shift();
                const L = lanes[e.li], rot = L.rotations[e.k], cph = rot.tpl.ph[e.ci], pool = poolOf(cph.ident);
                // MANUAL-FIRST: a flight that pinned a charger only considers bays of
                // that power. A pin whose charger isn't in this airport's fleet matches
                // none and falls back to every bay, so it can never deadlock the sim.
                let bays = pool.map((_, i) => i);
                const pinned = cph.forcedPower ? bays.filter(i => pool[i].power === cph.forcedPower) : [];
                if (pinned.length) bays = pinned;
                // A multi-charger aircraft (L.nCh > 1, catalog simultaneous_charging)
                // claims up to nCh DISTINCT bays at once — all occupied for the same
                // (shorter) duration, combined draw.
                const want = Math.max(1, Math.min(L.nCh || 1, bays.length));
                // Size a charge by the PHYSICAL chargers it claims — not the planCharging
                // estimate. Power is the claimed slots' nameplate sum, each capped by the
                // battery's acceptance (C-rate), then the published acceptance caps the
                // COMBINED draw, so the recorded draw and duration are both physical.
                const powerOn = (set) => _effPower(set.reduce((s, i) => s + _effPower(pool[i].power, L.cap), 0), L.cap, L.maxKw);
                const durOf = (set) => _chargeMin(cph.energy, powerOn(set), L.cap, cph.arrivalFrac);
                const slot = _slot(pool, bays, e.arrival, want, durOf);
                const phase = rot.phases[e.ci];
                phase.start = slot.start;             // ACTUAL charge start (queue wait already in)
                phase.dur = slot.dur;                 // ACTUAL duration on the claimed charger(s)
                phase.power = powerOn(slot.set);      // ACTUAL draw — used for peak
                phase.bays = slot.set;                // which chargers (smart charging flies the plan on them)
                phase.wait = phase.queue = slot.start - e.arrival;   // queue wait at THIS airport
                phase._bk = slot.dur > 0 ? slot.set.map(i => _book(pool[i], slot.start, slot.start + slot.dur)) : [];
                phase._ctx = { pool, bays, want, powerOn, durOf };   // to re-plan it (step 5)
                // Shift the rest of the rotation by the wait AND by any difference
                // between the actual charger duration and the baked estimate.
                rot.cumShift += phase.wait + (slot.dur - cph.dur);
                rot.nextC += 1;
                advance(e.li, e.k, e.to);
            }
        }
        // Phase A: fixed take-offs, flown as set. Phase B: automatic ones, around them.
        pass(lanes.map((L, li) => ({ li, from: 0, to: L.nFixed })).filter(r => r.to > 0));
        pass(lanes.map((L, li) => ({ li, from: L.nFixed, to: L.desired.length })).filter(r => r.to > r.from));

        // 5. DEPARTURE FIRST (automatic take-offs): each automatic rotation is
        //    re-planned backwards from where it ends — its last charge as late as
        //    it can still end there, each earlier charge as late as the next one
        //    allows — so it leaves as late as it can without finishing any later,
        //    and lands as its charger frees up instead of queueing for it. The
        //    latest-ending rotations go first and the passes repeat, since each
        //    re-plan can open room for another. A wait is left only where the
        //    calendar allows nothing better (a busy day, too few chargers).
        // ponytail: repeats until nothing moves, capped at 50 passes.
        function replan(rot) {
            const idx = rot._chargeSeg, P = rot.phases;
            if (!idx.length) return false;
            const legs = (a, b) => { let s = 0; for (let j = a; j < b; j++) s += P[j].dur; return s; };   // flying between charges
            const own = idx.flatMap(ci => P[ci]._bk);
            own.forEach(({ bay, iv }) => bay.busy.splice(bay.busy.indexOf(iv), 1));   // off the calendar while re-planned
            const plan = [];
            let bound = rot.end - legs(idx[idx.length - 1] + 1, P.length);
            for (let j = idx.length - 1; j >= 0 && bound != null; j--) {
                const c = P[idx[j]]._ctx, slot = _slotBefore(c.pool, c.bays, bound, c.want, c.durOf);
                plan[j] = slot;
                bound = slot ? slot.start - legs(j ? idx[j - 1] + 1 : 0, idx[j]) : null;
            }
            if (bound == null || !(bound > rot.takeoff + 1e-6)) { own.forEach(({ bay, iv }) => _insert(bay, iv)); return false; }
            rot.takeoff = bound;
            plan.forEach((slot, j) => {
                const ph = P[idx[j]], c = ph._ctx;
                ph.start = slot.start; ph.dur = slot.dur; ph.power = c.powerOn(slot.set); ph.bays = slot.set;
                ph._bk = slot.dur > 0 ? slot.set.map(i => _book(c.pool[i], slot.start, slot.start + slot.dur)) : [];
            });
            const last = plan[plan.length - 1];
            rot.end = last.start + last.dur + legs(idx[idx.length - 1] + 1, P.length);
            return true;
        }
        const autos = [];
        lanes.forEach(L => L.rotations.forEach(rot => { if (!rot.fixed) autos.push(rot); }));
        for (let n = 0; n < 50; n++) {
            autos.sort((a, b) => b.end - a.end);
            if (!autos.map(replan).some(Boolean)) break;
        }

        // 6. Forward-walk each rotation to stamp actual start times on the
        //    NON-charge (fly) phases — each begins where the previous ended. A
        //    charge keeps its slot; the gap in front of it is the wait that is left
        //    (phase.wait), while phase.queue keeps the whole delay its queue caused.
        lanes.forEach(L => L.rotations.forEach(rot => {
            let t = rot.takeoff;
            rot.phases.forEach(ph => {
                if (ph.kind === 'charge' && ph.dur > 0) {
                    const w = ph.start - t;
                    ph.wait = w > 1e-6 ? w : 0;
                    t = ph.start + ph.dur;        // charge body already placed at actual start
                } else {
                    ph.start = t; t += ph.dur;
                }
                delete ph._bk; delete ph._ctx;
            });
            rot.end = t;
        }));

        return { lanes, pools };
    }

    // ---------- smart charging (dynamic load balancing under a grid limit) ----------
    // An airport with a grid limit (cfg gridLimitKw, GRID side) never draws more than it. The planned day
    // (the DES above: take-offs, charge order) is FLOWN forward in time under the limits: aircraft queue
    // first come, first served for a free charger; at a limited airport the charges in progress share the
    // limit equally, and one that needs less (its battery tapering) leaves the rest to the others
    // (water-filling), in SMART_DT steps. A slowed charge holds its charger longer and delays everything
    // after it on that aircraft (its next take-off, its arrivals elsewhere). Causal, so the draw never
    // exceeds a limit and every charge still delivers exactly its energy. Off, or no limit = the plan.
    const SMART_DT = 0.25;   // minutes per allocation step (15 s)
    function gridLimits() {
        const st = _rs() && CNSSettings.loadAll ? CNSSettings.loadAll().smartCharging : null;
        if (!st || !st.enabled) return {};
        const gm = (_rs() && CNSSettings.gridDemandFactor) ? CNSSettings.gridDemandFactor() : 1, out = {}, cfg = loadCfg();
        // a limit at or above what the installed chargers can draw never binds: that airport flies the plan
        Object.keys(cfg).forEach(id => { const g = +((cfg[id] || {}).gridLimitKw); if (!(g > 0)) return;
            const inst = (getContext(id).fleetPowers || []).reduce((s, p) => s + (+p || 0), 0);
            if (g / gm < inst - 1e-9) out[id] = { gridKw: g, kw: g / gm }; });
        return out;   // kw: the aircraft-side limit (the grid also feeds the charger losses)
    }
    function _dispatch(plan, limits) {
        // the flown day: the plan's lanes with fresh rotations (planned take-offs kept as the earliest departure)
        const lanes = plan.lanes.map(L => ({ ...L, rotations: L.rotations.map(r => ({
            planned: r.takeoff, takeoff: r.takeoff, end: r.end, fixed: r.fixed, tpl: r.tpl, plannedStarts: r.phases.map(p => p.start), plannedBays: r.phases.map(p => p.bays || null),
            phases: r.tpl.ph.map(p => ({ kind: p.kind, ident: p.ident || null, atRole: p.at, start: 0, dur: p.dur, power: p.power || 0, energy: p.energy || 0,
                atIdx: p.atIdx, label: p.label, wait: 0, queue: 0, slow: 0 })),
        })) }));
        const pools = {};
        Object.keys(plan.pools).forEach(id => { pools[id] = plan.pools[id].map(b => ({ power: b.power, busy: false })); });
        const queue = {}, active = {};   // per airport: waiting charges (arrival order), sharing sessions (limited airports)
        const ev = [];                    // { t, seq, fn } by time, then insertion
        let seq = 0;
        const push = (t, fn) => { let lo = 0, hi = ev.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].t < t || (ev[m].t === t && ev[m].seq < seq)) lo = m + 1; else hi = m; } ev.splice(lo, 0, { t, seq: seq++, fn }); };
        // what the battery accepts over the coming step, read at its middle (the taper falls as it fills)
        const accAt = (x, e) => (_rs() && CNSSettings.acceptKw) ? CNSSettings.acceptKw(x.soc0 + e / Math.max(1e-9, x.B), x.P, x.B) : x.P;
        const acc = (x) => accAt(x, x.e + accAt(x, x.e) * SMART_DT / 120);

        function startPhase(li, k, pi, t) {
            const L = lanes[li], rot = L.rotations[k];
            if (pi >= rot.phases.length) {
                rot.end = t;
                if (k + 1 < L.rotations.length) { const nx = L.rotations[k + 1]; push(Math.max(nx.planned, t), tt => { nx.takeoff = tt; startPhase(li, k + 1, 0, tt); }); }
                return;
            }
            const ph = rot.phases[pi], tp = rot.tpl.ph[pi];
            if (ph.kind !== 'charge' || !(tp.dur > 0)) { ph.start = t; ph.dur = tp.dur || 0; push(t + ph.dur, tt => startPhase(li, k, pi + 1, tt)); return; }
            // never before its planned start: the plan's own waits and charge order hold, so a limit that never
            // binds flies the plan exactly; only a slowed charge moves anything
            const notBefore = rot.plannedStarts[pi] != null ? rot.plannedStarts[pi] : t;
            (queue[ph.ident] = queue[ph.ident] || []).push({ li, k, pi, arrival: t, notBefore });
            if (notBefore > t + 1e-9) push(notBefore, tt => tryStart(ph.ident, tt)); else tryStart(ph.ident, t);
        }
        // Start every waiting charge that has its chargers free (in arrival order; a pinned one only on its pinned power).
        function tryStart(id, t) {
            const pool = pools[id] || (pools[id] = [{ power: 0, busy: false }]), q = queue[id] || [];
            for (let n = 0; n < q.length; n++) {
                const w = q[n], L = lanes[w.li], rot = L.rotations[w.k], tp = rot.tpl.ph[w.pi], ph = rot.phases[w.pi];
                if (t < w.notBefore - 1e-9) { push(w.notBefore, tt => tryStart(id, tt)); continue; }   // (re)armed: a charger may free up before then
                let bays = pool.map((_, i) => i);
                const pinned = tp.forcedPower ? bays.filter(i => pool[i].power === tp.forcedPower) : [];
                if (pinned.length) bays = pinned;
                const want = Math.max(1, Math.min(L.nCh || 1, bays.length)), free = bays.filter(i => !pool[i].busy).sort((a, b) => pool[b].power - pool[a].power);
                // the charger(s) the plan gave it, else free ones of the same power (never a faster one it wasn't planned on)
                const pb = rot.plannedBays[w.pi], set = [];
                if (pb && pb.length) { const left = free.slice(); pb.forEach(i => { const j = left.includes(i) ? i : left.find(f => pool[f].power === pool[i].power); if (j != null) { set.push(j); left.splice(left.indexOf(j), 1); } }); if (set.length < pb.length) continue; }
                else { if (free.length < want) continue; set.push(...free.slice(0, want)); }
                set.forEach(i => { pool[i].busy = true; });
                q.splice(n, 1); n--;
                const P = _effPower(set.reduce((s, i) => s + _effPower(pool[i].power, L.cap), 0), L.cap, L.maxKw);
                ph.start = t; ph.wait = ph.queue = t - w.arrival; ph.power = P;
                const ref = _chargeMin(tp.energy, P, L.cap, tp.arrivalFrac);   // the charge alone, at full power
                const done = tt => { ph.dur = tt - ph.start; set.forEach(i => { pool[i].busy = false; }); startPhase(w.li, w.k, w.pi + 1, tt); tryStart(id, tt); };
                if (!limits[id] || !(tp.energy > 0) || !(P > 0)) { push(t + ref, tt => { ph.dur = ref; done(tt); }); continue; }
                (active[id] = active[id] || []).push({ ph, E: tp.energy, P, B: L.cap, ref, e: 0, series: [],
                    soc0: tp.arrivalFrac != null ? tp.arrivalFrac : Math.max(0, 1 - tp.energy / Math.max(1e-9, L.cap)), done });
            }
        }
        // Share each limited airport's power over [t, t + dt): equal shares, the smallest wants filled first.
        function share(t, dt) {
            Object.keys(active).forEach(id => {
                const on = active[id]; if (!on.length) return;
                const wants = on.filter(x => x.ph.start < t + dt).map(x => ({ x, w: acc(x) })).sort((a, b) => a.w - b.w);
                let left = limits[id].kw, n = wants.length;
                wants.forEach(q => { q.g = Math.min(q.w, left / n); left -= q.g; n--; });
                wants.forEach(({ x, g }) => {
                    const t0 = Math.max(t, x.ph.start), h = (t + dt - t0) / 60;
                    if (!x.series.length || Math.abs(x.series[x.series.length - 1].kw - g) > 1e-6) x.series.push({ t: t0, kw: g });
                    if (!(g > 0) || h <= 0) return;
                    if (x.e + g * h >= x.E - 1e-9) {
                        const tt = t0 + (x.E - x.e) / g * 60; x.e = x.E;
                        on.splice(on.indexOf(x), 1); x.ph.series = x.series; const sl = (tt - x.ph.start) - x.ref; x.ph.slow = sl > 0.5 ? sl : 0;   // below half a minute it is the step, not the limit
                        push(tt, x.done);
                    } else x.e += g * h;
                });
            });
        }
        // planned first take-offs
        lanes.forEach((L, li) => { if (L.rotations.length) { const r0 = L.rotations[0]; push(r0.planned, tt => { r0.takeoff = tt; startPhase(li, 0, 0, tt); }); } });
        const anyActive = () => Object.keys(active).some(id => active[id].length);
        const HORIZON = DAY_END + 2 * 24 * 60;
        let t = ev.length ? Math.floor(ev[0].t / SMART_DT) * SMART_DT : 0;
        while ((ev.length || anyActive()) && t < HORIZON) {
            if (!anyActive() && ev.length && ev[0].t >= t + SMART_DT) t = Math.floor(ev[0].t / SMART_DT) * SMART_DT;   // nothing sharing: jump to the next event
            // share the step first (its completions join the events), then take every event of the step in time
            // order: a charger freed at 9:04.3 is free for the aircraft that arrives at 9:04.4
            const tEnd = t + SMART_DT;
            share(t, SMART_DT);
            while (ev.length && ev[0].t < tEnd) { const e = ev.shift(); e.fn(e.t); }
            t = tEnd;
        }
        return { lanes, pools: plan.pools };
    }

    function runGlobal() {
        const stamp = _globalKey();
        if (stamp === _globalStamp && _globalCache) return _globalCache;
        _globalStamp = stamp;
        const free = _simulate(), limits = gridLimits();
        const g = Object.keys(limits).length ? _dispatch(free, limits) : free;
        _globalCache = { lanes: g.lanes, pools: g.pools, free, smart: { limits } };
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
                            start: relStart, dur: ph.dur, power: ph.power, energy: ph.energy, slow: ph.slow || 0,
                            atIdx: ph.atIdx, label: ph.label,
                        });
                    });
                    return { takeoff: rot.takeoff, end: rot.end, fixed: rot.fixed, phases: rel };
                }),
            });
        });
        return out;
    }

    // Charging power over the day at `ident` (the whole network without one), aircraft side, with
    // the CC-CV taper: a step series [{ t, kw }] (kw holds until the next point) exact at every
    // charge start and end and following each taper minute by minute. The sum only rises when a
    // charge starts, so its maximum IS the coincident peak: every printed peak comes from here.
    // ponytail: O(points × charges), fine for a day of a few hundred charges; sweep if that grows.
    // Where smart charging shared a grid limit, a charge draws what it was given (ph.series); `opts.free`
    // reads the same day without smart charging (the demand it shaved).
    function loadCurve(ident, opts) {
        const ch = [], g = runGlobal();
        ((opts && opts.free) ? g.free : g).lanes.forEach(L => L.rotations.forEach(rot => rot.phases.forEach((ph, i) => {
            if (ph.kind !== 'charge' || !(ph.dur > 0) || !ph.power || (ident && ph.ident !== ident)) return;
            const soc = (rot.tpl.ph[i] || {}).arrivalFrac, sr = ph.series;
            ch.push(sr ? { s: ph.start, e: ph.start + ph.dur, steps: sr.map(p => p.t), kw: t => { let v = 0; for (const p of sr) { if (p.t <= t + 1e-9) v = p.kw; else break; } return v; } }
                       : { s: ph.start, e: ph.start + ph.dur, kw: t => _powerAt(t - ph.start, ph.energy, ph.power, L.cap, soc) });
        })));
        const ts = new Set();
        ch.forEach(c => { ts.add(c.s); ts.add(c.e); for (let m = Math.ceil(c.s); m < c.e; m++) ts.add(m); (c.steps || []).forEach(t => { if (t >= c.s && t < c.e) ts.add(t); }); });
        const pts = [];
        [...ts].sort((a, b) => a - b).forEach(t => {
            const kw = ch.reduce((sum, c) => sum + (t >= c.s && t < c.e ? c.kw(t) : 0), 0);
            if (!pts.length || Math.abs(pts[pts.length - 1].kw - kw) > 1e-6) pts.push({ t, kw });
        });
        return { pts, peakKw: pts.reduce((m, p) => Math.max(m, p.kw), 0) };
    }

    /** Smart charging at `ident` (or the network): the grid limit (grid side, null = none), the peak without
     *  smart charging, and the charge minutes the limit added. */
    function smartAt(ident) {
        const g = runGlobal(), lim = ident ? g.smart.limits[ident] : null;
        let added = 0, slowed = 0;
        g.lanes.forEach(L => L.rotations.forEach(rot => rot.phases.forEach(ph => { if (ph.kind === 'charge' && ph.slow > 0 && (!ident || ph.ident === ident)) { added += ph.slow; slowed++; } })));
        return { enabled: !!(_rs() && CNSSettings.loadAll && CNSSettings.loadAll().smartCharging.enabled), limitKw: lim ? lim.gridKw : null, limited: Object.keys(g.smart.limits),
            freePeakKw: loadCurve(ident, { free: true }).peakKw, addedMin: added, slowed };
    }

    function summary(ident) {
        const g = runGlobal();
        let latest = DAY_START;
        let chargeMin = 0;   // Σ charge-phase minutes here — the SAME bars the Gantt draws
        g.lanes.forEach(L => {
            const role = roleAt(L.trip, ident);
            if (!role) return;
            L.rotations.forEach(rot => {
                rot.phases.forEach(ph => {
                    if (ph.kind === 'charge' && ph.ident === ident && ph.dur > 0 && ph.power) chargeMin += ph.dur;
                });
                // A one-way ORIGIN only sees the take-off here (the plane departs and
                // lands elsewhere), so its on-airport activity ends at departure — not
                // the flight's end. dest/home/stop terminate or charge here → rot.end.
                const endHere = role === 'origin' ? rot.takeoff : rot.end;
                if (endHere > latest) latest = endHere;
            });
        });
        return { peakKw: loadCurve(ident).peakKw, latestEnd: latest, overflow: latest > DAY_END, chargeMin };
    }

    // ---------- rendering ----------
    function renderInto(container, ident) {
        if (!container) return;
        const rows = rotationsAt(ident);             // actual-timed, from the global sim
        container.innerHTML = '';
        if (!rows.length) { container.innerHTML = '<p class="text-muted small mb-0">No flights touch this airport yet.</p>'; return; }

        const sched = loadSched();
        const ids = new Set(loadTrips().map(t => t.id));
        let pruned = false;
        Object.keys(sched).forEach(k => { if (k !== '_v' && !ids.has(k)) { delete sched[k]; pruned = true; } });
        if (pruned) saveSched(sched);

        const legend = document.createElement('div');
        legend.className = 'est-note mb-2';
        legend.innerHTML =
            'Each bar is one <strong>rotation</strong> (a single aircraft: depart → charge → return → recharge). Same aircraft can\'t overlap itself; a charger serves one plane at a time. Take-offs are placed automatically so an aircraft leaves later rather than queue for a charger. Drag a rotation to fix its take-off (dark edge); double-click to release it.<br>' +
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
            const roleLabel = (role === 'home' || role === 'origin') ? 'departure' : role === 'stop' ? 'stop' : 'destination';
            const lane = document.createElement('div');
            lane.style.cssText = `position:absolute;left:0;right:0;top:${li * LANE_H}px;height:${LANE_H}px;border-top:${li ? '1px solid #f4f4f4' : 'none'}`;

            const label = document.createElement('div');
            label.title = `${trip.originName} → ${trip.destName} (${trip.planeName})`;
            label.style.cssText = `position:absolute;left:0;width:${LABEL_W}px;height:100%;padding:4px 8px;box-sizing:border-box;overflow:hidden;font-size:.74rem;line-height:1.15`;
            const subRight = row.planeIdx
                ? `aircraft ${row.planeIdx} of ${row.planeTotal}`
                : `${row.rotations.length}/day`;
            label.innerHTML = `<div style="font-weight:600">${esc(shorten(trip.originName))} → ${esc(shorten(trip.destName))}</div>` +
                `<div class="text-muted" style="font-size:.68rem">${esc(trip.planeName)} · ${roleLabel}${trip.multiLeg ? ' · multi-leg' : ''} · ${subRight}</div>`;
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
                track.appendChild(buildInstance(trip, schedSlot, rot.takeoff, rot.phases, rot.fixed));
            });
            lane.appendChild(track);
            chart.appendChild(lane);
        });

        inner.appendChild(chart);
        scroll.appendChild(inner);
        container.appendChild(scroll);
    }

    function buildInstance(trip, idx, start, ph, fixed) {
        const total = ph.reduce((m, p) => Math.max(m, p.start + p.dur), 0) || 30;
        const inst = document.createElement('div');
        // A fixed take-off carries a dark leading edge (a shadow, so the bars don't shift).
        inst.style.cssText = `position:absolute;top:9px;height:28px;width:${total * PX}px;cursor:grab;touch-action:none${fixed ? ';box-shadow:-3px 0 0 #212529' : ''}`;
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
            const lines = [`${trip.originName} → ${trip.destName} — rotation`, `Take-off ${fmtTime(s)} (${fixed ? 'fixed; double-click to release' : 'automatic'})`];
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

            // Free move; on release the dragged take-off is FIXED there and the lane
            // re-cascades so rotations slide along and never overlap (a single
            // aircraft can't be in two states at once). A click (no real move) writes
            // nothing, so a double-click can release a fixed take-off.
            const startX = e.clientX, origStart = inst._start;
            let moved = false;
            const move = (ev) => {
                if (!moved && Math.abs(ev.clientX - startX) < 3) return;
                moved = true;
                let s = origStart + (ev.clientX - startX) / PX;
                s = Math.max(DAY_START, Math.min(DAY_END, Math.round(s / SNAP) * SNAP));
                inst._start = s; place(s);
            };
            const up = () => {
                inst.style.cursor = 'grab'; inst.style.opacity = '1'; inst.style.zIndex = '';
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                if (!moved) return;
                setTakeoff(trip.id, idx, inst._start);
                if (onChange) onChange();   // re-cascade lane + recompute charger waits / peak
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        });
        // Double-click toggles: a fixed take-off goes back to automatic, an automatic one is fixed where it is.
        inst.addEventListener('dblclick', () => { setTakeoff(trip.id, idx, fixed ? null : start); if (onChange) onChange(); });
        return inst;
    }

    /** Read-only what-if: run `fn` (which calls runGlobal / summary) as if airport `ident` had the
        charger fleet `chargerIds`. Nothing is saved: the real caches come back afterwards, and the
        schedule is restored should a default lay-out get written meanwhile. Only the fleet differs,
        so the cached trip profiles (which depend on the per-airport SoC target) stay valid. */
    function whatIfChargers(ident, chargerIds, fn) {
        const real = CNSState.getJSON(CFG_KEY, {}), sched0 = localStorage.getItem(SCHED_KEY);
        const keep = [_stamp, _ctx, _globalStamp, _globalCache];
        _cfgOverride = Object.assign({}, real, { [ident]: Object.assign({}, real[ident] || {}, { chargers: chargerIds.slice() }) });
        _stamp = null; _ctx = {}; _globalStamp = null; _globalCache = null;
        try { return fn(); }
        finally {
            _cfgOverride = null; [_stamp, _ctx, _globalStamp, _globalCache] = keep;
            if (localStorage.getItem(SCHED_KEY) !== sched0) { if (sched0 == null) localStorage.removeItem(SCHED_KEY); else localStorage.setItem(SCHED_KEY, sched0); }
        }
    }

    function init(opts) {
        opts = opts || {};
        catalog = opts.chargers || {};
        onChange = opts.onChange || null;
        _stamp = null; _ctx = {}; _globalStamp = null; _globalCache = null;
    }

    return { init, renderInto, summary, smartAt, gridLimits, loadCurve, tripsAt, phasesAnim, instanceStarts, setTakeoff, releaseAll, fixedCount, roleAt, runGlobal, rotationsAt, tripPhases, whatIfChargers, DAY_START, DAY_END, SPAN };
})();
