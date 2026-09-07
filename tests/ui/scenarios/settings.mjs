/* settings: the v2 Model settings dialog (static/ui/settings.js + CNSUI.modal in static/ui/app.js) over the
   shared CNSSettings engine (static/settings.js, key cns_settings_v5), against the classic #modelSettingsModal
   (templates/index.html markup 2119–2260, wiring 6185–6390). Both shells read the SAME localStorage blob
   (same Chrome profile), so every number the classic shows after its own Apply path is the oracle.

   Checks (run: node tests/ui/run.mjs settings [--only <check>]):
     dialog · gear-opens (REAL click on #setBtn; expected FAIL — settings.js:36–41 tests #setBtn after the
     closest('[data-ms]') early return) · close · autofocus (expected FAIL — app.js:54 focuses the first
     input = a range slider, so arrow keys change values) · toggle · slider · sid-star-slider (expected FAIL —
     settings.js:11 renders 0–40 step 1 while the engine clamps 5–50, classic #rsSidStarSl is 5/50/5) · live-label ·
     slider-ranges (every slider at min + max against the engine accessors and the classic ranges — expected FAIL:
     SID/STAR 0 km and climb overhead 0 % both display a value the engine replaces by its default via `|| 10` /
     `|| 0.10`) · tariff · reset · example-line · deep-link (/v2#settings) · badge-zero · no-exceptions.

   Every check re-establishes its own preconditions (result rail, open dialog) so --only <check> reproduces
   it alone; the dialog is opened through CNSUI.settings.open() wherever the check is not ABOUT the gear.
   Cross-tab note: neither shell listens to `storage` events (grep addEventListener('storage') → nothing), so
   the classic DISPLAY only follows a v2 write once its own subscribers fire — the checks press the classic's
   Apply button (#rsApplyBtn → CNSSettings.save(loadAll()), index.html:6366) and, for the modal labels, show
   its modal (shown.bs.modal → syncFromState). Its ENGINE numbers follow immediately (loadAll() reads storage). */
import fs from 'node:fs';
import path from 'node:path';
export const component = 'settings';
export const module = 'shell';

const j = v => JSON.stringify(v);
const BETA = 'beta_alia', CH = 'dc_320', O = 'EHLE', D = 'EDDF';
const KEY = 'cns_settings_v5';
const MODEL_KEYS = ['landingReserve', 'alternateReserve', 'climbModel', 'sidStarPadding', 'routingPadding', 'chargeTaper', 'chargeTarget', 'chargerEfficiency'];
const canon = v => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const same = (a, b) => j(canon(a)) === j(canon(b));
const ws = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ---- v2 readers ------------------------------------------------------------------------------
/** Everything the dialog + badge show, plus the stored blob and the engine's view of it. */
const V2_DIALOG = `(function(){ const q = s => document.querySelector(s);
  const stored = (function(){ try { return JSON.parse(localStorage.getItem(${j(KEY)})); } catch (e) { return null; } })();
  const flags = CNSSettings.activeFlags(); const nFlags = Object.entries(flags).filter(([k, v]) => k !== 'anyOn' && v).length;
  const b = q('#setBadge'); const ae = document.activeElement;
  const rows = qa('#modalBox .msr').map(r => { const sw = r.querySelector('.sw'); return { key: sw ? sw.dataset.key : null, name: ws(r.querySelector('.name')), on: sw ? sw.classList.contains('on') : null, off: r.classList.contains('off'),
    sliders: qa('input[type=range]', r).map(i => ({ ms: i.dataset.ms, key: i.dataset.key || null, f: i.dataset.f || null, min: i.min, max: i.max, step: i.step, value: i.value, disabled: i.disabled,
      label: ws((i.dataset.ms === 'rate' ? q('[data-ms-val=rate]') : q('[data-ms-val="' + i.dataset.key + '.' + i.dataset.f + '"]')) || {}) })), example: r.querySelector('[data-ms=example]') ? ws(r.querySelector('[data-ms=example]')) : null }; });
  function ws(el) { return String((el && el.textContent) || '').replace(/\\s+/g, ' ').trim(); } function qa(s, el) { return [...(el || document).querySelectorAll(s)]; }
  return { open: !q('#modal').hidden, isMs: !!q('#modalBox .ms'), rows, badge: b ? { text: b.textContent, hidden: b.hidden } : null, nFlags, flags, stored, loadAll: CNSSettings.loadAll(), defaults: CNSSettings.DEFAULTS,
    active: ae ? { tag: ae.tagName.toLowerCase(), type: ae.type || null, ms: ae.dataset ? ae.dataset.ms || null : null, key: ae.dataset ? ae.dataset.key || null : null, inModal: !!ae.closest('#modalBox') } : null,
    plane: CNSUI.S.planeId, rail: CNSUI.S.rail, mode: CNSUI.S.mode }; })()`;
/** The result rail as rendered: energy tile, cost headline + audit line, battery-chart reserve labels, calc pane. */
const V2_RESULT = `(function(){ const q = s => document.querySelector(s); const t = s => { const e = q(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
  const d = CNSUI.plan.derive(); const p = CNSUI.plane(); const svg = q('#railBody .soc svg');
  const calc = t('#railBody .calc') || ''; const mU = calc.match(/usable (\\d+) %/);
  const metaText = [...document.querySelectorAll('#railBody .meta')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()).find(x => /^Reach /.test(x)) || null;   // the aircraft card's line (the charger card has a .meta too)
  const mReach = (metaText || '').match(/Reach ([\\d,]+) of ([\\d,]+) (km|NM)/);
  return { rail: CNSUI.S.rail, used: d ? d.used : null, charged: d ? d.charged : null, energyTile: t('#railBody .stats .v'), costV: t('#railBody .cost .v'), costM: t('#railBody .cost .m'),
    chartLbl: t('#railBody .soc .lbl .r'), svgReserve: svg ? [...svg.querySelectorAll('text')].map(x => x.textContent.trim()).filter(x => /reserve/.test(x)) : null,
    calcUsable: mU ? +mU[1] : null, metaReach: mReach ? +mReach[1].replace(/,/g, '') : null, metaText,
    reach: CNSUI.planner.availRangeShownKm(p), reachShown: CNSUI.fmt.r(CNSUI.fmt.km(CNSUI.planner.availRangeShownKm(p) || 0)), usable: CNSSettings.usableFraction(p), rate: CNSSettings.chargeRate(),
    fpd: CNSUI.perDay({ freq: CNSUI.S.freq, per: CNSUI.S.per }), plane: p.id, climb: CNSFlight.climbParams(p) }; })()`;
/** Classic spec card + headline + engine view (all from the classic's OWN functions). */
const CLASSIC_STATE = `(function(){ const t = id => { const e = document.getElementById(id); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; }; const spec = selectedPlaneSpec();
  const flags = CNSSettings.activeFlags(); const nFlags = Object.entries(flags).filter(([k, v]) => k !== 'anyOn' && v).length; const badge = document.getElementById('modelBadge');
  return { plane: spec && spec.id, reachVal: t('reachVal'), psAvail: t('psAvail'), avail: spec ? _availRangeShownKm(spec) : null, usable: spec ? CNSSettings.usableFraction(spec) : null, hlUsed: t('hlUsed'), hlRevenue: t('hlRevenue'), hlRevenueSub: t('hlRevenueSub'),
    rate: CNSSettings.chargeRate(), sid: CNSSettings.sidStarPaddingKm(), nFlags, badge: badge ? { text: badge.textContent, hidden: badge.classList.contains('d-none') } : null, loadAll: CNSSettings.loadAll(),
    rsMinSocVal: t('rsMinSocVal'), rsMinSoc: (document.getElementById('rsMinSoc') || {}).value, rsSidStar: (function(){ const s = document.getElementById('rsSidStarSl'); return s ? { min: s.min, max: s.max, step: s.step, value: s.value } : null; })(),
    rsSidStarVal: t('rsSidStarVal'), rsChargeRateVal: t('rsChargeRateVal'), rsClimbEg: t('rsClimbEg'), rsClimbPctVal: t('rsClimbPctVal'),
    rsRanges: Object.fromEntries(['rsMinSoc', 'rsChargerEffSl', 'rsTaperThr', 'rsTaperFloor', 'rsRoutingSl', 'rsSidStarSl', 'rsClimbPctSl', 'rsChargeTargetSl', 'rsChargeRateSl'].map(id => { const s = document.getElementById(id); return [id, s ? { min: s.min, max: s.max, step: s.step, value: s.value } : null]; })), modalShown: !!document.querySelector('#modelSettingsModal.show') }; })()`;

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  const classic = await ctx.classicPage(v2.browser);
  const dump = (name, obj) => { const f = path.join(ctx.out, name + '.json'); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };
  const dlg = () => v2.eval(V2_DIALOG);
  const res = () => v2.eval(V2_RESULT);
  const cls = () => classic.eval(CLASSIC_STATE);
  const stored = async () => (await dlg()).stored;
  const save = patch => v2.eval(`CNSSettings.save(${j(patch)}); true`);
  // Always leave the shared blob at its defaults (the profile is deleted on close, but the classic tab reads it live).
  ctx.cleanup(async () => { try { await v2.eval(`CNSSettings.reset(); CNSDemand.saveFolder([]); true`); } catch (e) {} });

  // ---- helpers the harness lacks (see harnessGaps) ---------------------------------------------
  /** Open the dialog through the module API (NOT the gear — that is the gear-opens check) and let the 30 ms autofocus timer run. */
  async function openDialog() {
    const st = await dlg(); if (st.open && st.isMs) return st;
    await v2.eval(`CNSUI.settings.open(); true`); await v2.waitFor(`!document.querySelector('#modal').hidden && !!document.querySelector('#modalBox .ms')`, 2000, 30); await v2.sleep(150);
    return dlg();
  }
  async function closeDialog() { await v2.eval(`if (CNSUI.modal.isOpen()) CNSUI.modal.close(); true`); await v2.waitFor(`document.querySelector('#modal').hidden`, 1000, 30); }
  /** The v2 result rail for EHLE → EDDF / Alia / 320 kW, 1/day, through the REAL Simulate click. */
  async function ensureResult() {
    const st = await v2.eval(`(function(){ const S = CNSUI.S; return { rail: S.rail, mode: S.mode, o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, plane: S.planeId, charger: S.chargerId, trip: S.trip, freq: S.freq, per: S.per, stops: S.stops.length, result: !!S.result }; })()`);
    const want = { o: O, d: D, plane: BETA, charger: CH, trip: 'one-way', freq: 1, per: 'day', stops: 0 };
    const ok = st.rail === 'result' && st.mode === 'plan' && st.result && Object.keys(want).every(k => st[k] === want[k]);
    if (ok) return;
    if (st.mode !== 'plan') { await v2.click('#modeSeg button[data-mode=plan]'); await v2.waitFor(`CNSUI.S.mode === 'plan'`, 2000, 50); }
    await closeDialog();
    await v2.eval(`(function(){ const S = CNSUI.S, by = CNSUI.byId(); S.origin = by[${j(O)}]; S.dest = by[${j(D)}]; S.stops = []; S.planeId = ${j(BETA)}; S.chargerId = ${j(CH)}; S.trip = 'one-way'; S.freq = 1; S.per = 'day';
      S.picking = false; S.acFilterOpen = false; S.availOverride = null; if (S.blacklist && S.blacklist.clear) S.blacklist.clear(); S.divertOverrides = {}; S.rail = 'form'; S.result = null; S.profile = null; CNSUI.plan.onFormChange(false); return true; })()`);
    const r = await ctx.v2Simulate(v2);
    if (r.err) throw new Error('v2 simulate failed: ' + r.err);
  }
  /** The classic result for the same route (its own form + Simulate). */
  async function ensureClassicResult() {
    const st = await classic.eval(`({ o: selected.origin && selected.origin.ident, d: selected.destination && selected.destination.ident, plane: document.getElementById('plane').value, charger: document.getElementById('charger').value, trip: document.getElementById('tripType').value, has: !!lastResult, shown: !document.getElementById('result').classList.contains('d-none') })`);
    if (st.o === O && st.d === D && st.plane === BETA && st.charger === CH && st.trip === 'one-way' && st.has && st.shown) return;
    await ctx.classicSetRoute(classic, { o: O, d: D, plane: BETA, charger: CH, trip: 'one-way', freqN: 1, freqUnit: 'day' });
    const c = await ctx.classicSimulate(classic); if (c.error) throw new Error('classic simulate failed: ' + c.error);
  }
  /** The classic's own re-render path after a settings write from ANOTHER tab: its Apply button (index.html:6366). */
  async function classicApply() { await classic.eval(`document.getElementById('rsApplyBtn').click(); true`); await classic.sleep(300); return cls(); }
  /** Show the classic modal (shown.bs.modal → syncFromState) to read its slider labels, then hide it again. */
  async function classicModalSync() {
    await classic.eval(`bootstrap.Modal.getOrCreateInstance(document.getElementById('modelSettingsModal')).show(); true`);
    await classic.waitFor(`!!document.querySelector('#modelSettingsModal.show')`, 3000, 50); await classic.sleep(450);
    const st = await cls();
    await classic.eval(`bootstrap.Modal.getOrCreateInstance(document.getElementById('modelSettingsModal')).hide(); true`);
    try { await classic.waitFor(`!document.querySelector('#modelSettingsModal.show')`, 3000, 50); } catch (e) {}
    return st;
  }

  // =============================================================================================
  await ctx.check('dialog', async () => {
    const st = await openDialog();
    const model = st.rows.filter(r => r.key), tariff = st.rows.filter(r => !r.key);
    const fails = [];
    if (st.rows.length !== 9) fails.push(`${st.rows.length} .msr rows (want 8 model rows + the tariff row)`);
    if (model.length !== 8 || MODEL_KEYS.some(k => !model.find(r => r.key === k))) fails.push(`model rows ${j(model.map(r => r.key))} ≠ ${j(MODEL_KEYS)}`);
    if (tariff.length !== 1 || !/Charge tariff/.test(tariff[0].name) || !tariff[0].sliders.find(s => s.ms === 'rate')) fails.push('no tariff row with a [data-ms=rate] slider');
    for (const r of model) { const en = !!st.loadAll[r.key].enabled; if (r.on !== en) fails.push(`${r.key}: switch ${r.on} vs stored enabled ${en}`); if (r.off !== !en) fails.push(`${r.key}: .off ${r.off} vs enabled ${en}`); for (const s of r.sliders) if (s.disabled !== !en) fails.push(`${r.key}.${s.f}: disabled ${s.disabled} while enabled ${en}`); }
    // slider value + label ↔ stored value (display maps of settings.js FIELDS)
    const expect = { 'landingReserve.minLandingSoc': ['20', '20 %'], 'climbModel.overheadPct': ['10', '10 % of battery'], 'climbModel.satFrac': ['15', '15 % of range'], 'sidStarPadding.km': ['10', '10 km'], 'routingPadding.factor': ['105', '1.05×'], 'chargeTaper.threshold': ['75', '75 % SoC'], 'chargeTaper.taperPower': ['30', '30 % of peak'], 'chargeTarget.value': ['80', '80 %'], 'chargerEfficiency.value': ['88', '88 %'] };
    const sliders = {}; for (const r of st.rows) for (const s of r.sliders) sliders[s.ms === 'rate' ? 'rate' : s.key + '.' + s.f] = s;
    for (const [k, [v, l]] of Object.entries(expect)) { const s = sliders[k]; if (!s) { fails.push(`slider ${k} missing`); continue; } if (s.value !== v || s.label !== l) fails.push(`${k}: value "${s.value}" label "${s.label}" (want ${v} / "${l}")`); }
    if (!sliders.rate || sliders.rate.value !== '60' || sliders.rate.label !== '€0.60 / kWh') fails.push(`tariff slider ${j(sliders.rate)} (want 60 / "€0.60 / kWh")`);
    // badge = number of active flags (classic updateBadge: flags minus anyOn — index.html:6262)
    const c = await cls();
    if (!st.badge || st.badge.hidden || st.badge.text !== String(st.nFlags)) fails.push(`#setBadge ${j(st.badge)} vs ${st.nFlags} active flags`);
    if (st.nFlags !== 6 || c.nFlags !== 6) fails.push(`active flags v2 ${st.nFlags} / classic ${c.nFlags} (defaults: 6 on)`);
    if (!same(st.loadAll, st.defaults)) fails.push('loadAll() ≠ DEFAULTS at boot');
    await ctx.screenshot(v2, 'dialog');
    const file = dump('dialog', { v2: st, classic: c });
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    return { detail: `9 rows (8 model + tariff), switches/off/disabled ↔ stored, ${Object.keys(expect).length + 1} slider labels, badge "${st.badge.text}" = ${st.nFlags} flags (classic ${c.nFlags}, #modelBadge ${j(c.badge)})`, repro: 'v2: CNSUI.settings.open(); read #modalBox .msr rows, #setBadge, CNSSettings.loadAll()', evidence: [ctx.shot('dialog'), file] };
  });

  // ---- gear: a REAL click on the topbar gear must open the dialog (the classic gear opens #modelSettingsModal) --
  await ctx.check('gear-opens', async () => {
    await closeDialog();
    const r = await v2.rect('#setBtn'); if (!r) throw new Error('#setBtn missing');
    await v2.clickAt(r.cx, r.cy);
    let opened = true; try { await v2.waitFor(`!document.querySelector('#modal').hidden && !!document.querySelector('#modalBox .ms')`, 1500, 50); } catch (e) { opened = false; }
    await ctx.screenshot(v2, 'gear-click');
    // control: the module API opens the very same dialog (so only the click path is broken)
    let apiOpens = false; if (!opened) { await v2.eval(`CNSUI.settings.open(); true`); try { await v2.waitFor(`!!document.querySelector('#modalBox .ms')`, 1500, 50); apiOpens = true; } catch (e) {} await closeDialog(); }
    // control: the click handler's own guard — the gear is not inside any [data-ms] element
    const guard = await v2.eval(`(function(){ const b = document.querySelector('#setBtn'); return { inDataMs: !!b.closest('[data-ms]'), html: b.outerHTML.slice(0, 120) }; })()`);
    // control (spec): the classic's gear — a REAL click on #planModelSettingsBtn (data-bs-toggle=modal) shows #modelSettingsModal
    let classicOpens = false, cr = null;
    try { cr = await classic.rect('#planModelSettingsBtn'); if (cr && (cr.w || cr.h) && !cr.covered) { await classic.clickAt(cr.cx, cr.cy); await classic.waitFor(`!!document.querySelector('#modelSettingsModal.show')`, 3000, 50); classicOpens = true; } } catch (e) {}
    await ctx.screenshot(classic, 'gear-click-classic');
    try { await classic.eval(`bootstrap.Modal.getOrCreateInstance(document.getElementById('modelSettingsModal')).hide(); true`); await classic.waitFor(`!document.querySelector('#modelSettingsModal.show')`, 3000, 50); } catch (e) {}
    if (!opened) throw new Error(`real click at (${r.cx.toFixed(0)},${r.cy.toFixed(0)}) on #setBtn (covered=${r.covered}, top=${r.topTag}) opened no dialog; CNSUI.settings.open() ${apiOpens ? 'does' : 'does NOT'} open it; #setBtn.closest('[data-ms]')=${guard.inDataMs} — settings.js:36–41 returns before the #setBtn test; classic control: real click on #planModelSettingsBtn ${classicOpens ? 'opens #modelSettingsModal' : 'not clickable (' + j(cr) + ')'}`);
    await closeDialog();
    return { detail: `real click on #setBtn (${r.cx.toFixed(0)},${r.cy.toFixed(0)}) opened the Model settings dialog; classic #planModelSettingsBtn ${classicOpens ? 'opens its modal' : 'not clickable'}`, repro: 'v2: Input.dispatchMouseEvent on #setBtn', evidence: [ctx.shot('gear-click'), ctx.shot('gear-click-classic')] };
  }, { retry: 0 });

  // ---- close paths: Done (real click), Escape (real key), the dim (real click) -----------------
  await ctx.check('close', async () => {
    const out = [];
    await openDialog(); await v2.click('#modalBox .btns [data-modal=close]'); await v2.waitFor(`document.querySelector('#modal').hidden`, 1500, 30); out.push('Done');
    await openDialog(); await v2.press('Escape'); await v2.waitFor(`document.querySelector('#modal').hidden`, 1500, 30); out.push('Escape');
    await openDialog(); const vp = await v2.eval('({ w: innerWidth, h: innerHeight })'); await v2.clickAt(vp.w - 24, vp.h - 24); await v2.waitFor(`document.querySelector('#modal').hidden`, 1500, 30); out.push('dim');
    const box = await v2.eval(`document.querySelector('#modalBox').innerHTML.length`);
    return { detail: `closed by ${out.join(', ')}; #modalBox emptied (${box} chars)`, repro: 'v2: open, click Done / press Escape / click the backdrop' };
  });

  // ---- autofocus: opening the dialog must not focus a range slider (arrow keys would change values) --
  await ctx.check('autofocus', async () => {
    await closeDialog(); await save({ landingReserve: { minLandingSoc: 0.20 } });
    const st = await openDialog();
    const before = st.stored.landingReserve.minLandingSoc;
    await v2.press('ArrowRight'); await v2.sleep(150);
    const after = await dlg(); const sl = after.rows.find(r => r.key === 'landingReserve').sliders[0];
    await ctx.screenshot(v2, 'autofocus');
    // control: with the slider focused on purpose the same key DOES move it (so a no-op above is not a dead key path)
    await v2.focus('#modalBox input[data-key=landingReserve]'); await v2.press('ArrowRight'); await v2.sleep(150);
    const ctl = await dlg(); const ctlSl = ctl.rows.find(r => r.key === 'landingReserve').sliders[0];
    await save({ landingReserve: { minLandingSoc: 0.20 } }); await closeDialog();
    const keyWorks = +ctlSl.value > +sl.value || ctl.stored.landingReserve.minLandingSoc > after.stored.landingReserve.minLandingSoc;
    // control (spec): what the classic focuses when its modal opens (Bootstrap focuses the modal container, tabindex=-1)
    let classicFocus = null;
    try { await classic.eval(`bootstrap.Modal.getOrCreateInstance(document.getElementById('modelSettingsModal')).show(); true`); await classic.waitFor(`!!document.querySelector('#modelSettingsModal.show')`, 3000, 50); await classic.sleep(450);
      classicFocus = await classic.eval(`(function(){ const a = document.activeElement; return a ? { tag: a.tagName.toLowerCase(), type: a.type || null, id: a.id || null, inModal: !!a.closest('#modelSettingsModal') } : null; })()`);
      await classic.eval(`bootstrap.Modal.getOrCreateInstance(document.getElementById('modelSettingsModal')).hide(); true`); await classic.waitFor(`!document.querySelector('#modelSettingsModal.show')`, 3000, 50); } catch (e) { classicFocus = { error: e.message }; }
    const file = dump('autofocus', { openedFocus: st.active, before, after: { stored: after.stored.landingReserve, slider: sl, active: after.active }, control: { stored: ctl.stored.landingReserve, slider: ctlSl }, classicFocus });
    const focusedRange = st.active && st.active.tag === 'input' && st.active.type === 'range';
    if (focusedRange || after.stored.landingReserve.minLandingSoc !== before || sl.value !== '20')
      throw new Error(`on open the focus is on ${j(st.active)}; ArrowRight moved the landing reserve ${before} → ${after.stored.landingReserve.minLandingSoc} (slider "${sl.value}", label "${sl.label}") — app.js:54 modal.open focuses '#modalBox input,#modalBox select' = the first range; control with explicit focus: ${keyWorks ? 'key moves the slider' : 'key does nothing'}; classic modal focuses ${j(classicFocus)} — ${file}`);
    if (!keyWorks) throw new Error('control failed: ArrowRight on the explicitly focused slider changed nothing (harness key path) — ' + file);
    return { detail: `focus on open: ${j(st.active)}; ArrowRight left minLandingSoc at ${before}; control (explicit focus) moved it to ${ctl.stored.landingReserve.minLandingSoc}`, repro: 'v2: CNSUI.settings.open(); press ArrowRight; read cns_settings_v5.landingReserve', evidence: [ctx.shot('autofocus'), file] };
  }, { retry: 0 });

  // ---- toggle: climb model off / on through REAL clicks on the switch ------------------------
  await ctx.check('toggle', async () => {
    await save({ climbModel: { enabled: true, overheadPct: 0.10, satFrac: 0.15 } });
    await ensureResult(); const r0 = await res();
    const st0 = await openDialog(); const badge0 = +st0.badge.text;
    await v2.click('#modalBox .sw[data-key=climbModel]'); await v2.sleep(400);
    const st1 = await dlg(); const r1 = await res(); const row1 = st1.rows.find(r => r.key === 'climbModel');
    await ctx.screenshot(v2, 'toggle-off');
    await v2.click('#modalBox .sw[data-key=climbModel]'); await v2.sleep(400);
    const st2 = await dlg(); const r2 = await res(); const row2 = st2.rows.find(r => r.key === 'climbModel');
    const c = await classicApply();
    const file = dump('toggle', { before: { r: r0, badge: badge0 }, off: { row: row1, stored: st1.stored.climbModel, badge: st1.badge, r: r1 }, on: { row: row2, stored: st2.stored.climbModel, badge: st2.badge, r: r2 }, classic: c });
    const fails = [];
    if (st1.stored.climbModel.enabled !== false) fails.push(`stored climbModel.enabled ${st1.stored.climbModel.enabled} after the off click`);
    if (!row1 || !row1.off || row1.on) fails.push(`row after off: .off=${row1 && row1.off} .sw.on=${row1 && row1.on}`);
    if (row1 && row1.sliders.some(s => !s.disabled)) fails.push('sliders still enabled while the row is off');
    if (+st1.badge.text !== badge0 - 1) fails.push(`badge ${badge0} → ${st1.badge.text} (want −1)`);
    if (!(r1.used < r0.used)) fails.push(`energy did not drop with the climb model off: ${r0.used} → ${r1.used} (tile "${r0.energyTile}" → "${r1.energyTile}")`);
    if (st2.stored.climbModel.enabled !== true || !row2.on || row2.off || +st2.badge.text !== badge0) fails.push(`after the on click: stored ${st2.stored.climbModel.enabled}, .on=${row2.on}, .off=${row2.off}, badge ${st2.badge.text}`);
    if (Math.abs(r2.used - r0.used) > 1e-6) fails.push(`energy not restored: ${r0.used} vs ${r2.used}`);
    if (c.loadAll.climbModel.enabled !== true || c.nFlags !== badge0) fails.push(`classic sees enabled=${c.loadAll.climbModel.enabled}, ${c.nFlags} flags`);
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    return { detail: `off: stored false, .msr.off, badge ${badge0}→${st1.badge.text}, energy ${r0.used.toFixed(2)}→${r1.used.toFixed(2)} kWh ("${r0.energyTile}"→"${r1.energyTile}"); on: restored (${r2.used.toFixed(2)} kWh, badge ${st2.badge.text}); classic flags ${c.nFlags}`, repro: 'v2 with the EHLE→EDDF result: open settings, real click .sw[data-key=climbModel] twice', evidence: [ctx.shot('toggle-off'), file] };
  }, { retry: 0 });

  // ---- landing-reserve slider → 30 %: label, storage, reach, chart; the classic shows the same numbers --
  await ctx.check('slider', async () => {
    await save({ landingReserve: { enabled: true, minLandingSoc: 0.20 } });
    await ensureResult(); await ensureClassicResult(); const c0 = await classicApply();
    const b = await res();
    await openDialog();
    await v2.setValue('#modalBox input[data-key=landingReserve][data-f=minLandingSoc]', '30', ['input', 'change']); await v2.sleep(400);
    const st = await dlg(); const sl = st.rows.find(r => r.key === 'landingReserve').sliders[0];
    const a = await res();
    await ctx.screenshot(v2, 'slider-30-result');
    // the reach bar lives on the form rail: Done (real click) then Edit (real click), read, then Simulate again (real click)
    await v2.click('#modalBox .btns [data-modal=close]'); await v2.waitFor(`document.querySelector('#modal').hidden`, 1500, 30);
    await v2.click('#railBody [data-act=edit]'); await v2.waitFor(`CNSUI.S.rail === 'form' && !!document.querySelector('#railBody .meta')`, 2000, 50);
    const form = await res(); await ctx.screenshot(v2, 'slider-30-form');
    const sim = await ctx.v2Simulate(v2); if (sim.err) throw new Error('re-simulate failed: ' + sim.err);
    const c1 = await classicApply(); const cm = await classicModalSync();
    const file = dump('slider', { before: b, after: a, form, slider: sl, stored: st.stored.landingReserve, classicBefore: c0, classicAfter: c1, classicModal: cm });
    const fails = [];
    if (sl.value !== '30' || sl.label !== '30 %') fails.push(`slider "${sl.value}" label "${sl.label}"`);
    if (st.stored.landingReserve.minLandingSoc !== 0.3) fails.push(`stored minLandingSoc ${st.stored.landingReserve.minLandingSoc}`);
    if (Math.abs(a.usable - 0.7) > 1e-9) fails.push(`usableFraction ${a.usable}`);
    if (!(a.reach < b.reach)) fails.push(`reach did not shrink: ${b.reach} → ${a.reach}`);
    if (!/reserve 30 %/.test(a.chartLbl || '') || !(a.svgReserve || []).includes('reserve 30 %')) fails.push(`chart labels "${a.chartLbl}" / ${j(a.svgReserve)} (want "reserve 30 %")`);
    if (a.calcUsable !== 70) fails.push(`calc pane usable ${a.calcUsable} %`);
    if (form.metaReach == null || form.metaReach !== a.reachShown) fails.push(`form-rail "${form.metaText}" vs reach ${a.reachShown}`);
    if (Math.abs(c1.usable - 0.7) > 1e-9) fails.push(`classic usableFraction ${c1.usable}`);
    if (!(c1.avail < c0.avail)) fails.push(`classic reach did not shrink: ${c0.avail} → ${c1.avail}`);
    if (Math.abs(c1.avail - a.reach) > 0.5) fails.push(`reach v2 ${a.reach} vs classic ${c1.avail}`);
    if (Math.abs(ctx.num(c1.reachVal) - a.reachShown) > 1) fails.push(`classic #reachVal "${c1.reachVal}" vs v2 ${a.reachShown}`);
    if (cm.rsMinSocVal !== '30%' || cm.rsMinSoc !== '30') fails.push(`classic modal slider ${cm.rsMinSoc} / "${cm.rsMinSocVal}"`);
    if (Math.abs(b.used - a.used) > 1e-6) fails.push(`energy changed with the landing reserve: ${b.used} → ${a.used} (reserve must not change the leg energy)`);
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    return { detail: `label "${sl.label}", stored 0.3, usable 0.8→0.7, reach ${b.reach.toFixed(1)}→${a.reach.toFixed(1)} km (form rail "${form.metaText}"), chart "${a.chartLbl}"; classic reach ${c0.avail.toFixed(1)}→${c1.avail.toFixed(1)} (#reachVal "${c1.reachVal}"), modal "${cm.rsMinSocVal}"`, repro: 'v2: settings → landing reserve slider 30 (input+change); classic: #rsApplyBtn, show #modelSettingsModal', evidence: [ctx.shot('slider-30-result'), ctx.shot('slider-30-form'), file] };
  }, { retry: 0 });
  await save({ landingReserve: { minLandingSoc: 0.20 } });

  // ---- SID/STAR slider: its range must be the engine clamp (5–50 step 5, classic #rsSidStarSl) ----
  await ctx.check('sid-star-slider', async () => {
    await save({ sidStarPadding: { enabled: true, km: 10 } });
    const st = await openDialog(); const sl = st.rows.find(r => r.key === 'sidStarPadding').sliders[0];
    const c = await cls();
    // model view: an IFR aircraft (the engine returns 0 for VFR regardless) and no aircraft
    const model = () => v2.eval(`({ ifr: CNSSettings.sidStarPaddingKm(PLANES_BY_ID['diamond_eda40']), any: CNSSettings.sidStarPaddingKm(), stored: CNSSettings.loadAll().sidStarPadding.km })`);
    const m0 = await model();
    // drag the slider to its minimum and to a mid value the classic step could never produce
    await v2.setValue('#modalBox input[data-key=sidStarPadding]', sl.min, ['input', 'change']); await v2.sleep(200);
    const stMin = await dlg(); const slMin = stMin.rows.find(r => r.key === 'sidStarPadding').sliders[0]; const mMin = await model();
    await v2.setValue('#modalBox input[data-key=sidStarPadding]', '7', ['input', 'change']); await v2.sleep(200);
    const st7 = await dlg(); const sl7 = st7.rows.find(r => r.key === 'sidStarPadding').sliders[0]; const m7 = await model();
    await ctx.screenshot(v2, 'sid-star-min');
    await save({ sidStarPadding: { km: 10 } }); await closeDialog();
    const file = dump('sid-star-slider', { v2: sl, classic: c.rsSidStar, engineClamp: '[5,50] (static/settings.js sidStarPaddingKm)', atMin: { slider: slMin, model: mMin }, at7: { slider: sl7, model: m7 }, initial: m0 });
    const fails = [];
    if (sl.min !== '5' || sl.max !== '50' || sl.step !== '5') fails.push(`v2 range min=${sl.min} max=${sl.max} step=${sl.step} (classic #rsSidStarSl ${c.rsSidStar.min}/${c.rsSidStar.max}/${c.rsSidStar.step}, engine clamp 5–50)`);
    if (+slMin.value < 5) fails.push(`slider accepts ${slMin.value} → label "${slMin.label}" while the model uses ${mMin.ifr} km (stored ${mMin.stored})`);
    if (Number(sl7.value) === 7) fails.push(`slider accepts 7 (label "${sl7.label}", model ${m7.ifr}) — the classic steps by 5`);
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    return { detail: `range ${sl.min}–${sl.max} step ${sl.step} = classic ${c.rsSidStar.min}–${c.rsSidStar.max}/${c.rsSidStar.step}; at min: "${slMin.label}" ↔ model ${mMin.ifr} km`, repro: 'v2: settings → read input[data-key=sidStarPadding] min/max/step; set 0 → compare the label with CNSSettings.sidStarPaddingKm(IFR plane)', evidence: [ctx.shot('sid-star-min'), file] };
  }, { retry: 0 });

  // ---- live label: `input` moves the label only, `change` persists (classic: input → label, change → commit, index.html:6273–6276) --
  await ctx.check('live-label', async () => {
    await save({ landingReserve: { enabled: true, minLandingSoc: 0.20 } });
    await openDialog();
    const sel = '#modalBox input[data-key=landingReserve][data-f=minLandingSoc]';
    await v2.setValue(sel, '25', ['input']); await v2.sleep(120);
    const a = await dlg(); const sa = a.rows.find(r => r.key === 'landingReserve').sliders[0];
    await v2.setValue(sel, '25', ['change']); await v2.sleep(250);
    const b = await dlg(); const sb = b.rows.find(r => r.key === 'landingReserve').sliders[0];
    // classic control: the same two events on #rsMinSoc (it reads the v2 write live through loadAll())
    const c = await classic.eval(`(function(){ const s = document.getElementById('rsMinSoc'), l = document.getElementById('rsMinSocVal'); s.value = '35'; s.dispatchEvent(new Event('input', { bubbles: true }));
      const afterInput = { label: l.textContent, stored: CNSSettings.loadAll().landingReserve.minLandingSoc }; s.dispatchEvent(new Event('change', { bubbles: true }));
      const afterChange = { label: l.textContent, stored: CNSSettings.loadAll().landingReserve.minLandingSoc }; return { afterInput, afterChange }; })()`);
    await save({ landingReserve: { minLandingSoc: 0.20 } }); await closeDialog();
    const file = dump('live-label', { v2: { afterInput: { slider: sa, stored: a.loadAll.landingReserve }, afterChange: { slider: sb, stored: b.loadAll.landingReserve } }, classic: c });
    const fails = [];
    if (sa.label !== '25 %') fails.push(`label after input "${sa.label}" (want "25 %")`);
    if (a.loadAll.landingReserve.minLandingSoc !== 0.2) fails.push(`input alone persisted minLandingSoc ${a.loadAll.landingReserve.minLandingSoc}`);
    if (b.loadAll.landingReserve.minLandingSoc !== 0.25 || sb.label !== '25 %') fails.push(`change did not persist: stored ${b.loadAll.landingReserve.minLandingSoc}, label "${sb.label}"`);
    if (c.afterInput.label !== '35%' || c.afterInput.stored !== 0.25 || c.afterChange.stored !== 0.35) fails.push(`classic control ${j(c)} (want input → "35%" with 0.25 kept, change → 0.35)`);
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    return { detail: `input → label "${sa.label}" with stored ${a.loadAll.landingReserve.minLandingSoc}; change → stored ${b.loadAll.landingReserve.minLandingSoc}; classic: input "${c.afterInput.label}" (stored ${c.afterInput.stored}), change → ${c.afterChange.stored}`, repro: 'v2: settings → dispatch input(25) then change(25) on the landing-reserve slider; read the label + cns_settings_v5', evidence: [file] };
  }, { retry: 0 });

  // ---- every slider at min + max: the stored value must be what the engine uses (a label the model ignores = a lie), ranges vs the classic --
  await ctx.check('slider-ranges', async () => {
    const ENGINE = { 'landingReserve.minLandingSoc': `1 - CNSSettings.usableFraction({})`, 'chargerEfficiency.value': `1 / CNSSettings.gridDemandFactor()`, 'routingPadding.factor': `CNSSettings.routingFactor({ regime: 'IFR' })`, 'sidStarPadding.km': `CNSSettings.sidStarPaddingKm({ regime: 'IFR' })`, 'climbModel.overheadPct': `CNSSettings.climbOverheadPct()`, 'climbModel.satFrac': `CNSSettings.climbSatFrac()`, 'chargeTarget.value': `CNSSettings.chargeTargetDefault()`, rate: `CNSSettings.chargeRate()` };
    const CLAMP = { 'chargeTaper.threshold': [0.5, 0.95], 'chargeTaper.taperPower': [0.05, 0.95] };   // chargeTimeMin's internal clamps (static/settings.js) — no accessor to read
    const CLASSIC = { 'landingReserve.minLandingSoc': 'rsMinSoc', 'chargerEfficiency.value': 'rsChargerEffSl', 'chargeTaper.threshold': 'rsTaperThr', 'chargeTaper.taperPower': 'rsTaperFloor', 'routingPadding.factor': 'rsRoutingSl', 'sidStarPadding.km': 'rsSidStarSl', 'climbModel.overheadPct': 'rsClimbPctSl', 'chargeTarget.value': 'rsChargeTargetSl', rate: 'rsChargeRateSl' };
    await closeDialog(); await save(Object.fromEntries(MODEL_KEYS.map(k => [k, { enabled: true }])));
    const st0 = await openDialog(); const c = await cls();
    const rows = [], lies = [], diffs = [];
    for (const r of st0.rows) for (const s of r.sliders) {
      const id = s.ms === 'rate' ? 'rate' : s.key + '.' + s.f; const sel = s.ms === 'rate' ? '#modalBox input[data-ms=rate]' : `#modalBox input[data-key=${s.key}][data-f=${s.f}]`;
      const lblSel = s.ms === 'rate' ? '[data-ms-val=rate]' : `[data-ms-val="${s.key}.${s.f}"]`; const probe = {};
      for (const v of [s.min, s.max]) {
        await v2.setValue(sel, v, ['input', 'change']); await v2.sleep(150);
        const p = await v2.eval(`(function(){ const all = CNSSettings.loadAll(); const stored = ${j(id)} === 'rate' ? all.chargeRate.value : all[${j(s.key)}][${j(s.f)}]; const engine = ${ENGINE[id] || 'null'}; const l = document.querySelector(${j(lblSel)}); const ex = document.querySelector('[data-ms=example]'); return { stored, engine, label: l ? l.textContent.trim() : null, example: ex ? ex.textContent.trim() : null }; })()`);
        probe[v] = p; const cl = CLAMP[id];
        if (p.engine != null && Math.abs(p.engine - p.stored) > 1e-9) lies.push(`${id}=${v} shows "${p.label}" (stored ${p.stored}) while the model uses ${p.engine}${id === 'climbModel.overheadPct' ? ' (example line in the same row: "' + p.example + '")' : ''}`);
        if (cl && (p.stored < cl[0] - 1e-9 || p.stored > cl[1] + 1e-9)) lies.push(`${id}=${v} shows "${p.label}" (stored ${p.stored}) outside the engine clamp [${cl}]`);
      }
      const cr = c.rsRanges[CLASSIC[id]] || null;
      if (cr && (cr.min !== s.min || cr.max !== s.max || cr.step !== s.step)) diffs.push(`${id}: v2 ${s.min}–${s.max}/${s.step} vs classic #${CLASSIC[id]} ${cr.min}–${cr.max}/${cr.step}`);
      rows.push({ id, v2: { min: s.min, max: s.max, step: s.step }, classic: cr, probe });
    }
    // control (spec): the classic at the same 0 % climb overhead — its label, its example line and the shared engine accessor
    await save({ climbModel: { overheadPct: 0 } }); const cm = await classicModalSync(); const cEng = await classic.eval(`CNSSettings.climbOverheadPct()`);
    await v2.eval(`CNSSettings.reset(); true`); await closeDialog();
    const file = dump('slider-ranges', { rows, lies, diffs, classicAtZeroClimb: { rsClimbPctVal: cm.rsClimbPctVal, rsClimbEg: cm.rsClimbEg, engine: cEng } });
    const tail = `; classic at climb 0 %: label "${cm.rsClimbPctVal}", example "${cm.rsClimbEg}", engine ${cEng}` + (diffs.length ? '; range differences vs the classic: ' + diffs.join(', ') : '');
    if (lies.length) throw new Error(lies.join('; ') + tail + ' — ' + file);
    return { detail: `${rows.length} sliders probed at min + max, every stored value is what the engine uses` + tail, repro: 'v2: enable all 8 flags, settings → set each slider to min and to max (input+change), compare cns_settings_v5 with the CNSSettings accessor', evidence: [file] };
  }, { retry: 0 });

  // ---- tariff → €1.00 / kWh in the result cost line and in the network ledger ----------------
  await ctx.check('tariff', async () => {
    await save({ chargeRate: { value: 0.60 } });
    await ensureResult(); await ensureClassicResult();
    const b = await res();
    await openDialog();
    await v2.setValue('#modalBox input[data-ms=rate]', '100', ['input', 'change']); await v2.sleep(400);
    const st = await dlg(); const sl = st.rows.find(r => !r.key).sliders[0];
    const a = await res(); await ctx.screenshot(v2, 'tariff-result');
    await v2.click('#modalBox .btns [data-modal=close]'); await v2.waitFor(`document.querySelector('#modal').hidden`, 1500, 30);
    // ledger: one flight in the network, Network mode by a real click, expand the first airport row by a real click
    const seeded = await ctx.seedNetwork(v2, [{ o: O, d: D, plane: BETA, charger: CH, trip: 'one-way', freq: 1, per: 'day' }]);
    if (seeded[0].err) throw new Error('seedNetwork: ' + seeded[0].err);
    await v2.click('#modeSeg button[data-mode=network]'); await v2.waitFor(`CNSUI.S.mode === 'network' && document.querySelectorAll('#railBody .ap').length > 0`, 4000, 50);
    await v2.click('#railBody .ap > button'); await v2.waitFor(`!!document.querySelector('#railBody .ap.open .tiles3')`, 2000, 50);
    const led = await v2.eval(`(function(){ const t = s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; }; const R = CNSUI.network.rows(); const ap = document.querySelector('#railBody .ap.open');
      return { ident: ap && ap.dataset.ap, tile: t('#railBody .ap.open .tiles3 .s'), tileV: t('#railBody .ap.open .tiles3 .v'), hint: t('#railBody .ntool .hint'), kwh: R.map(r => ({ ident: r.ident, kwh: r.kwh })), total: R.reduce((s, r) => s + r.kwh, 0), rate: CNSSettings.chargeRate() }; })()`);
    await ctx.screenshot(v2, 'tariff-ledger');
    const c = await classicApply();
    // restore: plan mode (real click), empty folder, default tariff
    await v2.click('#modeSeg button[data-mode=plan]'); await v2.waitFor(`CNSUI.S.mode === 'plan'`, 2000, 50);
    await v2.eval(`CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.render(); true`); await save({ chargeRate: { value: 0.60 } });
    const file = dump('tariff', { before: b, after: a, slider: sl, stored: st.stored.chargeRate, ledger: led, classic: c });
    const fails = [];
    if (sl.value !== '100' || sl.label !== '€1.00 / kWh') fails.push(`slider "${sl.value}" label "${sl.label}"`);
    if (st.stored.chargeRate.value !== 1) fails.push(`stored chargeRate.value ${st.stored.chargeRate.value}`);
    if (!/€1\.00 \/ kWh/.test(a.costM || '')) fails.push(`.cost .m "${a.costM}"`);
    const chargedR = Math.ceil(a.charged - 1e-9); const wantCost = chargedR * a.fpd * 1;
    if (Math.abs(ctx.num(a.costV) - wantCost) > 0.011) fails.push(`.cost .v "${a.costV}" vs ${chargedR} kWh × ${a.fpd} × €1.00 = ${wantCost}`);
    if (!/€1\.00 \/ kWh/.test(led.tile || '')) fails.push(`ledger tile "${led.tile}" (airport ${led.ident})`);
    if (Math.abs(ctx.num(led.hint) - led.total) > 0.011) fails.push(`ledger "${led.hint}" vs ${led.total.toFixed(2)} kWh × €1.00`);
    if (Math.abs(led.rate - 1) > 1e-9) fails.push(`network rate() ${led.rate}`);
    if (!/€1\.00\/kWh/.test(ws(c.hlRevenueSub))) fails.push(`classic #hlRevenueSub "${c.hlRevenueSub}"`);
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    return { detail: `label "${sl.label}", stored 1; result "${a.costV}" · "${a.costM}" (was "${b.costM}"); ledger ${led.ident}: "${led.tile}", "${led.hint}" for ${led.total.toFixed(2)} kWh; classic "${c.hlRevenueSub}"`, repro: 'v2: settings → tariff slider 100; result .cost .m; add the flight, Network mode, expand the airport: .tiles3 .s', evidence: [ctx.shot('tariff-result'), ctx.shot('tariff-ledger'), file] };
  }, { retry: 0 });

  // ---- reset: confirm stub → loadAll() equals DEFAULTS; a declined confirm changes nothing ----
  await ctx.check('reset', async () => {
    await save({ chargerEfficiency: { enabled: true, value: 0.9 }, chargeTaper: { threshold: 0.85 }, chargeRate: { value: 1.25 }, climbModel: { enabled: false } });
    const st0 = await openDialog(); if (same(st0.loadAll, st0.defaults)) throw new Error('precondition: state already equals DEFAULTS');
    await v2.eval(`__cns.confirmResult = false; true`); const n0 = await v2.eval('__cns.confirms.length');
    await v2.click('#modalBox [data-ms=reset]'); await v2.sleep(250);
    const declined = await dlg(); const n1 = await v2.eval('__cns.confirms.length');
    await v2.eval(`__cns.confirmResult = true; true`);
    await v2.click('#modalBox [data-ms=reset]'); await v2.sleep(400);
    const st = await dlg(); const n2 = await v2.eval('__cns.confirms.length'); const msg = await v2.eval('__cns.confirms.at(-1)');
    await ctx.screenshot(v2, 'reset');
    const c = await classicApply();
    const file = dump('reset', { before: { loadAll: st0.loadAll, badge: st0.badge }, declined: { loadAll: declined.loadAll, badge: declined.badge }, after: { loadAll: st.loadAll, stored: st.stored, badge: st.badge, rows: st.rows }, confirms: [n0, n1, n2, msg], classic: c });
    const fails = [];
    if (n1 !== n0 + 1 || !same(declined.loadAll, st0.loadAll)) fails.push(`declined confirm: ${n1 - n0} prompt(s), state ${same(declined.loadAll, st0.loadAll) ? 'kept' : 'CHANGED'}`);
    if (n2 !== n1 + 1 || !/reset/i.test(msg || '')) fails.push(`accepted confirm: ${n2 - n1} prompt(s) "${msg}"`);
    if (!same(st.loadAll, st.defaults)) fails.push('loadAll() ≠ DEFAULTS after reset');
    if (!same(st.stored, st.defaults)) fails.push('stored blob ≠ DEFAULTS after reset');
    if (!st.badge || st.badge.text !== '6' || st.badge.hidden) fails.push(`badge ${j(st.badge)} (want 6 visible)`);
    const eff = st.rows.find(r => r.key === 'chargerEfficiency'), tap = st.rows.find(r => r.key === 'chargeTaper'), rate = st.rows.find(r => !r.key);
    if (!eff || eff.on || !eff.off || tap.sliders[0].value !== '75' || rate.sliders[0].label !== '€0.60 / kWh') fails.push(`dialog not re-rendered from defaults: eff.on=${eff && eff.on}, knee=${tap && tap.sliders[0].value}, tariff "${rate && rate.sliders[0].label}"`);
    if (!same(c.loadAll, st.defaults) || c.nFlags !== 6) fails.push(`classic loadAll ≠ DEFAULTS or flags ${c.nFlags}`);
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    await closeDialog();
    return { detail: `declined confirm kept the state; accepted ("${msg}") → loadAll() = DEFAULTS, blob = DEFAULTS, badge 6, rows re-rendered; classic ${c.nFlags} flags`, repro: 'v2: settings → real click [data-ms=reset] with window.confirm stubbed false, then true', evidence: [ctx.shot('reset'), file] };
  }, { retry: 0 });

  // ---- example line names the SELECTED aircraft (classic #rsClimbEg: "<name>: +N kWh per climb — full on legs ≥ M km") --
  await ctx.check('example-line', async () => {
    await closeDialog(); await v2.eval(`CNSSettings.reset(); true`);
    const pick = async id => { await v2.eval(`(function(){ const S = CNSUI.S; S.planeId = ${j(id)}; S.picking = false; S.availOverride = null; CNSUI.plan.onFormChange(false); return true; })()`); await closeDialog(); return openDialog(); };
    const line = st => (st.rows.find(r => r.key === 'climbModel') || {}).example;
    const st1 = await pick(BETA); const ex1 = line(st1);
    const r1 = await res();
    const cm = await classicModalSync();
    // live: the overhead slider moves the example (change handler) — 20 % of 225 kWh = 45 kWh
    await v2.setValue('#modalBox input[data-key=climbModel][data-f=overheadPct]', '20', ['input', 'change']); await v2.sleep(250);
    const ex20 = line(await dlg()); const cp20 = await v2.eval(`CNSFlight.climbParams(CNSUI.plane())`);
    await save({ climbModel: { overheadPct: 0.10 } });
    const st2 = await pick('vertical_vx4'); const ex2 = line(st2);   // eVTOL: powered-lift → not applied
    const st3 = await pick('aura_era'); const ex3 = line(st3);       // hybrid without a battery → not applied
    await ctx.screenshot(v2, 'example-era');
    await pick(BETA); await closeDialog();
    const file = dump('example-line', { beta: { line: ex1, climb: r1.climb, classicEg: cm.rsClimbEg }, at20: { line: ex20, climb: cp20 }, vx4: ex2, era: ex3 });
    const fails = [];
    const want1 = `Alia CX300: +${Math.round(r1.climb.eMaxKwh)} kWh per leg, full from ${Math.round(r1.climb.dSatKm)} km`;
    if (ex1 !== want1) fails.push(`beta: "${ex1}" (want "${want1}")`);
    const cEg = ws(cm.rsClimbEg); const cN = cEg.match(/\+(\d+) kWh/), cM = cEg.match(/≥ (\d+) km/);
    if (!cN || +cN[1] !== Math.round(r1.climb.eMaxKwh) || !cM || +cM[1] !== Math.round(r1.climb.dSatKm) || !/Alia CX300/.test(cEg)) fails.push(`classic #rsClimbEg "${cEg}" ≠ +${Math.round(r1.climb.eMaxKwh)} kWh / ${Math.round(r1.climb.dSatKm)} km`);
    if (!ex20 || !ex20.includes(`+${Math.round(cp20.eMaxKwh)} kWh`) || Math.round(cp20.eMaxKwh) !== 45) fails.push(`at 20 %: "${ex20}" (engine ${cp20.eMaxKwh})`);
    if (!/^VX4: not applied/.test(ex2 || '')) fails.push(`vertical_vx4: "${ex2}"`);
    if (!/^ERA: not applied/.test(ex3 || '')) fails.push(`aura_era: "${ex3}"`);
    if (fails.length) throw new Error(fails.join('; ') + ' — ' + file);
    return { detail: `"${ex1}" (classic "${cEg}"); at 20 %: "${ex20}"; VX4: "${ex2}"; ERA: "${ex3}"`, repro: 'v2: select the aircraft, CNSUI.settings.open(), read [data-ms=example]', evidence: [ctx.shot('example-era'), file] };
  }, { retry: 0 });

  // ---- #settings deep link boots with the dialog open (app.js:151) ----------------------------
  await ctx.check('deep-link', async () => {
    await closeDialog();
    // harness gap: page.goto() to the SAME path + a hash is a same-document navigation (no Page.loadEventFired) — leave the page first
    await v2.send('Page.navigate', { url: 'about:blank' }); await v2.sleep(150);
    await v2.goto(ctx.base + '/v2', { hash: 'settings', boot: 'v2' });
    let opened = true; try { await v2.waitFor(`!document.querySelector('#modal').hidden && !!document.querySelector('#modalBox .ms')`, 5000, 50); } catch (e) { opened = false; }
    await v2.sleep(150); const st = await dlg(); await ctx.screenshot(v2, 'deep-link');
    await closeDialog();
    if (!opened || !st.isMs || st.rows.length !== 9) throw new Error(`/v2#settings: dialog open=${st.open} ms=${st.isMs} rows=${st.rows.length}`);
    return { detail: `/v2#settings boots with the Model settings dialog open (${st.rows.length} rows, badge "${st.badge.text}", focus on open ${j(st.active)})`, repro: 'v2: navigate to /v2#settings', evidence: [ctx.shot('deep-link')] };
  }, { retry: 0 });

  // ---- badge hides at zero flags (classic #modelBadge gets d-none) ---------------------------
  await ctx.check('badge-zero', async () => {
    await closeDialog();
    await save(Object.fromEntries(MODEL_KEYS.map(k => [k, { enabled: false }]))); await v2.sleep(150);
    const st = await dlg(); const c = await classicApply();
    await v2.eval(`CNSSettings.reset(); true`); await v2.sleep(150); const st2 = await dlg();
    if (!st.badge.hidden || st.nFlags !== 0) throw new Error(`badge ${j(st.badge)} with ${st.nFlags} flags`);
    if (!c.badge || !c.badge.hidden || c.nFlags !== 0) throw new Error(`classic badge ${j(c.badge)} with ${c.nFlags} flags`);
    if (st2.badge.hidden || st2.badge.text !== '6') throw new Error(`after reset: badge ${j(st2.badge)}`);
    return { detail: `all 8 off → #setBadge hidden (classic #modelBadge d-none); reset → "6"`, repro: 'v2: CNSSettings.save({…enabled:false}); read #setBadge.hidden' };
  }, { retry: 0 });

  await ctx.check('no-exceptions', async () => {
    const ex = [...ctx.exceptions(v2), ...ctx.exceptions(classic)];
    if (ex.length) throw new Error(ex.map(e => e.text).join(' || '));
    return `v2 errors ${v2.errors.length}, classic errors ${classic.errors.length}, exceptions 0 (known classic ones filtered)`;
  }, { retry: 0 });
}
