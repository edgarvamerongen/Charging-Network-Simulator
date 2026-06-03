---
description: Reconcile the guided onboarding tour with the current app UI
---

# Update the tour

The onboarding tour (`static/tour.js`, driven by Driver.js) walks a new user
top-to-bottom through the app: Create-a-route form → Simulate → result panel →
Demand Calculator → scheduler → PDF → Overview animation. As the app's markup and
copy evolve, tour steps drift — anchors break, descriptions go stale, new
features get no step. This command refreshes the tour to match the current app.

Work on the `tour` branch (cut a fresh one off `main` if needed). Do **not**
commit unless the user asks.

## Procedure

1. **Start the app** on port 5055 and open it in the browser/preview:
   `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python app.py`
   → http://127.0.0.1:5055  (Flask debug is off → restart after template edits;
   `static/*.js` edits just need a browser reload.)

2. **Find drift.** In the page console (or `preview_eval`) run:
   `CNSTour.check()`
   It returns `{ step, title, element, found }` for every step. Any `found:false`
   whose `element` does **not** start with `#folder ` is a BROKEN anchor that must
   be fixed. (`#folder …` anchors only resolve mid-tour once the demand drawer has
   rendered flights — they read false at start, which is expected.)

3. **Reconcile each step.** The `_steps()` array in `static/tour.js` is the source
   of truth. Open it alongside `templates/index.html`. For every broken/stale step:
   - Repoint `element` to the current DOM — prefer a stable `#id`. If the markup
     has no stable hook, add an `id` in `index.html` rather than a brittle
     structural/class selector.
   - Refresh `title` / `description` copy if the feature changed.
   - Update `onHighlightStarted` side-effects if the interaction changed (e.g. a
     toggle moved, a button renamed).

4. **Check for NEW features** worth a step. Skim the Create-a-route form and the
   Demand Calculator for controls added since the tour last changed. Insert steps
   in the form's visual top-to-bottom order (that ordering is a hard rule — see
   the existing sequence: Departure → +Add stop → Destination → Trajectory →
   Trip type → Aircraft → Model settings → Plan-with-charging → Suggested route →
   Frequency → Charger → Simulate).

5. **Verify in the browser.** Replay the whole tour:
   `CNSTour.reset(); CNSTour.start();`
   then advance with the Next button (`.driver-popover-next-btn`), screenshotting
   key steps. Confirm:
   - every spotlight lands on its element, order is top-to-bottom;
   - the "Plan with charging stops" step toggles stops ON on arrival, and the
     Siegerland stop appears;
   - the "Overview" step seeds the real network (≈6 flights out of Lelystad) and
     the flights map fits to them;
   - `CNSTour.check()` reports no missing static anchors;
   - the console shows no `[CNSTour]` warnings and no errors.

6. **Report** what drifted and what changed. Leave it uncommitted for the user to
   test, unless they said to commit.

## Conventions / gotchas

- Tour CSS is in `templates/index.html` (`.cns-tour-*`, `.tour-lead-*`).
- `allowClose: false` + `showButtons: ['next','previous','close']` — clicking
  outside must NOT end the tour; the × / Esc are the deliberate exits. Keep it.
- The demo seed is `_seedDemoForm()` (Lelystad → Frankfurt, Beta Alia). The
  Overview network is `_seedNetworkFlights()` — it routes each flight through
  `CNSRouting.planRoute` and `/api/simulate` so they're physically valid; stops
  carry `.lat`/`.lon` (NOT `.latitude_deg`).
- Realistic model factors (reserve, padding, taper, 80% charge target) are ON by
  default — that's why the Beta needs a charging stop; the tour explains this.
