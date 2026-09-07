# tests/ui — browser harness for the v2 shell (classic = the spec)

Dependency-free: Node ≥ 22 built-ins (`WebSocket`, `fetch`, `child_process`) talking raw CDP to
headless Google Chrome (`/Applications/Google Chrome.app/…`, override with `CNS_CHROME`). No npm.

## Run

```bash
bash tests/ui/server.sh start|status|restart|stop     # ONE shared Flask server on :5097 (from this worktree)
export CNS_UI_TMP=<scratch>/ui-tmp CNS_UI_OUT=<scratch>/ui-out   # profiles/downloads · reports/screenshots
node tests/ui/run.mjs smoke                            # one scenario = one component
node tests/ui/run.mjs map --only dot-click             # substring filter on check names (others are recorded as skipped)
node tests/ui/run.mjs network --base http://127.0.0.1:5097
```

`run.mjs` writes `$CNS_UI_OUT/<component>.json`, prints `@@REPORT@@{json}` as the LAST stdout line and exits 1
if any check failed (or the scenario threw → a synthetic `scenario-crashed` check). A watchdog kills a run after
10 min (`CNS_UI_TIMEOUT` ms). Failing checks get a screenshot per open page in `$CNS_UI_OUT/<component>/<check>.png`
(`<check>.classic.png` for the classic tab) plus the console/exception lines raised during the check.

Report shape: `{component, module, base, catalog:{planes, ids}, checks:[{name, ok, detail, repro, evidence, ms, flaky}],
skipped, consoleErrors:[{page, type, text, url}], blockedBy, durationMs, ok}`.

## Writing a scenario — `tests/ui/scenarios/<component>.mjs`

```js
export const component = 'map';        // report name
export const module = 'map';           // fix-wave module (map | plan | network | shell)
export default async function run(ctx) {
  const v2 = await ctx.v2Page({ hash: 'result', seedLocalStorage: { cns_units: 'nm' } });   // fresh Chrome + profile
  const classic = await ctx.classicPage(v2.browser);                                        // same profile ⇒ same localStorage
  await ctx.check('name', async () => { …; return { detail, repro, evidence: [ctx.shot('x')] }; }, { retry: 0 });
  ctx.cleanup(async () => { /* LIFO, always runs, even after a crash */ });
}
```

### ctx
| member | what |
|---|---|
| `base`, `out`, `outRoot`, `tmp`, `state` | server URL · `$CNS_UI_OUT/<component>` · `$CNS_UI_OUT` · scratch · free-form bag between checks |
| `v2Page({hash, seedLocalStorage, browser})` | launches Chrome (own profile + download dir) unless `browser` is given, opens `/v2`, waits for the v2 boot predicate, hooks map move/zoom into `__cns.moving` |
| `classicPage(browser, {seedLocalStorage})` | second tab in the SAME profile at `/?desktop=1`, waits for `airportByIdent` + `lastResult` |
| `check(name, fn, {retry:1})` | records `{name, ok, detail, repro, evidence, ms, flaky}`; `fn` may return a string (detail) or `{detail, repro, evidence}`; a throw = fail; passing on the retry marks `flaky`. Use `retry:0` for checks with side effects. `--only` skips non-matching names |
| `cleanup(fn)` | LIFO, always runs (`ctx.finish()`), e.g. DELETE the `UI-TEST-…` custom charger you created |
| `screenshot(page, name)` / `shot(name)` | write / path of `$CNS_UI_OUT/<component>/<name>.png` |
| `classicSetRoute(page, {o, d, stops, plane, charger, trip, freqN, freqUnit})` | idents; uses `window.setOrigin/setDest/setStop`, `#plane/#charger` value+change, `.trip-seg-btn[data-trip]` click (else `#tripType`), `#freqN` input+change, `#freqUnit` change. Circular is set AFTER the airports (the classic turns `setDest` into `setStop` in ring mode) |
| `classicSimulate(page)` | `lastResult = null; .sim-btn.click()` → `{error, api: lastResult, engine: _breakdownFromProfile(_engineProfile(lastResult)), shown: {hlUsed, hlFlight, hlTime, hlRevenue, hlRevenueSub}}` |
| `v2Simulate(page)` | real click on `[data-act=simulate]` → `{err, api: S.result, engine: CNSUI.plan.derive(), shown: {stats[], cost, costSub}}` |
| `seedNetwork(page, [{o, d, stops, plane, charger, trip, freq, per}])` | sets `S.*`, `await CNSUI.plan.simulate()`, `CNSUI.plan.addToNetwork()` per flight → `[{err, added, count, id}]` |
| `exceptions(page)` | `page.exceptions()` minus `KNOWN_CLASSIC_EXCEPTIONS` (exported; `isKnownClassic(e)`) — use it for "zero exceptions" checks on the classic tab |
| `num(s)`, `hm(s)`, `close(a, b, tol)`, `stripApi(r)` | first number in a string (commas stripped) · `"1:30"` → 90 · abs tolerance · drop `_origin/_dest/_chargerId/_freqN/_freqUnit/…` (every `_`-key) |

### page (tests/ui/cdp.mjs)
`goto(url, {hash, seedLocalStorage, boot:'v2'|'classic'|null, timeout})` · `eval(expr, {timeout})` (JSON, throws on exceptions, `userGesture`) ·
`evalAsync(body)` · `waitFor(predicateExpr, timeout=10000, every=100)` (throws with the last value) · `waitForMapIdle()` ·
`rect(sel)` → `{x,y,w,h,cx,cy,covered,topTag}` · `click(sel)` / `clickAt(x,y,{button,clickCount})` — REAL `Input.dispatchMouseEvent` ·
`drag(x0,y0,x1,y1,steps)` · `type(text)` (per-char key events → `input` fires) · `press('Enter'|'Escape'|'ArrowDown'|'k', modifiers)` (`MOD.Meta`=4 …) ·
`setValue(sel, value, events)` · `focus(sel)` · `waitForResponse(urlPart, {since, timeout, method})` (`since` = `page.responses.length` snapshot) ·
`responseBody(requestId)` · `waitForDownload({timeout, ext})` → `{filename, bytes, path}` · `screenshot(file)` ·
`errors` (exceptions + console error/warning + Log error entries such as app-served 404s) · `exceptions()` · `console` · `responses` · `failed` · `blocked` · `clearErrors()` ·
`mapPoint(ident)` → `{ident,type,x,y,zoom,inView,asset,topTag,topPane}` · `pickClickableDots(n)`.

Seed (every navigation): `localStorage.cns_welcome_hide='true'`, `cns_tour_done='true'` (+ your `seedLocalStorage`, JSON-stringified; `null` removes),
`window.__cns = {confirms, alerts, prompts, clip, confirmResult:true, promptResult, moving}` with `confirm/alert/prompt` stubs and a
`navigator.clipboard` stub (`__cns.clip.at(-1)` is the last copied text).

## Pitfalls
- **Real input, not `.click()`.** `page.click`/`clickAt` dispatch OS-level mouse events; `page.click` throws when the target is covered
  (`rect().covered`) — pass `{force:true}` if the cover is the point. Prefer `page.type` over `setValue` when the test is about focus/autocomplete.
- **Wait for the map.** `flyTo`/`fitBounds` animate; `await page.waitForMapIdle()` before `mapPoint`/`pickClickableDots`. `flyTo` opens its own popup after 400 ms — `CNSUI.map.map.closePopup()` before a click test.
- **The classic tab shares localStorage** with the v2 tab (same profile): the network folder, settings, units and `cns_map_options` are visible to both.
  Both listen to `storage` events, so a write in one tab re-renders the other. Give each scenario its own Chrome (`ctx.v2Page()` does) — never share a profile across scenarios.
- **Server state is shared by every scenario** (one Flask on :5097; `data/custom_chargers.json` cap 5; `data/shares.db` append-only). Name what you create
  `UI-TEST-r1-0904-…` and delete it in `ctx.cleanup`. Never delete shares.
- **Blocked hosts**: tiles (arcgis/carto), Google fonts and `/api/airport-photo/*` fail with `BlockedByClient` — expect `Network.loadingFailed`
  entries (`page.failed`), never console errors. Leaflet/driver.js/bootstrap still load from their CDNs (network required).
- **Template edits need `bash tests/ui/server.sh restart`**; `static/**` is served fresh (`Network.setCacheDisabled`). The catalog is
  `data/planes.generated.json` (production copy, 18 aircraft, `image_url` for 13); `sim.py` reloads on mtime.
- **Boot predicates**: v2 = `CNSUI.map.map && airports().length > 100 && #railBody.children.length`; classic = `airportByIdent` > 100 and `lastResult` defined.
  Top-level `let/const` of the classic (`lastResult`, `airportByIdent`, `selected`) are reachable from `page.eval` (global lexical scope).
- **Downloads**: Chrome saves into the browser's download dir; `waitForDownload` returns each completed download once. The
  report/xlsx buttons POST — `waitForResponse('/api/report.pdf', {since})` checks the status separately.
- **Known classic exception (pre-existing, read-only file):** `ReferenceError: Cannot access 'plane' before initialization at _legEst`
  (`templates/index.html:4581-4582`, TDZ) fires on every live-preview redraw of a single-leg **Return** trip in the classic — after
  `setOrigin/setDest/setStop`, a trip click or a plane change. The state still updates (only the preview label is lost);
  `classicSetRoute` catches it and returns it in `warnings`; filter it with `ctx.exceptions(page)` / `isKnownClassic`. Never count it against v2.
- **Retries re-run side effects.** Default `retry:1`; pass `{retry:0}` for anything that mutates (adds flights, creates chargers).
- **The tour is out of scope**: never click `#tourBtn`, never start `CNSUI.tour`; `cns_tour_done` is seeded so it cannot auto-start.
- Only 127.0.0.1 URLs. Profiles live under `$CNS_UI_TMP/profiles` and are deleted on `browser.close()` (`{keepProfile:true}` to inspect).
