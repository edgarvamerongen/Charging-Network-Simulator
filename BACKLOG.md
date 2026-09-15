# CNS Backlog

The 2026 rollout (branding / units / airport-data / result-panel /
model-settings / pdf / map-labels / training-range / airport-db) shipped as
14 tasks across orthogonal cluster branches; the per-cluster plan and gates
live in git history, not here.

## Added during rollout
- **Charging model — charge-to-reach option (raised 2026-06-04, result-panel review):**
  today every stop (intermediate *and* termini) charges to the global SoC target, so a
  quick mid-route stop tops up to e.g. 80% even when the next leg needs little. Option:
  intermediate/en-route stops charge **only enough for the next leg + landing reserve**;
  **only the destination/home hit the target**. More realistic, less dwell. Model-wide:
  `scheduler.js recomputeMultiLegCharges` (forward walk) + `demand.js deliveredEnergy`;
  cascades to DES + demand calculator + PDF. Prefer a **Model-settings toggle**
  (charge-to-target vs charge-to-reach) over replacing current behaviour outright.
- **planes.json `max_kw` → retire `c_rate` (raised 2026-06-04, model-settings review):**
  add an explicit per-aircraft **`max_kw`** (max accepted charge power) to `planes.json` and
  cap charging at `min(chargerKw, plane.max_kw)`. Then remove `c_rate` / `chargeTaper.cRate`
  entirely (`settings.js effectiveChargePower`, the DEFAULT + accessor) — the C-rate slider
  was already pulled from Model settings as redundant; the model still uses the 2.0C default
  until `max_kw` replaces it.
- **Available-range override → battery-used % (raised 2026-06-05, plane-card review):**
  the per-flight "available range" override (Edit for this flight) currently only shrinks the
  planner's reach. In reality a *smaller* edited range means a *smaller* slice of the battery is
  used (more reserve left). Future: convert the edited available range into a "fraction of
  battery used" and feed that into the charging calc (less energy delivered, shorter dwell) so
  the demand/charging numbers stay realistic — not just the routing reach.
