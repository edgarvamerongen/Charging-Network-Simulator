/* Planner: suggested stops, blacklist / re-suggest, Prefer bias, no-route remedies, circular rings, over-range
   marking, rail-vs-result distances, alternates (divert markers, ALT pick, drag) and multi-leg parity with the
   classic shell (templates/index.html, the behavioural spec). Every mutation goes through the v2 rail's own
   controls (REAL clicks / change events); the classic tab is driven with ctx.classicSetRoute + classicSimulate.
   Expected-FAIL suspects from the static audit (plan A1/A3/A4/A8/A10/A15) are asserted as the CLASSIC behaves. */
export const component = 'planner';
export const module = 'plan';
import fs from 'node:fs';
import path from 'node:path';

const STOP = '#railBody .route .stop';   // NOT a bare `.stop` — the map's route endpoint pins are `.ep.stop`
const J = v => JSON.stringify(v);
const ids = a => (a || []).map(s => (s && s.ident) || s);
const pairs = chain => { const out = []; for (let i = 0; i < chain.length - 1; i++) out.push(chain[i] + '→' + chain[i + 1]); return out; };

/** One snapshot of everything the planner shows + holds (rail DOM and S.*). */
const SNAP = `(function(){ const S = CNSUI.S, PL = CNSUI.planner, $$ = s => Array.from(document.querySelectorAll(s)); const c = CNSUI.chain();
  const P = q => { const [lat, lon] = CNSUI.ll(q); return { lat: +lat, lon: +lon }; };
  const legs = []; for (let i = 0; i < c.length - 1; i++) legs.push(+CNSRouting.haversineKm(P(c[i]), P(c[i + 1])).toFixed(3));
  const t = s => { const e = document.querySelector(s); return e ? e.textContent.trim().replace(/\\s+/g, ' ') : null; };
  return { chain: c.map(a => a.ident), types: c.map(a => a.type), legsKm: legs, avail: PL.availableRangeKm(), shown: PL.availRangeShownKm(),
    stops: S.planned.stops.map(s => s.ident), closing: S.planned.closing.map(s => s.ident), error: S.planned.error, legIssues: S.planned.legIssues.slice(), source: S.planned.source,
    title: t('#railBody .route .rh b'), rh: t('#railBody .route .rh'),
    rows: $$('${STOP}').map(r => ({ txt: r.textContent.trim().replace(/\\s+/g, ' '), d: (r.querySelector('.d') || { textContent: '' }).textContent.trim(), bad: r.classList.contains('bad'), rm: !!r.querySelector('[data-act=rmPlanned]'), alt: (r.querySelector('.alt') || { textContent: '' }).textContent.trim() })),
    rm: $$('#railBody [data-act=rmPlanned]').map(b => b.dataset.ident), resuggest: $$('#railBody [data-act=resuggest]').length, blacklist: Array.from(S.blacklist), bias: S.bias, biasSel: (document.querySelector('#railBody [data-act=bias]') || {}).value || null,
    err: t('#railBody .route .err'), remedyBtns: $$('#railBody .route .err [data-act]').map(b => b.dataset.act), trip: S.trip, plane: S.planeId, charger: S.chargerId, override: S.availOverride, diverts: Object.assign({}, S.divertOverrides), showAlt: S.showAlternates, allowed: S.allowedTypes.slice(), rail: S.rail, o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, manual: S.stops.map(s => s && s.ident) }; })()`;

/** Engine oracle for the Prefer bias: CNSRouting.planChain with the classic's typePenalty table (index.html:2893). */
const ORACLE = bias => `(function(){ const ORD = { 'medium-large-small': { medium_airport: 0, large_airport: 50, small_airport: 150 }, 'large-medium-small': { large_airport: 0, medium_airport: 50, small_airport: 150 }, 'small-medium-large': { small_airport: 0, medium_airport: 50, large_airport: 150 }, none: { medium_airport: 0, large_airport: 0, small_airport: 0 } };
  const PL = CNSUI.planner, S = CNSUI.S, t = PL.terminus(); if (!t) return null;
  const r = CNSRouting.planChain({ origin: t.origin, dest: t.dest, manualStops: S.stops.filter(Boolean).map(a => PL.wp(a)), plane: CNSUI.plane(), allowedTypes: S.allowedTypes.slice(), allAirports: CNSUI.airports(), allowedIdents: PL.plannerAllowedIdents(), blacklist: S.blacklist, maxLegKm: PL.availableRangeKm(), options: { typePenalty: ORD[${J(bias)}] } });
  return { stops: (r.stops || []).map(s => s.ident), error: r.error || null }; })()`;

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  const snap = () => v2.eval(SNAP);
  /** Set the form state the way the popup buttons / rail inputs do (S.* + plan.onFormChange(true)). */
  const setRoute = f => v2.eval(`(function(){ const S = CNSUI.S, by = CNSUI.byId(); const F = ${J(f)}; const need = i => { if (!by[i]) throw new Error('unknown airport ' + i); return by[i]; };
    if (F.o) S.origin = need(F.o); if (F.d) S.dest = need(F.d); if (F.stops) S.stops = F.stops.map(need); if (F.plane) { S.planeId = F.plane; S.availOverride = null; } if (F.charger) S.chargerId = F.charger; if (F.trip) S.trip = F.trip;
    if (F.bias) S.bias = F.bias; if (F.clearBlacklist) S.blacklist.clear(); if (F.clearDiverts) S.divertOverrides = {}; if (F.override !== undefined) S.availOverride = F.override;
    S.rail = 'form'; CNSUI.plan.onFormChange(true); return true; })()`);
  const exceptionsSince = (page, t0) => page.errors.filter(e => e.type === 'exception' && e.t >= t0 && !ctx.isKnownClassic(e)).map(e => e.text.split('\n')[0].slice(0, 200));
  const attributed = [];   // exception texts already reported by a failing check (so the final gate reports only the rest)
  /** Full evidence for a failing check (the harness truncates a failure's detail to 600 chars): $CNS_UI_OUT/planner/<check>.json */
  const dump = (name, obj) => { const f = path.join(ctx.out, name + '.json'); fs.writeFileSync(f, JSON.stringify(obj, null, 1)); return f; };
  let classic = null;
  /** The classic tab, opened on first use (so every `--only <check>` repro still gets its control). */
  const getClassic = async () => { if (!classic) { classic = await ctx.classicPage(v2.browser); ctx.state.classic = classic; } return classic; };
  /** The baseline auto-stop route (Alia, EHLE→EDDM, default bias, no blacklist / diverts). */
  const baseline = () => setRoute({ o: 'EHLE', d: 'EDDM', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', stops: [], clearBlacklist: true, clearDiverts: true, bias: 'medium-large-small', override: null });
  /** The circular ring used by the circular-* checks: EHLE → EHRD (manual) → … → EDDM (far point) → … → EHLE, set through the trip segment's own button. */
  const setupRing = async () => { await setRoute({ o: 'EHLE', d: 'EDDM', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', stops: ['EHRD'], clearBlacklist: true, clearDiverts: true, bias: 'medium-large-small', override: null }); await v2.click('#railBody [data-seg=trip] button[data-v=circular]'); const s = await snap(); ctx.state.ring = s.chain; return s; };
  /** Alternates overlay ON through the Map menu's own checkbox (a real click), menu closed afterwards. */
  const ensureAlternates = async () => { if (await v2.eval(`CNSUI.S.showAlternates`)) return; await v2.click('#mapBtn'); await v2.click('#fAlternates'); await v2.eval(`document.querySelector('#mapDd').classList.remove('open'); true`); await v2.sleep(250); };

  // ---- 1. auto stop --------------------------------------------------------------------------
  await ctx.check('auto-stop', async () => {
    const before = await snap();
    await v2.eval(`window.setDest(airportByIdent['EDDM'])`);   // the map popup's Destination button path (app.js:101)
    const s = await snap();
    await ctx.screenshot(v2, 'auto-stop');
    const over = s.legsKm.map((d, i) => d > s.avail + 1e-6 ? i : -1).filter(i => i >= 0);
    const problems = [];
    if (s.title !== 'Suggested route') problems.push(`title "${s.title}" (want "Suggested route")`);
    if (!s.rm.length) problems.push('no [data-act=rmPlanned] stop');
    if (over.length) problems.push(`legs ${J(over)} exceed availableRangeKm ${s.avail.toFixed(1)}`);
    if (s.legIssues.length || s.error) problems.push(`planned.legIssues ${J(s.legIssues)} error ${J(s.error)}`);
    if (s.rows.length !== s.chain.length) problems.push(`${s.rows.length} rail rows for a ${s.chain.length}-node chain`);
    if (s.chain[0] !== 'EHLE' || s.chain[s.chain.length - 1] !== 'EDDM') problems.push('chain endpoints ' + J(s.chain));
    if (problems.length) throw new Error(problems.join('; ') + ' — ' + J({ chain: s.chain, legsKm: s.legsKm, rows: s.rows.map(r => r.txt) }));
    ctx.state.autoChain = s.chain; ctx.state.autoStops = s.stops;
    return { detail: `${before.chain.join('→')} → ${s.chain.join('→')} (${s.types.map(x => x[0]).join('')}); legs ${J(s.legsKm)} ≤ reach ${s.avail.toFixed(1)} km; rm=${J(s.rm)}; rows ${J(s.rows.map(r => r.d))}`, repro: 'node tests/ui/run.mjs planner --only auto-stop', evidence: [ctx.shot('auto-stop')] };
  }, { retry: 0 });

  // ---- 2. remove → blacklist → a different stop; Re-suggest clears ---------------------------
  await ctx.check('blacklist-and-resuggest', async () => {
    await baseline();
    const s0 = await snap(); if (!s0.rm.length) throw new Error('precondition: no auto stop to remove (' + J(s0.chain) + ')');
    const removed = s0.rm[0];
    await v2.click('#railBody [data-act=rmPlanned]');
    const s1 = await snap();
    await ctx.screenshot(v2, 'blacklist');
    const problems = [];
    if (!s1.blacklist.includes(removed)) problems.push(`S.blacklist ${J(s1.blacklist)} lacks ${removed}`);
    if (s1.chain.includes(removed)) problems.push(`${removed} still on the chain ${J(s1.chain)}`);
    if (s1.chain.length < 3 || !s1.stops.length) problems.push(`no replacement stop: chain ${J(s1.chain)} error ${J(s1.error)}`);
    if (J(s1.stops) === J(s0.stops)) problems.push('stops unchanged ' + J(s1.stops));
    if (!s1.resuggest) problems.push('no [data-act=resuggest] button while the blacklist is non-empty');
    if (problems.length) throw new Error(problems.join('; '));
    await v2.click('#railBody [data-act=resuggest]');
    const s2 = await snap();
    if (s2.blacklist.length) problems.push('blacklist not cleared: ' + J(s2.blacklist));
    if (s2.resuggest) problems.push('Re-suggest button still shown after clearing');
    if (J(s2.stops) !== J(s0.stops)) problems.push(`stops after Re-suggest ${J(s2.stops)} ≠ original ${J(s0.stops)}`);
    if (problems.length) throw new Error(problems.join('; '));
    return { detail: `removed ${removed} → blacklist ${J(s1.blacklist)}, chain ${s1.chain.join('→')}; Re-suggest → blacklist [] chain ${s2.chain.join('→')}`, repro: 'node tests/ui/run.mjs planner --only blacklist', evidence: [ctx.shot('blacklist')] };
  }, { retry: 0 });

  // ---- 3. Prefer bias replans (engine oracle: planChain with the classic's penalty table) ------
  await ctx.check('bias', async () => {
    await baseline();
    const oracle = { medium: await v2.eval(ORACLE('medium-large-small')), large: await v2.eval(ORACLE('large-medium-small')) };
    if (!oracle.large || oracle.large.error) throw new Error('oracle: ' + J(oracle));
    await v2.setValue('#railBody select[data-act=bias]', 'large-medium-small', ['change']);
    const s1 = await snap();
    await ctx.screenshot(v2, 'bias');
    const problems = [];
    if (s1.bias !== 'large-medium-small') problems.push(`S.bias ${s1.bias}`);
    if (s1.biasSel !== 'large-medium-small') problems.push(`select re-rendered as ${s1.biasSel}`);
    if (J(s1.stops) !== J(oracle.large.stops)) problems.push(`stops ${J(s1.stops)} ≠ planChain(large-medium-small) ${J(oracle.large.stops)}`);
    if (J(oracle.large.stops) === J(oracle.medium.stops)) problems.push('(weak) the oracle picks the same stop for both orders — bias effect not observable on this route');
    await v2.setValue('#railBody select[data-act=bias]', 'medium-large-small', ['change']);
    const s2 = await snap();
    if (s2.bias !== 'medium-large-small' || J(s2.stops) !== J(oracle.medium.stops)) problems.push(`reset: bias ${s2.bias} stops ${J(s2.stops)} vs ${J(oracle.medium.stops)}`);
    if (problems.length) throw new Error(problems.join('; '));
    return { detail: `medium-large-small → ${J(oracle.medium.stops)}; large-medium-small → ${J(s1.stops)} (oracle ${J(oracle.large.stops)}); reset → ${J(s2.stops)}`, repro: 'node tests/ui/run.mjs planner --only bias', evidence: [ctx.shot('bias')] };
  }, { retry: 0 });

  // ---- 4. a manual stop: "Edited route", the operator's stop is not removable via the rail ----
  await ctx.check('manual-stop-edited-route', async () => {
    await baseline(); const auto = (await snap()).chain; ctx.state.autoChain = auto;
    await setRoute({ stops: ['EHRD'] });
    const s = await snap();
    await ctx.screenshot(v2, 'manual-stop');
    const problems = [];
    if (s.title !== 'Edited route') problems.push(`title "${s.title}"`);
    if (s.source !== 'user') problems.push(`source ${s.source}`);
    if (s.chain[1] !== 'EHRD') problems.push('EHRD not first stop: ' + J(s.chain));
    if (s.rm.includes('EHRD')) problems.push('the manual stop carries a rmPlanned button');
    if (s.legIssues.length || s.error) problems.push(`legIssues ${J(s.legIssues)} error ${J(s.error)} (the gap EHRD→EDDM should be auto-filled)`);
    if (s.chain.length < 4) problems.push('no auto stop filled between EHRD and EDDM: ' + J(s.chain));
    // remove the manual stop through the form's × (data-act=rmStop) → back to the suggested route
    await v2.click('#railBody [data-act=rmStop]');
    const s2 = await snap();
    if (s2.manual.length || s2.title !== 'Suggested route' || J(s2.chain) !== J(ctx.state.autoChain)) problems.push(`after rmStop: manual ${J(s2.manual)} title ${s2.title} chain ${J(s2.chain)} (want ${J(ctx.state.autoChain)})`);
    if (problems.length) throw new Error(problems.join('; '));
    return { detail: `chain ${s.chain.join('→')} title "${s.title}" source ${s.source} rm=${J(s.rm)}; × on the field → ${s2.chain.join('→')}`, repro: 'node tests/ui/run.mjs planner --only manual-stop', evidence: [ctx.shot('manual-stop')] };
  }, { retry: 0 });

  // ---- 5. multi-leg parity with the classic (same route, same catalog, same settings) ----------
  await ctx.check('multi-leg-parity', async () => {
    const classic = await getClassic();
    const cs = await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDM', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', freqN: 1, freqUnit: 'day' });
    const cr = await ctx.classicSimulate(classic);
    if (cr.error) throw new Error('classic simulate: ' + cr.error);
    await setRoute({ o: 'EHLE', d: 'EDDM', plane: 'beta_alia', charger: 'dc_320', trip: 'one-way', stops: [], clearBlacklist: true, bias: 'medium-large-small' });
    const vr = await ctx.v2Simulate(v2);
    if (vr.err) throw new Error('v2 simulate: ' + vr.err);
    await ctx.screenshot(v2, 'parity-v2'); await ctx.screenshot(classic, 'parity-classic');
    const planned = await v2.eval(`CNSUI.S.planned.stops.map(s => s.ident)`);
    const cStops = ids(cr.api.stops), vStops = ids(vr.api.stops);
    const problems = [];
    if (J(cStops) !== J(vStops)) problems.push(`stops classic ${J(cStops)} ≠ v2 payload ${J(vStops)}`);
    if (J(planned) !== J(vStops)) problems.push(`S.planned.stops ${J(planned)} ≠ payload ${J(vStops)}`);
    const E = cr.engine, D = vr.engine;
    const cmp = [['energy', E.energyUsedKwh, D.used], ['dist', E.distKm, D.dist], ['flight', E.flightMin, D.flyMin], ['charge', E.chargeMin, D.chargeMin]];
    for (const [k, a, b] of cmp) if (!ctx.close(a, b, 1e-6)) problems.push(`engine ${k}: classic ${a} v2 ${b}`);
    const ca = ctx.stripApi(cr.api), va = ctx.stripApi(vr.api);
    if (J(ca) !== J(va)) { const diff = Object.keys(Object.assign({}, ca, va)).filter(k => J(ca[k]) !== J(va[k])); problems.push('API result differs in ' + J(diff)); }
    const shownUsed = ctx.num(cr.shown.hlUsed), v2Used = ctx.num(vr.shown.stats[0]);
    if (shownUsed !== v2Used) problems.push(`shown energy classic ${cr.shown.hlUsed} v2 ${vr.shown.stats[0]}`);
    if (problems.length) throw new Error(problems.join('; ') + ` (classic warnings ${J(cs.warnings)})`);
    return { detail: `stops ${J(cStops)}; energy ${E.energyUsedKwh.toFixed(3)} dist ${E.distKm.toFixed(3)} flight ${E.flightMin.toFixed(3)} charge ${E.chargeMin.toFixed(3)} equal; shown ${cr.shown.hlUsed} / ${vr.shown.stats[0]}`, repro: 'node tests/ui/run.mjs planner --only multi-leg-parity', evidence: [ctx.shot('parity-v2'), ctx.shot('parity-classic')] };
  }, { retry: 0 });
  await v2.eval(`(function(){ const b = document.querySelector('[data-act=edit]'); if (b) b.click(); return true; })()`);

  // ---- 6. rail distances = result-table distances (classic: _dispKm = routed + SID/STAR in BOTH places) ----
  await ctx.check('distances-consistent', async () => {
    // an IFR+reserves airframe carries the 10 km SID/STAR pad (settings default) — VFR would hide the gap
    await setRoute({ o: 'EHLE', d: 'EDDF', plane: 'heart_es30_25_pax', trip: 'one-way', stops: [], clearBlacklist: true });
    const s = await snap();
    const sid = await v2.eval(`CNSSettings.sidStarPaddingKm(CNSUI.plane())`);
    const railLegs = s.rows.slice(1).map(r => ctx.num(r.d)), railTotal = ctx.num((s.rh.match(/·\s*([\d,.]+)\s*(km|NM)/) || [])[1]);
    const vr = await ctx.v2Simulate(v2);
    if (vr.err) throw new Error('v2 simulate: ' + vr.err);
    const table = await v2.eval(`Array.from(document.querySelectorAll('#railBody .acc[data-acc=route] .tbl tr')).slice(1).map(tr => tr.children[1].textContent.trim())`);
    const tableLegs = table.map(ctx.num);
    const engine = vr.engine.legs.map(l => ({ raw: +l.rawKm.toFixed(2), dist: +l.distKm.toFixed(2) }));
    await ctx.screenshot(v2, 'distances-result');
    // control: the classic shows the same padded number in its Suggested route list and its result
    const cl = await (async () => { const classic = await getClassic(); await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'heart_es30_25_pax', trip: 'one-way' }); return classic.eval(`({ summary: (document.getElementById('stopsSummary') || {}).textContent, legs: Array.from(document.querySelectorAll('#stopsList .leg-dist')).map(e => e.textContent.trim()), disp: typeof _dispKm === 'function' ? _dispKm({ lat: selected.origin.latitude_deg, lon: selected.origin.longitude_deg }, { lat: selected.destination.latitude_deg, lon: selected.destination.longitude_deg }) : null })`); })();
    const problems = [];
    if (J(railLegs) !== J(tableLegs)) problems.push(`rail legs ${J(railLegs)} ≠ result table ${J(tableLegs)} (engine raw/routed ${J(engine)}, SID/STAR ${sid} km)`);
    if (Number.isFinite(railTotal) && Math.abs(railTotal - tableLegs.reduce((a, b) => a + b, 0)) > 1) problems.push(`rail header total ${railTotal} ≠ Σ table ${tableLegs.reduce((a, b) => a + b, 0)}`);
    await v2.eval(`(function(){ const b = document.querySelector('[data-act=edit]'); if (b) b.click(); return true; })()`);
    if (problems.length) throw new Error(problems.join('; ') + (cl ? ` — classic shows ${J(cl.legs)} / ${J(cl.summary)} (_dispKm ${cl.disp && cl.disp.toFixed(2)})` : '') + ' — full: ' + dump('distances-consistent', { rail: s.rows, rh: s.rh, table, engine, sid, classic: cl }));
    return { detail: `rail ${J(railLegs)} = table ${J(tableLegs)}; engine ${J(engine)}; classic ${cl ? J(cl.legs) : 'n/a'}`, repro: 'node tests/ui/run.mjs planner --only distances-consistent', evidence: [ctx.shot('distances-result')] };
  }, { retry: 0 });

  // ---- 6b. rail leg text vs the classic's leg text (rounding: the classic rounds UP via CNSUnits.r) ----
  await ctx.check('distances-classic-rounding', async () => {
    const classic = await getClassic();
    await setRoute({ o: 'EHLE', d: 'EDDF', plane: 'beta_alia', trip: 'one-way', stops: [], clearBlacklist: true });   // VFR: no pad → only rounding can differ
    const s = await snap();
    await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'beta_alia', trip: 'one-way' });
    const cl = await classic.eval(`({ legs: Array.from(document.querySelectorAll('#stopsList .leg-dist')).map(e => e.textContent.replace(/[→\\s]+/g, ' ').trim()), summary: (document.getElementById('stopsSummary') || {}).textContent.trim(), raw: CNSRouting.haversineKm({ lat: selected.origin.latitude_deg, lon: selected.origin.longitude_deg }, { lat: selected.destination.latitude_deg, lon: selected.destination.longitude_deg }) })`);
    const v = s.rows.slice(1).map(r => r.d);
    if (J(v) !== J(cl.legs)) throw new Error(`v2 rail ${J(v)} ≠ classic leg text ${J(cl.legs)} (great-circle ${cl.raw.toFixed(3)} km; classic fmtDist rounds up, v2 fmt.dist uses Math.round)`);
    return { detail: `v2 ${J(v)} = classic ${J(cl.legs)} (raw ${cl.raw.toFixed(3)})`, repro: 'node tests/ui/run.mjs planner --only distances-classic-rounding' };
  }, { retry: 0 });

  // ---- 7. range override 100 km → the offending leg is marked --------------------------------
  await ctx.check('leg-issue-marking', async () => {
    await setRoute({ o: 'EHLE', d: 'EDDF', plane: 'beta_alia', trip: 'one-way', stops: [], clearBlacklist: true });
    await v2.click('#railBody [data-act=acEdit]');
    const inp = await v2.rect('#railBody input[data-act=acOverride]'); if (!inp) throw new Error('no override input after "Edit for this flight"');
    const seeded = await v2.eval(`+document.querySelector('#railBody input[data-act=acOverride]').value`);
    await v2.setValue('#railBody input[data-act=acOverride]', '100', ['input', 'change']);
    const s = await snap();
    await ctx.screenshot(v2, 'leg-issue');
    const problems = [];
    if (s.override !== 100) problems.push(`S.availOverride ${s.override}`);
    if (Math.abs(s.avail - 100) > 1e-6) problems.push(`availableRangeKm ${s.avail} (want 100 for a VFR airframe)`);
    if (!s.legIssues.includes(0)) problems.push(`legIssues ${J(s.legIssues)}`);
    const badRows = s.rows.map((r, i) => r.bad ? i : -1).filter(i => i >= 0);
    if (!badRows.includes(1)) problems.push(`.stop.bad rows ${J(badRows)} (want the arrival row 1)`);
    if (!/bad/.test(await v2.eval(`document.querySelector('#railBody .route .rh').className`))) problems.push('.route .rh lacks .bad');
    if (!s.error) problems.push('no planned.error');
    // reset through the same control
    await v2.click('#railBody [data-act=acEdit]');
    const s2 = await snap();
    if (s2.override != null || s2.legIssues.length) problems.push(`after Reset override: override ${s2.override} legIssues ${J(s2.legIssues)}`);
    if (problems.length) throw new Error(problems.join('; '));
    return { detail: `override seeded ${seeded} → 100: avail ${s.avail}, legIssues ${J(s.legIssues)}, bad rows ${J(badRows)}, error "${s.error}"; reset → ${s2.avail.toFixed(1)}`, repro: 'node tests/ui/run.mjs planner --only leg-issue-marking', evidence: [ctx.shot('leg-issue')] };
  }, { retry: 0 });

  // ---- 7b. override with airways padding ON: the typed value is the SHOWN range (classic index.html:4056 stores v/route) ----
  await ctx.check('override-airways-padding', async () => {
    await v2.eval(`CNSSettings.save({ routingPadding: { enabled: true, factor: 1.05 } }); true`);
    try {
      await setRoute({ o: 'EHLE', d: 'EDDF', plane: 'heart_es30_25_pax', trip: 'one-way', stops: [], clearBlacklist: true });
      const f = await v2.eval(`({ route: CNSSettings.routingFactor(CNSUI.plane()), sid: CNSSettings.sidStarPaddingKm(CNSUI.plane()) })`);
      if (f.route !== 1.05) throw new Error('routingFactor did not take: ' + J(f));
      const s0 = await snap();
      await v2.click('#railBody [data-act=acEdit]');
      const seeded = await snap();   // merely opening the override must not move the reach (the classic seeds the field with the shown range and stores v/route)
      await v2.setValue('#railBody input[data-act=acOverride]', '100', ['input', 'change']);
      const s = await snap();
      const want = { avail: (100 / f.route) - f.sid / f.route, shown: 100 };   // classic: base = v/route; shown = base·route = v
      // control: the classic's own override field for the same aircraft
      let cl = null;
      { const classic = await getClassic(); await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'heart_es30_25_pax', trip: 'one-way' });
        cl = await classic.eval(`(function(){ const i = document.getElementById('psoAvailRange'); if (!i) return { missing: 'psoAvailRange' }; i.value = '100'; i.dispatchEvent(new Event('change', { bubbles: true })); const p = selectedPlaneSpec(); const out = { avail: _availableRangeKm(p), shown: _availRangeShownKm(p), psAvail: (document.getElementById('psAvail') || {}).textContent }; const r = document.getElementById('psoReset'); if (r) r.click(); return out; })()`); }
      await v2.click('#railBody [data-act=acEdit]');   // reset the v2 override
      const problems = [];
      if (Math.abs(seeded.shown - s0.shown) > 0.01) problems.push(`opening "Edit for this flight" alone moved the reach: shown ${s0.shown.toFixed(1)} → ${seeded.shown.toFixed(1)}, avail ${s0.avail.toFixed(1)} → ${seeded.avail.toFixed(1)} (override seeded ${seeded.override})`);
      if (Math.abs(s.shown - want.shown) > 0.01) problems.push(`shown range ${s.shown.toFixed(2)} after typing 100 (classic keeps 100${cl && cl.shown != null ? ', classic control ' + cl.shown.toFixed(2) : ''})`);
      if (Math.abs(s.avail - want.avail) > 0.01) problems.push(`availableRangeKm ${s.avail.toFixed(2)} ≠ classic ${want.avail.toFixed(2)}${cl && cl.avail != null ? ' (classic control ' + cl.avail.toFixed(2) + ')' : ''}`);
      if (problems.length) throw new Error(problems.join('; ') + ' — full: ' + dump('override-airways-padding', { factors: f, before: s0, afterEdit: seeded, after100: s, want, classic: cl }));
      return { detail: `routingFactor ${f.route}, SID/STAR ${f.sid}: override 100 → avail ${s.avail.toFixed(2)} shown ${s.shown.toFixed(2)} (classic ${J(cl)})`, repro: 'node tests/ui/run.mjs planner --only override-airways-padding' };
    } finally { await v2.eval(`CNSSettings.save({ routingPadding: { enabled: false, factor: 1.05 } }); CNSUI.S.availOverride = null; true`); }
  }, { retry: 0 });

  // ---- 8. no route at all: the hard-fail copy (classic renderStops default branch) --------------
  await ctx.check('no-route-hard-fail-copy', async () => {
    await setRoute({ o: 'EHLE', d: 'EDDF', plane: 'pipistrel_velis', trip: 'one-way', stops: [], clearBlacklist: true });
    const s = await snap();
    const remedy = await v2.eval(`CNSUI.planner.noRouteRemedy()`);
    let cl = null;
    { const classic = await getClassic(); await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'pipistrel_velis', trip: 'one-way' });
      cl = await classic.eval(`({ remedy: typeof _noRouteRemedy === 'function' ? _noRouteRemedy() : 'n/a', err: (document.querySelector('#stopsList .stops-error') || document.querySelector('#stopsHint') || {}).textContent, plannedError: typeof plannedError !== 'undefined' ? plannedError : 'n/a' })`); }
    await ctx.screenshot(v2, 'no-route-hard-fail'); if (classic) await ctx.screenshot(classic, 'no-route-hard-fail-classic');
    const problems = [];
    if (!s.error) problems.push('no planned.error for the Velis EHLE→EDDF');
    if (remedy !== null) problems.push(`v2 remedy ${J(remedy)} (classic ${cl && J(cl.remedy)})`);
    if (cl && cl.remedy !== null && cl.remedy !== 'n/a') problems.push('classic control offers a remedy: ' + J(cl.remedy));
    const classicCopy = /No route within range/;
    if (cl && !classicCopy.test(cl.err || '')) problems.push('classic did not show its hard-fail copy: ' + J(cl.err));
    if (!classicCopy.test(s.err || '')) problems.push(`v2 .route .err says "${s.err}" — the classic says "${(cl && cl.err || '').trim().slice(0, 120)}"`);
    const chainErr = await v2.eval(`(function(){ const PL = CNSUI.planner, S = CNSUI.S, t = PL.terminus(); return CNSRouting.planChain({ origin: t.origin, dest: t.dest, manualStops: [], plane: CNSUI.plane(), allowedTypes: S.allowedTypes, allAirports: CNSUI.airports(), allowedIdents: PL.plannerAllowedIdents(), blacklist: S.blacklist, maxLegKm: PL.availableRangeKm(), options: PL.routingOptions() }).error; })()`);
    if (problems.length) throw new Error(problems.join('; ') + ' — full: ' + dump('no-route-hard-fail-copy', { v2: { err: s.err, plannedError: s.error, remedy, chainResError: chainErr }, classic: cl }));
    return { detail: `v2 "${s.err}" / classic "${(cl && cl.err || '').trim().slice(0, 100)}"`, repro: 'node tests/ui/run.mjs planner --only no-route-hard-fail-copy', evidence: [ctx.shot('no-route-hard-fail')] };
  }, { retry: 0 });

  // ---- 9. no-route remedy: the one-click "enable small airfields" fix + persisted map option -----
  await ctx.check('no-route-remedy', async () => {
    // Velis EHRD→EDDF: the only pair in a 9-aircraft × 17-route scan where the classic's probe says 'types'
    await setRoute({ o: 'EHRD', d: 'EDDF', plane: 'pipistrel_velis', trip: 'one-way', stops: [], clearBlacklist: true });
    const s0 = await snap();
    const remedy = await v2.eval(`CNSUI.planner.noRouteRemedy()`);
    let cl = null;
    { const classic = await getClassic(); await ctx.classicSetRoute(classic, { o: 'EHRD', d: 'EDDF', plane: 'pipistrel_velis', trip: 'one-way' }); cl = await classic.eval(`({ remedy: typeof _noRouteRemedy === 'function' ? _noRouteRemedy() : 'n/a', btn: !!document.querySelector('#stopsList button:not(.stops-retry), #stopsHint button:not(.stops-retry)') })`); }
    await ctx.screenshot(v2, 'no-route-remedy-before');
    const problems = [];
    if (!s0.error) problems.push('no planned.error');
    if (remedy !== 'types') problems.push(`v2 remedy ${J(remedy)} (classic ${cl && J(cl.remedy)})`);
    if (!s0.remedyBtns.includes('remedyTypes')) problems.push(`no [data-act=remedyTypes] in .route .err (buttons ${J(s0.remedyBtns)}, err "${s0.err}")`);
    if (problems.length) throw new Error(problems.join('; '));
    await v2.click('#railBody [data-act=remedyTypes]');
    const s1 = await snap();
    const after = await v2.eval(`({ cb: document.querySelector('#mapDd .airport-filter[value=small_airport]').checked, ls: JSON.parse(localStorage.getItem('cns_map_options') || 'null'), small: CNSUI.map.map.hasLayer ? null : null })`);
    await ctx.screenshot(v2, 'no-route-remedy-after');
    if (!s1.allowed.includes('small_airport')) problems.push(`S.allowedTypes ${J(s1.allowed)}`);
    if (!after.cb) problems.push('Map menu "Small" checkbox not checked');
    if (!after.ls || after.ls.fSmall !== true) problems.push(`cns_map_options.fSmall not persisted: ${J(after.ls)} (classic: the Enable-types button dispatches change → the options menu snapshots)`);
    if (s1.error || !s1.stops.length) problems.push(`route still failing after the remedy: error ${J(s1.error)} stops ${J(s1.stops)}`);
    // control: the SAME option flipped through the Map menu checkbox itself persists
    await v2.click('#mapBtn'); const cbBefore = await v2.eval(`document.querySelector('#mapDd .airport-filter[value=small_airport]').checked`);
    await v2.click('#mapDd .airport-filter[value=small_airport]');   // un-tick (restores the default pool for later checks)
    const ctl = await v2.eval(`({ cb: document.querySelector('#mapDd .airport-filter[value=small_airport]').checked, ls: JSON.parse(localStorage.getItem('cns_map_options') || 'null'), allowed: CNSUI.S.allowedTypes.slice() })`);
    await v2.eval(`document.querySelector('#mapDd').classList.remove('open'); true`);
    if (!ctl.ls || ctl.ls.fSmall !== false || ctl.allowed.includes('small_airport')) problems.push(`control: Map-menu click did not persist/apply: ${J(ctl)}`);
    if (problems.length) throw new Error(problems.join('; ') + ` — after remedy: allowed ${J(s1.allowed)} cb ${after.cb} ls ${J(after.ls)}; control ${J(ctl)} — full: ` + dump('no-route-remedy', { before: { err: s0.err, remedyBtns: s0.remedyBtns, remedy, classic: cl }, afterRemedy: { allowed: s1.allowed, chain: s1.chain, error: s1.error, checkbox: after.cb, cns_map_options: after.ls }, mapMenuControl: ctl }));
    return { detail: `remedy 'types' (classic ${cl && cl.remedy}); click → allowed ${J(s1.allowed)}, chain ${s1.chain.join('→')}, fSmall persisted ${after.ls && after.ls.fSmall}; Map-menu control ${J(ctl.ls)}`, repro: 'node tests/ui/run.mjs planner --only no-route-remedy', evidence: [ctx.shot('no-route-remedy-before'), ctx.shot('no-route-remedy-after')] };
  }, { retry: 0 });

  // ---- 10. circular: chain closes at the origin, closing-leg auto stops ------------------------
  await ctx.check('circular-chain', async () => {
    const s = await setupRing();
    await ctx.screenshot(v2, 'circular');
    const problems = [];
    if (s.trip !== 'circular') problems.push('S.trip ' + s.trip);
    if (s.chain[0] !== 'EHLE' || s.chain[s.chain.length - 1] !== 'EHLE') problems.push('ring does not close at EHLE: ' + J(s.chain));
    if (s.chain[1] !== 'EHRD') problems.push('manual stop not first: ' + J(s.chain));
    if (!s.chain.includes('EDDM')) problems.push('far point EDDM missing: ' + J(s.chain));
    if (!s.closing.length) problems.push(`no closing-leg auto stop although EDDM→EHLE is ${s.legsKm[s.legsKm.length - 1]} km vs reach ${s.avail.toFixed(0)} (closing ${J(s.closing)})`);
    if (s.error || s.legIssues.length) problems.push(`error ${J(s.error)} legIssues ${J(s.legIssues)}`);
    if (s.rows.length !== s.chain.length) problems.push(`${s.rows.length} rail rows vs ${s.chain.length} nodes`);
    if (problems.length) throw new Error(problems.join('; '));
    return { detail: `ring ${s.chain.join('→')} (stops ${J(s.stops)} closing ${J(s.closing)}), legs ${J(s.legsKm)} ≤ ${s.avail.toFixed(0)}`, repro: 'node tests/ui/run.mjs planner --only circular-chain', evidence: [ctx.shot('circular')] };
  }, { retry: 0 });

  // ---- 10b. circular simulate: engine legs follow the ring; SoC points = legs + 1 -----------------
  await ctx.check('circular-profile', async () => {
    const ring = (await v2.eval(`CNSUI.S.trip === 'circular' && CNSUI.S.rail === 'form'`)) && ctx.state.ring || (await setupRing()).chain;
    const vr = await ctx.v2Simulate(v2);
    if (vr.err) throw new Error('v2 simulate: ' + vr.err);
    const legs = vr.engine.legs.map(l => l.fromIdent + '→' + l.toIdent), km = vr.engine.legs.map(l => Math.round(l.distKm));
    const pts = await v2.eval(`document.querySelectorAll('#railBody .soc svg circle').length`);
    const api = { stops: ids(vr.api.stops), dest: vr.api._dest && vr.api._dest.ident, payloadDestName: vr.api.destination && vr.api.destination.name };
    await ctx.screenshot(v2, 'circular-result');
    // classic control: same ring (setDest EDDM then circular → the drafted destination becomes the ring's last stop)
    let cl = null;
    { const classic = await getClassic(); await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDM', stops: ['EHRD'], plane: 'beta_alia', charger: 'dc_320', trip: 'circular' }); const cr = await ctx.classicSimulate(classic);
      cl = cr.error ? { error: cr.error } : { stops: ids(cr.api.stops), dest: cr.api._dest && cr.api._dest.ident, named: cr.api._namedDestIdent, legs: await classic.eval(`_engineProfile(lastResult).legs.map(l => l.fromIdent + '→' + l.toIdent)`), shownUsed: cr.shown.hlUsed, used: cr.engine && +cr.engine.energyUsedKwh.toFixed(2) };
      await ctx.screenshot(classic, 'circular-result-classic'); }
    const problems = [];
    if (legs.length !== ring.length - 1) problems.push(`${legs.length} engine legs for a ${ring.length}-node ring`);
    if (J(legs) !== J(pairs(ring))) problems.push(`engine legs ${J(legs)} ≠ ring legs ${J(pairs(ring))}`);
    if (km.some(k => k === 0)) problems.push('a 0 km leg: ' + J(km));
    if (vr.engine.legs.some(l => l.overRange)) problems.push('an over-range leg in the engine profile (the planner said every leg fits)');
    if (pts !== legs.length + 1) problems.push(`SoC chart has ${pts} points for ${legs.length} legs`);
    if (api.dest !== ring[ring.length - 2]) problems.push(`S.result._dest ${api.dest} ≠ the last ring node ${ring[ring.length - 2]}${cl && cl.dest ? ' (classic _dest ' + cl.dest + ')' : ''}`);
    if (cl && cl.legs && J(cl.legs) !== J(legs)) problems.push(`classic engine legs ${J(cl.legs)} ≠ v2 ${J(legs)}`);
    if (problems.length) throw new Error(`v2 shown ${J(vr.shown.stats)} / classic ${cl && cl.shownUsed}; ` + problems.join('; ') + ' — full: ' + dump('circular-profile', { ring, v2: { legs: vr.engine.legs.map(l => ({ leg: l.fromIdent + '→' + l.toIdent, distKm: +l.distKm.toFixed(1), energyKwh: +l.energyKwh.toFixed(1), overRange: !!l.overRange })), used: +vr.engine.used.toFixed(2), dist: +vr.engine.dist.toFixed(1), shown: vr.shown, socPoints: pts, api, lowest: await v2.eval(`(document.querySelector('#railBody .soc .lbl .r') || {}).textContent`), table: await v2.eval(`Array.from(document.querySelectorAll('#railBody .acc[data-acc=route] .tbl tr')).slice(1).map(tr => Array.from(tr.children).map(td => td.textContent.trim()))`) }, classic: cl }));
    return { detail: `legs ${J(legs)} km ${J(km)}, SoC points ${pts}, _dest ${api.dest}; classic ${J(cl)}`, repro: 'node tests/ui/run.mjs planner --only circular-profile', evidence: [ctx.shot('circular-result')] };
  }, { retry: 0 });

  // ---- 10c. circular → Add to network: the folder entry lists every ring node once ---------------
  await ctx.check('circular-folder-entry', async () => {
    let ring = ctx.state.ring;
    const ok = await v2.eval(`!!(CNSUI.S.result && CNSUI.S.rail === 'result' && CNSUI.S.trip === 'circular')`);
    if (!ok || !ring) { ring = (await setupRing()).chain; const vr = await ctx.v2Simulate(v2); if (vr.err) throw new Error('v2 simulate: ' + vr.err); }
    await v2.eval(`CNSDemand.saveFolder([]); CNSUI.folderChanged(); true`);
    await v2.click('#railFoot [data-act=add]');
    const e = await v2.eval(`(function(){ const f = CNSDemand.loadFolder(); const e = f[f.length - 1] || {}; return { n: f.length, o: e.originIdent, d: e.destIdent, stops: (e.stops || []).map(s => s.ident + (s._manual ? '*' : s._auto ? '' : '?')), trip: e.tripType, count: (document.getElementById('netCount') || {}).textContent }; })()`);
    const problems = [];
    const nodes = [e.o, ...e.stops.map(x => x.replace(/[*?]$/, '')), e.d];
    const dup = nodes.filter((x, i) => nodes.indexOf(x) !== i);
    if (e.n !== 1) problems.push('folder length ' + e.n);
    if (e.trip !== 'circular') problems.push('tripType ' + e.trip);
    if (dup.length) problems.push(`duplicated node(s) ${J(dup)} in origin/stops/dest ${J(nodes)}`);
    if (J(nodes) !== J(ring.slice(0, -1))) problems.push(`entry nodes ${J(nodes)} ≠ ring ${J(ring.slice(0, -1))} (classic: destIdent = the LAST ring node, the named destination rides in stops with _manual)`);
    if (!e.stops.some(x => /\*$/.test(x))) problems.push('no stop carries _manual (classic mergeManualFlags keeps the operator stops manual; a recompute would re-plan them away)');
    await v2.eval(`CNSDemand.saveFolder([]); CNSUI.folderChanged(); CNSUI.render(); true`);
    if (problems.length) throw new Error(problems.join('; ') + ' — entry ' + J(e) + ' — full: ' + dump('circular-folder-entry', { ring, entry: e, nodes, classicExpectation: { destIdent: ring[ring.length - 2], stops: ring.slice(1, -2), manualIdents: ['EHRD', 'EDDM'] } }));
    return { detail: `entry ${e.o} → ${J(e.stops)} → ${e.d} (${e.trip})`, repro: 'node tests/ui/run.mjs planner --only circular-folder-entry' };
  }, { retry: 0 });

  // ---- 11. alternates overlay: one divert marker per arrival node, a VISIBLE handle ---------------
  await ctx.check('alternates-markers', async () => {
    await baseline();
    await ensureAlternates();
    const m = await v2.eval(`(function(){ const q = s => Array.from(document.querySelectorAll(s)); const chain = CNSUI.chain().length;
      const marks = q('.divert-marker').map(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), bg: cs.backgroundColor, x: Math.round(r.left), y: Math.round(r.top) }; });
      const wraps = q('.divert-marker-wrap').map(el => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: Math.round(r.left), y: Math.round(r.top) }; });
      return { showAlt: CNSUI.S.showAlternates, chain, marks, wraps, labels: q('.alt-dist-label').map(l => l.textContent.trim()), lines: q('.leaflet-overlay-pane path, .leaflet-overlay-pane canvas').length, altPick: q('#railBody [data-act=altPick]').map(b => b.dataset.ident), ls: JSON.parse(localStorage.getItem('cns_map_options') || 'null'), css: !!Array.from(document.styleSheets).some(ss => { try { return Array.from(ss.cssRules).some(r => /\\.divert-marker/.test(r.selectorText || '')); } catch (e) { return false; } }) }; })()`);
    await ctx.screenshot(v2, 'alternates');
    const problems = [];
    if (!m.showAlt) problems.push('S.showAlternates false after ticking #fAlternates');
    if (!m.ls || m.ls.fAlternates !== true) problems.push('cns_map_options.fAlternates not persisted: ' + J(m.ls));
    if (m.marks.length !== m.chain - 1) problems.push(`${m.marks.length} .divert-marker for a ${m.chain}-node chain (want ${m.chain - 1})`);
    if (m.altPick.length !== m.chain - 1) problems.push(`${m.altPick.length} [data-act=altPick] buttons (want ${m.chain - 1})`);
    const invisible = m.marks.filter(k => k.h < 4 || k.w < 4 || /rgba\(0, 0, 0, 0\)|transparent/.test(k.bg));
    if (invisible.length) problems.push(`${invisible.length}/${m.marks.length} divert handles are invisible ${J(invisible)} — desktop.css has ${m.css ? '' : 'NO '}.divert-marker rule (classic index.html:1667–1669: 14×14 purple disc, white border)`);
    if (problems.length) throw new Error(problems.join('; ') + ` — labels ${J(m.labels)} wraps ${J(m.wraps)} — full: ` + dump('alternates-markers', m));
    return { detail: `${m.marks.length} markers for ${m.chain} nodes, labels ${J(m.labels)}, handles ${J(m.marks)}`, repro: 'node tests/ui/run.mjs planner --only alternates-markers', evidence: [ctx.shot('alternates')] };
  }, { retry: 0 });

  // ---- 11b. ALT pick: the rail button arms the pick; a REAL click on an airport dot sets the override ----
  await ctx.check('alternates-alt-pick', async () => {
    await baseline(); await ensureAlternates();
    const node = await v2.eval(`(document.querySelector('#railBody [data-act=altPick]') || {}).dataset ? document.querySelector('#railBody [data-act=altPick]').dataset.ident : null`);
    if (!node) throw new Error('no [data-act=altPick] button');
    await v2.click('#railBody [data-act=altPick]');
    const pending = await v2.eval(`CNSUI.planner.pickPending()`);
    if (!pending) throw new Error('CNSUI.planner.pickPending() false after clicking divert…');
    await v2.waitForMapIdle(); await v2.closePopups();
    // a runway-suitable dot the divert editor would accept (CNSRunway hasData+fits for the Alia)
    const dots = (await v2.pickClickableDots(6));
    const suit = await v2.eval(`(function(){ const ok = CNSUI.planner.divertSuitable(); return ${J(dots.map(d => d.ident))}.map(i => ok(CNSUI.byId()[i])); })()`);
    const dot = dots.find((d, i) => suit[i]); if (!dot) throw new Error('no suitable clickable dot: ' + J(dots.map((d, i) => d.ident + ':' + suit[i])));
    const t0 = Date.now();
    await v2.clickAt(dot.x, dot.y); await v2.sleep(400);
    const real = await v2.eval(`({ ov: Object.assign({}, CNSUI.S.divertOverrides), pending: CNSUI.planner.pickPending(), popup: !!document.querySelector('.leaflet-popup') })`);
    const realEx = exceptionsSince(v2, t0);
    let fallback = null;
    if (!real.ov[node]) {
      if (dot.topPane !== 'leaflet-dots-pane') ctx.blockedBy.push('MAP-1');
      // fall back to the host hook the dot handler calls (map.js:33) — tests the editor/planner wiring on its own
      fallback = await v2.eval(`(function(){ try { const r = CNSUI.planner.notifyAirportPick(CNSUI.byId()[${J(dot.ident)}]); return { r: r === undefined ? 'void' : r, ov: Object.assign({}, CNSUI.S.divertOverrides), pending: CNSUI.planner.pickPending() }; } catch (e) { return { threw: String(e && e.message || e), pending: CNSUI.planner.pickPending() }; } })()`);
    }
    await v2.sleep(200);
    const s = await snap();
    await ctx.screenshot(v2, 'alt-pick');
    const row = s.rows.find(r => r.txt.includes('ALT ' + dot.ident));
    const problems = [];
    const via = real.ov[node] ? 'real dot click' : fallback && fallback.ov && fallback.ov[node] ? 'CNSUI.planner.notifyAirportPick fallback (real click blocked by MAP-1)' : null;
    if (!via) problems.push(`no divert override for ${node}: real click on ${dot.ident} @${Math.round(dot.x)},${Math.round(dot.y)} top=${dot.topPane} → ${J(real)}${realEx.length ? ' exceptions ' + J(realEx) : ''}; fallback → ${J(fallback)}`);
    else {
      if (s.diverts[node] !== dot.ident) problems.push(`S.divertOverrides ${J(s.diverts)}`);
      if (!row) problems.push(`no 'ALT ${dot.ident}' label on the ${node} row (rows ${J(s.rows.map(r => r.alt))})`);
      if (!(await v2.eval(`!!document.querySelector('#railBody [data-act=altReset][data-ident=${J(node)}]')`))) problems.push('no [data-act=altReset]');
      else { await v2.click(`#railBody [data-act=altReset][data-ident="${node}"]`); const s2 = await snap(); if (s2.diverts[node]) problems.push('altReset left the override: ' + J(s2.diverts)); }
    }
    await v2.eval(`if (window.CNSDivertEdit) CNSDivertEdit.cancelAltPick(); true`);
    if (problems.length) { attributed.push(...realEx); throw new Error(problems.join('; ') + ' — full: ' + dump('alternates-alt-pick', { node, dot, suitableDots: dots.map((d, i) => d.ident + ':' + suit[i]), realClick: real, realClickExceptions: realEx, fallback, blockedBy: ctx.blockedBy.slice() })); }
    return { detail: `armed for ${node}; picked ${dot.ident} via ${via}; ALT label + reset ok`, repro: 'node tests/ui/run.mjs planner --only alternates-alt-pick', evidence: [ctx.shot('alt-pick')] };
  }, { retry: 0 });

  // ---- 11c. dragging a divert marker 60 px snaps to a suitable airport or reverts — never throws ---
  await ctx.check('alternates-drag', async () => {
    await baseline(); await ensureAlternates();
    await v2.sleep(200);
    const before = await v2.eval(`(function(){ const w = document.querySelector('.divert-marker-wrap'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, labels: Array.from(document.querySelectorAll('.alt-dist-label')).map(l => l.textContent.trim()), n: document.querySelectorAll('.divert-marker-wrap').length }; })()`);
    if (!before) throw new Error('no .divert-marker-wrap on the map (alternates overlay off?)');
    const t0 = Date.now();
    await v2.drag(before.x, before.y, before.x + 60, before.y, 12);
    await v2.sleep(500);
    const after = await v2.eval(`(function(){ const w = document.querySelector('.divert-marker-wrap'); const r = w ? w.getBoundingClientRect() : null; return { x: r && r.left + r.width / 2, y: r && r.top + r.height / 2, labels: Array.from(document.querySelectorAll('.alt-dist-label')).map(l => l.textContent.trim()), ov: Object.assign({}, CNSUI.S.divertOverrides), n: document.querySelectorAll('.divert-marker-wrap').length }; })()`);
    const ex = exceptionsSince(v2, t0);
    await ctx.screenshot(v2, 'alternates-drag');
    const moved = after.x != null && Math.hypot(after.x - before.x, after.y - before.y);
    const overrideSet = Object.keys(after.ov).length > 0;
    const reverted = moved != null && moved < 3 && J(after.labels) === J(before.labels);
    const problems = [];
    if (ex.length) problems.push(`${ex.length} exception(s) during the drag: ${J([...new Set(ex)])}`);
    if (!overrideSet && !reverted) problems.push(`neither an override (${J(after.ov)}) nor a clean revert (marker moved ${moved && moved.toFixed(0)} px, labels ${J(before.labels)} → ${J(after.labels)})`);
    if (problems.length) { attributed.push(...ex); throw new Error(problems.join('; ') + ' — full: ' + dump('alternates-drag', { before, after, movedPx: moved, exceptions: ex, stacks: v2.errors.filter(e => e.type === 'exception' && e.t >= t0).slice(0, 2).map(e => e.text) })); }
    await v2.eval(`CNSUI.S.divertOverrides = {}; CNSUI.plan.onFormChange(false); true`);
    return { detail: overrideSet ? `override ${J(after.ov)} after a 60 px drag, labels ${J(after.labels)}` : `clean revert (moved ${moved.toFixed(1)} px), labels unchanged ${J(after.labels)}`, repro: 'node tests/ui/run.mjs planner --only alternates-drag', evidence: [ctx.shot('alternates-drag')] };
  }, { retry: 0 });

  // ---- 12. every exception not already attributed to a failing check above ----------------------
  await ctx.check('no-unattributed-exceptions', async () => {
    const all = [...v2.exceptions().map(e => ({ page: 'v2', text: e.text.split('\n')[0].slice(0, 200) })), ...(classic ? ctx.exceptions(classic).map(e => ({ page: 'classic', text: e.text.split('\n')[0].slice(0, 200) })) : [])];   // `classic` = the lazily opened tab (null when no check needed it)
    const rest = all.filter(e => !attributed.includes(e.text));
    if (rest.length) throw new Error(`${rest.length} unattributed exception(s): ` + J([...new Set(rest.map(e => e.page + ': ' + e.text))]));
    return `v2 exceptions ${v2.exceptions().length} (${attributed.length} attributed to failing checks), classic ${classic ? ctx.exceptions(classic).length : 'n/a'}`;
  }, { retry: 0 });
}
