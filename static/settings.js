/*
 * CNSSettings — operator-facing realism factors for the energy / charging model.
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
 *   chargeTaper        — charging above ~80% SoC tapers (lithium-ion CV phase).
 *                        Stretches charge time when topping up to near-full.
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
    const KEY = 'cns_settings_v1';
    const DEFAULTS = Object.freeze({
        landingReserve:    { enabled: false, minLandingSoc: 0.30 },   // 0..1
        chargerEfficiency: { enabled: false, value: 0.88 },           // 0..1
        chargeTaper:       { enabled: false, threshold: 0.80, taperPower: 0.40 },
        routingPadding:    { enabled: false, factor: 1.05 },          // ≥1
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
     *  Plane catalog can override the global floor via `plane.min_landing_soc`. */
    function usableFraction(plane) {
        const s = loadAll().landingReserve;
        if (!s.enabled) return 1.0;
        const perAircraft = plane && plane.min_landing_soc;
        const floor = (perAircraft != null && isFinite(+perAircraft)) ? +perAircraft : s.minLandingSoc;
        return Math.max(0.05, Math.min(1.0, 1.0 - floor));   // clamp to a sane window
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

    /** Minutes to deliver `energyKwh` from a charger rated `powerKw`, against
     *  a battery of size `batteryKwh`. Linear when the taper toggle is off.
     *  When on: full power up to `threshold` SoC, then linearly down to
     *  `taperPower × powerKw` at 100%. We don't know absolute start-SoC at
     *  this layer, so we treat the charge as occupying the "top slice" of
     *  the battery — i.e. if energyKwh would push the SoC above the taper
     *  threshold, the over-threshold portion charges at the average tapered
     *  rate. Conservative and easy to reason about. */
    function chargeTimeMin(energyKwh, powerKw, batteryKwh) {
        const e = Math.max(0, +energyKwh || 0);
        const p = Math.max(1e-9, +powerKw || 0);
        if (e === 0) return 0;
        const s = loadAll().chargeTaper;
        if (!s.enabled || !batteryKwh) return 60 * e / p;
        const thr = Math.max(0.5, Math.min(0.99, +s.threshold || 0.80));
        const tp  = Math.max(0.1, Math.min(0.95, +s.taperPower || 0.40));
        const batt = Math.max(1e-9, +batteryKwh);
        const overThresholdKwh = Math.max(0, e - batt * (1 - thr));
        const fastKwh = e - overThresholdKwh;
        const avgTaperPower = p * (1 + tp) / 2;     // linear taper → average
        return 60 * (fastKwh / p + overThresholdKwh / avgTaperPower);
    }

    /** Convenience: state-of-the-world flags for UI badges / explanations. */
    function activeFlags() {
        const s = loadAll();
        return {
            landingReserve:    !!s.landingReserve.enabled,
            chargerEfficiency: !!s.chargerEfficiency.enabled,
            chargeTaper:       !!s.chargeTaper.enabled,
            routingPadding:    !!s.routingPadding.enabled,
            anyOn: !!(s.landingReserve.enabled || s.chargerEfficiency.enabled ||
                      s.chargeTaper.enabled || s.routingPadding.enabled),
        };
    }

    return {
        DEFAULTS, KEY,
        loadAll, save, reset, subscribe,
        usableFraction, gridDemandFactor, routingFactor, chargeTimeMin,
        activeFlags,
    };
})();
