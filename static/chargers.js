/*
 * CNSChargers — user-defined chargers, persisted on the SERVER (shared across
 * all visitors). Mirrors CNSPlanes: async load + add, with a localStorage
 * fallback when the API is unreachable.
 *
 * Depends on: CNSState (load earlier).
 */
window.CNSChargers = (function () {
    const ENDPOINT = '/api/custom/chargers';
    const LSKEY = 'cns_custom_chargers';   // local-only fallback storage

    let cached = [];
    const byId = {};

    function _index(c) { byId[c.id] = c; }
    function _clear() { cached = []; for (const k in byId) delete byId[k]; }

    async function load() {
        _clear();
        let serverList = null;
        try {
            const res = await fetch(ENDPOINT);
            if (res.ok) serverList = await res.json();
        } catch (e) { /* offline */ }

        if (Array.isArray(serverList)) {
            cached = serverList.slice();
            cached.forEach(_index);
        } else {
            cached = CNSState.getJSON(LSKEY, []);
            cached.forEach(_index);
        }
        return cached.slice();
    }

    const list = () => cached.slice();
    const get = (id) => byId[id];

    async function add(charger) {
        const draft = Object.assign({}, charger);
        let serverReached = false;
        try {
            const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
            serverReached = true;
            if (res.ok) {
                const saved = await res.json();
                cached.push(saved); _index(saved);
                return saved;
            }
            const body = await res.json().catch(() => ({}));
            const e = new Error(body.error || `Server returned ${res.status}`);
            e.serverError = true;
            throw e;
        } catch (e) {
            if (e && e.serverError) throw e;
            if (serverReached) throw e;
            if (!draft.id) draft.id = 'charger_' + Date.now().toString(36);
            cached.push(draft); _index(draft);
            CNSState.setJSON(LSKEY, cached);
            return draft;
        }
    }

    async function remove(id) {
        try {
            const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!res.ok && res.status !== 404) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `delete returned ${res.status}`);
            }
        } catch (e) { /* fall through to local cleanup */ }
        cached = cached.filter(c => c.id !== id);
        delete byId[id];
        const ls = CNSState.getJSON(LSKEY, []).filter(c => c.id !== id);
        CNSState.setJSON(LSKEY, ls);
        return true;
    }

    return { load, list, get, add, remove };
})();
