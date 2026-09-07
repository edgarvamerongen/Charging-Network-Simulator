/* tests/ui/lib.mjs — scenario context (checks, cleanup, evidence) + classic-parity helpers.
   A scenario file exports { component, module, default async run(ctx) }. See tests/ui/README.md. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch } from './cdp.mjs';

const SCRATCH = process.env.CNS_UI_TMP || path.join(os.tmpdir(), 'cns-ui', 'tmp');
export const DEFAULTS = {
  base: process.env.CNS_UI_BASE || 'http://127.0.0.1:5097',
  out: process.env.CNS_UI_OUT || path.join(os.tmpdir(), 'cns-ui', 'out'),
  tmp: SCRATCH,
  watchdogMs: 10 * 60 * 1000
};
const safe = s => String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const trunc = (s, n = 600) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

export const num = s => { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
export const hm = s => { const m = String(s || '').match(/(\d+):(\d\d)/); return m ? +m[1] * 60 + +m[2] : NaN; };   // "1:30" → 90 min
export const close = (a, b, tol = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
/** Drop the client-side annotations (_origin/_dest/_chargerId/_freqN/_freqUnit/_namedDestIdent…) for API deep-equals. */
export const stripApi = r => { if (!r || typeof r !== 'object') return r; const o = {}; for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k]; return o; };
/** Pre-existing exceptions of the CLASSIC shell (templates/index.html is read-only for the v2 campaign) that scenarios must
    not count against v2: `_legEst` reads `plane` before its `const` (index.html:4581-4582) on every live-preview redraw of a
    single-leg RETURN trip (the back-leg label takes the legacy path). State still updates; only the preview label is lost. */
export const KNOWN_CLASSIC_EXCEPTIONS = [/Cannot access 'plane' before initialization[\s\S]*_legEst/];
export const isKnownClassic = e => KNOWN_CLASSIC_EXCEPTIONS.some(re => re.test(e.text || ''));

export function makeCtx({ component, module = '', base = DEFAULTS.base, only = null, out = DEFAULTS.out, tmp = DEFAULTS.tmp } = {}) {
  const outDir = path.join(out, component); fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  const ctx = {
    component, module, base, only, outRoot: out, out: outDir, tmp,
    checks: [], skipped: [], blockedBy: [], pages: [], browsers: [], state: {}, _cleanups: [], _n: 0,
    num, hm, close, stripApi, isKnownClassic,
    /** page.exceptions() minus the documented pre-existing classic ones (KNOWN_CLASSIC_EXCEPTIONS). */
    exceptions: page => page.exceptions().filter(e => !isKnownClassic(e)),
    log: (...a) => console.log(`[${component}]`, ...a),
    shot: name => path.join(outDir, safe(name) + '.png'),

    // ---- browsers + pages ----------------------------------------------------------------
    async browser() {
      const id = `${safe(component)}-${process.pid}-${++ctx._n}`;
      const b = await launch({ profileDir: path.join(tmp, 'profiles', id), downloadDir: path.join(tmp, 'downloads', id) });
      ctx.browsers.push(b); ctx.cleanup(() => b.close());
      return b;
    },
    /** /v2 in a fresh headless Chrome (own profile) unless `browser` is given. */
    async v2Page({ hash, seedLocalStorage, browser, timeout } = {}) {
      const b = browser || await ctx.browser();
      const p = await b.newPage(browser ? `v2-${b.pages.length}` : 'v2'); ctx.pages.push(p);
      await p.goto(base + '/v2', { hash, seedLocalStorage, boot: 'v2', timeout });
      return p;
    },
    /** The classic shell (/?desktop=1) in a second tab of the SAME profile — the behavioural spec. */
    async classicPage(browser, { seedLocalStorage, hash, timeout } = {}) {
      if (!browser) throw new Error('classicPage(browser): pass v2Page().browser');
      const p = await browser.newPage('classic'); ctx.pages.push(p);
      await p.goto(base + '/?desktop=1', { hash, seedLocalStorage, boot: 'classic', timeout });
      return p;
    },
    cleanup(fn) { ctx._cleanups.push(fn); },
    async finish() {
      while (ctx._cleanups.length) { const fn = ctx._cleanups.pop(); try { await fn(); } catch (e) { console.error('cleanup failed: ' + (e.message || e)); } }
    },
    async screenshot(page, name) { const f = ctx.shot(name); try { await page.screenshot(f); } catch (e) { return null; } return f; },

    // ---- checks --------------------------------------------------------------------------
    async check(name, fn, { retry = 1 } = {}) {
      if (only && !name.includes(only)) { ctx.skipped.push(name); return { name, skipped: true, ok: true }; }
      const rec = { name, ok: false, detail: '', repro: '', evidence: [], ms: 0, flaky: false };
      const t0 = Date.now(); let attempt = 0, lastErr = null;
      while (attempt <= retry) {
        try {
          const v = await fn(attempt);
          rec.ok = true; rec.flaky = attempt > 0;
          if (typeof v === 'string') rec.detail = v;
          else if (v && typeof v === 'object' && ('detail' in v || 'repro' in v || 'evidence' in v)) { rec.detail = v.detail == null ? '' : (typeof v.detail === 'string' ? v.detail : JSON.stringify(v.detail)); rec.repro = v.repro || ''; rec.evidence.push(...(v.evidence || [])); }
          else if (v !== undefined) rec.detail = trunc(JSON.stringify(v));
          break;
        } catch (e) {
          lastErr = e; attempt++;
          if (attempt <= retry) { rec.evidence.push(`attempt ${attempt} failed: ${trunc(e.message || e, 300)}`); }
        }
      }
      rec.ms = Date.now() - t0;
      if (!rec.ok) {
        rec.detail = trunc(lastErr && (lastErr.message || lastErr));
        for (const p of ctx.pages) { const f = path.join(outDir, safe(name) + (p.label === 'v2' ? '' : '.' + p.label) + '.png'); try { await p.screenshot(f); rec.evidence.push(f); } catch (e) {} }
        for (const p of ctx.pages) for (const e of p.errors) if (e.t >= t0) rec.evidence.push(`${p.label} ${e.type}: ${trunc(e.text, 300)}`);
      }
      ctx.checks.push(rec);
      console.log(`  ${rec.ok ? 'PASS' : 'FAIL'}${rec.flaky ? ' (flaky)' : ''} ${name} (${rec.ms} ms)${rec.detail ? ' — ' + trunc(rec.detail, 240) : ''}`);
      return rec;
    },
    report(extra = {}) {
      const consoleErrors = []; for (const p of ctx.pages) for (const e of p.errors) consoleErrors.push({ page: p.label, type: e.type, text: trunc(e.text, 500), url: e.url || '' });
      return Object.assign({ component, module, base, catalog: null, checks: ctx.checks, skipped: ctx.skipped, consoleErrors, blockedBy: ctx.blockedBy, durationMs: 0, ok: ctx.checks.every(c => c.ok) }, extra);
    },

    // ---- classic parity helpers ------------------------------------------------------------
    /** Drive the classic form. Order: plane, charger, (trip unless circular), origin, dest, stops, (trip if circular), freq —
        the classic's setDest becomes setStop while the trip is circular, so the ring trip is set last. Idents, not records. */
    async classicSetRoute(page, { o, d, stops = [], plane, charger, trip, freqN, freqUnit } = {}) {
      if (plane) await page.setValue('#plane', plane, ['change']);
      if (charger) await page.setValue('#charger', charger, ['change']);
      // The classic's live-preview redraw can throw a KNOWN pre-existing exception (see KNOWN_CLASSIC_EXCEPTIONS) AFTER the
      // state was updated; run each step inside the page, keep going, and report the messages as `warnings`.
      const step = (label, body) => page.eval(`(function(){ try { ${body} return null; } catch (e) { return ${JSON.stringify(label)} + ': ' + (e && e.message || e); } })()`);
      const warnings = []; const w = async p => { const r = await p; if (r) warnings.push(r); };
      const setTrip = async () => { const has = await page.eval(`!!document.querySelector('.trip-seg-btn[data-trip=${JSON.stringify(trip)}]')`);
        if (has) await w(step('trip', `document.querySelector('.trip-seg-btn[data-trip=${JSON.stringify(trip)}]').click();`)); else await w(step('trip', `const t = document.getElementById('tripType'); t.value = ${JSON.stringify(trip)}; t.dispatchEvent(new Event('change', { bubbles: true }));`)); };
      const need = id => `if (!airportByIdent[${JSON.stringify(id)}]) throw new Error('unknown airport ${id}');`;
      if (trip && trip !== 'circular') await setTrip();
      if (o) await w(step('setOrigin ' + o, need(o) + `window.setOrigin(${JSON.stringify(o)});`));
      if (d) await w(step('setDest ' + d, need(d) + `window.setDest(${JSON.stringify(d)});`));
      for (const s of stops) await w(step('setStop ' + s, need(s) + `window.setStop(${JSON.stringify(s)});`));
      if (trip === 'circular') await setTrip();
      if (freqN != null) await page.setValue('#freqN', String(freqN), ['input', 'change']);
      if (freqUnit) await page.setValue('#freqUnit', freqUnit, ['change']);
      await page.eval(`(function(){ try { map.closePopup(); } catch (e) {} return true; })()`);
      const st = await page.eval(`({ o: selected.origin && selected.origin.ident, d: selected.destination && selected.destination.ident, plane: document.getElementById('plane').value, charger: document.getElementById('charger').value, trip: document.getElementById('tripType').value, freqN: document.getElementById('freqN').value, freqUnit: document.getElementById('freqUnit').value, stops: [...document.querySelectorAll('#stopsContainer .stop-input')].map(i => i.dataset.ident).filter(Boolean) })`);
      const unknown = warnings.filter(x => /unknown airport/.test(x)); if (unknown.length) throw new Error(unknown.join('; '));
      if (o && st.o !== o) throw new Error(`classicSetRoute: origin is ${st.o}, wanted ${o} (${warnings.join('; ')})`);
      if (d && trip !== 'circular' && st.d !== d) throw new Error(`classicSetRoute: destination is ${st.d}, wanted ${d} (${warnings.join('; ')})`);
      if (plane && st.plane !== plane) throw new Error(`classicSetRoute: #plane is "${st.plane}", wanted ${plane} (not an option?)`);
      if (charger && st.charger !== charger) throw new Error(`classicSetRoute: #charger is "${st.charger}", wanted ${charger} (not an option?)`);
      st.warnings = warnings; return st;
    },
    /** Click the classic Simulate; returns { api: lastResult, engine: breakdown, shown: headline texts } (or { error } when the form rejects). */
    async classicSimulate(page, { timeout = 20000 } = {}) {
      await page.eval(`(function(){ lastResult = null; const e = document.getElementById('error'); if (e) e.classList.add('d-none'); document.querySelector('.sim-btn').click(); return true; })()`);
      await page.waitFor(`(lastResult && !document.getElementById('result').classList.contains('d-none')) || (document.getElementById('error') && !document.getElementById('error').classList.contains('d-none'))`, timeout, 100);
      return page.eval(`(function(){ const err = document.getElementById('error'); const t = id => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
        if (!lastResult) return { error: err ? err.textContent.trim() : 'no result', api: null, engine: null, shown: null };
        return { error: null, api: lastResult, engine: _breakdownFromProfile(_engineProfile(lastResult)), shown: { hlUsed: t('hlUsed'), hlFlight: t('hlFlight'), hlTime: t('hlTime'), hlRevenue: t('hlRevenue'), hlRevenueSub: t('hlRevenueSub') } }; })()`);
    },
    /** Click the v2 Simulate (real click); returns { err, api: S.result, engine: plan.derive(), shown: { stats, cost } }. */
    async v2Simulate(page, { timeout = 20000 } = {}) {
      await page.click('[data-act=simulate]');
      await page.waitFor(`(CNSUI.S.rail === 'result' && !!CNSUI.S.profile) || !!CNSUI.S.err`, timeout, 100);
      return page.eval(`(function(){ const S = CNSUI.S; const txt = s => [...document.querySelectorAll(s)].map(e => e.textContent.trim());
        return { err: S.err || null, api: S.result, engine: CNSUI.plan.derive(), shown: { stats: txt('#railBody .stats .v'), cost: (document.querySelector('#railBody .cost .v') || {}).textContent || null, costSub: (document.querySelector('#railBody .cost .m') || {}).textContent || null } }; })()`);
    },
    /** Seed the network via the v2 plan path: per flight {o, d, stops, plane, charger, trip, freq, per} → S.*, simulate, addToNetwork. */
    async seedNetwork(page, flights) {
      const out = [];
      for (const f of flights) {
        const r = await page.evalAsync(`const S = CNSUI.S, by = CNSUI.byId(); const F = ${JSON.stringify(f)};
          if (F.o) S.origin = by[F.o] || null; if (F.d) S.dest = by[F.d] || null; S.stops = (F.stops || []).map(i => by[i]).filter(Boolean);
          if (F.plane) S.planeId = F.plane; if (F.charger) S.chargerId = F.charger; S.trip = F.trip || 'one-way'; S.freq = F.freq || 1; S.per = F.per || 'day';
          if (S.blacklist && S.blacklist.clear) S.blacklist.clear(); if (S.divertOverrides) S.divertOverrides = {};
          CNSUI.plan.onFormChange(false); await CNSUI.plan.simulate(); if (S.err) return { err: S.err, flight: F };
          const before = CNSDemand.loadFolder().length; CNSUI.plan.addToNetwork(); const folder = CNSDemand.loadFolder();
          return { err: null, flight: F, added: folder.length - before, count: folder.length, id: (folder[folder.length - 1] || {}).id };`);
        out.push(r);
      }
      return out;
    }
  };
  return ctx;
}
