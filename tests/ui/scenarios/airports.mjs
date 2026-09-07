/* Airports: the Departure / Stop / Destination fields + their autocomplete, the header airport search and
   the map popup actions — driven with REAL input (Input.dispatchMouseEvent / dispatchKeyEvent) against the
   classic shell's behaviour (templates/index.html setupAutocomplete 4076–4105, _setupStopAutocomplete
   3508–3546, header search 4213–4256, popup buttons 4286–4290, syncUnset 2693–2697 + submit 5297–5305).
   v2 code under test: static/ui/plan.js bindAc (45–51), renderForm (53–74), the addStop/rmStop actions
   (194–195), simulate (96–115); static/ui/palette.js header search (36–40); static/ui/map.js popupHtml (6–13)
   + window.setOrigin/setDest/setStop (app.js 100–102). */
import fs from 'node:fs';
import path from 'node:path';
import { MOD } from '../cdp.mjs';

export const component = 'airports';
export const module = 'plan';

/** lib.mjs keeps only the first 600 chars of a failing check's message — long v2-vs-classic details go to a sidecar file. */
function note(ctx, name, text) { const f = path.join(ctx.out, name + '.txt'); fs.writeFileSync(f, text + '\n'); return f; }

const NAMES = { EHLE: 'Lelystad Airport', EDDF: 'Frankfurt Main Airport', EDDH: 'Hamburg Helmut Schmidt Airport', EHRD: 'Rotterdam The Hague Airport', EDDM: 'Munich Airport', EDDK: 'Cologne Bonn Airport' };

// ---- helpers the harness lacks (see harnessGaps in the report) ---------------------------------------
/** Real select-all in the focused field: CDP editing command (Meta+A via dispatchKeyEvent does NOT select in headless Chrome). */
async function selectAll(page) {
  const k = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: MOD.Meta };
  await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', commands: ['selectAll'] }, k));
  await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
  const sel = await page.eval(`(function(){ const a = document.activeElement; return a && a.value != null ? { s: a.selectionStart, e: a.selectionEnd, n: a.value.length } : null; })()`);
  if (!sel || sel.s !== 0 || sel.e !== sel.n) throw new Error('selectAll did not select the field text: ' + JSON.stringify(sel));
  return sel;
}
/** State of one route field + its list: focus (by identity tag), open, suggestion ids, highlighted index, ICAO chip. */
const acState = (page, key) => page.eval(`(function(){ const inp = document.querySelector('[data-ac=${key}]'); const box = document.querySelector('#ac-${key}'); const a = document.activeElement;
  const btns = box ? Array.from(box.querySelectorAll('button')) : [];
  const d = e => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.dataset && e.dataset.ac ? '[data-ac=' + e.dataset.ac + ']' : '') + (e.dataset && e.dataset.act ? '[data-act=' + e.dataset.act + ']' : '') : null;
  return { exists: !!inp, focused: !!inp && a === inp, tag: inp ? (inp.__acTag || null) : null, active: d(a), value: inp ? inp.value : null, cls: inp ? inp.className : null,
    open: !!box && box.classList.contains('open'), n: btns.length, first: btns[0] ? btns[0].dataset.id : null, ids: btns.map(b => b.dataset.id),
    hl: btns.findIndex(b => b.classList.contains('hl') || b.classList.contains('active') || b.classList.contains('on')),
    icao: (function(){ const s = inp && inp.parentElement.querySelector('.icao'); return s ? s.textContent.trim() : null; })() }; })()`);
/** Tag the current field element so a re-render (new element) is detectable. */
const tagField = (page, key) => page.eval(`(function(){ const i = document.querySelector('[data-ac=${key}]'); if (!i) return null; i.__acTag = 'tag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); return i.__acTag; })()`);
/** Real click into a route field + select its text (ready to type over). Returns the identity tag. */
async function focusField(page, key) {
  await page.click(`[data-ac=${key}]`);
  const tag = await tagField(page, key);
  await selectAll(page);
  return tag;
}
/** Type `text` over the field's current text (real keys) and wait for the list to settle. */
async function typeInto(page, key, text) {
  const tag = await focusField(page, key);
  await page.type(text);
  await page.sleep(60);
  return { tag, st: await acState(page, key) };
}
/** v2 state snapshot (everything a stray click could change). */
const snapshot = page => page.eval(`(function(){ const S = CNSUI.S; return { o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, stops: S.stops.map(s => s && s.ident), trip: S.trip, freq: S.freq, per: S.per, plane: S.planeId, charger: S.chargerId, picking: S.picking, rail: S.rail, filterOpen: S.acFilterOpen, allChargers: S.allChargers, mode: S.mode, err: S.err }; })()`);
/** Reset the v2 form to a known route through v2's own state API (not the thing under test), re-render, settle the map. */
async function ensureRoute(page, { o = 'EHLE', d = 'EDDF', trip = 'one-way' } = {}) {
  await page.eval(`(function(){ const S = CNSUI.S, by = CNSUI.byId(); S.origin = by[${JSON.stringify(o)}] || null; S.dest = by[${JSON.stringify(d)}] || null; S.stops = []; S.trip = ${JSON.stringify(trip)}; S.err = ''; if (S.blacklist && S.blacklist.clear) S.blacklist.clear(); S.divertOverrides = {}; S.rail = 'form'; S.picking = false; CNSUI.plan.onFormChange(true); return true; })()`);
  await page.closePopups(); await page.waitForMapIdle(5000);
  await page.eval(`(function(){ if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
}
/** A map point a human would call "empty": ≥ 18 px from every drawn airport dot, outside the rail / topbar / drawer /
    DOM marker panes / popups. Scans from the right edge inwards. */
const emptyMapPoint = page => page.eval(`(function(){ const m = CNSUI.map.map, S = CNSUI.S, z = m.getZoom(); const mr = document.getElementById('map').getBoundingClientRect();
  const allowed = (S.allowedTypes || []).filter(t => t !== 'small_airport' || z >= 7.5); const b = m.getBounds(); const pts = [];
  for (const a of CNSUI.airports()) { if (!allowed.includes(a.type)) continue; const ll = L.latLng(a.latitude_deg, a.longitude_deg); if (!b.contains(ll)) continue; const p = m.latLngToContainerPoint(ll); pts.push([mr.left + p.x, mr.top + p.y]); }
  const box = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; }; const rail = box('#rail'), drawer = box('#drawer');
  const inBox = (r, x, y) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  for (let y = 120; y < mr.bottom - 60; y += 40) for (let x = mr.right - 80; x > mr.left + 60; x -= 40) { if (inBox(rail, x, y) || inBox(drawer, x, y)) continue; if (pts.some(p => Math.hypot(p[0] - x, p[1] - y) < 18)) continue;
    const el = document.elementFromPoint(x, y); if (!el || el.closest('.leaflet-marker-pane,.leaflet-popup-pane,.leaflet-pins-pane,.topbar,.rail,.drawer,.cmdk,.modal-v2,.dd')) continue;
    return { x, y, top: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\\s+/)[0] : ''), dots: pts.length }; }
  return null; })()`);
/** Header search: real typing into #q, Enter on the first suggestion, wait for the fly-to popup of `ident`. */
async function headerSearch(page, ident, nameStart) {
  await page.click('#q'); await selectAll(page); await page.type(ident); await page.sleep(60);
  const q = await page.eval(`({ open: document.querySelector('#qAc').classList.contains('open'), first: (document.querySelector('#qAc button') || { dataset: {} }).dataset.id, n: document.querySelectorAll('#qAc button').length })`);
  if (!q.open || q.first !== ident) throw new Error(`#qAc after typing ${ident}: ${JSON.stringify(q)}`);
  const c0 = await page.eval('CNSUI.map.map.getCenter()');
  await page.press('Enter'); await page.sleep(150); await page.waitForMapIdle(9000);
  await page.waitFor(`(function(){ const t = document.querySelector('.leaflet-popup .pp .t span'); return !!t && t.textContent.indexOf(${JSON.stringify(nameStart)}) >= 0; })()`, 4000);
  const after = await page.eval(`(function(){ const m = CNSUI.map.map; const a = CNSUI.byId()[${JSON.stringify(ident)}]; const c = m.getCenter(); return { q: document.querySelector('#q').value, qOpen: document.querySelector('#qAc').classList.contains('open'), zoom: m.getZoom(), dCenterDeg: Math.hypot(c.lat - a.latitude_deg, c.lng - a.longitude_deg), popup: document.querySelector('.leaflet-popup .pp .t span').textContent, popupIcao: (document.querySelector('.leaflet-popup .pp .ic2') || {}).textContent }; })()`);
  return { before: c0, after };
}
/** Real click on a popup action button (Departure | Destination | Stop) and report the popup afterwards. */
async function clickPopupAction(page, label) {
  const sel = `.leaflet-popup .pp .acts button`;
  const i = await page.eval(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).findIndex(b => b.textContent.trim() === ${JSON.stringify(label)})`);
  if (i < 0) throw new Error(`no "${label}" button in the popup`);
  const r = await page.click(`${sel}:nth-of-type(${i + 1})`);
  await page.sleep(120);
  let closed = true; try { await page.waitFor(`!document.querySelector('.leaflet-popup')`, 900, 50); } catch (e) { closed = false; }
  return { rect: r, closed, popupStill: closed ? null : await page.eval(`(function(){ const p = document.querySelector('.leaflet-popup .pp .t span'); return p ? p.textContent : '(popup without .pp)'; })()`) };
}

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  const classic = await ctx.classicPage(v2.browser);
  const R = { retry: 0 };   // every check drives real input with side effects: no silent retries

  // ---- defaults ---------------------------------------------------------------------------------
  await ctx.check('defaults', async () => {
    const st = await v2.eval(`(function(){ const S = CNSUI.S; const f = k => { const i = document.querySelector('[data-ac=' + k + ']'); return i ? { value: i.value, icao: ((i.parentElement.querySelector('.icao') || {}).textContent || '').trim(), placeholder: i.placeholder } : null; };
      return { o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, stops: S.stops.length, trip: S.trip, origin: f('origin'), dest: f('dest'), seed: CNSUI.SEED, acOrigin: !!document.querySelector('#ac-origin'), acDest: !!document.querySelector('#ac-dest') }; })()`);
    const cl = await classic.eval(`({ o: selected.origin && selected.origin.ident, d: selected.destination && selected.destination.ident, oName: document.getElementById('origin').value, dName: document.getElementById('destination').value, lelystad: airportByIdent['EHLE'] && airportByIdent['EHLE'].name, frankfurt: airportByIdent['EDDF'] && airportByIdent['EDDF'].name })`);
    const bad = [];
    if (st.o !== 'EHLE' || st.d !== 'EDDF') bad.push(`S.origin/S.dest = ${st.o}/${st.d}`);
    if (!st.origin || st.origin.value !== cl.lelystad || st.origin.icao !== 'EHLE') bad.push(`origin field ${JSON.stringify(st.origin)} (classic name ${cl.lelystad})`);
    if (!st.dest || st.dest.value !== cl.frankfurt || st.dest.icao !== 'EDDF') bad.push(`dest field ${JSON.stringify(st.dest)} (classic name ${cl.frankfurt})`);
    if (!st.acOrigin || !st.acDest) bad.push('missing #ac-origin/#ac-dest list containers');
    if (st.stops !== 0 || st.trip !== 'one-way') bad.push(`stops ${st.stops} trip ${st.trip}`);
    await ctx.screenshot(v2, 'defaults');
    if (bad.length) throw new Error(bad.join('; '));
    return { detail: `v2 ${st.o} → ${st.d} ("${st.origin.value}" / "${st.dest.value}"), classic fields "${cl.oName}"/"${cl.dName}" (selected ${cl.o}/${cl.d})`, repro: 'open /v2, read CNSUI.S.origin/dest + the [data-ac] inputs', evidence: [ctx.shot('defaults')] };
  }, R);

  // ---- type-keeps-focus: key-by-key typing over the destination -------------------------------
  await ctx.check('type-keeps-focus', async () => {
    await ensureRoute(v2);
    const tag = await focusField(v2, 'dest');
    const steps = [];
    for (const ch of 'ham') {
      await v2.type(ch); await v2.sleep(40);
      const st = await acState(v2, 'dest');
      steps.push({ ch, value: st.value, focused: st.focused, sameEl: st.tag === tag, active: st.active, open: st.open, first: st.first, n: st.n });
    }
    await ctx.screenshot(v2, 'type-keeps-focus-list');
    const bad = [];
    steps.forEach(s => { if (!s.focused || !s.sameEl) bad.push(`after "${s.ch}": focus left the field (activeElement ${s.active}, same element ${s.sameEl})`); });
    steps.filter(s => s.value.length >= 2).forEach(s => { if (!s.open) bad.push(`after "${s.ch}": #ac-dest not open`); if (s.first !== 'EDDH') bad.push(`after "${s.ch}": first suggestion ${s.first}, expected EDDH`); });
    if (steps[0].open) bad.push('list open after a single character (classic needs 2)');
    const last = steps[steps.length - 1]; if (last.value !== 'ham') bad.push(`field value "${last.value}" after typing ham (select-all lost?)`);
    if (bad.length) throw new Error(bad.join('; '));
    await v2.press('Enter');
    await v2.waitFor(`CNSUI.S.dest && CNSUI.S.dest.ident === 'EDDH'`, 3000);
    const after = await acState(v2, 'dest');
    await ctx.screenshot(v2, 'type-keeps-focus-picked');
    const rerendered = after.tag !== tag;
    if (!rerendered || after.value !== NAMES.EDDH || after.icao !== 'EDDH') throw new Error(`after Enter: rail re-rendered=${rerendered}, field "${after.value}" chip ${after.icao} (expected ${NAMES.EDDH} / EDDH)`);
    return { detail: steps.map(s => `${s.ch}: focus ${s.focused ? 'kept' : 'LOST'}, list ${s.open ? 'open(' + s.n + ') first ' + s.first : 'closed'}`).join(' · ') + ` → Enter: S.dest EDDH, rail re-rendered, field "${after.value}" ${after.icao}, focus after render: ${after.active}`, repro: 'node tests/ui/run.mjs airports --only type-keeps-focus', evidence: [ctx.shot('type-keeps-focus-list'), ctx.shot('type-keeps-focus-picked')] };
  }, R);

  // ---- arrow keys move the highlight, Enter picks the highlighted row (classic keydown 4092–4101) -----
  await ctx.check('arrow-keys-pick-highlighted', async () => {
    await ensureRoute(v2);
    const { st } = await typeInto(v2, 'dest', 'rott');
    if (!st.open || st.n < 2) throw new Error('precondition: list not open with ≥ 2 rows: ' + JSON.stringify(st));
    await v2.press('ArrowDown'); await v2.press('ArrowDown'); await v2.sleep(40);
    const hl = await acState(v2, 'dest');
    await ctx.screenshot(v2, 'arrow-keys');
    await v2.press('Enter');
    await v2.sleep(250);
    const d = await v2.eval(`CNSUI.S.dest && CNSUI.S.dest.ident`);
    const want = st.ids[1];
    // control: the same keys in the classic destination field (setupAutocomplete keydown, index.html:4092–4101)
    await classic.click('#destination'); await selectAll(classic); await classic.type('rott'); await classic.sleep(80);
    const cIds = await classic.eval(`Array.from(document.querySelectorAll('#destinationList .ac-item small')).map(s => s.textContent.split(' · ')[0])`);
    await classic.press('ArrowDown'); await classic.press('ArrowDown'); await classic.sleep(40);
    const cHl = await classic.eval(`Array.from(document.querySelectorAll('#destinationList .ac-item')).findIndex(i => i.classList.contains('active'))`);
    await classic.press('Enter'); await classic.sleep(120);
    const cPick = await classic.eval(`({ d: selected.destination && selected.destination.ident, listHidden: document.getElementById('destinationList').classList.contains('d-none'), focused: document.activeElement === document.getElementById('destination') })`);
    await ctx.screenshot(classic, 'arrow-keys-classic');
    await classic.eval(`window.setDest('EDDF'); true`);
    const control = `classic: rows ${cIds.slice(0, 3).join(',')}…, ArrowDown ×2 → .active row ${cHl}, Enter → ${cPick.d} (list hidden ${cPick.listHidden}, field focused ${cPick.focused})`;
    if (hl.hl !== 1 || d !== want) throw new Error(`v2: ArrowDown ×2 highlighted row ${hl.hl}, Enter picked ${d} — expected row 1 = ${want} (rows ${st.ids.join(',')}); plan.js:48 handles only Escape/Enter and Enter always takes the first button. ${control}`);
    return { detail: `rows ${st.ids.join(',')}; ArrowDown ×2 → row ${hl.hl}; Enter → ${d}. ${control}`, repro: 'node tests/ui/run.mjs airports --only arrow-keys', evidence: [ctx.shot('arrow-keys'), ctx.shot('arrow-keys-classic')] };
  }, R);

  // ---- mouse-pick: a REAL click on the first suggestion --------------------------------------------
  await ctx.check('mouse-pick', async () => {
    await ensureRoute(v2);
    const { st } = await typeInto(v2, 'dest', 'rotter');
    if (!st.open || st.first !== 'EHRD') throw new Error('precondition: list after "rotter" ' + JSON.stringify({ open: st.open, first: st.first, ids: st.ids }));
    const before = await snapshot(v2);
    await v2.eval(`(function(){ __cns.clicks = []; if (!__cns.clickHook) { __cns.clickHook = true; document.addEventListener('click', e => { const t = e.target; __cns.clicks.push((t.tagName || '?').toLowerCase() + (t.id ? '#' + t.id : '') + (t.dataset && t.dataset.act ? '[data-act=' + t.dataset.act + ']' : '') + (t.dataset && t.dataset.ac ? '[data-ac=' + t.dataset.ac + ']' : '')); }, true); } return true; })()`);
    const r = await v2.click('#ac-dest button:first-child');
    await v2.waitFor(`CNSUI.S.dest && CNSUI.S.dest.ident === 'EHRD'`, 3000);
    await v2.sleep(150);
    const after = await snapshot(v2); const clicks = await v2.eval('__cns.clicks.slice()');
    const field = await acState(v2, 'dest');
    await ctx.screenshot(v2, 'mouse-pick');
    const diff = Object.keys(before).filter(k => k !== 'd' && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (diff.length) throw new Error(`the pick changed unrelated state ${diff.map(k => k + ': ' + JSON.stringify(before[k]) + '→' + JSON.stringify(after[k])).join(', ')} (click targets ${JSON.stringify(clicks)})`);
    if (field.open || field.value !== NAMES.EHRD || field.icao !== 'EHRD') throw new Error(`after the pick: list open=${field.open}, field "${field.value}" ${field.icao}`);
    return { detail: `real click at (${r.cx.toFixed(0)},${r.cy.toFixed(0)}) top=${r.topTag} covered=${r.covered} → S.dest EHRD, field "${field.value}", click events reaching the document: ${JSON.stringify(clicks)}`, repro: 'node tests/ui/run.mjs airports --only mouse-pick', evidence: [ctx.shot('mouse-pick')] };
  }, R);

  // ---- pick-keeps-focus: after a keyboard pick the caret stays in the field (classic pickAirport only swaps the value) ----
  await ctx.check('pick-keeps-focus', async () => {
    await ensureRoute(v2);
    const { st } = await typeInto(v2, 'dest', 'rotter');
    if (!st.open || st.first !== 'EHRD') throw new Error('precondition ' + JSON.stringify({ open: st.open, first: st.first }));
    await v2.press('Enter');
    await v2.waitFor(`CNSUI.S.dest && CNSUI.S.dest.ident === 'EHRD'`, 3000); await v2.sleep(80);
    const after = await acState(v2, 'dest');
    // control: classic — type, ArrowDown, Enter (its Enter needs a highlighted row), read activeElement
    await classic.click('#destination'); await selectAll(classic); await classic.type('rotter'); await classic.sleep(80);
    await classic.press('ArrowDown'); await classic.press('Enter'); await classic.sleep(120);
    const cl = await classic.eval(`({ d: selected.destination && selected.destination.ident, focused: document.activeElement === document.getElementById('destination'), active: document.activeElement && document.activeElement.id })`);
    await classic.eval(`window.setDest('EDDF'); true`);
    const control = `classic: Enter-pick → selected.destination ${cl.d}, #destination still focused=${cl.focused} (activeElement #${cl.active})`;
    if (!after.focused) throw new Error(`v2: after the Enter pick focus is on ${after.active} (the rail re-render in onFormChange → UI.render drops the caret) — the next Tab restarts at the top of the document. ${control}`);
    return { detail: `v2: Enter-pick → S.dest EHRD, field focused=${after.focused}. ${control}`, repro: 'node tests/ui/run.mjs airports --only pick-keeps-focus' };
  }, R);

  // ---- blur-closes: click the map while the list is open ------------------------------------------
  await ctx.check('blur-closes', async () => {
    await ensureRoute(v2);
    const { st } = await typeInto(v2, 'dest', 'rotter');
    if (!st.open) throw new Error('precondition: list not open ' + JSON.stringify(st));
    const pt = await emptyMapPoint(v2); if (!pt) throw new Error('no empty map point found');
    const before = await snapshot(v2);
    await v2.clickAt(pt.x, pt.y); await v2.sleep(300);
    const after = await acState(v2, 'dest'); const snap = await snapshot(v2);
    await ctx.screenshot(v2, 'blur-closes');
    if (after.open) throw new Error(`list still open after a real click on the map at (${pt.x},${pt.y}) top=${pt.top}`);
    if (snap.d !== before.d) throw new Error(`destination changed ${before.d} → ${snap.d} by clicking the map`);
    return { detail: `map click at (${pt.x},${pt.y}) top=${pt.top} (${pt.dots} dots in view) → list closed, S.dest ${snap.d} unchanged, field text "${after.value}" with ICAO chip "${after.icao}" focused=${after.focused} cls="${after.cls}" (classic: blur hides the list and flags the unmatched text with .ac-unset; see typed-over-airport)`, repro: 'node tests/ui/run.mjs airports --only blur-closes', evidence: [ctx.shot('blur-closes')] };
  }, R);

  // ---- escape-closes-list ---------------------------------------------------------------------------
  await ctx.check('escape-closes-list', async () => {
    await ensureRoute(v2);
    const { st } = await typeInto(v2, 'dest', 'rotter');
    if (!st.open) throw new Error('precondition: list not open ' + JSON.stringify(st));
    await v2.press('Escape'); await v2.sleep(120);
    const after = await acState(v2, 'dest'); const snap = await snapshot(v2);
    const modal = await v2.eval(`({ modal: !document.getElementById('modal').hidden, cmdk: !document.getElementById('cmdk').hidden })`);
    if (after.open) throw new Error('list still open after Escape');
    if (!after.focused) throw new Error(`focus left the field after Escape (activeElement ${after.active}; classic keeps it)`);
    if (snap.d !== 'EDDF') throw new Error(`Escape changed the destination to ${snap.d}`);
    return { detail: `Escape → list closed, field still focused with "${after.value}", S.dest ${snap.d}, modal/cmdk ${JSON.stringify(modal)}`, repro: 'node tests/ui/run.mjs airports --only escape-closes-list' };
  }, R);

  // ---- tab-blur-closes: keyboard blur (classic: input blur → list hidden after 150 ms) -------------
  await ctx.check('tab-blur-closes', async () => {
    await ensureRoute(v2);
    const { st } = await typeInto(v2, 'dest', 'rotter');
    if (!st.open) throw new Error('precondition: list not open ' + JSON.stringify(st));
    await v2.press('Tab'); await v2.sleep(350);
    const after = await acState(v2, 'dest');
    await ctx.screenshot(v2, 'tab-blur');
    // control: classic #destination — type, Tab, list hidden after the 150 ms blur timer (index.html:4104)
    await classic.click('#destination'); await selectAll(classic); await classic.type('rotter'); await classic.sleep(80);
    const c0 = await classic.eval(`!document.getElementById('destinationList').classList.contains('d-none')`);
    await classic.press('Tab'); await classic.sleep(350);
    const c1 = await classic.eval(`({ open: !document.getElementById('destinationList').classList.contains('d-none'), focused: document.activeElement === document.getElementById('destination'), unset: document.getElementById('destination').classList.contains('ac-unset') })`);
    await ctx.screenshot(classic, 'tab-blur-classic');
    await classic.eval(`window.setDest('EDDF'); true`);
    const control = `classic: list open before Tab=${c0}, after Tab open=${c1.open} focused=${c1.focused} .ac-unset=${c1.unset}`;
    if (after.focused) throw new Error('Tab did not move the focus (activeElement ' + after.active + ')');
    if (after.open) throw new Error(`v2: focus moved to ${after.active} but #ac-dest is still open 350 ms after the blur — bindAc (plan.js:45–51) has no blur handler, only a document mousedown. ${control}`);
    return { detail: `Tab → focus on ${after.active}, list closed. ${control}`, repro: 'node tests/ui/run.mjs airports --only tab-blur-closes', evidence: [ctx.shot('tab-blur'), ctx.shot('tab-blur-classic')] };
  }, R);

  // ---- add-stop-focus ---------------------------------------------------------------------------------
  await ctx.check('add-stop-focus', async () => {
    await ensureRoute(v2);
    await v2.click('[data-act=addStop]');
    let focused = true; try { await v2.waitFor(`CNSUI.S.stops.length === 1 && document.activeElement === document.querySelector('[data-ac=stop0]')`, 1500, 40); } catch (e) { focused = false; }
    const st0 = await acState(v2, 'stop0');
    if (!st0.exists) throw new Error('no [data-ac=stop0] input after + Add stop (S.stops ' + JSON.stringify(await v2.eval('CNSUI.S.stops')) + ')');
    if (!focused) throw new Error(`the new stop input is not focused (activeElement ${st0.active})`);
    await tagField(v2, 'stop0');
    await v2.type('EHRD'); await v2.sleep(60);
    const typed = await acState(v2, 'stop0');
    if (!typed.open || typed.first !== 'EHRD') throw new Error('stop list after typing EHRD: ' + JSON.stringify({ open: typed.open, first: typed.first, ids: typed.ids }));
    await ctx.screenshot(v2, 'add-stop-list');
    await v2.press('Enter');
    await v2.waitFor(`CNSUI.S.stops.length === 1 && CNSUI.S.stops[0] && CNSUI.S.stops[0].ident === 'EHRD'`, 3000);
    const after = await v2.eval(`(function(){ const i = document.querySelector('[data-ac=stop0]'); return { value: i && i.value, icao: i && ((i.parentElement.querySelector('.icao') || {}).textContent || '').trim(), wp: !!(i && i.parentElement.classList.contains('wp')), rows: document.querySelectorAll('#railBody .route .stop').length, rowIdents: Array.from(document.querySelectorAll('#railBody .route .stop .d')).map(e => e.textContent.trim()), chain: CNSUI.chain().map(a => a.ident) }; })()`);
    await ctx.screenshot(v2, 'add-stop-picked');
    if (after.value !== NAMES.EHRD || after.icao !== 'EHRD') throw new Error(`stop field after Enter: "${after.value}" ${after.icao}`);
    if (JSON.stringify(after.chain) !== JSON.stringify(['EHLE', 'EHRD', 'EDDF'])) throw new Error('chain after the stop: ' + JSON.stringify(after.chain));
    await v2.click('[data-act=rmStop]');
    await v2.waitFor(`CNSUI.S.stops.length === 0 && !document.querySelector('[data-ac=stop0]')`, 3000);
    const chain = await v2.eval('CNSUI.chain().map(a => a.ident)');
    if (JSON.stringify(chain) !== JSON.stringify(['EHLE', 'EDDF'])) throw new Error('chain after removing the stop: ' + JSON.stringify(chain));
    return { detail: `+ Add stop → [data-ac=stop0] focused; EHRD + Enter → S.stops[0] EHRD, field "${after.value}", route rows ${after.rows} (${after.rowIdents.join(' | ')}), chain ${after.chain.join('→')}; × → stops 0, chain ${chain.join('→')}`, repro: 'node tests/ui/run.mjs airports --only add-stop-focus', evidence: [ctx.shot('add-stop-list'), ctx.shot('add-stop-picked')] };
  }, R);

  // ---- header-search → fly-to popup → Destination button -------------------------------------------
  await ctx.check('header-search', async () => {
    await ensureRoute(v2);
    const hs = await headerSearch(v2, 'EDDM', 'Munich');
    await ctx.screenshot(v2, 'header-search-popup');
    if (hs.after.dCenterDeg > 0.5) throw new Error(`map did not fly to EDDM (centre ${hs.after.dCenterDeg.toFixed(2)}° away, zoom ${hs.after.zoom})`);
    const act = await clickPopupAction(v2, 'Destination');
    await v2.waitFor(`CNSUI.S.dest && CNSUI.S.dest.ident === 'EDDM'`, 3000);
    const field = await acState(v2, 'dest');
    await ctx.screenshot(v2, 'header-search-after-destination');
    // control: the classic header search → .ap-card popup → real click on its Destination button
    await classic.click('#airportSearch'); await selectAll(classic); await classic.type('EDDM'); await classic.sleep(80);
    await classic.press('Enter'); await classic.sleep(1200);
    await classic.waitFor(`(function(){ const n = document.querySelector('.leaflet-popup .ap-card-name'); return !!n && n.textContent.indexOf('Munich') >= 0; })()`, 4000);
    const cBtn = await classic.click('.leaflet-popup .ap-card-btn:nth-of-type(2)');
    await classic.sleep(300);
    const cl = await classic.eval(`({ d: selected.destination && selected.destination.ident, popup: !!document.querySelector('.leaflet-popup'), field: document.getElementById('destination').value })`);
    await ctx.screenshot(classic, 'header-search-classic');
    await classic.eval(`window.setDest('EDDF'); true`);
    const control = `classic: #airportSearch "EDDM" + Enter → .ap-card popup; real click on Destination at (${cBtn.cx.toFixed(0)},${cBtn.cy.toFixed(0)}) → selected.destination ${cl.d}, popup still in the DOM=${cl.popup}`;
    const detail = `#q "EDDM" + Enter → #q "${hs.after.q}", map centre ${hs.after.dCenterDeg.toFixed(3)}° from EDDM at zoom ${hs.after.zoom}, popup "${hs.after.popup}" (${(hs.after.popupIcao || '').trim()}); real click on Destination at (${act.rect.cx.toFixed(0)},${act.rect.cy.toFixed(0)}) → S.dest EDDM, field "${field.value}" ${field.icao}; popup closed=${act.closed}. ${control}`;
    if (!act.closed) { const f = note(ctx, 'header-search-detail', detail); throw new Error(`v2: S.dest EDDM set, but the popup stays open after the real Destination click (shows "${act.popupStill}"); classic: selected.destination ${cl.d}, popup left in the DOM=${cl.popup}. Cause: map.js:12 buttons only call setDest() and app.js:101 window.setDest never closes the popup (classic 2716–2720 closes it in setOrigin/setDest, card buttons 4287–4289 also call closeAirportCard()). Full detail: ${f}`); }
    return { detail, repro: 'node tests/ui/run.mjs airports --only header-search', evidence: [ctx.shot('header-search-popup'), ctx.shot('header-search-after-destination'), ctx.shot('header-search-classic')] };
  }, R);

  // ---- the other two popup actions (state only; the popup-close gap is reported by header-search) ---
  await ctx.check('popup-departure-button', async () => {
    await ensureRoute(v2);
    const hs = await headerSearch(v2, 'EDDK', 'Cologne');
    const act = await clickPopupAction(v2, 'Departure');
    await v2.waitFor(`CNSUI.S.origin && CNSUI.S.origin.ident === 'EDDK'`, 3000);
    const field = await acState(v2, 'origin'); const snap = await snapshot(v2);
    await ctx.screenshot(v2, 'popup-departure');
    if (field.value !== NAMES.EDDK || field.icao !== 'EDDK' || snap.d !== 'EDDF') throw new Error(`origin field "${field.value}" ${field.icao}, dest ${snap.d}`);
    return { detail: `popup "${hs.after.popup}" → Departure → S.origin EDDK, field "${field.value}", chain ${snap.o}→${snap.d}; popup closed=${act.closed}`, repro: 'node tests/ui/run.mjs airports --only popup-departure-button', evidence: [ctx.shot('popup-departure')] };
  }, R);
  await ctx.check('popup-stop-button', async () => {
    await ensureRoute(v2);
    const hs = await headerSearch(v2, 'EHRD', 'Rotterdam');
    const act = await clickPopupAction(v2, 'Stop');
    await v2.waitFor(`CNSUI.S.stops.length === 1 && CNSUI.S.stops[0] && CNSUI.S.stops[0].ident === 'EHRD'`, 3000);
    const st = await v2.eval(`({ chain: CNSUI.chain().map(a => a.ident), field: (document.querySelector('[data-ac=stop0]') || {}).value || null })`);
    await ctx.screenshot(v2, 'popup-stop');
    if (JSON.stringify(st.chain) !== JSON.stringify(['EHLE', 'EHRD', 'EDDF']) || st.field !== NAMES.EHRD) throw new Error(JSON.stringify(st));
    return { detail: `popup "${hs.after.popup}" → Stop → S.stops[0] EHRD, stop field "${st.field}", chain ${st.chain.join('→')}; popup closed=${act.closed}`, repro: 'node tests/ui/run.mjs airports --only popup-stop-button', evidence: [ctx.shot('popup-stop')] };
  }, R);

  // ---- training-hides-dest -----------------------------------------------------------------------------
  await ctx.check('training-hides-dest', async () => {
    await ensureRoute(v2);
    await v2.click('[data-seg=trip] button[data-v=training]');
    await v2.waitFor(`CNSUI.S.trip === 'training'`, 2000);
    const st = await v2.eval(`({ dest: !!document.querySelector('[data-ac=dest]'), acDest: !!document.querySelector('#ac-dest'), origin: !!document.querySelector('[data-ac=origin]'), addStop: !!document.querySelector('[data-act=addStop]'), hint: (document.querySelector('[data-seg=trip] + .hint') || {}).textContent || '' })`);
    await ctx.screenshot(v2, 'training');
    await classic.eval(`(function(){ document.querySelector('.trip-seg-btn[data-trip=training]').click(); return true; })()`);
    await classic.sleep(150);
    const cl = await classic.eval(`(function(){ const f = document.getElementById('destinationField'); return { trip: document.getElementById('tripType').value, destHidden: !f || f.classList.contains('d-none') || getComputedStyle(f).display === 'none' }; })()`);
    // restore both shells
    await v2.click('[data-seg=trip] button[data-v=one-way]'); await v2.waitFor(`CNSUI.S.trip === 'one-way' && !!document.querySelector('[data-ac=dest]')`, 2000);
    await classic.eval(`(function(){ document.querySelector('.trip-seg-btn[data-trip="one-way"]').click(); return true; })()`);
    if (st.dest || st.acDest) throw new Error('training trip still renders the destination field');
    if (!st.origin) throw new Error('departure field missing in training');
    if (!cl.destHidden) throw new Error('control: the classic did not hide #destinationField for training (' + JSON.stringify(cl) + ')');
    return { detail: `training: [data-ac=dest] absent, departure present, hint "${st.hint.trim()}"; classic hides #destinationField=${cl.destHidden}; both restored to one-way`, repro: 'node tests/ui/run.mjs airports --only training-hides-dest', evidence: [ctx.shot('training')] };
  }, R);

  // ---- typed-over-airport: text typed over a chosen airport without picking, then Simulate ------------
  await ctx.check('typed-over-airport', async () => {
    await ensureRoute(v2);
    await focusField(v2, 'origin');
    await v2.press('Backspace'); await v2.sleep(40);
    const cleared = await acState(v2, 'origin');
    if (cleared.value !== '') throw new Error('Backspace over the selection did not clear the field: ' + JSON.stringify(cleared.value));
    await v2.type('EDDK'); await v2.sleep(60);
    const typed = await acState(v2, 'origin');
    if (!typed.open || typed.first !== 'EDDK') throw new Error('list after typing EDDK: ' + JSON.stringify({ open: typed.open, first: typed.first }));
    const mid = await snapshot(v2);
    await ctx.screenshot(v2, 'typed-over-before-simulate');
    const since = v2.responses.length;
    await v2.click('[data-act=simulate]');
    await v2.waitFor(`(CNSUI.S.rail === 'result' && !!CNSUI.S.profile) || !!CNSUI.S.err`, 20000, 100);
    const res = await v2.eval(`(function(){ const S = CNSUI.S; const o = document.querySelector('[data-ac=origin]'); return { rail: S.rail, err: S.err, origin: S.origin && S.origin.ident, resultOrigin: S.result && S.result._origin && S.result._origin.ident, apiOrigin: S.result && S.result.origin && (S.result.origin.ident || S.result.origin.name), field: o ? o.value : null, fieldCls: o ? o.className : null, title: (document.querySelector('#railBody .rh2 .ttl') || {}).textContent || null }; })()`);
    const simCall = v2.responses.slice(since).find(r => r.url.includes('/api/simulate'));
    await ctx.screenshot(v2, 'typed-over-after-simulate');
    // control: the classic unsets the airport on input and refuses to simulate
    await classic.click('#origin'); await selectAll(classic); await classic.press('Backspace'); await classic.type('EDDK'); await classic.sleep(80);
    const cl0 = await classic.eval(`({ selectedOrigin: selected.origin && selected.origin.ident, field: document.getElementById('origin').value, listOpen: !document.getElementById('originList').classList.contains('d-none') })`);
    const clSim = await ctx.classicSimulate(classic);
    const cl1 = await classic.eval(`({ unset: document.getElementById('origin').classList.contains('ac-unset'), selectedOrigin: selected.origin && selected.origin.ident })`);
    await ctx.screenshot(classic, 'typed-over-classic');
    const classicDetail = `classic: typing over Departure → selected.origin=${cl0.selectedOrigin} (list open ${cl0.listOpen}); Simulate → error "${clSim.error}", #origin.ac-unset=${cl1.unset}`;
    const usedStale = res.resultOrigin === 'EHLE' || (res.rail === 'result' && res.origin === 'EHLE');
    const detail = `v2: field "${mid.o ? typed.value : ''}" over S.origin ${mid.o}; Simulate → rail ${res.rail}, err "${res.err}", S.origin ${res.origin}, result origin ${res.resultOrigin}, POST /api/simulate ${simCall ? simCall.status : 'not sent'}, title "${res.title}", field now "${res.field}" cls "${res.fieldCls}". ${classicDetail}`;
    if (usedStale) { const f = note(ctx, 'typed-over-airport-detail', detail); throw new Error(`v2 silently simulated from the stale airport EHLE while the Departure field read "EDDK": POST /api/simulate ${simCall ? simCall.status : 'not sent'}, result title "${res.title}", S.err "${res.err}"; classic: selected.origin=${cl0.selectedOrigin} after typing, Simulate → error "${clSim.error}", #origin.ac-unset=${cl1.unset}. Cause: plan.js:46 never clears S.origin on input and simulate() (96–103) reads S.origin (classic 4085 sets selected[field]=null; 5297–5305 refuses + syncUnset). Full detail: ${f}`); }
    if (!(res.err && !res.resultOrigin) && res.origin !== 'EDDK') throw new Error('neither an error nor EDDK: ' + detail);
    return { detail, repro: 'node tests/ui/run.mjs airports --only typed-over-airport', evidence: [ctx.shot('typed-over-before-simulate'), ctx.shot('typed-over-after-simulate'), ctx.shot('typed-over-classic')] };
  }, R);

  // ---- listener leak: bindAc registers a document mousedown listener per input per render (plan.js:50) ----
  await ctx.check('listener-leak-per-render', async () => {
    await ensureRoute(v2);
    const r = await v2.eval(`(function(){ const orig = document.addEventListener; let n = 0; document.addEventListener = function (t, f, o) { if (t === 'mousedown') n++; return orig.call(this, t, f, o); };
      try { for (let i = 0; i < 5; i++) CNSUI.render(); } finally { document.addEventListener = orig; } return { mousedownListenersAddedBy5Renders: n, inputs: document.querySelectorAll('[data-ac]').length }; })()`);
    if (r.mousedownListenersAddedBy5Renders >= 5) throw new Error(`${r.mousedownListenersAddedBy5Renders} document mousedown listeners registered by 5 rail renders (${r.inputs} [data-ac] inputs per render) — they are never removed (plan.js:50); the classic wires each static input once (index.html:4076)`);
    return { detail: JSON.stringify(r), repro: 'node tests/ui/run.mjs airports --only listener-leak' };
  }, R);

  // ---- no exceptions anywhere ----------------------------------------------------------------------
  await ctx.check('no-exceptions', async () => {
    const ex = [...ctx.exceptions(v2), ...ctx.exceptions(classic)];
    if (ex.length) throw new Error(ex.map(e => `${e.text} @ ${e.url}`).join(' || '));
    return `v2 errors ${v2.errors.length}, classic errors ${classic.errors.length}, exceptions 0 (known classic ones filtered)`;
  }, R);
}
