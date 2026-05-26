/*
 * CNSState — central registry of localStorage keys + a tiny pub/sub.
 * ------------------------------------------------------------------
 * Every piece of persistent app state goes through here, so modules can:
 *   - read/write without hard-coding storage keys, and
 *   - subscribe to changes (useful when the UI eventually goes reactive).
 *
 * Intentionally framework-free and ~zero-dep so it ports cleanly to React/Svelte.
 */
window.CNSState = (function () {
    const KEYS = {
        folder: 'cns_folder',        // saved flights (the demand calculator)
        cfg: 'cns_airport_cfg',      // per-airport charger fleet + fullCharge
        sched: 'cns_schedule',       // per-trip rotation take-off times
        units: 'cns_units',          // 'metric' | 'nautical'
        custom: 'cns_custom_planes'  // user-defined aircraft
    };

    const subs = [];
    const subscribe = (fn) => { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; };
    const notify = (key) => subs.forEach(fn => { try { fn(key); } catch (e) { console.error('state subscriber', e); } });

    const getRaw = (k) => localStorage.getItem(k);
    const setRaw = (k, v) => { localStorage.setItem(k, v); notify(k); };
    const getJSON = (k, dflt) => {
        try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); }
        catch (e) { return dflt; }
    };
    const setJSON = (k, v) => setRaw(k, JSON.stringify(v));
    const remove = (k) => { localStorage.removeItem(k); notify(k); };

    return { KEYS, subscribe, notify, getRaw, setRaw, getJSON, setJSON, remove };
})();
