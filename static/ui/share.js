/* CNS v2 — ui/share.js: route share links (CNSShare schema 1), build links (CNSBuildShare), the
   custom-charger dialog. State is read from S instead of the classic's form ids; the blob format
   and the /api/share endpoint are the classic's, so links open in either shell. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, esc = UI.esc;
  const v2Url = url => String(url || '').replace(/\/s\//, '/v2/s/');
  function currentState() {
    const st = { v: (window.CNSShare && CNSShare.SCHEMA) || 1, a: S.planeId || '', o: S.origin ? S.origin.ident : '', d: S.dest ? S.dest.ident : '',
      s: S.stops.filter(Boolean).map(a => a.ident), t: S.trip, f: { n: +S.freq || 1, u: S.per || 'day' }, c: S.chargerId || '', w: true };
    const ms = (window.CNSShare && CNSShare.settingsDelta) ? CNSShare.settingsDelta() : null; if (ms) st.ms = ms;
    return st;
  }
  async function copyRouteLink() {
    let url; try { url = v2Url(await CNSShare.createShortLink(currentState())); } catch (e) { UI.toast('Share link failed — is the server reachable?'); return; }
    try { await navigator.clipboard.writeText(url); UI.toast('Link copied'); } catch (e) { window.prompt('Copy this shareable link:', url); }
  }
  async function copyBuildLink() {
    if (!window.CNSBuildShare) return;
    try { await CNSBuildShare.copyBuildLink({ createShortLink: async st => v2Url(await CNSShare.createShortLink(st)), writeText: async t => { await navigator.clipboard.writeText(t); UI.toast('Build link copied'); } }); }
    catch (e) { UI.toast('Build link failed — ' + e.message); }
  }
  async function applyState(st) {
    if (!st) return false;
    if (st.k === 'build' && window.CNSBuildShare) { await CNSBuildShare.applyBuild(st); UI.folderChanged(); UI.setMode('network'); UI.map.drawNet(); UI.map.fitNet(); UI.toast(`Build restored — ${CNSDemand.loadFolder().length} routes`); return true; }
    if (st.v == null) return false;
    const by = UI.byId();
    if (st.a && UI.PLANES.find(p => p.id === st.a)) S.planeId = st.a;
    if (st.c && UI.CHARGERS.find(c => c.id === st.c)) S.chargerId = st.c;
    if (st.o && by[st.o]) S.origin = by[st.o]; if (st.d && by[st.d]) S.dest = by[st.d];
    S.stops = (st.s || []).map(id => by[id]).filter(Boolean);
    S.trip = ({ oneway: 'one-way', 'one-way': 'one-way', retour: 'retour', circular: 'circular', training: 'training' })[st.t] || 'one-way';
    if (st.f) { S.freq = Math.max(1, +st.f.n || 1); S.per = st.f.u === 'week' ? 'week' : 'day'; }
    if (st.ms && window.CNSSettings && CNSSettings.save) { try { CNSSettings.save(st.ms); } catch (e) { console.warn('[v2] share settings not applied', e); } }
    UI.plan.onFormChange(true); await UI.plan.simulate(); UI.toast('Shared route opened'); return true;
  }
  // ---- custom chargers ----
  const MAX = 5;
  function chargerModal() {
    const customs = (window.CNSChargers && CNSChargers.list) ? CNSChargers.list() : [];
    const atMax = customs.length >= MAX;
    UI.modal.open(`<div class="mh"><h3>Custom charger</h3><button class="tb icon" data-modal="close"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div class="mb"><div class="row" style="gap:8px"><label class="fld" style="flex:1"><input id="ccName" placeholder="Name (e.g. Hangar 4 DC)" maxlength="40"></label><label class="fld" style="width:120px"><input id="ccPower" type="number" min="1" max="10000" placeholder="kW" class="num"></label></div>
      <div class="err" id="ccError" hidden></div>
      <div class="cap" style="margin:14px 0 6px">Your custom chargers · ${customs.length} / ${MAX}</div>
      ${customs.length ? customs.map(c => `<div class="fl" style="grid-template-columns:1fr auto auto"><span class="t">${esc(c.name)}</span><span class="mu num">${c.power_kw} kW</span><button class="rm" data-act="ccRemove" data-id="${esc(c.id)}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button></div>`).join('') : '<div class="hint">None yet. Custom chargers are shared with everyone on this server.</div>'}</div>
      <div class="btns"><button class="btn p" data-act="ccSave" ${atMax ? 'disabled' : ''}>${atMax ? 'Limit reached (' + MAX + ')' : 'Add charger'}</button><button class="btn" data-modal="close">Close</button></div>`);
  }
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    if (t.dataset.act === 'ccOpen') { chargerModal(); return; }
    if (t.dataset.act === 'ccSave') { const name = $('#ccName').value.trim(), power = parseFloat($('#ccPower').value); const err = $('#ccError');
      if (!name || !(power > 0)) { err.textContent = 'Give the charger a name and a power in kW.'; err.hidden = false; return; }
      try { const c = await CNSChargers.add({ name, power_kw: power }); if (!UI.CHARGERS.find(x => x.id === c.id)) UI.CHARGERS.push(Object.assign({ type: 'Custom', image: '' }, c)); UI.rebuildIndexes(); S.chargerId = c.id; UI.modal.close(); UI.toast('Charger added'); UI.plan.onFormChange(false); }
      catch (ex) { err.textContent = ex.message || 'Could not add the charger.'; err.hidden = false; } return; }
    if (t.dataset.act === 'ccRemove') { try { await CNSChargers.remove(t.dataset.id); const i = UI.CHARGERS.findIndex(x => x.id === t.dataset.id); if (i >= 0) UI.CHARGERS.splice(i, 1); UI.rebuildIndexes(); if (S.chargerId === t.dataset.id) S.chargerId = UI.CHARGERS[0].id; chargerModal(); UI.plan.onFormChange(false); } catch (ex) { UI.toast('Could not remove: ' + ex.message); } }
  });
  UI.share = { currentState, copyRouteLink, copyBuildLink, applyState };
})();
