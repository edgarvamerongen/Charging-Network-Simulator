/*
 * CNSRecompute — re-plan saved Demand-Calculator flights under current model
 * settings and recompute feasibility. Pure (no DOM): the caller supplies the
 * airport catalog + per-plane available-range. Depends on CNSRouting, CNSFlight.
 */
window.CNSRecompute = (function () {
    // Copy the planner's _manual flag onto the saved stop objects (which come from
    // /api/simulate and have lost it), matched by ident. Auto stops stay unflagged.
    function mergeManualFlags(savedStops, plannedStops) {
        const manualIdents = new Set((plannedStops || []).filter(s => s && s._manual).map(s => s.ident));
        return (savedStops || []).map(s => (s && manualIdents.has(s.ident)) ? { ...s, _manual: true } : { ...s });
    }

    return { mergeManualFlags };
})();
