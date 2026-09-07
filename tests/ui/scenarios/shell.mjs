/* Shell: units toggle in both shells, route share create/open (v2 + classic), build share round-trip,
   every deep link (never #tour), the welcome flag in both shells, the export menu on an empty network,
   and the boot-failure path. The classic shell is the behavioural spec; the production catalog is the data.

   Run: node tests/ui/run.mjs shell [--only <check>]   (check names below; --only is a substring filter). */
import { BLOCK_PATTERNS, Page } from '../cdp.mjs';
export const component = 'shell';
export const module = 'shell';

// ---------------------------------------------------------------------------------------------
// Helpers the harness lacks (reported under harnessGaps):
//  * a toast recorder — UI.toast() lives 2.2 s in #toast and CNSShare.toast() in a lazily created
//    .cns-share-toast; a MutationObserver installed as an extra new-document script records every show
//    into window.__toasts, so a check can assert a toast it could not have polled in time.
//  * openV2(): newPage + recorder + goto (ctx.v2Page cannot install anything between newPage and goto).
//  * closePage(): Target.closeTarget (Page has no close()).
//  * reloadKeepingWelcomeFlag(): the harness seed writes cns_welcome_hide on EVERY navigation, so a
//    reload that must observe the flag the user just wrote needs a seed that leaves that key alone.
const TOAST_RECORDER = `(function () {
  window.__toasts = [];
  const rec = (kind, text) => { text = String(text || '').trim(); if (!text) return; const last = __toasts[__toasts.length - 1];
    if (last && last.kind === kind && last.text === text && Date.now() - last.t < 250) return; __toasts.push({ kind, text, t: Date.now() }); };
  const watch = (el, kind) => { if (!el || el.__cnsWatched) return; el.__cnsWatched = true; if (el.classList.contains('show')) rec(kind, el.textContent);
    new MutationObserver(() => { if (el.classList.contains('show')) rec(kind, el.textContent); }).observe(el, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true }); };
  document.addEventListener('DOMContentLoaded', () => {
    watch(document.getElementById('toast'), 'v2');
    document.querySelectorAll('.cns-share-toast').forEach(el => watch(el, 'share'));
    new MutationObserver(() => document.querySelectorAll('.cns-share-toast').forEach(el => watch(el, 'share'))).observe(document.body, { childList: true });
  });
})();`;
async function installToastRecorder(page) { await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TOAST_RECORDER }); }
const toasts = page => page.eval('(window.__toasts || []).map(t => ({ kind: t.kind, text: t.text }))');
async function waitToast(page, re, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const l = await toasts(page); const hit = l.find(t => re.test(t.text)); if (hit) return hit; await page.sleep(100); }
  return null;
}
async function openV2(ctx, browser, { label = 'v2', hash, seedLocalStorage, url, boot = 'v2', timeout } = {}) {
  const p = await browser.newPage(label); await installToastRecorder(p); ctx.pages.push(p);
  await p.goto(url || (ctx.base + '/v2'), { hash, seedLocalStorage, boot, timeout });
  return p;
}
async function openClassic(ctx, browser, { label = 'classic', url, seedLocalStorage, hash, timeout } = {}) {
  const p = await browser.newPage(label); await installToastRecorder(p); ctx.pages.push(p);
  await p.goto(url || (ctx.base + '/?desktop=1'), { hash, seedLocalStorage, boot: 'classic', timeout });
  return p;
}
async function closePage(ctx, page) {
  try { await page.browser.send('Target.closeTarget', { targetId: page.targetId }); } catch (e) {}
  const i = ctx.pages.indexOf(page); if (i >= 0) ctx.pages.splice(i, 1);
  (ctx.state.closedPages = ctx.state.closedPages || []).push(page);
}
async function reloadKeepingWelcomeFlag(page) {
  const seed = Page.seedScript({}).replace(/localStorage\.setItem\("cns_welcome_hide"[^;]*;/, '');
  if (seed.includes('cns_welcome_hide')) throw new Error('harness: could not strip cns_welcome_hide from the seed script');
  await page.seed(seed);
  const loaded = page.once('Page.loadEventFired', 25000);
  await page.send('Page.reload', { ignoreCache: true });
  await loaded;
  await page.waitFor(Page.BOOT.v2, 25000, 100);
  await page.eval(Page.MAP_HOOK);
}
async function openMenu(page, btn, dd) { await page.click(btn); await page.waitFor(`document.querySelector(${JSON.stringify(dd)}).classList.contains('open')`, 2000, 50); }
const j = v => JSON.stringify(v);

// ---- state readers -------------------------------------------------------------------------
const V2_STATE = `(function(){ const S = CNSUI.S, D = window.CNS_DATA || {}; return { o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, stops: S.stops.filter(Boolean).map(a => a.ident),
  plane: S.planeId, charger: S.chargerId, trip: S.trip, freq: S.freq, per: S.per, rail: S.rail, mode: S.mode, hasProfile: !!S.profile, err: S.err || '',
  legs: S.result && (Array.isArray(S.result.legs) ? S.result.legs.length : S.result.legs), distKm: S.result && S.result.total_distance_km, resultPlane: S.result && S.result.plane && S.result.plane.id, resultCharger: S.result && S.result.charger && S.result.charger.id,
  shareV: D.shareState ? D.shareState.v : null, shareK: D.shareState ? (D.shareState.k || null) : null, shareNull: D.shareState === null,
  netCount: (document.querySelector('#netCount') || { textContent: '' }).textContent.trim(), folder: window.CNSDemand ? CNSDemand.loadFolder().length : null,
  bodyNet: document.body.classList.contains('net'), railWide: document.querySelector('#rail').classList.contains('wide'), modalOpen: !document.querySelector('#modal').hidden,
  drawerOpen: document.querySelector('#drawer').classList.contains('open'), lanes: S.lanes, filter: S.filter, openAp: Object.keys(S.openAp || {}).filter(k => S.openAp[k]), acFilterOpen: !!S.acFilterOpen,
  acPop: !!document.querySelector('.ac-pop'), ms: !!document.querySelector('#modalBox .ms'), welcomeHide: !!document.querySelector('#welcomeHide'), apRows: document.querySelectorAll('#railBody .ap').length,
  units: localStorage.getItem('cns_units'), toasts: (window.__toasts || []).map(t => t.text) }; })()`;
const CLASSIC_STATE = `(function(){ const v = id => { const e = document.getElementById(id); return e ? e.value : null; }; const R = (typeof lastResult !== 'undefined') ? lastResult : undefined;
  return { o: selected.origin && selected.origin.ident, d: selected.destination && selected.destination.ident, stops: [...document.querySelectorAll('#stopsContainer .stop-input')].map(i => i.dataset.ident).filter(Boolean),
    plane: v('plane'), charger: v('charger'), trip: v('tripType'), freqN: v('freqN'), freqUnit: v('freqUnit'), hasResult: !!R, lastPlane: R && R.plane && R.plane.id, lastCharger: R && R.charger && R.charger.id, lastTrip: R && R.trip_type,
    legs: R && (Array.isArray(R.legs) ? R.legs.length : R.legs), distKm: R && R.total_distance_km, resultShown: !document.getElementById('result').classList.contains('d-none'), folder: CNSDemand.loadFolder().length, units: CNSUnits.get(),
    psRange: (document.getElementById('psRange') || { textContent: '' }).textContent.trim(), unitToggle: !!(document.getElementById('unitToggle') || {}).checked,
    welcome: !!document.querySelector('#welcomeModal.show'), dontShow: !!(document.getElementById('welcomeDontShow') || {}).checked, share: window.__CNS_SHARE__ ? (window.__CNS_SHARE__.k || 'route') : null }; })()`;
const ROUTE_D = `[...document.querySelectorAll('#railBody .route .stop .d')].map(e => e.textContent.trim())`;

// ---------------------------------------------------------------------------------------------
export default async function run(ctx) {
  const base = ctx.base;
  const bA = await ctx.browser();
  const v2 = await openV2(ctx, bA, { label: 'v2' });
  const classic = await openClassic(ctx, bA, { label: 'classic' });
  const seedApi = { origin: { ident: 'EHLE', name: 'Lelystad', lat: 52.4603, lon: 5.5272 }, destination: { ident: 'EDDF', name: 'Frankfurt', lat: 50.0333, lon: 8.5706 }, charger_id: 'dc_320', trip_type: 'one-way' };

  // =============================================================================================
  // 1. units — [data-u=nm] → cns_units 'nautical', .route .d shows NM, the classic shows NM (after a
  //    reload: neither shell listens to `storage`); back to km.
  await ctx.check('units-toggle', async () => {
    const before = await v2.eval(ROUTE_D);
    if (!before.some(t => / km$/.test(t))) throw new Error('precondition: no ".route .stop .d" showing km in the form rail — ' + j(before));
    await v2.click('#unitSeg [data-u=nm]');
    await v2.waitFor(`localStorage.getItem('cns_units') === 'nautical'`, 2000, 50);
    await v2.sleep(200);
    const nm = await v2.eval(`({ raw: localStorage.getItem('cns_units'), get: CNSUnits.get(), on: [...document.querySelectorAll('#unitSeg button.on')].map(b => b.dataset.u), d: ${ROUTE_D}, spec: (document.querySelector('#railBody .sp') || { textContent: '' }).textContent.trim() })`);
    const classicLive = await classic.eval(`({ units: CNSUnits.get(), unitToggle: !!document.getElementById('unitToggle').checked, psRange: document.getElementById('psRange').textContent.trim() })`);
    await classic.reload({ boot: 'classic' });
    const classicNm = await classic.eval(CLASSIC_STATE);
    await ctx.screenshot(v2, 'units-nm'); await ctx.screenshot(classic, 'units-nm-classic');
    const kmVal = ctx.num(before.find(t => / km$/.test(t))), nmVal = ctx.num((nm.d.find(t => / NM$/.test(t)) || ''));
    const problems = [];
    if (nm.raw !== 'nautical') problems.push(`cns_units=${nm.raw}`);
    if (!nm.d.some(t => / NM$/.test(t)) || nm.d.some(t => / km$/.test(t))) problems.push(`.route .d after nm: ${j(nm.d)}`);
    if (!nm.on.includes('nm') || nm.on.includes('km')) problems.push(`unitSeg .on = ${j(nm.on)}`);
    if (Number.isFinite(kmVal) && Number.isFinite(nmVal) && Math.abs(nmVal - kmVal / 1.852) > 1.01) problems.push(`NM value ${nmVal} vs km ${kmVal} / 1.852 = ${(kmVal / 1.852).toFixed(1)}`);
    if (classicNm.units !== 'nautical' || !classicNm.unitToggle || !/ NM$/.test(classicNm.psRange)) problems.push(`classic after reload: units=${classicNm.units} toggle=${classicNm.unitToggle} psRange="${classicNm.psRange}"`);
    // back to km
    await v2.click('#unitSeg [data-u=km]');
    await v2.waitFor(`localStorage.getItem('cns_units') === 'metric'`, 2000, 50);
    await v2.sleep(200);
    const km = await v2.eval(`({ raw: localStorage.getItem('cns_units'), on: [...document.querySelectorAll('#unitSeg button.on')].map(b => b.dataset.u), d: ${ROUTE_D} })`);
    await classic.reload({ boot: 'classic' });
    const classicKm = await classic.eval(CLASSIC_STATE);
    if (km.raw !== 'metric' || !km.d.some(t => / km$/.test(t)) || km.d.some(t => / NM$/.test(t))) problems.push(`back to km: cns_units=${km.raw} .route .d=${j(km.d)}`);
    if (classicKm.units !== 'metric' || classicKm.unitToggle || !/ km$/.test(classicKm.psRange)) problems.push(`classic after km reload: units=${classicKm.units} toggle=${classicKm.unitToggle} psRange="${classicKm.psRange}"`);
    if (problems.length) throw new Error(problems.join(' | '));
    return { detail: `v2 .route .d km=${j(before)} → nm=${j(nm.d)} → km=${j(km.d)}; unitSeg.on nm=${j(nm.on)} km=${j(km.on)}; spec line (nm) "${nm.spec}"; classic LIVE (no storage listener in either shell): units=${classicLive.units} psRange="${classicLive.psRange}"; classic after reload: nm psRange="${classicNm.psRange}" toggle=${classicNm.unitToggle} → km psRange="${classicKm.psRange}" toggle=${classicKm.unitToggle}`,
      repro: 'v2: real click #unitSeg [data-u=nm]; read localStorage.cns_units + .route .stop .d; reload the classic tab (same profile) and read CNSUnits.get()/#unitToggle/#psRange; click [data-u=km]; repeat',
      evidence: [ctx.shot('units-nm'), ctx.shot('units-nm-classic')] };
  }, { retry: 0 });

  // The classic rounds distances UP (CNSUnits.r = ceil, used by fmtDist in every leg list); v2's fmt.dist
  // rounds half-up — same page, same input, two formatters.
  await ctx.check('units-rounding-parity', async () => {
    const rows = await v2.eval(`[343.01, 185.2, 100.2, 250.5, 0.4].map(x => ({ x, v2: CNSUI.fmt.dist(x), classic: CNSUnits.fmtDist(x) }))`);
    const bad = rows.filter(r => r.v2 !== r.classic);
    const detail = rows.map(r => `${r.x}: v2 "${r.v2}" classic "${r.classic}"`).join('; ');
    if (bad.length) throw new Error(`${bad.length}/${rows.length} sample distances differ between CNSUI.fmt.dist (Math.round) and CNSUnits.fmtDist (ceil) — ${detail}`);
    return { detail, repro: 'v2 console: [343.01,185.2].map(x => [CNSUI.fmt.dist(x), CNSUnits.fmtDist(x)])' };
  });

  // =============================================================================================
  // 2. export menu on an EMPTY network (fresh profile → empty folder)
  await ctx.check('export-menu-empty-pdf', async () => {
    const folder = await v2.eval('CNSDemand.loadFolder().length'); if (folder) throw new Error('precondition: folder not empty (' + folder + ')');
    await openMenu(v2, '#expBtn', '#expDd');
    const exBefore = v2.exceptions().length;
    await v2.click('#expDd [data-exp=pdf]');
    const hit = await waitToast(v2, /Add a route to the network first/, 2500);
    const st = await v2.eval(`({ modalOpen: !document.querySelector('#modal').hidden, modalHtml: document.querySelector('#modalBox').innerHTML.slice(0, 80), ddOpen: document.querySelector('#expDd').classList.contains('open') })`);
    await ctx.screenshot(v2, 'export-pdf-empty');
    const ex = v2.exceptions().slice(exBefore);
    if (ex.length) throw new Error('exception: ' + ex.map(e => e.text).join(' || '));
    if (!hit) throw new Error(`no "Add a route to the network first" toast — toasts=${j(await toasts(v2))} modalOpen=${st.modalOpen}`);
    if (st.modalOpen) throw new Error('the airport-pick dialog opened on an empty network: ' + st.modalHtml);
    return { detail: `toast "${hit.text}"; modalOpen=${st.modalOpen}; menu closed=${!st.ddOpen}`, repro: 'v2 fresh profile: click #expBtn, click [data-exp=pdf]', evidence: [ctx.shot('export-pdf-empty')] };
  }, { retry: 0 });

  await ctx.check('export-menu-empty-xlsx', async () => {
    await openMenu(v2, '#expBtn', '#expDd');
    const alerts0 = await v2.eval('__cns.alerts.length'); const since = v2.responses.length; const exBefore = v2.exceptions().length;
    await v2.click('#expDd [data-exp=xlsx]');
    let resp = null; try { resp = await v2.waitForResponse('/api/report.xlsx', { since, timeout: 2500, method: 'POST' }); } catch (e) {}
    const alerts = await v2.eval('__cns.alerts.slice(' + alerts0 + ')');
    const ex = v2.exceptions().slice(exBefore);
    await ctx.screenshot(v2, 'export-xlsx-empty');
    if (ex.length) throw new Error('exception: ' + ex.map(e => e.text).join(' || '));
    if (!alerts.length && !resp) throw new Error('neither the classic\'s alert nor a POST /api/report.xlsx response within 2.5 s — toasts=' + j(await toasts(v2)));
    return { detail: `alert=${j(alerts)}; server=${resp ? resp.status + ' ' + resp.url : 'no request'}`, repro: 'v2 fresh profile: click #expBtn, click [data-exp=xlsx]', evidence: [ctx.shot('export-xlsx-empty')] };
  }, { retry: 0 });

  // Gap: the build link on an empty network answers through CNSShare.toast → .cns-share-toast, which the classic
  // styles (index.html:588) and desktop.css does not. The message must be visible to a human.
  await ctx.check('export-menu-empty-build', async () => {
    await openMenu(v2, '#expBtn', '#expDd');
    const since = v2.responses.length; const exBefore = v2.exceptions().length;
    await v2.click('#expDd [data-exp=build]');
    const hit = await waitToast(v2, /Add at least one flight before sharing a build/, 2500);
    const vis = await v2.eval(`(function(){ const el = document.querySelector('.cns-share-toast'); if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = (r.width && r.height) ? document.elementFromPoint(cx, cy) : null; const tag = e => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '') : null;
      let styled = false; try { styled = [...document.styleSheets].some(s => { try { return [...s.cssRules].some(rl => rl.selectorText && rl.selectorText.includes('cns-share-toast')); } catch (e) { return false; } }); } catch (e) {}
      return { text: el.textContent, show: el.classList.contains('show'), position: cs.position, opacity: cs.opacity, zIndex: cs.zIndex, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth, top: tag(top), covered: !!top && top !== el && !el.contains(top), pointerEvents: cs.pointerEvents, styled }; })()`);
    const posted = v2.responses.slice(since).filter(r => r.url.includes('/api/share'));
    const ex = v2.exceptions().slice(exBefore);
    await ctx.screenshot(v2, 'export-build-empty');
    if (ex.length) throw new Error('exception: ' + ex.map(e => e.text).join(' || '));
    if (posted.length) throw new Error('POST /api/share was sent for an empty network');
    if (!hit || !vis) throw new Error(`no "Add at least one flight before sharing a build." message — toasts=${j(await toasts(v2))} el=${j(vis)}`);
    const visible = vis.show && +vis.opacity > 0 && vis.inViewport && (vis.pointerEvents === 'none' || !vis.covered) && (vis.position === 'fixed' || vis.position === 'absolute');
    if (!visible) throw new Error(`.cns-share-toast exists with text "${vis.text}" but is not visible: position=${vis.position} opacity=${vis.opacity} z=${vis.zIndex} rect=${j(vis.rect)} inViewport=${vis.inViewport} covered=${vis.covered} (top=${vis.top}) styled=${vis.styled} — the classic styles it (index.html:588), desktop.css has no .cns-share-toast rule`);
    return { detail: `toast "${hit.text}" visible: ${j(vis)}`, repro: 'v2 fresh profile: click #expBtn, click [data-exp=build]; inspect .cns-share-toast', evidence: [ctx.shot('export-build-empty')] };
  }, { retry: 0 });

  // Gap: the menu's "Share this route" works from the FORM state too (no result yet).
  await ctx.check('export-menu-share-form', async () => {
    const st0 = await v2.eval(V2_STATE);
    await openMenu(v2, '#expBtn', '#expDd');
    const since = v2.responses.length; const clip0 = await v2.eval('__cns.clip.length');
    await v2.click('#expDd [data-exp=share]');
    const resp = await v2.waitForResponse('/api/share', { since, timeout: 8000, method: 'POST' });
    const body = JSON.parse(String(await v2.responseBody(resp.requestId)));
    await v2.waitFor(`__cns.clip.length > ${clip0}`, 3000, 50);
    const clip = await v2.eval('__cns.clip.at(-1)');
    const hit = await waitToast(v2, /Link copied/, 2000);
    if (resp.status !== 200) throw new Error(`POST /api/share → ${resp.status} ${j(body)}`);
    if (!clip.includes('/v2/s/' + body.slug)) throw new Error(`clipboard "${clip}" does not contain /v2/s/${body.slug}`);
    if (!hit) throw new Error('no "Link copied" toast — ' + j(await toasts(v2)));
    return { detail: `rail=${st0.rail}; POST /api/share ${resp.status} slug=${body.slug}; clipboard=${clip}; toast "${hit.text}"`, repro: 'v2 form state: click #expBtn, click [data-exp=share]' };
  }, { retry: 0 });

  // =============================================================================================
  // 3. route share: create in v2 (real click on the result's [data-act=share]) → open /v2/s/<slug> in a
  //    fresh page → open /s/<slug> in the classic. Non-default everything so a restore is provable.
  const ROUTE = { o: 'EHRD', stops: ['EHLE'], d: 'EDDH', plane: 'elysian_e9x', charger: 'dc_2400', trip: 'one-way', freq: 3, per: 'week' };
  await ctx.check('share-create-open-post', async () => {
    const set = await v2.eval(`(function(){ const S = CNSUI.S, by = CNSUI.byId(), R = ${j(ROUTE)}; if (!by[R.o] || !by[R.d] || !R.stops.every(s => by[s])) return 'unknown airport';
      if (!CNSUI.PLANES.find(p => p.id === R.plane)) return 'unknown plane ' + R.plane; if (!CNSUI.CHARGERS.find(c => c.id === R.charger)) return 'unknown charger ' + R.charger;
      S.origin = by[R.o]; S.dest = by[R.d]; S.stops = R.stops.map(s => by[s]); S.planeId = R.plane; S.chargerId = R.charger; S.trip = R.trip; S.freq = R.freq; S.per = R.per; if (S.blacklist) S.blacklist.clear(); S.divertOverrides = {};
      CNSUI.plan.onFormChange(true); return null; })()`);
    if (set) throw new Error('precondition: ' + set);
    const sim = await ctx.v2Simulate(v2);
    if (sim.err) throw new Error('simulate failed: ' + sim.err);
    const st = await v2.eval(V2_STATE); ctx.state.routeState = st;
    const since = v2.responses.length; const clip0 = await v2.eval('__cns.clip.length');
    await v2.click('[data-act=share]');
    const resp = await v2.waitForResponse('/api/share', { since, timeout: 8000, method: 'POST' });
    const body = JSON.parse(String(await v2.responseBody(resp.requestId)));
    await v2.waitFor(`__cns.clip.length > ${clip0}`, 3000, 50);
    const clip = await v2.eval('__cns.clip.at(-1)');
    const hit = await waitToast(v2, /Link copied/, 2000);
    await ctx.screenshot(v2, 'share-create');
    if (resp.status !== 200 || !body.slug) throw new Error(`POST /api/share → ${resp.status} ${j(body)}`);
    if (!clip.startsWith('http://127.0.0.1') || !clip.includes('/v2/s/' + body.slug)) throw new Error(`clipboard "${clip}" is not the /v2/s/${body.slug} link`);
    ctx.state.share = { slug: body.slug, url: clip, serverUrl: body.url };
    if (!hit) throw new Error('no "Link copied" toast — ' + j(await toasts(v2)));
    return { detail: `state ${j({ o: st.o, stops: st.stops, d: st.d, plane: st.plane, charger: st.charger, trip: st.trip, freq: st.freq, per: st.per, legs: st.legs, distKm: st.distKm })}; POST /api/share ${resp.status} → ${body.url}; clipboard ${clip}; toast "${hit.text}"`,
      repro: 'v2: set EHRD → EHLE → EDDH, elysian_e9x, dc_2400, 3/week; real click [data-act=simulate] then [data-act=share]', evidence: [ctx.shot('share-create')] };
  }, { retry: 0 });

  await ctx.check('share-create-open-v2', async () => {
    if (!ctx.state.share) throw new Error('needs share-create-open-post (run with --only share-create)');
    const st0 = ctx.state.routeState;
    const p = await openV2(ctx, bA, { label: 'v2-share', url: ctx.state.share.url, timeout: 30000 }); ctx.state.sharePage = p;
    await p.waitFor(`(CNSUI.S.rail === 'result' && !!CNSUI.S.profile) || !!CNSUI.S.err`, 20000, 100);
    const hit = await waitToast(p, /Shared route opened|share link could not be opened/, 3000);
    const st = await p.eval(V2_STATE);
    await ctx.screenshot(p, 'share-open-v2');
    const diff = ['o', 'd', 'plane', 'charger', 'trip', 'freq', 'per'].filter(k => st[k] !== st0[k]).map(k => `${k}: ${j(st[k])} ≠ ${j(st0[k])}`);
    if (j(st.stops) !== j(st0.stops)) diff.push(`stops ${j(st.stops)} ≠ ${j(st0.stops)}`);
    if (st.shareV !== 1) diff.push(`CNS_DATA.shareState.v = ${j(st.shareV)}`);
    if (st.rail !== 'result' || !st.hasProfile) diff.push(`rail=${st.rail} profile=${st.hasProfile} err="${st.err}"`);
    if (st.legs !== st0.legs || !ctx.close(st.distKm, st0.distKm, 0.5)) diff.push(`result legs/dist ${st.legs}/${st.distKm} ≠ ${st0.legs}/${st0.distKm}`);
    if (!hit || !/Shared route opened/.test(hit.text)) diff.push(`toast: ${hit ? hit.text : 'none'} (all: ${j(st.toasts)})`);
    const ex = p.exceptions(); if (ex.length) diff.push('exceptions: ' + ex.map(e => e.text).join(' || '));
    if (diff.length) throw new Error(diff.join(' | '));
    return { detail: `${ctx.state.share.url} → shareState.v=${st.shareV}, ${st.o} → ${st.stops.join(' → ')} → ${st.d}, ${st.plane}, ${st.charger}, ${st.trip}, ${st.freq}/${st.per}, rail=${st.rail}, legs=${st.legs}, dist=${st.distKm}, toast "${hit.text}"`,
      repro: 'open the copied /v2/s/<slug> in a fresh tab', evidence: [ctx.shot('share-open-v2')] };
  }, { retry: 0 });

  await ctx.check('share-create-open-classic', async () => {
    if (!ctx.state.share) throw new Error('needs share-create-open-post (run with --only share-create)');
    const st0 = ctx.state.routeState;
    await classic.goto(base + '/s/' + ctx.state.share.slug, { boot: 'classic', timeout: 30000 });
    await classic.waitFor(`!!lastResult && !document.getElementById('result').classList.contains('d-none')`, 20000, 100);
    const st = await classic.eval(CLASSIC_STATE);
    await ctx.screenshot(classic, 'share-open-classic');
    const diff = [];
    if (st.share !== 'route') diff.push('window.__CNS_SHARE__ missing');
    if (st.o !== st0.o || st.d !== st0.d) diff.push(`route ${st.o} → ${st.d} ≠ ${st0.o} → ${st0.d}`);
    if (j(st.stops) !== j(st0.stops)) diff.push(`stops ${j(st.stops)} ≠ ${j(st0.stops)}`);
    if (st.plane !== st0.plane || st.lastPlane !== st0.plane) diff.push(`plane #plane=${st.plane} lastResult=${st.lastPlane} ≠ ${st0.plane}`);
    if (st.charger !== st0.charger || st.lastCharger !== st0.charger) diff.push(`charger #charger=${st.charger} lastResult=${st.lastCharger} ≠ ${st0.charger}`);
    if (st.trip !== st0.trip || st.lastTrip !== st0.trip) diff.push(`trip ${st.trip}/${st.lastTrip} ≠ ${st0.trip}`);
    if (String(st.freqN) !== String(st0.freq) || st.freqUnit !== st0.per) diff.push(`freq ${st.freqN}/${st.freqUnit} ≠ ${st0.freq}/${st0.per}`);
    if (st.legs !== st0.legs || !ctx.close(st.distKm, st0.distKm, 0.5)) diff.push(`lastResult legs/dist ${st.legs}/${st.distKm} ≠ v2 ${st0.legs}/${st0.distKm}`);
    const ex = ctx.exceptions(classic); if (ex.length) diff.push('exceptions: ' + ex.map(e => e.text).join(' || '));
    if (diff.length) throw new Error(diff.join(' | '));
    return { detail: `/s/${ctx.state.share.slug} → ${st.o} → ${st.stops.join(' → ')} → ${st.d}, #plane=${st.plane}, #charger=${st.charger}, trip=${st.trip}, ${st.freqN}/${st.freqUnit}, lastResult plane=${st.lastPlane} legs=${st.legs} dist=${st.distKm} (v2 ${st0.legs}/${st0.distKm})`,
      repro: 'classic: open /s/<slug> (same slug), read selected.*, #plane/#charger/#tripType/#freqN/#freqUnit, lastResult', evidence: [ctx.shot('share-open-classic')] };
  }, { retry: 0 });

  await ctx.check('share-unknown-slug', async () => {
    const p = await openV2(ctx, bA, { label: 'v2-badslug', url: base + '/v2/s/no-such-slug-r1-0904' });
    await p.sleep(1200);
    const st = await p.eval(V2_STATE);
    const ex = p.exceptions();
    await closePage(ctx, p);
    if (!st.shareNull) throw new Error('CNS_DATA.shareState is not null for an unknown slug: ' + j(st.shareV));
    if (st.o !== 'EHLE' || st.d !== 'EDDF') throw new Error(`default route not applied: ${st.o} → ${st.d}`);
    if (ex.length) throw new Error('exceptions: ' + ex.map(e => e.text).join(' || '));
    return { detail: `shareState=null, default route ${st.o} → ${st.d}, toasts=${j(st.toasts)} (the classic shows no notice either: index.html:6644 falls through to _applyDefaultFlight)`, repro: 'open /v2/s/no-such-slug' };
  }, { retry: 0 });

  // =============================================================================================
  // 4. build share: 2 flights → [data-exp=build] → open the link in a FRESH profile (empty folder) →
  //    folder length 2, Network mode, toast. Then the classic opens the same /s/<slug> (another fresh profile).
  await ctx.check('build-share-create', async () => {
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); if (CNSUI.S.mode !== 'plan') CNSUI.setMode('plan'); CNSUI.S.rail = 'form'; CNSUI.render(); return true; })()`);
    const seeded = await ctx.seedNetwork(v2, [{ o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freq: 2, per: 'day' }, { o: 'EHAM', d: 'EDDL', plane: 'elysian_e9x', charger: 'dc_2400', trip: 'retour', freq: 1, per: 'day' }]);
    const bad = seeded.filter(r => r.err || r.added !== 1); if (bad.length) throw new Error('seed failed: ' + j(bad));
    const folder = await v2.eval('CNSDemand.loadFolder().length'); if (folder !== 2) throw new Error('folder length ' + folder);
    ctx.state.buildFolder = await v2.eval(`CNSDemand.loadFolder().map(t => ({ id: t.id, o: t.originIdent, d: t.destIdent, plane: t.planeId, charger: t.chargerId, trip: t.tripType, freqN: t.freqN, freqUnit: t.freqUnit }))`);
    await openMenu(v2, '#expBtn', '#expDd');
    const since = v2.responses.length; const clip0 = await v2.eval('__cns.clip.length'); const t0 = await v2.eval('(window.__toasts || []).length');
    await v2.click('#expDd [data-exp=build]');
    const resp = await v2.waitForResponse('/api/share', { since, timeout: 8000, method: 'POST' });
    const body = JSON.parse(String(await v2.responseBody(resp.requestId)));
    await v2.waitFor(`__cns.clip.length > ${clip0}`, 3000, 50);
    const clip = await v2.eval('__cns.clip.at(-1)');
    await v2.sleep(400);
    const tl = (await toasts(v2)).slice(t0); ctx.state.buildToasts = tl;
    await ctx.screenshot(v2, 'build-share-create');
    if (resp.status !== 200 || !body.slug) throw new Error(`POST /api/share → ${resp.status} ${j(body)}`);
    if (!clip.includes('/v2/s/' + body.slug)) throw new Error(`clipboard "${clip}" is not the /v2/s/${body.slug} link`);
    ctx.state.build = { slug: body.slug, url: clip };
    if (!tl.some(t => /Build link copied/.test(t.text))) throw new Error('no "Build link copied" toast — ' + j(tl));
    return { detail: `folder ${j(ctx.state.buildFolder)}; POST /api/share ${resp.status} slug=${body.slug}; clipboard ${clip}; toasts after click ${j(tl)}`, repro: 'v2: seed 2 flights, click #expBtn, click [data-exp=build]', evidence: [ctx.shot('build-share-create')] };
  }, { retry: 0 });

  await ctx.check('build-share-toast-once', async () => {
    const tl = ctx.state.buildToasts; if (!tl) throw new Error('needs build-share-create');
    const n = tl.filter(t => /Build link copied/.test(t.text));
    if (n.length !== 1) throw new Error(`"Build link copied" shown ${n.length}× (${n.map(t => t.kind).join(' + ')}) — ui/share.js copyBuildLink toasts in its writeText dep AND buildshare.js toasts after writeText`);
    return { detail: 'one toast: ' + j(n) };
  }, { retry: 0 });

  await ctx.check('build-share-open-v2', async () => {
    if (!ctx.state.build) throw new Error('needs build-share-create (run with --only build-share)');
    const bB = await ctx.browser();
    const p = await openV2(ctx, bB, { label: 'v2-build', url: ctx.state.build.url, timeout: 40000 });
    const folder0 = await p.eval('CNSDemand.loadFolder().length');
    await p.waitFor(`CNSUI.S.mode === 'network' && CNSDemand.loadFolder().length >= 2`, 25000, 150);
    await p.sleep(500);
    const hit = await waitToast(p, /Build restored — \d+ routes/, 3000);
    const st = await p.eval(V2_STATE);
    const flights = await p.eval(`CNSDemand.loadFolder().map(t => ({ id: t.id, o: t.originIdent, d: t.destIdent, plane: t.planeId, charger: t.chargerId, trip: t.tripType, freqN: t.freqN, freqUnit: t.freqUnit }))`);
    await ctx.screenshot(p, 'build-share-open-v2');
    const diff = [];
    if (st.shareV !== 1 || st.shareK !== 'build') diff.push(`shareState v=${st.shareV} k=${st.shareK}`);
    if (st.folder !== 2) diff.push(`folder length ${st.folder}`);
    if (st.mode !== 'network' || !st.bodyNet) diff.push(`mode=${st.mode} body.net=${st.bodyNet}`);
    if (st.netCount !== '2') diff.push(`#netCount "${st.netCount}"`);
    if (j(flights) !== j(ctx.state.buildFolder)) diff.push(`restored flights ${j(flights)} ≠ shared ${j(ctx.state.buildFolder)}`);
    if (!hit) diff.push(`no "Build restored — N routes" toast (toasts: ${j(st.toasts)})`);
    const ex = p.exceptions(); if (ex.length) diff.push('exceptions: ' + ex.map(e => e.text).join(' || '));
    if (diff.length) throw new Error(diff.join(' | '));
    return { detail: `fresh profile (folder before restore ${folder0}) → folder ${st.folder}, mode ${st.mode}, #netCount ${st.netCount}, .ap rows ${st.apRows}, toast "${hit.text}", flights ${j(flights)}`, repro: 'open the copied /v2/s/<slug> build link in a fresh Chrome profile', evidence: [ctx.shot('build-share-open-v2')] };
  }, { retry: 0 });

  await ctx.check('build-share-open-classic', async () => {
    if (!ctx.state.build) throw new Error('needs build-share-create (run with --only build-share)');
    const bC = await ctx.browser();
    const p = await openClassic(ctx, bC, { label: 'classic-build', url: base + '/s/' + ctx.state.build.slug, timeout: 40000 });
    await p.waitFor(`CNSDemand.loadFolder().length >= 2`, 25000, 150);
    await p.sleep(500);
    const st = await p.eval(CLASSIC_STATE);
    const flights = await p.eval(`CNSDemand.loadFolder().map(t => ({ id: t.id, o: t.originIdent, d: t.destIdent, plane: t.planeId, charger: t.chargerId, trip: t.tripType, freqN: t.freqN, freqUnit: t.freqUnit }))`);
    await ctx.screenshot(p, 'build-share-open-classic');
    const diff = [];
    if (st.share !== 'build') diff.push('window.__CNS_SHARE__.k ≠ build');
    if (st.folder !== 2) diff.push(`folder length ${st.folder}`);
    if (j(flights) !== j(ctx.state.buildFolder)) diff.push(`restored flights ${j(flights)} ≠ shared ${j(ctx.state.buildFolder)}`);
    const ex = ctx.exceptions(p); if (ex.length) diff.push('exceptions: ' + ex.map(e => e.text).join(' || '));
    if (diff.length) throw new Error(diff.join(' | '));
    return { detail: `classic /s/${ctx.state.build.slug} in a fresh profile → folder ${st.folder}, flights ${j(flights)}`, repro: 'classic: open /s/<slug> of the build in a fresh profile', evidence: [ctx.shot('build-share-open-classic')] };
  }, { retry: 0 });

  // =============================================================================================
  // 5. deep links — a fresh page each (one dedicated browser, tab closed after each link). NEVER #tour.
  const bD = await ctx.browser();
  const SCEN_READY = `CNSUI.S.mode === 'network'`;
  const flightsOf = async p => p.eval(`CNSDemand.loadFolder().map(t => t.originIdent + '→' + (t.stops || []).map(s => s.ident).join('→') + (t.stops && t.stops.length ? '→' : '') + t.destIdent + ' ' + t.planeId + ' ' + t.chargerId + ' ' + t.tripType + ' ' + t.freqN + '/' + t.freqUnit)`);
  const scenarioIds = async p => p.eval(`(function(){ const SC = CNSUI.network.SCENARIOS; const all = [...new Set(Object.values(SC).flatMap(s => s.routes.map(r => r[2])))]; return { all, missing: all.filter(id => !CNSUI.PLANES.some(p => p.id === id)) }; })()`);
  const control = async (planeId) => { const r = await fetch(base + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, seedApi, { plane_id: planeId })) }); const jx = await r.json().catch(() => ({})); return `${planeId}: HTTP ${r.status}${jx.error ? ' error "' + jx.error + '"' : jx.success ? ' ok' : ''}`; };
  const deep = async (name, hash, ready, verify, { settle = 0, timeout = 45000 } = {}) => ctx.check('deep-links-' + name, async () => {
    const p = await openV2(ctx, bD, { label: 'v2-' + name.replace(/[^\w]+/g, '-'), hash, timeout: 30000 });
    try {
      if (ready) await p.waitFor(ready, timeout, 150);
      if (settle) await p.sleep(settle);
      const st = await p.eval(V2_STATE);
      await ctx.screenshot(p, 'deep-' + name);
      const out = await verify(st, p);
      const ex = p.exceptions(); if (ex.length) out.problems.push('exceptions: ' + ex.map(e => e.text).join(' || '));
      if (out.problems.length) throw new Error(out.problems.join(' | ') + (out.detail ? ' — ' + out.detail : ''));
      return { detail: out.detail, repro: `open /v2#${hash} in a fresh tab`, evidence: [ctx.shot('deep-' + name)] };
    } finally { await closePage(ctx, p); }
  }, { retry: 0 });

  await deep('result', 'result', `(CNSUI.S.rail === 'result' && !!CNSUI.S.profile) || !!CNSUI.S.err`, async st => ({ problems: (st.rail === 'result' && st.hasProfile) ? [] : [`rail=${st.rail} profile=${st.hasProfile} err="${st.err}"`], detail: `rail=${st.rail} ${st.o} → ${st.d} legs=${st.legs} welcome=${st.welcomeHide}` }), { timeout: 20000 });
  await deep('multi', 'multi', `(CNSUI.S.rail === 'result' && !!CNSUI.S.profile) || !!CNSUI.S.err`, async st => { const pr = [];
    if (st.d !== 'EDDM') pr.push(`dest ${st.d}`); if (j(st.stops) !== j(['EDDF'])) pr.push(`stops ${j(st.stops)}`); if (st.rail !== 'result' || !st.hasProfile) pr.push(`rail=${st.rail} err="${st.err}"`);
    return { problems: pr, detail: `${st.o} → ${st.stops.join(' → ')} → ${st.d} legs=${st.legs} dist=${st.distKm}` }; }, { timeout: 20000 });
  await deep('network', 'network', `CNSUI.S.mode === 'network'`, async st => ({ problems: (st.mode === 'network' && st.bodyNet && st.railWide) ? [] : [`mode=${st.mode} body.net=${st.bodyNet} rail.wide=${st.railWide}`], detail: `mode=${st.mode} folder=${st.folder} welcome=${st.welcomeHide}` }), { timeout: 15000 });
  await deep('big', 'big', SCEN_READY, async (st, p) => { const ids = await scenarioIds(p); const pr = [];
    if (st.folder !== 12) pr.push(`folder ${st.folder}/12 routes`); if (st.mode !== 'network') pr.push('mode ' + st.mode);
    const ctl = st.folder !== 12 ? [await control('beta_plane'), await control('vaeridion'), await control('beta_alia')] : [];
    return { problems: pr, detail: `folder=${st.folder} #netCount=${st.netCount} .ap rows=${st.apRows} S.planeId after=${st.plane} flights=${j(await flightsOf(p))} toasts=${j(st.toasts)}; scenario plane ids ${j(ids.all)} missing from the catalog ${j(ids.missing)}${ctl.length ? '; control /api/simulate → ' + ctl.join(' ; ') : ''}` }; }, { settle: 600 });
  await deep('hub', 'hub', SCEN_READY, async (st, p) => { const ids = await scenarioIds(p); const cfg = await p.eval(`(CNSDemand.loadCfg().EHLE || {}).chargers || null`); const pr = [];
    if (st.folder !== 8) pr.push(`folder ${st.folder}/8 routes`); if (j(cfg) !== j(['dc_320', 'dc_320'])) pr.push(`cfg EHLE chargers ${j(cfg)}`); if (st.mode !== 'network') pr.push('mode ' + st.mode);
    const ctl = st.folder !== 8 ? [await control('beta_plane'), await control('vaeridion'), await control('beta_alia')] : [];
    return { problems: pr, detail: `folder=${st.folder} cfg.EHLE.chargers=${j(cfg)} openAp=${j(st.openAp)} drawer=${st.drawerOpen} S.planeId after=${st.plane} flights=${j(await flightsOf(p))} toasts=${j(st.toasts)}; hub ids ${j([...new Set(ids.all)])} missing ${j(ids.missing)}${ctl.length ? '; control /api/simulate → ' + ctl.join(' ; ') : ''}` }; }, { settle: 600 });
  await deep('training', 'training', SCEN_READY, async (st, p) => { const cfg = await p.eval(`(CNSDemand.loadCfg().EHTE || {}).chargers || null`); const pr = [];
    if (st.folder !== 1) pr.push(`folder ${st.folder}/1`); if (st.mode !== 'network') pr.push('mode ' + st.mode);
    return { problems: pr, detail: `folder=${st.folder} cfg.EHTE.chargers=${j(cfg)} openAp=${j(st.openAp)} drawer=${st.drawerOpen} toasts=${j(st.toasts)}` }; }, { settle: 600 });
  await deep('hub-EHLE', 'hub:EHLE', SCEN_READY + ` && CNSUI.S.filter === 'EHLE'`, async st => { const pr = [];
    if (st.filter !== 'EHLE' || !st.openAp.includes('EHLE')) pr.push(`filter=${st.filter} openAp=${j(st.openAp)}`); if (st.mode !== 'network') pr.push('mode ' + st.mode); if (st.folder !== 8) pr.push(`folder ${st.folder}/8 routes (same cause as deep-links-hub)`);
    return { problems: pr, detail: `filter=${st.filter} openAp=${j(st.openAp)} folder=${st.folder} .ap rows=${st.apRows}` }; }, { settle: 600 });
  await deep('hub-fleet', 'hub::fleet', SCEN_READY + ` && CNSUI.S.lanes === 'fleet'`, async (st, p) => { const g = await p.eval(`({ lanes: document.querySelectorAll('#gantt .lane, #gantt [class*=lane]').length, seg: [...document.querySelectorAll('#laneSeg button.on')].map(b => b.dataset.lanes), ganttChildren: document.querySelector('#gantt').children.length })`); const pr = [];
    if (st.lanes !== 'fleet') pr.push('S.lanes ' + st.lanes); if (!st.drawerOpen) pr.push('drawer closed'); if (st.folder !== 8) pr.push(`folder ${st.folder}/8 routes (same cause as deep-links-hub)`);
    return { problems: pr, detail: `lanes=${st.lanes} drawer=${st.drawerOpen} laneSeg.on=${j(g.seg)} gantt children=${g.ganttChildren} folder=${st.folder}` }; }, { settle: 600 });
  await deep('filters', 'filters', `!!document.querySelector('.ac-pop')`, async st => ({ problems: (st.acPop && st.acFilterOpen) ? [] : [`.ac-pop=${st.acPop} S.acFilterOpen=${st.acFilterOpen}`], detail: `.ac-pop=${st.acPop} welcome=${st.welcomeHide}` }), { timeout: 8000 });
  await deep('settings', 'settings', `!document.querySelector('#modal').hidden && !!document.querySelector('#modalBox .ms')`, async (st, p) => ({ problems: (st.modalOpen && st.ms) ? [] : [`modal=${st.modalOpen} .ms=${st.ms}`], detail: `modal=${st.modalOpen} .ms=${st.ms} rows=${await p.eval(`document.querySelectorAll('#modalBox .ms .msr').length`)}` }), { timeout: 8000 });
  await deep('welcome', 'welcome', `!!document.querySelector('#modal:not([hidden]) #welcomeHide')`, async st => ({ problems: (st.modalOpen && st.welcomeHide) ? [] : [`modal=${st.modalOpen} #welcomeHide=${st.welcomeHide}`], detail: `modal=${st.modalOpen} #welcomeHide=${st.welcomeHide}` }), { timeout: 8000 });

  // Gap found by deep-links-big: plan.simulate() returns early on a validation / planner error WITHOUT clearing
  // S.result, and loadScenario adds whatever S.result holds → ghost flights (previous plane + auto stops + trip
  // type under the new origin/destination). Control: the API-error path DOES clear S.result.
  await ctx.check('deep-links-scenario-stale-result', async () => {
    const p = await openV2(ctx, bD, { label: 'v2-stale' });
    try {
      const r = await p.evalAsync(`const S = CNSUI.S, by = CNSUI.byId(); const snap = () => ({ result: !!S.result, resultPlane: S.result && S.result.plane && S.result.plane.id, resultDest: S.result && S.result.destination && S.result.destination.name, rail: S.rail, err: S.err, plannedErr: S.planned && S.planned.error, uiPlane: CNSUI.plane().id, planes0: CNSUI.PLANES[0].id });
        const setR = (o, d, pl, tr) => { S.origin = by[o]; S.dest = by[d]; S.stops = []; S.planeId = pl; S.trip = tr; S.freq = 2; S.per = 'day'; S.blacklist.clear(); S.divertOverrides = {}; };
        CNSDemand.saveFolder([]); CNSUI.folderChanged();
        setR('EHBK', 'EDDL', 'pipistrel_velis', 'one-way'); S.chargerId = 'dc_22'; await CNSUI.plan.simulate(); const ok = snap();
        setR('EHAM', 'EHGG', 'zz_not_a_real_plane', 'retour'); await CNSUI.plan.simulate(); const stale = snap();   // an id that cannot resolve (beta_plane now aliases to beta_alia by design)
        const before = CNSDemand.loadFolder().length; if (S.result) CNSUI.plan.addToNetwork();                   // loadScenario's consumer (network.js:159)
        const ghost = CNSDemand.loadFolder().slice(before).map(t => ({ o: t.originIdent, d: t.destIdent, stops: (t.stops || []).map(x => x.ident), plane: t.planeId, trip: t.tripType, freqN: t.freqN }));
        setR('EHBK', 'EDDL', 'zz_not_a_real_plane', 'one-way'); await CNSUI.plan.simulate(); const apiErr = snap();  // unresolvable id → refused before/at the API
        setR('EHLE', 'EDDF', 'beta_alia', 'one-way'); S.chargerId = 'dc_320'; await CNSUI.plan.simulate(); const ok2 = snap(); S.trip = 'circular'; await CNSUI.plan.simulate(); const valid = snap();
        CNSDemand.saveFolder([]); CNSUI.folderChanged(); return { ok, stale, ghost, apiErr, ok2, valid };`);
      await ctx.screenshot(p, 'scenario-stale-result');
      const pr = [];
      if (!r.ok.result) pr.push('precondition: Velis EHBK→EDDL did not simulate: ' + r.ok.err);
      if (r.stale.result) pr.push(`planner error "${r.stale.err}" left S.result = ${r.stale.resultPlane} → ${r.stale.resultDest} (rail=${r.stale.rail}); addToNetwork stored ghost ${j(r.ghost)}`);
      if (r.valid.result) pr.push(`validation error "${r.valid.err}" left S.result = ${r.valid.resultPlane} → ${r.valid.resultDest} (rail=${r.valid.rail})`);
      const detail = `unknown id beta_plane → CNSUI.plane() falls back to PLANES[0]=${r.stale.planes0} (uiPlane=${r.stale.uiPlane}); control API-error path: result=${r.apiErr.result} err="${r.apiErr.err}"; classic: the submit handler nulls lastResult before every run`;
      if (pr.length) throw new Error(pr.join(' | ') + ' — ' + detail);
      return { detail, repro: 'v2: simulate a Velis EHBK→EDDL, then S.planeId=beta_plane, EHAM→EHGG retour, await CNSUI.plan.simulate(); inspect S.result', evidence: [ctx.shot('scenario-stale-result')] };
    } finally { await closePage(ctx, p); }
  }, { retry: 0 });

  // =============================================================================================
  // 6. welcome flag — no seed → the dialog within 1.5 s; REAL click #welcomeHide → 'true'; reload → none;
  //    the classic honours the same key (both directions); any hash → none.
  await ctx.check('welcome-flag-shows', async () => {
    const p = await openV2(ctx, bD, { label: 'v2-welcome', seedLocalStorage: { cns_welcome_hide: null } }); ctx.state.welcomePage = p;
    const t0 = Date.now(); let shown = true; try { await p.waitFor(`!!document.querySelector('#modal:not([hidden]) #welcomeHide')`, 1500, 50); } catch (e) { shown = false; }
    const ms = Date.now() - t0; const flag = await p.eval(`localStorage.getItem('cns_welcome_hide')`);
    await ctx.screenshot(p, 'welcome-shows');
    if (!shown) throw new Error(`no welcome dialog within 1.5 s of boot (flag=${j(flag)}, modal hidden=${await p.eval(`document.querySelector('#modal').hidden`)})`);
    return { detail: `welcome dialog after ${ms} ms (flag=${j(flag)})`, repro: 'v2 with localStorage.cns_welcome_hide removed', evidence: [ctx.shot('welcome-shows')] };
  }, { retry: 0 });

  await ctx.check('welcome-flag-click-persists', async () => {
    const p = ctx.state.welcomePage; if (!p) throw new Error('needs welcome-flag-shows');
    await p.click('#welcomeHide');
    await p.waitFor(`localStorage.getItem('cns_welcome_hide') === 'true'`, 1500, 50);
    const st = await p.eval(`({ flag: localStorage.getItem('cns_welcome_hide'), checked: document.querySelector('#welcomeHide').checked })`);
    await p.click('#modalBox .btns [data-modal=close]');
    await p.waitFor(`document.querySelector('#modal').hidden`, 1500, 50);
    if (st.flag !== 'true' || !st.checked) throw new Error(j(st));
    return { detail: `real click → cns_welcome_hide=${st.flag}, checkbox=${st.checked}; "Start planning" closed the dialog`, repro: 'real click #welcomeHide, read localStorage.cns_welcome_hide' };
  }, { retry: 0 });

  await ctx.check('welcome-flag-reload-hidden', async () => {
    const p = ctx.state.welcomePage; if (!p) throw new Error('needs welcome-flag-shows');
    await reloadKeepingWelcomeFlag(p);
    await p.sleep(1500);
    const st = await p.eval(`({ flag: localStorage.getItem('cns_welcome_hide'), welcome: !!document.querySelector('#welcomeHide'), modal: !document.querySelector('#modal').hidden })`);
    await ctx.screenshot(p, 'welcome-reload');
    if (st.flag !== 'true') throw new Error('flag lost across the reload: ' + j(st));
    if (st.welcome || st.modal) throw new Error('welcome dialog shown again despite cns_welcome_hide=true: ' + j(st));
    return { detail: `after reload (seed not touching the flag): flag=${st.flag} welcome=${st.welcome} modal=${st.modal}`, repro: 'reload /v2 after ticking "Don\'t show this again"', evidence: [ctx.shot('welcome-reload')] };
  }, { retry: 0 });

  await ctx.check('welcome-flag-classic', async () => {
    // same profile, flag 'true' (written by the v2 click; the default seed writes the identical value)
    const c = await openClassic(ctx, bD, { label: 'classic-welcome' });
    await c.sleep(1500);
    const on = await c.eval(CLASSIC_STATE);
    await ctx.screenshot(c, 'welcome-classic-hidden');
    // converse: remove the flag → the classic's #welcomeModal shows (proves it reads the SAME key)
    await c.goto(base + '/?desktop=1', { seedLocalStorage: { cns_welcome_hide: null }, boot: 'classic' });
    let shows = true; try { await c.waitFor(`!!document.querySelector('#welcomeModal.show')`, 3000, 50); } catch (e) { shows = false; }
    const off = await c.eval(CLASSIC_STATE);
    await ctx.screenshot(c, 'welcome-classic-shows');
    await closePage(ctx, c);
    const pr = [];
    if (on.welcome || !on.dontShow) pr.push(`flag true: #welcomeModal.show=${on.welcome} #welcomeDontShow.checked=${on.dontShow}`);
    if (!shows || off.dontShow) pr.push(`flag removed: #welcomeModal.show=${shows} #welcomeDontShow.checked=${off.dontShow}`);
    if (pr.length) throw new Error(pr.join(' | '));
    return { detail: `flag 'true' → classic modal hidden, "Don't show" checked; flag removed → modal shown within 3 s`, repro: 'classic /?desktop=1 with and without localStorage.cns_welcome_hide', evidence: [ctx.shot('welcome-classic-hidden'), ctx.shot('welcome-classic-shows')] };
  }, { retry: 0 });

  await ctx.check('welcome-flag-hash-suppressed', async () => {
    const p = await openV2(ctx, bD, { label: 'v2-welcome-hash', hash: 'result', seedLocalStorage: { cns_welcome_hide: null } });
    await p.waitFor(`(CNSUI.S.rail === 'result' && !!CNSUI.S.profile) || !!CNSUI.S.err`, 20000, 100);
    await p.sleep(1500);
    const st = await p.eval(`({ flag: localStorage.getItem('cns_welcome_hide'), welcome: !!document.querySelector('#welcomeHide'), modal: !document.querySelector('#modal').hidden, hash: location.hash })`);
    await closePage(ctx, p);
    if (st.welcome || st.modal) throw new Error('welcome shown on a deep link: ' + j(st));
    return { detail: `#result with no flag: welcome=${st.welcome} modal=${st.modal}`, repro: 'v2#result with cns_welcome_hide removed' };
  }, { retry: 0 });

  // =============================================================================================
  // 7. boot failure — /api/airports blocked at the network layer: the rail must say something.
  await ctx.check('boot-failure-airports-blocked', async () => {
    const bE = await ctx.browser(); const p = await bE.newPage('v2-bootfail'); await installToastRecorder(p); ctx.pages.push(p); ctx.state.bootFailPage = p;
    await p.send('Fetch.enable', { patterns: [...BLOCK_PATTERNS, '*/api/airports'].map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
    await p.goto(base + '/v2', { boot: null, timeout: 20000 });
    await p.sleep(4000);
    const st = await p.eval(`({ railChildren: document.querySelector('#railBody').children.length, railText: document.querySelector('#railBody').textContent.trim().slice(0, 200), footText: document.querySelector('#railFoot').textContent.trim().slice(0, 100),
      toastShown: document.querySelector('#toast').classList.contains('show'), toastText: document.querySelector('#toast').textContent.trim(), toasts: (window.__toasts || []).map(t => t.text), airports: window.CNSUI ? CNSUI.airports().length : -1, map: !!(window.CNSUI && CNSUI.map && CNSUI.map.map) })`);
    const blocked = p.blocked.filter(u => /\/api\/airports(\?|$)/.test(u));
    const ex = p.exceptions();
    await ctx.screenshot(p, 'boot-failure');
    if (!blocked.length) throw new Error('control failed: /api/airports was not blocked (blocked=' + j(p.blocked.slice(-5)) + ')');
    const feedback = (st.railChildren > 0 && st.railText.length > 0) || st.toasts.length > 0 || st.toastShown;
    if (!feedback) throw new Error(`rail blank 4 s after /api/airports failed (railChildren=${st.railChildren}, toasts=${j(st.toasts)}, airports=${st.airports}, map=${st.map}); exceptions: ${ex.map(e => e.text).join(' || ') || 'none'} — app.js boot() has no try/catch`);
    return { detail: `blocked ${blocked[0]}; rail "${st.railText}" (${st.railChildren} children); toasts ${j(st.toasts)}; exceptions ${ex.length}`, repro: 'CDP Fetch: fail */api/airports with BlockedByClient, open /v2, wait 4 s', evidence: [ctx.shot('boot-failure')] };
  }, { retry: 0 });

  // =============================================================================================
  await ctx.check('no-unexpected-exceptions', async () => {
    const pages = [...ctx.pages, ...(ctx.state.closedPages || [])].filter(p => p !== ctx.state.bootFailPage);
    const ex = pages.flatMap(p => ctx.exceptions(p).map(e => `${p.label}: ${e.text}`));
    if (ex.length) throw new Error(ex.join(' || '));
    return `${pages.length} pages, 0 exceptions (boot-failure page excluded; ${pages.reduce((n, p) => n + p.errors.length, 0)} console errors/warnings total)`;
  }, { retry: 0 });
}
