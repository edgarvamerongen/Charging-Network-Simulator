/* CNS v2 — ui/palette.js: topbar menus, units, map options persistence, ⌘K command palette. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc;
  const KEY = 'cns_map_options';
  function loadOpts() { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); if (o.basemap === 'street' || o.basemap === 'sat' || o.basemap === 'light') S.base = o.basemap; const T = []; if (o.fLarge !== false) T.push('large_airport'); if (o.fMedium !== false) T.push('medium_airport'); if (o.fSmall === true) T.push('small_airport'); S.allowedTypes = T; if ('nrgChargerToggle' in o) S.showAssets = !!o.nrgChargerToggle; if ('fSavedRoutes' in o) S.showNet = !!o.fSavedRoutes; if ('fAlternates' in o) S.showAlternates = !!o.fAlternates; if ('flightLabelToggle' in o) S.showLabels = o.flightLabelToggle !== false; } catch (e) {} }
  function saveOpts() { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); Object.assign(o, { basemap: S.base, fLarge: S.allowedTypes.includes('large_airport'), fMedium: S.allowedTypes.includes('medium_airport'), fSmall: S.allowedTypes.includes('small_airport'), nrgChargerToggle: S.showAssets, fSavedRoutes: S.showNet, fAlternates: S.showAlternates, flightLabelToggle: S.showLabels }); localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  document.addEventListener('DOMContentLoaded', loadOpts);
  // ---- topbar ----------------------------------------------------------------
  document.addEventListener('click', e => {
    const dd = { mapBtn: 'mapDd', expBtn: 'expDd', setBtn: 'setDd' }; const tb = e.target.closest('#mapBtn,#expBtn,#setBtn');
    $$('.dd').forEach(x => { if (!(tb && x.id === dd[tb.id]) && !x.contains(e.target)) x.classList.remove('open'); });
    if (tb) { const box = $('#' + dd[tb.id]); box.classList.toggle('open'); if (tb.id === 'setBtn' && window.CNSSettings) $('#setSummary').textContent = (CNSSettings.activeFlags ? CNSSettings.activeFlags() : []).join(' · ') || 'defaults'; return; }
    const b = e.target.closest('#mapDd [data-base]'); if (b) { UI.map.setBase(b.dataset.base); $$('#mapDd [data-base]').forEach(x => x.classList.toggle('on', x === b)); saveOpts(); return; }
    const u = e.target.closest('#unitSeg button'); if (u) { if (window.CNSUnits) CNSUnits.set(u.dataset.u === 'nm' ? 'nautical' : 'metric'); $$('#unitSeg button').forEach(x => x.classList.toggle('on', x === u)); return; }
    const x = e.target.closest('#expDd [data-exp]'); if (x) { $$('.dd').forEach(d => d.classList.remove('open')); runExport(x.dataset.exp, x); return; }
    if (e.target.closest('#kbdHint')) open('');
    if (e.target.closest('[data-cmdk=close]')) close();
  });
  document.addEventListener('change', e => { const t = e.target;
    if (t.classList && t.classList.contains('airport-filter')) { S.allowedTypes = $$('.airport-filter').filter(c => c.checked).map(c => c.value); UI.map.applyVisibility(); saveOpts(); UI.plan.onFormChange(false); }
    if (t.id === 'nrgChargerToggle') { S.showAssets = t.checked; UI.map.drawAssets(); saveOpts(); UI.plan.onFormChange(false); }
    if (t.id === 'fSavedRoutes') { S.showNet = t.checked; UI.map.drawNet(); saveOpts(); }
    if (t.id === 'fAlternates') { S.showAlternates = t.checked; saveOpts(); UI.render(); UI.map.drawAlternates(); }
    if (t.id === 'flightLabelToggle') { S.showLabels = t.checked; saveOpts(); UI.map.drawRoute(false); } });
  function runExport(kind, btn) {
    if (kind === 'xlsx' && window.CNSSpreadsheet) return CNSSpreadsheet.export(btn);
    if (kind === 'share') return UI.share.copyRouteLink();
    if (kind === 'build') return UI.share.copyBuildLink();
    if (kind === 'pdf') return UI.toast('PDF report needs the airport picker — phase 4. Use the classic version for now.');
  }
  // sync the topbar controls to persisted state
  function syncControls() { $$('#mapDd [data-base]').forEach(x => x.classList.toggle('on', x.dataset.base === S.base)); $$('.airport-filter').forEach(c => c.checked = S.allowedTypes.includes(c.value)); $('#nrgChargerToggle').checked = S.showAssets; $('#fSavedRoutes').checked = S.showNet; $('#fAlternates').checked = S.showAlternates; $('#flightLabelToggle').checked = S.showLabels;
    const nm = window.CNSUnits && CNSUnits.isNautical && CNSUnits.isNautical(); $$('#unitSeg button').forEach(x => x.classList.toggle('on', (x.dataset.u === 'nm') === !!nm)); }
  document.addEventListener('DOMContentLoaded', syncControls);
  // ---- header search: fly to ----------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => { const inp = $('#q'), box = $('#qAc');
    inp.addEventListener('input', () => { const l = UI.search(inp.value); box.innerHTML = l.map(a => `<button data-id="${esc(a.ident)}"><span class="id">${esc(a.ident)}</span><span class="nm">${esc(a.name)}<small>${esc(a.municipality || '')}</small></span><span class="ty">${esc((a.type || '').split('_')[0])}</span></button>`).join(''); box.classList.toggle('open', l.length > 0); });
    box.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); inp.value = ''; box.classList.remove('open'); UI.map.flyTo(UI.byId()[b.dataset.id]); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = $('button', box); if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } if (e.key === 'Escape') box.classList.remove('open'); });
    document.addEventListener('mousedown', e => { if (!box.contains(e.target) && e.target !== inp) box.classList.remove('open'); }); });
  // ---- command palette ------------------------------------------------------------
  const CMD = { items: [], hl: 0 };
  function items(q) {
    const ql = (q || '').trim().toLowerCase(); const L = []; const add = (g, label, run, k, sub) => L.push({ g, label, run, k, sub });
    if (ql.length >= 2) UI.search(ql).slice(0, 4).forEach((a, ai) => {
      add('Airports', `<b>${esc(a.ident)}</b> ${esc(a.name)}`, () => UI.map.flyTo(a), 'fly to', esc(a.municipality || ''));
      if (ai > 0) return;
      add('Airports', `Set <b>${esc(a.ident)}</b> as departure`, () => { S.origin = a; UI.setMode('plan'); UI.plan.onFormChange(true); }, 'D');
      add('Airports', `Set <b>${esc(a.ident)}</b> as destination`, () => { S.dest = a; UI.setMode('plan'); UI.plan.onFormChange(true); }, 'A');
      add('Airports', `Add <b>${esc(a.ident)}</b> as a stop`, () => { S.stops.push(a); UI.setMode('plan'); UI.plan.onFormChange(true); }, 'S'); });
    const hit = s => !ql || s.toLowerCase().includes(ql);
    UI.PLANES.filter(p => ql && hit(p.name)).slice(0, 3).forEach(p => add('Aircraft', `Aircraft: ${esc(p.name)}`, () => { S.planeId = p.id; const dc = p.default_charger_id; if (dc && UI.CHARGERS.find(c => c.id === dc)) S.chargerId = dc; UI.setMode('plan'); UI.plan.onFormChange(false); }, '', `${p.range_km} km · ${p.battery_kwh || 0} kWh`));
    UI.CHARGERS.filter(c => ql && hit(c.name)).slice(0, 3).forEach(c => add('Chargers', `Charger: ${esc(c.name)}`, () => { S.chargerId = c.id; UI.setMode('plan'); UI.plan.onFormChange(false); }));
    const A = [
      ['Simulate the current route', () => { UI.setMode('plan'); UI.plan.simulate(); }, '↵'],
      S.result ? ['Add the result to the network', () => UI.plan.addToNetwork()] : null,
      [S.mode === 'network' ? 'Switch to Plan mode' : 'Switch to Network mode', () => UI.setMode(S.mode === 'network' ? 'plan' : 'network'), 'N'],
      ['Basemap: Light', () => $('#mapDd [data-base=light]').click()], ['Basemap: Street', () => $('#mapDd [data-base=street]').click()], ['Basemap: Satellite', () => $('#mapDd [data-base=sat]').click()],
      ['Units: kilometres', () => $('#unitSeg [data-u=km]').click()], ['Units: nautical miles', () => $('#unitSeg [data-u=nm]').click()],
      ['Export demand workbook (XLSX)', () => runExport('xlsx', $('#expBtn')), '⇧X'], ['Share this route', () => runExport('share'), '⇧L'], ['Share the network build', () => runExport('build')],
      ['Reset the route form', () => { UI.setMode('plan'); UI.plan.resetForm(); }],
      ['Open the classic version', () => { location.href = '/?desktop=1'; }],
    ].filter(Boolean).filter(([l]) => hit(l));
    A.slice(0, ql ? 8 : 10).forEach(([l, run, k]) => add('Actions', esc(l), run, k || ''));
    return L.slice(0, 14);
  }
  function renderList() { const list = $('#cmdkList'); if (!CMD.items.length) { list.innerHTML = '<div class="none">Nothing matches. Try an ICAO code, a city, an aircraft or an action.</div>'; return; }
    let g = ''; list.innerHTML = CMD.items.map((it, i) => { const h = it.g !== g ? `<div class="grp">${it.g}</div>` : ''; g = it.g; return `${h}<div class="it ${i === CMD.hl ? 'on' : ''}" data-i="${i}"><span>${it.label}${it.sub ? ` <span class="sub">${it.sub}</span>` : ''}</span>${it.k ? `<span class="k">${it.k}</span>` : ''}</div>`; }).join('');
    const on = list.querySelector('.it.on'); if (on) on.scrollIntoView({ block: 'nearest' }); }
  function open(q) { $('#cmdk').hidden = false; const inp = $('#cmdkIn'); inp.value = q || ''; CMD.items = items(inp.value); CMD.hl = 0; renderList(); inp.focus(); }
  function close() { $('#cmdk').hidden = true; }
  function run(i) { const it = CMD.items[i]; if (!it) return; close(); it.run(); }
  document.addEventListener('DOMContentLoaded', () => {
    $('#cmdkIn').addEventListener('input', e => { CMD.items = items(e.target.value); CMD.hl = 0; renderList(); });
    $('#cmdkIn').addEventListener('keydown', e => { if (e.key === 'ArrowDown') { CMD.hl = Math.min(CMD.items.length - 1, CMD.hl + 1); renderList(); e.preventDefault(); } else if (e.key === 'ArrowUp') { CMD.hl = Math.max(0, CMD.hl - 1); renderList(); e.preventDefault(); } else if (e.key === 'Enter') { run(CMD.hl); e.preventDefault(); } else if (e.key === 'Escape') close(); });
    $('#cmdkList').addEventListener('click', e => { const it = e.target.closest('.it'); if (it) run(+it.dataset.i); });
    $('#cmdkList').addEventListener('mousemove', e => { const it = e.target.closest('.it'); if (it && +it.dataset.i !== CMD.hl) { CMD.hl = +it.dataset.i; renderList(); } }); });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#cmdk').hidden ? open('') : close(); } else if (e.key === 'Escape' && !$('#cmdk').hidden) close(); });
  UI.palette = { open, close, items, syncControls };
})();
