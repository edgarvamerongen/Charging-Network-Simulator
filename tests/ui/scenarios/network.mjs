/* Network ledger (v2 Network mode) against the classic demand calculator (index.html renderFolder).
   Seeds 3 flights through the v2 plan path, then drives the ledger with REAL clicks: header, per-airport
   parity with the classic tab (scheduler summary, contribs, card integers, revenue day/year, grid factor),
   expand, charger slots, charge target, frequency, the edit / replay dialogs, isolation, remove + clear,
   scenarios, PDF + XLSX. Server-side state created here: one custom charger named UI-TEST-r1-0904-… (deleted
   in cleanup). Never touches the tour.
   Seed note: the brief's EHLE→EHRD Velis leg is 91.8 km great-circle against an 87.5 km range — neither shell
   routes it direct (v2 planner: "1 leg exceeds the aircraft's range"), so the seed falls back to the first
   Velis-reachable large/medium destination in [EHRD, EHAM, EHHV] and records which one it used. */
export const component = 'network';
export const module = 'network';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const RUN = 'UI-TEST-r1-0904-net';
const J = v => JSON.stringify(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, what) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
const HEAD_RE = /(\d+(?:\.\d+)?)\s+airports?\s+·\s+(\d+)\s+routes?\s+·\s+(\d+(?:\.\d+)?)\s+flights?\s*\/\s*day/;
const BAD_TEXT = /\bNaN\b|undefined|\bnull\b|Infinity/;
const fpdOf = t => t.freqUnit === 'week' ? t.freqN / 7 : t.freqN;
const fmtFlights = n => n % 1 ? +n.toFixed(1) : n;
// The classic prints integers through CNSUnits.num (ceil → en-US grouping) and switches to 2-decimal MW/MWh at ≥ 1000.
const classicVal = txt => { const s = String(txt || ''); const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/); if (!m) return { v: NaN, approx: false }; const v = parseFloat(m[0]); return /M(W|Wh)\b/.test(s) ? { v: v * 1000, approx: true } : { v, approx: false }; };
const sameNum = (cls, v2) => cls.approx ? Math.abs(cls.v - v2) <= 10 : cls.v === v2;

// ---- in-page snippets (v2) --------------------------------------------------------------
const V2_ROWS = `CNSUI.network.rows().map(a => ({ ident: a.ident, flights: a.flights, kwh: a.kwh, peak: a.peak, chargeMin: a.chargeMin, latestEnd: a.latestEnd, fleetIds: a.fleetIds, contribs: a.contribs.length, trips: a.trips.length, targetSoc: a.targetSoc, rKwh: CNSUI.fmt.r(a.kwh), rPeak: CNSUI.fmt.r(a.peak) }))`;
const V2_HEAD = `(function(){ const sub = document.querySelector('#railBody .ph .sub'); const body = document.querySelector('#railBody'); return { sub: sub ? sub.textContent.trim() : null, aps: [...document.querySelectorAll('#railBody .ap')].map(e => e.dataset.ap), text: body ? body.textContent : '', netCount: (document.querySelector('#netCount') || {}).textContent, mode: CNSUI.S.mode, tiles: [...document.querySelectorAll('#railBody .tiles > div')].map(d => ({ cap: (d.querySelector('.cap') || {}).textContent, v: (d.querySelector('.v') || {}).textContent })) }; })()`;
const V2_STATS = ap => `(function(){ const el = document.querySelector('.ap[data-ap=${J(ap)}]'); if (!el) return null; return { st: [...el.querySelectorAll(':scope > button .st')].map(s => s.firstChild ? s.firstChild.textContent.trim() : s.textContent.trim()), stFull: [...el.querySelectorAll(':scope > button .st')].map(s => s.textContent.replace(/\\s+/g, ' ').trim()), tileKwh: (function(){ const t = el.querySelector('.pane .tiles3 > div:nth-child(2) .v'); return t ? t.textContent.replace(/\\s+/g, ' ').trim() : ''; })(), open: el.classList.contains('open'), paneDisplay: getComputedStyle(el.querySelector('.pane')).display, tiles3: [...el.querySelectorAll('.pane .tiles3 > div')].map(d => ({ cap: (d.querySelector('.cap') || {}).textContent.trim(), v: (d.querySelector('.v') || {}).textContent.trim(), s: (d.querySelector('.s') || {}).textContent.trim() })), fleetSel: el.querySelectorAll('[data-act=fleetSel]').length, fleetRm: el.querySelectorAll('[data-act=fleetRm]').length, socChip: (el.querySelector('[data-act=socToggle]') || {}).textContent, socp: !!el.querySelector('.socp') }; })()`;
const FOLDER = `CNSDemand.loadFolder().map(t => ({ id: t.id, o: t.originIdent, d: t.destIdent, plane: t.planeId, planeName: t.planeName, charger: t.chargerId, trip: t.tripType, freqN: t.freqN, freqUnit: t.freqUnit, stops: (t.stops || []).map(s => s.ident), multi: !!t.multiLeg, battery: t.battery, recharge: t.rechargeEnergy, legEnergy: t.legEnergy, feasible: t.feasible, override: t.chargerOverride || null }))`;
const CFG = `CNSDemand.loadCfg()`;
const MODAL_OPEN = sel => `!document.querySelector('#modal').hidden && !!document.querySelector(${J(sel)})`;
const MODAL_CLOSED = `document.querySelector('#modal').hidden`;
// ---- classic snippets -------------------------------------------------------------------
const CL_CARDS = `[...document.querySelectorAll('#folder [data-dest]')].map(c => ({ ident: c.dataset.dest, heroes: [...c.querySelectorAll('.agg-hero-num')].map(e => e.textContent.trim()), heroLbls: [...c.querySelectorAll('.agg-hero-lbl')].map(e => e.textContent.trim()), small: [...c.querySelectorAll('.agg-small-num')].map(e => e.textContent.trim()), fleet: c.querySelectorAll('.fleet-charger').length, fleetRemove: c.querySelectorAll('.fleet-remove').length, soc: (c.querySelector('.soc-chip strong') || {}).textContent, revSub: (c.querySelector('.agg-hero-rev .agg-hero-sub') || {}).textContent, sub: (c.querySelector('.folder-airport-sub') || {}).textContent }))`;
const CL_SUM = id => `(function(){ const s = CNSScheduler.summary(${J(id)}); const ap = (typeof computeAirports === 'function' ? computeAirports() : CNSDemand.computeAirports())[${J(id)}]; return { peakKw: s.peakKw, chargeMin: s.chargeMin, latestEnd: s.latestEnd, overflow: s.overflow, contribs: ap ? ap.contribs.length : null }; })()`;
const V2_SUM = id => `(function(){ const s = CNSScheduler.summary(${J(id)}); const ap = CNSDemand.computeAirports()[${J(id)}]; return { peakKw: s.peakKw, chargeMin: s.chargeMin, latestEnd: s.latestEnd, overflow: s.overflow, contribs: ap ? ap.contribs.length : null }; })()`;

export default async function run(ctx) {
  let v2 = await ctx.v2Page();
  let classic = null;
  // Guards the harness lacks: a native JS dialog would block Input.* forever — auto-accept and record it; bound the CDP calls.
  const dialogs = [];
  const guard = page => { const loop = () => page.once('Page.javascriptDialogOpening', 2e9).then(p => { dialogs.push({ page: page.label, type: p.type, message: p.message }); return page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }).then(loop).catch(() => {}); loop(); };
  guard(v2);
  // Chrome's own stderr (NSLog / AppKit / net spam) is the only witness of a browser-process storm — keep it as evidence.
  const stderrLog = path.join(ctx.out, 'chrome-stderr.log');
  const tapStderr = b => { try { b.proc.stderr.on('data', d => { try { fs.appendFileSync(stderrLog, `[${new Date().toISOString()} pid ${b.proc.pid}] ` + d); } catch (e) {} }); } catch (e) {} };
  tapStderr(v2.browser);
  const click = (sel, o) => withTimeout(v2.click(sel, o), 15000, 'click ' + sel);
  const press = k => withTimeout(v2.press(k), 5000, 'press ' + k);
  const shotV2 = n => withTimeout(ctx.screenshot(v2, n), 15000, 'screenshot ' + n).catch(() => null);
  const shotCl = n => classic ? withTimeout(ctx.screenshot(classic, n), 15000, 'screenshot ' + n).catch(() => null) : null;
  /** The classic has NO `storage` listener (index.html / state.js: none) — the harness README's claim does not hold, so a
      v2 write never re-renders the classic tab by itself; give it a short grace, then call renderFolder() and say so. */
  const classicSync = async (pred, ms = 300) => { try { await classic.waitFor(pred, ms, 100); return 'storage event'; } catch (e) { await classic.eval(`(function(){ renderFolder(); return true; })()`); await classic.waitFor(pred, 3000, 100); return 'renderFolder() fallback (the classic has no storage listener)'; } };
  /** Open the classic edit dialog PROPERLY: Bootstrap ignores hide() while the show transition runs, so the scenario's old
      `openFlightEdit(); _editFlightModal.hide()` left the modal open with its focus trap active (diag-focus variant A). */
  const classicEdit = (id, ap, body) => classic.evalAsync(`openFlightEdit(${J(id)}, ${J(ap)}); const m = document.getElementById('editFlightModal');
    await new Promise(r => { if (m.classList.contains('show') && getComputedStyle(m).display !== 'none') r(); else m.addEventListener('shown.bs.modal', r, { once: true }); setTimeout(r, 1500); });
    const out = await (async function(){ ${body} })();
    await new Promise(r => { m.addEventListener('hidden.bs.modal', r, { once: true }); setTimeout(r, 1500); try { _editFlightModal.hide(); } catch (e) { r(); } });
    return out;`);

  // ---- liveness + recovery -------------------------------------------------------------------------------------------
  // Runs 1 + 2 (2026-09-07) and both 09-04 runs wedged 2–3 min in: the browser process pegged at >100 % CPU, its DevTools
  // endpoint stopped answering, one renderer at 80 %, and lib.mjs's UNBOUNDED failure-path screenshot of the classic tab then
  // hung until the 10-min watchdog (no report at all). Every check is therefore preceded by a bounded liveness probe; a
  // wedge is recorded as its own failed check with process diagnostics, Chrome is relaunched and the network re-seeded so
  // the remaining checks still run. The failure path below is bounded too (lib's runs against an empty page list).
  const livePages = () => [v2, classic].filter(Boolean);
  const alive = async (page, ms = 5000) => { const s = Date.now(); try { await withTimeout(page.eval('1'), ms, 'alive'); return Date.now() - s; } catch (e) { return -1; } };
  const procDiag = b => { const pid = b && b.proc && b.proc.pid; let ps = '?'; try { ps = execSync(`ps -o %cpu=,rss=,etime= -p ${pid}`).toString().trim(); } catch (e) {} let port = '?'; try { port = fs.readFileSync(path.join(b.profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (e) {} return { pid, ps, port }; };
  const devtoolsHttp = async port => { const s = Date.now(); try { const r = await withTimeout(fetch(`http://127.0.0.1:${port}/json/version`), 3000, 'devtools'); return `HTTP ${r.status} in ${Date.now() - s} ms`; } catch (e) { return `no answer in ${Date.now() - s} ms (${e.message})`; } };
  const stderrTail = () => { try { return fs.readFileSync(stderrLog, 'utf8').slice(-1200); } catch (e) { return ''; } };
  let lastCheck = '(none)', wedges = 0;
  const wedgeDiag = async (why) => { const d = procDiag(v2.browser); const http = await devtoolsHttp(d.port); return `${why}; last completed check: ${lastCheck}; browser pid ${d.pid} [%cpu rss etime] ${d.ps}; DevTools ${http}; chrome stderr tail: ${J(stderrTail())}`; };
  const recover = async why => {
    wedges++;
    const old = v2.browser; try { await withTimeout(old.close(), 8000, 'close wedged browser'); } catch (e) { try { old.proc.kill('SIGKILL'); } catch (e2) {} }
    v2 = await ctx.v2Page(); guard(v2); tapStderr(v2.browser);
    await seed(); await toNetwork();
    if (classic) { classic = await ctx.classicPage(v2.browser); guard(classic); }
    ctx.blockedBy.push(`browser wedged (${why}) — relaunched Chrome and re-seeded before continuing`);
  };
  /** ctx.check with (1) a liveness probe before, (2) bounded failure screenshots + console harvest, (3) recovery on a wedge. */
  const check = async (name, fn, opts) => {
    if (ctx.only && !name.includes(ctx.only)) return ctx.check(name, fn, opts);
    for (const p of livePages()) { const ms = await alive(p); p._dead = ms < 0; }
    const wedged = livePages().filter(p => p._dead).map(p => p.label);
    if (wedged.length) {
      // A wedged headless Chrome is a harness/environment event, not a v2 defect: keep its diagnostics on the record but
      // let the check pass when the relaunch + re-seed succeeded (a failed recovery is the only failing outcome).
      const diag = await wedgeDiag(`${wedged.join('+')} tab(s) did not answer Runtime.evaluate within 5 s`);
      let recovered = null; try { await recover(`before ${name}`); } catch (e) { recovered = e.message || String(e); }
      const saved = ctx.pages.slice(); ctx.pages.length = 0;
      try { await ctx.check(`browser-wedge-recovered-before-${name}`, async () => { if (recovered) throw new Error(`recovery failed: ${recovered} — ${diag}`); return { detail: `relaunched Chrome and re-seeded the 3 flights — ${diag}`, repro: 'full run only (never in --only runs); see harnessGaps' }; }, { retry: 0 }); } finally { ctx.pages.push(...saved); }
    }
    const t0 = Date.now(); let extra = null, hidden = null;
    const rec = await ctx.check(name, async attempt => {
      try { return await fn(attempt); }
      catch (e) {
        extra = [];
        for (const p of livePages()) { const f = ctx.shot(name + (p.label === 'v2' ? '' : '.' + p.label)); const ms = await alive(p, 4000); if (ms < 0) { extra.push(`${p.label}: renderer/browser unresponsive — no screenshot`); continue; } try { await withTimeout(p.screenshot(f), 8000, 'screenshot'); extra.push(f); } catch (e2) { extra.push(`${p.label}: screenshot failed (${e2.message})`); } }
        for (const p of livePages()) for (const er of p.errors) if (er.t >= t0) extra.push(`${p.label} ${er.type}: ${String(er.text).slice(0, 300)}`);
        hidden = ctx.pages.slice(); ctx.pages.length = 0;
        throw e;
      }
    }, opts);
    if (hidden) { ctx.pages.push(...hidden); rec.evidence.push(...extra); }
    lastCheck = name;
    return rec;
  };
  const v2Settle = async () => { await v2.sleep(350); await v2.waitFor(`!!document.querySelector('#railBody .ph')`, 5000); };
  const toNetwork = async () => { if (await v2.eval(`CNSUI.S.mode`) !== 'network') { await click('#modeSeg [data-mode=network]'); } await v2Settle(); };
  const openRow = async ap => { const st = await v2.eval(V2_STATS(ap)); if (!st) throw new Error('no .ap row for ' + ap); if (!st.open) { await click(`.ap[data-ap=${ap}] > button`); await v2.waitFor(`document.querySelector('.ap[data-ap=${ap}]').classList.contains('open')`, 2000); } };
  const closeModal = async () => { if (await v2.eval(`!${MODAL_CLOSED}`)) { await press('Escape'); await v2.waitFor(MODAL_CLOSED, 2000); } };
  const ids = ctx.state.ids = {};

  // ================= seed via the v2 form path =================
  const SEED = [
    { o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'retour', freq: 2, per: 'day' },
    { o: 'EHLE', d: 'EHRD', plane: 'pipistrel_velis', charger: 'dc_22', trip: 'one-way', freq: 4, per: 'day', fallback: ['EHAM', 'EHHV'] },
    { o: 'EHTE', d: 'EHTE', plane: 'pipistrel_velis', charger: 'dc_22', trip: 'training', freq: 6, per: 'day' }
  ];
  const seed = async () => {
    const notes = [], results = [];
    for (const f of SEED) {
      const tries = [f.d, ...(f.fallback || [])]; let r = null;
      for (const d of tries) { r = (await ctx.seedNetwork(v2, [Object.assign({}, f, { d, fallback: undefined })]))[0]; if (!r.err && r.added === 1) { if (d !== f.d) notes.push(`${f.o}→${f.d} ${f.plane}: planner refused ("${results.at(-1)?.err || r.err || 'see log'}") → seeded ${f.o}→${d} instead`); break; } notes.push(`${f.o}→${d} ${f.plane}: ${r.err}`); results.push(r); }
      results.push(r);
    }
    const folder = await v2.eval(FOLDER);
    ids.retour = (folder.find(t => t.trip === 'retour') || {}).id; ids.oneway = (folder.find(t => t.trip === 'one-way') || {}).id; ids.training = (folder.find(t => t.trip === 'training') || {}).id;
    ctx.state.folder = folder;
    return { folder, notes, results };
  };
  await check('seed-3-flights', async () => {
    const { folder, notes } = await seed();
    if (folder.length !== 3 || !ids.retour || !ids.oneway || !ids.training) throw new Error(`folder has ${folder.length} entries (${J(folder.map(t => `${t.o}→${t.d} ${t.trip}`))}); notes: ${notes.join(' | ')}`);
    return { detail: `3 flights: ${folder.map(t => `${t.o}→${t.d} ${t.plane} ${t.trip} ${t.freqN}/${t.freqUnit}${t.multi ? ' via ' + t.stops.join(',') : ''}`).join('; ')}${notes.length ? ' — ' + notes.join(' | ') : ''}`, repro: 'ctx.seedNetwork(v2, [EHLE→EDDF beta_alia retour 2/day, EHLE→EHRD pipistrel_velis one-way 4/day (fallback EHAM, EHHV), EHTE training pipistrel_velis 6/day])' };
  }, { retry: 0 });
  if (!ids.retour && ctx.only) { await seed(); }            // --only runs still need the network
  if (!ids.retour || !ids.training) { ctx.blockedBy.push('seed-3-flights'); return; }
  const folderNow = () => v2.eval(FOLDER);
  const expFlights = async () => (await folderNow()).reduce((s, t) => s + fpdOf(t), 0);

  // The classic (the behavioural spec) in a second tab of the same profile — opened now so the Plan-mode control below can read it.
  classic = await ctx.classicPage(v2.browser); guard(classic);

  // B8 control: the topbar count must reflect the folder while still in Plan mode. Control: the classic's drawer pill
  // (#drawerSub, "— N flights across M airports") reflects the same folder without entering any mode.
  await check('netcount-plan-mode', async () => {
    const h = await v2.eval(V2_HEAD); const n = (await folderNow()).length;
    const cl = String(await classic.eval(`(document.getElementById('drawerSub') || {}).textContent || ''`)).trim();
    if (h.mode !== 'plan') throw new Error('expected plan mode, got ' + h.mode);
    if (String(h.netCount).trim() !== String(n)) throw new Error(`#netCount is "${h.netCount}" in Plan mode after ${n} adds (network.js:79 writes it only in the Network render); the classic's drawer pill reads ${J(cl)} for the same folder`);
    return `#netCount = ${h.netCount} in plan mode; classic pill ${J(cl)}`;
  }, { retry: 0 });

  // ================= ledger header =================
  await check('ledger-header', async () => {
    await toNetwork();
    const h = await v2.eval(V2_HEAD); const folder = await folderNow();
    const engineAps = await v2.eval(`Object.keys(CNSDemand.computeAirports())`);
    const m = HEAD_RE.exec(h.sub || ''); if (!m) throw new Error('header sub unparsable: ' + J(h.sub));
    const flights = +m[3], routes = +m[2], aps = +m[1]; const sumFpd = folder.reduce((s, t) => s + fpdOf(t), 0);
    const probs = [];
    if (flights !== fmtFlights(sumFpd)) probs.push(`flights ${flights} ≠ Σ flightsPerDay ${sumFpd}`);
    if (routes !== folder.length) probs.push(`routes ${routes} ≠ ${folder.length}`);
    if (aps !== engineAps.length || h.aps.length !== engineAps.length) probs.push(`airports header=${aps} rows=${h.aps.length} engine=${engineAps.length} (${engineAps.join(',')})`);
    if (BAD_TEXT.test(h.text)) probs.push('rail text contains ' + J((h.text.match(BAD_TEXT) || [])[0]));
    if (String(h.netCount).trim() !== String(folder.length)) probs.push(`#netCount "${h.netCount}"`);
    await shotV2('ledger-header');
    if (probs.length) throw new Error(probs.join('; ') + ' — sub=' + J(h.sub));
    ctx.state.aps = h.aps;
    return { detail: `sub=${J(h.sub)}; rows=${h.aps.join(',')} (engine computeAirports=${engineAps.length}; brief expected 4); tiles=${J(h.tiles)}`, repro: 'seed, click #modeSeg [data-mode=network], read #railBody .ph .sub + .ap rows', evidence: [ctx.shot('ledger-header')] };
  }, { retry: 0 });
  if (!ctx.state.aps) { await toNetwork(); ctx.state.aps = (await v2.eval(V2_HEAD)).aps; }
  const APS = ctx.state.aps;

  // ================= parity with the classic tab =================
  await check('ledger-parity-summary', async () => {
    const cards = await classic.eval(CL_CARDS);
    const probs = [];
    if (cards.length !== APS.length) probs.push(`classic renders ${cards.length} folder cards (${cards.map(c => c.ident).join(',')}) vs v2 ${APS.length} rows (${APS.join(',')})`);
    const diffs = [];
    for (const id of APS) {
      const a = await v2.eval(V2_SUM(id)), b = await classic.eval(CL_SUM(id));
      diffs.push({ id, v2: a, classic: b });
      for (const k of ['peakKw', 'chargeMin', 'latestEnd', 'contribs']) if (a[k] !== b[k]) probs.push(`${id}.${k}: v2 ${a[k]} vs classic ${b[k]}`);
    }
    await shotCl('ledger-parity.classic');
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: diffs.map(d => `${d.id}: peak ${d.v2.peakKw} kW, charge ${d.v2.chargeMin} min, ends ${d.v2.latestEnd}, contribs ${d.v2.contribs}`).join('; '), repro: 'classic tab (same profile): CNSScheduler.summary(id) + computeAirports()[id].contribs.length per airport', evidence: [ctx.shot('ledger-parity.classic')] };
  }, { retry: 0 });

  await check('ledger-parity-cards', async () => {
    const rows = await v2.eval(V2_ROWS); const cards = await classic.eval(CL_CARDS);
    const probs = [], det = [];
    for (const r of rows) {
      const c = cards.find(x => x.ident === r.ident); if (!c) { probs.push(r.ident + ' has no classic card'); continue; }
      const st = await v2.eval(V2_STATS(r.ident));
      const peakC = classicVal(c.heroes[0]), kwhC = classicVal(c.heroes[1]);
      det.push(`${r.ident}: classic peak ${c.heroes[0]} / energy ${c.heroes[1]} · v2 row ${st.st.join('|')} · fmt.r(peak)=${r.rPeak} fmt.r(kwh)=${r.rKwh}`);
      if (!sameNum(peakC, r.rPeak)) probs.push(`${r.ident} peak: classic ${c.heroes[0]} vs v2 fmt.r ${r.rPeak}`);
      if (!sameNum(kwhC, r.rKwh)) probs.push(`${r.ident} energy: classic ${c.heroes[1]} vs v2 fmt.r ${r.rKwh}`);
      // v2's megawatt rule: over 99 the figure reads in MW/MWh — two decimals below 1 MW (±5), one above (±50)
      const mwVal = txt => { const s = String(txt || ''); const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/); if (!m) return { v: NaN, tol: 0 }; const v = parseFloat(m[0]); return /M(W|Wh)\b/.test(s) ? { v: v * 1000, tol: v >= 1 ? 50 : 5 } : { v, tol: 0 }; };
      const shownKwh = mwVal(st.tileKwh), shownPeak = mwVal(st.stFull[1]);
      if (r.kwh && Math.abs(shownKwh.v - r.rKwh) > shownKwh.tol) probs.push(`${r.ident} energy tile shows ${st.tileKwh} ≠ fmt.r ${r.rKwh}`);
      if (r.peak && Math.abs(shownPeak.v - r.rPeak) > shownPeak.tol) probs.push(`${r.ident} row shows peak ${st.stFull[1]} ≠ fmt.r ${r.rPeak}`);
    }
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: det.join(' || '), repro: 'compare #folder [data-dest] .agg-hero-num[0..1] with v2 .ap .st (kWh/day, peak kW) and CNSUI.fmt.r(rows().peak|kwh)' };
  }, { retry: 0 });

  // ================= expand (real click) =================
  await check('expand', async () => {
    const before = await v2.eval(V2_STATS('EHLE'));
    if (before.open) throw new Error('EHLE already open before the click');
    await click('.ap[data-ap=EHLE] > button');
    await v2.waitFor(`document.querySelector('.ap[data-ap=EHLE]').classList.contains('open')`, 2000);
    const after = await v2.eval(V2_STATS('EHLE'));
    if (after.paneDisplay === 'none' || !after.tiles3.length) throw new Error('pane not visible: ' + J(after));
    await shotV2('expand');
    return { detail: `pane display=${after.paneDisplay}; tiles3=${J(after.tiles3)}; fleet selects=${after.fleetSel} ×=${after.fleetRm}; soc chip=${J(after.socChip)}`, repro: 'real click .ap[data-ap=EHLE] > button', evidence: [ctx.shot('expand')] };
  }, { retry: 0 });

  // ================= revenue day / year =================
  await check('revenue-day-year', async () => {
    await openRow('EHLE');
    const rd = async () => ({ v2: (await v2.eval(V2_STATS('EHLE'))).tiles3[0], cl: (await classic.eval(CL_CARDS)).find(c => c.ident === 'EHLE') });
    const y = await rd();
    const yV2 = ctx.num(y.v2.v), yCl = ctx.num(y.cl.heroes[2]);
    const probs = [];
    if (!/per year/.test(y.cl.revSub)) probs.push('classic default is not yearly: ' + y.cl.revSub);
    if (yV2 !== yCl) probs.push(`year: v2 ${y.v2.v} vs classic ${y.cl.heroes[2]} (${y.cl.revSub})`);
    await click('.ap[data-ap=EHLE] [data-act=revDay]'); await v2Settle();
    await classic.eval(`(function(){ document.querySelector('#folder [data-dest=EHLE] [data-rev-period=day]').click(); return true; })()`);
    const d = await rd();
    const dV2 = ctx.num(d.v2.v), dCl = ctx.num(d.cl.heroes[2]);
    if (!/per day/.test(d.cl.revSub)) probs.push('classic did not switch to per day: ' + d.cl.revSub);
    if (dV2 !== dCl) probs.push(`day: v2 ${d.v2.v} vs classic ${d.cl.heroes[2]}`);
    if (yV2 === dV2) probs.push('v2 revenue did not change between year and day');
    await click('.ap[data-ap=EHLE] [data-act=revYear]'); await v2Settle();
    await classic.eval(`(function(){ document.querySelector('#folder [data-dest=EHLE] [data-rev-period=year]').click(); return true; })()`);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `year: v2 ${y.v2.v} = classic ${y.cl.heroes[2]}; day: v2 ${d.v2.v} = classic ${d.cl.heroes[2]}; rate ${y.v2.s}`, repro: 'EHLE pane [data-act=revDay]/[data-act=revYear] vs classic [data-rev-period]' };
  }, { retry: 0 });

  // ================= charger-efficiency (grid) factor =================
  await check('energy-grid-factor', async () => {
    await openRow('EHLE');
    const off = await v2.eval(V2_ROWS);
    await v2.eval(`(function(){ CNSSettings.save({ chargerEfficiency: { enabled: true, value: 0.88 } }); return true; })()`);
    await v2.sleep(700); await v2Settle();
    const mul = await v2.eval(`CNSSettings.gridDemandFactor()`);
    const how = await classicSync(`(function(){ const c = document.querySelector('#folder [data-dest=EHLE] .agg-hero-lbl'); return !!c && /grid/.test(c.textContent); })()`);
    const on = await v2.eval(V2_ROWS); const cards = await classic.eval(CL_CARDS); const head = await v2.eval(V2_HEAD); const st = await v2.eval(V2_STATS('EHLE'));
    const probs = [];
    for (const r of on) {
      const c = cards.find(x => x.ident === r.ident); const o = off.find(x => x.ident === r.ident); if (!c) continue;
      const kwhC = classicVal(c.heroes[1]), peakC = classicVal(c.heroes[0]);
      if (!sameNum(kwhC, r.rKwh)) probs.push(`${r.ident} energy: classic grid ${c.heroes[1]} ("${c.heroLbls[1]}") vs v2 ${r.rKwh} (aircraft-side was ${o.rKwh}; ×${mul.toFixed(3)} = ${Math.ceil(o.kwh * mul)})`);
      if (!sameNum(peakC, r.rPeak)) probs.push(`${r.ident} peak: classic ${c.heroes[0]} vs v2 ${r.rPeak}`);
    }
    const daily = st.tiles3[1] && st.tiles3[1].v; const cl = cards.find(x => x.ident === 'EHLE');
    // v2's tile is the per-DAY grid energy; the classic card's small line is that × 30.44 — compare per day,
    // within the megawatt rule's rounding (2 dp below 1 MWh → ±5 kWh, 1 dp above → ±50) plus 0.5 %
    const clMonthly = cl && classicVal(cl.small[0]); const v2Daily = daily && classicVal(daily);
    if (cl && v2Daily && clMonthly && Math.abs(clMonthly.v / 30.44 - v2Daily.v) > Math.max(v2Daily.v >= 1000 ? 50 : 5, clMonthly.v / 30.44 * 0.005)) probs.push(`EHLE per day: classic ${cl.small[0]} / 30.44 = ${(clMonthly.v / 30.44).toFixed(0)} (grid) vs v2 tile ${J(daily)}`);
    await shotV2('energy-grid-factor'); await shotCl('energy-grid-factor.classic');
    await v2.eval(`(function(){ CNSSettings.save({ chargerEfficiency: { enabled: false } }); return true; })()`); await v2.sleep(700); await v2Settle();
    await classicSync(`(function(){ const c = document.querySelector('#folder [data-dest=EHLE] .agg-hero-lbl'); return !!c && !/grid/.test(c.textContent); })()`);
    if (probs.length) throw new Error(`gridDemandFactor ${mul.toFixed(4)} (classic synced via ${how}): ` + probs.join('; '));
    return { detail: `factor ${mul.toFixed(4)}; header energy tile ${J(head.tiles[2])}; EHLE pane ${J(st.tiles3[1])}; classic via ${how}`, repro: 'CNSSettings.save({chargerEfficiency:{enabled:true}}) in v2; compare classic "Daily energy (grid)" with v2 kWh/day', evidence: [ctx.shot('energy-grid-factor'), ctx.shot('energy-grid-factor.classic')] };
  }, { retry: 0 });

  // ================= charger slots =================
  await check('charger-slots-add', async () => {
    await openRow('EHLE');
    const before = (await v2.eval(V2_ROWS)).find(r => r.ident === 'EHLE');
    const clBefore = (await classic.eval(CL_CARDS)).find(c => c.ident === 'EHLE');
    await click('[data-act=fleetAdd][data-ap=EHLE]'); await v2Settle();
    const cfg = await v2.eval(CFG); const after = (await v2.eval(V2_ROWS)).find(r => r.ident === 'EHLE');
    const how = await classicSync(`document.querySelectorAll('#folder [data-dest=EHLE] .fleet-charger').length === ${before.fleetIds.length + 1}`);
    const clAfter = (await classic.eval(CL_CARDS)).find(c => c.ident === 'EHLE');
    const probs = [];
    if (!cfg.EHLE || !cfg.EHLE.chargers || cfg.EHLE.chargers.length !== before.fleetIds.length + 1) probs.push(`cfg.EHLE.chargers = ${J(cfg.EHLE && cfg.EHLE.chargers)} (was ${J(before.fleetIds)})`);
    if (after.fleetIds.length !== before.fleetIds.length + 1) probs.push(`rows().fleetIds ${J(after.fleetIds)}`);
    if (clAfter.fleet !== clBefore.fleet + 1) probs.push(`classic .fleet-charger ${clBefore.fleet} → ${clAfter.fleet}`);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `fleet ${J(before.fleetIds)} → ${J(after.fleetIds)}; classic selects ${clBefore.fleet} → ${clAfter.fleet} (${how})`, repro: 'real click [data-act=fleetAdd][data-ap=EHLE]' };
  }, { retry: 0 });

  await check('charger-slots-select', async () => {
    await openRow('EHLE');
    const before = (await v2.eval(V2_ROWS)).find(r => r.ident === 'EHLE');
    await v2.setValue('[data-act=fleetSel][data-ap=EHLE][data-i="0"]', 'dc_1000', ['change']); await v2Settle();
    const cfg = await v2.eval(CFG); const after = (await v2.eval(V2_ROWS)).find(r => r.ident === 'EHLE');
    const cap = await v2.eval(`(PLANES_BY_ID.beta_alia || {}).max_charge_kw`);
    const probs = [];
    if (!cfg.EHLE.chargers || cfg.EHLE.chargers[0] !== 'dc_1000') probs.push('cfg.EHLE.chargers[0] = ' + J(cfg.EHLE.chargers));
    if (after.peak === before.peak) probs.push(`peak unchanged at ${before.peak} kW after selecting dc_1000 (beta_alia max_charge_kw=${cap})`);
    const how = await classicSync(`(document.querySelector('#folder [data-dest=EHLE] .fleet-charger') || {}).value === 'dc_1000'`);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `slot 0 → dc_1000; peak ${before.peak} → ${after.peak} kW (beta_alia max_charge_kw ${cap}); classic select synced via ${how}`, repro: 'set [data-act=fleetSel][data-i=0] to dc_1000 + change' };
  }, { retry: 0 });

  await check('charger-slots-remove-last', async () => {
    await openRow('EHLE');
    // Bring EHLE down to ONE charger through the × buttons, then the classic rule: no × at one charger.
    let st = await v2.eval(V2_STATS('EHLE')); let guardN = 0;
    while (st.fleetSel > 1 && guardN++ < 5) { await click(`[data-act=fleetRm][data-ap=EHLE][data-i="${st.fleetSel - 1}"]`); await v2Settle(); st = await v2.eval(V2_STATS('EHLE')); }
    const cfg1 = await v2.eval(CFG);
    await classicSync(`document.querySelectorAll('#folder [data-dest=EHLE] .fleet-charger').length === 1`);
    const cl1 = (await classic.eval(CL_CARDS)).find(c => c.ident === 'EHLE');
    const det = `at one charger: cfg ${J(cfg1.EHLE.chargers)}; v2 × buttons ${st.fleetRm}; classic .fleet-remove ${cl1.fleetRemove} (selects ${cl1.fleet})`;
    if (st.fleetRm === 0) return { detail: det + ' — remove hidden like the classic', repro: 'reduce EHLE to one charger, count [data-act=fleetRm]' };
    // Control: what happens when the remaining × is clicked.
    const before = (await v2.eval(V2_ROWS)).find(r => r.ident === 'EHLE');
    await click('[data-act=fleetRm][data-ap=EHLE][data-i="0"]'); await v2Settle();
    const cfg0 = await v2.eval(CFG); const after = (await v2.eval(V2_ROWS)).find(r => r.ident === 'EHLE');
    await shotV2('charger-slots-remove-last');
    // restore a known fleet for the following checks
    await v2.eval(`(function(){ const c = CNSDemand.loadCfg(); c.EHLE = Object.assign({}, c.EHLE || {}, { chargers: ['dc_320'] }); CNSDemand.saveCfg(c); CNSUI.folderChanged(); CNSUI.render(); return true; })()`); await v2Settle();
    throw new Error(`${det}; clicking the last × wrote cfg.EHLE.chargers=${J(cfg0.EHLE && cfg0.EHLE.chargers)} and the fleet silently became ${J(after.fleetIds)} (was ${J(before.fleetIds)}) — the classic hides .fleet-remove at one charger (index.html:5663)`);
  }, { retry: 0 });

  // ================= charge target (on the AWAY node: D6 — the retour home always refills to 100 %) =================
  await check('charge-target', async () => {
    const AP = 'EDDF';
    await openRow(AP);
    let st = await v2.eval(V2_STATS(AP));
    if (!st.socp) { await click(`[data-act=socToggle][data-ap=${AP}]`); await v2Settle(); st = await v2.eval(V2_STATS(AP)); }
    if (!st.socp) throw new Error('no .socp panel after [data-act=socToggle]');
    const kw = async id => (await v2.eval(V2_ROWS)).find(r => r.ident === id).kwh;
    const k0 = await kw(AP), h0 = await kw('EHLE');
    await click(`input[data-act=socMode][data-ap=${AP}][value=target]`); await v2Settle();
    let cfg = await v2.eval(CFG); const probs = [];
    if (!cfg[AP] || cfg[AP].targetDepartureSoc !== 0.8) probs.push('after radio target: targetDepartureSoc = ' + J(cfg[AP] && cfg[AP].targetDepartureSoc));
    const k80 = await kw(AP);
    await v2.setValue(`[data-act=socSlider][data-ap=${AP}]`, '90', ['input', 'change']); await v2Settle();
    cfg = await v2.eval(CFG);
    if (!cfg[AP] || cfg[AP].targetDepartureSoc !== 0.9) probs.push('after slider 90: targetDepartureSoc = ' + J(cfg[AP] && cfg[AP].targetDepartureSoc));
    const k90 = await kw(AP), h90 = await kw('EHLE');
    if (!(k90 > k80)) probs.push(`${AP} kWh did not rise with the target: auto ${k0.toFixed(2)} → 80% ${k80.toFixed(2)} → 90% ${k90.toFixed(2)}`);
    st = await v2.eval(V2_STATS(AP));
    if (!/90 ?%/.test(st.socChip || '')) probs.push('v2 chip reads ' + J(st.socChip));
    const how = await classicSync(`(document.querySelector('#folder [data-dest=${AP}] .soc-chip strong') || {}).textContent === '90%'`);
    const cl = (await classic.eval(CL_CARDS)).find(c => c.ident === AP);
    if (cl.soc !== '90%') probs.push('classic chip reads ' + J(cl.soc));
    const clK = classicVal(cl.heroes[1]); const v2K = (await v2.eval(V2_ROWS)).find(r => r.ident === AP).rKwh;
    if (!sameNum(clK, v2K)) probs.push(`at 90%: classic ${AP} energy ${cl.heroes[1]} vs v2 ${v2K}`);
    await click(`input[data-act=socMode][data-ap=${AP}][value=auto]`); await v2Settle();
    cfg = await v2.eval(CFG);
    if (cfg[AP] && 'targetDepartureSoc' in cfg[AP]) probs.push('auto did not delete targetDepartureSoc: ' + J(cfg[AP]));
    await shotV2('charge-target');
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `${AP}: target 0.8 → 0.9 → auto; kWh auto ${k0.toFixed(2)} / 80% ${k80.toFixed(2)} / 90% ${k90.toFixed(2)} (classic ${cl.heroes[1]} at 90%); EHLE home stays ${h0.toFixed(1)} → ${h90.toFixed(1)} (D6: terminus refills to 100%); classic chip via ${how}`, repro: `${AP} pane: socToggle → radio target → slider 90 → radio auto`, evidence: [ctx.shot('charge-target')] };
  }, { retry: 0 });

  // ================= frequency edit =================
  await check('freq-edit', async () => {
    await openRow('EHLE');
    const others = (await folderNow()).filter(t => t.id !== ids.retour).reduce((s, t) => s + fpdOf(t), 0);
    const sel = `[data-act=tripFreq][data-id="${ids.retour}"]`;
    await v2.setValue(sel, '5', ['change']); await v2Settle();
    let f = (await folderNow()).find(t => t.id === ids.retour); let h = await v2.eval(V2_HEAD); const probs = [];
    if (f.freqN !== 5) probs.push('freqN ' + f.freqN);
    let m = HEAD_RE.exec(h.sub || ''); const exp1 = fmtFlights(5 + others);
    if (!m || +m[3] !== exp1) probs.push(`header after 5/day: ${J(h.sub)} (expected ${exp1} flights / day)`);
    await v2.setValue(`[data-act=tripUnit][data-id="${ids.retour}"]`, 'week', ['change']); await v2Settle();
    f = (await folderNow()).find(t => t.id === ids.retour); h = await v2.eval(V2_HEAD);
    if (f.freqUnit !== 'week') probs.push('freqUnit ' + f.freqUnit);
    m = HEAD_RE.exec(h.sub || ''); const exp2 = fmtFlights(5 / 7 + others);
    if (!m || Math.abs(+m[3] - exp2) > 0.051) probs.push(`header after 5/week: ${J(h.sub)} (expected ${exp2})`);
    const how = await classicSync(`(document.querySelector('#folder .trip-freq-unit[data-id="${ids.retour}"]') || {}).value === 'week'`);
    await v2.setValue(`[data-act=tripUnit][data-id="${ids.retour}"]`, 'day', ['change']); await v2Settle();
    await v2.setValue(sel, '2', ['change']); await v2Settle();
    const back = (await folderNow()).find(t => t.id === ids.retour);
    if (back.freqN !== 2 || back.freqUnit !== 'day') probs.push('restore failed ' + J(back));
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `5/day → header ${exp1}; 5/week → header ${exp2}; classic select synced via ${how}; restored 2/day`, repro: '[data-act=tripFreq] 5 + change, [data-act=tripUnit] week + change' };
  }, { retry: 0 });

  // ================= edit dialog: plane change re-simulates =================
  await check('edit-dialog-plane-change', async () => {
    await openRow('EHLE');
    const before = (await folderNow()).find(t => t.id === ids.retour);
    await click(`[data-act=editTrip][data-id="${ids.retour}"]`);
    await v2.waitFor(MODAL_OPEN('#efPlane'), 3000);
    const opts = await v2.eval(`[...document.querySelectorAll('#efPlane option')].map(o => o.value)`);
    if (!opts.includes('vaeridion_microliner')) throw new Error('#efPlane lacks vaeridion_microliner: ' + J(opts));
    await v2.setValue('#efPlane', 'vaeridion_microliner', ['change']);
    const since = v2.responses.length;
    await click('[data-act=efSave]');
    const resp = await v2.waitForResponse('/api/simulate', { since, method: 'POST', timeout: 20000 });
    let body = null; try { body = JSON.parse(String(await v2.responseBody(resp.requestId))); } catch (e) {}
    await v2.sleep(300);
    const modalOpen = await v2.eval(`!${MODAL_CLOSED}`);
    const err = await v2.eval(`(document.querySelector('#efError') || {}).textContent || ''`);
    const after = (await folderNow()).find(t => t.id === ids.retour);
    const prof = await v2.eval(`(function(){ const t = CNSDemand.loadFolder().find(x => x.id === ${J(ids.retour)}); const p = CNSFlight.profileForTrip(t, {}); return p ? { legs: (p.legs || []).length, charges: (p.charges || []).map(c => Math.round((c.energyKwh ?? 0) * 10) / 10) } : null; })()`);
    const probs = [];
    if (resp.status !== 200 || (body && body.error)) probs.push(`POST /api/simulate ${resp.status} ${body && body.error ? 'error: ' + body.error : ''}`);
    if (modalOpen) probs.push('dialog still open, #efError=' + J(err));
    if (after.plane !== 'vaeridion_microliner' || after.battery !== 600) probs.push(`entry plane=${after.plane} battery=${after.battery}`);
    if (after.recharge === before.recharge) probs.push(`rechargeEnergy unchanged ${after.recharge}`);
    if (!prof) probs.push('CNSFlight.profileForTrip(entry) is null');
    await shotV2('edit-dialog-plane-change'); await closeModal();
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `beta_alia (${before.battery} kWh, recharge ${before.recharge}) → vaeridion_microliner (${after.battery} kWh, recharge ${after.recharge}); profile ${J(prof)}`, repro: 'Edit EHLE→EDDF, #efPlane=vaeridion_microliner, [data-act=efSave]', evidence: [ctx.shot('edit-dialog-plane-change')] };
  }, { retry: 0 });

  await check('edit-dialog-plane-options', async () => {
    await openRow('EHLE');
    await click(`[data-act=editTrip][data-id="${ids.retour}"]`);
    await v2.waitFor(MODAL_OPEN('#efPlane'), 3000);
    const v = await v2.eval(`[...document.querySelectorAll('#efPlane option')].map(o => o.textContent.trim())`);
    await closeModal();
    const c = await classicEdit(ids.retour, 'EHLE', `return [...document.querySelectorAll('#efPlane option')].map(x => x.textContent.trim());`);
    const dup = a => [...new Set(a.filter((x, i) => a.indexOf(x) !== i))];
    const dv = dup(v), dc = dup(c);
    const probs = [];
    if (v.length !== 18) probs.push('v2 lists ' + v.length + ' aircraft');
    if (dv.length && !dc.length) probs.push('v2 has duplicate labels the classic disambiguates: ' + J(dv));
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `v2 ${v.length} options, duplicates ${J(dv)}; classic ${c.length} options ("name — battery"), duplicates ${J(dc)} — same catalog collision in both shells (heart_es30 / heart_es30_30_pax)`, repro: 'open Edit; compare #efPlane option labels with the classic openFlightEdit' };
  }, { retry: 0 });

  // ================= edit dialog: training → return must be blocked =================
  await check('edit-dialog-training-blocked', async () => {
    await openRow('EHTE');
    const before = await folderNow();
    await click(`[data-act=editTrip][data-id="${ids.training}"]`);
    await v2.waitFor(MODAL_OPEN('#efTripType'), 3000);
    await v2.setValue('#efTripType', 'retour', ['change']);
    const since = v2.responses.length;
    await click('[data-act=efSave]');
    await v2.sleep(1500);
    const posted = v2.responses.slice(since).filter(r => r.url.includes('/api/simulate') && r.method === 'POST');
    const err = await v2.eval(`(function(){ const e = document.querySelector('#efError'); return e ? { hidden: e.hidden, text: e.textContent } : null; })()`);
    const open = await v2.eval(`!${MODAL_CLOSED}`);
    const after = await folderNow();
    await shotV2('edit-dialog-training-blocked'); await closeModal();
    const CLASSIC_MSG = 'This flight loops around a single airport (no destination). Add a new flight to give it a route.';
    // Control: the same edit in the classic tab — message shown client-side, no /api/simulate request.
    const clSince = classic.responses.length;
    const cl = await classicEdit(ids.training, 'EHTE', `document.getElementById('efTripType').value = 'retour'; document.getElementById('efSave').click(); await new Promise(r => setTimeout(r, 700)); const e = document.getElementById('efError'); return { shown: !e.classList.contains('d-none'), text: e.textContent.trim(), stillOpen: document.getElementById('editFlightModal').classList.contains('show') };`);
    const clPosted = classic.responses.slice(clSince).filter(r => r.url.includes('/api/simulate') && r.method === 'POST').length;
    const probs = [];
    if (posted.length) probs.push(`v2 POSTed /api/simulate (${posted.map(p => p.status).join(',')}) instead of blocking client-side`);
    if (!err || err.hidden || err.text !== CLASSIC_MSG) probs.push(`#efError = ${J(err)} — the classic shows ${J(cl.text)} (shown=${cl.shown}, POSTs=${clPosted}; index.html:6135)`);
    if (J(after) !== J(before)) probs.push('folder changed');
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `blocked with the classic message, no POST, folder unchanged; classic control: ${J(cl)} POSTs=${clPosted}`, repro: 'Edit the EHTE training flight, #efTripType=retour, Save', evidence: [ctx.shot('edit-dialog-training-blocked')] };
  }, { retry: 0 });

  // ================= edit dialog: pinned charger removed from the fleet =================
  await check('edit-dialog-pinned-not-in-fleet', async () => {
    await v2.eval(`(function(){ const c = CNSDemand.loadCfg(); c.EHLE = Object.assign({}, c.EHLE || {}, { chargers: ['dc_320', 'dc_1000'] }); CNSDemand.saveCfg(c); CNSUI.folderChanged(); CNSUI.render(); return true; })()`); await v2Settle();
    await openRow('EHLE');
    await click(`[data-act=editTrip][data-id="${ids.retour}"]`);
    await v2.waitFor(MODAL_OPEN('#efCharger'), 3000);
    const opts1 = await v2.eval(`[...document.querySelectorAll('#efCharger option')].map(o => o.value)`);
    if (!opts1.includes('dc_1000')) throw new Error('#efCharger lacks the fleet charger dc_1000: ' + J(opts1));
    await v2.setValue('#efCharger', 'dc_1000', ['change']);
    const since = v2.responses.length;
    await click('[data-act=efSave]'); await v2.waitFor(MODAL_CLOSED, 5000); await v2Settle();
    const posted = v2.responses.slice(since).filter(r => r.url.includes('/api/simulate') && r.method === 'POST').length;
    const pinned = (await folderNow()).find(t => t.id === ids.retour).override;
    const probs = [];
    if (pinned !== 'dc_1000') probs.push('chargerOverride = ' + J(pinned));
    if (posted) probs.push('metadata-only save POSTed /api/simulate (classic does not)');
    // now drop dc_1000 from the fleet and reopen
    await v2.eval(`(function(){ const c = CNSDemand.loadCfg(); c.EHLE = Object.assign({}, c.EHLE || {}, { chargers: ['dc_320'] }); CNSDemand.saveCfg(c); CNSUI.folderChanged(); CNSUI.render(); return true; })()`); await v2Settle();
    await openRow('EHLE');
    await click(`[data-act=editTrip][data-id="${ids.retour}"]`);
    await v2.waitFor(MODAL_OPEN('#efCharger'), 3000);
    const o2 = await v2.eval(`[...document.querySelectorAll('#efCharger option')].map(o => ({ v: o.value, t: o.textContent.trim(), sel: o.selected }))`);
    const selected = await v2.eval(`document.querySelector('#efCharger').value`);
    await shotV2('edit-dialog-pinned-not-in-fleet'); await closeModal();
    const clOpts = await classicEdit(ids.retour, 'EHLE', `const o = [...document.querySelectorAll('#efCharger option')].map(x => ({ v: x.value, t: x.textContent.trim() })); return { o, sel: document.getElementById('efCharger').value };`);
    const pin = o2.find(o => o.v === 'dc_1000');
    if (!pin || !/not in fleet/.test(pin.t) || selected !== 'dc_1000') probs.push(`v2 #efCharger options ${J(o2.map(o => o.t))} selected=${J(selected)} — classic lists ${J(clOpts.o.map(o => o.t))} selected=${J(clOpts.sel)} (index.html:6055)`);
    // unpin for the following checks
    await v2.eval(`(function(){ CNSDemand.updateTrip(${J(ids.retour)}, { chargerOverride: undefined }); CNSUI.folderChanged(); CNSUI.render(); return true; })()`); await v2Settle();
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `pinned dc_1000 then removed it from the fleet: v2 options ${J(o2.map(o => o.t))}; classic ${J(clOpts.o.map(o => o.t))}`, repro: 'fleet [dc_320,dc_1000]; Edit → #efCharger dc_1000 → Save; fleet [dc_320]; Edit again', evidence: [ctx.shot('edit-dialog-pinned-not-in-fleet')] };
  }, { retry: 0 });

  // ================= edit dialog: a metadata-only save must not recompute the whole folder (B21) =================
  // network.js:117 calls recomputeAll() on the frequency / fleet-mode / charger-pin branch; the classic (index.html:6141-6147)
  // saves and re-renders only. Spy on CNSRecompute.recomputeAll in both shells and save the dialog with unchanged values.
  await check('edit-dialog-metadata-only-no-recompute', async () => {
    const SPY = `(function(){ const R = window.CNSRecompute; if (!R.__orig) { R.__orig = R.recomputeAll; R.recomputeAll = function () { R.__n = (R.__n || 0) + 1; return R.__orig.apply(this, arguments); }; } R.__n = 0; return true; })()`;
    await openRow('EHLE'); await v2.eval(SPY);
    const before = await folderNow();
    await click(`[data-act=editTrip][data-id="${ids.oneway}"]`); await v2.waitFor(MODAL_OPEN('#efFreqN'), 3000);
    const cur = await v2.eval(`document.querySelector('#efFreqN').value`);
    await v2.setValue('#efFreqN', cur, ['input', 'change']);          // unchanged value → the metadata-only branch
    const since = v2.responses.length;
    await click('[data-act=efSave]'); await v2.waitFor(MODAL_CLOSED, 5000); await v2Settle();
    const n = await v2.eval(`CNSRecompute.__n || 0`); const posted = v2.responses.slice(since).filter(r => r.url.includes('/api/simulate') && r.method === 'POST').length;
    const after = await folderNow(); const changed = after.filter((t, i) => J(t) !== J(before[i])).map(t => `${t.o}→${t.d} ${t.trip}`);
    await classic.eval(SPY);
    const cl = await classicEdit(ids.oneway, 'EHLE', `const f = document.getElementById('efFreqN'); f.value = f.value; document.getElementById('efSave').click(); await new Promise(r => setTimeout(r, 700)); return { n: CNSRecompute.__n || 0, open: document.getElementById('editFlightModal').classList.contains('show') };`);
    const probs = [];
    if (posted) probs.push('v2 POSTed /api/simulate on a metadata-only save');
    if (n > 0) probs.push(`v2 ran CNSRecompute.recomputeAll ${n}× for a metadata-only save (the classic ran it ${cl.n}× for the same save)${changed.length ? '; folder entries rewritten: ' + J(changed) : ''}`);
    if (probs.length) throw new Error(probs.join('; ') + ' — network.js:117 calls recomputeAll() on the metadata branch, index.html:6146 saves + renderFolder() only');
    return { detail: `metadata-only save: v2 recomputeAll ${n}×, POSTs ${posted}, entries changed ${J(changed)}; classic recomputeAll ${cl.n}× (modal open after save: ${cl.open})`, repro: 'Edit the one-way flight, leave every field as is, Save; spy CNSRecompute.recomputeAll in both tabs' };
  }, { retry: 0 });

  // ================= replay dialog =================
  // The classic creates #folderMap ONCE and keeps it (index.html:6404-6407); v2 removes the Leaflet map on every close
  // (network.js:143). Anything Leaflet still has queued (zoom-transition fallback timer 250 ms, tile timers) then runs
  // against a removed map. Capture the stack of everything thrown after the close.
  await check('replay-dialog', async () => {
    await openRow('EHLE');
    // leaflet.js comes from unpkg without `crossorigin`, so window.onerror only sees "Script error." — capture the stack
    // in-page instead, where Leaflet reads `_leaflet_pos` (L.DomUtil.getPosition(el) with el === undefined after map.remove()).
    await v2.eval(`(function(){ __cns.errs = []; if (!__cns.errHook) { __cns.errHook = true;
      window.addEventListener('error', e => { __cns.errs.push({ t: Math.round(performance.now()), msg: String(e.message), stack: e.error && e.error.stack ? String(e.error.stack).split('\\n').slice(0, 7).map(s => s.trim()).join(' | ') : '' }); });
      const P = L.Map.prototype, orig = P._getMapPanePos; P._getMapPanePos = function () { if (!this._mapPane) __cns.errs.push({ t: Math.round(performance.now()), msg: '_getMapPanePos() on a removed map (no _mapPane)', stack: String(new Error().stack).split('\\n').slice(2, 9).map(s => s.trim().replace(/https?:\\S*leaflet\\.js/, 'leaflet.js')).join(' | ') }); return orig.apply(this, arguments); }; }
      return true; })()`);
    // The CDP event still carries the frames the page cannot see (leaflet.js is loaded without crossorigin).
    const cdpFrames = () => v2.once('Runtime.exceptionThrown', 3500).then(p => { const d = p.exceptionDetails || {}; return ((d.stackTrace || {}).callFrames || []).map(f => `${f.functionName || '(anon)'}@${(f.url || '').split('/').pop()}:${f.lineNumber}:${f.columnNumber}`).join(' < '); }).catch(() => null);
    const rounds = [], probs = [];
    for (let i = 0; i < 3; i++) {
      const ex0 = v2.errors.length;
      await v2.eval(`__cns.errs.length = 0; true`);
      await click('[data-act=replay][data-ap=EHLE]');
      await v2.waitFor(`!!document.querySelector('#folderMap .leaflet-tile-pane') && !!window.folderMap`, 4000);
      const active0 = await v2.eval(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`);
      const c0 = await v2.eval(`(document.querySelector('#animClock') || {}).textContent`);
      let changed = false; const t0 = Date.now();
      while (Date.now() - t0 < 3000) { await sleep(150); const c = await v2.eval(`(document.querySelector('#animClock') || {}).textContent`); if (c && c !== c0) { changed = true; break; } }
      const c1 = await v2.eval(`(document.querySelector('#animClock') || {}).textContent`);
      await v2.setValue('#animSpeed', '40', ['input']);
      const lbl = await v2.eval(`(document.querySelector('#animSpeedLbl') || {}).textContent`);
      const tiles = await v2.eval(`document.querySelectorAll('#folderMap .leaflet-tile-pane img.leaflet-tile').length`);
      if (i === 0) await shotV2('replay-dialog');
      const tClose = await v2.eval(`Math.round(performance.now())`);
      const framesP = cdpFrames();
      await click('#modalBox [data-modal=close]');
      await v2.waitFor(MODAL_CLOSED, 2000); await v2.sleep(1500);            // Leaflet's zoom-transition fallback fires 250 ms later
      const after = await v2.eval(`({ folderMap: window.folderMap, box: document.querySelector('#modalBox').innerHTML.length, width: document.querySelector('#modalBox').style.width })`);
      const errs = (await v2.eval(`__cns.errs.slice()`)).map(e => `+${e.t - tClose} ms after close: ${e.msg} — ${e.stack}`);
      const frames = await framesP; if (frames) errs.push('CDP frames: ' + frames);
      const ex = v2.errors.slice(ex0).filter(e => e.type === 'exception').map(e => e.text.split('\n')[0] + ' @ ' + e.url);
      rounds.push({ i: i + 1, active0, clock0: c0, clock1: c1, changed, lbl, tiles, after, ex, errs });
      if (!changed) probs.push(`round ${i + 1}: #animClock did not change within 3 s (${J(c0)})`);
      if (lbl !== '40 s / hour') probs.push(`round ${i + 1}: speed label ${J(lbl)}`);
      if (after.folderMap !== null || after.box !== 0) probs.push(`round ${i + 1}: after close ${J(after)}`);
      if (ex.length) probs.push(`round ${i + 1}: exception ${ex.join(' || ')}${errs.length ? ' [' + errs.join(' ;; ') + ']' : ''}`);
    }
    ctx.state.replayExceptions = rounds.reduce((s, r) => s + r.ex.length, 0);
    if (probs.length) throw new Error(probs.join('; ') + ' — rounds ' + J(rounds));
    return { detail: J(rounds), repro: '[data-act=replay][data-ap=EHLE] → wait #animClock → #animSpeed 40 → [data-modal=close] ×3', evidence: [ctx.shot('replay-dialog')] };
  }, { retry: 0 });

  // B18 (app.js:54): modal.open() focuses the first input/select, so the replay opens with the speed slider focused and an
  // arrow key changes the replay speed. Control: the classic's Bootstrap modal focuses the dialog itself (index.html:2095,
  // tabindex=-1) and the same ArrowRight leaves #animSpeed alone.
  await check('replay-dialog-autofocus', async () => {
    await openRow('EHLE');
    await click('[data-act=replay][data-ap=EHLE]'); await v2.waitFor(`!!window.folderMap`, 4000); await v2.sleep(250);
    const RD = `({ active: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName), speed: document.querySelector('#animSpeed').value, lbl: (document.querySelector('#animSpeedLbl') || {}).textContent })`;
    const before = await v2.eval(RD);
    await press('ArrowRight'); await v2.sleep(200);
    const after = await v2.eval(RD);
    await click('#modalBox [data-modal=close]'); await v2.waitFor(MODAL_CLOSED, 2000);
    const cl0 = await classic.evalAsync(`openFlightsMap('EHLE'); const m = document.getElementById('flightsMapModal'); await new Promise(r => { m.addEventListener('shown.bs.modal', r, { once: true }); setTimeout(r, 1500); }); await new Promise(r => setTimeout(r, 200)); return { active: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName), speed: document.getElementById('animSpeed').value };`);
    await classic.press('ArrowRight'); await classic.sleep(200);
    const cl1 = await classic.eval(`({ active: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName), speed: document.getElementById('animSpeed').value })`);
    await classic.evalAsync(`const m = document.getElementById('flightsMapModal'); await new Promise(r => { m.addEventListener('hidden.bs.modal', r, { once: true }); setTimeout(r, 1500); flightsModal.hide(); }); return true;`);
    if (after.speed !== before.speed) throw new Error(`replay opens with focus on "${before.active}"; one ArrowRight changed the speed ${before.speed} → ${after.speed} (${after.lbl}) — the classic opens with focus on "${cl0.active}" and ArrowRight leaves #animSpeed at ${cl1.speed} (app.js:54 autofocuses the first input/select of every dialog)`);
    return { detail: `v2 focus ${J(before.active)}, ArrowRight kept speed ${after.speed}; classic focus ${J(cl0.active)}, speed ${cl1.speed}`, repro: 'open the replay, press ArrowRight, read #animSpeed; same in the classic flightsMapModal' };
  }, { retry: 0 });

  // ================= isolation =================
  await check('isolation', async () => {
    await openRow('EHLE');
    await click('[data-act=focus][data-ap=EHLE]'); await v2Settle();
    const st = await v2.eval(`({ aps: [...document.querySelectorAll('#railBody .ap')].map(e => e.dataset.ap), chipHidden: document.querySelector('#focChip').hidden, chip: document.querySelector('#focChip').textContent.trim(), sub: document.querySelector('#drawerSub').textContent, filter: CNSUI.S.filter, head: (document.querySelector('#railBody .ph h3') || {}).textContent })`);
    const probs = [];
    if (st.aps.length !== 1 || st.aps[0] !== 'EHLE') probs.push('rows ' + J(st.aps));
    if (st.chipHidden || !/EHLE/.test(st.chip)) probs.push('chip ' + J({ hidden: st.chipHidden, text: st.chip }));
    if (!/chargers? · peak/.test(st.sub)) probs.push('drawer sub ' + J(st.sub));
    await shotV2('isolation');
    await click('#focChip'); await v2Settle();
    const back = await v2.eval(`({ aps: [...document.querySelectorAll('#railBody .ap')].map(e => e.dataset.ap), chipHidden: document.querySelector('#focChip').hidden, filter: CNSUI.S.filter })`);
    if (back.filter !== '' || back.aps.length !== APS.length || !back.chipHidden) probs.push(`after chip: ${J(back)} (expected ${APS.length} rows)`);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `isolated: ${J(st)}; chip → ${J(back)}`, repro: 'Isolate EHLE in the pane, then click #focChip', evidence: [ctx.shot('isolation')] };
  }, { retry: 0 });

  await check('isolation-chip-single-pass', async () => {
    await openRow('EHLE');
    await click('[data-act=focus][data-ap=EHLE]'); await v2Settle();
    await v2.eval(`(function(){ const orig = CNSUI.network.render; let n = 0; CNSUI.network.render = function () { n++; return orig.apply(this, arguments); }; window.__cnsRenderCount = () => { CNSUI.network.render = orig; return n; }; return true; })()`);
    await click('#focChip'); await v2Settle();
    const count = await v2.eval(`window.__cnsRenderCount()`);
    if (count !== 1) throw new Error(`one #focChip click ran network.render() ${count}× (desktop.html:64 gives the chip data-act="focus" AND timeline.js:63 handles #focChip) — expected 1`);
    return `one chip click → ${count} network render`;
  }, { retry: 0 });

  // ================= timeline "Isolate" button in Plan mode (B5) =================
  // app.js:118 renders the drawer in both modes, so the per-airport Isolate button is visible in Plan mode too, but
  // network.js:167 drops every data-act except 'scenario' unless S.mode === 'network'. Control: the same real click in Network mode.
  await check('timeline-focus-in-plan-mode', async () => {
    await toNetwork();
    await v2.eval(`document.querySelector('#drawer').classList.add('open'); CNSUI.timeline.render(); true`);
    const sel = '#gantt .grp .lab button[data-act=focus][data-ap=EHLE]';
    await v2.waitFor(`!!document.querySelector(${J(sel)})`, 3000);
    await click(sel); await v2Settle();
    const net = await v2.eval(`({ filter: CNSUI.S.filter, mode: CNSUI.S.mode, rows: document.querySelectorAll('#railBody .ap').length })`);
    if (net.filter === 'EHLE') { await click('#focChip'); await v2Settle(); }
    await click('#modeSeg [data-mode=plan]'); await v2.sleep(400);
    await v2.waitFor(`CNSUI.S.mode === 'plan' && !!document.querySelector(${J(sel)})`, 3000);
    const r = await v2.rect(sel);
    await click(sel); await v2.sleep(500);
    const plan = await v2.eval(`({ filter: CNSUI.S.filter, mode: CNSUI.S.mode, chipHidden: document.querySelector('#focChip').hidden, title: (document.querySelector(${J(sel)}) || {}).title, drawerOpen: document.querySelector('#drawer').classList.contains('open') })`);
    await shotV2('timeline-focus-plan-mode');
    if (net.filter !== 'EHLE') throw new Error('control failed: in Network mode the timeline Isolate button did not isolate: ' + J(net));
    if (plan.filter !== 'EHLE') throw new Error(`Plan mode: a real click on the timeline's "${plan.title}" button (visible, ${Math.round(r.w)}×${Math.round(r.h)} px, top=${r.topTag}) did nothing — ${J(plan)}; the same click in Network mode isolated EHLE (${J(net)}). network.js:167 returns before the 'focus' case unless S.mode === 'network'`);
    await toNetwork(); if (await v2.eval(`CNSUI.S.filter`)) { await click('#focChip'); await v2Settle(); }
    return { detail: `network mode click → ${J(net)}; plan mode click → ${J(plan)}`, repro: 'open the drawer, click #gantt .grp .lab button[data-act=focus] in Plan mode', evidence: [ctx.shot('timeline-focus-plan-mode')] };
  }, { retry: 0 });

  // ================= custom charger: seed a 4th flight on it, edit it =================
  let customId = null;
  await check('edit-dialog-custom-charger', async () => {
    const r = await fetch(ctx.base + '/api/custom/chargers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ name: RUN + ' 150 kW', power_kw: 150 }) });
    const body = await r.json();
    if (r.status !== 201) throw new Error(`POST /api/custom/chargers → ${r.status} ${J(body)}`);
    customId = body.id;
    ctx.cleanup(async () => { const d = await fetch(ctx.base + '/api/custom/chargers/' + encodeURIComponent(customId), { method: 'DELETE' }); ctx.log('cleanup custom charger', customId, d.status); });
    await withTimeout(v2.reload({ boot: 'v2' }), 60000, 'reload /v2'); guard(v2);
    const known = await v2.eval(`!!CHARGERS_BY_ID[${J(customId)}] && !!(CNSChargers.get && CNSChargers.get(${J(customId)}))`);
    if (!known) throw new Error('custom charger not in CHARGERS_BY_ID after reload');
    const seeded = await ctx.seedNetwork(v2, [{ o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: customId, trip: 'one-way', freq: 1, per: 'day' }]);
    if (seeded[0].err || seeded[0].added !== 1) throw new Error('seed on custom charger failed: ' + J(seeded));
    ids.custom = seeded[0].id;
    await toNetwork(); await openRow('EHLE');
    await click(`[data-act=editTrip][data-id="${ids.custom}"]`);
    await v2.waitFor(MODAL_OPEN('#efPlane'), 3000);
    await v2.setValue('#efPlane', 'vaeridion_microliner', ['change']);
    const since = v2.responses.length;
    await click('[data-act=efSave]');
    const resp = await v2.waitForResponse('/api/simulate', { since, method: 'POST', timeout: 20000 });
    let rb = null; try { rb = JSON.parse(String(await v2.responseBody(resp.requestId))); } catch (e) {}
    await v2.sleep(300);
    const open = await v2.eval(`!${MODAL_CLOSED}`);
    const err = await v2.eval(`(document.querySelector('#efError') || {}).textContent || ''`);
    const after = (await folderNow()).find(t => t.id === ids.custom);
    await shotV2('edit-dialog-custom-charger'); await closeModal();
    const probs = [];
    if (resp.status !== 200 || (rb && rb.error)) probs.push(`POST /api/simulate ${resp.status}${rb && rb.error ? ' error: ' + J(rb.error) : ''} — the classic sends payload.charger for a custom charger (index.html:6161), network.js:120 does not`);
    if (open) probs.push('dialog still open, #efError=' + J(err));
    if (after.plane !== 'vaeridion_microliner') probs.push('entry plane ' + after.plane);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `custom charger ${customId} (${RUN}); flight ${ids.custom} re-simulated on plane change → ${after.plane}`, repro: 'POST custom charger, reload /v2, seed EHLE→EDDF on it, Edit → plane change → Save', evidence: [ctx.shot('edit-dialog-custom-charger')] };
  }, { retry: 0 });

  // ================= remove + clear =================
  await check('remove-and-clear', async () => {
    await toNetwork(); await openRow('EHLE');
    const n0 = (await folderNow()).length; const victim = ids.custom || ids.oneway;
    await click(`[data-act=rm][data-id="${victim}"]`); await v2Settle();
    const n1 = (await folderNow()).length; const probs = [];
    if (n1 !== n0 - 1) probs.push(`rm: ${n0} → ${n1}`);
    await v2.eval(`__cns.confirms.length = 0; __cns.confirmResult = false;`);
    await click('[data-act=clear]'); await v2Settle();
    const nKeep = (await folderNow()).length; const c1 = await v2.eval(`__cns.confirms.slice()`);
    if (nKeep !== n1) probs.push(`cancelled confirm still cleared: ${n1} → ${nKeep}`);
    if (c1.length !== 1) probs.push('confirm not asked: ' + J(c1));
    await v2.eval(`__cns.confirmResult = true;`);
    await click('[data-act=clear]'); await v2Settle();
    const st = await v2.eval(`({ n: CNSDemand.loadFolder().length, cards: document.querySelectorAll('#railBody .scen .sc').length, netCount: document.querySelector('#netCount').textContent, foot: document.querySelector('#railFoot').textContent.trim() })`);
    if (st.n !== 0 || st.cards !== 3 || st.netCount !== '') probs.push('after clear: ' + J(st));
    await shotV2('remove-and-clear');
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `rm ${n0}→${n1}; cancel kept ${nKeep}; confirm ${J(c1[0])}; cleared → ${J(st)}`, repro: '[data-act=rm] then [data-act=clear] with __cns.confirmResult false/true', evidence: [ctx.shot('remove-and-clear')] };
  }, { retry: 0 });

  // ================= scenarios =================
  const loadScenarioViaButton = async k => {
    await toNetwork();
    if (await v2.eval(`CNSDemand.loadFolder().length`)) { await v2.eval(`__cns.confirmResult = true;`); await click('[data-act=clear]'); await v2Settle(); }
    // B19 (network.js:158-160): count the full renders (timeline.render runs once per app.js render), map fits and the
    // network rows() passes reachable through the CNSUI object while the scenario loads — informational, reported in `perf`.
    await v2.eval(`(function(){ const c = window.__cnsPerf = { renders: 0, fitNet: 0, drawNet: 0, rows: 0, t0: performance.now() }; const T = CNSUI.timeline.render, F = CNSUI.map.fitNet, Dn = CNSUI.map.drawNet, W = CNSUI.network.rows;
      CNSUI.timeline.render = function () { c.renders++; return T.apply(this, arguments); }; CNSUI.map.fitNet = function () { c.fitNet++; return F.apply(this, arguments); }; CNSUI.map.drawNet = function () { c.drawNet++; return Dn.apply(this, arguments); }; CNSUI.network.rows = function () { c.rows++; return W.apply(this, arguments); };
      c.restore = () => { CNSUI.timeline.render = T; CNSUI.map.fitNet = F; CNSUI.map.drawNet = Dn; CNSUI.network.rows = W; }; document.querySelector('#toast').textContent = ''; return true; })()`);
    await click(`[data-act=scenario][data-k=${k}]`);
    await v2.waitFor(`/loaded —/.test(document.querySelector('#toast').textContent)`, 120000, 250);
    await v2Settle();
    return v2.eval(`(function(){ const c = window.__cnsPerf; const perf = { renders: c.renders, fitNet: c.fitNet, drawNet: c.drawNet, rowsCalls: c.rows, ms: Math.round(performance.now() - c.t0) }; c.restore();
      return { perf, toast: document.querySelector('#toast').textContent, folder: ${FOLDER}, cfg: ${CFG}, sched: Object.keys(JSON.parse(localStorage.getItem('cns_schedule') || '{}')), aps: [...document.querySelectorAll('#railBody .ap')].map(e => e.dataset.ap), mode: CNSUI.S.mode, err: CNSUI.S.err }; })()`);
  };
  await check('scenario-training', async () => {
    const r = await loadScenarioViaButton('training');
    const probs = [];
    if (r.folder.length !== 1 || r.folder[0].trip !== 'training' || r.folder[0].o !== 'EHTE') probs.push('folder ' + J(r.folder));
    if (!r.cfg.EHTE || J(r.cfg.EHTE.chargers) !== J(['dc_22', 'dc_22', 'dc_22'])) probs.push('cfg.EHTE ' + J(r.cfg.EHTE));
    if (r.aps.length !== 1) probs.push('rows ' + J(r.aps));
    await shotV2('scenario-training');
    if (probs.length) throw new Error(probs.join('; ') + ' toast=' + J(r.toast));
    return { detail: `${r.toast}; ${J(r.folder[0])}; perf ${J(r.perf)}`, repro: 'empty network → [data-act=scenario][data-k=training]', evidence: [ctx.shot('scenario-training')] };
  }, { retry: 0 });
  await check('scenario-hub', async () => {
    const want = await v2.eval(`CNSUI.network.SCENARIOS.hub.routes.map(r => r[2])`);
    const catalog = await v2.eval(`CNSUI.PLANES.map(p => p.id)`);
    const unknown = [...new Set(want.filter(id => !catalog.includes(id)))];
    const r = await loadScenarioViaButton('hub');
    ctx.state.hub = r;
    await shotV2('scenario-hub');
    if (r.folder.length !== 8) throw new Error(`hub loaded ${r.folder.length}/8 routes in ${r.perf.ms} ms (toast ${J(r.toast)}); scenario plane ids ${J([...new Set(want)])} — not in the production catalog: ${J(unknown)} (network.js:150; /api/simulate answers "Plane beta_plane not found"); perf ${J(r.perf)}`);
    return { detail: r.toast + ' ' + J(r.folder.map(t => `${t.o}→${t.d} ${t.plane}`)) + '; perf ' + J(r.perf), repro: 'Clear all → [data-act=scenario][data-k=hub]', evidence: [ctx.shot('scenario-hub')] };
  }, { retry: 0 });
  await check('scenario-no-stale-state', async () => {
    const r = ctx.state.hub || await v2.eval(`({ folder: ${FOLDER}, cfg: ${CFG}, sched: Object.keys(JSON.parse(localStorage.getItem('cns_schedule') || '{}')) })`);
    const hubAps = new Set(['EHLE', ...(await v2.eval(`CNSUI.network.SCENARIOS.hub.routes.map(x => x[1])`))]);
    const staleCfg = Object.keys(r.cfg).filter(k => !hubAps.has(k));
    const live = new Set(r.folder.map(t => t.id)); const staleSched = r.sched.filter(id => !live.has(id));
    const probs = [];
    if (staleCfg.length) probs.push(`cns_airport_cfg still holds ${J(staleCfg)} from the previous (training) network: ${J(staleCfg.map(k => r.cfg[k]))}`);
    if (staleSched.length) probs.push(`cns_schedule still holds ${staleSched.length} take-off arrays for trips that no longer exist (${J(staleSched.slice(0, 3))})`);
    if (probs.length) throw new Error(probs.join('; ') + ' — network.js:157 keeps loadCfg() and never resets cns_schedule');
    return `cfg keys ${J(Object.keys(r.cfg))}, schedule keys ${r.sched.length} all live`;
  }, { retry: 0 });
  await check('scenario-regional', async () => {
    const r = await loadScenarioViaButton('regional');
    await shotV2('scenario-regional');
    if (r.folder.length !== 12) throw new Error(`regional loaded ${r.folder.length}/12 routes in ${r.perf.ms} ms (toast ${J(r.toast)}): ${J(r.folder.map(t => `${t.o}→${t.d} ${t.plane}`))} — prototype plane ids in network.js:152; perf ${J(r.perf)}`);
    return { detail: r.toast + '; perf ' + J(r.perf), repro: 'Clear all → [data-act=scenario][data-k=regional]', evidence: [ctx.shot('scenario-regional')] };
  }, { retry: 0 });

  // ================= PDF / XLSX (needs a non-empty network) =================
  const ensureNetwork = async () => { if (!(await v2.eval(`CNSDemand.loadFolder().length`))) { await click('#modeSeg [data-mode=plan]'); await v2Settle(); await ctx.seedNetwork(v2, [{ o: 'EHLE', d: 'EDDF', plane: 'beta_alia', charger: 'dc_320', trip: 'retour', freq: 2, per: 'day' }]); } await toNetwork(); };
  await check('pdf', async () => {
    await ensureNetwork();
    const rows = await v2.eval(V2_ROWS);
    await click('[data-act=pdf]');
    await v2.waitFor(`!document.querySelector('#modal').hidden && document.querySelectorAll('#modalBox .rp input[name=rp]').length > 0`, 3000);
    const radios = await v2.eval(`[...document.querySelectorAll('#modalBox .rp input[name=rp]')].map(r => r.value)`);
    const probs = [];
    if (radios.length !== rows.length || rows.some(r => !radios.includes(r.ident))) probs.push(`radios ${J(radios)} vs rows ${J(rows.map(r => r.ident))}`);
    await v2.eval(`document.querySelector('#toast').textContent = ''; __cns.alerts.length = 0; true`);
    const since = v2.responses.length;
    await click('[data-act=rpGo]');
    const resp = await v2.waitForResponse('/api/report.pdf', { since, method: 'POST', timeout: 90000 });
    let errBody = null; if (resp.status !== 200) { try { errBody = String(await v2.responseBody(resp.requestId)).slice(0, 300); } catch (e) {} }
    let dl = null; if (resp.status === 200) { try { dl = await v2.waitForDownload({ ext: '.pdf', timeout: 20000 }); } catch (e) { probs.push('download: ' + e.message); } }
    await v2.sleep(400);
    const toast = await v2.eval(`document.querySelector('#toast').textContent`); const alerts = await v2.eval(`__cns.alerts.slice()`);
    const open = await v2.eval(`!${MODAL_CLOSED}`);
    await shotV2('pdf'); await closeModal();
    if (resp.status !== 200) {
      ctx.state.pdfEnv = `POST /api/report.pdf → ${resp.status} ${errBody || ''}`;
      if (/Report downloaded/.test(toast)) probs.push(`server answered ${resp.status} (${errBody}) but the toast says ${J(toast)} (report.js:16 — CNSReport.generate swallows the failure via alert(): ${J(alerts)})`);
      else probs.push(`server answered ${resp.status}: ${errBody} (toast ${J(toast)}, alerts ${J(alerts)})`);
    } else {
      if (resp.mimeType !== 'application/pdf') probs.push('mime ' + resp.mimeType);
      if (!dl || dl.bytes <= 10240) probs.push('download ' + J(dl));
      if (!/Report downloaded/.test(toast)) probs.push('no success toast: ' + J(toast));
      if (open) probs.push('dialog still open after success');
    }
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `radios ${J(radios)}; ${resp.status} ${resp.mimeType}; download ${dl.filename} ${dl.bytes} B; toast ${J(toast)}`, repro: '[data-act=pdf] → [data-act=rpGo]', evidence: [ctx.shot('pdf'), dl.path] };
  }, { retry: 0 });

  await check('pdf-failure-no-success-toast', async () => {
    await ensureNetwork();
    await v2.eval(`(function(){ window.__realFetch = window.fetch; window.fetch = function (u, o) { if (String(u).includes('/api/report.pdf')) return Promise.resolve(new Response(JSON.stringify({ error: 'UI-TEST forced 500' }), { status: 500, headers: { 'Content-Type': 'application/json' } })); return window.__realFetch(u, o); }; document.querySelector('#toast').textContent = ''; __cns.alerts.length = 0; return true; })()`);
    try {
      await click('[data-act=pdf]');
      await v2.waitFor(`!document.querySelector('#modal').hidden && document.querySelectorAll('#modalBox .rp input[name=rp]').length > 0`, 3000);
      await click('[data-act=rpGo]'); await v2.sleep(1200);
      const toast = await v2.eval(`document.querySelector('#toast').textContent`); const alerts = await v2.eval(`__cns.alerts.slice()`);
      const open = await v2.eval(`!${MODAL_CLOSED}`);
      await shotV2('pdf-failure'); await closeModal();
      if (/Report downloaded/.test(toast)) throw new Error(`forced 500 on /api/report.pdf → toast ${J(toast)}, dialog ${open ? 'open' : 'closed'} (alerts ${J(alerts)}) — report.js:16 toasts success because CNSReport.generate (static/report.js:395) catches the error and alerts instead of throwing`);
      return { detail: `forced 500 → toast ${J(toast)}, alerts ${J(alerts)}, dialog ${open ? 'still open' : 'closed'}`, repro: 'stub fetch(/api/report.pdf) → 500, [data-act=pdf] → [data-act=rpGo]', evidence: [ctx.shot('pdf-failure')] };
    } finally { await v2.eval(`(function(){ if (window.__realFetch) { window.fetch = window.__realFetch; delete window.__realFetch; } return true; })()`); }
  }, { retry: 0 });

  await check('xlsx', async () => {
    await ensureNetwork();
    await v2.eval(`__cns.alerts.length = 0; true`);
    const since = v2.responses.length;
    await click('[data-act=xlsx]');
    const resp = await v2.waitForResponse('/api/report.xlsx', { since, method: 'POST', timeout: 60000 });
    const probs = []; let dl = null;
    if (resp.status !== 200) { let b = ''; try { b = String(await v2.responseBody(resp.requestId)).slice(0, 300); } catch (e) {} probs.push(`POST /api/report.xlsx → ${resp.status} ${b}`); }
    else { try { dl = await v2.waitForDownload({ ext: '.xlsx', timeout: 20000 }); if (dl.bytes <= 5120) probs.push('download too small ' + J(dl)); } catch (e) { probs.push('download: ' + e.message); } }
    const alerts = await v2.eval(`__cns.alerts.slice()`); if (alerts.length) probs.push('alerts ' + J(alerts));
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `${resp.status} ${resp.mimeType}; ${dl.filename} ${dl.bytes} B`, repro: '[data-act=xlsx]', evidence: [dl.path] };
  }, { retry: 0 });

  await check('no-exceptions', async () => {
    const all = [...ctx.pages.filter(p => p.label.startsWith('v2')).flatMap(p => p.exceptions()), ...ctx.pages.filter(p => p.label === 'classic').flatMap(p => ctx.exceptions(p))];
    const attributed = all.filter(e => /_leaflet_pos/.test(e.text)).length;                 // already failed in replay-dialog
    const ex = all.filter(e => !/_leaflet_pos/.test(e.text));
    if (dialogs.length) throw new Error('native JS dialogs appeared (the seed stubs confirm/alert/prompt): ' + J(dialogs));
    if (ex.length) throw new Error(ex.map(e => e.text.split('\n')[0] + ' @ ' + e.url).join(' || ') + (attributed ? ` (+${attributed} Leaflet _leaflet_pos exceptions counted under replay-dialog)` : ''));
    return `v2 errors ${v2.errors.length}, classic errors ${classic ? classic.errors.length : 0}; exceptions outside replay-dialog: 0 (${attributed} Leaflet _leaflet_pos exceptions counted under replay-dialog); native dialogs 0; browser wedges ${wedges}`;
  }, { retry: 0 });
}
