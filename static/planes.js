/*
 * CNSPlanes — user-defined ("custom") aircraft persisted in localStorage.
 * -----------------------------------------------------------------------
 * Pure data layer: list, lookup, add. No DOM. The UI (currently in
 * index.html, eventually a React/Svelte component) reads from here.
 *
 * Depends on: CNSState (load earlier).
 */
window.CNSPlanes = (function () {
    const KEY = CNSState.KEYS.custom;

    let customs = CNSState.getJSON(KEY, []);
    const byId = {};
    customs.forEach(p => { if (p && p.id) byId[p.id] = p; });

    const list = () => customs.slice();
    const get = (id) => byId[id];

    const add = (plane) => {
        const p = Object.assign({}, plane);
        if (!p.id) p.id = 'custom_' + Date.now().toString(36);
        customs.push(p);
        byId[p.id] = p;
        CNSState.setJSON(KEY, customs);
        return p;
    };

    return { list, get, add };
})();
