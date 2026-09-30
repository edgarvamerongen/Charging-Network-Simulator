/* CNS v2 — ui/palette.js: topbar menus, units, map options persistence, and the search field that is
   the command palette (⌘K): airports, aircraft, chargers and actions drop down under it (audit P7). */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc;
  const KEY = 'cns_map_options';
  const RG_KEY = 'cns_v2_reach_graph';   // v2-only: the classic rewrites KEY wholesale and would drop this flag
  // the classic writes satellite|voyager on this shared key; v2 speaks light|street|sat — translate both ways
  const BM_FROM = { satellite: 'sat', voyager: 'street', sat: 'sat', street: 'street', light: 'light' };
  const BM_TO = { sat: 'satellite', street: 'voyager', light: 'light' };
  function loadOpts() { try { const o = CNSState.getJSON(KEY, {}); const bm = BM_FROM[o.basemap]; if (bm) S.base = bm; const T = []; if (o.fLarge !== false) T.push('large_airport'); if (o.fMedium !== false) T.push('medium_airport'); if (o.fSmall === true) T.push('small_airport'); S.allowedTypes = T; if ('nrgChargerToggle' in o) S.showAssets = !!o.nrgChargerToggle; if ('fSavedRoutes' in o) S.showNet = !!o.fSavedRoutes; if ('fAlternates' in o) S.showAlternates = !!o.fAlternates; if ('flightLabelToggle' in o) S.showLabels = o.flightLabelToggle !== false; S.showTracks = o.fTracks === true; const rg0 = document.getElementById('fReachGraph');
      if (rg0) { const mirror = localStorage.getItem(RG_KEY); rg0.checked = ('fReachGraph' in o) ? !!o.fReachGraph : (mirror === '1'); } } catch (e) {} }
  function saveOpts() { try { const o = CNSState.getJSON(KEY, {}); const rg = document.getElementById('fReachGraph'); try { localStorage.setItem(RG_KEY, rg && rg.checked ? '1' : '0'); } catch (e) {} Object.assign(o, { basemap: BM_TO[S.base] || S.base, fReachGraph: !!(rg && rg.checked), fLarge: S.allowedTypes.includes('large_airport'), fMedium: S.allowedTypes.includes('medium_airport'), fSmall: S.allowedTypes.includes('small_airport'), nrgChargerToggle: S.showAssets, fSavedRoutes: S.showNet, fAlternates: S.showAlternates, flightLabelToggle: S.showLabels, fTracks: !!S.showTracks }); CNSState.setJSON(KEY, o); } catch (e) {} }
  document.addEventListener('DOMContentLoaded', loadOpts);
  // ---- topbar ----------------------------------------------------------------
  document.addEventListener('click', e => {
    const dd = { mapBtn: 'mapDd', shareBtn: 'shareDd', expBtn: 'expDd', helpBtn: 'helpDd' }; const tb = e.target.closest('#mapBtn,#shareBtn,#expBtn,#helpBtn');
    $$('.dd').forEach(x => { if (!(tb && x.id === dd[tb.id]) && !x.contains(e.target)) x.classList.remove('open'); });
    if (tb) { $('#' + dd[tb.id]).classList.toggle('open'); return; }
    const b = e.target.closest('#mapDd [data-base]'); if (b) { UI.map.setBase(b.dataset.base); $$('#mapDd [data-base]').forEach(x => x.classList.toggle('on', x === b)); saveOpts(); return; }
    const u = e.target.closest('#unitSeg button'); if (u) { setUnits(u.dataset.u); return; }
    const x = e.target.closest('#expDd [data-exp],#shareDd [data-exp]'); if (x) { $$('.dd').forEach(d => d.classList.remove('open')); runExport(x.dataset.exp, x); return; }
    if (e.target.closest('#helpDd button,#helpDd a')) $$('.dd').forEach(d => d.classList.remove('open'));   // tour.js starts the tour on #tourBtn
    if (e.target.closest('#kbdHint')) open('');
  });
  document.addEventListener('change', e => { const t = e.target;
    if (t.classList && t.classList.contains('airport-filter')) { S.allowedTypes = $$('.airport-filter').filter(c => c.checked).map(c => c.value); UI.map.applyVisibility(); saveOpts(); UI.plan.onFormChange(false); }
    if (t.id === 'nrgChargerToggle') { S.showAssets = t.checked; UI.map.drawAssets(); saveOpts(); UI.plan.onFormChange(false); }
    if (t.id === 'fSavedRoutes') { S.showNet = t.checked; UI.map.drawNet(); saveOpts(); }
    if (t.id === 'fAlternates') { S.showAlternates = t.checked; saveOpts(); UI.render(); UI.map.drawAlternates(); }
    if (t.id === 'flightLabelToggle') { S.showLabels = t.checked; saveOpts(); UI.map.drawRoute(false); }
    if (t.id === 'fTracks') { S.showTracks = t.checked; saveOpts(); UI.map.drawRoute(false); }
    if (t.id === 'fReachGraph') saveOpts(); });
  function runExport(kind, btn) {
    if (kind === 'xlsx' && window.CNSSpreadsheet) return CNSSpreadsheet.export(btn);
    if (kind === 'share') return UI.share.copyRouteLink();
    if (kind === 'build') return UI.share.copyBuildLink();
    if (kind === 'pdf') return UI.report.pick();
  }
  // Units: a set-once preference, so it lives in Model settings and the palette, not in the bar.
  function setUnits(u) { if (window.CNSUnits) CNSUnits.set(u === 'nm' ? 'nautical' : 'metric'); $$('#unitSeg button').forEach(x => x.classList.toggle('on', x.dataset.u === u)); }
  // sync the topbar controls to persisted state
  function syncControls() { $$('#mapDd [data-base]').forEach(x => x.classList.toggle('on', x.dataset.base === S.base)); $$('.airport-filter').forEach(c => c.checked = S.allowedTypes.includes(c.value)); $('#nrgChargerToggle').checked = S.showAssets; $('#fSavedRoutes').checked = S.showNet; $('#fAlternates').checked = S.showAlternates; $('#flightLabelToggle').checked = S.showLabels; $('#fTracks').checked = !!S.showTracks;
    const nm = window.CNSUnits && CNSUnits.isNautical && CNSUnits.isNautical(); $$('#unitSeg button').forEach(x => x.classList.toggle('on', (x.dataset.u === 'nm') === !!nm)); }
  document.addEventListener('DOMContentLoaded', syncControls);
  // ---- command palette ------------------------------------------------------------
  const CMD = { items: [], hl: 0 };
  function items(q) {
    const ql = (q || '').trim().toLowerCase(); const L = []; const add = (g, label, run, k, sub) => L.push({ g, label, run, k, sub });
    const hit = s => !ql || s.toLowerCase().includes(ql);
    const acts = actions().filter(([l]) => hit(l)).slice(0, ql ? 8 : 10), pushActs = () => acts.forEach(([l, run, k]) => add('Actions', esc(l), run, k || ''));
    // An action the query names from its first letter ranks first ("sim" → Simulate), then airports by match (audit F6).
    const actsFirst = !!ql && acts.some(([l]) => l.toLowerCase().startsWith(ql)); if (actsFirst) pushActs();
    if (ql.length >= 2) UI.search(ql).slice(0, 4).forEach((a, ai) => {
      add('Airports', `<b>${esc(a.ident)}</b> ${esc(a.name)}`, () => UI.map.flyTo(a), 'fly to', esc(a.municipality || ''));
      if (ai > 0) return;
      add('Airports', `Set <b>${esc(a.ident)}</b> as departure`, () => { S.origin = a; UI.setMode('plan'); UI.plan.onFormChange(false); }, 'D');
      add('Airports', `Set <b>${esc(a.ident)}</b> as destination`, () => { S.dest = a; UI.setMode('plan'); UI.plan.onFormChange(false); }, 'A');
      add('Airports', `Add <b>${esc(a.ident)}</b> as a stop`, () => { S.stops.push(a); UI.setMode('plan'); UI.plan.onFormChange(false); }, 'S');
      if (window.CNSDemand && CNSDemand.computeAirports()[a.ident]) add('Airports', `Isolate <b>${esc(a.ident)}</b> in the network`, () => { UI.setMode('network'); S.filter = a.ident; S.openAp[a.ident] = true; UI.render(); UI.map.drawNet(); UI.map.fitNet(); $('#drawer').classList.add('open'); }, 'I'); });
    UI.PLANES.filter(p => ql && hit(`${p.oem || ''} ${p.name} ${p.id || ''}`)).slice(0, 3).forEach(p => add('Aircraft', `Aircraft: ${esc(p.name)}`, () => { S.planeId = p.id; const dc = p.default_charger_id; if (dc && UI.CHARGERS.find(c => c.id === dc)) S.chargerId = dc; UI.setMode('plan'); UI.plan.onFormChange(false); }, '', `${UI.fmt.dist(p.range_km)} · ${p.battery_kwh > 0 ? UI.fmt.ekwh(p.battery_kwh) : 'no charge'}`));
    UI.CHARGERS.filter(c => ql && hit(c.name)).slice(0, 3).forEach(c => add('Chargers', `Charger: ${esc(c.name)}`, () => { S.chargerId = c.id; UI.setMode('plan'); UI.plan.onFormChange(false); }));
    if (!actsFirst) pushActs();
    return L.slice(0, 14);
  }
  function actions() {
    return [
      ['Simulate the current route', () => { UI.setMode('plan'); UI.plan.simulate(); }, '↵'],
      S.result ? ['Add the result to the network', () => UI.plan.addToNetwork()] : null,
      [S.mode === 'network' ? 'Switch to Plan mode' : 'Switch to Network mode', () => UI.setMode(S.mode === 'network' ? 'plan' : 'network'), 'N'],
      [S.mode === 'network' ? 'Fit the map to the network' : 'Fit the map to the route', () => UI.map.fit(), 'F'],
      ['Basemap: Light', () => $('#mapDd [data-base=light]').click()], ['Basemap: Street', () => $('#mapDd [data-base=street]').click()], ['Basemap: Satellite', () => $('#mapDd [data-base=sat]').click()],
      ['Units: kilometres', () => setUnits('km')], ['Units: nautical miles', () => setUnits('nm')],
      ['Export demand workbook (XLSX)', () => runExport('xlsx', $('#expBtn')), '⇧X'], ['Share this route', () => runExport('share'), '⇧L'], ['Share the network build', () => runExport('build')],
      ['Reset the route form', () => { UI.setMode('plan'); UI.plan.resetForm(); }],
      ['Model settings', () => UI.settings.open()], ['Take the tour', () => UI.tour.start()], ['Export advisory report (PDF)', () => UI.report.pick(), '⇧P'],
      ['Load scenario: Hub base', () => UI.network.loadScenario('hub')], ['Load scenario: Regional network', () => UI.network.loadScenario('regional')], ['Load scenario: Training school', () => UI.network.loadScenario('training')],
      S.filter ? ['Show all airports', () => { S.filter = ''; UI.render(); UI.map.drawNet(); UI.map.fitNet(); }] : null,
      [S.lanes === 'fleet' ? 'Timeline: airport lanes' : 'Timeline: fleet lanes', () => { S.lanes = S.lanes === 'fleet' ? 'airports' : 'fleet'; $('#drawer').classList.add('open'); UI.timeline.render(); }],
      ['Open the classic version', () => { location.href = '/?desktop=1'; }],
      [UI.PROTO ? 'Leave the prototype' : 'Open the prototype: fixed panels, live result, charger sizing', () => { location.search = UI.PROTO ? '' : '?proto'; }],
    ].filter(Boolean);
  }
  function renderList() { const list = $('#cmdkList'); if (!CMD.items.length) { list.innerHTML = '<div class="none">Nothing matches. Try an ICAO code, a city, an aircraft or an action.</div>'; return; }
    let g = ''; list.innerHTML = CMD.items.map((it, i) => { const h = it.g !== g ? `<div class="grp">${it.g}</div>` : ''; g = it.g; return `${h}<div class="it ${i === CMD.hl ? 'on' : ''}" data-i="${i}"><span>${it.label}${it.sub ? ` <span class="sub">${it.sub}</span>` : ''}</span>${it.k ? `<span class="k">${it.k}</span>` : ''}</div>`; }).join('');
    const on = list.querySelector('.it.on'); if (on) on.scrollIntoView({ block: 'nearest' }); }
  function open(q) { const inp = $('#cmdkIn'); $('#cmdk').hidden = false; if (q != null) inp.value = q; CMD.items = items(inp.value); CMD.hl = 0; renderList(); if (document.activeElement !== inp) inp.focus(); }
  function close() { $('#cmdk').hidden = true; }
  function run(i) { const it = CMD.items[i]; if (!it) return; close(); const inp = $('#cmdkIn'); inp.value = ''; inp.blur(); it.run(); }
  document.addEventListener('DOMContentLoaded', () => {
    $('#cmdkIn').addEventListener('focus', () => { if ($('#cmdk').hidden) open(null); });
    $('#cmdkIn').addEventListener('input', e => { $('#cmdk').hidden = false; CMD.items = items(e.target.value); CMD.hl = 0; renderList(); });
    document.addEventListener('mousedown', e => { if (!$('#cmdk').hidden && !e.target.closest('#cmdkWrap')) close(); });
    $('#cmdkIn').addEventListener('keydown', e => { if (e.key === 'ArrowDown') { CMD.hl = Math.min(CMD.items.length - 1, CMD.hl + 1); renderList(); e.preventDefault(); } else if (e.key === 'ArrowUp') { CMD.hl = Math.max(0, CMD.hl - 1); renderList(); e.preventDefault(); } else if (e.key === 'Enter') { run(CMD.hl); e.preventDefault(); } else if (e.key === 'Escape') { close(); e.target.value = ''; e.target.blur(); } });
    $('#cmdkList').addEventListener('click', e => { const it = e.target.closest('.it'); if (it) run(+it.dataset.i); });
    $('#cmdkList').addEventListener('mousemove', e => { const it = e.target.closest('.it'); if (it && +it.dataset.i !== CMD.hl) { CMD.hl = +it.dataset.i; renderList(); } }); });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('#cmdk').hidden) open(''); else { close(); $('#cmdkIn').blur(); } } else if (e.key === 'Escape' && !$('#cmdk').hidden) { close(); $('#cmdkIn').value = ''; $('#cmdkIn').blur(); } });
  UI.palette = { items };
})();
