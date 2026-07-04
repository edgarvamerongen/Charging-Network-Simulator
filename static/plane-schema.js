/*
 * CNSPlaneSchema — provenance normalizer for catalog aircraft (planes.json).
 * --------------------------------------------------------------------------
 * Roadmap step 1 of docs/performance-engine.md. The JS twin of plane_schema.py:
 * a field may be a bare scalar OR a provenance object { value, basis?, source?,
 * confidence? }. These helpers let every consumer (spec sheet, future modules)
 * read `.value` uniformly without caring which form the catalog used.
 *
 *   CNSPlaneSchema.value(plane, key, default?)   -> scalar (unwrapped) | default
 *   CNSPlaneSchema.provenance(plane, key)        -> { value, basis, source, confidence } | null
 *   CNSPlaneSchema.ifrCapable(plane)             -> bool (explicit, else inferred from class)
 *   CNSPlaneSchema.normalize(plane)              -> shallow copy with every field unwrapped to its scalar
 *
 * Pure: no DOM / storage / fetch (loadable in a node vm harness like settings.js).
 * NOT yet wired into index.html — there is no consumer in step 1, so loading it
 * changes nothing. The IFR/VFR module + spec sheet add the <script> tag.
 */
window.CNSPlaneSchema = (function () {
    'use strict';

    function _isProvenance(v) {
        return v && typeof v === 'object' && !Array.isArray(v) && 'value' in v;
    }

    function value(plane, key, dflt) {
        if (!plane || !(key in plane)) return dflt;
        const v = plane[key];
        return _isProvenance(v) ? v.value : v;
    }

    function provenance(plane, key) {
        if (!plane || !(key in plane)) return null;
        const v = plane[key];
        if (_isProvenance(v)) {
            return { value: v.value, basis: v.basis ?? null, source: v.source ?? null,
                     confidence: v.confidence || 'assumed' };
        }
        return { value: v, basis: null, source: null, confidence: 'assumed' };
    }

    function inferIfrCapable(plane) {
        const cls = value(plane, 'class');
        if (cls === 'trainer') return false;
        if (cls === 'commuter' || cls === 'regional' || cls === 'evtol') return true;
        const seats = value(plane, 'seats') || 0;
        const rng = value(plane, 'range_km') || 0;
        return !(seats <= 2 && rng < 200);   // tiny short-range -> assume VFR-only
    }

    function ifrCapable(plane) {
        return (plane && 'ifr_capable' in plane) ? !!value(plane, 'ifr_capable')
                                                  : inferIfrCapable(plane);
    }

    function normalize(plane) {
        const out = {};
        if (plane) for (const k in plane) out[k] = value(plane, k);
        return out;
    }

    // ---- measurements: multiple data points per quantity + selector ----
    const _CONF_RANK = { 'certified': 3, 'manufacturer-stated': 2, 'estimated': 1, 'assumed': 0 };
    const _norm = (x) => (typeof x === 'string' ? x.toLowerCase() : x);

    function measurements(plane, quantity) {
        const out = (plane && Array.isArray(plane.measurements))
            ? plane.measurements.filter(m => m && typeof m === 'object') : [];
        return quantity == null ? out : out.filter(m => m.quantity === quantity);
    }

    function selectMeasurement(plane, quantity, context) {
        const ctx = {};
        for (const k in (context || {})) ctx[k] = _norm(context[k]);
        let best = null, bestKey = null;
        for (const m of measurements(plane, quantity)) {
            const cond = {};
            for (const k in (m.conditions || {})) cond[k] = _norm(m.conditions[k]);
            let conflict = false, matched = 0;
            for (const k in cond) {
                if (k in ctx) { if (ctx[k] !== cond[k]) { conflict = true; break; } matched++; }
            }
            if (conflict) continue;
            if (Object.keys(cond).length > 0 && matched === 0) continue;  // context matched none of its conditions
            const key = [matched, _CONF_RANK[m.confidence || 'assumed'] || 0];
            if (best === null || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
                best = m; bestKey = key;
            }
        }
        return best;
    }

    function select(plane, quantity, context, dflt) {
        const m = selectMeasurement(plane, quantity, context);
        if (m) return m.value;
        const v = value(plane, quantity);
        return v == null ? dflt : v;
    }

    // usable range: gross --x(1 - min_soc)--> usable battery --minus reserve--> planning range
    const RESERVE_MIN = { vfr: 30, vfr_day: 30, vfr_night: 45, ifr: 45 };
    const DEFAULT_MIN_SOC = 0.30;

    function _minSoc(plane, override) {
        if (override != null) return override;
        const v = value(plane, 'min_landing_soc');
        return (typeof v === 'number') ? v : DEFAULT_MIN_SOC;
    }

    function usableRange(plane, regime, context, opts) {
        regime = regime || 'vfr'; opts = opts || {};
        const m = selectMeasurement(plane, 'range_km', Object.assign({}, context, { regime }));
        if (m && m.basis === 'usable_incl_reserve') return m.value;   // published with-reserves figure
        // VFR add-back (§13.3): a non-IFR regime on a plane whose only usable figure
        // is an ifr-conditioned incl-reserve measurement extrapolates the IFR
        // diversion + loiter delta back in, rather than falling through to the
        // gross build-down (which can undercut the IFR figure it is meant to exceed).
        // The loiter credit clamps to zero when the regime's reserve already exceeds
        // the baked-in loiter (e.g. vfr_night).
        if (regime !== 'ifr') {
            const mi = selectMeasurement(plane, 'range_km', Object.assign({}, context, { regime: 'ifr' }));
            const ri = value(plane, 'reserve_included');
            if (mi && mi.basis === 'usable_incl_reserve' && ri && ri.regime === 'ifr') {
                const spd0 = value(plane, 'speed_kmh') || 0;
                const vfrMin = RESERVE_MIN[regime] != null ? RESERVE_MIN[regime] : 30;
                const addback = mi.value + (ri.diversion_km || 0)
                    + Math.max(0, ((ri.loiter_min || 0) - vfrMin) / 60) * spd0;
                return Math.max(mi.value, addback);
            }
        }
        const gross = (m && m.basis === 'gross') ? m.value : value(plane, 'range_km');
        const spd = value(plane, 'speed_kmh');
        if (!gross || !spd) return value(plane, 'range_km');
        const base = gross * (1 - _minSoc(plane, opts.minSoc));
        const reserveKm = (spd / 60) * (RESERVE_MIN[regime] != null ? RESERVE_MIN[regime] : 30);
        let usable = base - reserveKm;
        if (regime === 'ifr') usable = (usable - (opts.alternateKm || 0)) / (opts.routingFactor || 1);
        return Math.max(0, usable);
    }

    return { value, provenance, inferIfrCapable, ifrCapable, normalize,
             measurements, selectMeasurement, select, usableRange };
})();
