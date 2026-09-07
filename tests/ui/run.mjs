#!/usr/bin/env node
/* tests/ui/run.mjs — run one UI scenario against the shared local server.
   node tests/ui/run.mjs <component> [--only <check-substring>] [--base <url>]
   Prints the JSON report as the last stdout line prefixed @@REPORT@@, writes $CNS_UI_OUT/<component>.json,
   exits 1 if any check failed (or the scenario crashed). */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeCtx, DEFAULTS } from './lib.mjs';

const argv = process.argv.slice(2);
const component = argv.find(a => !a.startsWith('--'));
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!component) { console.error('usage: node tests/ui/run.mjs <component> [--only <check>] [--base <url>]'); process.exit(2); }
const base = opt('--base') || DEFAULTS.base, only = opt('--only') || null;
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'scenarios', component + '.mjs');
if (!fs.existsSync(file)) { console.error('no scenario file: ' + file); process.exit(2); }

const t0 = Date.now();
let health; try { health = await fetch(base + '/healthz').then(r => r.status); } catch (e) { health = 'down: ' + e.message; }
if (health !== 200) { console.error(`server at ${base} is not healthy (${health}) — bash tests/ui/server.sh start`); process.exit(2); }
let catalog = { planes: null, ids: [] };
try { const h = await fetch(base + '/v2').then(r => r.text()); const i = h.indexOf('planes: ') + 8, j = h.indexOf('\n  chargers:'); const pl = JSON.parse(h.slice(i, j).trim().replace(/,$/, '')); catalog = { planes: pl.length, ids: pl.map(p => p.id) }; } catch (e) { console.error('catalog parse failed: ' + e.message); }

const mod = await import(pathToFileURL(file).href);
const ctx = makeCtx({ component, module: mod.module || '', base, only });
const watchdog = setTimeout(() => { console.error('@@WATCHDOG@@ scenario exceeded ' + DEFAULTS.watchdogMs + ' ms'); ctx.finish().finally(() => process.exit(1)); }, +process.env.CNS_UI_TIMEOUT || DEFAULTS.watchdogMs);
let crashed = null;
try { await (mod.default || mod.run)(ctx); } catch (e) { crashed = e; console.error('scenario crashed: ' + (e.stack || e)); ctx.checks.push({ name: 'scenario-crashed', ok: false, detail: String(e.message || e), repro: '', evidence: [String(e.stack || '').split('\n').slice(0, 6).join(' | ')], ms: 0, flaky: false }); }
finally { clearTimeout(watchdog); await ctx.finish(); }

const report = ctx.report({ component: mod.component || component, catalog, durationMs: Date.now() - t0 });
fs.mkdirSync(ctx.outRoot, { recursive: true });
fs.writeFileSync(path.join(ctx.outRoot, component + '.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(c => !c.ok).length;
console.log(`\n${component}: ${report.checks.length - failed}/${report.checks.length} checks passed${report.skipped.length ? ` (${report.skipped.length} skipped by --only)` : ''}, ${report.consoleErrors.length} console errors, ${report.durationMs} ms → ${path.join(ctx.outRoot, component + '.json')}`);
console.log('@@REPORT@@' + JSON.stringify(report));
process.exit(failed || crashed ? 1 : 0);
