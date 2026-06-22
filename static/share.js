/*
 * CNSShare — shareable route links.
 *
 * Primary form: the planner state is POSTed to /api/share, stored server-side
 * (shares.py / SQLite), and shared as a short https://<host>/s/<slug> link.
 * createShortLink()/copyLink() build it; the server injects the saved state as
 * window.__CNS_SHARE__ on open and the page restores it via apply().
 *
 * Legacy form (still supported): the state is serialised into a compact
 * base64url token in the URL *hash* (#r=...). The hash is never sent to the
 * server, so these older links still survive the auth 302 redirect. copyLink()
 * falls back to this hash link whenever the /api/share POST fails.
 *
 * Auto charging stops are NOT stored: apply() replays the planner's recompute,
 * so they re-plan fresh (and stay correct if the catalog / settings change).
 * Only idents go in the URL; coordinates resolve from the airport catalog on
 * open. Custom (user-added) planes/chargers fall back to defaults with a notice.
 *
 * Inline-planner globals (selected, plannedStops, airportByIdent, pickAirport,
 * setStop, smartReplan, drawLiveRoute, renderPlaneSpecCard) and CNSSettings are
 * read LAZILY inside functions and guarded with typeof, so loading this file in
 * a bare context (the node test harness) never throws.
 */
window.CNSShare = (function () {
    'use strict';
    const SCHEMA = 1;
    const KEY = 'r';                 // #r=<blob>

    // ---- base64url <-> utf8 (synchronous; works in browser + node) ----
    function _b64urlEncode(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function _b64urlDecode(b64) {
        const s = b64.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(s + '==='.slice((s.length + 3) % 4));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    function encode(state) { return _b64urlEncode(JSON.stringify(state)); }
    function decode(blob) { return JSON.parse(_b64urlDecode(blob)); }

    // ---- only the Model settings that differ from the defaults ----
    function _settingsDelta() {
        const S = window.CNSSettings;
        if (!S || !S.loadAll || !S.DEFAULTS) return undefined;
        const cur = S.loadAll(), def = S.DEFAULTS, out = {};
        Object.keys(cur).forEach((k) => {
            if (JSON.stringify(cur[k]) !== JSON.stringify(def[k])) out[k] = cur[k];
        });
        return Object.keys(out).length ? out : undefined;
    }

    // ---- read the live planner state ----
    function currentState() {
        const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
        const sel = (typeof selected !== 'undefined' && selected) ? selected : {};
        const ps = (typeof plannedStops !== 'undefined' && Array.isArray(plannedStops)) ? plannedStops : [];
        const ws = document.getElementById('withStops');
        const st = {
            v: SCHEMA,
            a: val('plane'),
            o: sel.origin ? sel.origin.ident : '',
            d: sel.destination ? sel.destination.ident : '',
            s: ps.filter((p) => p && p.ident && !p._auto).map((p) => p.ident),   // only the operator's stops; auto charging stops re-plan on open
            t: val('tripType') || 'oneway',
            f: { n: +val('freqN') || 1, u: val('freqUnit') || 'day' },
            c: val('charger'),
            w: !!(ws && ws.checked),
        };
        const ms = _settingsDelta();
        if (ms) st.ms = ms;
        return st;
    }

    // ---- apply a decoded state to the planner ----
    function apply(st) {
        if (!st || typeof st !== 'object') return;
        const byIdent = (typeof airportByIdent !== 'undefined' && airportByIdent) ? airportByIdent : {};
        const fire = (id, v) => {
            const el = document.getElementById(id);
            if (el && v != null && v !== '') { el.value = v; el.dispatchEvent(new Event('change')); }
        };
        const optExists = (id, v) => { const el = document.getElementById(id); return !!(el && [...el.options].some((o) => o.value === v)); };
        const miss = [];

        // 1. Model settings first, so the recompute + simulate use them.
        if (st.ms && window.CNSSettings && CNSSettings.save) { try { CNSSettings.save(st.ms); } catch (e) { /* ignore */ } }

        // 2. Trip type before stops/destination (circular handles points differently).
        if (st.t) fire('tripType', st.t);

        // 3. Aircraft (drives the default charger), then override the charger explicitly.
        if (st.a) { optExists('plane', st.a) ? fire('plane', st.a) : miss.push('aircraft'); }
        if (st.c) { optExists('charger', st.c) ? fire('charger', st.c) : miss.push('charger'); }

        // 4. Frequency.
        const fn = document.getElementById('freqN');
        if (fn && st.f && st.f.n) fn.value = st.f.n;
        if (st.f && st.f.u) fire('freqUnit', st.f.u);

        // 5. Charging-stops toggle (manual stops below will force it on if needed).
        const ws = document.getElementById('withStops');
        if (ws && st.w !== undefined && ws.checked !== !!st.w) { ws.checked = !!st.w; ws.dispatchEvent(new Event('change')); }

        // 6. Route: origin -> manual stops -> destination (resolved from the catalog).
        //    A circular trip has no separate destination — its far point is just the
        //    final ring node, so add it as the last STOP (the recompute then derives
        //    the dest from it); applying it as a destination would be dropped.
        if (st.o) { (byIdent[st.o] && typeof pickAirport === 'function') ? pickAirport('origin', byIdent[st.o]) : miss.push('departure'); }
        (st.s || []).forEach((id) => { if (byIdent[id] && typeof setStop === 'function') setStop(id); });
        if (st.d) {
            if (!byIdent[st.d]) miss.push('destination');
            else if (st.t === 'circular') { if (typeof setStop === 'function') setStop(st.d); }
            else if (typeof pickAirport === 'function') pickAirport('destination', byIdent[st.d]);
        }

        if (typeof renderPlaneSpecCard === 'function') renderPlaneSpecCard();
        if (typeof smartReplan === 'function') smartReplan();          // re-plan auto charging stops
        if (typeof drawLiveRoute === 'function') drawLiveRoute();

        // 7. Simulate so the result panel (where the Share button lives) opens.
        const form = document.getElementById('simForm');
        if (form && st.o && (st.d || st.t === 'training')) {
            try { form.requestSubmit(); }
            catch (e) { form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); }
        }

        if (miss.length) toast('Shared route: ' + [...new Set(miss)].join(', ') + ' unavailable here — using defaults', 4500);
    }

    // ---- URL helpers ----
    function _params() { return new URLSearchParams((location.hash || '').replace(/^#/, '')); }
    function hasLink() { return _params().has(KEY); }
    function shareUrl() { return location.origin + location.pathname + '#' + KEY + '=' + encode(currentState()); }

    function init() {
        if (!hasLink()) return false;
        let st;
        try { st = decode(_params().get(KEY)); }
        catch (e) { console.warn('[CNSShare] unreadable link', e); toast('Couldn’t read that shared link.', 4500); return false; }
        if (!st || st.v !== SCHEMA) { toast('This shared link is from a different version.', 4500); return false; }
        apply(st);
        return true;
    }

    // POST the state to the server, which stores it and returns a short
    // /s/<slug> URL. _fetch is injectable for tests; defaults to window.fetch.
    async function createShortLink(state, _fetch) {
        const f = _fetch || (typeof fetch !== 'undefined' ? fetch : null);
        if (!f) throw new Error('no fetch available');
        const resp = await f('/api/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state }),
        });
        if (!resp.ok) throw new Error('share request failed: ' + resp.status);
        const data = await resp.json();
        if (!data || !data.url) throw new Error('share response missing url');
        return data.url;
    }

    async function copyLink() {
        let url;
        try { url = await createShortLink(currentState()); }
        catch (e) { url = shareUrl(); }   // server unavailable → the long hash link still works
        try { await navigator.clipboard.writeText(url); toast('Link copied'); }
        catch (e) { window.prompt('Copy this shareable link:', url); }
        return url;
    }

    // ---- minimal toast ----
    let _toastEl = null, _toastTimer = null;
    function toast(msg, ms) {
        if (typeof document === 'undefined') return;
        if (!_toastEl) { _toastEl = document.createElement('div'); _toastEl.className = 'cns-share-toast'; document.body.appendChild(_toastEl); }
        _toastEl.textContent = msg;
        _toastEl.classList.add('show');
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => _toastEl && _toastEl.classList.remove('show'), ms || 2200);
    }

    return { encode, decode, currentState, apply, hasLink, shareUrl, init, createShortLink, copyLink, toast, SCHEMA };
})();
