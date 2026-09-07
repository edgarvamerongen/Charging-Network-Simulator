/* simulate-result: Plan mode Simulate → result panel, against the classic (index.html renderResult /
   addFolder) on the production catalog. Every parity check drives BOTH shells with the same inputs
   (classic tab = same Chrome profile) and compares: the /api/simulate response (deep-equal after
   stripping v2's `_*` annotations), the CNSFlight engine totals (1e-6), the displayed integers
   (ceil), and the revenue per day (± 0.01, classic "/ week" normalised). Then: the result panel's
   structure + real clicks, the cost-audit line at 1/day, 3/day, 1/week, Add to network (toast,
   #netCount in Plan mode, folder entry shape, _manual stop flags, classic card after reload) and a
   Model-settings change (climb model off) that must move both shells identically. */
import fs from 'node:fs';
import path from 'node:path';
export const component = 'simulate-result';
export const module = 'plan';

const BETA = 'beta_alia', CH = 'dc_320';
/** "1:12h" (v2 travel tile) · "1h12min" / "1h 12min" / "2h" (classic stacked fmtDuration) · "43min" / "43 min" → minutes. */
const toMin = s => {
  s = String(s == null ? '' : s).replace(/\s+/g, ''); let m;
  if ((m = s.match(/^(\d+):(\d\d)h?$/))) return +m[1] * 60 + +m[2];
  let t = 0, hit = false;
  if ((m = s.match(/(\d+)h/))) { t += +m[1] * 60; hit = true; }
  if ((m = s.match(/(\d+)min/))) { t += +m[1]; hit = true; }
  return hit ? t : NaN;
};
/** kWh shown: "57kWh" → 57; the classic switches to "1.23MWh" ≥ 1000 kWh (never for the Beta routes here). */
const kwhShown = s => { const n = (String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/) || [NaN])[0]; return /MWh/.test(String(s)) ? +n * 1000 : +n; };
const rateOf = s => { const m = String(s || '').match(/€\s*(\d+(?:\.\d+)?)/); return m ? +m[1] : NaN; };
const canon = v => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const diffPaths = (a, b, p = '', out = []) => {
  if (out.length > 12 || a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') { out.push(`${p || '/'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], p + '/' + k, out);
  return out;
};
const f2 = v => Number.isFinite(v) ? +v.toFixed(3) : v;

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  const classic = await ctx.classicPage(v2.browser);
  // Record every /api/simulate payload each shell sends (window.__cns.payloads) so a response diff can be explained.
  const HOOK = `(function(){ if (window.__cns && !__cns.fetchHooked) { __cns.fetchHooked = true; __cns.payloads = []; const f = window.fetch; window.fetch = function (u, o) { try { if (String(u).includes('/api/simulate') && o && o.body) __cns.payloads.push(JSON.parse(o.body)); } catch (e) {} return f.apply(this, arguments); }; } return true; })()`;
  await v2.eval(HOOK); await classic.eval(HOOK);
  const dump = (name, obj) => { const f = path.join(ctx.out, name + '.json'); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; };
  const lastPayload = p => p.eval(`((window.__cns && __cns.payloads) || []).at(-1) || null`);

  /** Put the v2 form into a known state (S.*), back on the form rail — the Simulate button is a real click later. */
  const v2Route = cfg => v2.eval(`(function(){ const S = CNSUI.S, by = CNSUI.byId(), F = ${JSON.stringify(cfg)};
    S.origin = by[F.o] || null; S.dest = F.d ? (by[F.d] || null) : S.dest; S.stops = (F.stops || []).map(i => by[i]).filter(Boolean);
    S.planeId = F.plane; S.chargerId = F.charger; S.trip = F.trip || 'one-way'; S.freq = F.freqN || 1; S.per = F.freqUnit || 'day';
    S.picking = false; S.acFilterOpen = false; S.availOverride = null; if (S.blacklist && S.blacklist.clear) S.blacklist.clear(); S.divertOverrides = {};
    CNSUI.plan.onFormChange(false);
    return { o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, stops: S.stops.map(s => s && s.ident), planned: S.planned.stops.map(s => s.ident), closing: S.planned.closing.map(s => s.ident), trip: S.trip, plane: S.planeId, charger: S.chargerId, freq: S.freq, per: S.per, rail: S.rail, plannedError: S.planned.error }; })()`);
  const v2State = () => v2.eval(`(function(){ const S = CNSUI.S; return { rail: S.rail, mode: S.mode, o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, stops: S.stops.map(s => s && s.ident), trip: S.trip, freq: S.freq, per: S.per, plane: S.planeId, charger: S.chargerId, result: !!S.result, profile: !!S.profile }; })()`);
  /** The battery chart as rendered: circles, the "NN %" labels, charge segments (stroke #d84c26), the "lowest" label. */
  const socState = () => v2.eval(`(function(){ const d = CNSUI.plan.derive(); const svg = document.querySelector('#railBody .soc svg'); const ch = d ? d.charges.map(c => ({ at: c.atIndex, ident: c.ident, kwh: +(+c.energyKwh || 0).toFixed(2), role: c.role })) : [];
    if (!svg) return { present: false, legs: d ? d.legs.length : null, charges: ch };
    const vals = [...svg.querySelectorAll('text')].map(t => t.textContent.trim()).filter(t => /^-?\\d+ %/.test(t)).map(t => parseInt(t, 10));
    const chg = [...svg.querySelectorAll('path')].filter(p => p.getAttribute('stroke') === '#d84c26').length; const fly = [...svg.querySelectorAll('path')].filter(p => p.getAttribute('stroke') === '#32326E').length;
    const low = (document.querySelector('#railBody .soc .lbl .r b') || {}).textContent;
    return { present: true, legs: d.legs.length, charges: ch, circles: svg.querySelectorAll('circle').length, vals, chgSegs: chg, flySegs: fly, low: parseInt(low, 10), lowTxt: (document.querySelector('#railBody .soc .lbl .r') || {}).textContent || '' }; })()`);

  // ---------------------------------------------------------------------------------------------
  /** Drive both shells with the same inputs, simulate with REAL clicks, compare. Returns the evidence object; throws on any mismatch. */
  async function parity(label, cfg) {
    const cset = await ctx.classicSetRoute(classic, { o: cfg.o, d: cfg.d, stops: cfg.stops || [], plane: cfg.plane, charger: cfg.charger, trip: cfg.trip, freqN: cfg.freqN || 1, freqUnit: cfg.freqUnit || 'day' });
    const c = await ctx.classicSimulate(classic);
    const cPayload = await lastPayload(classic);
    const cPlanned = await classic.eval(`({ planned: plannedStops.map(s => s.ident), closing: (typeof closingStops !== 'undefined' ? closingStops : []).map(s => s.ident) })`);
    const vset = await v2Route(cfg);
    const since = v2.responses.length;
    const v = await ctx.v2Simulate(v2);
    const resp = await v2.waitForResponse('/api/simulate', { since, method: 'POST', timeout: 5000 }).catch(() => null);
    const vPayload = await lastPayload(v2);
    const soc = await socState();
    await ctx.screenshot(v2, label); await ctx.screenshot(classic, label + '-classic');
    const fails = [];
    if (cset.warnings && cset.warnings.some(w => !/Cannot access 'plane' before initialization/.test(w))) fails.push('classicSetRoute warnings: ' + cset.warnings.join('; '));
    if (c.error) fails.push('classic error: ' + c.error);
    if (v.err) fails.push('v2 error: ' + v.err);
    // (training ignores stops in both shells — the classic keeps hidden stop fields, v2 plans none)
    if (cfg.trip !== 'training' && JSON.stringify(cPlanned.planned) !== JSON.stringify(vset.planned)) fails.push(`planned stops: classic ${JSON.stringify(cPlanned.planned)} vs v2 ${JSON.stringify(vset.planned)}`);
    const ev = { cfg, cset, vset, cPlanned, cPayload, vPayload, payloadDiff: diffPaths(canon(cPayload), canon(vPayload)), respStatus: resp && resp.status, cApi: c.api, vApi: v.api, cEngine: c.engine, vEngine: v.engine, cShown: c.shown, vShown: v.shown, soc, fails };
    if (!c.error && !v.err) {
      ev.apiDiff = diffPaths(canon(ctx.stripApi(c.api)), canon(ctx.stripApi(v.api)));
      if (ev.apiDiff.length) fails.push('API differs: ' + ev.apiDiff.slice(0, 6).join('; '));
      const eng = { used: [c.engine.energyUsedKwh, v.engine.used], flightMin: [c.engine.flightMin, v.engine.flyMin], chargeMin: [c.engine.chargeMin, v.engine.chargeMin], travelMin: [c.engine.flightMin + c.engine.enRouteMin, v.engine.travelMin] };
      ev.engine = eng;
      for (const [k, [a, b]] of Object.entries(eng)) if (!ctx.close(a, b, 1e-6)) fails.push(`engine ${k}: classic ${a} vs v2 ${b}`);
      ev.chargedVsUsed = { charged: v.engine.charged, used: v.engine.used };
      const shown = { energyKwh: [kwhShown(c.shown.hlUsed), kwhShown(v.shown.stats[0])], travelMin: [toMin(c.shown.hlFlight), toMin(v.shown.stats[1])], chargeMin: [toMin(c.shown.hlTime), toMin(v.shown.stats[2])] };
      ev.shown = shown;
      for (const [k, [a, b]] of Object.entries(shown)) if (!(Number.isFinite(a) && a === b)) fails.push(`shown ${k}: classic ${a} vs v2 ${b}`);
      const cRevDay = ctx.num(c.shown.hlRevenue) / (/week/.test(c.shown.hlRevenue) ? 7 : 1), vRevDay = ctx.num(v.shown.cost);
      ev.revenueDay = { classic: cRevDay, v2: vRevDay, classicText: c.shown.hlRevenue, v2Text: v.shown.cost };
      if (!ctx.close(cRevDay, vRevDay, 0.01)) fails.push(`revenue/day: classic ${cRevDay} ("${c.shown.hlRevenue}") vs v2 ${vRevDay} ("${v.shown.cost}")`);
    }
    const file = dump(label, ev);
    const summary = `classic ${c.error ? 'ERR ' + c.error : `used ${f2(c.engine.energyUsedKwh)} kWh · fly ${f2(c.engine.flightMin)} · charge ${f2(c.engine.chargeMin)} min · ${c.shown.hlUsed}/${c.shown.hlFlight}/${c.shown.hlTime} · ${c.shown.hlRevenue}`} | v2 ${v.err ? 'ERR ' + v.err : `used ${f2(v.engine.used)} · fly ${f2(v.engine.flyMin)} · charge ${f2(v.engine.chargeMin)} · ${v.shown.stats.join('/')} · ${v.shown.cost}`} | stops classic ${JSON.stringify(cPlanned.planned)} v2 ${JSON.stringify(vset.planned)} | POST ${resp && resp.status}`;
    if (fails.length) throw new Error(fails.join(' || ') + ' — ' + summary + ' — ' + file);
    return { detail: summary, repro: `both shells: ${JSON.stringify(cfg)} → Simulate (real click)`, evidence: [file, ctx.shot(label), ctx.shot(label + '-classic')] };
  }
  const socCheck = (name, opts = {}) => ctx.check(name, async () => {
    const s = await socState(); const fails = [];
    if (!s.present) throw new Error('no .soc svg in the result rail (legs ' + s.legs + ')');
    if (s.circles !== s.legs + 1) fails.push(`${s.circles} circles for ${s.legs} leg(s) (want legs+1 = ${s.legs + 1})`);
    if (s.vals.length !== s.legs + 1) fails.push(`${s.vals.length} "NN %" labels for ${s.legs} leg(s)`);
    if (s.vals.some(x => !(x >= 0 && x <= 100))) fails.push('SoC label out of 0..100: ' + JSON.stringify(s.vals));
    if (!(s.low >= 0 && s.low <= 100)) fails.push('lowest label out of 0..100: ' + s.lowTxt);
    const drawable = s.charges.filter(c => c.kwh > 0.05).length;
    if (opts.expectCharge !== false && drawable && s.chgSegs < drawable) {
      // control: the same series with every charge's atIndex shifted by one — if THAT draws the segment, the index convention is the cause
      const ctl = await v2.eval(`(function(){ const d = CNSUI.plan.derive(); const p = CNSUI.plane(); const climb = CNSFlight.climbParams(p); const mk = ch => CNSUI.soc.series(d.legs, ch, p.battery_kwh || 1, climb, { training: d.training }).segs.filter(s => s.t === 'chg').length; return { asIs: mk(d.charges), atIndexPlus1: mk(d.charges.map(c => Object.assign({}, c, { atIndex: c.atIndex + 1 }))), atIndexes: d.charges.map(c => c.atIndex), tableRows: document.querySelectorAll('#railBody .acc[data-acc=charging] .pane tr').length - 1 }; })()`);
      fails.push(`${s.chgSegs} charge segment(s) drawn for ${drawable} charge(s) > 0.05 kWh (${s.charges.map(c => c.ident + '@' + c.at + ':' + c.kwh).join(', ')}); the Charging table lists ${ctl.tableRows} row(s); control: CNSUI.soc.series draws ${ctl.asIs} charge seg(s) with the engine's atIndex ${JSON.stringify(ctl.atIndexes)} and ${ctl.atIndexPlus1} with atIndex+1`);
    }
    const detail = `legs ${s.legs} · circles ${s.circles} · labels ${JSON.stringify(s.vals)} · charge segs ${s.chgSegs} for ${JSON.stringify(s.charges)} · ${s.lowTxt}`;
    if (fails.length) throw new Error(fails.join(' || ') + ' — ' + detail);
    return detail;
  });

  // ---- 1. one-way EHLE → EDDF ------------------------------------------------------------------
  const ONE = { o: 'EHLE', d: 'EDDF', plane: BETA, charger: CH, trip: 'one-way', freqN: 1, freqUnit: 'day' };
  await ctx.check('one-way-parity', () => parity('one-way', ONE));
  await socCheck('soc-chart-one-way');

  // ---- 2. result panel: structure, battery chart, accordions on REAL clicks, Edit keeps the form -----
  await ctx.check('result-panel', async () => {
    const st = await v2.eval(`(function(){ const q = s => document.querySelectorAll(s).length; const d = CNSUI.plan.derive(); const stats = [...document.querySelectorAll('#railBody .stats > div')].map(e => (e.querySelector('.cap') || {}).textContent + '=' + (e.querySelector('.v') || {}).textContent);
      return { rail: CNSUI.S.rail, tiles: q('#railBody .stats > div'), stats, cost: q('#railBody .cost'), costV: (document.querySelector('#railBody .cost .v') || {}).textContent, split: q('#railBody .split'), splitLg: (document.querySelector('#railBody .split .lg') || {}).textContent, soc: q('#railBody .soc svg'), accs: [...document.querySelectorAll('#railBody .acc')].map(a => a.dataset.acc + ':' + (a.classList.contains('open') ? 'open' : 'closed')), edit: q('#railBody [data-act=edit]'), add: q('#railFoot [data-act=add]'), legs: d.legs.length, nan: /NaN|undefined/.test(document.getElementById('railBody').textContent) }; })()`);
    const fails = [];
    if (st.rail !== 'result') fails.push('rail ' + st.rail);
    if (st.tiles !== 3) fails.push(`${st.tiles} .stats tiles (want 3)`);
    if (!st.cost || !st.split || !st.soc) fails.push(`cost ${st.cost} split ${st.split} soc ${st.soc}`);
    if (st.nan) fails.push('rail text contains NaN/undefined');
    if (st.accs.length !== 3) fails.push('accordions: ' + st.accs.join(','));
    const soc = await socState();
    if (soc.circles !== soc.legs + 1) fails.push(`soc circles ${soc.circles} for ${soc.legs} leg(s)`);
    if (soc.vals.some(x => !(x >= 0 && x <= 100))) fails.push('soc labels ' + JSON.stringify(soc.vals));
    // accordions: real clicks toggle the pane (display none ↔ block) and S.open
    const tog = async name => { await v2.click(`#railBody .acc[data-acc=${name}]>button`); await v2.sleep(80); return v2.eval(`(function(){ const a = document.querySelector('#railBody .acc[data-acc=${name}]'); return { open: a.classList.contains('open'), display: getComputedStyle(a.querySelector('.pane')).display, state: !!CNSUI.S.open['${name}'], rows: a.querySelectorAll('.pane tr').length }; })()`); };
    const acc = { charging1: await tog('charging'), charging2: await tog('charging'), route1: await tog('route'), route2: await tog('route'), calc1: await tog('calc') };
    if (!(acc.charging1.open && acc.charging1.display === 'block' && acc.charging1.state)) fails.push('charging did not open on click: ' + JSON.stringify(acc.charging1));
    if (!(!acc.charging2.open && acc.charging2.display === 'none' && !acc.charging2.state)) fails.push('charging did not close on 2nd click: ' + JSON.stringify(acc.charging2));
    if (!(!acc.route1.open && acc.route1.display === 'none')) fails.push('route (open by default) did not close: ' + JSON.stringify(acc.route1));
    if (!(acc.route2.open && acc.route2.display === 'block')) fails.push('route did not re-open: ' + JSON.stringify(acc.route2));
    if (!(acc.calc1.open && acc.calc1.display === 'block')) fails.push('calc did not open: ' + JSON.stringify(acc.calc1));
    if (acc.charging1.rows < 2) fails.push('charging table has no rows');
    await ctx.screenshot(v2, 'result-panel');
    // Edit → back to the form with every field intact
    const before = await v2State();
    await v2.click('#railBody [data-act=edit]');
    await v2.waitFor(`CNSUI.S.rail === 'form' && !!document.querySelector('[data-ac=origin]')`, 3000);
    const form = await v2.eval(`(function(){ const S = CNSUI.S; const val = s => { const e = document.querySelector(s); return e ? e.value : null; }; const on = s => { const e = document.querySelector(s + ' button.on'); return e ? e.dataset.v : null; }; const chg = document.querySelector('#railBody .chg.on');
      return { rail: S.rail, originInput: val('[data-ac=origin]'), originIcao: (document.querySelector('[data-ac=origin] + .icao') || {}).textContent, destInput: val('[data-ac=dest]'), destIcao: (document.querySelector('[data-ac=dest] + .icao') || {}).textContent, trip: on('[data-seg=trip]'), freq: val('[data-act=freq]'), per: on('[data-seg=per]'), charger: chg ? chg.dataset.id : null, plane: S.planeId, o: S.origin && S.origin.ident, d: S.dest && S.dest.ident, stops: S.stops.map(s => s && s.ident), result: !!S.result, simulateBtn: !!document.querySelector('#railFoot [data-act=simulate]'), originName: S.origin.name, destName: S.dest.name }; })()`);
    const after = await v2State();
    for (const k of ['o', 'd', 'trip', 'freq', 'per', 'plane', 'charger']) if (before[k] !== after[k]) fails.push(`edit changed S.${k}: ${before[k]} → ${after[k]}`);
    if (form.rail !== 'form' || !form.simulateBtn) fails.push('edit did not return to the form: ' + JSON.stringify({ rail: form.rail, simulateBtn: form.simulateBtn }));
    if (form.originInput !== form.originName || form.originIcao !== 'EHLE') fails.push(`departure field "${form.originInput}"/${form.originIcao}`);
    if (form.destInput !== form.destName || form.destIcao !== 'EDDF') fails.push(`destination field "${form.destInput}"/${form.destIcao}`);
    if (form.trip !== 'one-way' || form.freq !== '1' || form.per !== 'day' || form.charger !== CH) fails.push(`form controls: trip ${form.trip} freq ${form.freq} per ${form.per} charger ${form.charger}`);
    await ctx.screenshot(v2, 'result-panel-edit');
    const file = dump('result-panel', { st, soc, acc, before, form, after });
    if (fails.length) throw new Error(fails.join(' || ') + ' — ' + file);
    return { detail: `tiles ${st.stats.join(' · ')} · ${st.costV} · soc circles ${soc.circles}/${soc.legs} legs ${JSON.stringify(soc.vals)} · accordions toggled by real clicks · Edit kept ${form.originIcao}→${form.destIcao} ${form.trip} ${form.freq}/${form.per} ${form.charger}`, repro: 'v2 one-way result: count .stats tiles, click each .acc button twice, click [data-act=edit]', evidence: [file, ctx.shot('result-panel'), ctx.shot('result-panel-edit')] };
  }, { retry: 0 });

  // ---- 3. cost audit at 1/day, 3/day, 1/week (back to 1/day at the end) -------------------------
  await ctx.check('cost-audit', async () => {
    const runs = [];
    for (const [n, per] of [[1, 'day'], [3, 'day'], [1, 'week'], [1, 'day']]) {
      if (await v2.eval(`CNSUI.S.rail`) === 'result') { await v2.click('#railBody [data-act=edit]'); await v2.waitFor(`CNSUI.S.rail === 'form' && !!document.querySelector('[data-act=freq]')`, 3000); }
      await v2.setValue('[data-act=freq]', String(n), ['input', 'change']);
      await v2.click(`[data-seg=per] button[data-v=${per}]`);
      await v2.waitFor(`CNSUI.S.freq === ${n} && CNSUI.S.per === '${per}' && !!document.querySelector('#railFoot [data-act=simulate]')`, 3000);
      const v = await ctx.v2Simulate(v2);
      if (v.err) throw new Error(`v2 simulate at ${n}/${per}: ${v.err}`);
      const H = ctx.num(v.shown.cost), N = ctx.num(v.shown.costSub), R = rateOf(v.shown.costSub), fpd = per === 'day' ? n : n / 7;
      const perDay = Math.abs(N * R - H) <= 0.01, perFlight = Math.abs(N * R * fpd - H) <= 0.01;
      const calc = await v2.eval(`(function(){ const p = document.querySelector('#railBody .acc[data-acc=calc] .pane'); return p ? [...p.children].map(e => e.textContent.trim()).find(t => /^Cost/.test(t)) || '' : ''; })()`);
      await classic.setValue('#freqN', String(n), ['input', 'change']); await classic.setValue('#freqUnit', per, ['change']);
      const c = await ctx.classicSimulate(classic);
      if (c.error) throw new Error(`classic simulate at ${n}/${per}: ${c.error}`);
      const cRev = ctx.num(c.shown.hlRevenue), cUnit = /week/.test(c.shown.hlRevenue) ? 'week' : 'day', cDay = cRev / (cUnit === 'week' ? 7 : 1);
      const cN = ctx.num(c.shown.hlRevenueSub), cR = rateOf(c.shown.hlRevenueSub), cMul = +((c.shown.hlRevenueSub.match(/(\d+)×/) || [0, 1])[1]);
      const cAudit = Math.abs(cN * cR * cMul - cRev) <= 0.01;
      runs.push({ n, per, fpd, v2: { headline: v.shown.cost, sub: v.shown.costSub, calcLine: calc, H, N, R, NxR: +(N * R).toFixed(4), NxRxFpd: +(N * R * fpd).toFixed(4), auditPerDay: perDay, auditPerFlight: perFlight, engineCharged: v.engine.charged, engineUsed: v.engine.used }, classic: { headline: c.shown.hlRevenue, sub: c.shown.hlRevenueSub, cRev, cUnit, cDay: +cDay.toFixed(4), cN, cR, cMul, audit: cAudit }, parityDay: Math.abs(cDay - H) <= 0.01 });
      await ctx.screenshot(v2, `cost-${n}-${per}`);
    }
    const file = dump('cost-audit', runs);
    const bad = runs.filter(r => !(r.v2.auditPerDay || r.v2.auditPerFlight) || !r.parityDay || !r.classic.audit);
    const line = r => `${r.n}/${r.per}: v2 "${r.v2.headline}" sub "${r.v2.sub}" → N×r=${r.v2.NxR.toFixed(2)}, N×r×fpd=${r.v2.NxRxFpd.toFixed(2)} (${r.v2.auditPerDay || r.v2.auditPerFlight ? 'audits' : 'DOES NOT AUDIT'}); classic "${r.classic.headline}" = ${r.classic.cDay.toFixed(2)}/day (${r.classic.audit ? 'audits' : 'does not audit'}); day parity ${r.parityDay ? 'ok' : 'FAIL'}`;
    if (bad.length) throw new Error(bad.map(line).join(' || ') + ' — ' + file);
    return { detail: runs.map(line).join(' || '), repro: 'v2: Edit → freq input + per segment → Simulate; read .cost .v and .cost .m; classic #freqN/#freqUnit → Simulate', evidence: [file, ...runs.map(r => ctx.shot(`cost-${r.n}-${r.per}`))] };
  }, { retry: 0 });

  // ---- 4. a Model-settings change moves both shells identically (climb model off, then restored) ----
  await ctx.check('settings-effect', async () => {
    const readV2 = () => v2.eval(`(function(){ const d = CNSUI.plan.derive(); const t = document.querySelector('#railBody .stats .v'); return { used: d ? d.used : null, shown: t ? t.textContent.trim() : null, rail: CNSUI.S.rail, climb: CNSSettings.loadAll().climbModel.enabled, badge: !document.getElementById('setBadge').hidden }; })()`);
    const readClassic = () => classic.eval(`(function(){ const bd = _breakdownFromProfile(_engineProfile(lastResult)); return { used: bd ? bd.energyUsedKwh : null, shown: document.getElementById('hlUsed').textContent.trim(), climb: CNSSettings.loadAll().climbModel.enabled }; })()`);
    ctx.cleanup(async () => { for (const p of [v2, classic]) await p.eval(`CNSSettings.save({ climbModel: { enabled: true } }); true`).catch(() => {}); });
    const b1 = await readV2(), b2 = await readClassic();
    await v2.eval(`CNSSettings.save({ climbModel: { enabled: false } }); true`); await v2.sleep(400);
    const a1 = await readV2(); const a2auto = await readClassic();           // the classic engine reads localStorage; its DISPLAY only re-renders on its own save
    await classic.eval(`CNSSettings.save({ climbModel: { enabled: false } }); true`); await classic.sleep(400);
    const a2 = await readClassic();
    await ctx.screenshot(v2, 'settings-climb-off'); await ctx.screenshot(classic, 'settings-climb-off-classic');
    await v2.eval(`CNSSettings.save({ climbModel: { enabled: true } }); true`); await classic.eval(`CNSSettings.save({ climbModel: { enabled: true } }); true`); await v2.sleep(400);
    const r1 = await readV2(), r2 = await readClassic();
    const fails = [];
    if (!ctx.close(b1.used, b2.used, 1e-6)) fails.push(`before: v2 ${b1.used} vs classic ${b2.used}`);
    if (!(a1.used < b1.used - 1e-6)) fails.push(`v2 energy did not drop: ${b1.used} → ${a1.used}`);
    if (!(a2.used < b2.used - 1e-6)) fails.push(`classic energy did not drop: ${b2.used} → ${a2.used}`);
    if (!ctx.close(a1.used, a2.used, 1e-6)) fails.push(`after: v2 ${a1.used} vs classic ${a2.used}`);
    if (kwhShown(a1.shown) !== kwhShown(a2.shown)) fails.push(`shown after: v2 "${a1.shown}" vs classic "${a2.shown}"`);
    if (a1.rail !== 'result') fails.push('v2 left the result rail: ' + a1.rail);
    if (!a1.badge) fails.push('settings badge not shown while a non-default flag is active');
    if (!ctx.close(r1.used, b1.used, 1e-6) || !ctx.close(r2.used, b2.used, 1e-6)) fails.push(`restore: v2 ${r1.used} (was ${b1.used}) classic ${r2.used} (was ${b2.used})`);
    const file = dump('settings-effect', { b1, b2, a1, a2auto, a2, r1, r2 });
    if (fails.length) throw new Error(fails.join(' || ') + ' — ' + file);
    return { detail: `climb off: v2 ${f2(b1.used)} → ${f2(a1.used)} kWh ("${b1.shown}" → "${a1.shown}"), classic ${f2(b2.used)} → ${f2(a2.used)} ("${b2.shown}" → "${a2.shown}"); classic engine after the v2 save alone: ${f2(a2auto.used)} (display "${a2auto.shown}"); restored ${f2(r1.used)} / ${f2(r2.used)}`, repro: 'CNSSettings.save({climbModel:{enabled:false}}) in each tab with the one-way result open', evidence: [file, ctx.shot('settings-climb-off'), ctx.shot('settings-climb-off-classic')] };
  }, { retry: 0 });

  // ---- 5. return EHLE ⇄ EDDF -------------------------------------------------------------------
  await ctx.check('retour-parity', () => parity('retour', { o: 'EHLE', d: 'EDDF', plane: BETA, charger: CH, trip: 'retour', freqN: 1, freqUnit: 'day' }));
  await socCheck('soc-chart-retour');

  // ---- 6. multi-leg EHLE → EDDM (auto-planned stop) and with an operator stop at EDDF ------------
  await ctx.check('multi-parity', () => parity('multi', { o: 'EHLE', d: 'EDDM', plane: BETA, charger: CH, trip: 'one-way', freqN: 1, freqUnit: 'day' }));
  await socCheck('soc-chart-multi');
  await ctx.check('multi-manual-parity', () => parity('multi-manual', { o: 'EHLE', d: 'EDDM', stops: ['EDDF'], plane: BETA, charger: CH, trip: 'one-way', freqN: 1, freqUnit: 'day' }));

  // ---- 7. Add to network from the multi-manual result --------------------------------------------
  await ctx.check('add-to-network', async () => {
    const preRead = () => v2.eval(`({ rail: CNSUI.S.rail, mode: CNSUI.S.mode, folder: CNSDemand.loadFolder().length, chain: CNSUI.chain().map(a => a.ident), netCount: document.getElementById('netCount').textContent, manual: CNSUI.S.planned.stops.filter(s => s._manual).map(s => s.ident) })`);
    let pre = await preRead();
    if (pre.rail !== 'result' || pre.chain.join('>') !== 'EHLE>EDDF>EDDM') {   // standalone (--only add-): build the multi-manual result first
      await v2Route({ o: 'EHLE', d: 'EDDM', stops: ['EDDF'], plane: BETA, charger: CH, trip: 'one-way', freqN: 1, freqUnit: 'day' });
      const v = await ctx.v2Simulate(v2); if (v.err) throw new Error('precondition simulate: ' + v.err); pre = await preRead();
    }
    if (pre.rail !== 'result') throw new Error('precondition: v2 is not on a result (rail ' + pre.rail + ')');
    await v2.click('#railFoot [data-act=add]');
    const toast = await v2.waitFor(`(function(){ const t = document.getElementById('toast'); return t.classList.contains('show') ? t.textContent : ''; })()`, 2500).catch(() => '');
    const post = await v2.eval(`(function(){ const S = CNSUI.S; const f = CNSDemand.loadFolder(); const e = f[f.length - 1] || null;
      return { mode: S.mode, rail: S.rail, netCount: document.getElementById('netCount').textContent, folderLen: f.length, keys: e ? Object.keys(e) : [], entry: e && { id: e.id, tripType: e.tripType, originIdent: e.originIdent, destIdent: e.destIdent, originLat: e.originLat, originLon: e.originLon, destLat: e.destLat, destLon: e.destLon, range_km: e.range_km, battery: e.battery, speed_kmh: e.speed_kmh, planeId: e.planeId, chargerId: e.chargerId, chargerPower: e.chargerPower, freqN: e.freqN, freqUnit: e.freqUnit, fleetMode: e.fleetMode, multiLeg: e.multiLeg, stops: (e.stops || []).map(s => ({ ident: s.ident, _manual: s._manual, _auto: s._auto })), charges: (e.charges || []).length, legs: (e.legs || []).length } }; })()`);
    ctx.state.added = Object.assign({ toast, pre }, post);
    await ctx.screenshot(v2, 'add-to-network');
    await classic.reload({ boot: 'classic' }); await classic.eval(HOOK);
    let cards = []; try { cards = JSON.parse(await classic.waitFor(`(function(){ const c = [...document.querySelectorAll('#folder [data-dest]')].map(e => e.dataset.dest); return c.length ? JSON.stringify(c) : ''; })()`, 8000)); } catch (e) {}
    const cl = await classic.eval(`(function(){ const id = ${JSON.stringify(post.entry && post.entry.id)}; return { folder: CNSDemand.loadFolder().length, row: !!document.querySelector('#folder [data-edit="' + id + '"]'), sub: (document.getElementById('drawerSub') || {}).textContent, exceptions: 0 }; })()`);
    await ctx.screenshot(classic, 'add-to-network-classic');
    const fails = []; const e = post.entry;
    if (!/added/i.test(toast)) fails.push('no "Added …" toast (got "' + toast + '")');
    if (post.mode !== 'plan') fails.push('mode switched to ' + post.mode);
    if (post.folderLen !== pre.folder + 1 || post.folderLen !== 1) fails.push(`folder length ${pre.folder} → ${post.folderLen}`);
    if (!e) fails.push('no folder entry'); else {
      if (!e.id) fails.push('entry has no id');
      for (const k of ['originLat', 'originLon', 'destLat', 'destLon', 'range_km', 'battery', 'speed_kmh']) if (!Number.isFinite(e[k])) fails.push(`entry.${k} = ${e[k]}`);
      if (e.originIdent !== 'EHLE' || e.destIdent !== 'EDDM' || e.planeId !== BETA || e.chargerId !== CH || e.freqN !== 1 || e.freqUnit !== 'day') fails.push('entry route/plane/charger/freq: ' + JSON.stringify({ o: e.originIdent, d: e.destIdent, p: e.planeId, c: e.chargerId, f: e.freqN, u: e.freqUnit }));
      if (!e.multiLeg || e.stops.length < 1 || !e.legs || !e.charges) fails.push('multi-leg fields: ' + JSON.stringify({ multiLeg: e.multiLeg, stops: e.stops, legs: e.legs, charges: e.charges }));
    }
    for (const id of pre.chain) if (!cards.includes(id)) fails.push(`classic has no card for ${id} after reload (cards ${JSON.stringify(cards)})`);
    if (!cl.row) fails.push('classic folder has no row [data-edit=' + (e && e.id) + ']');
    const file = dump('add-to-network', { pre, toast, post, classic: Object.assign({ cards }, cl) });
    if (fails.length) throw new Error(fails.join(' || ') + ' — ' + file);
    return { detail: `toast "${toast}" · folder ${post.folderLen} · entry ${e.id} ${e.originIdent}→${e.destIdent} via ${e.stops.map(s => s.ident + (s._manual ? '(manual)' : s._auto ? '(auto)' : '')).join(',')} · classic cards ${JSON.stringify(cards)} row ${cl.row} · "${cl.sub}"`, repro: 'v2: EHLE → EDDF (operator stop) → EDDM one-way, Simulate, real click [data-act=add]; reload the classic tab', evidence: [file, ctx.shot('add-to-network'), ctx.shot('add-to-network-classic')] };
  }, { retry: 0 });
  await ctx.check('add-netcount-plan-mode', async () => {
    const a = ctx.state.added; if (!a || !a.entry) throw new Error('add-to-network did not add a flight');
    const now = await v2.eval(`({ mode: CNSUI.S.mode, netCount: document.getElementById('netCount').textContent, folder: CNSDemand.loadFolder().length })`);
    // control: the same read after a mode round-trip (network.js render writes #netCount)
    const ctl = await v2.eval(`(function(){ CNSUI.setMode('network'); const n = document.getElementById('netCount').textContent; CNSUI.setMode('plan'); return { afterSwitch: n, backInPlan: document.getElementById('netCount').textContent, mode: CNSUI.S.mode }; })()`);
    await v2.waitForMapIdle(6000).catch(() => {});
    const detail = `#netCount right after Add (Plan mode) = "${a.netCount}", later = "${now.netCount}" with ${now.folder} flight(s); control after setMode('network') = "${ctl.afterSwitch}", back in Plan = "${ctl.backInPlan}"`;
    if (a.netCount !== '1') throw new Error(detail + ' — the Network button count is not written in Plan mode (network.js:79 sets it only inside the Network render)');
    return detail;
  }, { retry: 0 });
  await ctx.check('add-manual-stop-flags', async () => {
    const a = ctx.state.added; if (!a || !a.entry) throw new Error('add-to-network did not add a flight');
    const m = a.entry.stops.find(s => s.ident === 'EDDF');
    const detail = `planned manual stops before Add: ${JSON.stringify(a.pre.manual)}; saved stops: ${JSON.stringify(a.entry.stops)}`;
    if (!m) throw new Error('EDDF is not in the saved stops — ' + detail);
    if (m._manual !== true) throw new Error(`the operator stop EDDF was saved without _manual (${JSON.stringify(m)}) — the classic wraps d.stops in CNSRecompute.mergeManualFlags(d.stops, plannedStops) (index.html:5892); a settings recompute may now re-plan it away — ` + detail);
    return detail;
  }, { retry: 0 });
  await ctx.check('add-manual-stop-survives-recompute', async () => {
    const a = ctx.state.added; if (!a || !a.entry) throw new Error('add-to-network did not add a flight');
    // control: the SAME flight added from the classic (index.html addFolder) — its EDDF must carry _manual …
    const cset = await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDM', stops: ['EDDF'], plane: BETA, charger: CH, trip: 'one-way', freqN: 1, freqUnit: 'day' });
    const c = await ctx.classicSimulate(classic); if (c.error) throw new Error('classic simulate: ' + c.error);
    const cAdd = await classic.eval(`(function(){ const before = CNSDemand.loadFolder().length; document.getElementById('addFolder').click(); const f = CNSDemand.loadFolder(); const e = f[f.length - 1]; return { before, after: f.length, id: e.id, stops: (e.stops || []).map(s => ({ ident: s.ident, _manual: s._manual, _auto: s._auto })) }; })()`);
    // … and survive a recompute (what any Model-settings change triggers in either shell); the flagless v2 entry is re-planned from scratch
    const rec = await v2.eval(`(function(){ CNSUI.network.recomputeAll(); return CNSDemand.loadFolder().map(e => ({ id: e.id, feasible: e.feasible, stops: (e.stops || []).map(s => ({ ident: s.ident, _manual: s._manual, _auto: s._auto })) })); })()`);
    const v2e = rec.find(e => e.id === a.entry.id), cle = rec.find(e => e.id === cAdd.id);
    const fails = [];
    if (!cAdd.stops.some(s => s.ident === 'EDDF' && s._manual === true)) fails.push('control failed: the classic-added entry has no _manual EDDF: ' + JSON.stringify(cAdd.stops));
    if (!cle || !cle.stops.some(s => s.ident === 'EDDF')) fails.push('control failed: the classic-added entry lost EDDF after the recompute: ' + JSON.stringify(cle && cle.stops));
    if (!v2e || !v2e.stops.some(s => s.ident === 'EDDF')) fails.push(`the v2-added entry lost its operator stop EDDF after a recompute (saved as ${JSON.stringify(a.entry.stops)}, now ${JSON.stringify(v2e && v2e.stops)})`);
    const file = dump('manual-stop-recompute', { v2Entry: a.entry, classicSet: cset, classicAdd: cAdd, afterRecompute: rec });
    const detail = `v2 entry stops saved ${JSON.stringify(a.entry.stops)} → after recompute ${JSON.stringify(v2e && v2e.stops)}; classic-added entry ${JSON.stringify(cAdd.stops)} → ${JSON.stringify(cle && cle.stops)}`;
    if (fails.length) throw new Error(fails.join(' || ') + ' — ' + detail + ' — ' + file);
    return { detail, repro: 'add EHLE→EDDF(manual)→EDDM from v2 and from the classic, then CNSUI.network.recomputeAll()', evidence: [file] };
  }, { retry: 0 });

  // ---- 8. training: Velis at EHLE --------------------------------------------------------------
  await ctx.check('training-parity', () => parity('training', { o: 'EHLE', plane: 'pipistrel_velis', charger: 'dc_22', trip: 'training', freqN: 1, freqUnit: 'day' }));
  await socCheck('soc-chart-training');

  // ---- 9. zero exceptions in v2 (classic: minus its documented pre-existing one) -------------------
  await ctx.check('no-exceptions', async () => {
    const ex = v2.exceptions(), cx = ctx.exceptions(classic);
    if (ex.length || cx.length) throw new Error(`v2: ${ex.map(e => e.text).join(' || ') || '-'}; classic: ${cx.map(e => e.text).join(' || ') || '-'}`);
    return `v2 errors ${v2.errors.length} (exceptions 0) · classic errors ${classic.errors.length} (known-classic filtered: ${classic.exceptions().length - cx.length})`;
  }, { retry: 0 });
}
