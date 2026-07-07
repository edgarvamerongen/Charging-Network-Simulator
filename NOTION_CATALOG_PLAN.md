# Notion Aircraft Catalog — Complete Integration Plan

**Status:** approved by Edgar, not yet implemented. Phase 0 (Notion setup) is
in progress on Edgar's side.
**Written:** 2026-07-07 by a Claude session, as a handoff guide for a future
session (Opus) that will implement it. Revised same day after Edgar's review —
see D9/D10. Decisions below are LOCKED with Edgar — do not re-litigate them;
implement them.
**Lane:** backend/desktop (per CLAUDE.md worktree rules). Everything here is
backend-lane work: `sim.py`, `app.py`, new `notion_sync.py`, `tests/`,
`static/settings.js`, desktop `templates/index.html`.

---

## 0. Read this first (for the implementing session)

1. **Phantom-file warning.** An earlier draft plan referenced `plane_schema.py`,
   `static/plane-schema.js`, `planes.schema.json`, `validate_planes.py`,
   `field_performance.py`, a `measurements[]` model, `docs/DATABASE_PLAN.md`,
   and "PR #30". **None of these exist anywhere in git history** (verified
   2026-07-07: not tracked, not in any branch, not in stashes). Do not hunt for
   them and do not treat them as dependencies. Build fresh per this document.
2. `docs/` is **gitignored** (`.gitignore:27`) — that's why this plan lives at
   the repo root. Don't move it into `docs/`.
3. `data/` is gitignored (`.gitignore:20`) — all generated artifacts below live
   there deliberately.
4. The implementing session has **no SSH to the VPS**. Every command that must
   run on the VPS is collected in §12 (runbook) for Edgar to execute. Write
   code + docs; Edgar deploys.
5. **Secrets:** the Notion integration secret (`CNS_NOTION_TOKEN`) lives ONLY
   in `/etc/cns.env` on the VPS. Never commit it, never write it into this
   repo, never echo it into files. (The integration already exists — named
   **CNS-Connector**, workspace **NRG2fly**, token verified working
   2026-07-07.)

## 1. Goal & locked decisions

**Goal:** the aircraft catalog becomes editable by non-dev colleagues, readable
by everyone, and the CNS consumes it automatically — **replacing** the
hand-edited `planes.json` workflow and the in-app custom-planes overlay
entirely.

Decisions locked with Edgar (2026-07-07):

| # | Decision | Choice |
|---|----------|--------|
| D1 | Source of truth | **Notion** (master). CNS only reads. No self-hosted DB (VPS has no Docker; Notion natively covers editing + reading + sharing). |
| D2 | Data model | **Two Notion databases**: Aircraft (intrinsic) + Performance Profiles (conditional, many per aircraft). Coarse profiles (one row per operating case), NOT one-row-per-measurement. |
| D3 | Range semantics | **Per-profile regime**: each profile row declares `VFR` or `IFR+reserves` and carries ONE range figure; the sim uses that profile's range as `range_km`. An aircraft with both VFR and IFR figures = two profile rows. |
| D4 | Notion DB creation | **Edgar creates the databases with Notion's AI assistant** using the prompt in Appendix A, then shares both with CNS-Connector and copies the two database IDs into `/etc/cns.env`. |
| D5 | In-app custom planes | **Deleted at cutover** (phase 3). Custom **chargers** feature stays — only the planes side goes. |
| D6 | Tracked `planes.json` | **Deleted at cutover** (phase 3), together with the loader fallback. No multi-week confidence period. |
| D7 | Validation failures | **Per-aircraft quarantine with carry-forward** (§8), not all-or-nothing. |
| D8 | Chargers catalog | Stays in `chargers.json` (dev-managed) for now. Aircraft↔charger link lives in Notion as a multi-select of charger ids. Moving chargers to Notion is a possible later phase, same pattern. |
| D9 | **No legacy-compat constraint.** | The tool has not shipped — there are no users, saved links, or results to protect. The generated catalog does NOT need to reproduce today's `planes.json` values; seeds use best-known real figures; verification is **functional**, not byte-comparison. Optimize the end-state; leave no shrapnel from the old system. |
| D10 | Catalog visibility | Aircraft rows carry a **`Show in CNS` checkbox**; unchecked aircraft (and their profiles) are silently excluded from the sync output. This is how colleagues stage "planes to come". |

## 2. Verified current state (file:line, checked 2026-07-07)

- `sim.py:23-31` — `Simulator.__init__` loads `planes.json` + `chargers.json`
  from `base_dir` **once at startup**; lookups are linear scans by `id`
  (`sim.py:70`, `sim.py:246`).
- `app.py:44` — one module-level `Simulator(base_dir=<app dir>)`.
- `app.py:417,434,561` — planes are injected **server-side into templates**
  (`render_template(..., planes=simulator.planes)`); desktop + mobile + share
  views. `app.py:927` — `/api/import` builds `planes_by_id` from
  `simulator.planes`.
- `app.py:184-188, 707-831` — the "custom planes/chargers" overlay:
  `data/custom_planes.json` (cap 5) with GET/POST/DELETE under
  `/api/custom/planes`, plus logging. Client-side merge lives in
  `static/planes.js` / `static/settings.js`. The planes half of this is what
  phase 3 deletes.
- `app.py:908-917` — `/api/import` bearer-token pattern: `_IMPORT_TOKEN` +
  `hmac.compare_digest`. **Mirror this exact mechanism** for the sync endpoint.
- `gunicorn.conf.py` — **2 workers × 4 gthreads**, bind `127.0.0.1:5055`,
  fronted by **Caddy** (not nginx). Service logs via `journalctl -u cns`.
  ⚠️ Multi-worker means an in-process reload in one request only refreshes ONE
  worker → the loader must do mtime-based reloads (§9).
- Images: `pics/` (e.g. `pics/pipistrel.jpg`), SVGs in `pics/plane_svgs/`.
  (An earlier draft said `static/pics` — wrong.)
- Current catalog: 5 entries in `planes.json`. Note `vaeridion` and
  `vaeridion_light` are the **same airframe** as two entries — they become one
  Aircraft + two Profiles. `elysian_e9x` has **no** `default_charger_id` and
  carries `simultaneous_charging {enabled, max:2}`. `pipistrel_velis` carries
  `training_range_km`.
- `static/tour.js` seeds demo flights with specific plane ids (Beta Alia), and
  test goldens under `tests/goldens/` bake in plane data. The seed rows keep
  today's emit ids (`pipistrel_velis`, `beta_plane`, `vaeridion`,
  `vaeridion_light`, `elysian_e9x`) — not for compat with shipped users (none
  exist, D9) but because renaming buys nothing and would force tour/golden
  churn. From phase 1 on, emit ids should stay stable.

## 3. Target architecture

```
  Notion (master)                     VPS                            CNS app
┌─────────────────────┐   REST   ┌──────────────────────────┐ file ┌───────────────────────┐
│ Aircraft DB         │ ───────► │ notion_sync.py           │ ───► │ sim.py loads          │
│ Performance Profiles│  pull    │  pull → transform →      │      │ data/planes.generated │
│ (colleagues edit)   │          │  validate/quarantine →   │      │ .json; reloads on     │
└─────────────────────┘          │  atomic write + snapshot │      │ mtime change          │
                                 │  + data/sync_report.json │      └───────────────────────┘
        triggers: CLI (phase 1) · POST /api/admin/sync-catalog (phase 2) · systemd timer (phase 2)
```

End-state (post-cutover): `data/planes.generated.json` is the **only** catalog
the app reads. No tracked `planes.json`, no fallback branch, no custom-planes
overlay. A fresh deploy runs one sync as a setup step; a missing catalog fails
fast with an actionable error. Properties preserved: load-once/no-per-request-IO
(mtime stat is ~µs), works through Notion outages (last-good file + snapshots),
a bad Notion edit can never take the app down (§8).

## 4. Notion workspace setup (phase 0 — Edgar, mostly done)

1. ✅ Internal integration **CNS-Connector** exists (workspace NRG2fly; token
   verified 2026-07-07). Secret → `CNS_NOTION_TOKEN` in `/etc/cns.env` ONLY.
2. Create the two databases by pasting the **Appendix A prompt** into Notion's
   AI assistant, then run the 30-second verification checklist (Appendix A.2)
   — AI output must be checked because the sync matches properties **by exact
   name**.
3. Share both databases with the integration: ••• → Connections →
   CNS-Connector. (As of 2026-07-07 the integration can see nothing — this
   step is what fixes that.)
4. Copy both database IDs (the 32-hex segment of each DB's URL) →
   `CNS_NOTION_AIRCRAFT_DB`, `CNS_NOTION_PROFILES_DB` in `/etc/cns.env`.
5. Seed rows are created by the same Appendix A prompt. Per **D9** they are
   best-known real values (e.g. Velis cruise 80 kt from Edgar's spec sheet,
   not a number reverse-engineered from the old JSON) — colleagues should
   review and correct them in Notion afterwards; that's the point of the
   system.

## 5. Notion schema (exact)

### 5.1 `Aircraft` database — one row per airframe

| Property (exact name) | Type | Required | Notes / options |
|---|---|---|---|
| `Name` | Title | yes | e.g. "Vaeridion Microliner" (no profile suffix) |
| `Slug` | Rich text | yes | stable grouping id, `[a-z0-9_]+`, unique |
| `Show in CNS` | Checkbox | yes | **D10** — unchecked = aircraft (and all its profiles) excluded from the sync output; how "planes to come" are staged |
| `OEM` | Select | no | Pipistrel, Beta, Vaeridion, Elysian, … |
| `Type` | Select | no | CTOL / STOL / eVTOL |
| `Status` | Select | no | concept / under construction / prototype flying / certified |
| `Certification year` | Number | no | blank if certified |
| `Propulsion` | Select | no | fully electric / hybrid / hydrogen |
| `Battery (kWh)` | Number | yes | plain number |
| `Cruise speed (kt)` | Number | yes | knots; transform emits `speed_kmh = round(kt × 1.852)` |
| `MTOW (kg)` | Number | no | |
| `Training range (km)` | Number | no | emits `training_range_km` (Velis) |
| `Simultaneous charging max` | Number | no | ≥2 emits `simultaneous_charging {enabled:true, max:N}` |
| `Chargers` | Multi-select | no | options are charger **ids** from `chargers.json` (see Appendix A for the full list); **first selected = default** → `default_charger_id`; empty allowed (Elysian) |
| `Image` | Rich text | no | filename existing in `pics/` |
| `SVG` | Rich text | no | filename existing in `pics/plane_svgs/` |
| `Notes` | Rich text | no | ignored by sync |

### 5.2 `Performance Profiles` database — one row per operating case

| Property (exact name) | Type | Required | Notes / options |
|---|---|---|---|
| `Label` | Title | yes | e.g. "Max (9 seats)", "Light (4 seats)", "Grass, light load" |
| `Aircraft` | Relation → Aircraft | yes | |
| `Emit ID` | Rich text | yes | the plane `id` CNS emits, `[a-z0-9_]+`, unique across the catalog, stable from phase 1 on (`static/tour.js` + goldens reference ids) |
| `Default` | Checkbox | yes | exactly one checked per aircraft |
| `Seats` | Number | yes | |
| `Payload (kg)` | Number | no | emits `load_kg` when set |
| `Regime` | Select | yes | `VFR` / `IFR+reserves` — D3: the profile's single `Range (km)` is understood under this regime |
| `Range (km)` | Number | yes | emits `range_km` |
| `Surface` | Select | no | paved / grass / any |
| `Min runway (m)` | Number | no | |
| `Max flight duration (min)` | Number | no | |
| `Display name` | Rich text | no | overrides the composed emitted `name` |
| `Source` | Rich text | no | provenance, passthrough only |
| `Confidence` | Select | no | certified / manufacturer-stated / estimated — passthrough only |

### 5.3 Seed data (best-known values per D9 — colleagues refine in Notion)

Aircraft rows (all `Show in CNS` ✔):

| Name | Slug | Status / cert | Battery (kWh) | Cruise (kt) | Training range | Sim. charging max | Chargers (order matters) | Image / SVG |
|---|---|---|---|---|---|---|---|---|
| Velis Electro | `pipistrel_velis` | certified | 22 | 80 | 87.5 | — | dc_22 | pipistrel.jpg / pepistrel.svg |
| Beta Alia CX300 | `beta_alia` | — | 225 | 135 | — | — | dc_320 | beta.png / beta.svg |
| Vaeridion Microliner | `vaeridion_microliner` | under construction / 2030 | 600 | 216 | — | — | dc_1000 | vaeridion.jpg / vaeridion.svg |
| Elysian E9X | `elysian_e9x` | concept | 14000 | 389 | — | 2 | *(none)* | elysian.jpg / vaeridion.svg |

Profile rows:

| Label | Aircraft | Emit ID | Default | Seats | Payload | Regime | Range (km) | Max duration (min) |
|---|---|---|---|---|---|---|---|---|
| Standard | Velis Electro | `pipistrel_velis` | ✔ | 2 | — | VFR | 87.5 | 40 |
| Standard | Beta Alia CX300 | `beta_plane` | ✔ | 6 | 500 | VFR | 500 | — |
| Max (9 seats) | Vaeridion Microliner | `vaeridion` | ✔ | 9 | 1000 | VFR | 500 | — |
| Light (4 seats) | Vaeridion Microliner | `vaeridion_light` | | 4 | 600 | VFR | 687.5 | — |
| Standard | Elysian E9X | `elysian_e9x` | ✔ | 90 | 9000 | VFR | 1000 | — |

(Resulting `speed_kmh`: 148 / 250 / 400 / 720. The Velis shifts from the old
JSON's 150 to 148 km/h because 80 kt is the real figure — accepted per D9.)

## 6. Transform & emission rules (`notion_sync.py`)

The generated file keeps **today's `planes.json` shape**: a JSON array with one
entry **per profile** of every `Show in CNS` aircraft (this is exactly the
trick the old catalog played with vaeridion/vaeridion_light, so zero frontend
changes are needed in v1; a proper per-sim profile picker can come later and
would collapse this).

Per emitted entry:

- `id` ← profile `Emit ID`.
- `name` ← profile `Display name` if set; else the aircraft `Name` when the
  aircraft has one emitted profile; else `"{Aircraft Name} — {Profile Label}"`.
- `seats` ← profile `Seats`; `load_kg` ← `Payload (kg)` (omit key when blank).
- `range_km` ← profile `Range (km)` (its `Regime` says what it means — D3).
- `battery_kwh` ← aircraft `Battery (kWh)`.
- `speed_kmh` ← `round(Cruise speed (kt) × 1.852)` (int).
- `training_range_km` ← aircraft `Training range (km)` (omit when blank).
- `image` / `svg` ← aircraft `Image` / `SVG` (omit when blank).
- `default_charger_id` ← first item of aircraft `Chargers` (omit when empty).
- `simultaneous_charging` ← `{"enabled": true, "max": N}` when
  `Simultaneous charging max` ≥ 2 (omit otherwise).
- **Metadata keys** (additive; templates/JS ignore unknown keys today, and may
  start displaying them later): `aircraft_id` (Slug), `oem`, `type`, `status`,
  `certification_year`, `propulsion`, `mtow_kg`, `regime`, `surface`,
  `min_runway_m`, `max_flight_duration_min`, `profile_label`, `source`,
  `confidence` — each omitted when blank.

Normalization applied to every Notion string before use: trim, collapse inner
whitespace; selects compared case-insensitively; `Emit ID`/`Slug` lowercased
and validated against `^[a-z0-9_]+$`. This kills the "Grass " vs "grass" class
of drift.

Ordering: aircraft by Notion creation time, profiles default-first.

## 7. Sync mechanics

- Pure Python + `requests` (already a dependency; add nothing to
  `requirements.txt`).
- Endpoint `POST https://api.notion.com/v1/databases/{id}/query`, headers
  `Authorization: Bearer $CNS_NOTION_TOKEN`, `Notion-Version: 2022-06-28`
  (**pin this version** — newer versions split databases into "data sources"
  and change response shapes).
- Paginate with `page_size: 100` + `next_cursor`/`has_more`. Rate limit ~3
  req/s: on 429, sleep `Retry-After` and retry (max 5). Two databases, so a
  normal sync is 2 requests.
- Property extraction by type: `title`/`rich_text` → concatenated plain_text;
  `number` → as-is; `select` → option name; `multi_select` → ordered names;
  `checkbox` → bool; `relation` → list of page ids (group profiles by aircraft
  page id).
- **Atomic write**: serialize → write `data/planes.generated.json.tmp` →
  `os.replace()`. Never truncate-then-write.
- **Snapshot**: after every successful sync, copy the result to
  `data/snapshots/planes-<UTC yyyymmdd-HHMMSS>.json`; prune to the newest 30.
  This is the "you own your data" guarantee against Notion lock-in.
- **Report**: write `data/sync_report.json`:
  `{synced_at, emitted, ok: [ids], hidden: [slugs], skipped: [{slug, errors:[...]}], carried_forward: [ids], notion_pages_read}`.
  The CLI prints it; the endpoint returns it. (`hidden` = `Show in CNS`
  unchecked — informational, never an error.)
- CLI: `./venv/bin/python notion_sync.py [--dry-run]` (dry-run: full pull +
  validate + report to stdout, no file writes). Reads env from the process
  environment (systemd injects `/etc/cns.env`; for manual runs
  `set -a; . /etc/cns.env; set +a` — see runbook).

## 8. Validation & quarantine (D7)

Fatal per-aircraft errors (aircraft + all its profiles excluded):
- missing/invalid `Slug`, `Battery (kWh)` ≤ 0 or missing, `Cruise speed (kt)`
  ≤ 0 or missing, no emitted profile, no/multiple `Default` profiles,
  any profile missing `Emit ID`/`Seats`/`Regime`/`Range (km)` (> 0),
  `Emit ID` colliding with another aircraft's, unknown charger id (not in
  `chargers.json`), non-finite numbers.
- Sanity bounds (mirror the spirit of `app.py`'s custom-plane bounds checks
  around `app.py:714-736`): battery 1–100 000 kWh, range 1–20 000 km, speed
  40–1 000 km/h after conversion, seats 1–1 000.

Warnings (emit anyway, list in report): `Image`/`SVG` file not found under
`pics/` (checked only when running on a machine that has `pics/`), unknown
select option outside the documented sets.

**Quarantine with carry-forward:** a quarantined aircraft's entries are copied
from the last-good `planes.generated.json` (matched by `id`) so a colleague's
typo never *removes* a plane from CNS; if no last-good entry exists, skip.
(An aircraft deliberately unchecked from `Show in CNS` is NOT carried forward
— hiding is a valid edit, not an error.)
**Global abort** (keep last-good file untouched, exit non-zero): zero valid
aircraft, or emitted entry count < 50% of the last-good count, or Notion
API/auth failure.

## 9. CNS integration (`sim.py` / `app.py`)

Loader (`sim.py:23-31` area):

```python
CATALOG = os.path.join(base_dir, "data", "planes.generated.json")
# Load + minimal shape check (non-empty list of dicts each having
# id/name/battery_kwh/range_km/speed_kmh).
# Phase 1 (transitional): on missing/invalid, log + fall back to planes.json.
# Phase 3 (cutover): fallback deleted; missing catalog exits with
#   "no catalog: run notion_sync.py (or restore data/snapshots/...)"
```

**Multi-worker reload (required, see gunicorn.conf.py):** the sync can't poke
2 workers via one HTTP request. Give `Simulator` a `maybe_reload_planes()`
that stats the generated file and re-reads it when the mtime changed since
last load (guard with a lock; on parse error keep the previous list). Call it
from a `@app.before_request` hook. A stat is ~1 µs — the no-per-request-IO
property effectively survives. Restarting the service (`systemctl restart cns`)
also works and is the documented fallback.

Phase 2 endpoint (mirror `/api/import`'s token mechanism, `app.py:908-917`):

```
POST /api/admin/sync-catalog     Authorization: Bearer $CNS_SYNC_TOKEN
→ runs the sync in-process, returns sync_report JSON (401 on bad token,
  502 with the report on abort). New env var CNS_SYNC_TOKEN, loaded exactly
  like _IMPORT_TOKEN (grep its load site), documented in /etc/cns.env.
```

Plus a small "Sync from Notion" button in the settings panel
(`static/settings.js`) showing emitted/hidden/skipped/errors from the report.

## 10. Phases

**Phase 0 — Notion setup (Edgar, in progress).** §4 + Appendix A.
Deliverable: two seeded databases shared with CNS-Connector; token + 2 DB ids
in `/etc/cns.env`.

**Phase 1 — build & test (the core slice).**
Build `notion_sync.py` (§6–8), the loader + mtime reload (§9, with the
transitional `planes.json` fallback), and `tests/test_notion_sync.py` (§11).
Edgar runs `--dry-run` then a real sync on the VPS. **Gate (functional, per
D9):** sync exits 0; the aircraft picker lists exactly the `Show in CNS`
aircraft/profiles from Notion; one simulation per aircraft runs sanely; a
hidden aircraft does not appear; existing test suite still passes.

**Phase 2 — triggers.** `/api/admin/sync-catalog` + settings button +
`CNS_SYNC_TOKEN`; systemd service+timer (nightly, §12); snapshot pruning.
Failure drill (§11) passes.

**Phase 3 — CUTOVER (delete the old system).**
Trigger: Edgar says the new method works. No waiting period (D9). One commit:
1. Edgar first checks `data/custom_planes.json` on the VPS; anything worth
   keeping is entered into Notion (runbook §12).
2. Delete `planes.json` and the loader fallback branch — the generated file
   becomes the only catalog; missing → actionable startup error.
3. Delete the custom-*planes* feature: UI in `static/settings.js`, merge logic
   in `static/planes.js`, template hooks, `/api/custom/planes*` routes and the
   planes half of `CUSTOM_FILES`/logging (`app.py:184-188, 707-779`).
   **Custom chargers stay untouched.**
4. Point tests at a fixture: add `tests/fixtures/planes.fixture.json` (a copy
   of the final synced catalog), give test Simulators a fixture `base_dir`
   (check `tests/_helpers.py`, `tests/test_api.py`, `tests/test_sim_core.py`,
   JS goldens under `tests/goldens/`). The fixture doubles as a dev seed:
   `cp tests/fixtures/planes.fixture.json data/planes.generated.json` boots
   the app without a Notion token.
5. Run the guided tour check (`CNSTour.check()` in the browser console) —
   `static/tour.js` references plane ids.

**Later (optional, out of scope):** per-simulation profile picker in the UI
(schema already carries `aircraft_id`/`profile_label`); chargers catalog to
Notion (D8); image sync from Notion.

## 11. Verification (per phase)

- **Unit (phase 1):** fixture-driven — a captured/synthetic Notion API payload
  (no live network in tests) through transform → expected entries; `Show in
  CNS` unchecked → excluded and listed under `hidden`; quarantine test (bad
  battery → aircraft skipped, carry-forward applied, report lists it);
  hidden-vs-quarantined distinction (hidden is NOT carried forward);
  global-abort test (empty pull → last-good untouched); normalization tests
  ("Grass " → grass; "VFR" case-insensitive); kt→km/h rounding test
  (80→148, 135→250, 389→720).
- **Loader:** reads generated file; transitional fallback on missing/corrupt
  (phase 1 only); mtime reload swaps planes without restart (two reads around
  a file touch).
- **E2E (phase 1, Edgar on VPS):** run sync, restart service, load app —
  picker matches Notion, one simulation per aircraft completes; untick
  `Show in CNS` on one aircraft, re-sync, confirm it vanishes; re-tick,
  re-sync, it returns.
- **Failure drill (phase 2):** blank out Battery for one aircraft in Notion →
  sync → CNS keeps serving that aircraft (carry-forward), report shows the
  error, settings button surfaces it.
- **Cutover (phase 3):** full test suite green on the fixture; fresh-checkout
  boot test (no `data/` → actionable error; fixture copied in → boots);
  `CNSTour.check()` clean; `git grep -l 'planes.json'` returns only
  historical/docs references.
- All Python tests run via the existing `tests/` conventions; don't invent a
  new runner.

## 12. Ops runbook (Edgar executes; Claude sessions have no SSH)

```bash
# --- one-time (phase 0/1) ---
sudo tee -a /etc/cns.env >/dev/null <<'EOF'
CNS_NOTION_TOKEN=<the CNS-Connector secret — never commit it anywhere>
CNS_NOTION_AIRCRAFT_DB=<32-hex id from the Aircraft DB URL>
CNS_NOTION_PROFILES_DB=<32-hex id from the Profiles DB URL>
CNS_SYNC_TOKEN=<generate: openssl rand -hex 24>
EOF

# --- deploy any phase ---
cd ~/Charging-Network-Simulator && git pull
sudo systemctl restart cns          # journalctl -u cns -f to watch

# --- manual sync (phase 1) ---
cd ~/Charging-Network-Simulator
set -a; . /etc/cns.env; set +a
./venv/bin/python notion_sync.py --dry-run   # inspect first
./venv/bin/python notion_sync.py             # real run; mtime reload picks it up

# --- nightly timer (phase 2): cns-sync.service + cns-sync.timer ---
# service: Type=oneshot, User=cns, WorkingDirectory=app dir,
#          EnvironmentFile=/etc/cns.env, ExecStart=<venv python> notion_sync.py
# timer:   OnCalendar=daily (03:00), Persistent=true
sudo systemctl enable --now cns-sync.timer

# --- phase 3 (cutover) precheck ---
cat ~/Charging-Network-Simulator/data/custom_planes.json   # migrate keepers to Notion first
```

Colleague workflow (document on the Notion page itself): edit/add rows →
tick `Show in CNS` when the aircraft is ready to appear, and give it exactly
one `Default` profile → press "Sync from Notion" in CNS settings (or wait for
the nightly sync) → check the reported summary.

## 13. Known limitations & risks (accepted)

- **Images still need a dev**: `Image` references files committed under
  `pics/`; a brand-new aircraft photo requires a git commit. (Notion file
  upload → auto-download is a possible later enhancement.)
- **Notion select drift** is mitigated by normalization (§6) but colleagues
  can still invent new option values — they surface as warnings, not failures.
- **Notion outage / token revocation**: CNS keeps serving the last-good file
  indefinitely; syncs fail loudly (non-zero exit → timer failure visible in
  `systemctl list-timers` / journal).
- **v1 profile selection**: the sim uses whatever profiles are emitted as
  separate picker entries (exactly like the old vaeridion pair). A real
  per-simulation profile dropdown is future work and purely additive on this
  schema.
- **Charger catalog** remains dev-managed JSON (D8).
- **The token was pasted in a chat session** during setup. If that session
  transcript is ever shared, rotate the secret (Notion → Settings →
  Connections → CNS-Connector → refresh token) and update `/etc/cns.env`.

---

## Appendix A — Notion AI prompt (Edgar pastes this into Notion's assistant)

### A.1 The prompt

```
Create a page called "CNS Aircraft Catalog" containing two inline databases.
Use the EXACT property names below (a sync script matches them by name,
case-sensitively). Do not add, rename, or remove properties.

DATABASE 1 — name it "Aircraft", with these properties:
- "Name" (title)
- "Slug" (text)
- "Show in CNS" (checkbox)
- "OEM" (select — options: Pipistrel, Beta, Vaeridion, Elysian)
- "Type" (select — options: CTOL, STOL, eVTOL)
- "Status" (select — options: concept, under construction, prototype flying, certified)
- "Certification year" (number)
- "Propulsion" (select — options: fully electric, hybrid, hydrogen)
- "Battery (kWh)" (number)
- "Cruise speed (kt)" (number)
- "MTOW (kg)" (number)
- "Training range (km)" (number)
- "Simultaneous charging max" (number)
- "Chargers" (multi-select — options: dc_22, dc_40, dc_mobile_40, dc_beta_40,
  dc_50, dc_beta_65, dc_100, dc_mobile_100, dc_250, dc_320, dc_400, dc_1000,
  dc_2400, dc_3750)
- "Image" (text)
- "SVG" (text)
- "Notes" (text)

DATABASE 2 — name it "Performance Profiles", with these properties:
- "Label" (title)
- "Aircraft" (relation to the "Aircraft" database above)
- "Emit ID" (text)
- "Default" (checkbox)
- "Seats" (number)
- "Payload (kg)" (number)
- "Regime" (select — options: VFR, IFR+reserves)
- "Range (km)" (number)
- "Surface" (select — options: paved, grass, any)
- "Min runway (m)" (number)
- "Max flight duration (min)" (number)
- "Display name" (text)
- "Source" (text)
- "Confidence" (select — options: certified, manufacturer-stated, estimated)

Then add these 4 rows to "Aircraft" (Show in CNS checked on all):
1. Name: Velis Electro | Slug: pipistrel_velis | OEM: Pipistrel | Type: CTOL |
   Status: certified | Propulsion: fully electric | Battery (kWh): 22 |
   Cruise speed (kt): 80 | Training range (km): 87.5 | Chargers: dc_22 |
   Image: pipistrel.jpg | SVG: pepistrel.svg
2. Name: Beta Alia CX300 | Slug: beta_alia | OEM: Beta | Type: CTOL |
   Propulsion: fully electric | Battery (kWh): 225 | Cruise speed (kt): 135 |
   Chargers: dc_320 | Image: beta.png | SVG: beta.svg
3. Name: Vaeridion Microliner | Slug: vaeridion_microliner | OEM: Vaeridion |
   Type: CTOL | Status: under construction | Certification year: 2030 |
   Propulsion: fully electric | Battery (kWh): 600 | Cruise speed (kt): 216 |
   Chargers: dc_1000 | Image: vaeridion.jpg | SVG: vaeridion.svg
4. Name: Elysian E9X | Slug: elysian_e9x | OEM: Elysian | Type: CTOL |
   Status: concept | Propulsion: fully electric | Battery (kWh): 14000 |
   Cruise speed (kt): 389 | Simultaneous charging max: 2 |
   Image: elysian.jpg | SVG: vaeridion.svg

Then add these 5 rows to "Performance Profiles":
1. Label: Standard | Aircraft: Velis Electro | Emit ID: pipistrel_velis |
   Default: checked | Seats: 2 | Regime: VFR | Range (km): 87.5 |
   Max flight duration (min): 40
2. Label: Standard | Aircraft: Beta Alia CX300 | Emit ID: beta_plane |
   Default: checked | Seats: 6 | Payload (kg): 500 | Regime: VFR |
   Range (km): 500
3. Label: Max (9 seats) | Aircraft: Vaeridion Microliner | Emit ID: vaeridion |
   Default: checked | Seats: 9 | Payload (kg): 1000 | Regime: VFR |
   Range (km): 500
4. Label: Light (4 seats) | Aircraft: Vaeridion Microliner |
   Emit ID: vaeridion_light | Default: unchecked | Seats: 4 |
   Payload (kg): 600 | Regime: VFR | Range (km): 687.5
5. Label: Standard | Aircraft: Elysian E9X | Emit ID: elysian_e9x |
   Default: checked | Seats: 90 | Payload (kg): 9000 | Regime: VFR |
   Range (km): 1000
```

### A.2 After the bot finishes — Edgar's 30-second checklist

1. Property names match §5 **exactly** (especially `Show in CNS`, `Emit ID`,
   `Battery (kWh)`, `Cruise speed (kt)` — AI assistants love to "fix" names).
   Types too: `Slug`/`Emit ID`/`Image`/`SVG` are plain text, not select.
2. Every aircraft row: `Show in CNS` ✔, `Slug` filled.
3. Every profile row: linked to its `Aircraft`, `Emit ID` filled, exactly one
   `Default` ✔ per aircraft.
4. If the bot mangled the seed rows, fix them by hand from §5.3 — the schema
   matters more than the rows.
5. Share BOTH databases with **CNS-Connector** (••• → Connections), then copy
   both database IDs into `/etc/cns.env` (§12).
