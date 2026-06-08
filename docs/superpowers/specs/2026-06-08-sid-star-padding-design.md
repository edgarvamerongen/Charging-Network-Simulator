# SID/STAR padding slider — design spec

**Date:** 2026-06-08
**Branch:** `claude/zealous-mendeleev-a18254` (off `main`, desktop/backend lane)
**Status:** approved (design), pending spec review → implementation plan

Add an opt-in **model factor** that adds a fixed distance (km) to every leg of
every route, modeling Standard Instrument Departure (SID) + Standard Terminal
Arrival (STAR) track miles that don't lie on the great circle. It lives in
**Model settings → "Available range"**, beside the existing Routing-padding
slider.

---

## 0. Decisions (locked)

| decision | choice | why |
|----------|--------|-----|
| relationship to existing `routingPadding` (×) | **add as a separate slider** | the two model genuinely different things: a % airways detour that scales with cruise distance vs. a roughly fixed terminal-procedure distance at each end. Nothing existing changes. |
| math composition | `distKm = rawKm × routingFactor + sidStarKm` | apply the % to the great-circle length, then add the fixed terminal km on top |
| granularity | **per leg** | one leg = one departure (SID) + one arrival (STAR) = exactly one pad. "+km to each leg" is satisfied by the existing per-leg loop. |
| range | **5–50 km**, step 5 | per request |
| default state | **OFF**, slider starts at **10 km** | routing padding is already ON and already nominally covers SID/STAR; defaulting this ON would double-count and shift every existing plan + force golden regeneration. As a new factor it is opt-in. With it OFF the model is byte-identical to today. |
| `sim.py` | **untouched** | `sim.py` is the deliberately-raw model and already ignores `routingPadding`; SID/STAR stays JS-only to match that scope. |
| mobile | **untouched** | `mobile.js` / `mobile.css` / `index_mobile.html` are the mobile session's lane. |

---

## 1. Architecture & data flow

The energy/charging model is computed **browser-side** by `CNSFlight`
(`static/flight-model.js`). Every consumer — the result panel, demand
calculator, scheduler, animation, and the **PDF report** (built from `CNSFlight`
profiles in `report.js`, then typeset by a physics-free `report.py`) — reads the
profile's already-padded `distKm` / `energyKwh` / charge figures. Therefore a
single change at the leg-distance line in `flight-model.js` cascades everywhere
automatically; no downstream consumer needs editing.

The one place that computes distance **independently of the profile** is the
routing-reach math (the multi-stop planner's `maxLeg` and the "over available
range" warnings). It must subtract the fixed pad too, or the planner would
propose legs the energy model then flags as over-range.

```
CNSSettings.sidStarPaddingKm()  ── identity 0 when OFF ───────────────┐
                                                                       │
flight-model.js  simulateTrip():                                       │
    distKm = rawKm × route + sidStar   ← core injection ──────────────┤→ profile.legs[].distKm/energyKwh
    availRangeKm = max(0, range·usable − sidStar) / route             │   → charges, phases, totals
                                                                       │   → scheduler / demand / report.js / PDF
index.html  _availableRangeKm():                                       │   → animation
    (range·usable − sidStar) / route   ← router + over-range warnings ─┘
routing.js  default maxLeg (belt-and-suspenders)
```

---

## 2. Components & exact touch-points

### 2.1 `static/settings.js` — the factor

- **DEFAULTS** (after the `routingPadding` line, ~`:54`):
  ```js
  sidStarPadding: { enabled: false, km: 10 },   // ≥0; fixed km added to each leg (SID+STAR)
  ```
  No storage-key bump needed. `loadAll()` already merges `DEFAULTS` under saved
  blobs ("fill in any new keys"), so existing `cns_settings_v3` users transparently
  pick up the new key in its default-OFF state. (Contrast the 2026-06-03 spec,
  which bumped the key only because it *changed existing* defaults to ON.)

- **Accessor** (after `routingFactor()`, ~`:125`):
  ```js
  /** Fixed km added to EACH leg to approximate SID/STAR terminal track miles.
   *  0 when off (identity); clamped to the slider's [5,50] when on. Additive,
   *  applied AFTER the routingPadding multiplier:
   *  distKm = rawKm·routingFactor + sidStarPaddingKm. Mirrors routingFactor()'s
   *  "identity when off, clamp to UI range when on" shape. */
  function sidStarPaddingKm() {
      const s = loadAll().sidStarPadding;
      if (!s || !s.enabled) return 0;
      return Math.max(5, Math.min(50, +s.km || 10));
  }
  ```

- **`activeFlags()`**: add `sidStarPadding: !!(s.sidStarPadding && s.sidStarPadding.enabled)`
  and OR it into `anyOn`.

- **Module exports**: add `sidStarPaddingKm`.

### 2.2 `static/flight-model.js` — apply to energy model

- Wrapper next to `_routingFactor()` (~`:35`):
  ```js
  function _sidStarKm() { const s = _settings(); return s && s.sidStarPaddingKm ? s.sidStarPaddingKm() : 0; }
  ```
- In `simulateTrip()`:
  - capture once near `const route = _routingFactor();` (~`:64`): `const sidStar = _sidStarKm();`
  - **leg loop** (~`:135`): `const distKm = rawKm * route + sidStar;`  *(was `rawKm * route`)*
  - **reach field** (~`:74`): `const availRangeKm = (range > 0 && route > 0) ? Math.max(0, range * usableFrac - sidStar) / route : 0;`
  - record it on the profile for transparency (~`:87`): add `sidStarKm: sidStar` beside `routingFactor: route`.
- **Training pattern is excluded.** The training branch (~`:94–121`) leaves
  `distKm`/energy on the unpadded pattern distance; do **not** add `sidStar`
  there (circuits at one field have no SID/STAR — consistent with training
  distance already being unpadded for energy, per the G4a/R7 comments).

### 2.3 `templates/index.html` — reach consistency + UI

- **`_availableRangeKm(plane)`** (~`:2124`): subtract the pad from usable range
  before dividing by `route`:
  ```js
  const sid = (window.CNSSettings && CNSSettings.sidStarPaddingKm) ? CNSSettings.sidStarPaddingKm() : 0;
  return _availRangeOverride != null ? _availRangeOverride
       : Math.max(0, p.range_km * _usableFrac(p) - sid) / route;
  ```
  This single helper feeds the router (`maxLegKm`) and the over-range warnings at
  `:2053`, `:2156`, `:3278`, keeping them aligned with the energy model.

- **Modal markup** — new `.rs-cell` immediately after the Routing-padding cell
  (~`:1692`), mirroring its structure:
  ```html
  <div class="rs-cell">
    <div class="rs-cell-head">
      <label class="rs-toggle"><input type="checkbox" id="rsSidStar"><span>SID/STAR padding</span></label>
      <span class="rs-q" tabindex="0" data-bs-toggle="tooltip"
            data-bs-title="Fixed distance added to every leg for SID departure + STAR arrival track miles (terminal-area routing not on the great circle). Adds on top of routing padding.">?</span>
    </div>
    <div class="rs-cell-ctrl">
      <input type="range" id="rsSidStarSl" min="5" max="50" step="5" value="10" class="form-range">
      <span class="rs-val" id="rsSidStarVal">+10 km</span>
    </div>
  </div>
  ```

- **Settings `map`** (~`:4026`) — new entry; save/load/subscribe wiring is then automatic:
  ```js
  sidStarPadding: {
    check: 'rsSidStar',
    extras: { km: { input: 'rsSidStarSl', valEl: 'rsSidStarVal',
                    fmt: (v) => `+${v} km`, to: (v) => v, from: (v) => v } }
  }
  ```
  (Settings value === HTML value for km, so `to`/`from` are identity, unlike the
  percent sliders that ÷100.)

### 2.4 `static/routing.js` — default reach (secondary)

- Default `maxLeg` (~`:77–78`) gets the same subtraction, for the rare path
  where a caller does **not** pass `maxLegKm`:
  ```js
  const sid = (window.CNSSettings && CNSSettings.sidStarPaddingKm) ? CNSSettings.sidStarPaddingKm() : 0;
  const maxLeg = options.maxLegKm != null ? options.maxLegKm
               : Math.max(0, rng * usable * (1 - options.reservePct) - sid) / route;
  ```
  The primary callers in `index.html` already pass `maxLegKm: _availableRangeKm(plane)`,
  so this is belt-and-suspenders.

---

## 3. Out of scope / unchanged

- `sim.py`, `app.py`, `report.py` — no edits (raw model + physics-free PDF typesetter).
- `static/mobile.js`, `static/mobile.css`, `templates/index_mobile.html` — mobile lane.
- `scheduler.js`, `demand.js`, `report.js`, `animation.js` — inherit the pad via
  the profile; no direct edits. (`scheduler.js:144 _route()` is a routing-factor
  helper unrelated to this fixed pad.)

---

## 4. Testing

TDD-first in `tests/js_settings.test.mjs` (Node, loads `settings.js`):

1. `sidStarPaddingKm()` returns `0` when `enabled:false` (default).
2. When enabled: returns the set km; clamps below 5→`5` and above 50→`50`;
   non-numeric km falls back to the `10` default (mirrors `routingFactor()`).
3. With the factor ON at `k` km, a single leg's `distKm` equals
   `rawKm·routingFactor + k` and `energyKwh` equals `ePerKm·distKm`. Prefer
   asserting the accessor + the documented formula directly in
   `js_settings.test.mjs`; if a `simulateTrip` fixture is already wired (see
   `tests/js_flight_model.test.mjs`), add the integration assertion there.
4. Regression: with the factor OFF, `simulateTrip` output is identical to a
   pre-change baseline (guards the default-OFF promise).

**Goldens:** unchanged. The default is OFF and every new formula reduces to the
old one at `sidStar = 0` (`rawKm·route + 0`, `max(0, range·usable − 0)/route`),
so `tests/goldens/*` need no regeneration. Run the full suite (`tests/run_all.sh`)
to confirm Python + JS stay green.

---

## 5. Verification checklist (before PR)

- [ ] `tests/run_all.sh` green (Python + JS, goldens unchanged).
- [ ] App boots; Model-settings modal shows the new slider under Routing padding;
      toggle + slider update the `+N km` label and persist across reload.
- [ ] With it ON at 50 km on a near-range route: leg distance/energy/charge-time
      rise, and the planner inserts a stop / shows the over-range warning
      consistently (router and energy model agree).
- [ ] With it OFF: numbers identical to before (spot-check one saved plan).
- [ ] PDF export reflects the pad when ON (it flows through the profile).
- [ ] `git diff --stat main..HEAD` shows ONLY: `static/settings.js`,
      `static/flight-model.js`, `static/routing.js`, `templates/index.html`,
      `tests/js_settings.test.mjs`, this spec. No mobile / no `sim.py`.

---

## 6. PR

PR `claude/zealous-mendeleev-a18254` → `main`, desktop/backend lane. Description
covers the additive-vs-multiplicative distinction, the default-OFF rationale, and
a before/after of the Model-settings panel.
