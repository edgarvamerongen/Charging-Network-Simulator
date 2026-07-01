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

    // A stored flight's inputs → an /api/simulate request body.
    function _simPayload(fl) {
        const wp = (p) => ({ ident: p.i, name: p.n, lat: p.la, lon: p.lo });
        const body = { plane_id: fl.p, charger_id: fl.c, trip_type: fl.t, origin: wp(fl.o) };
        if (fl.d) body.destination = wp(fl.d);
        if (fl.s && fl.s.length) body.stops = fl.s.map(wp);
        return body;
    }

    // Re-simulate one stored flight → a folder entry (null if it can't fly now).
    async function _restoreFlight(fl, _fetch) {
        const f = _fetch || (typeof fetch !== 'undefined' ? fetch : null);
        if (!f) return null;
        let d;
        try {
            d = await f('/api/simulate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(_simPayload(fl)),
            }).then((r) => r.json());
        } catch (e) { return null; }
        if (!d || d.error || !d.plane) return null;
        const wp = (p) => ({ ident: p.i, name: p.n, lat: p.la, lon: p.lo });
        const FE = (typeof CNSFlightEntry !== 'undefined') ? CNSFlightEntry : null;
        if (!FE || !FE.fromSim) return null;
        const entry = FE.fromSim(d, {
            origin: wp(fl.o), dest: fl.d ? wp(fl.d) : wp(fl.o),
            chargerId: fl.c, freqN: fl.fn, freqUnit: fl.fu, id: fl.id,
        });
        // Imported stops are intentional itinerary waypoints (a reconstructed
        // rotation's real legs), not auto-inserted charging stops — tag them
        // _manual so the demand-calc recompute preserves them (otherwise it
        // drops untagged stops and collapses the rotation into one long leg).
        if (entry && Array.isArray(entry.stops)) {
            entry.stops = entry.stops.map((s) => ({ ...s, _manual: true }));
        }
        return entry;
    }

    // Restore a build blob: settings first, then re-simulate every flight in
    // parallel, replace the folder, and reapply per-airport config + schedule.
    async function applyBuild(st, _fetch) {
        if (!st || st.k !== 'build') return { restored: 0, dropped: 0 };
        if (st.ms && typeof CNSSettings !== 'undefined' && CNSSettings.save) {
            try { CNSSettings.save(st.ms); } catch (e) { /* ignore */ }
        }
        const specs = Array.isArray(st.fl) ? st.fl : [];
        const entries = await Promise.all(specs.map((fl) => _restoreFlight(fl, _fetch)));
        const ok = entries.filter(Boolean);
        const dropped = specs.length - ok.length;

        if (typeof CNSDemand !== 'undefined') {
            if (CNSDemand.saveFolder) CNSDemand.saveFolder(ok);
            if (st.cfg && CNSDemand.saveCfg) CNSDemand.saveCfg(st.cfg);
        }
        if (st.sch && typeof CNSState !== 'undefined' && CNSState.setJSON) {
            CNSState.setJSON(CNSState.KEYS.sched, st.sch);
        }
        if (typeof renderFolder === 'function') renderFolder();
        if (dropped && typeof CNSShare !== 'undefined' && CNSShare.toast) {
            CNSShare.toast(dropped + ' flight' + (dropped > 1 ? 's' : '') + ' couldn’t be restored — skipped', 4500);
        }
        return { restored: ok.length, dropped };
    }

    // POST the current network as a build and copy its /s/<slug> link. _deps is
    // injectable for tests; defaults to CNSShare.createShortLink + the clipboard.
    async function copyBuildLink(_deps) {
        const deps = _deps || {};
        const createShortLink = deps.createShortLink
            || (typeof CNSShare !== 'undefined' ? CNSShare.createShortLink : null);
        const writeText = deps.writeText
            || ((typeof navigator !== 'undefined' && navigator.clipboard) ? navigator.clipboard.writeText.bind(navigator.clipboard) : null);
        const toast = (m, ms) => { if (typeof CNSShare !== 'undefined' && CNSShare.toast) CNSShare.toast(m, ms); };

        const folder = (typeof CNSDemand !== 'undefined' && CNSDemand.loadFolder) ? CNSDemand.loadFolder() : [];
        if (!folder.length) { toast('Add at least one flight before sharing a build.', 3500); return null; }

        let url;
        try { url = await createShortLink(currentBuild()); }
        catch (e) { toast('Couldn’t create a share link — try again.', 4000); return null; }   // build links are slug-only: no hash fallback

        try { if (writeText) await writeText(url); toast('Build link copied'); }
        catch (e) { if (typeof window !== 'undefined' && window.prompt) window.prompt('Copy this shareable build link:', url); }
        return url;
    }

    return { currentBuild, applyBuild, copyBuildLink, _simPayload, SCHEMA };
})();
