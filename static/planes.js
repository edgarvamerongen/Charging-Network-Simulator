/*
 * CNSPlanes — user-defined aircraft, persisted on the SERVER (shared across all
 * visitors). Falls back to localStorage if the API is unreachable (offline dev).
 *
 * Async API:
 *   await CNSPlanes.load();           // pull custom planes from the server
 *   CNSPlanes.list();                 // [] (after load)
 *   CNSPlanes.get(id);                // plane object
 *   await CNSPlanes.add(plane);       // POST → server, return saved plane
 *
 * Migration: if the server has none and localStorage has some (legacy data),
 * push them up on first load so nothing is lost.
 *
 * Depends on: CNSState (load earlier).
 */
window.CNSPlanes = (function () {
    const ENDPOINT = '/api/custom/planes';
    const LSKEY = CNSState.KEYS.custom;

    let cached = [];
    const byId = {};

    function _index(p) { byId[p.id] = p; }
    function _clear() { cached = []; for (const k in byId) delete byId[k]; }

    async function load() {
        _clear();
        let serverList = null;
        try {
            const res = await fetch(ENDPOINT);
            if (res.ok) serverList = await res.json();
        } catch (e) { /* offline → fall through */ }

        if (Array.isArray(serverList)) {
            cached = serverList.slice();
            cached.forEach(_index);

            // one-time migration: lift legacy localStorage planes to the server
            const legacy = CNSState.getJSON(LSKEY, []);
            if (cached.length === 0 && legacy.length) {
                for (const p of legacy) {
                    try {
                        const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
                        if (r.ok) { const saved = await r.json(); cached.push(saved); _index(saved); }
                    } catch (e) { /* ignore */ }
                }
                if (cached.length) CNSState.remove(LSKEY);
            }
        } else {
            // server unreachable → use localStorage as a graceful fallback
            cached = CNSState.getJSON(LSKEY, []);
            cached.forEach(_index);
        }
        return cached.slice();
    }

    const list = () => cached.slice();
    const get = (id) => byId[id];

    async function add(plane) {
        const draft = Object.assign({}, plane);
        let serverReached = false;
        try {
            const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
            serverReached = true;
            if (res.ok) {
                const saved = await res.json();
                cached.push(saved); _index(saved);
                return saved;
            }
            // Server replied with an error (e.g. limit reached) — surface it; don't silently fall back.
            const body = await res.json().catch(() => ({}));
            const e = new Error(body.error || `Server returned ${res.status}`);
            e.serverError = true;
            throw e;
        } catch (e) {
            if (e && e.serverError) throw e;
            if (serverReached) throw e;
            // Network unreachable → local fallback (no server cap)
            if (!draft.id) draft.id = 'custom_' + Date.now().toString(36);
            cached.push(draft); _index(draft);
            CNSState.setJSON(LSKEY, cached);
            return draft;
        }
    }

    async function remove(id) {
        try {
            const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!res.ok && res.status !== 404) {
                // server-side error; surface so UI can show it
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `delete returned ${res.status}`);
            }
        } catch (e) { /* network: fall through to local cleanup anyway */ }
        cached = cached.filter(p => p.id !== id);
        delete byId[id];
        const ls = CNSState.getJSON(LSKEY, []).filter(p => p.id !== id);
        CNSState.setJSON(LSKEY, ls);
        return true;
    }

    return { load, list, get, add, remove };
})();
