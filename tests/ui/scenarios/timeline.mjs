/* Timeline: the demand-timeline drawer of the v2 shell (static/ui/timeline.js) against CNSScheduler (the engine both
   shells share) and the classic shell (templates/index.html: the per-airport Gantt `CNSScheduler.renderInto`, the
   folder card's `peak … · last ends …`). The classic is the behavioural spec; the production catalog is the data.

   Seed (3 flights → 4 airports EHLE, EDDF, EHAM, EDDL; 4 scheduler lanes):
     EHLE → EDDF  beta_alia            dc_320   one-way  2/day   (2 separate lanes, charge at EDDF, queue there)
     EHAM → EDDL  elysian_e9x          dc_2400  return   1/day
     EHLE → EHAM  vaeridion_microliner dc_1000  return   1/day
   Checks (names are `--only` substrings): seed, lanes, fleet-lanes, departures-switch, departures-label,
   drag-reschedule-persists, drag-reload-persists, drag-classic-parity, ends-clock-parity, drag-clamp-day-start,
   click-without-drag, focus-chip, peak-consistency-eff-off, peak-consistency-eff-on, focus-button-plan-mode,
   network-fleet-deep-link, hub-fleet-deep-link, no-exceptions.
   Run: node tests/ui/run.mjs timeline [--only <check>] */
export const component = 'timeline';
export const module = 'network';

const SEED = [
  { o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freq: 2, per: 'day' },
  { o: 'EHAM', d: 'EDDL', plane: 'elysian_e9x', charger: 'dc_2400', trip: 'retour', freq: 1, per: 'day' },
  { o: 'EHLE', d: 'EHAM', plane: 'vaeridion_microliner', charger: 'dc_1000', trip: 'retour', freq: 1, per: 'day' }
];
const H0 = 360, H1 = 1380, SPAN = H1 - H0;              // timeline.js's own axis (06:00–23:00); DAY_START of the engine is 07:00
const pct = m => Math.max(0, Math.min(100, (m - H0) / SPAN * 100));
const clock = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
const j = v => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------
// Helpers the harness lacks (listed under harnessGaps in the report):
//  * a toast recorder — UI.toast() shows #toast for 2.2 s; a MutationObserver records every show into window.__toasts
//    so a check can assert (or deny) a toast after the fact. Installed after boot (re-install after every navigation).
//  * a cns_schedule write recorder — Storage.prototype.setItem is wrapped to log every write of that key, so a
//    "no-op" claim can be proven even when the written value equals the old one.
//  * call counters on CNSUI.render / map.fitNet / map.drawNet / network.render / timeline.render for the
//    "handled once, not twice" claims.
//  * page.goto(url, {boot:'v2'}) instead of page.reload() — reload() does not wait for the boot predicate.
const TOAST_REC = `(function(){ if (window.__toasts) return 'kept'; window.__toasts = []; const el = document.getElementById('toast'); if (!el) return 'no #toast';
  const rec = () => { if (!el.classList.contains('show')) return; const text = el.textContent.trim(); const last = __toasts[__toasts.length - 1]; if (last && last.text === text && Date.now() - last.t < 250) return; __toasts.push({ text, t: Date.now() }); };
  new MutationObserver(rec).observe(el, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true }); return 'installed'; })()`;
const SCHED_REC = `(function(){ if (window.__schedWrites) return 'kept'; window.__schedWrites = []; const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { if (k === 'cns_schedule') __schedWrites.push({ v: String(v), t: Date.now() }); return orig.apply(this, arguments); }; return 'installed'; })()`;
const COUNTERS = `(function(){ if (window.__cnt) { for (const k in __cnt) __cnt[k] = 0; return __cnt; } window.__cnt = { render: 0, fitNet: 0, drawNet: 0, netRender: 0, tlRender: 0 };
  const wrap = (obj, k, name) => { const f = obj[k]; obj[k] = function () { __cnt[name]++; return f.apply(this, arguments); }; };
  wrap(CNSUI, 'render', 'render'); wrap(CNSUI.map, 'fitNet', 'fitNet'); wrap(CNSUI.map, 'drawNet', 'drawNet'); wrap(CNSUI.network, 'render', 'netRender'); wrap(CNSUI.timeline, 'render', 'tlRender'); return __cnt; })()`;
const CLICK_REC = `(function(){ if (window.__clicks) return 'kept'; window.__clicks = []; const tag = e => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '') : null;
  document.addEventListener('click', e => { __clicks.push({ t: Date.now(), target: tag(e.target), x: e.clientX, y: e.clientY }); if (__clicks.length > 50) __clicks.shift(); }, true); return 'installed'; })()`;
const toasts = page => page.eval('(window.__toasts || []).map(t => t.text)');
async function waitToast(page, re, timeout = 3000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const l = await toasts(page); const hit = l.find(t => re.test(t)); if (hit) return hit; await page.sleep(80); } return null; }
async function install(page) { return { toast: await page.eval(TOAST_REC), sched: await page.eval(SCHED_REC), clicks: await page.eval(CLICK_REC) }; }
const lastClick = page => page.eval('(window.__clicks || []).slice(-1)[0] || null');
/** The drawer animates its height (.22 s) after open/close and after every lane switch (--drawer-h changes): wait until it is still. */
async function settle(page, timeout = 2000) {
  const t0 = Date.now(); let prev = -1;
  while (Date.now() - t0 < timeout) { const h = await page.eval(`document.querySelector('#drawer').getBoundingClientRect().height`); if (h === prev) return h; prev = h; await page.sleep(70); }
  return prev;
}

// ---- state readers ---------------------------------------------------------------------------
const DRAWER = `(function(){ const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)]; const S = CNSUI.S; const path = q('#gantt .grow.load svg path');
  return { open: q('#drawer').classList.contains('open'), height: q('#drawer').getBoundingClientRect().height, lanes: S.lanes, showDep: S.showDep, mode: S.mode, filter: S.filter, sub: q('#drawerSub').textContent.trim(),
    grp: qa('#gantt .grow.grp').map(g => g.querySelector('button').textContent.trim()), grpPeak: qa('#gantt .grow.grp').map(g => g.querySelector('.lab small').textContent.trim()),
    subRows: qa('#gantt .grow.sub').length, subLabels: qa('#gantt .grow.sub .lab').map(l => l.textContent.trim()), rows: qa('#gantt .grow:not(.axis):not(.load)').length, rowLabels: qa('#gantt .grow:not(.axis):not(.load) .lab').map(l => l.textContent.trim()),
    chg: qa('#gantt .blk.chg').length, chgAway: qa('#gantt .blk.chg.away').length, fly: qa('#gantt .blk.fly').length, wait: qa('#gantt .blk.wait').length, drag: qa('#gantt .blk[data-drag]').length,
    path: path ? path.getAttribute('d').slice(0, 40) : null, pathLen: path ? path.getAttribute('d').length : 0, loadLab: (q('#gantt .grow.load .lab') || { textContent: '' }).textContent.trim(),
    legend: (q('#gantt .glegend') || { textContent: '' }).textContent.trim(), depSwHidden: q('#depSw').hidden, depLblHidden: q('.dep-lbl').hidden, depOn: q('#depSw').classList.contains('on'),
    segOn: qa('#laneSeg button.on').map(b => b.dataset.lanes), chipHidden: q('#focChip').hidden, chipText: q('#focChip').textContent.trim(), empty: !!q('#gantt .empty'), toasts: (window.__toasts || []).map(t => t.text) }; })()`;
const ENGINE = `(function(){ const R = CNSUI.network.rows(); const g = CNSScheduler.runGlobal(); const D = CNSDemand; const folder = D.loadFolder();
  return { rows: R.map(a => a.ident), withRot: R.filter(a => a.contribs.some(c => c.role) && CNSScheduler.rotationsAt(a.ident).length).map(a => a.ident), lanes: g.lanes.length,
    laneKeys: g.lanes.map(L => L.trip.originIdent + '→' + L.trip.destIdent + ':' + (L.schedSlot != null ? L.schedSlot : '*') + ' rot=' + L.rotations.length), subRows: R.filter(a => a.contribs.some(c => c.role)).reduce((s, a) => s + CNSScheduler.rotationsAt(a.ident).length, 0),
    folder: folder.length, flights: folder.reduce((s, t) => s + D.flightsPerDay(t), 0), chargePhases: g.lanes.reduce((s, L) => s + L.rotations.reduce((q, r) => q + r.phases.filter(p => p.kind === 'charge' && p.dur > 0).length, 0), 0),
    sched: JSON.parse(localStorage.getItem('cns_schedule') || '{}'), peaks: Object.fromEntries(R.map(a => [a.ident, { rail: a.peak, engine: CNSScheduler.summary(a.ident).peakKw, binned: CNSUI.timeline.loadProfile(g.lanes, a.ident).peak, latestEnd: a.latestEnd }])),
    gridMul: CNSSettings.gridDemandFactor(), effOn: !!CNSSettings.loadAll().chargerEfficiency.enabled }; })()`;
/** Every draggable block: geometry, the track it lives in, what is on top of its centre, and its group row. */
const BLOCKS = `(function(){ const gr = document.querySelector('#gantt').getBoundingClientRect(); const out = [];
  document.querySelectorAll('#gantt .blk[data-drag]').forEach(b => { const r = b.getBoundingClientRect(); const tr = b.parentElement.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = (cy > gr.top && cy < gr.bottom) ? document.elementFromPoint(cx, cy) : null; const row = b.closest('.grow'); let grp = row; while (grp && !grp.classList.contains('grp')) grp = grp.previousElementSibling;
    out.push({ key: b.dataset.drag, takeoff: +b.dataset.takeoff, left: parseFloat(b.style.left), cls: b.className, x: cx, y: cy, w: r.width, trackX: tr.left, trackW: tr.width, visible: cy > gr.top && cy < gr.bottom, covered: top !== b, topTag: top ? top.tagName.toLowerCase() + '.' + (typeof top.className === 'string' ? top.className : '') : null,
      lab: row ? row.querySelector('.lab').textContent.trim() : '', grp: grp ? grp.querySelector('button').textContent.trim() : '' }); }); return out; })()`;
const blockByKey = (page, key) => page.eval(`(function(){ const b = document.querySelector('#gantt .blk[data-drag=' + ${j('"')} + ${j(key)} + ${j('"')} + ']'); if (!b) return null; const r = b.getBoundingClientRect(); return { key: b.dataset.drag, takeoff: +b.dataset.takeoff, left: parseFloat(b.style.left), x: r.left + r.width / 2, y: r.top + r.height / 2, cls: b.className }; })()`);
const SUMMARIES = `(function(){ const ids = ${j(['EHLE', 'EDDF', 'EHAM', 'EDDL'])}; return Object.fromEntries(ids.map(id => [id, CNSScheduler.summary(id)])); })()`;

// ---- real-input state helpers (idempotent, so every check can run alone with --only) ---------
async function setMode(page, mode) { if (await page.eval('CNSUI.S.mode') === mode) return; await page.click(`#modeSeg button[data-mode=${mode}]`); await page.waitFor(`CNSUI.S.mode === ${j(mode)}`, 3000, 50); await settle(page); }
async function ensureDrawer(page, open) { const is = await page.eval(`document.querySelector('#drawer').classList.contains('open')`); if (is === open) { await settle(page); return; } await page.click('#drawerHead'); await page.waitFor(`document.querySelector('#drawer').classList.contains('open') === ${open}`, 3000, 50); await settle(page); }
async function ensureLanes(page, lanes) { if (await page.eval('CNSUI.S.lanes') === lanes) { await settle(page); return; } await page.click(`#laneSeg button[data-lanes=${lanes}]`); await page.waitFor(`CNSUI.S.lanes === ${j(lanes)}`, 3000, 50); await settle(page); }
async function ensureDep(page, on) { if (await page.eval('CNSUI.S.showDep') === on) return; await settle(page); await page.click('#depSw'); await page.waitFor(`CNSUI.S.showDep === ${on}`, 3000, 50); await settle(page); }
async function isolate(page, ident) {   // real click on the drawer's group-row button (network mode)
  await ensureDrawer(page, true); await ensureLanes(page, 'airports');
  if (await page.eval('CNSUI.S.filter') === ident) return;
  await page.click(`#gantt .grow.grp .lab button[data-act=focus][data-ap=${ident}]`); await page.waitFor(`CNSUI.S.filter === ${j(ident)} && !document.querySelector('#focChip').hidden`, 3000, 50); await settle(page);
}
async function prepared(page) { await setMode(page, 'network'); await ensureDrawer(page, true); await ensureLanes(page, 'airports'); await ensureDep(page, false); await settle(page); }

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  await install(v2);
  // ---- seed (setup, outside the checks so --only works; the `seed` check only reports it) --------------------------
  const seeded = await ctx.seedNetwork(v2, SEED);
  const bad = seeded.filter(s => s.err || !s.added);
  ctx.state.seed = seeded;
  await ctx.check('seed', async () => {
    if (bad.length) throw new Error('seed failed: ' + j(bad));
    const st = await v2.eval(ENGINE); const dr = await v2.eval(DRAWER);
    if (st.folder !== 3 || st.rows.length !== 4) throw new Error(`folder ${st.folder}/3, airports ${j(st.rows)}`);
    // the drawer header must reflect the network right after Add (Plan mode; timeline.render runs from UI.render)
    if (!/4 airports/.test(dr.sub)) throw new Error(`#drawerSub in Plan mode right after Add = "${dr.sub}" (expected "4 airports · 4 flights / day · peak load …")`);
    return { detail: `folder ${st.folder}, airports ${j(st.rows)}, lanes ${st.lanes} ${j(st.laneKeys)}, flights/day ${st.flights}, #drawerSub="${dr.sub}"`, repro: 'ctx.seedNetwork(v2, SEED) in Plan mode' };
  }, { retry: 0 });
  if (bad.length) { ctx.blockedBy.push('seed failed: ' + j(bad)); return; }

  // ---- lanes: open the drawer with a real click, airport lanes vs the scheduler ----------------------------------
  await ctx.check('lanes', async () => {
    await setMode(v2, 'network');
    await ensureDrawer(v2, false);
    const r0 = await v2.click('#drawerHead');                   // a REAL click on the head opens the drawer
    await v2.waitFor(`document.querySelector('#drawer').classList.contains('open')`, 3000, 50); await v2.sleep(350);
    await ensureLanes(v2, 'airports'); await ensureDep(v2, false);
    const dr = await v2.eval(DRAWER), st = await v2.eval(ENGINE);
    const pr = [];
    if (j(dr.grp) !== j(st.withRot)) pr.push(`group rows ${j(dr.grp)} ≠ airports with rotations ${j(st.withRot)}`);
    if (dr.subRows < 3) pr.push(`sub rows ${dr.subRows} < 3`);
    if (dr.subRows !== st.subRows) pr.push(`sub rows ${dr.subRows} ≠ Σ rotationsAt(ident).length ${st.subRows}`);
    if (!(dr.chg > 0)) pr.push(`.blk.chg ${dr.chg} (engine has ${st.chargePhases} charge phases)`);
    if (!dr.path || !/^M0 40 L/.test(dr.path)) pr.push(`load row path missing/odd: ${j(dr.path)}`);
    if (!/Charging here/.test(dr.legend) || !/Charging elsewhere/.test(dr.legend) || !/Drag a rotation/.test(dr.legend)) pr.push(`legend "${dr.legend}"`);
    if (dr.wait > 0 && !/Waiting for a charger/.test(dr.legend)) pr.push('wait blocks drawn but the legend lacks "Waiting for a charger"');
    if (!(new RegExp(`^${st.rows.length} airports · ${st.flights % 1 ? st.flights.toFixed(1) : st.flights} flights / day · peak load`)).test(dr.sub)) pr.push(`#drawerSub "${dr.sub}" vs ${st.rows.length} airports · ${st.flights} flights / day`);
    if (dr.drag < 1) pr.push('no draggable block (.blk[data-drag])');
    if (dr.height < 200) pr.push(`drawer height ${dr.height}px while open`);
    await ctx.screenshot(v2, 'lanes');
    if (pr.length) throw new Error(pr.join('; ') + ` — drawer=${j(dr)}`);
    return { detail: `real click at (${r0.cx.toFixed(0)},${r0.cy.toFixed(0)}) opened the drawer (${dr.height}px); groups ${j(dr.grp)} peaks ${j(dr.grpPeak)}; ${dr.subRows} sub rows ${j(dr.subLabels)}; chg ${dr.chg} (away ${dr.chgAway}) wait ${dr.wait} fly ${dr.fly} drag ${dr.drag}; load "${dr.loadLab}" path "${dr.path}…"; legend "${dr.legend}"; sub "${dr.sub}"`, repro: 'seed 3 flights, Network mode, real click #drawerHead, read #gantt', evidence: [ctx.shot('lanes')] };
  });

  // ---- fleet lanes: [data-lanes=fleet] → one row per scheduler lane; the drawer must stay open ------------------
  await ctx.check('fleet-lanes', async () => {
    await prepared(v2);
    await v2.click('#laneSeg button[data-lanes=fleet]');
    await v2.waitFor(`CNSUI.S.lanes === 'fleet'`, 3000, 50); await v2.sleep(150);
    const dr = await v2.eval(DRAWER), st = await v2.eval(ENGINE);
    const pr = [];
    if (!dr.open) pr.push('clicking the Fleet button collapsed the drawer');
    if (j(dr.segOn) !== j(['fleet'])) pr.push(`#laneSeg .on = ${j(dr.segOn)}`);
    if (dr.rows !== st.lanes) pr.push(`fleet rows ${dr.rows} ≠ CNSScheduler.runGlobal().lanes.length ${st.lanes}`);
    if (!dr.depSwHidden || !dr.depLblHidden) pr.push(`departures switch/label not hidden in fleet view (sw ${dr.depSwHidden}, lbl ${dr.depLblHidden})`);
    if (!(dr.fly > 0 && dr.chg > 0)) pr.push(`fleet view blocks: fly ${dr.fly}, chg ${dr.chg}`);
    if (dr.drag !== st.lanes && dr.drag < st.lanes) pr.push(`draggable blocks ${dr.drag} < lanes ${st.lanes}`);
    if (!dr.rowLabels.every(l => /→/.test(l))) pr.push(`lane labels lack "origin → dest": ${j(dr.rowLabels)}`);
    if (!/Flying/.test(dr.legend)) pr.push('legend lacks "Flying" in the fleet view');
    if (!(new RegExp(`^${st.lanes} aircraft ·`)).test(dr.sub)) pr.push(`#drawerSub "${dr.sub}" vs "${st.lanes} aircraft · …"`);
    await ctx.screenshot(v2, 'fleet-lanes');
    await ensureLanes(v2, 'airports');
    if (pr.length) throw new Error(pr.join('; ') + ` — drawer=${j(dr)} engine lanes=${j(st.laneKeys)}`);
    return { detail: `${dr.rows} fleet rows = ${st.lanes} lanes ${j(st.laneKeys)}; labels ${j(dr.rowLabels)}; fly ${dr.fly} chg ${dr.chg} wait ${dr.wait}; sub "${dr.sub}"; drawer open ${dr.open}`, repro: 'drawer open, real click #laneSeg [data-lanes=fleet]', evidence: [ctx.shot('fleet-lanes')] };
  });

  // ---- departures switch: #depSw toggles the fly blocks; the "Departures" LABEL must toggle the switch, not the drawer
  await ctx.check('departures-switch', async () => {
    await prepared(v2);
    const before = await v2.eval(DRAWER);
    await v2.click('#depSw'); await v2.waitFor('CNSUI.S.showDep === true', 3000, 50).catch(async e => { throw new Error(e.message + ' — last click target ' + j(await lastClick(v2))); }); await settle(v2);
    const on = await v2.eval(DRAWER);
    await v2.click('#depSw'); await v2.waitFor('CNSUI.S.showDep === false', 3000, 50).catch(async e => { throw new Error(e.message + ' — last click target ' + j(await lastClick(v2))); }); await settle(v2);
    const off = await v2.eval(DRAWER);
    const pr = [];
    if (before.fly !== 0) pr.push(`fly blocks with the switch off before: ${before.fly}`);
    if (!(on.fly > 0) || !on.depOn || !/Flying/.test(on.legend)) pr.push(`switch on → fly ${on.fly}, .on ${on.depOn}, legend "${on.legend}"`);
    if (off.fly !== 0 || off.depOn) pr.push(`switch off again → fly ${off.fly}, .on ${off.depOn}`);
    if (!on.open || !off.open) pr.push(`the switch click collapsed the drawer (open on=${on.open} off=${off.open})`);
    await ctx.screenshot(v2, 'departures-switch');
    if (pr.length) throw new Error(pr.join('; '));
    return { detail: `fly blocks off/on/off = ${before.fly}/${on.fly}/${off.fly}; .on ${before.depOn}/${on.depOn}/${off.depOn}; drawer stayed open`, repro: 'drawer open (airport lanes), real click #depSw twice', evidence: [ctx.shot('departures-switch')] };
  });
  await ctx.check('departures-label', async () => {
    await prepared(v2);
    const before = await v2.eval(DRAWER);
    const r = await v2.click('.dep-lbl');                       // real click on the LABEL text
    await v2.sleep(400);
    const after = await v2.eval(DRAWER);
    // control: the switch itself (proven above) — repeat here so the two are in one record
    await ensureDrawer(v2, true);
    const c0 = await v2.eval(DRAWER); await v2.click('#depSw'); await v2.sleep(300); const c1 = await v2.eval(DRAWER);
    await ensureDep(v2, false); await ensureDrawer(v2, true);
    await ctx.screenshot(v2, 'departures-label');
    const pr = [];
    if (after.showDep === before.showDep) pr.push(`label click did NOT toggle the switch (showDep ${before.showDep} → ${after.showDep}, fly ${before.fly} → ${after.fly})`);
    if (after.open !== before.open) pr.push(`label click toggled the DRAWER (open ${before.open} → ${after.open})`);
    const detail = `label at (${r.cx.toFixed(0)},${r.cy.toFixed(0)}) top=${r.topTag}: showDep ${before.showDep}→${after.showDep}, drawer open ${before.open}→${after.open}, fly ${before.fly}→${after.fly}; control #depSw: showDep ${c0.showDep}→${c1.showDep}, open ${c0.open}→${c1.open}`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'drawer open, real click on .dep-lbl ("Departures")', evidence: [ctx.shot('departures-label')] };
  }, { retry: 0 });

  // ---- drag a rotation +120 px → cns_schedule (5-min steps), toast, block moves; reload persists; classic agrees --
  let dragged = null;
  await ctx.check('drag-reschedule-persists', async () => {
    await prepared(v2);
    const blocks = await v2.eval(BLOCKS);
    const st0 = await v2.eval(ENGINE);
    const cand = blocks.filter(b => b.visible && !b.covered && b.x + 120 + b.w / 2 < b.trackX + b.trackW - 4 && b.takeoff + 120 / b.trackW * SPAN < H1 - 5 && b.takeoff + 120 / b.trackW * SPAN > H0 + 65);
    if (!cand.length) throw new Error('no draggable, uncovered block with room for +120 px — blocks: ' + j(blocks));
    const b = cand.find(c => /chg/.test(c.cls)) || cand[0];
    const [tripId, k] = b.key.split(':');
    const schedBefore = st0.sched[tripId]; if (!Array.isArray(schedBefore) || schedBefore.length <= +k) throw new Error(`cns_schedule[${tripId}] = ${j(schedBefore)} has no slot ${k}`);
    const dm = 120 / b.trackW * SPAN; const nt = Math.max(H0 + 60, Math.min(H1, Math.round((b.takeoff + dm) / 5) * 5));
    await v2.eval('__toasts.length = 0; __schedWrites.length = 0; true');
    await v2.drag(b.x, b.y, b.x + 120, b.y, 12);
    const toast = await waitToast(v2, /Take-off moved to/, 2500);
    await v2.sleep(150);
    const st1 = await v2.eval(ENGINE); const after = await blockByKey(v2, b.key); const writes = await v2.eval('__schedWrites.length');
    const stored = (st1.sched[tripId] || [])[+k];
    const pr = [];
    if (stored !== nt) pr.push(`cns_schedule[${tripId}][${k}] = ${stored}, expected ${nt} (= round((${b.takeoff} + 120/${b.trackW.toFixed(1)}×${SPAN}) / 5) × 5)`);
    if (stored % 5) pr.push(`stored take-off ${stored} is not a multiple of 5`);
    if (!toast) pr.push(`no "Take-off moved to …" toast (toasts: ${j(await toasts(v2))})`);
    else if (toast !== `Take-off moved to ${clock(nt)}`) pr.push(`toast "${toast}" ≠ "Take-off moved to ${clock(nt)}"`);
    if (!after) pr.push(`block ${b.key} vanished after the re-render`);
    else {
      // the handle block is the rotation's first RENDERED phase (a charge when departures are hidden), so its left% is
      // pct(takeoff + phase start): it must shift by exactly the take-off delta, not land on pct(takeoff)
      if (Math.abs(after.left - b.left) < 0.5) pr.push(`block left% did not move (${b.left.toFixed(2)}% → ${after.left.toFixed(2)}%)`);
      const shift = (after.takeoff - b.takeoff) / SPAN * 100;
      if (Math.abs((after.left - b.left) - shift) > 0.05) pr.push(`block moved ${(after.left - b.left).toFixed(2)}% but its take-off moved ${after.takeoff - b.takeoff} min = ${shift.toFixed(2)}%`);
      if (after.takeoff < nt || after.takeoff - nt > 5) pr.push(`block data-takeoff ${after.takeoff} vs desired ${nt} (a lane's first rotation must take off at its desired time)`);
    }
    dragged = { key: b.key, tripId, k: +k, nt, takeoff0: b.takeoff, left0: b.left, left1: after && after.left, takeoff1: after && after.takeoff, grp: b.grp, lab: b.lab, cls: b.cls, x: b.x, y: b.y, trackW: b.trackW };
    ctx.state.dragged = dragged;
    await ctx.screenshot(v2, 'drag-reschedule');
    const detail = `${b.grp} / ${b.lab} [${b.cls}] key ${b.key}: takeoff ${b.takeoff} (${clock(b.takeoff)}) → drag +120 px of ${b.trackW.toFixed(0)} px track (dm ${dm.toFixed(1)} min) → stored ${stored} (${clock(stored || 0)}) expected ${nt}; toast "${toast}"; block left ${b.left.toFixed(2)}% → ${after ? after.left.toFixed(2) : '?'}% data-takeoff ${after ? after.takeoff : '?'}; cns_schedule writes ${writes}`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'drawer open (airport lanes), Input.dispatchMouseEvent press/move ×12/release +120 px on a .blk[data-drag]', evidence: [ctx.shot('drag-reschedule')] };
  }, { retry: 0 });

  await ctx.check('drag-reload-persists', async () => {
    if (!dragged) throw new Error('blocked: drag-reschedule-persists did not run/pass');
    await v2.goto(ctx.base + '/v2', { boot: 'v2' }); await install(v2);
    const sched = await v2.eval(`JSON.parse(localStorage.getItem('cns_schedule') || '{}')`);
    const stored = (sched[dragged.tripId] || [])[dragged.k];
    await prepared(v2);
    const after = await blockByKey(v2, dragged.key);
    await ctx.screenshot(v2, 'drag-reload');
    const pr = [];
    if (stored !== dragged.nt) pr.push(`after reload cns_schedule[${dragged.tripId}][${dragged.k}] = ${stored}, expected ${dragged.nt}`);
    if (!after) pr.push(`block ${dragged.key} not found after reload`);
    else { if (Math.abs(after.left - dragged.left1) > 0.05) pr.push(`block left ${after.left.toFixed(2)}% ≠ ${dragged.left1.toFixed(2)}% before the reload`); if (after.takeoff !== dragged.takeoff1) pr.push(`data-takeoff ${after.takeoff} ≠ ${dragged.takeoff1} before the reload`); }
    if (pr.length) throw new Error(pr.join('; '));
    return { detail: `reload → cns_schedule[${dragged.tripId}][${dragged.k}] = ${stored}; block ${dragged.key} left ${after.left.toFixed(2)}% takeoff ${after.takeoff} (same as before the reload)`, repro: 'after the drag: goto /v2 again, Network mode, open the drawer, find .blk[data-drag=key]', evidence: [ctx.shot('drag-reload')] };
  }, { retry: 0 });

  const classic = await ctx.classicPage(v2.browser);
  await ctx.check('drag-classic-parity', async () => {
    if (!dragged) throw new Error('blocked: drag-reschedule-persists did not run/pass');
    await prepared(v2);
    const a = await v2.eval(SUMMARIES), c = await classic.eval(SUMMARIES);
    const rows = await v2.eval(`Object.fromEntries(CNSUI.network.rows().map(r => [r.ident, { latestEnd: r.latestEnd, ends: (document.querySelector('#railBody .ap[data-ap="' + r.ident + '"] .tiles3 .s') ? [...document.querySelectorAll('#railBody .ap[data-ap="' + r.ident + '"] .tiles3 .s')].map(e => e.textContent.trim()).find(t => /^ends|runs past/.test(t)) : null) }]))`);
    const fmtH = clock;   // the rail prints a CLOCK (CNSUnits.fmtClock: round to the minute, zero-padded) — not the ceil duration formatter this check used to transcribe
    const pr = [];
    for (const id of Object.keys(a)) {
      if (a[id].latestEnd !== c[id].latestEnd) pr.push(`${id}: v2 latestEnd ${a[id].latestEnd} ≠ classic ${c[id].latestEnd}`);
      if (a[id].peakKw !== c[id].peakKw) pr.push(`${id}: v2 peakKw ${a[id].peakKw} ≠ classic ${c[id].peakKw}`);
      if (rows[id] && rows[id].latestEnd !== a[id].latestEnd) pr.push(`${id}: rows().latestEnd ${rows[id].latestEnd} ≠ summary ${a[id].latestEnd}`);
      if (rows[id] && rows[id].ends && !a[id].overflow && rows[id].ends !== 'ends ' + fmtH(a[id].latestEnd)) pr.push(`${id}: rail "${rows[id].ends}" ≠ "ends ${fmtH(a[id].latestEnd)}"`);
    }
    const cl = await classic.eval(`(function(){ const s = JSON.parse(localStorage.getItem('cns_schedule') || '{}'); return { stored: (s[${j(dragged.tripId)}] || [])[${dragged.k}], folder: CNSDemand.loadFolder().length, cards: document.querySelectorAll('#folder .sched-card-summary').length, summaries: [...document.querySelectorAll('#folder .sched-card-summary')].map(e => e.textContent.trim()) }; })()`);
    if (cl.stored !== dragged.nt) pr.push(`classic tab reads cns_schedule[${dragged.tripId}][${dragged.k}] = ${cl.stored}, expected ${dragged.nt}`);
    await ctx.screenshot(classic, 'drag-classic-parity.classic');
    ctx.state.summaries = { v2: a, classic: c, rows };
    const detail = `summary per airport v2 ${j(a)} classic ${j(c)}; v2 rail ${j(rows)}; classic folder ${cl.folder} cards ${j(cl.summaries)}`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'after the drag: open /?desktop=1 in the same profile, compare CNSScheduler.summary(id) in both tabs', evidence: [ctx.shot('drag-classic-parity.classic')] };
  }, { retry: 0 });

  // ---- the rail's "ends H:MM" must print the same clock as the classic card's "last ends HH:MM" ------------------
  await ctx.check('ends-clock-parity', async () => {
    await prepared(v2);
    const v = await v2.eval(`Object.fromEntries(CNSUI.network.rows().map(r => [r.ident, { latestEnd: r.latestEnd, ends: [...document.querySelectorAll('#railBody .ap[data-ap="' + r.ident + '"] .tiles3 .s')].map(e => e.textContent.trim()).find(t => /^ends|runs past/.test(t)) || null }]))`);
    const c = await classic.eval(`Object.fromEntries([...document.querySelectorAll('#folder .sched-toggle[data-ident]')].map(b => [b.dataset.ident, (b.querySelector('.sched-card-summary') || { textContent: '' }).textContent.trim()]))`);
    const pr = [], lines = [];
    for (const id of Object.keys(v)) {
      const cm = String(c[id] || '').match(/last ends (\d\d):(\d\d)/); const vm = String(v[id].ends || '').match(/ends (\d+):(\d\d)/);
      if (!cm || !vm) { lines.push(`${id}: v2 "${v[id].ends}" classic "${c[id]}"`); continue; }
      const vMin = +vm[1] * 60 + +vm[2], cMin = +cm[1] * 60 + +cm[2];
      lines.push(`${id}: latestEnd ${v[id].latestEnd.toFixed(2)} → v2 "${v[id].ends}" classic "last ends ${cm[1]}:${cm[2]}"`);
      if (vMin !== cMin) pr.push(`${id}: v2 rail "${v[id].ends}" ≠ classic card "last ends ${cm[1]}:${cm[2]}" for latestEnd ${v[id].latestEnd.toFixed(3)} min (classic CNSUnits.fmtClock rounds to the nearest minute; v2 fmt.h ceils via CNSUnits.r)`);
    }
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + lines.join(' | '));
    return { detail: lines.join(' | '), repro: 'same profile: v2 Network rail row "ends …" vs classic #folder .sched-card-summary "last ends …"' };
  }, { retry: 0 });

  // ---- drag far left in the FLEET view → clamps at 07:00 (engine DAY_START), never before ------------------------
  await ctx.check('drag-clamp-day-start', async () => {
    await prepared(v2); await ensureLanes(v2, 'fleet');
    const blocks = (await v2.eval(BLOCKS)).filter(b => b.visible && !b.covered);
    if (!blocks.length) throw new Error('fleet view: no uncovered draggable block');
    const b = blocks.find(c => c.takeoff > 420) || blocks[0];
    const [tripId, k] = b.key.split(':');
    await v2.eval('__toasts.length = 0; true');
    await v2.drag(b.x, b.y, Math.max(2, b.x - 900), b.y, 14);
    const toast = await waitToast(v2, /Take-off moved to/, 2500); await v2.sleep(150);
    const sched = await v2.eval(`JSON.parse(localStorage.getItem('cns_schedule') || '{}')`); const after = await blockByKey(v2, b.key);
    const stored = (sched[tripId] || [])[+k];
    await ctx.screenshot(v2, 'drag-clamp');
    await ensureLanes(v2, 'airports');
    const pr = [];
    if (stored !== 420) pr.push(`stored ${stored}, expected the clamp 420 (07:00 = CNSScheduler.DAY_START)`);
    if (toast !== 'Take-off moved to 07:00') pr.push(`toast "${toast}"`);
    if (!after || after.takeoff !== 420) pr.push(`block data-takeoff ${after && after.takeoff}`);
    if (after && Math.abs(after.left - pct(420)) > 0.05) pr.push(`fleet block left ${after.left.toFixed(2)}% ≠ pct(420) ${pct(420).toFixed(2)}% (fleet lanes draw the fly phase first, at the take-off)`);
    const detail = `fleet lane "${b.lab}" key ${b.key} takeoff ${b.takeoff} → drag −${Math.min(900, b.x - 2).toFixed(0)} px → stored ${stored}, toast "${toast}", block takeoff ${after && after.takeoff} left ${after && after.left.toFixed(2)}%`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'fleet view, drag a lane block far to the left', evidence: [ctx.shot('drag-clamp')] };
  }, { retry: 0 });

  // ---- a plain click on a block must not write the schedule nor toast ----------------------------------------
  await ctx.check('click-without-drag', async () => {
    await prepared(v2);
    const blocks = (await v2.eval(BLOCKS)).filter(b => b.visible && !b.covered);
    if (!blocks.length) throw new Error('no uncovered draggable block');
    const b = blocks.find(c => /chg/.test(c.cls)) || blocks[0];
    const before = await v2.eval(`localStorage.getItem('cns_schedule')`);
    await v2.eval('__toasts.length = 0; __schedWrites.length = 0; true');
    await v2.clickAt(b.x, b.y);                                  // press + release at the same point: no movement at all
    await v2.sleep(700);
    const res = await v2.eval(`({ sched: localStorage.getItem('cns_schedule'), writes: __schedWrites.length, toasts: __toasts.map(t => t.text), showing: document.querySelector('#toast').classList.contains('show') })`);
    // control: the same plain click on the row LABEL next to the block (no block under the pointer)
    const lab = await v2.rect('#gantt .grow.sub .lab');
    await v2.eval('__toasts.length = 0; __schedWrites.length = 0; true');
    await v2.clickAt(lab.cx, lab.cy); await v2.sleep(500);
    const ctl = await v2.eval(`({ writes: __schedWrites.length, toasts: __toasts.map(t => t.text) })`);
    await ctx.screenshot(v2, 'click-without-drag');
    const pr = [];
    const moved = res.toasts.filter(t => /Take-off moved/.test(t));
    if (moved.length) pr.push(`a plain click toasted ${j(moved)}`);
    if (res.writes) pr.push(`a plain click wrote cns_schedule ${res.writes}× (value ${res.sched === before ? 'unchanged' : 'CHANGED'})`);
    if (res.sched !== before) pr.push(`cns_schedule changed by a plain click: ${before} → ${res.sched}`);
    const detail = `block ${b.key} (${b.cls}) at (${b.x.toFixed(0)},${b.y.toFixed(0)}) takeoff ${b.takeoff}: writes ${res.writes}, toasts ${j(res.toasts)}, schedule ${res.sched === before ? 'unchanged' : 'changed'}; control click on the lane label: writes ${ctl.writes}, toasts ${j(ctl.toasts)}`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'drawer open, Input.dispatchMouseEvent mousePressed+mouseReleased at a .blk[data-drag] centre, no mouseMoved', evidence: [ctx.shot('click-without-drag')] };
  }, { retry: 0 });

  // ---- focus chip clears the isolation once (one render, one fit), not twice --------------------------------
  await ctx.check('focus-chip', async () => {
    await prepared(v2);
    await isolate(v2, 'EHLE');
    const iso = await v2.eval(DRAWER);
    // control: the rail's "← All airports" button (network.js only) — count the passes it triggers
    await v2.eval(COUNTERS);
    await v2.click('#railBody [data-act=focus][data-ap=""]'); await v2.waitFor(`CNSUI.S.filter === ''`, 3000, 50); await v2.sleep(200);
    const ctl = await v2.eval('({ ...__cnt })');
    await isolate(v2, 'EHLE');
    const iso2 = await v2.eval(DRAWER);
    await v2.eval(COUNTERS);
    const r = await v2.click('#focChip'); await v2.waitFor(`CNSUI.S.filter === ''`, 3000, 50); await v2.sleep(200);
    const cnt = await v2.eval('({ ...__cnt })'); const after = await v2.eval(DRAWER);
    await ctx.screenshot(v2, 'focus-chip');
    const pr = [];
    if (iso.filter !== 'EHLE' || iso.chipHidden || !/^EHLE/.test(iso.chipText) || j(iso.grp) !== j(['EHLE']) || !/^EHLE load/.test(iso.loadLab)) pr.push(`isolation via the group button: filter ${iso.filter}, chip hidden ${iso.chipHidden} "${iso.chipText}", groups ${j(iso.grp)}, load "${iso.loadLab}"`);
    if (after.filter !== '' || !after.chipHidden || after.grp.length < 2) pr.push(`after the chip click: filter "${after.filter}", chip hidden ${after.chipHidden}, groups ${j(after.grp)}`);
    if (cnt.render !== 1 || cnt.fitNet !== 1) pr.push(`#focChip click ran CNSUI.render ${cnt.render}× and map.fitNet ${cnt.fitNet}× (network.render ${cnt.netRender}, timeline.render ${cnt.tlRender}, drawNet ${cnt.drawNet}); control "← All airports": render ${ctl.render}, fitNet ${ctl.fitNet}`);
    const detail = `chip at (${r.cx.toFixed(0)},${r.cy.toFixed(0)}) "${iso2.chipText}": filter ${iso2.filter} → "${after.filter}", chip hidden ${after.chipHidden}, groups ${j(iso2.grp)} → ${j(after.grp)}; passes on the chip click ${j(cnt)}; control "← All airports" ${j(ctl)}`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'Network mode, isolate EHLE via the drawer group button, wrap CNSUI.render/map.fitNet with counters, real click #focChip', evidence: [ctx.shot('focus-chip')] };
  }, { retry: 0 });

  // ---- the drawer's per-airport peak equals the rail's peak, with charger efficiency off and on -----------
  const setEff = async on => { await v2.eval(`CNSSettings.save({ chargerEfficiency: { enabled: ${on} } }); true`); await v2.sleep(700); await prepared(v2); };
  const parseKw = s => { const m = String(s).match(/peak\s+([\d.,]+)\s*(kW|MW)/i); return m ? parseFloat(m[1].replace(/,/g, '')) * (/MW/i.test(m[2]) ? 1000 : 1) : NaN; };
  /** Per airport: the drawer's group-row "peak", the rail row's "peak kW", rows().peak, the engine's event peak, the drawer's
      15-min binned peak, the classic card's peak (summary × gridMul) and the installed charger power (the physical ceiling). */
  const readPeaks = async () => { const dr = await v2.eval(DRAWER), st = await v2.eval(ENGINE);
    const rail = await v2.eval(`Object.fromEntries([...document.querySelectorAll('#railBody .ap[data-ap]')].map(ap => [ap.dataset.ap, (ap.querySelectorAll('button > .st')[1] || { textContent: '' }).textContent.trim()]))`);
    const installed = await v2.eval(`Object.fromEntries(CNSUI.network.rows().map(r => [r.ident, r.fleet.reduce((s, c) => s + c.power_kw, 0)]))`);
    const classicPeak = await classic.eval(`(function(){ const g = CNSSettings.gridDemandFactor(); return Object.fromEntries(${j(['EHLE', 'EDDF', 'EHAM', 'EDDL'])}.map(id => [id, { peak: CNSScheduler.summary(id).peakKw * g, text: (document.querySelector('#folder .sched-toggle[data-ident="' + id + '"] .sched-card-summary') || { textContent: '' }).textContent.trim() }])); })()`);
    const per = {}; dr.grp.forEach((id, i) => { per[id] = { drawer: parseKw(dr.grpPeak[i]), drawerText: dr.grpPeak[i].replace(/^.*· /, ''), railText: rail[id], rail: /MW/i.test(rail[id]) ? ctx.num(rail[id]) * 1000 : ctx.num(rail[id]), rows: st.peaks[id] && st.peaks[id].rail, engine: st.peaks[id] && st.peaks[id].engine, binned: st.peaks[id] && st.peaks[id].binned, classic: classicPeak[id] && classicPeak[id].peak, classicText: classicPeak[id] && classicPeak[id].text, installed: installed[id] }; });
    return { per, gridMul: st.gridMul, effOn: st.effOn, sub: dr.sub }; };
  const fmtPer = (id, p) => `${id}: drawer "${p.drawerText}" rail "${p.railText}" | rows().peak ${p.rows.toFixed(1)}, engine peakKw ${p.engine.toFixed(1)}, drawer 15-min binned ${p.binned.toFixed(1)}, classic card ${p.classic.toFixed(1)} ("${p.classicText}"), installed ${p.installed} kW`;
  const tolOf = p => (/MW/i.test(p.drawerText) || p.rail >= 1000) ? 50 : (/MW/i.test(p.railText || '') ? 5 : 1);   // MW: one decimal from 1 MW, two below
  ctx.cleanup(async () => { try { await v2.eval(`CNSSettings.save({ chargerEfficiency: { enabled: false } }); true`); } catch (e) {} });

  await ctx.check('peak-consistency-eff-off', async () => {
    await setEff(false); const r = await readPeaks();
    await ctx.screenshot(v2, 'peak-eff-off');
    const pr = [];
    if (r.effOn || r.gridMul !== 1) pr.push(`efficiency still on (gridMul ${r.gridMul})`);
    for (const [id, p] of Object.entries(r.per)) {
      if (!(Math.abs(p.drawer - p.rail) <= tolOf(p))) pr.push(`${id}: drawer "${p.drawerText}" ≠ rail "${p.railText}" (engine event peak ${p.engine.toFixed(1)} = classic card ${p.classic.toFixed(1)}; the drawer's 15-min binned peak is ${p.binned.toFixed(1)}; installed chargers ${p.installed} kW)`);
      if (p.drawer > p.installed + 1) pr.push(`${id}: drawer peak ${p.drawer} kW exceeds the installed charger power ${p.installed} kW`);
    }
    const detail = `gridMul ${r.gridMul}: ` + Object.entries(r.per).map(([id, p]) => fmtPer(id, p)).join(' || ');
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'Network mode + drawer open, charger efficiency off: compare .grow.grp small "peak …" with the rail row "peak kW", the classic card and the installed charger power', evidence: [ctx.shot('peak-eff-off')] };
  }, { retry: 0 });

  await ctx.check('peak-consistency-eff-on', async () => {
    await setEff(true); const r = await readPeaks();
    await ctx.screenshot(v2, 'peak-eff-on');
    await setEff(false);
    const pr = [];
    if (!(r.gridMul > 1.05)) pr.push(`gridDemandFactor with efficiency on = ${r.gridMul} (settings save did not apply?)`);
    for (const [id, p] of Object.entries(r.per)) {
      if (Math.abs(p.binned - p.engine) > 0.5) continue;   // airports where the binning already disagrees are covered by peak-consistency-eff-off
      if (!(Math.abs(p.drawer - p.rail) <= tolOf(p))) pr.push(`${id}: drawer "${p.drawerText}" ≠ rail "${p.railText}" (rail = engine ${p.engine.toFixed(1)} × gridMul ${r.gridMul.toFixed(4)} = ${(p.engine * r.gridMul).toFixed(1)} = classic card ${p.classic.toFixed(1)}; the drawer stays at the aircraft-side ${p.binned.toFixed(1)})`);
    }
    const detail = `gridMul ${r.gridMul.toFixed(4)}: ` + Object.entries(r.per).map(([id, p]) => fmtPer(id, p)).join(' || ');
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'Network mode + drawer open, CNSSettings.save({chargerEfficiency:{enabled:true}}): compare the drawer group peak with the rail row peak and the classic card', evidence: [ctx.shot('peak-eff-on')] };
  }, { retry: 0 });

  // ---- the group-row focus button in Plan mode (the drawer is visible in both modes) --------------------------
  await ctx.check('focus-button-plan-mode', async () => {
    await prepared(v2);
    // control: in Network mode the same real click isolates the airport
    await v2.click('#gantt .grow.grp .lab button[data-act=focus][data-ap=EDDF]'); await v2.sleep(300);
    const net = await v2.eval(DRAWER);
    await v2.click('#focChip'); await v2.waitFor(`CNSUI.S.filter === ''`, 3000, 50); await v2.sleep(200);
    await setMode(v2, 'plan'); await ensureDrawer(v2, true); await ensureLanes(v2, 'airports');
    const has = await v2.eval(`!!document.querySelector('#gantt .grow.grp .lab button[data-act=focus][data-ap=EDDF]')`);
    if (!has) throw new Error('Plan mode: no EDDF group button in the drawer');
    const r = await v2.click('#gantt .grow.grp .lab button[data-act=focus][data-ap=EDDF]'); await v2.sleep(400);
    const plan = await v2.eval(DRAWER);
    await ctx.screenshot(v2, 'focus-button-plan-mode');
    await setMode(v2, 'network'); if (await v2.eval('CNSUI.S.filter')) { await v2.click('#focChip'); await v2.sleep(200); }
    const pr = [];
    if (net.filter !== 'EDDF') pr.push(`control (Network mode) did not isolate: filter "${net.filter}"`);
    if (plan.filter !== 'EDDF' || plan.chipHidden) pr.push(`Plan mode: the group button did nothing (filter "${plan.filter}", chip hidden ${plan.chipHidden}, mode ${plan.mode}) — network.js:167 returns before 'focus' unless S.mode === 'network'`);
    else if (plan.mode !== 'network') pr.push(`Plan mode: isolated EDDF but stayed in ${plan.mode} mode (expected to switch to Network)`);
    const detail = `Network-mode control: filter "${net.filter}" groups ${j(net.grp)}; Plan-mode click at (${r.cx.toFixed(0)},${r.cy.toFixed(0)}) top=${r.topTag}: filter "${plan.filter}", chip hidden ${plan.chipHidden}, mode ${plan.mode}, groups ${j(plan.grp)}`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'Plan mode, drawer open, real click on the EDDF button of its group row', evidence: [ctx.shot('focus-button-plan-mode')] };
  }, { retry: 0 });

  // ---- #network::fleet deep link in the seeded profile: the `::fleet` view mechanics with routes present ----------
  await ctx.check('network-fleet-deep-link', async () => {
    const p = await ctx.v2Page({ browser: v2.browser, hash: 'network::fleet' }); await install(p);
    await p.waitFor(`CNSUI.S.mode === 'network' && CNSUI.S.lanes === 'fleet' && document.querySelector('#drawer').classList.contains('open')`, 10000, 100); await settle(p);
    const dr = await p.eval(DRAWER), st = await p.eval(ENGINE);
    await ctx.screenshot(p, 'network-fleet-deep-link');
    const pr = [];
    if (j(dr.segOn) !== j(['fleet'])) pr.push(`#laneSeg .on ${j(dr.segOn)}`);
    if (dr.rows !== st.lanes || st.lanes < 1) pr.push(`fleet rows ${dr.rows} ≠ runGlobal().lanes.length ${st.lanes}`);
    if (!dr.depSwHidden || !dr.depLblHidden) pr.push('departures switch/label visible in the fleet view');
    if (!(new RegExp(`^${st.lanes} aircraft ·`)).test(dr.sub)) pr.push(`#drawerSub "${dr.sub}"`);
    const detail = `#network::fleet → mode ${dr.mode}, lanes ${dr.lanes} seg ${j(dr.segOn)}, drawer open ${dr.open} (${dr.height}px), fleet rows ${dr.rows} = lanes ${st.lanes} ${j(st.laneKeys)}, folder ${st.folder}, sub "${dr.sub}"`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'seeded profile: open /v2#network::fleet in a second tab', evidence: [ctx.shot('network-fleet-deep-link')] };
  });

  // ---- #hub::fleet deep link (own Chrome: loadScenario wipes the folder of its profile) ------------------------
  await ctx.check('hub-fleet-deep-link', async () => {
    const p = await ctx.v2Page({ hash: 'hub::fleet', timeout: 40000 }); await install(p);
    await p.waitFor(`!!(window.__toasts || []).find(t => /loaded/.test(t.text)) || (CNSUI.S.lanes === 'fleet' && document.querySelector('#drawer').classList.contains('open'))`, 30000, 150);
    await p.sleep(800);
    const dr = await p.eval(DRAWER), st = await p.eval(ENGINE);
    const hub = await p.eval(`({ routes: CNSUI.network.SCENARIOS.hub.routes.length, planes: [...new Set(CNSUI.network.SCENARIOS.hub.routes.map(r => r[2]))], catalog: CNSUI.PLANES.map(p => p.id) })`);
    const missing = hub.planes.filter(id => !hub.catalog.includes(id));
    await ctx.screenshot(p, 'hub-fleet');
    const pr = [];
    if (dr.mode !== 'network') pr.push(`mode ${dr.mode}`);
    if (dr.lanes !== 'fleet' || j(dr.segOn) !== j(['fleet'])) pr.push(`lanes ${dr.lanes}, #laneSeg .on ${j(dr.segOn)}`);
    if (!dr.open) pr.push('drawer closed');
    if (!dr.depSwHidden || !dr.depLblHidden) pr.push(`departures switch/label visible in the fleet view`);
    if (dr.rows !== st.lanes) pr.push(`fleet rows ${dr.rows} ≠ runGlobal().lanes.length ${st.lanes}`);
    if (st.folder !== hub.routes) { const msg = `hub scenario loaded ${st.folder}/${hub.routes} routes (scenario plane ids ${j(hub.planes)}; not in the production catalog: ${j(missing)}) — the shell component's deep-links-hub defect, so the fleet view here is ${st.lanes ? 'partial' : 'EMPTY'}`; if (st.lanes === 0) { ctx.blockedBy.push('hub-fleet-deep-link: ' + msg); pr.push(msg); } else pr.push(msg); }
    const detail = `#hub::fleet → mode ${dr.mode}, lanes ${dr.lanes} seg ${j(dr.segOn)}, drawer open ${dr.open} (${dr.height}px), fleet rows ${dr.rows} = lanes ${st.lanes} ${j(st.laneKeys)}, folder ${st.folder}/${hub.routes}, empty-state ${dr.empty}, sub "${dr.sub}", toasts ${j(dr.toasts)}`;
    if (pr.length) throw new Error(pr.join('; ') + ' — ' + detail);
    return { detail, repro: 'open /v2#hub::fleet in a fresh profile', evidence: [ctx.shot('hub-fleet')] };
  }, { retry: 0 });

  await ctx.check('no-exceptions', async () => {
    const ex = []; for (const p of ctx.pages) for (const e of ctx.exceptions(p)) ex.push(`${p.label}: ${e.text.split('\n')[0]}`);
    if (ex.length) throw new Error(ex.join(' || '));
    return `pages ${ctx.pages.map(p => p.label).join(', ')}: 0 exceptions (console errors: ${ctx.pages.map(p => p.label + ' ' + p.errors.length).join(', ')})`;
  }, { retry: 0 });
}
