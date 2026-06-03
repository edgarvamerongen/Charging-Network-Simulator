/*
 * CNSSettings — operator-facing model factors for the energy / charging model.
 * ------------------------------------------------------------------------------
 * Each factor has a toggle. When OFF the accessor returns the identity value
 * (1.0 / linear), so call sites can use the accessor unconditionally without
 * sprinkling `if (settings.x)` everywhere. The default state is all-off so
 * existing saved plans keep behaving exactly the same until the user opts in.
 *
 * Factors (current set):
 *   landingReserve     — minimum SoC the aircraft must land with. Reduces
 *                        usable battery per leg.
 *   chargerEfficiency  — grid→cell efficiency. Inflates grid kWh demand vs
 *                        aircraft-side kWh; doesn't change charge time.
 *   chargeTaper        — models the real charging curve. Two coupled effects,
 *                        both active when this one factor is on:
 *                          (a) C-rate acceptance cap — effective power is
 *                              limited to min(charger kW, C-rate × battery kWh),
 *                              because a small pack can't physically absorb an
 *                              over-sized charger (e.g. a 3.75 MW MCS into a
 *                              22 kWh Pipistrel). Per-aircraft `c_rate` overrides
 *                              the global `cRate` default.
 *                          (b) CV-phase taper — above `threshold` SoC power
 *                              rolls off exponentially toward `taperPower × peak`, stretching the
 *                              top-up to near-full.
 *                        Together they form the plateau-then-taper curve.
 *   routingPadding     — multiplier on great-circle distance to approximate
 *                        SID/STAR + airways padding.
 *
 * Per-aircraft overrides:
 *   plane.min_landing_soc — if present in the catalog (planes.json), takes
 *                           precedence over the global slider when the
 *                           landingReserve toggle is on.
 *
 * Subscriptions: change events fan out to subscribers so the result panel,
 * demand drawer, scheduler and animation can re-render in lockstep.
 *
 * Depends on: CNSState (load earlier).
 */
window.CNSSettings = (function () {
    // v2: the realistic model is now the default (reserve + padding + taper +
    // charge target all ON). Bumping the key from v1 retires browsers' old
    // all-off blobs so everyone picks up the new defaults on next load.
    const KEY = 'cns_settings_v2';
    const DEFAULTS = Object.freeze({
        landingReserve:    { enabled: true,  minLandingSoc: 0.30 },   // 0..1
        chargerEfficiency: { enabled: false, value: 0.88 },           // 0..1
        chargeTaper:       { enabled: true,  threshold: 0.70, taperPower: 0.15, cRate: 2.0 },  // threshold = CC→CV knee; taperPower = power at 100% as a fraction of peak (exp-taper floor); cRate = global C-rate (per-plane c_rate overrides)
        routingPadding:    { enabled: true,  factor: 1.05 },          // ≥1
        chargeTarget:      { enabled: true,  value: 0.80 },           // 0..1 — default SoC every aircraft charges to (per-airport target overrides)
    });

    // Cloned so call sites can't mutate the frozen defaults via the returned object.
    const _clone = (o) => JSON.parse(JSON.stringify(o));

    function loadAll() {
        const stored = CNSState.getJSON(KEY, null);
        if (!stored || typeof stored !== 'object') return _clone(DEFAULTS);
        // Merge to fill in any new keys we've added since the user last saved.
        const out = _clone(DEFAULTS);
        Object.keys(out).forEach(k => {
            if (stored[k] && typeof stored[k] === 'object') Object.assign(out[k], stored[k]);
        });
        return out;
    }

    function save(patch) {
        const cur = loadAll();
        Object.keys(patch || {}).forEach(k => {
            if (cur[k]) Object.assign(cur[k], patch[k]);
        });
        CNSState.setJSON(KEY, cur);
        _fire(cur);
        return cur;
    }
    function reset() {
        CNSState.setJSON(KEY, _clone(DEFAULTS));
        _fire(loadAll());
    }

    // ---------- subscribers --------------------------------------------------
    const _subs = new Set();
    function subscribe(cb) { _subs.add(cb); return () => _subs.delete(cb); }
    function _fire(state) { _subs.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }

    // ---------- accessors (identity when toggle is off) ----------------------

    /** Fraction of nameplate battery available per leg. 1.0 when the reserve
     *  toggle is off. When on: (max takeoff SoC = 1.0) − (min landing SoC).
     *
     *  Precedence (per user decision): the GLOBAL slider value applies to all
     *  aircraft when the toggle is on, overriding per-aircraft min_landing_soc
     *  values in the catalog. Use this for fleet-wide what-if analysis. The
     *  catalog values stay in the JSON as documentation of published per-
     *  aircraft POH limits but no longer change the math.
     *  (Plane argument retained for forward-compat if we re-introduce a
     *  per-aircraft override path later.) */
    function usableFraction(_plane) {
        const s = loadAll().landingReserve;
        if (!s.enabled) return 1.0;
        return Math.max(0.05, Math.min(1.0, 1.0 - s.minLandingSoc));
    }

    /** Multiplier from aircraft-side kWh to grid kWh. 1.0 when efficiency
     *  is off; 1/eff when on (e.g. delivering 100 kWh through an 88%-efficient
     *  charger pulls 113.6 kWh from the grid). */
    function gridDemandFactor() {
        const s = loadAll().chargerEfficiency;
        if (!s.enabled) return 1.0;
        return 1.0 / Math.max(0.5, Math.min(1.0, +s.value || 0.88));
    }

    /** Multiplier on great-circle distance to approximate SID/STAR + airways.
     *  Cascades into leg distance, energy, flight time, and routing reach. */
    function routingFactor() {
        const s = loadAll().routingPadding;
        if (!s.enabled) return 1.0;
        return Math.max(1.0, Math.min(1.5, +s.factor || 1.05));
    }

    /** Default state-of-charge every aircraft charges to at a terminus, unless a
     *  per-airport target overrides it (LOCAL > GLOBAL). Returns a fraction in
     *  (0,1] when the factor is on, or null when off — null means pure deficit
     *  charging (top up only what the next leg needs), the original behaviour.
     *  Resolvers should use `perAirportTarget(id) ?? chargeTargetDefault()`. */
    function chargeTargetDefault() {
        const s = loadAll().chargeTarget;
        if (!s || !s.enabled) return null;
        return Math.max(0.1, Math.min(1.0, +s.value || 0.80));
    }

    /** Effective charge power (kW) a battery can actually accept: the smaller
     *  of the charger's rated power and the pack's C-rate limit
     *  (`cRate × batteryKwh`). This is the CC-plateau half of the charging-curve
     *  model, so it's gated on the SAME `chargeTaper` toggle. Identity (returns
     *  `powerKw`) when that toggle is off or battery size is unknown. A
     *  per-aircraft `planeCRate` (from the catalog's `c_rate`) takes precedence
     *  over the global slider — small GA packs (~1C) and high-power eVTOLs
     *  differ a lot, and C-rate is already normalised to pack size so it scales
     *  correctly to each aircraft. */
    function effectiveChargePower(powerKw, batteryKwh, planeCRate) {
        const p = Math.max(0, +powerKw || 0);
        const s = loadAll().chargeTaper;
        if (!s.enabled) return p;
        const batt = Math.max(0, +batteryKwh || 0);
        if (!batt) return p;
        const cr = (planeCRate != null && isFinite(+planeCRate) && +planeCRate > 0)
            ? +planeCRate
            : Math.max(0.1, Math.min(10, +s.cRate || 2.0));
        return Math.min(p, cr * batt);
    }

    /** Minutes to deliver `energyKwh` from a charger rated `powerKw`, against
     *  a battery of size `batteryKwh`. Linear when the taper toggle is off.
     *  When on: full power up to `threshold` SoC, then an EXPONENTIAL roll-off
     *  to `taperPower × powerKw` at 100% (a realistic CV-phase taper). We don't
     *  know absolute start-SoC at this layer, so we treat the charge as
     *  occupying the "top slice" of the battery — energy beyond the top-slice
     *  capacity `batt × (1 - thr)` sits below the threshold and charges at full
     *  power; the top slice itself rolls off along the exponential curve. */
    function chargeTimeMin(energyKwh, powerKw, batteryKwh) {
        const e = Math.max(0, +energyKwh || 0);
        const p = Math.max(1e-9, +powerKw || 0);
        if (e === 0) return 0;
        const s = loadAll().chargeTaper;
        if (!s.enabled || !batteryKwh) return 60 * e / p;
        const thr   = Math.max(0.5, Math.min(0.95, +s.threshold || 0.70));
        const floor = Math.max(0.05, Math.min(0.95, +s.taperPower || 0.15));
        const batt  = Math.max(1e-9, +batteryKwh);
        // Above `thr` SoC the accepted power decays EXPONENTIALLY from peak to
        // floor·peak at 100%:  P(SoC) = p · floor^((SoC-thr)/(1-thr)).  That
        // constant-fraction roll-off mirrors a real CV-phase current taper far
        // better than a straight line. Time over the tapered top slice is the
        // closed-form integral of dE / P(SoC); below `thr` it's just full power.
        const topSlice = batt * (1 - thr);          // capacity above the CC→CV knee
        const b = -Math.log(floor);                 // decay constant (> 0)
        if (e <= topSlice) {                         // whole charge sits in the taper band, ending at 100%
            const u0 = (1 - e / batt - thr) / (1 - thr);             // 0..1 up from the knee
            return 60 * topSlice / (p * b) * (Math.exp(b) - Math.exp(u0 * b));
        }
        const fastKwh = e - topSlice;                               // below the knee → full power
        const taperHr = topSlice / (p * b) * (Math.exp(b) - 1);     // tapered top slice (hours)
        return 60 * (fastKwh / p + taperHr);
    }

    /** Convenience: state-of-the-world flags for UI badges / explanations. */
    function activeFlags() {
        const s = loadAll();
        return {
            landingReserve:    !!s.landingReserve.enabled,
            chargerEfficiency: !!s.chargerEfficiency.enabled,
            chargeTaper:       !!s.chargeTaper.enabled,
            routingPadding:    !!s.routingPadding.enabled,
            chargeTarget:      !!(s.chargeTarget && s.chargeTarget.enabled),
            anyOn: !!(s.landingReserve.enabled || s.chargerEfficiency.enabled ||
                      s.chargeTaper.enabled || s.routingPadding.enabled ||
                      (s.chargeTarget && s.chargeTarget.enabled)),
        };
    }

    return {
        DEFAULTS, KEY,
        loadAll, save, reset, subscribe,
        usableFraction, gridDemandFactor, routingFactor, chargeTimeMin,
        effectiveChargePower, chargeTargetDefault, activeFlags,
    };
})();
