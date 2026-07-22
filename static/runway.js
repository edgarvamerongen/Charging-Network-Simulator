/*
 * CNSRunway — airport-card runway display + per-aircraft fit check.
 * ---------------------------------------------------------------------------
 * Pure + DOM-free (node-testable like range-graph.js). Two readers, no state:
 *
 *   summary(ap)            -> terse chip string for the airport card, e.g.
 *                             "paved 2,013 m · grass 800 m" ('' when no data).
 *                             Reads the rwy_<cat>_m fields the airports API
 *                             serves (longest OPEN runway per surface category,
 *                             baked from runways.csv by airport_alternates.py).
 *   suitability(plane, ap) -> { state, label } for the CURRENTLY SELECTED
 *                             aircraft vs this airport:
 *                               'unknown' — no requirement / no airport data -> render nothing
 *                               'ok'      — some category satisfies the requirement -> render nothing
 *                                           (terse convention: only warnings show)
 *                               'short'   — right surface exists but too short
 *                               'surface' — required surface not present at all
 *                             plane.runway_req comes from the Notion sync:
 *                             { category: minMeters|null } with the grass->paved
 *                             hierarchy already applied; null min = surface
 *                             required, length unspecified.
 *
 * Display only — routing / alternates / range graph are NOT gated here (that is
 * the perf-engine S5 step, which will consume the same fields).
 */
window.CNSRunway = (function () {
    'use strict';

    var CATS = ['paved', 'grass', 'gravel', 'dirt', 'water', 'unknown'];

    function _len(ap, cat) {
        var v = ap ? +ap['rwy_' + cat + '_m'] : 0;   // '' (blank CSV cell) -> 0
        return (isFinite(v) && v > 0) ? v : 0;
    }

    function _fmtM(m) {
        return Math.round(m).toLocaleString('en-US') + ' m';
    }

    function summary(ap) {
        var chips = [];
        for (var i = 0; i < CATS.length; i++) {
            var v = _len(ap, CATS[i]);
            if (v > 0) chips.push((CATS[i] === 'unknown' ? 'rwy' : CATS[i]) + ' ' + _fmtM(v));
        }
        return chips.join(' · ');
    }

    function suitability(plane, ap) {
        var req = plane && plane.runway_req;
        if (!req || typeof req !== 'object') return { state: 'unknown', label: '' };
        var hasData = false;
        for (var i = 0; i < CATS.length; i++) if (_len(ap, CATS[i]) > 0) { hasData = true; break; }
        if (!hasData) return { state: 'unknown', label: '' };

        var shortest = null;      // smallest non-null requirement on a surface the airport HAS
        var firstMissing = null;  // first required category (display order) absent at the airport
        for (var j = 0; j < CATS.length; j++) {
            var cat = CATS[j];
            if (!(cat in req)) continue;
            var have = _len(ap, cat);
            var need = req[cat];
            if (have > 0) {
                if (need == null || have >= need) return { state: 'ok', label: '' };
                if (shortest == null || need < shortest) shortest = need;
            } else if (firstMissing == null) {
                firstMissing = cat;
            }
        }
        if (shortest != null) return { state: 'short', label: 'rwy short — need ' + _fmtM(shortest) };
        return { state: 'surface', label: 'no ' + (firstMissing || 'suitable') + ' rwy' };
    }

    return { summary: summary, suitability: suitability, CATS: CATS };
})();
