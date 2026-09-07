/* trip-freq-charger: the trip-type segment, training (Velis at EHTE parity; an aircraft without a
   published training range → API error in the rail, no exception), the frequency normalisation
   (3 / week → per-day cost = ceil(kWh) × 3/7 × tariff, the classic's weekly headline / 7), the charger
   shortlist / 'All chargers' / the acceptance-cap hint, a custom-charger round-trip through the dialog
   (POST 201 → used by simulate → listed n / 5 → DELETE 200) and a network edit of a flight that sits
   on a custom charger (the classic sends the charger object; network.js:120 sends only charger_id).
   Server state created here is named UI-TEST-r1-0904-tfc-… and swept in cleanup, even on failure. */
export const component = 'trip-freq-charger';
export const module = 'plan';

const TAG = 'UI-TEST-r1-0904-tfc';          // this scenario's prefix (component-specific so a concurrent scenario's chargers survive)
const CAP = 5;
const HINT_RE = { 'one-way': /A to B/i, retour: /back/i, circular: /stop/i, training: /circuit|pattern/i };

// ---- helpers the harness lacks (see harnessGaps in the report) --------------------------------
const listCustoms = async base => { const r = await fetch(base + '/api/custom/chargers'); return r.ok ? r.json() : []; };
async function sweep(base, prefix = TAG) {
  const out = [];
  for (const c of await listCustoms(base)) {
    if (!String(c.name || '').startsWith(prefix)) continue;
    const r = await fetch(`${base}/api/custom/chargers/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    out.push(`${c.id} "${c.name}" → DELETE ${r.status}`);
  }
  return out;
}
const circles = page => page.eval(`(function(){ let n = 0; CNSUI.map.map.eachLayer(l => { if (l instanceof L.Circle) n++; }); return n; })()`);
const tripHint = page => page.eval(`(function(){ const s = document.querySelector('[data-seg=trip]'); const h = s && s.nextElementSibling; return h ? h.textContent.trim() : ''; })()`);
const chgList = page => page.eval(`[...document.querySelectorAll('#railBody .chg')].map(b => ({ id: b.dataset.id, on: b.classList.contains('on'), kw: b.querySelector('.kw').textContent.trim() }))`);
/** Back to a pristine Plan form with real clicks: Plan mode, Edit (when the result rail is up), Reset → beta_alia / dc_320 / EHLE→EDDF / one-way / 1 per day. */
async function resetForm(page) {
  if (await page.eval(`CNSUI.S.mode !== 'plan'`)) { await page.click('#modeSeg button[data-mode="plan"]'); await page.waitFor(`CNSUI.S.mode === 'plan'`, 3000); }
  if (await page.eval(`CNSUI.S.rail === 'result'`)) { await page.click('[data-act=edit]'); await page.waitFor(`CNSUI.S.rail === 'form'`, 3000); }
  await page.click('[data-act=reset]');
  await page.waitFor(`CNSUI.S.rail === 'form' && CNSUI.S.trip === 'one-way' && CNSUI.S.planeId === 'beta_alia' && CNSUI.S.chargerId === 'dc_320' && CNSUI.S.origin && CNSUI.S.origin.ident === 'EHLE' && CNSUI.S.dest && CNSUI.S.dest.ident === 'EDDF' && !CNSUI.S.allChargers && CNSUI.S.freq === 1 && CNSUI.S.per === 'day'`, 3000);
}
/** Pick an aircraft through the rail's Change picker with real clicks (selectPlane applies the default charger). */
async function pickPlane(page, id) {
  const open = await page.eval(`CNSUI.S.picking`);
  if (!open) await page.click('[data-act=pick]');
  await page.waitFor(`!!document.querySelector('.pick [data-act=plane][data-id=${JSON.stringify(id)}]')`, 3000);
  await page.click(`.pick [data-act=plane][data-id="${id}"]`);
  await page.waitFor(`CNSUI.S.planeId === ${JSON.stringify(id)} && !CNSUI.S.picking`, 3000);
  return page.eval(`({ plane: CNSUI.S.planeId, charger: CNSUI.S.chargerId })`);
}
/** Type into an input via real key events; fall back to setValue when the value did not take (number inputs in headless). */
async function typeInto(page, sel, text) {
  await page.focus(sel); await page.type(text);
  const got = await page.eval(`document.querySelector(${JSON.stringify(sel)}).value`);
  if (String(got) !== String(text)) { await page.setValue(sel, text, ['input']); return { typed: got, fallback: true }; }
  return { typed: got, fallback: false };
}
async function bodyJson(page, requestId) {
  let last = null;
  for (let i = 0; i < 5; i++) { try { const b = await page.responseBody(requestId); return JSON.parse(String(b)); } catch (e) { last = e; await page.sleep(120); } }
  throw new Error('responseBody: ' + (last && last.message));
}
/** Add a custom charger through the v2 dialog with real input; returns { status, body, name }. */
async function addCustomViaDialog(page, name, kw) {
  await page.click('[data-act=ccOpen]');
  await page.waitFor(`!document.getElementById('modal').hidden && !!document.getElementById('ccName')`, 3000);
  const t1 = await typeInto(page, '#ccName', name); const t2 = await typeInto(page, '#ccPower', String(kw));
  const since = page.responses.length;
  await page.click('[data-act=ccSave]');
  const hit = await page.waitForResponse('/api/custom/chargers', { since, method: 'POST', timeout: 10000 });
  const body = await bodyJson(page, hit.requestId);
  return { status: hit.status, body, name, typing: { name: t1, kw: t2 } };
}

export default async function run(ctx) {
  const base = ctx.base;
  // cleanup FIRST so it runs even when a later step throws: every charger with this scenario's prefix goes.
  ctx.cleanup(async () => { const done = await sweep(base); if (done.length) ctx.log('cleanup swept', done.join('; ')); });

  const v2 = await ctx.v2Page();
  const classic = await ctx.classicPage(v2.browser);
  const noNewExceptions = (page, n0, label) => { const ex = ctx.exceptions(page).slice(n0); if (ex.length) throw new Error(`${label}: ${ex.length} exception(s): ` + ex.map(e => e.text).join(' || ')); };

  // ------------------------------------------------------------------------------------------
  await ctx.check('trip-seg', async () => {
    const res = []; const ex0 = ctx.exceptions(v2).length;
    for (const k of ['retour', 'circular', 'training', 'one-way']) {
      await v2.click(`[data-seg=trip] button[data-v="${k}"]`);
      await v2.waitFor(`CNSUI.S.trip === ${JSON.stringify(k)}`, 3000);
      const st = await v2.eval(`({ trip: CNSUI.S.trip, on: (document.querySelector('[data-seg=trip] button.on') || {}).dataset && document.querySelector('[data-seg=trip] button.on').dataset.v, dest: !!document.querySelector('[data-ac=dest]'), err: CNSUI.S.err })`);
      st.hint = await tripHint(v2); st.circles = await circles(v2);
      // classic control: the same segment click drives #tripType
      const c = await classic.eval(`(function(){ const b = document.querySelector('.trip-seg-btn[data-trip=${JSON.stringify(k)}]'); try { b.click(); } catch (e) {} return { trip: document.getElementById('tripType').value, active: (document.querySelector('.trip-seg-btn.active') || {}).dataset && document.querySelector('.trip-seg-btn.active').dataset.trip }; })()`);
      st.classic = c; res.push({ k, ...st });
      if (st.on !== k) throw new Error(`${k}: .on button is ${st.on}`);
      if (!HINT_RE[k].test(st.hint)) throw new Error(`${k}: hint "${st.hint}" does not match ${HINT_RE[k]}`);
      if (k === 'training' && st.circles < 1) throw new Error('training: no L.Circle on the map');
      if (k === 'training' && st.dest) throw new Error('training: destination field still rendered');
      if (k !== 'training' && st.circles !== 0) throw new Error(`${k}: ${st.circles} L.Circle layer(s) left on the map`);
      if (c.trip !== k) throw new Error(`classic #tripType is ${c.trip} after clicking ${k}`);
    }
    await ctx.screenshot(v2, 'trip-seg');
    noNewExceptions(v2, ex0, 'trip-seg');
    return { detail: res.map(r => `${r.k}: S.trip=${r.trip} hint="${r.hint.slice(0, 40)}" circles=${r.circles} dest=${r.dest} classic=${r.classic.trip}`).join(' | '), repro: 'v2: real click on each [data-seg=trip] button; classic: .trip-seg-btn click', evidence: [ctx.shot('trip-seg')] };
  });

  // ------------------------------------------------------------------------------------------
  await ctx.check('training-velis-ehte', async () => {
    const ex0 = ctx.exceptions(v2).length;
    const pk = await pickPlane(v2, 'pipistrel_velis');
    if (pk.charger !== 'dc_22') throw new Error(`Velis default charger not applied: S.chargerId=${pk.charger} (catalog default_charger_id dc_22)`);
    await v2.eval(`(function(){ window.setOrigin(CNSUI.byId()['EHTE']); return CNSUI.S.origin.ident; })()`);
    await v2.click('[data-seg=trip] button[data-v="training"]');
    await v2.waitFor(`CNSUI.S.trip === 'training' && CNSUI.S.origin && CNSUI.S.origin.ident === 'EHTE'`, 3000);
    const r = await ctx.v2Simulate(v2);
    if (r.err) throw new Error('v2 simulate error: ' + r.err);
    const pr = await v2.eval(`({ training: CNSUI.S.profile.training, tripType: CNSUI.S.profile.tripType, totals: CNSUI.S.profile.totals, charges: (CNSUI.S.profile.charges || []).map(c => ({ ident: c.ident, energyKwh: c.energyKwh, powerKw: c.powerKw, chargeMin: c.chargeMin })), circles: (function(){ let n = 0; CNSUI.map.map.eachLayer(l => { if (l instanceof L.Circle) n++; }); return n; })() })`);
    if (pr.training !== true) throw new Error('S.profile.training is ' + JSON.stringify(pr.training));
    if (r.api.trip_type !== 'training' || +r.api.training_range_km !== 87.5) throw new Error(`API trip_type=${r.api.trip_type} training_range_km=${r.api.training_range_km}`);
    // classic parity on the same profile + the same headline
    const cs = await ctx.classicSetRoute(classic, { o: 'EHTE', plane: 'pipistrel_velis', charger: 'dc_22', trip: 'training' });
    const c = await ctx.classicSimulate(classic);
    if (c.error) throw new Error('classic simulate error: ' + c.error);
    const cpr = await classic.eval(`(function(){ const p = _engineProfile(lastResult); return { training: p.training, totals: p.totals }; })()`);
    const a = ctx.stripApi(r.api), b = ctx.stripApi(c.api);
    const diff = Object.keys(Object.assign({}, a, b)).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (diff.length) throw new Error('API differs from the classic on: ' + diff.map(k => `${k}: v2=${JSON.stringify(a[k])} classic=${JSON.stringify(b[k])}`).join('; '));
    for (const k of ['energyUsedKwh', 'chargeMin', 'flightMin', 'distKm']) if (!ctx.close(+pr.totals[k], +cpr.totals[k], 1e-6)) throw new Error(`engine totals.${k}: v2 ${pr.totals[k]} vs classic ${cpr.totals[k]}`);
    const v2Energy = ctx.num(r.shown.stats[0]), clEnergy = ctx.num(c.shown.hlUsed);
    if (v2Energy !== clEnergy) throw new Error(`displayed energy: v2 ${r.shown.stats[0]} vs classic hlUsed ${c.shown.hlUsed}`);
    await ctx.screenshot(v2, 'training-velis'); await ctx.screenshot(classic, 'training-velis.classic');
    noNewExceptions(v2, ex0, 'training-velis-ehte');
    return { detail: `S.profile.training=true, API training_range_km=${r.api.training_range_km}, recharge ${r.api.recharge_energy_kwh} kWh, charge_time_min ${r.api.charge_time_min}; engine totals ${JSON.stringify(pr.totals)} == classic; shown energy ${v2Energy} == hlUsed ${clEnergy}; charges ${JSON.stringify(pr.charges)}; circles ${pr.circles}; classic warnings ${JSON.stringify(cs.warnings)}`,
      repro: 'v2: Change → Velis, setOrigin EHTE, click Training, Simulate; classic: same via classicSetRoute + .sim-btn', evidence: [ctx.shot('training-velis'), ctx.shot('training-velis.classic')] };
  });

  // ------------------------------------------------------------------------------------------
  await ctx.check('training-without-range', async () => {
    const ex0 = ctx.exceptions(v2).length; const errs0 = v2.errors.length;
    await v2.click('[data-act=edit]').catch(() => {});             // back to the form when the result rail is shown
    await v2.waitFor(`CNSUI.S.rail === 'form'`, 3000);
    const pk = await pickPlane(v2, 'beta_alia');
    if (pk.charger !== 'dc_320') throw new Error('Alia default charger not applied: ' + pk.charger);
    const st = await v2.eval(`({ trip: CNSUI.S.trip, o: CNSUI.S.origin && CNSUI.S.origin.ident, tr: CNSUI.plane().training_range_km })`);
    if (st.trip !== 'training') { await v2.click('[data-seg=trip] button[data-v="training"]'); await v2.waitFor(`CNSUI.S.trip === 'training'`, 3000); }
    const r = await ctx.v2Simulate(v2);
    const dom = await v2.eval(`({ err: (document.querySelector('#railBody .sec.err') || {}).textContent || null, rail: CNSUI.S.rail, result: !!CNSUI.S.result, busy: CNSUI.S.busy })`);
    await ctx.screenshot(v2, 'training-no-range');
    if (!r.err) throw new Error('simulate did not fail although beta_alia has no training_range_km (' + JSON.stringify(st) + ')');
    if (!dom.err || !/training_range_km|training mode unavailable/i.test(dom.err)) throw new Error(`.sec.err is ${JSON.stringify(dom.err)} (S.err=${r.err})`);
    noNewExceptions(v2, ex0, 'training-without-range');
    // classic control: same aircraft, same trip → the same API error in #error
    const cs = await ctx.classicSetRoute(classic, { o: 'EHTE', plane: 'beta_alia', trip: 'training' });
    const c = await ctx.classicSimulate(classic);
    if (!c.error || !/training_range_km|training mode unavailable/i.test(c.error)) throw new Error('classic did not show the API error: ' + JSON.stringify(c.error));
    return { detail: `v2 .sec.err="${dom.err}" S.rail=${dom.rail} result=${dom.result}; classic #error="${c.error}"; new console errors ${v2.errors.length - errs0}`, repro: 'v2: Change → Alia CX300, Training, Simulate; classic: classicSetRoute({plane:beta_alia, trip:training}) + .sim-btn', evidence: [ctx.shot('training-no-range')] };
  });

  // ------------------------------------------------------------------------------------------
  await ctx.check('frequency', async () => {
    const ex0 = ctx.exceptions(v2).length;
    await resetForm(v2);
    // real keys: focus + select-all so the seeded "1" is replaced, then type 3 (input event → S.freq)
    await v2.eval(`(function(){ const i = document.querySelector('[data-act=freq]'); i.focus(); i.select(); return document.activeElement === i; })()`);
    await v2.type('3');
    let typed = await v2.eval(`({ v: document.querySelector('[data-act=freq]').value, freq: CNSUI.S.freq })`);
    if (typed.v !== '3' || typed.freq !== 3) { await v2.setValue('[data-act=freq]', '3', ['input', 'change']); typed.fallback = true; typed.after = await v2.eval(`CNSUI.S.freq`); }
    await v2.click('[data-seg=per] button[data-v="week"]');
    await v2.waitFor(`CNSUI.S.freq === 3 && CNSUI.S.per === 'week'`, 3000);
    const r = await ctx.v2Simulate(v2);
    if (r.err) throw new Error('v2 simulate error: ' + r.err);
    const st = await v2.eval(`(function(){ const d = CNSUI.plan.derive(); const rate = CNSSettings.chargeRate(); return { charged: d.charged, used: d.used, chargedR: CNSUI.fmt.r(d.charged), rate, fpd: CNSUI.perDay({ freq: CNSUI.S.freq, per: CNSUI.S.per }), freqN: CNSUI.S.result._freqN, freqUnit: CNSUI.S.result._freqUnit, cost: (document.querySelector('#railBody .cost .v') || {}).textContent, sub: (document.querySelector('#railBody .cost .m') || {}).textContent, head: (document.querySelector('#railBody .rh2 .m') || {}).textContent }; })()`);
    const expected = st.chargedR * 3 / 7 * st.rate; const shown = ctx.num(st.cost);
    if (!ctx.close(shown, expected, 0.01)) throw new Error(`cost .v ${st.cost} → ${shown}, expected ceil(${st.charged})=${st.chargedR} × 3/7 × ${st.rate} = ${expected.toFixed(4)}`);
    if (st.freqN !== 3 || st.freqUnit !== 'week') throw new Error(`result annotations _freqN=${st.freqN} _freqUnit=${st.freqUnit}`);
    if (!/\/ day/.test(st.cost)) throw new Error('cost unit is not "/ day": ' + st.cost);
    // classic: 3 / week → weekly headline = rate × kWh × 3; per day = / 7
    const cs = await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freqN: 3, freqUnit: 'week' });
    const c = await ctx.classicSimulate(classic);
    if (c.error) throw new Error('classic simulate error: ' + c.error);
    const weekly = ctx.num(c.shown.hlRevenue); const perDay = weekly / 7;
    if (!/week/.test(c.shown.hlRevenue)) throw new Error('classic headline is not per week: ' + c.shown.hlRevenue);
    if (!ctx.close(perDay, shown, 0.01)) throw new Error(`classic ${c.shown.hlRevenue} (${c.shown.hlRevenueSub}) / 7 = ${perDay.toFixed(4)} vs v2 ${shown}`);
    await ctx.screenshot(v2, 'frequency');
    noNewExceptions(v2, ex0, 'frequency');
    return { detail: `v2 cost "${st.cost}" sub "${st.sub}" head "${st.head}" = ceil(charged ${st.charged.toFixed(3)}; used ${st.used.toFixed(3)})=${st.chargedR} × 3/7 × €${st.rate} = ${expected.toFixed(4)}; typed ${JSON.stringify(typed)}; classic ${c.shown.hlRevenue} · ${c.shown.hlRevenueSub} → /7 = ${perDay.toFixed(4)}; classic warnings ${JSON.stringify(cs.warnings)}`, repro: 'v2: Reset, type 3 in [data-act=freq], click week, Simulate; classic: freqN 3 / week', evidence: [ctx.shot('frequency')] };
  });

  // ------------------------------------------------------------------------------------------
  await ctx.check('charger-list', async () => {
    const ex0 = ctx.exceptions(v2).length;
    await resetForm(v2);
    const short = await chgList(v2);
    if (short.length !== 3) throw new Error(`shortlist has ${short.length} chargers: ` + JSON.stringify(short));
    const on = short.find(x => x.on); if (!on || on.id !== 'dc_320') throw new Error('.chg.on is ' + JSON.stringify(on));
    await v2.click('[data-act=allChargers]'); await v2.waitFor(`CNSUI.S.allChargers === true`, 3000);
    const all = await chgList(v2); const total = await v2.eval(`CNSUI.CHARGERS.length`);
    const classicCount = await classic.eval(`[...document.querySelectorAll('#charger option')].filter(o => o.value !== '__custom_charger__').length`);
    const btn = await v2.eval(`document.querySelector('[data-act=allChargers]').textContent.trim()`);
    if (all.length !== total) throw new Error(`All chargers shows ${all.length}, CNSUI.CHARGERS has ${total}`);
    if (all.length !== classicCount) throw new Error(`v2 full list ${all.length} vs classic #charger options ${classicCount}`);
    const kws = await v2.eval(`[...document.querySelectorAll('#railBody .chg')].map(b => CNSUI.CHARGERS.find(c => c.id === b.dataset.id).power_kw)`);
    for (let i = 1; i < kws.length; i++) if (kws[i] > kws[i - 1]) throw new Error('full list not sorted by power desc: ' + kws.join(','));
    // dc_1000 on the Alia (max_charge_kw 400) → the acceptance-cap hint; control = the engine's effective power
    await v2.click('.chg[data-id="dc_1000"]'); await v2.waitFor(`CNSUI.S.chargerId === 'dc_1000'`, 3000);
    const hint = await v2.eval(`(function(){ const h = [...document.querySelectorAll('#railBody .hint.num')].map(e => e.textContent.trim()); return { hints: h, on: (document.querySelector('#railBody .chg.on') || {}).dataset && document.querySelector('#railBody .chg.on').dataset.id, max: CNSUI.plane().max_charge_kw, eff: CNSSettings.effectiveChargePower ? CNSSettings.effectiveChargePower(1000, CNSUI.plane().battery_kwh, CNSUI.plane().c_rate, CNSUI.plane().max_charge_kw) : null }; })()`);
    if (hint.on !== 'dc_1000') throw new Error('.chg.on after clicking dc_1000 is ' + hint.on);
    if (!hint.hints.some(h => /accepts max 400 kW/i.test(h))) throw new Error('no acceptance-cap hint for dc_1000 on the Alia: ' + JSON.stringify(hint.hints));
    const r = await ctx.v2Simulate(v2); if (r.err) throw new Error('simulate with dc_1000: ' + r.err);
    const pw = await v2.eval(`(CNSUI.S.profile.charges || []).map(c => c.powerKw)`);
    if (!pw.length || pw.some(p => p > 400 + 1e-9)) throw new Error('engine charge power not capped at 400 kW: ' + JSON.stringify(pw));
    await ctx.screenshot(v2, 'charger-list');
    // restore: Edit → dc_320 → Fewer
    await v2.click('[data-act=edit]'); await v2.waitFor(`CNSUI.S.rail === 'form'`, 3000);
    await v2.click('.chg[data-id="dc_320"]'); await v2.waitFor(`CNSUI.S.chargerId === 'dc_320'`, 3000);
    await v2.click('[data-act=allChargers]'); await v2.waitFor(`CNSUI.S.allChargers === false`, 3000);
    const back = await chgList(v2); if (back.length !== 3 || (back.find(x => x.on) || {}).id !== 'dc_320') throw new Error('Fewer did not restore the 3-item shortlist: ' + JSON.stringify(back));
    noNewExceptions(v2, ex0, 'charger-list');
    return { detail: `shortlist ${short.map(x => x.id + (x.on ? '*' : '')).join(',')}; All → ${all.length} (CNSUI.CHARGERS ${total}, classic options ${classicCount}), button "${btn}"; dc_1000 → hint ${JSON.stringify(hint.hints)}, effectiveChargePower(1000)=${hint.eff}, profile powerKw ${JSON.stringify(pw)}; Fewer → ${back.map(x => x.id + (x.on ? '*' : '')).join(',')}`, repro: 'v2: Reset; count .chg; click All chargers; click .chg[data-id=dc_1000]; Simulate', evidence: [ctx.shot('charger-list')] };
  });

  // ------------------------------------------------------------------------------------------
  await ctx.check('custom-charger-roundtrip', async () => {
    const ex0 = ctx.exceptions(v2).length; const log = [];
    const pre = await listCustoms(base); const swept = await sweep(base); const after = swept.length ? await listCustoms(base) : pre;
    log.push(`server before: ${pre.length} (${pre.map(c => c.name).join(', ') || 'none'})${swept.length ? '; swept stale ' + swept.join('; ') : ''}`);
    if (after.length >= CAP) { ctx.blockedBy.push(`custom charger cap: ${after.length}/${CAP} foreign chargers on the server (${after.map(c => c.name).join(', ')})`); throw new Error('cap reached by chargers this scenario does not own — not creating'); }
    await resetForm(v2);
    const name = TAG + '-rt';
    const sinceAdd = v2.responses.length;
    const add = await addCustomViaDialog(v2, name, 123);
    log.push(`POST /api/custom/chargers → ${add.status} ${JSON.stringify(add.body)} (typing ${JSON.stringify(add.typing)})`);
    if (add.status !== 201) throw new Error(`POST returned ${add.status}: ${JSON.stringify(add.body)}`);
    const id = add.body.id;
    await v2.waitFor(`CNSUI.S.chargerId === ${JSON.stringify(id)} && document.getElementById('modal').hidden`, 5000);
    const st1 = await v2.eval(`({ chargerId: CNSUI.S.chargerId, inCatalog: !!CNSUI.CHARGERS.find(c => c.id === ${JSON.stringify(id)}), byId: !!window.CHARGERS_BY_ID[${JSON.stringify(id)}], eng: !!(CNSChargers.get(${JSON.stringify(id)})), on: (document.querySelector('#railBody .chg.on') || {}).dataset && document.querySelector('#railBody .chg.on').dataset.id, kw: (document.querySelector('#railBody .chg.on .kw') || {}).textContent, toast: document.getElementById('toast').textContent })`);
    log.push('after add: ' + JSON.stringify(st1));
    // evidence for custom-charger-thumb: the row's <img src> and any /pics/ 404 raised since the add (the classic draws a glyph when a charger has no image)
    await v2.sleep(300);
    const thumb = await v2.eval(`(function(){ const img = document.querySelector('#railBody .chg.on img'); return { src: img ? img.getAttribute('src') : null, complete: img ? img.complete : null, naturalWidth: img ? img.naturalWidth : null }; })()`);
    const pics404 = v2.responses.slice(sinceAdd).filter(r => /\/pics\/?$/.test(r.url) && r.status === 404).map(r => `${r.method} ${r.url} → ${r.status}`);
    ctx.state.thumb = { id, name, thumb, pics404 };
    log.push('thumb: ' + JSON.stringify(ctx.state.thumb));
    if (st1.on !== id || !st1.inCatalog || !st1.byId || !st1.eng) throw new Error('new charger not selected/indexed: ' + JSON.stringify(st1));
    const r = await ctx.v2Simulate(v2); if (r.err) throw new Error('simulate with the custom charger: ' + r.err);
    const sim = { id: r.api.charger && r.api.charger.id, kw: r.api.charger && r.api.charger.power_kw, profileKw: await v2.eval(`(CNSUI.S.profile.charges || []).map(c => c.powerKw)`), head: await v2.eval(`(document.querySelector('#railBody .rh2 .m') || {}).textContent`) };
    log.push('simulate: ' + JSON.stringify(sim));
    if (sim.kw !== 123 || sim.id !== id) throw new Error('result.charger is ' + JSON.stringify(r.api.charger));
    await ctx.screenshot(v2, 'custom-charger-result');
    await v2.click('[data-act=edit]'); await v2.waitFor(`CNSUI.S.rail === 'form'`, 3000);
    await v2.click('[data-act=ccOpen]'); await v2.waitFor(`!document.getElementById('modal').hidden && !!document.getElementById('ccName')`, 3000);
    const dlg = await v2.eval(`({ cap: [...document.querySelectorAll('#modalBox .cap')].map(e => e.textContent.trim()).find(t => /\\/ ${CAP}/.test(t)) || null, rows: [...document.querySelectorAll('#modalBox [data-act=ccRemove]')].map(b => b.dataset.id), names: [...document.querySelectorAll('#modalBox .fl .t')].map(e => e.textContent.trim()) })`);
    const server = await listCustoms(base);
    log.push('dialog: ' + JSON.stringify(dlg) + ' server: ' + server.length);
    await ctx.screenshot(v2, 'custom-charger-dialog');
    const m = dlg.cap && dlg.cap.match(/(\d+)\s*\/\s*5/); if (!m || +m[1] !== server.length) throw new Error(`dialog count "${dlg.cap}" vs server ${server.length}`);
    if (!dlg.rows.includes(id) || !dlg.names.includes(name)) throw new Error('dialog does not list the new charger: ' + JSON.stringify(dlg));
    const since = v2.responses.length;
    await v2.click(`[data-act=ccRemove][data-id="${id}"]`);
    const del = await v2.waitForResponse('/api/custom/chargers/', { since, method: 'DELETE', timeout: 10000 });
    log.push(`DELETE → ${del.status} ${del.url}`);
    if (del.status !== 200) throw new Error('DELETE returned ' + del.status);
    await v2.waitFor(`!CNSUI.CHARGERS.find(c => c.id === ${JSON.stringify(id)}) && CNSUI.S.chargerId !== ${JSON.stringify(id)}`, 5000);
    const st2 = await v2.eval(`({ chargerId: CNSUI.S.chargerId, cap: [...document.querySelectorAll('#modalBox .cap')].map(e => e.textContent.trim()).find(t => /\\/ ${CAP}/.test(t)) || null, byId: !!window.CHARGERS_BY_ID[${JSON.stringify(id)}], modal: !document.getElementById('modal').hidden })`);
    const gone = !(await listCustoms(base)).some(c => c.id === id);
    log.push('after remove: ' + JSON.stringify(st2) + ' serverGone=' + gone);
    if (!gone || st2.byId) throw new Error('charger still present after DELETE: ' + JSON.stringify(st2));
    await v2.press('Escape'); await v2.waitFor(`document.getElementById('modal').hidden`, 3000);
    noNewExceptions(v2, ex0, 'custom-charger-roundtrip');
    return { detail: log.join(' | '), repro: 'v2: [data-act=ccOpen], type name + 123, Add charger → POST 201; Simulate; ccOpen lists n / 5; ccRemove → DELETE 200', evidence: [ctx.shot('custom-charger-result'), ctx.shot('custom-charger-dialog')] };
  }, { retry: 0 });

  // ------------------------------------------------------------------------------------------
  await ctx.check('custom-charger-thumb', async () => {
    const t = ctx.state.thumb; if (!t) throw new Error('no evidence collected — run together with custom-charger-roundtrip (it records the row while the charger exists)');
    if (t.thumb.src === '/pics/' || t.pics404.length) throw new Error(`custom charger "${t.name}" row renders <img src="${t.thumb.src}"> (naturalWidth ${t.thumb.naturalWidth}) → ${t.pics404.length} × ${t.pics404[0] || '/pics/ 404'}; the classic renders a ⚡ glyph when a charger has no image (index.html:6511-6512), v2 plan.js:69 builds /pics/\${x.image || ''}`);
    return { detail: `custom charger row img src=${t.thumb.src}, /pics/ 404s since the add: ${t.pics404.length}`, repro: 'v2: add a custom charger (no image) → the shortlist row', evidence: [ctx.shot('custom-charger-result')] };
  }, { retry: 0 });

  // ------------------------------------------------------------------------------------------
  await ctx.check('network-with-custom-charger', async () => {
    const ex0 = ctx.exceptions(v2).length; const log = [];
    const cur = await listCustoms(base); if (cur.length >= CAP) { ctx.blockedBy.push(`custom charger cap: ${cur.length}/${CAP} on the server`); throw new Error('cap reached — not creating'); }
    await v2.eval(`(function(){ CNSDemand.saveFolder([]); CNSUI.folderChanged(); return true; })()`);
    await resetForm(v2);
    const name = TAG + '-net';
    const add = await addCustomViaDialog(v2, name, 123);
    if (add.status !== 201) throw new Error(`POST returned ${add.status}: ${JSON.stringify(add.body)}`);
    const id = add.body.id; log.push(`created ${id}`);
    await v2.waitFor(`CNSUI.S.chargerId === ${JSON.stringify(id)} && document.getElementById('modal').hidden`, 5000);
    const r = await ctx.v2Simulate(v2); if (r.err) throw new Error('simulate: ' + r.err);
    await v2.click('[data-act=add]');
    await v2.waitFor(`CNSDemand.loadFolder().length === 1`, 5000);
    const entry = await v2.eval(`(function(){ const t = CNSDemand.loadFolder()[0]; return { id: t.id, plane: t.planeId, charger: t.chargerId, chargerPower: t.chargerPower, o: t.originIdent, d: t.destIdent, count: document.getElementById('netCount').textContent }; })()`);
    log.push('folder entry ' + JSON.stringify(entry));
    if (entry.charger !== id) throw new Error('folder entry chargerId is ' + entry.charger);
    // Network → open EHLE → Edit → change aircraft → Save
    await v2.click('#modeSeg button[data-mode="network"]'); await v2.waitFor(`CNSUI.S.mode === 'network' && !!document.querySelector('.ap[data-ap="EHLE"]')`, 5000);
    const isOpen = await v2.eval(`document.querySelector('.ap[data-ap="EHLE"]').classList.contains('open')`);
    if (!isOpen) { await v2.click('.ap[data-ap="EHLE"] > button'); await v2.waitFor(`document.querySelector('.ap[data-ap="EHLE"]').classList.contains('open')`, 3000); }
    // the flight is listed under BOTH endpoints (departure + destination); scope to the opened EHLE pane
    await v2.click(`.ap[data-ap="EHLE"] [data-act=editTrip][data-id="${entry.id}"]`);
    await v2.waitFor(`!document.getElementById('modal').hidden && !!document.getElementById('efPlane')`, 3000);
    const newPlane = 'vaeridion_microliner';
    await v2.setValue('#efPlane', newPlane, ['change']);
    const since = v2.responses.length;
    await v2.click('[data-act=efSave]');
    const hit = await v2.waitForResponse('/api/simulate', { since, method: 'POST', timeout: 15000 });
    const body = await bodyJson(v2, hit.requestId);
    const sent = await (async () => { try { const b = hit.requestId && await v2.send('Network.getRequestPostData', { requestId: hit.requestId }); return b && b.postData ? JSON.parse(b.postData) : null; } catch (e) { return null; } })();
    await v2.waitFor(`document.getElementById('modal').hidden || !document.getElementById('efError').hidden`, 8000);
    const out = await v2.eval(`({ modal: !document.getElementById('modal').hidden, err: (document.getElementById('efError') || {}).textContent || null, plane: (CNSDemand.loadFolder()[0] || {}).planeId, charger: (CNSDemand.loadFolder()[0] || {}).chargerId, toast: document.getElementById('toast').textContent })`);
    log.push(`edit save: POST /api/simulate ${hit.status} body=${JSON.stringify(body).slice(0, 160)} sent.charger=${sent ? JSON.stringify(sent.charger) : 'n/a'} sent.charger_id=${sent && sent.charger_id} → ${JSON.stringify(out)}`);
    await ctx.screenshot(v2, 'network-edit');
    // control A — the API itself: same payload without / with the charger object
    const o = { ident: 'EHLE', name: 'Lelystad', lat: r.api._origin.lat, lon: r.api._origin.lon }, d = { ident: 'EDDF', name: 'Frankfurt', lat: r.api._dest.lat, lon: r.api._dest.lon };
    const post = async p => { const x = await fetch(base + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); return { status: x.status, body: await x.json() }; };
    const without = await post({ origin: o, destination: d, plane_id: newPlane, charger_id: id, trip_type: 'one-way' });
    const withObj = await post({ origin: o, destination: d, plane_id: newPlane, charger_id: id, trip_type: 'one-way', charger: { id, name, power_kw: 123 } });
    log.push(`control A: without charger object → ${without.status} ${JSON.stringify(without.body.error || 'ok')}; with → ${withObj.status} ${withObj.body.error ? JSON.stringify(withObj.body.error) : 'ok charger.power_kw=' + (withObj.body.charger && withObj.body.charger.power_kw)}`);
    // control B — the classic edits the same folder entry (it sends chargerById[prev.chargerId]); reload so it knows the custom charger
    let ctl = null;
    try {
      await classic.reload({ boot: 'classic' });
      await classic.eval(`(function(){ openFlightEdit(${JSON.stringify(entry.id)}, 'EHLE'); return true; })()`);
      await classic.waitFor(`document.querySelector('#editFlightModal.show') && !!document.getElementById('efPlane')`, 5000);
      await classic.sleep(450);   // Bootstrap's fade: hide() is a no-op while the 300 ms show transition runs
      const alt = await classic.eval(`(function(){ const cur = document.getElementById('efPlane').value; const pref = ['heart_es30_25_pax', 'vaeridion_microliner']; const vals = [...document.querySelectorAll('#efPlane option')].map(o => o.value); return pref.find(v => vals.includes(v) && v !== cur) || vals.find(v => v && v !== cur) || null; })()`);
      if (!alt) throw new Error('classic #efPlane has no alternative aircraft');
      await classic.setValue('#efPlane', alt, ['change']);
      const s2 = classic.responses.length; await classic.eval(`document.getElementById('efSave').click(); true`);
      const h2 = await classic.waitForResponse('/api/simulate', { since: s2, method: 'POST', timeout: 15000 });
      // success = the folder entry carries the new aircraft (the modal's .show may linger while Bootstrap transitions)
      await classic.waitFor(`(CNSDemand.loadFolder()[0] || {}).planeId === ${JSON.stringify(alt)} || !document.getElementById('efError').classList.contains('d-none')`, 8000);
      ctl = await classic.eval(`({ status: ${h2.status}, wanted: ${JSON.stringify(alt)}, modalShown: !!document.querySelector('#editFlightModal.show'), err: document.getElementById('efError').classList.contains('d-none') ? null : document.getElementById('efError').textContent, plane: (CNSDemand.loadFolder()[0] || {}).planeId, charger: (CNSDemand.loadFolder()[0] || {}).chargerId, hasCustom: !!chargerById[${JSON.stringify(id)}] })`);
      ctl.ok = !ctl.err && ctl.plane === alt;
      await ctx.screenshot(classic, 'network-edit.classic');
    } catch (e) { ctl = { failed: e.message }; }
    log.push('control B (classic edit): ' + JSON.stringify(ctl));
    ctx.log('network-with-custom-charger trace:\n  ' + log.join('\n  '));
    // lib.mjs truncates a failing detail to 600 chars — keep the message compact and complete
    if (out.modal || out.err || out.plane !== newPlane) throw new Error(`v2 edit-save failed: efError=${JSON.stringify(out.err)}, folder plane=${out.plane}; v2 sent charger_id=${sent && sent.charger_id} charger=${sent ? JSON.stringify(sent.charger) : 'n/a'} → /api/simulate ${hit.status} ${JSON.stringify(body.error || 'ok')}; control A (Node POST) without charger object → ${JSON.stringify(without.body.error || 'ok')}, with charger object → ${withObj.body.error ? JSON.stringify(withObj.body.error) : 'ok (charger.power_kw ' + (withObj.body.charger && withObj.body.charger.power_kw) + ')'}; control B (classic openFlightEdit → efSave) → ${ctl && ctl.ok ? 'OK plane=' + ctl.plane + ' charger kept=' + (ctl.charger === id) : JSON.stringify(ctl)}`);
    if (out.charger !== id) throw new Error('edited flight lost its custom charger: ' + out.charger);
    noNewExceptions(v2, ex0, 'network-with-custom-charger');
    return { detail: log.join(' | '), repro: 'v2: custom charger → Simulate → Add to network → Network → EHLE → Edit → Aircraft: Microliner → Save', evidence: [ctx.shot('network-edit'), ctx.shot('network-edit.classic')] };
  }, { retry: 0 });

  // ------------------------------------------------------------------------------------------
  await ctx.check('no-exceptions', async () => {
    const ex = [...ctx.exceptions(v2), ...ctx.exceptions(classic)];
    if (ex.length) throw new Error(ex.map(e => `${e.text} @ ${e.url}`).join(' || '));
    const left = await listCustoms(base);
    return `v2 errors ${v2.errors.length}, classic errors ${classic.errors.length}, exceptions 0 (known classic filtered); server customs now ${left.length} (${left.map(c => c.name).join(', ') || 'none'})`;
  }, { retry: 0 });
}
