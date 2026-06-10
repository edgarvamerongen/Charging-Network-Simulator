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
 *                              22 kWh Pipistrel). The global `cRate` default is
 *                              deliberately high (5C) so it does NOT bind for the
 *                              current fleet — the cap is kept as a hook, not an
 *                              active constraint. The catalog no longer ships a
 *                              per-aircraft `c_rate`; if one is re-added it would
 *                              override the global default (see BACKLOG `max_kw`).
 *                          (b) CV-phase taper — above `threshold` SoC power
 *                              rolls off exponentially toward `taperPower × peak`, stretching the
 *                              top-up to near-full.
 *                        Together they form the plateau-then-taper curve.
 *   routingPadding     — multiplier on great-circle distance for airways routing /
 *                        ATC route extension (SID/STAR is the separate sidStarPadding).
 *   sidStarPadding     — fixed km added to EACH leg for SID/STAR terminal track
 *                        miles. Additive, on top of routingPadding; opt-in (off
 *                        by default so it doesn't double-count with the above).
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
    // v3: the realistic model is the default (reserve + padding + taper +
    // charge target all ON), and the C-rate acceptance cap is now a non-binding
    // 5C hook (per-aircraft `c_rate` retired from the catalog). Bumping the key
    // retires browsers' old blobs — including any persisted 2.0C cap — so
    // everyone picks up the new defaults on next load.
    // v4: landing-reserve default drops 30% → 20%; the catalog ranges in planes.json
    // are recalibrated against it (range_km = familiar available range ÷ 0.8).
    // v5: alternate reserve + SID/STAR padding default ON (realistic ops out of the box).
    const KEY = 'cns_settings_v5';
    const DEFAULTS = Object.freeze({
        landingReserve:    { enabled: true,  minLandingSoc: 0.20 },   // 0..1 — planes.json ranges are calibrated to this default
        alternateReserve:  { enabled: true },                        // divert-to-nearest-airport reserve; uses each airport's pre-baked alternate_km
        chargerEfficiency: { enabled: false, value: 0.88 },           // 0..1
        chargeTaper:       { enabled: true,  threshold: 0.75, taperPower: 0.30, cRate: 5.0 },  // threshold = CC→CV knee; taperPower = power at 100% as a fraction of peak (exp-taper floor); cRate = global C-rate cap, set high (5C) so it stays non-binding for the current fleet — a hook for later, not an active constraint
        routingPadding:    { enabled: false, factor: 1.05 },          // ≥1; OFF by default — SID/STAR (additive km) is the preferred padding now
        sidStarPadding:    { enabled: true,  km: 10 },                // fixed km added to EACH leg (SID+STAR terminal track miles); additive on top of routingPadding
        chargeTarget:      { enabled: true,  value: 0.80 },           // 0..1 — default SoC every aircraft charges to (per-airport target overrides)
        chargeRate:        { value: 0.60 },                           // €/kWh — charging price for the result panel's potential-revenue figure (the Model-settings €/kWh field edits this same value)
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

    /** Multiplier on great-circle distance for airways routing / ATC route extension
     *  (SID/STAR terminal track miles are the separate sidStarPadding factor).
     *  Cascades into leg distance, energy, flight time, and routing reach. */
    function routingFactor() {
        const s = loadAll().routingPadding;
        if (!s.enabled) return 1.0;
        return Math.max(1.0, Math.min(1.5, +s.factor || 1.05));
    }

    /** Whether the planner must reserve charge at every stop/destination to
     *  divert to its nearest airport. Boolean toggle — the reserve magnitude is
     *  each airport's own `alternate_km` (read by the planner), so there is no
     *  slider here. Identity (false) by default so saved plans are unchanged. */
    function alternateReserveEnabled() {
        const s = loadAll().alternateReserve;
        return !!(s && s.enabled);
    }

    /** Fixed km added to EACH leg to approximate SID/STAR terminal track miles.
     *  0 when off (identity); clamped to the slider's [5,50] when on. Additive,
     *  applied AFTER the routingPadding multiplier:
     *  distKm = rawKm·routingFactor + sidStarPaddingKm. Mirrors routingFactor()'s
     *  "identity when off, clamp to UI range when on" shape. */
    function sidStarPaddingKm() {
        const s = loadAll().sidStarPadding;
        if (!s || !s.enabled) return 0;
        return Math.max(5, Math.min(50, +s.km || 10));
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

    /** Charging price in €/kWh for the result panel's potential-revenue figure.
     *  A pricing parameter, not a physics flag, so it never feeds the model-flag
     *  badge or `activeFlags`. The €/kWh field in Model settings (C1a) edits this
     *  same value; until then it returns the 0.60 default. */
    function chargeRate() {
        const s = loadAll().chargeRate;
        const v = +(s && s.value);
        return isFinite(v) && v >= 0 ? v : 0.60;
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
            : Math.max(0.1, Math.min(10, +s.cRate || 5.0));
        return Math.min(p, cr * batt);
    }

    /** Minutes to deliver `energyKwh` from a charger rated `powerKw`, against a battery
     *  of size `batteryKwh`, starting at `startSocFrac` (0..1). Linear when the taper toggle
     *  is off. When on: full power up to `threshold` SoC, then an EXPONENTIAL roll-off to
     *  `taperPower × powerKw` at 100% (a realistic CV-phase taper); time is the closed-form
     *  integral of dE/P(SoC) over the charge's actual [start, end] band.
     *  [R7] Pass `startSocFrac` so a charge that ends BELOW the knee pays no taper. When it's
     *  omitted, fall back to the legacy "top slice" assumption (charge ends at 100%,
     *  start = 1 − e/batt) — pre-R7 callers stay byte-identical until they opt in. */
    function chargeTimeMin(energyKwh, powerKw, batteryKwh, startSocFrac) {
        const e = Math.max(0, +energyKwh || 0);
        const p = Math.max(1e-9, +powerKw || 0);
        if (e === 0) return 0;
        const s = loadAll().chargeTaper;
        if (!s.enabled || !batteryKwh) return 60 * e / p;
        const thr   = Math.max(0.5, Math.min(0.95, +s.threshold || 0.75));
        const floor = Math.max(0.05, Math.min(0.95, +s.taperPower || 0.30));
        const batt  = Math.max(1e-9, +batteryKwh);
        const b = -Math.log(floor);                 // decay constant (> 0)
        // Above `thr` SoC the accepted power decays EXPONENTIALLY to floor·peak at 100%:
        // P(SoC) = p · floor^((SoC−thr)/(1−thr)) — a CV-phase current taper. Place the charge
        // at its true SoC range when known (R7), else the legacy top-slice (ends at 100%).
        const start = (startSocFrac != null && isFinite(+startSocFrac))
            ? Math.max(0, Math.min(1, +startSocFrac))
            : Math.max(0, 1 - e / batt);
        const end = Math.min(1, start + e / batt);
        let hours = 0;
        const flatEnd = Math.min(end, thr);          // below the knee → full power
        if (flatEnd > start) hours += batt * (flatEnd - start) / p;
        if (end > thr) {                             // above the knee → exponential roll-off (closed form)
            const u0 = Math.max(0, (start - thr) / (1 - thr));
            const u1 = (end - thr) / (1 - thr);
            hours += batt * (1 - thr) / (p * b) * (Math.exp(u1 * b) - Math.exp(u0 * b));
        }
        return 60 * hours;
    }

    /** Convenience: state-of-the-world flags for UI badges / explanations. */
    function activeFlags() {
        const s = loadAll();
        return {
            landingReserve:    !!s.landingReserve.enabled,
            chargerEfficiency: !!s.chargerEfficiency.enabled,
            chargeTaper:       !!s.chargeTaper.enabled,
            routingPadding:    !!s.routingPadding.enabled,
            sidStarPadding:    !!(s.sidStarPadding && s.sidStarPadding.enabled),
            chargeTarget:      !!(s.chargeTarget && s.chargeTarget.enabled),
            alternateReserve:  !!(s.alternateReserve && s.alternateReserve.enabled),
            anyOn: !!(s.landingReserve.enabled || s.chargerEfficiency.enabled ||
                      s.chargeTaper.enabled || s.routingPadding.enabled ||
                      (s.sidStarPadding && s.sidStarPadding.enabled) ||
                      (s.chargeTarget && s.chargeTarget.enabled) ||
                      (s.alternateReserve && s.alternateReserve.enabled)),
        };
    }

    return {
        DEFAULTS, KEY,
        loadAll, save, reset, subscribe,
        usableFraction, gridDemandFactor, routingFactor, sidStarPaddingKm, chargeTimeMin,
        effectiveChargePower, chargeTargetDefault, chargeRate, activeFlags,
        alternateReserveEnabled,
    };
})();
