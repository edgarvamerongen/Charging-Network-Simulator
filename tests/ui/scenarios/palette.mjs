/* Palette (⌘K command palette, static/ui/palette.js) — open/close/focus (⌘K, Escape, #kbdHint, dim click, from the
   header search), keyboard bounds + hover + query filtering, the default action list + keyboard run, airport items
   (departure / destination / stop / fly-to / Isolate-only-in-network / Show all), aircraft items (sub-labels, battery-less
   rows, OEM search, units, default charger, photo), charger items, and the actions (units, basemap, scenario, reset,
   settings, mode switch, simulate + add, timeline lanes, report picker, share link, XLSX on an empty network, classic
   hand-off) with the classic shell (second tab, same profile) as the behavioural control. The tour item is asserted to
   exist and is NEVER run: CNSUI.tour.start is replaced by a counting spy before the first check.

   Run: node tests/ui/run.mjs palette [--only <check>]   (check names below; --only is a substring filter).
   Every check re-establishes its own preconditions so --only works on any of them. On a loaded host the classic
   CONTROL tab starves headless Chrome in one long run (see renderer-stalls + the report's harnessGaps); running the
   checks as --only slices (one fresh Chrome each) is reliable — the 2026-09-07 report was produced that way. */
import { MOD, Page } from '../cdp.mjs';
export const component = 'palette';
export const module = 'shell';

const j = v => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------
// Helpers the harness lacks (reported under harnessGaps):
//  * a palette state reader (visible / focused / rendered items with their group, label, sub-label, shortcut, highlight)
//  * openPal / query / runItem — real ⌘K (Input.dispatchKeyEvent with Meta), real typing, ArrowDown×n + Enter
//  * tourSpy — replaces CNSUI.tour.start/welcome with counters so the tour can never start from this scenario
//  * classic state reader for units / basemap / folder / form defaults (shell.mjs has its own, not exported)
const PAL_STATE = `(function(){ var k = document.getElementById('cmdk'), inp = document.getElementById('cmdkIn'); var cs = getComputedStyle(k);
  var items = [].slice.call(document.querySelectorAll('#cmdkList .it')).map(function (e) { var c = e.firstElementChild ? e.firstElementChild.cloneNode(true) : e.cloneNode(true); var s = c.querySelector('.sub'); if (s) s.remove();
    var grp = null; var p = e.previousElementSibling; while (p) { if (p.classList.contains('grp')) { grp = p.textContent.trim(); break; } p = p.previousElementSibling; }
    return { i: +e.dataset.i, on: e.classList.contains('on'), g: grp, label: c.textContent.replace(/\\s+/g, ' ').trim(), sub: (e.querySelector('.sub') || { textContent: '' }).textContent.trim(), k: (e.querySelector('.k') || { textContent: '' }).textContent.trim() }; });
  var box = document.querySelector('.cmdk-box'); var r = box ? box.getBoundingClientRect() : null;
  return { hidden: k.hidden, display: cs.display, visible: !k.hidden && cs.display !== 'none', focused: document.activeElement === inp, active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    value: inp.value, items: items, groups: [].slice.call(document.querySelectorAll('#cmdkList .grp')).map(function (e) { return e.textContent.trim(); }), none: !!document.querySelector('#cmdkList .none'),
    box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null }; })()`;
const V2_STATE = `(function(){ var S = CNSUI.S; var oi = document.querySelector('#railBody [data-ac=origin]'); var c = CNSUI.map.map.getCenter();
  var mo = {}; try { mo = JSON.parse(localStorage.getItem('cns_map_options') || '{}'); } catch (e) {}
  return { o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, stops: S.stops.filter(Boolean).map(function (a) { return a.ident; }), plane: S.planeId, charger: S.chargerId, chargerObj: CNSUI.charger().id, trip: S.trip, freq: S.freq, per: S.per,
    mode: S.mode, rail: S.rail, base: S.base, filter: S.filter, lanes: S.lanes, result: !!S.result, err: S.err || '', bodyNet: document.body.classList.contains('net'), railWide: document.querySelector('#rail').classList.contains('wide'),
    drawer: document.querySelector('#drawer').classList.contains('open'), modal: !document.querySelector('#modal').hidden, ms: !!document.querySelector('#modalBox .ms'), msRows: document.querySelectorAll('#modalBox .msr').length,
    msTitle: ((document.querySelector('#modalBox .mh h3') || {}).textContent || '').trim(), msSliders: document.querySelectorAll('#modalBox input[type=range]').length, activeTag: document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.type || '') : null,
    netCount: ((document.querySelector('#netCount') || {}).textContent || '').trim(), folder: window.CNSDemand ? CNSDemand.loadFolder().length : null, apRows: [].slice.call(document.querySelectorAll('#railBody .ap')).map(function (e) { return e.dataset.ap; }),
    openAp: Object.keys(S.openAp || {}).filter(function (k) { return S.openAp[k]; }), units: localStorage.getItem('cns_units'), unitsGet: window.CNSUnits ? CNSUnits.get() : null, mapOpts: mo,
    baseOn: [].slice.call(document.querySelectorAll('#mapDd [data-base].on')).map(function (b) { return b.dataset.base; }), unitOn: [].slice.call(document.querySelectorAll('#unitSeg button.on')).map(function (b) { return b.dataset.u; }),
    tiles: Object.values(CNSUI.map.map._layers).filter(function (l) { return l instanceof L.TileLayer; }).map(function (l) { return l._url; }),
    originInput: oi ? oi.value : null, originIcao: oi && oi.nextElementSibling ? oi.nextElementSibling.textContent.trim() : null, routeD: [].slice.call(document.querySelectorAll('#railBody .route .stop .d')).map(function (e) { return e.textContent.trim(); }),
    tourCalls: (window.__cns && __cns.tourCalls) || 0, driver: !!document.querySelector('.driver-popover, .driver-overlay, .driver-active'), center: [c.lat, c.lng], zoom: CNSUI.map.map.getZoom(),
    popup: ((document.querySelector('.leaflet-popup .pp .ic2') || {}).textContent || '').trim(), toast: ((document.querySelector('#toast') || {}).textContent || '').trim(), toastShown: !!document.querySelector('#toast.show'),
    laneOn: [].slice.call(document.querySelectorAll('#laneSeg button.on')).map(function (b) { return b.dataset.lanes; }), drawerSub: ((document.querySelector('#drawerSub') || {}).textContent || '').trim(),
    modalTitle: ((document.querySelector('#modalBox .mh h3') || {}).textContent || '').trim(), rpRadios: document.querySelectorAll('#modalBox input[name=rp]').length,
    alerts: (window.__cns && __cns.alerts.slice(-2)) || [], clipN: (window.__cns && __cns.clip.length) || 0, clip: (window.__cns && __cns.clip[__cns.clip.length - 1]) || null,
    stageBg: (function () { var s = document.querySelector('#railBody .ac-stage'); return s ? getComputedStyle(s).backgroundImage : null; })(), planeImage: CNSUI.plane().image || null, planeImageUrl: CNSUI.plane().image_url || null }; })()`;
const CLASSIC_STATE = `(function(){ var v = function (id) { var e = document.getElementById(id); return e ? e.value : null; }; var bm = document.querySelector('.seg-btn[data-basemap].active');
  var mo = {}; try { mo = JSON.parse(localStorage.getItem('cns_map_options') || '{}'); } catch (e) {}
  return { o: selected.origin && selected.origin.ident, oName: selected.origin && selected.origin.name, d: selected.destination && selected.destination.ident, stops: [].slice.call(document.querySelectorAll('#stopsContainer .stop-input')).map(function (i) { return i.dataset.ident; }).filter(Boolean),
    plane: v('plane'), charger: v('charger'), trip: v('tripType'), freqN: v('freqN'), freqUnit: v('freqUnit'), units: CNSUnits.get(), unitToggle: !!(document.getElementById('unitToggle') || {}).checked, psRange: ((document.getElementById('psRange') || {}).textContent || '').trim(),
    basemap: bm ? bm.dataset.basemap : null, mapOpts: mo, folder: CNSDemand.loadFolder().length, airports: Object.keys(computeAirports()), folderText: ((document.getElementById('folder') || {}).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    airportFilter: [].slice.call(document.querySelectorAll('#airportFilter option')).map(function (o) { return o.value; }) }; })()`;
const optText = (sel, val) => `(function(){ var o = document.querySelector(${j(sel)} + ' option[value=' + ${j(JSON.stringify(val))} + ']'); return o ? o.textContent.trim() : null; })()`;

const HIDDEN = `document.getElementById('cmdk').hidden`;
const OPEN_FOCUSED = `!document.getElementById('cmdk').hidden && document.activeElement === document.getElementById('cmdkIn')`;
const pal = page => page.eval(PAL_STATE);
const v2s = page => page.eval(V2_STATE);
async function tourSpy(page) {
  return page.eval(`(function(){ __cns.tourCalls = 0; if (window.CNSUI && CNSUI.tour) { CNSUI.tour.start = function () { __cns.tourCalls++; return Promise.resolve(); }; CNSUI.tour.welcome = function () { __cns.tourCalls++; }; } return !!(window.CNSUI && CNSUI.tour); })()`);
}
async function closePal(page) { if (!(await page.eval(HIDDEN))) { await page.press('Escape'); await page.waitFor(HIDDEN, 2000, 30); } }
async function openPal(page, via = 'meta') {
  await closePal(page);
  if (via === 'hint') await page.click('#kbdHint'); else await page.press('k', MOD.Meta);
  await page.waitFor(OPEN_FOCUSED, 3000, 30);
}
/** Open the palette and type `q` with real key events; returns the palette state once the input carries `q`. */
async function query(page, q) {
  await openPal(page);
  await page.type(q);
  await page.waitFor(`document.getElementById('cmdkIn').value === ${j(q)}`, 3000, 30);
  await page.sleep(60);
  return pal(page);
}
const labelsOf = st => st.items.map(x => (x.g ? x.g + '/' : '') + x.label + (x.sub ? ' [' + x.sub + ']' : '')).join(' | ');
/** ArrowDown to the item whose label matches `re`, verify the highlight, Enter. Returns the item. */
async function runItem(page, st, re) {
  const it = st.items.find(x => re.test(x.label));
  if (!it) throw new Error(`no palette item matching ${re} — rendered: ${labelsOf(st) || '(none)'}`);
  for (let i = 0; i < it.i; i++) await page.press('ArrowDown');
  const now = await pal(page); const on = now.items.find(x => x.on);
  if (!on || on.i !== it.i) throw new Error(`after ${it.i}× ArrowDown the highlight is on #${on && on.i} "${on && on.label}", wanted #${it.i} "${it.label}"`);
  await page.press('Enter');
  await page.waitFor(HIDDEN, 3000, 30);
  return it;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const bounded = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what || 'call'} unanswered for ${ms} ms (renderer blocked?)`)), ms))]);
/** Renderer liveness sampler (harness gap): each tab is its own renderer; a busy main thread stalls every CDP call on it.
    Probes every page each second with a bounded Runtime.evaluate and records {page, ms, during, until} per stall. */
function startLiveness(pages, skip = () => false) {
  const L = { stalls: [], cur: '(setup)', blocked: {}, timer: null };
  const probe = async pg => { if (skip(pg)) return; const t = Date.now(); const r = await Promise.race([pg.send('Runtime.evaluate', { expression: '1', returnByValue: true }).then(() => 'ok', () => 'err'), new Promise(res => setTimeout(res, 1500, 'blocked'))]);
    if (r === 'blocked') { if (!L.blocked[pg.label]) L.blocked[pg.label] = { t, during: L.cur }; }
    else if (L.blocked[pg.label]) { const b = L.blocked[pg.label]; delete L.blocked[pg.label]; L.stalls.push({ page: pg.label, ms: Date.now() - b.t, during: b.during, until: L.cur }); } };
  L.timer = setInterval(() => pages.forEach(probe), 1000); L.timer.unref && L.timer.unref();
  L.stop = () => { clearInterval(L.timer); for (const [l, b] of Object.entries(L.blocked)) L.stalls.push({ page: l, ms: Date.now() - b.t, during: b.during, until: L.cur, open: true }); L.blocked = {}; };
  return L;
}
/** Wait until `page` answers a trivial evaluate twice in a row (≤ 1.5 s each), up to `max` ms; returns the wait in ms. */
async function settle(page, max = 90000) {
  const t0 = Date.now(); let quick = 0;
  while (Date.now() - t0 < max) { try { await bounded(page.eval('1', { timeout: 1500 }), 1500); quick++; if (quick >= 2) return Date.now() - t0; } catch (e) { quick = 0; await page.sleep(250); } }
  return Date.now() - t0;
}

// ---------------------------------------------------------------------------------------------
export default async function run(ctx) {
  // Seed the basemap to Satellite so the 3rd default action ("Basemap: Light") has an observable effect.
  const v2 = await ctx.v2Page({ seedLocalStorage: { cns_map_options: { basemap: 'sat' } } });
  if (!await tourSpy(v2)) throw new Error('CNSUI.tour missing — the tour spy could not be installed (the scenario refuses to run without it)');
  ctx.cleanup(async () => { try { await bounded(closePal(v2), 5000, 'closePal'); } catch (e) {} });
  const classic = await ctx.classicPage(v2.browser);
  // The classic is a CONTROL tab: its parity helpers read DOM/JS state, never pixels. Two software-rendered
  // 1440×900 map tabs in one headless Chrome saturate their main threads with paint work (Performance.getMetrics:
  // classic task 2.00 s per 2 s with 0.05 s script after boot) and starve every CDP call on a loaded host, so the
  // classic gets a tiny viewport (paint cost /30) and is frozen (Page.setWebLifecycleState) between the checks.
  const CLASSIC_VIEWPORT = { width: 360, height: 280, deviceScaleFactor: 1, mobile: false };
  await classic.send('Emulation.setDeviceMetricsOverride', CLASSIC_VIEWPORT);
  let classicFrozen = false;
  const freezeClassic = async on => { if (classicFrozen === on) return; try { await bounded(classic.send('Page.setWebLifecycleState', { state: on ? 'frozen' : 'active' }), 8000, 'setWebLifecycleState'); classicFrozen = on; } catch (e) { ctx.log('setWebLifecycleState failed: ' + e.message); } };
  const LIVE = startLiveness([v2, classic], pg => pg === classic && classicFrozen); ctx.cleanup(() => LIVE.stop());
  ctx.cleanup(() => freezeClassic(false));
  // Every check starts with both tabs answering (absorbs the classic-tab stalls at check boundaries instead of
  // letting them surface as 15 s eval timeouts mid-check). Checks are idempotent (each re-establishes its own
  // preconditions), so the default retry stays on; a pass on the retry is reported as `flaky`.
  const check = async (name, fn, opts) => { LIVE.cur = name; await freezeClassic(false); const wc = await settle(classic, 60000), wv = await settle(v2, 60000); if (wc > 2000 || wv > 2000) ctx.log(`${name}: waited classic ${wc} ms / v2 ${wv} ms for the tabs to answer`);
    try { return await ctx.check(name, fn, opts); } finally { await freezeClassic(true); } };
  // Reload the classic control tab without page.goto(): goto() races a 25 s Page.loadEventFired timer that rejects
  // unobserved (process crash) when Page.navigate itself stalls behind a busy classic renderer (harness gap). Here:
  // wait until the tab answers, send Page.navigate with a bound, then wait for the classic boot predicate.
  const reloadClassic = async () => {
    const w = await settle(classic); if (w > 2000) ctx.log(`classic tab answered again after ${w} ms — reloading now`);
    const t = Date.now();
    await bounded(classic.send('Page.navigate', { url: classic.url }), 90000, 'Page.navigate (classic reload)');
    await classic.waitFor(Page.BOOT.classic, 90000, 100);
    if (Date.now() - t > 5000) ctx.log(`classic reload took ${Date.now() - t} ms`);
    return classic.eval(CLASSIC_STATE);
  };

  // =============================================================================================
  // 1. open / close: ⌘K (Meta+K over CDP) → #cmdk visible + #cmdkIn focused; Escape closes; #kbdHint opens;
  //    ⌘K toggles it closed again; a real click on the dim closes.
  await check('open-close', async () => {
    const steps = [];
    await v2.press('k', MOD.Meta);
    await v2.waitFor(`!${HIDDEN}`, 3000, 30); await v2.sleep(50);
    const a = await pal(v2); steps.push(`⌘K → visible=${a.visible} display=${a.display} focused=${a.focused} active=${a.active} box=${j(a.box)}`);
    await ctx.screenshot(v2, 'open-cmdk');
    if (!a.visible || !a.focused) throw new Error('after ⌘K: ' + steps.join('; '));
    if (!a.box || a.box.w < 300 || a.box.y < 0 || a.box.y > 400) throw new Error('palette box off-screen or collapsed: ' + j(a.box));
    await v2.press('Escape');
    await v2.waitFor(HIDDEN, 2000, 30);
    const b = await pal(v2); steps.push(`Escape → hidden=${b.hidden}`);
    await v2.click('#kbdHint');
    await v2.waitFor(`!${HIDDEN}`, 3000, 30); await v2.sleep(50);
    const c = await pal(v2); steps.push(`#kbdHint click → visible=${c.visible} focused=${c.focused} value="${c.value}" items=${c.items.length}`);
    if (!c.visible || !c.focused) throw new Error('after #kbdHint click: ' + steps.join('; '));
    await v2.press('k', MOD.Meta);
    await v2.waitFor(HIDDEN, 2000, 30);
    const d = await pal(v2); steps.push(`⌘K again → hidden=${d.hidden}`);
    await v2.press('k', MOD.Meta);
    await v2.waitFor(OPEN_FOCUSED, 3000, 30);
    // the dim fills the viewport; the box sits at top 16vh centred — click bottom-left, well outside the box
    const where = await v2.eval(`(function(){ var e = document.elementFromPoint(30, innerHeight - 30); return e ? e.className : null; })()`);
    await v2.clickAt(30, 870);
    await v2.waitFor(HIDDEN, 2000, 30);
    const e = await pal(v2); steps.push(`dim click at (30,870) on "${where}" → hidden=${e.hidden}`);
    if (where !== 'cmdk-dim') throw new Error('expected the dim under the click, got ' + where + ' — ' + steps.join('; '));
    return { detail: steps.join('; '), repro: 'v2: Input.dispatchKeyEvent k+Meta; Escape; click #kbdHint; ⌘K; click (30,870)', evidence: [ctx.shot('open-cmdk')] };
  });

  // =============================================================================================
  // 2. default actions: ≥ 10 items with no query, all in the Actions group; ArrowDown ×2 + Enter runs the highlighted one.
  await check('default-actions', async () => {
    await openPal(v2);
    const st = await pal(v2);
    await ctx.screenshot(v2, 'default-actions');
    if (st.items.length < 10) throw new Error(`${st.items.length} default items (< 10): ${labelsOf(st)}`);
    if (!st.items.every(x => x.g === 'Actions')) throw new Error('non-Actions group in the default list: ' + labelsOf(st));
    if (!st.items[0].on) throw new Error('first item not highlighted on open: ' + labelsOf(st));
    const before = await v2s(v2);
    await v2.press('ArrowDown'); await v2.press('ArrowDown');
    const hl = (await pal(v2)).items.find(x => x.on);
    if (!hl || hl.i !== 2) throw new Error(`after 2× ArrowDown the highlight is #${hl && hl.i} "${hl && hl.label}"`);
    await v2.press('Enter');
    await v2.waitFor(HIDDEN, 3000, 30); await v2.sleep(150);
    const after = await v2s(v2);
    // the effect the highlighted label must have produced
    const EFFECTS = {
      'Basemap: Light': s => s.base === 'light' && s.baseOn.join() === 'light' && s.mapOpts.basemap === 'light' && s.tiles.length === 1 && /World_Light_Gray_Base/.test(s.tiles[0]),
      'Basemap: Street': s => s.base === 'street' && s.baseOn.join() === 'street' && s.mapOpts.basemap === 'street' && /cartocdn/.test(s.tiles[0]),
      'Basemap: Satellite': s => s.base === 'sat' && s.baseOn.join() === 'sat' && s.mapOpts.basemap === 'sat' && /World_Imagery/.test(s.tiles[0]),
      'Units: kilometres': s => s.units === 'metric' && s.unitOn.join() === 'km',
      'Units: nautical miles': s => s.units === 'nautical' && s.unitOn.join() === 'nm',
      'Switch to Network mode': s => s.mode === 'network' && s.bodyNet,
      'Simulate the current route': s => s.result || s.err
    };
    const eff = EFFECTS[hl.label];
    if (!eff) throw new Error(`highlighted item "${hl.label}" has no effect table entry — list: ${labelsOf(st)}`);
    const ok = eff(after);
    const detail = `${st.items.length} default items: ${st.items.map(x => x.label + (x.k ? ' (' + x.k + ')' : '')).join(' | ')}; ArrowDown×2 → #2 "${hl.label}"; Enter → palette hidden; before base=${before.base} tiles=${j(before.tiles)} → after base=${after.base} baseOn=${j(after.baseOn)} cns_map_options.basemap=${after.mapOpts.basemap} tiles=${j(after.tiles)} units=${after.units} mode=${after.mode}`;
    if (!ok) throw new Error(`"${hl.label}" ran but its effect is missing — ${detail}`);
    return { detail, repro: 'v2 (seed cns_map_options.basemap=sat): ⌘K, ArrowDown, ArrowDown, Enter → CNSUI.S.base / #mapDd .on / localStorage', evidence: [ctx.shot('default-actions')] };
  });

  // nothing matches → the empty state, no exception
  await check('empty-state', async () => {
    const st = await query(v2, 'zzqxjv');
    await closePal(v2);
    if (st.items.length || !st.none) throw new Error(`items=${st.items.length} none=${st.none}: ${labelsOf(st)}`);
    return `"zzqxjv" → 0 items, .none shown`;
  });

  // ⌘K while typing in the header search (#q) must still open the palette and take the focus (document-level keydown).
  await check('open-from-header-search', async () => {
    await closePal(v2);
    await v2.click('#q'); await v2.type('ed');
    const before = await v2.eval(`({ active: document.activeElement && document.activeElement.id, ac: document.querySelector('#qAc').classList.contains('open'), n: document.querySelectorAll('#qAc button').length })`);
    await v2.press('k', MOD.Meta);
    await v2.waitFor(OPEN_FOCUSED, 3000, 30);
    const st = await pal(v2);
    await v2.press('Escape'); await v2.waitFor(HIDDEN, 2000, 30);
    await v2.setValue('#q', '', ['input']);
    await v2.eval(`(function(){ document.querySelector('#qAc').classList.remove('open'); document.activeElement && document.activeElement.blur(); return true; })()`);
    if (before.active !== 'q' || !before.ac) throw new Error('precondition: header search not focused/open: ' + j(before));
    if (!st.visible || !st.focused) throw new Error(`⌘K from #q: visible=${st.visible} focused=${st.focused} active=${st.active}`);
    return { detail: `#q focused with "ed" (${before.n} suggestions open) → ⌘K → palette visible, focus moved to #cmdkIn (active=${st.active}), ${st.items.length} default items; Escape closes`, repro: 'v2: click #q, type "ed", Input.dispatchKeyEvent k+Meta' };
  });

  // Keyboard bounds: ArrowUp at the top stays at 0, ArrowDown past the end stays on the last item, Enter on an empty list is a no-op.
  await check('keyboard-bounds', async () => {
    await openPal(v2);
    await v2.press('ArrowUp'); await v2.press('ArrowUp');
    const top = (await pal(v2)).items.find(x => x.on);
    for (let i = 0; i < 25; i++) await v2.press('ArrowDown');
    const st = await pal(v2); const last = st.items.find(x => x.on);
    await v2.type('zzqxjv'); await v2.waitFor(`document.getElementById('cmdkIn').value === 'zzqxjv'`, 3000, 30); await v2.sleep(60);
    const n0 = v2.errors.length;
    await v2.press('Enter'); await v2.sleep(150);
    const after = await pal(v2);
    const ex = v2.errors.slice(n0).filter(e => e.type === 'exception');
    await closePal(v2);
    if (!top || top.i !== 0) throw new Error(`ArrowUp ×2 at the top → highlight #${top && top.i}`);
    if (!last || last.i !== st.items.length - 1) throw new Error(`ArrowDown ×25 → highlight #${last && last.i} of ${st.items.length}`);
    if (ex.length) throw new Error('Enter on an empty list threw: ' + ex.map(e => e.text).join(' || '));
    return { detail: `ArrowUp ×2 → #${top.i}; ArrowDown ×25 → #${last.i} of ${st.items.length} ("${last.label}"); "zzqxjv" + Enter → no exception, palette ${after.visible ? 'stays open' : 'closed'} (items=${after.items.length}, none=${after.none})`, repro: 'v2: ⌘K, ArrowUp, ArrowDown ×25, type zzqxjv, Enter' };
  });

  // Hover (real mousemove) moves the highlight to the item under the pointer.
  await check('hover-moves-highlight', async () => {
    await openPal(v2);
    const st = await pal(v2); const want = Math.min(3, st.items.length - 1);
    const r = await v2.rect(`#cmdkList .it[data-i="${want}"]`); if (!r) throw new Error('item #' + want + ' not rendered');
    await v2.hover(r.cx, r.cy); await v2.sleep(80);
    const on = (await pal(v2)).items.find(x => x.on);
    await closePal(v2);
    await v2.hover(30, 870);   // park the pointer over the map again — see pointer-over-list-storm below
    if (!on || on.i !== want) throw new Error(`hover over #${want} at (${r.cx.toFixed(0)},${r.cy.toFixed(0)}) → highlight #${on && on.i}`);
    return { detail: `mousemove over #${want} "${on.label}" → .it.on = #${on.i}`, repro: 'v2: ⌘K, Input.dispatchMouseEvent mouseMoved over #cmdkList .it[data-i=3]' };
  });

  // A query narrows the action list to the matching actions only (no airport/aircraft/charger noise).
  await check('query-filters-actions', async () => {
    const bm = await query(v2, 'basemap'); await closePal(v2);
    const un = await query(v2, 'units:'); await closePal(v2);
    const bmL = bm.items.map(x => x.label), unL = un.items.map(x => x.label);
    if (j(bmL) !== j(['Basemap: Light', 'Basemap: Street', 'Basemap: Satellite']) || !bm.items.every(x => x.g === 'Actions')) throw new Error('"basemap" → ' + labelsOf(bm));
    if (j(unL) !== j(['Units: kilometres', 'Units: nautical miles']) || !un.items.every(x => x.g === 'Actions')) throw new Error('"units:" → ' + labelsOf(un));
    return { detail: `"basemap" → ${j(bmL)}; "units:" → ${j(unL)} (all in Actions)`, repro: 'v2: ⌘K basemap / units:' };
  });

  // =============================================================================================
  // 3. airport items: 'EDDM' → fly-to + Set departure / destination / stop; no Isolate on an empty network.
  await check('airport-items-set-departure', async () => {
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.setMode('plan'); return true; })()`);
    const st = await query(v2, 'EDDM');
    await ctx.screenshot(v2, 'airport-items-eddm');
    const air = st.items.filter(x => x.g === 'Airports');
    const problems = [];
    if (!air.length || !/^EDDM /.test(air[0].label) || air[0].k !== 'fly to') problems.push('first airport item is not "EDDM … (fly to)"');
    for (const want of [/^Set EDDM as departure$/, /^Set EDDM as destination$/, /^Add EDDM as a stop$/]) if (!air.some(x => want.test(x.label))) problems.push('missing ' + want);
    if (air.some(x => /^Isolate /.test(x.label))) problems.push('Isolate offered on an EMPTY network');
    if (problems.length) throw new Error(problems.join('; ') + ' — rendered: ' + labelsOf(st));
    await runItem(v2, st, /^Set EDDM as departure$/);
    await v2.waitFor(`CNSUI.S.origin && CNSUI.S.origin.ident === 'EDDM'`, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    await ctx.screenshot(v2, 'airport-items-departure');
    // classic control: the same action (setOrigin) on the classic tab
    const c = await classic.eval(`(function(){ try { window.setOrigin('EDDM'); } catch (e) {} return { o: selected.origin && selected.origin.ident, name: selected.origin && selected.origin.name, input: document.getElementById('origin').value }; })()`);
    if (s.o !== 'EDDM' || s.mode !== 'plan' || s.originIcao !== 'EDDM') throw new Error(`v2 after "Set EDDM as departure": origin=${s.o} mode=${s.mode} icao="${s.originIcao}" input="${s.originInput}"`);
    if (c.o !== 'EDDM' || s.originInput !== c.name) throw new Error(`classic setOrigin('EDDM') → ${j(c)} vs v2 input "${s.originInput}"`);
    return { detail: `airport items for "EDDM": ${air.map(x => x.label + (x.k ? ' (' + x.k + ')' : '')).join(' | ')}; run "Set EDDM as departure" → S.origin=${s.o} rail input="${s.originInput}" icao=${s.originIcao} mode=${s.mode}; classic setOrigin('EDDM') → ${c.o} "${c.name}" (#origin "${c.input}")`,
      repro: 'v2: ⌘K, type EDDM, ArrowDown to "Set EDDM as departure", Enter → CNSUI.S.origin.ident; classic: window.setOrigin("EDDM")', evidence: [ctx.shot('airport-items-eddm'), ctx.shot('airport-items-departure')] };
  });

  await check('airport-items-dest-stop', async () => {
    let st = await query(v2, 'EHAM');
    await runItem(v2, st, /^Set EHAM as destination$/);
    await v2.waitFor(`CNSUI.S.dest && CNSUI.S.dest.ident === 'EHAM'`, 3000, 30);
    st = await query(v2, 'EDDF');
    await runItem(v2, st, /^Add EDDF as a stop$/);
    await v2.waitFor(`CNSUI.S.stops.some(function (a) { return a && a.ident === 'EDDF'; })`, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    if (s.d !== 'EHAM' || !s.stops.includes('EDDF') || s.mode !== 'plan') throw new Error(`dest=${s.d} stops=${j(s.stops)} mode=${s.mode}`);
    const stopInputs = await v2.eval(`[].slice.call(document.querySelectorAll('#railBody [data-ac^=stop]')).map(function (i) { return i.nextElementSibling.nextElementSibling.textContent.trim(); })`);
    if (!stopInputs.includes('EDDF')) throw new Error('stop field for EDDF not rendered: ' + j(stopInputs));
    return { detail: `"Set EHAM as destination" → S.dest=${s.d}; "Add EDDF as a stop" → S.stops=${j(s.stops)}, rail stop fields ${j(stopInputs)}`, repro: 'v2: ⌘K EHAM → destination item; ⌘K EDDF → stop item' };
  });

  await check('airport-items-fly-to', async () => {
    await v2.closePopups();
    const st = await query(v2, 'EDDM');
    const it = await runItem(v2, st, /^EDDM /);
    await v2.sleep(100); await v2.waitForMapIdle(8000);
    let popup = true; try { await v2.waitFor(`!!document.querySelector('.leaflet-popup .pp')`, 3000, 50); } catch (e) { popup = false; }
    const s = await v2s(v2);
    const tgt = await v2.eval(`(function(){ var a = CNSUI.byId()['EDDM']; return [a.latitude_deg, a.longitude_deg]; })()`);
    await ctx.screenshot(v2, 'airport-items-fly-to');
    await v2.closePopups();
    if (!near(s.center[0], tgt[0], 0.05) || !near(s.center[1], tgt[1], 0.05) || s.zoom < 8) throw new Error(`map centre ${j(s.center)} zoom ${s.zoom} vs EDDM ${j(tgt)}`);
    if (!popup || !s.popup.startsWith('EDDM')) throw new Error(`no EDDM popup after flyTo (popup="${s.popup}")`);
    return { detail: `"${it.label}" (${it.k}) → centre ${s.center.map(x => x.toFixed(3))} zoom ${s.zoom}, popup "${s.popup}"`, repro: 'v2: ⌘K EDDM, Enter on the first item', evidence: [ctx.shot('airport-items-fly-to')] };
  });

  // Isolate: only when the airport carries network demand (CNSDemand.computeAirports()[ident]); runs → network mode filtered.
  await check('airport-items-isolate', async () => {
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.S.filter = ''; CNSUI.setMode('plan'); return true; })()`);
    const seeded = await ctx.seedNetwork(v2, [{ o: 'EDDM', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freq: 1, per: 'day' }]);
    if (seeded[0].err || seeded[0].added !== 1) throw new Error('seed failed: ' + j(seeded));
    const inNet = await v2.eval(`Object.keys(CNSDemand.computeAirports())`);
    const notIn = await query(v2, 'EHAM');
    const eddm = await query(v2, 'EDDM');
    await ctx.screenshot(v2, 'airport-items-isolate');
    const problems = [];
    if (notIn.items.some(x => /^Isolate /.test(x.label))) problems.push('Isolate offered for EHAM, which is not in the network');
    const iso = eddm.items.find(x => /^Isolate EDDM in the network$/.test(x.label));
    if (!iso) problems.push('no "Isolate EDDM in the network" item although computeAirports() has ' + j(inNet));
    if (problems.length) throw new Error(problems.join('; ') + ' — EDDM items: ' + labelsOf(eddm));
    await runItem(v2, eddm, /^Isolate EDDM in the network$/);
    await v2.waitFor(`CNSUI.S.mode === 'network' && CNSUI.S.filter === 'EDDM'`, 3000, 30); await v2.sleep(150);
    const s = await v2s(v2);
    await ctx.screenshot(v2, 'airport-items-isolated');
    const c = await reloadClassic();
    if (!s.drawer || !s.railWide || s.apRows.join() !== 'EDDM' || !s.openAp.includes('EDDM')) throw new Error(`after Isolate: mode=${s.mode} filter=${s.filter} drawer=${s.drawer} wide=${s.railWide} apRows=${j(s.apRows)} openAp=${j(s.openAp)}`);
    if (!c.airports.includes('EDDM') || c.folder !== 1) throw new Error(`classic (reloaded) sees folder=${c.folder} airports=${j(c.airports)}`);
    await v2.eval(`(function(){ CNSUI.S.filter = ''; CNSUI.setMode('plan'); return true; })()`);
    return { detail: `network ${j(inNet)}; "EHAM" items have no Isolate (${labelsOf(notIn)}); "EDDM" offers "${iso.label}" (${iso.k}); run → mode=${s.mode} filter=${s.filter} drawer=${s.drawer} rail.wide=${s.railWide} rows=${j(s.apRows)} openAp=${j(s.openAp)}; classic after reload: folder=${c.folder} airports=${j(c.airports)} #airportFilter=${j(c.airportFilter)}`,
      repro: 'v2: seed one EDDM→EDDF flight; ⌘K EHAM (no Isolate); ⌘K EDDM → "Isolate EDDM in the network"', evidence: [ctx.shot('airport-items-isolate'), ctx.shot('airport-items-isolated')] };
  });

  // =============================================================================================
  // 4. aircraft items
  await check('aircraft-item-velis', async () => {
    await v2.eval(`(function(){ if (window.CNSUnits) CNSUnits.set('metric'); return true; })()`);
    const st = await query(v2, 'velis');
    await ctx.screenshot(v2, 'aircraft-item-velis');
    const ac = st.items.filter(x => x.g === 'Aircraft');
    const it = ac.find(x => x.label === 'Aircraft: Velis Electro');
    if (!it) throw new Error('no "Aircraft: Velis Electro" item — ' + labelsOf(st));
    if (it.sub !== '88 km · 22 kWh') throw new Error(`sub-label "${it.sub}", expected "88 km · 22 kWh" (units-aware CNSUnits.fmtDist ceils 87.5, as the classic spec line does)`);
    await runItem(v2, st, /^Aircraft: Velis Electro$/);
    await v2.waitFor(`CNSUI.S.planeId === 'pipistrel_velis'`, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    // classic control: #plane → pipistrel_velis switches #charger to the default charger (index.html:6519)
    const c = await ctx.classicSetRoute(classic, { plane: 'pipistrel_velis' });
    const opt = await classic.eval(optText('#plane', 'pipistrel_velis'));
    if (s.plane !== 'pipistrel_velis' || s.charger !== 'dc_22' || s.mode !== 'plan') throw new Error(`v2 after run: plane=${s.plane} charger=${s.charger} mode=${s.mode}`);
    if (c.charger !== 'dc_22') throw new Error(`classic #plane=pipistrel_velis → #charger=${c.charger} (v2 ${s.charger})`);
    return { detail: `"${it.label}" [${it.sub}] → S.planeId=${s.plane} S.chargerId=${s.charger} mode=${s.mode}; classic #plane=${c.plane} → #charger=${c.charger}; classic option text "${opt}"`,
      repro: 'v2: ⌘K velis → Enter on "Aircraft: Velis Electro"; classic: #plane=pipistrel_velis + change', evidence: [ctx.shot('aircraft-item-velis')] };
  });

  // Battery-less hybrids (aura_era, electra_el9): the classic says "no charge" (index.html:1817 option label, :3619 spec
  // line, :6007/:6035 edit dialog); the palette sub-label must not read "0 kWh". The spec names the query "aura" (the OEM);
  // when that yields no aircraft (see aircraft-item-oem-search) the row is reached through "era" so the sub-label is still judged.
  await check('aircraft-item-battery-less', async () => {
    let q = 'aura'; let st = await query(v2, q);
    let era = st.items.find(x => x.g === 'Aircraft' && x.label === 'Aircraft: ERA');
    const auraItems = st.items.filter(x => x.g === 'Aircraft').map(x => x.label);
    if (!era) { await closePal(v2); q = 'era'; st = await query(v2, q); era = st.items.find(x => x.g === 'Aircraft' && x.label === 'Aircraft: ERA'); }
    await ctx.screenshot(v2, 'aircraft-item-era');
    await closePal(v2);
    const cat = await v2.eval(`(function(){ var p = CNSUI.PLANES.find(function (x) { return x.id === 'aura_era'; }); return { name: p.name, oem: p.oem, battery_kwh: p.battery_kwh, range_km: p.range_km, hasKey: 'battery_kwh' in p }; })()`);
    const viaApi = await v2.eval(`CNSUI.palette.items('el9').filter(function (x) { return x.g === 'Aircraft'; }).map(function (x) { return { label: x.label.replace(/<[^>]+>/g, ''), sub: x.sub }; })`);
    const cOpt = await classic.eval(optText('#plane', 'aura_era'));
    const cEl9 = await classic.eval(optText('#plane', 'electra_el9'));
    const cSpec = await classic.eval(`(function(){ try { return _planeSpecsLine(BUILTIN_PLANES_BY_ID['aura_era']); } catch (e) { return 'ERR ' + e.message; } })()`);
    if (!era) throw new Error(`no "Aircraft: ERA" item for "aura" (${j(auraItems)}) nor for "era" — ` + labelsOf(st));
    const bad = [];
    if (/(^|\D)0 kWh\b/.test(era.sub)) bad.push(`ERA sub-label "${era.sub}"`);
    viaApi.forEach(x => { if (/(^|\D)0 kWh\b/.test(x.sub)) bad.push(`${x.label} sub-label "${x.sub}"`); });
    const detail = `"aura" → aircraft ${j(auraItems)} (row reached via "${q}"); catalog aura_era: ${j(cat)}; palette ERA sub-label "${era.sub}"; EL9 via CNSUI.palette.items('el9'): ${j(viaApi)}; classic #plane options: "${cOpt}", "${cEl9}"; classic _planeSpecsLine(aura_era)="${cSpec}"`;
    if (bad.length) throw new Error(`battery-less aircraft shown as 0 kWh (classic: "no charge") — ${bad.join('; ')} — ${detail}`);
    return { detail, repro: 'v2: ⌘K aura (or era) → read .it .sub; CNSUI.palette.items("el9")[..].sub; classic: #plane option[value=aura_era].textContent, _planeSpecsLine(BUILTIN_PLANES_BY_ID.aura_era)', evidence: [ctx.shot('aircraft-item-era')] };
  });

  // OEM search: the classic titles the airframe "Aura Aero ERA" (index.html:3691-3700, p.oem) — the palette should find it by "aura".
  await check('aircraft-item-oem-search', async () => {
    const st = await query(v2, 'aura');
    await ctx.screenshot(v2, 'aircraft-item-aura');
    await closePal(v2);
    const ac = st.items.filter(x => x.g === 'Aircraft');
    const pip = await v2.eval(`CNSUI.palette.items('pipistrel').filter(function (x) { return x.g === 'Aircraft'; }).map(function (x) { return x.label.replace(/<[^>]+>/g, ''); })`);
    const oems = await v2.eval(`CNSUI.PLANES.map(function (p) { return p.oem + ' ' + p.name; })`);
    const cTitle = await classic.eval(`(function(){ try { return _airframeNameHtml(BUILTIN_PLANES_BY_ID['aura_era']).replace(/<[^>]+>/g, ''); } catch (e) { return 'ERR ' + e.message; } })()`);
    const detail = `"aura" → aircraft items ${j(ac.map(x => x.label))}; "pipistrel" → ${j(pip)}; classic airframe title "${cTitle}"; catalog oem+name: ${j(oems.slice(0, 6))}…`;
    if (!ac.some(x => /ERA/.test(x.label))) throw new Error(`typing the OEM "aura" offers no aircraft (palette.js:53 matches p.name only) — ${detail}`);
    return { detail, repro: 'v2: ⌘K aura → Aircraft group; classic: _airframeNameHtml(BUILTIN_PLANES_BY_ID.aura_era)', evidence: [ctx.shot('aircraft-item-aura')] };
  });

  // An aircraft without default_charger_id keeps the current charger (classic: index.html:6519 only switches when the option exists).
  await check('aircraft-item-no-default-charger', async () => {
    await v2.eval(`(function(){ CNSUI.S.chargerId = 'dc_320'; CNSUI.plan.onFormChange(false); return true; })()`);
    const st = await query(v2, 'era');
    await runItem(v2, st, /^Aircraft: ERA$/);
    await v2.waitFor(`CNSUI.S.planeId === 'aura_era'`, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    const c = await ctx.classicSetRoute(classic, { charger: 'dc_320' });
    const c2 = await ctx.classicSetRoute(classic, { plane: 'aura_era' });
    if (s.plane !== 'aura_era' || s.charger !== 'dc_320') throw new Error(`v2 after "Aircraft: ERA": plane=${s.plane} charger=${s.charger} (was dc_320)`);
    if (c2.charger !== 'dc_320') throw new Error(`classic #plane=aura_era changed #charger ${c.charger} → ${c2.charger}`);
    return { detail: `"Aircraft: ERA" → S.planeId=${s.plane}, S.chargerId stays ${s.charger}; classic #plane=aura_era keeps #charger=${c2.charger}`, repro: 'v2: S.chargerId=dc_320; ⌘K era → Enter on "Aircraft: ERA"; classic: #plane=aura_era + change' };
  });

  // =============================================================================================
  // 5. charger item
  await check('charger-item-1mw', async () => {
    const st = await query(v2, '1 MW');
    await ctx.screenshot(v2, 'charger-item-1mw');
    const ch = st.items.filter(x => x.g === 'Chargers');
    const it = ch.find(x => x.label === 'Charger: Vaeridion 1 MW');
    if (!it) throw new Error('no "Charger: Vaeridion 1 MW" item — ' + labelsOf(st));
    await runItem(v2, st, /^Charger: Vaeridion 1 MW$/);
    await v2.waitFor(`CNSUI.S.chargerId === 'dc_1000'`, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    const cOpt = await classic.eval(optText('#charger', 'dc_1000'));
    const c = await ctx.classicSetRoute(classic, { charger: 'dc_1000' });
    if (s.charger !== 'dc_1000' || s.chargerObj !== 'dc_1000' || s.mode !== 'plan') throw new Error(`v2 after run: chargerId=${s.charger} charger()=${s.chargerObj} mode=${s.mode}`);
    return { detail: `chargers for "1 MW": ${j(ch.map(x => x.label))}; run → S.chargerId=${s.charger} mode=${s.mode}; classic #charger option "${cOpt}" selectable (=${c.charger})`, repro: 'v2: ⌘K "1 MW" → Enter on "Charger: Vaeridion 1 MW"', evidence: [ctx.shot('charger-item-1mw')] };
  });

  // =============================================================================================
  // 6. actions
  await check('actions-units-nautical', async () => {
    await v2.eval(`(function(){ if (window.CNSUnits) CNSUnits.set('metric'); CNSUI.setMode('plan'); return true; })()`); await v2.sleep(100);
    const before = await v2s(v2);
    const st = await query(v2, 'nautical');
    await runItem(v2, st, /^Units: nautical miles$/);
    await v2.waitFor(`localStorage.getItem('cns_units') === 'nautical'`, 3000, 30); await v2.sleep(200);
    const s = await v2s(v2);
    await ctx.screenshot(v2, 'actions-units-nm');
    const c = await reloadClassic();
    await ctx.screenshot(classic, 'actions-units-nm-classic');
    const problems = [];
    if (s.units !== 'nautical' || s.unitsGet !== 'nautical') problems.push(`cns_units=${s.units} CNSUnits.get()=${s.unitsGet}`);
    if (s.unitOn.join() !== 'nm') problems.push(`#unitSeg .on=${j(s.unitOn)}`);
    // a leg over the reach carries a trailing "⚠" — match the unit as a word, not at the end of the string
    if (!s.routeD.some(t => / NM\b/.test(t)) || s.routeD.some(t => / km\b/.test(t))) problems.push(`rail distances ${j(s.routeD)}`);
    if (c.units !== 'nautical' || !c.unitToggle || !/ NM$/.test(c.psRange)) problems.push(`classic after reload units=${c.units} toggle=${c.unitToggle} psRange="${c.psRange}"`);
    if (problems.length) throw new Error(problems.join(' | '));
    return { detail: `rail km ${j(before.routeD)} → NM ${j(s.routeD)}; cns_units=${s.units}; #unitSeg .on=${j(s.unitOn)}; classic after reload: units=${c.units} #unitToggle=${c.unitToggle} psRange="${c.psRange}"`,
      repro: 'v2: ⌘K nautical → Enter on "Units: nautical miles"; reload the classic tab and read CNSUnits.get()/#unitToggle/#psRange', evidence: [ctx.shot('actions-units-nm'), ctx.shot('actions-units-nm-classic')] };
  });

  // While nautical: the aircraft sub-label should follow the unit system like every classic spec line (fmtDist); then back to km via the palette.
  await check('aircraft-item-units', async () => {
    await v2.eval(`(function(){ if (window.CNSUnits) CNSUnits.set('nautical'); return true; })()`); await v2.sleep(100);
    const st = await query(v2, 'velis');
    await ctx.screenshot(v2, 'aircraft-item-velis-nm');
    const it = st.items.find(x => x.g === 'Aircraft' && x.label === 'Aircraft: Velis Electro');
    const want = await v2.eval(`CNSUnits.fmtDist(87.5)`);
    const cardSpec = await v2.eval(`((document.querySelector('#railBody .sp') || {}).textContent || '').trim()`);
    await closePal(v2);
    const back = await query(v2, 'kilometres');
    await runItem(v2, back, /^Units: kilometres$/);
    await v2.waitFor(`localStorage.getItem('cns_units') === 'metric'`, 3000, 30); await v2.sleep(150);
    const s = await v2s(v2);
    if (!it) throw new Error('no Velis item — ' + labelsOf(st));
    const detail = `nautical: palette sub-label "${it.sub}" vs CNSUnits.fmtDist(87.5)="${want}" (rail spec line "${cardSpec}"); "Units: kilometres" → cns_units=${s.units} .on=${j(s.unitOn)}`;
    if (s.units !== 'metric' || s.unitOn.join() !== 'km') throw new Error('back to km failed — ' + detail);
    if (!/ NM\b/.test(it.sub) || / km\b/.test(it.sub)) throw new Error(`aircraft sub-label ignores the unit system (palette.js:53 hard-codes "km") — ${detail}`);
    return { detail, repro: 'v2: CNSUnits.set("nautical"); ⌘K velis → .it .sub; CNSUnits.fmtDist(87.5)', evidence: [ctx.shot('aircraft-item-velis-nm')] };
  });

  await check('actions-basemap-satellite', async () => {
    await v2.eval(`(function(){ CNSUI.map.setBase('light'); return true; })()`);
    const st = await query(v2, 'satellite');
    await runItem(v2, st, /^Basemap: Satellite$/);
    await v2.waitFor(`CNSUI.S.base === 'sat'`, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    await ctx.screenshot(v2, 'actions-basemap-sat');
    const c = await reloadClassic();
    const problems = [];
    if (s.baseOn.join() !== 'sat') problems.push(`#mapDd .on=${j(s.baseOn)}`);
    if (s.mapOpts.basemap !== 'sat' && s.mapOpts.basemap !== 'satellite') problems.push(`cns_map_options.basemap=${s.mapOpts.basemap}`);   // either shell's token for the same basemap
    if (s.tiles.length !== 1 || !/World_Imagery/.test(s.tiles[0])) problems.push(`tile layers ${j(s.tiles)}`);
    if (problems.length) throw new Error(problems.join(' | '));
    return { detail: `S.base=${s.base} #mapDd .on=${j(s.baseOn)} cns_map_options.basemap=${s.mapOpts.basemap} tiles=${j(s.tiles)}; classic after reload: active basemap=${c.basemap} (its own default is satellite; it reads cns_map_options.basemap=${c.mapOpts.basemap})`,
      repro: 'v2: ⌘K satellite → Enter on "Basemap: Satellite"', evidence: [ctx.shot('actions-basemap-sat')] };
  });

  // Both shells persist the basemap under cns_map_options.basemap, but v2 writes light|street|sat while the classic
  // reads/writes satellite|voyager (index.html:6464-6477): a palette choice never reaches the classic and vice versa.
  await check('actions-basemap-shared-key-parity', async () => {
    const st = await query(v2, 'street');
    await runItem(v2, st, /^Basemap: Street$/);
    await v2.waitFor(`CNSUI.S.base === 'street'`, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    const c = await reloadClassic();
    await ctx.screenshot(classic, 'actions-basemap-street-classic');
    // reverse direction: the classic picks Street (voyager) → v2 reload
    const cw = await classic.eval(`(function(){ var b = document.querySelector('.seg-btn[data-basemap=voyager]'); if (b) b.click(); var mo = {}; try { mo = JSON.parse(localStorage.getItem('cns_map_options') || '{}'); } catch (e) {} var a = document.querySelector('.seg-btn[data-basemap].active'); return { active: a ? a.dataset.basemap : null, basemap: mo.basemap }; })()`);
    await settle(v2); await bounded(v2.send('Page.navigate', { url: v2.url }), 90000, 'Page.navigate (v2 reload)'); await v2.waitFor(Page.BOOT.v2, 90000, 100); await v2.eval(Page.MAP_HOOK); await tourSpy(v2);
    const s2 = await v2s(v2);
    const detail = `v2 palette "Basemap: Street" → S.base=${s.base}, cns_map_options.basemap=${s.mapOpts.basemap}; classic after reload: active=${c.basemap} (expected voyager = Street); classic clicks Street → writes basemap=${cw.basemap} (active ${cw.active}); v2 after reload: S.base=${s2.base} (expected street), tiles=${j(s2.tiles)}`;
    if (c.basemap !== 'voyager' || s2.base !== 'street') throw new Error('basemap choice does not cross the shells through the shared cns_map_options key — ' + detail);
    return { detail, repro: 'v2: ⌘K street → Enter; reload the classic → .seg-btn[data-basemap].active; classic: click Street; reload v2 → CNSUI.S.base', evidence: [ctx.shot('actions-basemap-street-classic')] };
  });

  await check('actions-scenario-training', async () => {
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.setMode('plan'); return true; })()`);
    const st = await query(v2, 'training');
    const it = await runItem(v2, st, /^Load scenario: Training school$/);
    await v2.waitFor(`CNSDemand.loadFolder().length === 1 && CNSUI.S.mode === 'network'`, 25000, 100); await v2.sleep(300);
    const s = await v2s(v2);
    const entry = await v2.eval(`(function(){ var t = CNSDemand.loadFolder()[0] || {}; var o = {}; ['id', 'tripType', 'planeId', 'freqN', 'freqUnit', 'originIdent', 'destIdent', 'origin', 'dest', 'chargerId', 'feasible'].forEach(function (k) { if (k in t) o[k] = typeof t[k] === 'object' && t[k] ? (t[k].ident || t[k]) : t[k]; }); o.cfgEHTE = (CNSDemand.loadCfg().EHTE || {}).chargers; return o; })()`);
    await ctx.screenshot(v2, 'actions-scenario-training');
    const c = await reloadClassic();
    await ctx.screenshot(classic, 'actions-scenario-training-classic');
    const problems = [];
    if (s.folder !== 1) problems.push(`folder=${s.folder}`);
    if (s.mode !== 'network' || !s.drawer || s.apRows.join() !== 'EHTE' || s.netCount !== '1') problems.push(`mode=${s.mode} drawer=${s.drawer} rows=${j(s.apRows)} #netCount="${s.netCount}"`);
    if (entry.tripType !== 'training' || entry.planeId !== 'pipistrel_velis' || +entry.freqN !== 12) problems.push('entry ' + j(entry));
    if (c.folder !== 1 || c.airports.join() !== 'EHTE') problems.push(`classic after reload folder=${c.folder} airports=${j(c.airports)}`);
    if (problems.length) throw new Error(problems.join(' | '));
    return { detail: `"${it.label}" → folder=${s.folder} mode=${s.mode} drawer=${s.drawer} rows=${j(s.apRows)} #netCount=${s.netCount} openAp=${j(s.openAp)} toast="${s.toast}"; entry ${j(entry)}; classic after reload: folder=${c.folder} airports=${j(c.airports)} card "${c.folderText.slice(0, 120)}"`,
      repro: 'v2: ⌘K training → Enter on "Load scenario: Training school"; CNSDemand.loadFolder().length; reload the classic', evidence: [ctx.shot('actions-scenario-training'), ctx.shot('actions-scenario-training-classic')] };
  });

  await check('actions-reset-form', async () => {
    // dirty every field first, then reset from the palette
    await v2.evalAsync(`const S = CNSUI.S, by = CNSUI.byId(); S.origin = by.EDDM; S.dest = by.EHAM; S.stops = [by.EDDF]; S.trip = 'retour'; S.freq = 3; S.per = 'week'; S.planeId = 'pipistrel_velis'; S.chargerId = 'dc_1000'; S.availOverride = 50; CNSUI.setMode('plan'); CNSUI.plan.onFormChange(false); return true;`);
    const dirty = await v2s(v2);
    const st = await query(v2, 'reset');
    await runItem(v2, st, /^Reset the route form$/);
    await v2.waitFor(`!CNSUI.S.origin && !CNSUI.S.dest && CNSUI.S.stops.length === 0`, 3000, 30); await v2.sleep(150);   // v2's Reset EMPTIES the route by design
    const s = await v2s(v2);
    await ctx.screenshot(v2, 'actions-reset-form');
    const c = await reloadClassic();
    const want = { o: null, d: null, stops: [], plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freq: 1, per: 'day', mode: 'plan', rail: 'form' };
    const diff = Object.keys(want).filter(k => j(s[k]) !== j(want[k])).map(k => `${k}=${j(s[k])} (want ${j(want[k])})`);
    const classicDefaults = `classic fresh defaults: ${c.o}→${c.d} stops=${j(c.stops)} plane=${c.plane} charger=${c.charger} trip=${c.trip} freq=${c.freqN}/${c.freqUnit}`;
    const parity = [];
    // route parity is not expected here: the classic's reset restores its demo route, v2's empties the route on purpose
    if (c.plane !== s.plane) parity.push(`plane ${c.plane} vs v2 ${s.plane}`);
    if (c.charger !== s.charger) parity.push(`charger ${c.charger} vs v2 ${s.charger}`);
    if (String(c.freqN) !== String(s.freq) || c.freqUnit !== s.per) parity.push(`freq ${c.freqN}/${c.freqUnit} vs v2 ${s.freq}/${s.per}`);
    const detail = `dirty: ${dirty.o}→${dirty.d} stops=${j(dirty.stops)} ${dirty.trip} ${dirty.freq}/${dirty.per} ${dirty.plane}/${dirty.charger}; reset → ${s.o}→${s.d} stops=${j(s.stops)} ${s.trip} ${s.freq}/${s.per} ${s.plane}/${s.charger} mode=${s.mode} rail=${s.rail} result=${s.result}; ${classicDefaults}`;
    if (diff.length) throw new Error('v2 reset left: ' + diff.join(', ') + ' — ' + detail);
    if (parity.length) throw new Error('v2 defaults differ from the classic boot defaults: ' + parity.join('; ') + ' — ' + detail);
    return { detail, repro: 'v2: set S.* to EDDM→EHAM via EDDF, retour, 3/week, velis, dc_1000; ⌘K reset → Enter; compare with a fresh classic tab', evidence: [ctx.shot('actions-reset-form')] };
  });

  await check('actions-settings', async () => {
    await v2.eval(`(function(){ CNSUI.modal.close(); return true; })()`);
    const st = await query(v2, 'settings');
    await runItem(v2, st, /^Model settings$/);
    await v2.waitFor(`!document.querySelector('#modal').hidden && !!document.querySelector('#modalBox .ms')`, 3000, 30); await v2.sleep(120);
    const s = await v2s(v2);
    const keys = await v2.eval(`({ fields: CNSUI.settings.FIELDS.map(function (f) { return f.key; }), stored: Object.keys(CNSSettings.loadAll()) })`);
    const cKeys = await classic.eval(`Object.keys(CNSSettings.loadAll())`);
    await ctx.screenshot(v2, 'actions-settings');
    await v2.press('Escape');
    await v2.waitFor(`document.querySelector('#modal').hidden`, 2000, 30);
    const missing = keys.fields.filter(k => !keys.stored.includes(k) || !cKeys.includes(k));
    if (!s.modal || !s.ms || s.msTitle !== 'Model settings') throw new Error(`modal=${s.modal} ms=${s.ms} title="${s.msTitle}"`);
    if (s.msRows !== keys.fields.length + 1) throw new Error(`${s.msRows} .msr rows, expected ${keys.fields.length} fields + tariff`);
    if (missing.length) throw new Error('setting keys not shared with the classic: ' + j(missing));
    return { detail: `"Model settings" → #modal open, title "${s.msTitle}", ${s.msRows} rows (${keys.fields.length} fields + tariff), ${s.msSliders} sliders, autofocus ${s.activeTag}; CNSSettings keys v2=${j(keys.stored)} classic=${j(cKeys)}; Escape closes`,
      repro: 'v2: ⌘K settings → Enter on "Model settings" → #modalBox .ms', evidence: [ctx.shot('actions-settings')] };
  });

  // Mode switch: the label follows the current mode and the action flips it.
  await check('actions-switch-mode', async () => {
    await v2.eval(`(function(){ CNSUI.modal.close(); CNSUI.setMode('plan'); return true; })()`);
    let st = await query(v2, 'switch to');
    const a = st.items.map(x => x.label);
    await runItem(v2, st, /^Switch to Network mode$/);
    await v2.waitFor(`CNSUI.S.mode === 'network'`, 3000, 30); await v2.sleep(100);
    const s1 = await v2s(v2);
    st = await query(v2, 'switch to');
    const b = st.items.map(x => x.label);
    await runItem(v2, st, /^Switch to Plan mode$/);
    await v2.waitFor(`CNSUI.S.mode === 'plan'`, 3000, 30); await v2.sleep(100);
    const s2 = await v2s(v2);
    if (!s1.bodyNet || !s1.railWide || s1.mode !== 'network') throw new Error(`after "Switch to Network mode": mode=${s1.mode} body.net=${s1.bodyNet} rail.wide=${s1.railWide}`);
    if (b.includes('Switch to Network mode') || !b.includes('Switch to Plan mode')) throw new Error('label did not flip in network mode: ' + j(b));
    if (s2.mode !== 'plan' || s2.bodyNet || s2.railWide) throw new Error(`after "Switch to Plan mode": mode=${s2.mode} body.net=${s2.bodyNet} rail.wide=${s2.railWide}`);
    return { detail: `plan: ${j(a)} → network (body.net=${s1.bodyNet}, rail.wide=${s1.railWide}); network: ${j(b)} → plan`, repro: 'v2: ⌘K "switch to" → Enter; again' };
  });

  // "Simulate the current route" (↵) then "Add the result to the network" (offered only once S.result exists) — with the classic
  // running the same route as the numbers control and its folder card as the network control.
  await check('actions-simulate-and-add', async () => {
    // Reset empties the route by design — put the demo route back so the simulate action has one
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.setMode('plan'); CNSUI.plan.resetForm(); const by = CNSUI.byId(); CNSUI.S.origin = by.EHLE; CNSUI.S.dest = by.EDDF; CNSUI.plan.onFormChange(false); return true; })()`);
    await openPal(v2); const pre = await pal(v2); const preLabels = pre.items.map(x => x.label);
    await closePal(v2);
    let st = await query(v2, 'simulate');
    const sim = await runItem(v2, st, /^Simulate the current route$/);
    await v2.waitFor(`(CNSUI.S.rail === 'result' && !!CNSUI.S.profile) || !!CNSUI.S.err`, 20000, 100); await v2.sleep(150);
    const s1 = await v2s(v2);
    const api = await v2.eval(`(function(){ var r = CNSUI.S.result || {}; return { err: CNSUI.S.err || null, leg: r.leg_energy_kwh, dist: r.total_distance_km, stops: (r.stops || []).map(function (x) { return x.ident; }), trip: r.trip_type }; })()`);
    await openPal(v2); const post = await pal(v2); const postLabels = post.items.map(x => x.label);
    const add = post.items.find(x => x.label === 'Add the result to the network');
    if (!add) { await closePal(v2); throw new Error(`no "Add the result to the network" after a simulate (err=${api.err}) — ${j(postLabels)}`); }
    await runItem(v2, post, /^Add the result to the network$/);
    await v2.waitFor(`CNSDemand.loadFolder().length === 1`, 3000, 30); await v2.sleep(150);
    const s2 = await v2s(v2);
    await ctx.screenshot(v2, 'actions-simulate-add');
    // classic control: the same route, simulated by the classic, and its folder after a reload
    const cr = await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freqN: 1, freqUnit: 'day' });
    const cs = await ctx.classicSimulate(classic);
    const c = await reloadClassic();
    const problems = [];
    if (preLabels.includes('Add the result to the network')) problems.push('"Add the result" offered before any result');
    if (sim.k !== '↵') problems.push(`Simulate shortcut label "${sim.k}"`);
    if (api.err || s1.rail !== 'result' || !s1.result) problems.push(`simulate: err=${api.err} rail=${s1.rail} result=${s1.result}`);
    if (add.i !== 1) problems.push(`"Add the result" sits at #${add.i}, expected #1 (after Simulate)`);
    if (s2.folder !== 1 || s2.netCount !== '1' || !/^Added EHLE → EDDF/.test(s2.toast)) problems.push(`after add: folder=${s2.folder} #netCount="${s2.netCount}" toast="${s2.toast}"`);
    if (cs.error || !cs.api) problems.push('classic simulate: ' + (cs.error || 'no result'));
    else if (!ctx.close(cs.api.leg_energy_kwh, api.leg, 1e-6) || j((cs.api.stops || []).map(x => x.ident)) !== j(api.stops)) problems.push(`classic leg_energy_kwh=${cs.api.leg_energy_kwh} stops=${j((cs.api.stops || []).map(x => x.ident))} vs v2 ${api.leg} ${j(api.stops)}`);
    if (c.folder !== 1 || !c.airports.includes('EHLE') || !c.airports.includes('EDDF')) problems.push(`classic after reload folder=${c.folder} airports=${j(c.airports)} card "${c.folderText.slice(0, 80)}"`);
    if (problems.length) throw new Error(problems.join(' | '));
    return { detail: `default list before: ${j(preLabels.slice(0, 3))}…; "Simulate the current route" (${sim.k}) → rail=${s1.rail} leg_energy_kwh=${api.leg} dist=${api.dist} stops=${j(api.stops)}; list after: #${add.i} "${add.label}"; run → folder=${s2.folder} #netCount=${s2.netCount} toast="${s2.toast}"; classic ${cr.o}→${cr.d} leg_energy_kwh=${cs.api && cs.api.leg_energy_kwh} stops=${j(cs.api && (cs.api.stops || []).map(x => x.ident))}; classic folder after reload=${c.folder} airports=${j(c.airports)} card "${c.folderText.slice(0, 60)}"`,
      repro: 'v2: reset form (EHLE→EDDF), ⌘K simulate → Enter; ⌘K → #1 "Add the result to the network" → Enter; classic: same route, .sim-btn, lastResult', evidence: [ctx.shot('actions-simulate-add')] };
  });

  // "Show all airports" appears only while an airport is isolated and clears the filter.
  await check('actions-show-all-airports', async () => {
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.S.filter = ''; CNSUI.setMode('plan'); return true; })()`);
    const seeded = await ctx.seedNetwork(v2, [{ o: 'EDDM', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freq: 1, per: 'day' }]);
    if (seeded[0].err || seeded[0].added !== 1) throw new Error('seed failed: ' + j(seeded));
    const none = await query(v2, 'show all'); await closePal(v2);
    let st = await query(v2, 'EDDM');
    await runItem(v2, st, /^Isolate EDDM in the network$/);
    await v2.waitFor(`CNSUI.S.mode === 'network' && CNSUI.S.filter === 'EDDM'`, 3000, 30); await v2.sleep(120);
    const iso = await v2s(v2);
    st = await query(v2, 'show all');
    const offered = st.items.map(x => x.label);
    await runItem(v2, st, /^Show all airports$/);
    await v2.waitFor(`CNSUI.S.filter === ''`, 3000, 30); await v2.sleep(150);
    const s = await v2s(v2);
    const again = await query(v2, 'show all'); await closePal(v2);
    await v2.eval(`(function(){ CNSUI.setMode('plan'); return true; })()`);
    if (none.items.some(x => x.label === 'Show all airports')) throw new Error('"Show all airports" offered with no filter: ' + labelsOf(none));
    if (!offered.includes('Show all airports')) throw new Error(`isolated on ${iso.filter} but "Show all airports" missing: ` + j(offered));
    if (s.filter !== '' || s.apRows.length < 2 || s.mode !== 'network') throw new Error(`after "Show all airports": filter="${s.filter}" rows=${j(s.apRows)} mode=${s.mode}`);
    if (again.items.some(x => x.label === 'Show all airports')) throw new Error('"Show all airports" still offered after clearing: ' + labelsOf(again));
    return { detail: `no filter → not offered; Isolate EDDM → rows ${j(iso.apRows)}; "show all" → ${j(offered)}; run → filter="" rows=${j(s.apRows)}; not offered again`, repro: 'v2: seed EDDM→EDDF; ⌘K EDDM → Isolate; ⌘K "show all" → Enter' };
  });

  // Timeline lanes: the label follows S.lanes; the action flips it, opens the drawer and re-renders the Gantt.
  await check('actions-timeline-lanes', async () => {
    await v2.eval(`(function(){ CNSUI.S.lanes = 'airports'; document.querySelector('#drawer').classList.remove('open'); CNSUI.timeline.render(); return true; })()`);
    let st = await query(v2, 'timeline');
    const a = st.items.map(x => x.label);
    await runItem(v2, st, /^Timeline: fleet lanes$/);
    await v2.waitFor(`CNSUI.S.lanes === 'fleet'`, 3000, 30); await v2.sleep(120);
    const s1 = await v2s(v2);
    st = await query(v2, 'timeline');
    const b = st.items.map(x => x.label);
    await runItem(v2, st, /^Timeline: airport lanes$/);
    await v2.waitFor(`CNSUI.S.lanes === 'airports'`, 3000, 30); await v2.sleep(120);
    const s2 = await v2s(v2);
    if (!a.includes('Timeline: fleet lanes') || a.includes('Timeline: airport lanes')) throw new Error('airport lanes: ' + j(a));
    if (!s1.drawer || s1.laneOn.join() !== 'fleet') throw new Error(`after "Timeline: fleet lanes": drawer=${s1.drawer} #laneSeg .on=${j(s1.laneOn)} sub="${s1.drawerSub}"`);
    if (!b.includes('Timeline: airport lanes') || b.includes('Timeline: fleet lanes')) throw new Error('fleet lanes: ' + j(b));
    if (s2.laneOn.join() !== 'airports') throw new Error(`after "Timeline: airport lanes": #laneSeg .on=${j(s2.laneOn)}`);
    return { detail: `${j(a)} → lanes=fleet drawer=${s1.drawer} #laneSeg .on=${j(s1.laneOn)} sub="${s1.drawerSub}"; ${j(b)} → lanes=airports sub="${s2.drawerSub}"`, repro: 'v2: ⌘K timeline → Enter; again' };
  });

  // Advisory report: on an empty network the action toasts; with a network it opens the airport picker (no PDF is generated here).
  await check('actions-report-pick', async () => {
    await v2.eval(`(function(){ CNSUI.modal.close(); CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.setMode('plan'); return true; })()`);
    let st = await query(v2, 'advisory');
    const it = await runItem(v2, st, /^Export advisory report \(PDF\)$/);
    await v2.sleep(150);
    const s1 = await v2s(v2);
    const seeded = await ctx.seedNetwork(v2, [{ o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freq: 1, per: 'day' }]);
    if (seeded[0].err || seeded[0].added !== 1) throw new Error('seed failed: ' + j(seeded));
    st = await query(v2, 'advisory');
    await runItem(v2, st, /^Export advisory report \(PDF\)$/);
    await v2.waitFor(`!document.querySelector('#modal').hidden && document.querySelectorAll('#modalBox input[name=rp]').length > 0`, 3000, 30); await v2.sleep(80);
    const s2 = await v2s(v2);
    await ctx.screenshot(v2, 'actions-report-pick');
    await v2.press('Escape'); await v2.waitFor(`document.querySelector('#modal').hidden`, 2000, 30);
    if (s1.modal || !/Add a route to the network first/.test(s1.toast)) throw new Error(`empty network: modal=${s1.modal} toast="${s1.toast}"`);
    if (!s2.modal || s2.modalTitle !== 'Advisory report' || s2.rpRadios < 1) throw new Error(`with a network: modal=${s2.modal} title="${s2.modalTitle}" radios=${s2.rpRadios}`);
    return { detail: `"${it.label}" (${it.k}) on an empty network → toast "${s1.toast}", no modal; with 1 flight → modal "${s2.modalTitle}" with ${s2.rpRadios} airport radio(s); Escape closes`, repro: 'v2: empty folder, ⌘K advisory → Enter; seed a flight, again', evidence: [ctx.shot('actions-report-pick')] };
  });

  // "Share this route" → POST /api/share (content-addressed, append-only) → a /v2/s/<slug> link on the clipboard that both shells serve.
  await check('actions-share-route', async () => {
    await v2.eval(`(function(){ CNSUI.setMode('plan'); CNSUI.plan.resetForm(); const by = CNSUI.byId(); CNSUI.S.origin = by.EHLE; CNSUI.S.dest = by.EDDF; CNSUI.plan.onFormChange(false); return true; })()`);   // reset empties the route; share needs one
    const since = v2.responses.length; const clip0 = (await v2s(v2)).clipN;
    const st = await query(v2, 'share this');
    const it = await runItem(v2, st, /^Share this route$/);
    const resp = await v2.waitForResponse('/api/share', { since, timeout: 10000, method: 'POST' });
    await v2.waitFor(`__cns.clip.length > ${clip0}`, 5000, 50); await v2.sleep(100);
    const s = await v2s(v2);
    const m = String(s.clip || '').match(/^(http:\/\/127\.0\.0\.1:\d+)\/v2\/s\/([\w-]+)$/);
    if (resp.status >= 300) throw new Error(`POST /api/share → ${resp.status}`);
    if (!m) throw new Error(`clipboard "${s.clip}" is not a 127.0.0.1 /v2/s/<slug> link (toast "${s.toast}")`);
    const v2Get = await fetch(`${ctx.base}/v2/s/${m[2]}`); const v2Html = await v2Get.text();
    const cGet = await fetch(`${ctx.base}/s/${m[2]}`);
    const hasState = /shareState:\s*\{[^\n]*"o":\s*"EHLE"/.test(v2Html);
    if (v2Get.status !== 200 || !hasState) throw new Error(`GET /v2/s/${m[2]} → ${v2Get.status}, shareState with o=EHLE embedded: ${hasState}`);
    if (cGet.status !== 200) throw new Error(`classic GET /s/${m[2]} → ${cGet.status}`);
    return { detail: `"${it.label}" (${it.k}) → POST /api/share ${resp.status}; clipboard ${s.clip}; toast "${s.toast}"; GET /v2/s/${m[2]} → ${v2Get.status} (shareState o=EHLE embedded); classic GET /s/${m[2]} → ${cGet.status}`, repro: 'v2: ⌘K "share this" → Enter; __cns.clip.at(-1); fetch the link' };
  });

  // XLSX on an empty network: the engine alerts (stubbed) instead of throwing.
  await check('actions-xlsx-empty', async () => {
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.setMode('plan'); __cns.alerts.length = 0; return true; })()`);
    const n0 = v2.errors.length; const since = v2.responses.length;
    const st = await query(v2, 'xlsx');
    const it = await runItem(v2, st, /^Export demand workbook \(XLSX\)$/);
    await v2.waitFor(`__cns.alerts.length > 0`, 3000, 50);
    const s = await v2s(v2);
    const ex = v2.errors.slice(n0).filter(e => e.type === 'exception');
    const posted = v2.responses.slice(since).filter(r => /xlsx|spreadsheet/i.test(r.url)).map(r => r.status);
    if (!/at least one flight/i.test(s.alerts.at(-1) || '')) throw new Error(`alert "${s.alerts.at(-1)}"`);
    if (ex.length) throw new Error('exception: ' + ex.map(e => e.text).join(' || '));
    if (posted.length) throw new Error('an export request went out on an empty network: ' + j(posted));
    return { detail: `"${it.label}" (${it.k}) on an empty network → alert "${s.alerts.at(-1)}", no request, no exception`, repro: 'v2: empty folder, ⌘K xlsx → Enter → __cns.alerts' };
  });

  // The classic hand-off is offered (never run here — it navigates away).
  await check('actions-open-classic-offered', async () => {
    const st = await query(v2, 'classic'); await closePal(v2);
    const it = st.items.find(x => x.label === 'Open the classic version');
    if (!it) throw new Error('no "Open the classic version" — ' + labelsOf(st));
    const href = await v2.eval(`(document.querySelector('.v2tag') || {}).getAttribute ? document.querySelector('.v2tag').getAttribute('href') : null`);
    return { detail: `"${it.label}" offered at #${it.i} (not run); topbar .v2tag href=${href}`, repro: 'v2: ⌘K classic → read the list → Escape' };
  });

  // Selecting an aircraft that only carries image_url (13 of 18 on production) must not request /pics/ (classic _planeImg:
  // image_url || /pics/<image> || glyph). Trigger = the palette's aircraft item; the 404 is logged by the shell (plan.js:31).
  await check('aircraft-item-photo', async () => {
    await v2.eval(`(function(){ CNSUI.setMode('plan'); CNSUI.S.planeId = 'beta_alia'; CNSUI.plan.onFormChange(false); return true; })()`); await v2.sleep(200);
    const n0 = v2.errors.length;
    const st = await query(v2, 'era');
    await runItem(v2, st, /^Aircraft: ERA$/);
    await v2.waitFor(`CNSUI.S.planeId === 'aura_era'`, 3000, 30); await v2.sleep(500);
    const s = await v2s(v2);
    const cImg = await classic.eval(`(function(){ try { return _planeImg(BUILTIN_PLANES_BY_ID['aura_era']); } catch (e) { return 'ERR ' + e.message; } })()`);
    const e404 = v2.errors.slice(n0).filter(e => /404/.test(e.text)).map(e => e.url);
    const detail = `"Aircraft: ERA" → plane.image=${j(s.planeImage)} plane.image_url=${j(s.planeImageUrl)}; stage background-image=${s.stageBg}; 404s since: ${j(e404)}; classic _planeImg(aura_era)=${j(cImg)}`;
    if (e404.length || !/plane-images/.test(String(s.stageBg))) throw new Error(`v2 renders the stage from /pics/<image> and ignores image_url (plan.js:31) — ${detail}`);
    return { detail, repro: 'v2: ⌘K era → Enter on "Aircraft: ERA" → getComputedStyle(.ac-stage).backgroundImage, Log 404 entries; classic: _planeImg(BUILTIN_PLANES_BY_ID.aura_era)' };
  });

  // The tour item must be offered but is NEVER executed here (out of scope); the spy proves it was not started.
  await check('actions-tour-not-run', async () => {
    const st = await query(v2, 'tour');
    await ctx.screenshot(v2, 'actions-tour-item');
    const it = st.items.find(x => x.label === 'Take the tour');
    await closePal(v2);                       // Escape — never Enter on this item
    const s = await v2s(v2);
    if (!it) throw new Error('no "Take the tour" item — ' + labelsOf(st));
    if (s.tourCalls !== 0 || s.driver) throw new Error(`tour spy calls=${s.tourCalls} driver DOM=${s.driver}`);
    return { detail: `"${it.label}" offered at #${it.i} (not run); CNSUI.tour.start spy calls=${s.tourCalls}, driver.js DOM present=${s.driver}`, repro: 'v2: ⌘K tour → read the list → Escape (never Enter)', evidence: [ctx.shot('actions-tour-item')] };
  });

  // =============================================================================================
  // 7. mouse path: a REAL click on a rendered item runs it (hover moves the highlight first)
  await check('mouse-click-runs-item', async () => {
    await v2.eval(`(function(){ CNSUI.map.setBase('sat'); return true; })()`);
    await openPal(v2);
    const st = await pal(v2);
    const it = st.items.find(x => x.label === 'Basemap: Light');
    if (!it) throw new Error('no "Basemap: Light" in the default list — ' + labelsOf(st));
    await v2.click(`#cmdkList .it[data-i="${it.i}"]`);
    await v2.waitFor(HIDDEN, 3000, 30); await v2.sleep(100);
    const s = await v2s(v2);
    if (s.base !== 'light' || s.baseOn.join() !== 'light') throw new Error(`after a real click on "${it.label}": base=${s.base} .on=${j(s.baseOn)}`);
    return { detail: `real click on #${it.i} "${it.label}" → palette hidden, S.base=${s.base}, #mapDd .on=${j(s.baseOn)}`, repro: 'v2: ⌘K, Input.dispatchMouseEvent on #cmdkList .it "Basemap: Light"' };
  });

  // CDP stalls seen by the sampler, for the record. Investigated 2026-09-07: the stalls start on the CLASSIC control tab
  // (after setOrigin / on its reload) while v2's main thread is idle (V8 profile: 143.5 s idle of 145 s), the server and
  // the CDNs answer in ms, no dialogs, no pending requests except the stuck navigation — a harness/headless-Chrome
  // problem, not a v2 defect. Informational: it never fails; the numbers go to the report (see harnessGaps).
  await check('renderer-stalls', async () => {
    LIVE.stop();
    const fmtS = s => `${s.page} ${(s.ms / 1000).toFixed(1)} s during "${s.during}"${s.until !== s.during ? ` … "${s.until}"` : ''}${s.open ? ' (still blocked)' : ''}`;
    const big = LIVE.stalls.filter(s => s.ms > 5000);
    const detail = `${LIVE.stalls.length} stall(s), ${big.length} over 5 s: [${big.map(fmtS).join('; ')}]; all: ${j(LIVE.stalls.map(s => [s.page, s.ms, s.during]))}`;
    return { detail, repro: 'probe each tab every second with Runtime.evaluate("1") raced against 1.5 s while the scenario runs' };
  });

  await check('no-exceptions', async () => {
    const ex = [...ctx.exceptions(v2), ...ctx.exceptions(classic)];
    const s = await v2s(v2);
    const by = {}; for (const e of v2.errors) { const k = `${e.type} ${e.url || ''}`.trim(); by[k] = (by[k] || 0) + 1; }
    if (ex.length) throw new Error(ex.map(e => e.text).join(' || '));
    if (s.tourCalls) throw new Error('tour spy was called ' + s.tourCalls + '×');
    return `v2 errors ${v2.errors.length} (${j(by)}), classic errors ${classic.errors.length} (exceptions 0, tour spy calls ${s.tourCalls})`;
  });
}
