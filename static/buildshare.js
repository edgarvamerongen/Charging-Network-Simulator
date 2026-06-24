/*
 * CNSBuildShare — share a whole saved NETWORK (multi-route "build") as one
 * short /s/<slug> link, the sibling of CNSShare (single route, static/share.js).
 *
 * A build blob is { v:1, k:'build', fl:[...flights...], cfg, sch, ms }, stored
 * verbatim by the existing /api/share slug store. Per flight we keep only the
 * INPUTS (plane, charger, trip type, frequency, origin/destination/stops). The
 * computed energies are deliberately dropped and recomputed on open via
 * /api/simulate, so a shared build never goes stale when the catalog or model
 * changes — the same philosophy as the single-route share re-planning its stops.
 *
 * Browser globals (CNSDemand, CNSState, CNSShare, CNSSettings, CNSFlightEntry,
 * renderFolder) are read LAZILY inside functions and typeof-guarded, so loading
 * this file in the bare node test harness never throws.
 */
window.CNSBuildShare = (function () {
    'use strict';
    const SCHEMA = 1;

    // Compact point: ident/lat/lon/name, omitting blanks to keep the blob small.
    function _pt(ident, name, lat, lon) {
        const p = {};
        if (ident) p.i = ident;
        if (name) p.n = name;
        if (lat != null) p.la = lat;
        if (lon != null) p.lo = lon;
        return p;
    }

    // Read the saved network into a build blob (INPUTS only).
    function currentBuild() {
        const D = (typeof CNSDemand !== 'undefined') ? CNSDemand : null;
        const folder = (D && D.loadFolder) ? D.loadFolder() : [];
        const fl = folder.map((t) => {
            const rec = {
                id: t.id, p: t.planeId, c: t.chargerId,
                t: t.tripType, fn: t.freqN, fu: t.freqUnit,
                o: _pt(t.originIdent, t.originName, t.originLat, t.originLon),
            };
            if (t.tripType !== 'training' && t.destIdent) {
                rec.d = _pt(t.destIdent, t.destName, t.destLat, t.destLon);
            }
            const stops = (t.stops || [])
                .map((s) => _pt(s.ident, s.name, s.lat, s.lon))
                .filter((s) => s.la != null && s.lo != null);
            if (stops.length) rec.s = stops;
            return rec;
        });

        const blob = { v: SCHEMA, k: 'build', fl };
        const cfg = (D && D.loadCfg) ? D.loadCfg() : {};
        if (cfg && Object.keys(cfg).length) blob.cfg = cfg;
        const St = (typeof CNSState !== 'undefined') ? CNSState : null;
        const sch = (St && St.getJSON) ? St.getJSON(St.KEYS.sched, {}) : {};
        if (sch && Object.keys(sch).length) blob.sch = sch;
        const ms = (typeof CNSShare !== 'undefined' && CNSShare.settingsDelta) ? CNSShare.settingsDelta() : undefined;
        if (ms) blob.ms = ms;
        return blob;
    }

    return { currentBuild, SCHEMA };
})();
