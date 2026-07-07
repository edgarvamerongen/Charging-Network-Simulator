# Notion Aircraft Catalog — Complete Integration Plan

**Status:** approved by Edgar, not yet implemented.
**Written:** 2026-07-07 by a Claude session, as a handoff guide for a future
session (Opus) that will implement it. Decisions below are LOCKED with Edgar —
do not re-litigate them; implement them.
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

## 1. Goal & locked decisions

**Goal:** the aircraft catalog becomes editable by non-dev colleagues, readable
by everyone, and the CNS consumes it automatically — replacing the hand-edited
`planes.json` workflow entirely (full migration, see phases 4–5).

Decisions locked with Edgar (2026-07-07):

| # | Decision | Choice |
|---|----------|--------|
| D1 | Source of truth | **Notion** (master). CNS only reads. No self-hosted DB (VPS has no Docker; Notion natively covers editing + reading + sharing). |
| D2 | Data model | **Two Notion databases**: Aircraft (intrinsic) + Performance Profiles (conditional, many per aircraft). Coarse profiles (one row per operating case), NOT one-row-per-measurement. |
| D3 | Range semantics | **Per-profile regime**: each profile row declares `VFR` or `IFR+reserves` and carries ONE range figure; the sim uses the selected (v1: default) profile's range as `range_km`. An aircraft with both VFR and IFR figures = two profile rows. |
| D4 | Notion DB creation | **Instructions only** (§4–5). Databases are created later by Edgar or a Notion-connected Claude session; IDs then go into `/etc/cns.env`. |
| D5 | In-app custom planes | **Deprecate** after Notion sync is live (phase 4). Custom **chargers** feature stays — only the planes side is deprecated. |
| D6 | Tracked `planes.json` | **Delete eventually** (phase 5) after a confidence period; until then it stays as boot fallback. Hand-editing it is dead from phase 1 on. |
| D7 | Validation failures | **Per-aircraft quarantine with carry-forward** (§8), not all-or-nothing. |
| D8 | Chargers catalog | Stays in `chargers.json` (dev-managed) for now. Aircraft↔charger link lives in Notion as a multi-select of charger ids. Moving chargers to Notion is a possible later phase, same pattern. |

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
  `static/planes.js` / `static/settings.js`. This is what D5 deprecates.
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
- `static/tour.js` seeds demo flights with specific plane ids (Beta Alia) —
  **emitted ids must remain stable forever** (§6).

## 3. Target architecture

```
  Notion (master)                     VPS                            CNS app
┌─────────────────────┐   REST   ┌──────────────────────────┐ file ┌───────────────────────┐
│ Aircraft DB         │ ───────► │ notion_sync.py           │ ───► │ sim.py loader:        │
│ Performance Profiles│  pull    │  pull → transform →      │      │  prefer data/planes.  │
│ (colleagues edit)   │          │  validate/quarantine →   │      │  generated.json,      │
└─────────────────────┘          │  atomic write + snapshot │      │  fall back planes.json│
                                 │  + data/sync_report.json │      │  reload on mtime change│
                                 └──────────────────────────┘      └───────────────────────┘
        triggers: CLI (phase 1) · POST /api/admin/sync-catalog (phase 2) · systemd timer (phase 3)
```

Properties preserved: load-once/no-per-request-IO (mtime stat is ~µs), works
offline (last-good file), a bad Notion edit can never take the app down.

## 4. Notion workspace setup (phase 0 — Edgar or a Notion-connected session)

1. Create an **internal integration**: notion.so → Settings → Connections →
   Develop or manage integrations → New. Capabilities: **Read content** only.
   Copy the secret → this becomes `CNS_NOTION_TOKEN`.
2. Create a page (e.g. "CNS Aircraft Catalog") and inside it the two databases
   from §5 with the **exact property names** given (the sync matches properties
   by name, case-sensitive).
3. Share both databases with the integration (••• → Connections → add it).
4. Copy both database IDs (the 32-hex segment of each DB's URL) →
   `CNS_NOTION_AIRCRAFT_DB`, `CNS_NOTION_PROFILES_DB`.
5. Seed with the current 5 aircraft using the tables in §5.3 — the values are
   pinned so phase-1 verification can require output identical to today's
   `planes.json`.

## 5. Notion schema (exact)

### 5.1 `Aircraft` database — one row per airframe

| Property (exact name) | Type | Required | Notes / options |
|---|---|---|---|
| `Name` | Title | yes | e.g. "Vaeridion Microliner" (no profile suffix) |
| `Slug` | Rich text | yes | stable grouping id, `[a-z0-9_]+`, unique |
| `Active` | Checkbox | yes | unchecked rows are ignored by sync → colleagues can draft "planes to come" safely |
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
| `Chargers` | Multi-select | no | options are charger **ids** from `chargers.json` (`dc_22`, `dc_320`, `dc_1000`, …); **first selected = default** → `default_charger_id`; empty allowed (Elysian) |
| `Image` | Rich text | no | filename existing in `pics/` |
| `SVG` | Rich text | no | filename existing in `pics/plane_svgs/` |
| `Notes` | Rich text | no | ignored by sync |

### 5.2 `Performance Profiles` database — one row per operating case

| Property (exact name) | Type | Required | Notes / options |
|---|---|---|---|
| `Label` | Title | yes | e.g. "Max (9 seats)", "Light (4 seats)", "Grass, light load" |
| `Aircraft` | Relation → Aircraft | yes | |
| `Emit ID` | Rich text | yes | the plane `id` CNS emits, `[a-z0-9_]+`, **unique across the whole catalog, stable forever** (share links, tour, saved plans reference it) |
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

### 5.3 Seed data (pinned to reproduce today's `planes.json` exactly)

Aircraft rows:

| Name | Slug | Battery (kWh) | Cruise (kt) | Training range | Sim. charging max | Chargers (order matters) | Image / SVG |
|---|---|---|---|---|---|---|---|
| Velis Electro | `pipistrel_velis` | 22 | **81** | 87.5 | — | dc_22 | pipistrel.jpg / pepistrel.svg |
| Beta Alia CX300 | `beta_alia` | 225 | **135** | — | — | dc_320 | beta.png / beta.svg |
| Vaeridion Microliner | `vaeridion_microliner` | 600 | **216** | — | — | dc_1000 | vaeridion.jpg / vaeridion.svg |
| Elysian E9X | `elysian_e9x` | 14000 | **389** | — | 2 | *(none)* | elysian.jpg / vaeridion.svg |

(Cruise kt values are pinned so `round(kt × 1.852)` returns exactly today's
150 / 250 / 400 / 720 km/h. If a colleague later corrects e.g. Velis to 80 kt,
that's a *data* change and sim results legitimately shift.)

Profile rows:

| Label | Aircraft | Emit ID | Default | Seats | Payload | Regime | Range (km) |
|---|---|---|---|---|---|---|---|
| Standard | Velis Electro | `pipistrel_velis` | ✔ | 2 | — | VFR | 87.5 |
| Standard | Beta Alia CX300 | `beta_plane` | ✔ | 6 | 500 | VFR | 500 |
| Max (9 seats) | Vaeridion Microliner | `vaeridion` | ✔ | 9 | 1000 | VFR | 500 |
| Light (4 seats) | Vaeridion Microliner | `vaeridion_light` | | 4 | 600 | VFR | 687.5 |
| Standard | Elysian E9X | `elysian_e9x` | ✔ | 90 | 9000 | VFR | 1000 |

## 6. Transform & emission rules (`notion_sync.py`)

The generated file keeps **today's `planes.json` shape**: a JSON array with one
entry **per profile** (this is exactly the trick the catalog already plays with
vaeridion/vaeridion_light, so zero frontend changes are needed in v1; a proper
per-sim profile picker can come later and would collapse this).

Per emitted entry:

- `id` ← profile `Emit ID`.
- `name` ← profile `Display name` if set; else the aircraft `Name` when the
  aircraft has one active profile; else `"{Aircraft Name} — {Profile Label}"`.
  (Reproduces "Vaeridion Microliner — Max (9 seats)".)
- `seats` ← profile `Seats`; `load_kg` ← `Payload (kg)` (omit key when blank).
- `range_km` ← profile `Range (km)` (its `Regime` says what it means — D3).
- `battery_kwh` ← aircraft `Battery (kWh)`.
- `speed_kmh` ← `round(Cruise speed (kt) × 1.852)` (int).
- `training_range_km` ← aircraft `Training range (km)` (omit when blank).
- `image` / `svg` ← aircraft `Image` / `SVG` (omit when blank).
- `default_charger_id` ← first item of aircraft `Chargers` (omit when empty).
- `simultaneous_charging` ← `{"enabled": true, "max": N}` when
  `Simultaneous charging max` ≥ 2 (omit otherwise).
- **New passthrough keys** (additive; current templates/JS ignore unknown keys):
  `aircraft_id` (Slug), `oem`, `type`, `status`, `certification_year`,
  `propulsion`, `mtow_kg`, `regime`, `surface`, `min_runway_m`,
  `max_flight_duration_min`, `profile_label`, `source`, `confidence` — each
  omitted when blank.

Normalization applied to every Notion string before use: trim, collapse inner
whitespace; selects compared case-insensitively; `Emit ID`/`Slug` lowercased
and validated against `^[a-z0-9_]+$`. This kills the "Grass " vs "grass" class
of drift.

Ordering: aircraft by Notion creation time, profiles default-first — but the
**phase-1 gate compares as sets keyed by id**, not by array order.

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
  `{synced_at, emitted, ok: [ids], skipped: [{slug, errors:[...]}], carried_forward: [ids], notion_pages_read}`.
  The CLI prints it; the endpoint returns it.
- CLI: `./venv/bin/python notion_sync.py [--dry-run]` (dry-run: full pull +
  validate + report to stdout, no file writes). Reads env from the process
  environment (systemd injects `/etc/cns.env`; for manual runs
  `set -a; . /etc/cns.env; set +a` — see runbook).

## 8. Validation & quarantine (D7)

Fatal per-aircraft errors (aircraft + all its profiles excluded):
- missing/invalid `Slug`, `Battery (kWh)` ≤ 0 or missing, `Cruise speed (kt)`
  ≤ 0 or missing, no active profile, no/multiple `Default` profiles,
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
**Global abort** (keep last-good file untouched, exit non-zero): zero valid
aircraft, or emitted entry count < 50% of the last-good count, or Notion
API/auth failure.

## 9. CNS integration (`sim.py` / `app.py`)

Loader change (`sim.py:23-31` area):

```python
GENERATED = os.path.join(base_dir, "data", "planes.generated.json")
# prefer the generated catalog; validate minimal shape (non-empty list of
# dicts each having id/name/battery_kwh/range_km/speed_kmh); on any problem
# log + fall back to the tracked planes.json  (phase 5 removes the fallback)
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
(`static/settings.js`) showing emitted/skipped/errors from the report.

## 10. Phases

**Phase 0 — Notion setup (Edgar / Notion-connected session, ~30 min).** §4 + §5.
Deliverable: two seeded databases, token + 2 DB ids in `/etc/cns.env`.

**Phase 1 — read path proven (the core slice).**
Build `notion_sync.py` (§6–8), the `sim.py` loader preference + mtime reload
(§9), and `tests/test_notion_sync.py` (§11). Edgar runs one manual sync on the
VPS. **Gate:** for the 5 legacy ids, the generated entries equal today's
`planes.json` on the legacy key subset (extra passthrough keys allowed); app
renders identically; full existing test suite still passes.

**Phase 2 — in-app trigger.** `/api/admin/sync-catalog` + settings button +
`CNS_SYNC_TOKEN`. Failure drill (§11) passes.

**Phase 3 — ops.** systemd service+timer (nightly, §12), snapshot pruning,
runbook section handed to colleagues (how to add an aircraft in Notion).

**Phase 4 — deprecate custom planes (D5).**
Precondition: phases 1–3 live and colleagues have edited Notion successfully.
1. Edgar checks `data/custom_planes.json` on the VPS; anything worth keeping
   is entered into Notion first (runbook §12).
2. Remove the custom-*planes* UI from `static/settings.js` +
   `static/planes.js` merge logic + desktop template hooks; then remove
   `/api/custom/planes*` routes and the planes half of `CUSTOM_FILES` /
   logging (`app.py:184-188, 707-779`). **Custom chargers stay untouched.**
3. Update any tests covering those routes.

**Phase 5 — delete `planes.json` (D6).**
Criteria (all): ≥4 consecutive weeks of successful timer syncs (check
`sync_report.json` + journal), snapshots verified restorable, Edgar signs off.
Then: remove `planes.json`; loader requires the generated file and fails with
an actionable error (`"no catalog: run notion_sync.py or restore
data/snapshots/..."`); **tests must stop depending on the live catalog** — add
`tests/fixtures/planes.fixture.json` (copy of the last tracked catalog) and
point test Simulators at a fixture `base_dir` (check `tests/_helpers.py`,
`tests/test_api.py`, `tests/test_sim_core.py`, JS goldens under
`tests/goldens/` for baked-in plane data). The guided tour references plane
ids (`static/tour.js`) — run `CNSTour.check()` after the switch.

## 11. Verification (per phase)

- **Unit (phase 1):** fixture-driven — a captured/synthetic Notion API payload
  (no live network in tests) through transform → exact expected entries;
  quarantine test (bad battery → aircraft skipped, carry-forward applied,
  report lists it); global-abort test (empty pull → last-good untouched);
  normalization tests ("Grass " → grass; "VFR" case-insensitive); kt→km/h
  pinned-values test (81→150, 135→250, 216→400, 389→720).
- **Loader:** generated-preferred / fallback-on-missing / fallback-on-corrupt;
  mtime reload swaps planes without restart (two reads around a file touch).
- **E2E (phase 1, Edgar on VPS):** run sync, restart service, load app —
  aircraft picker identical, one simulation per aircraft matches pre-sync
  results.
- **Failure drill (phase 2):** blank out Battery for one aircraft in Notion →
  sync → CNS keeps serving that aircraft (carry-forward), report shows the
  error, settings button surfaces it.
- All Python tests run via the existing `tests/` conventions; don't invent a
  new runner.

## 12. Ops runbook (Edgar executes; the repo has no SSH from Claude sessions)

```bash
# --- one-time (phase 0/1) ---
sudo tee -a /etc/cns.env >/dev/null <<'EOF'
CNS_NOTION_TOKEN=secret_xxx
CNS_NOTION_AIRCRAFT_DB=<32-hex id>
CNS_NOTION_PROFILES_DB=<32-hex id>
CNS_SYNC_TOKEN=<generate: openssl rand -hex 24>
EOF

# --- deploy any phase ---
cd ~/Charging-Network-Simulator && git pull
sudo systemctl restart cns          # journalctl -u cns -f to watch

# --- manual sync (phase 1) ---
cd ~/Charging-Network-Simulator
set -a; . /etc/cns.env; set +a
./venv/bin/python notion_sync.py --dry-run   # inspect first
./venv/bin/python notion_sync.py             # real run; then reload app or rely on mtime reload

# --- nightly timer (phase 3): cns-sync.service + cns-sync.timer ---
# service: Type=oneshot, User=cns, WorkingDirectory=app dir,
#          EnvironmentFile=/etc/cns.env, ExecStart=<venv python> notion_sync.py
# timer:   OnCalendar=daily (03:00), Persistent=true
sudo systemctl enable --now cns-sync.timer

# --- phase 4 precheck ---
cat ~/Charging-Network-Simulator/data/custom_planes.json   # migrate keepers to Notion first
```

Colleague workflow (document on the Notion page itself): edit/add rows →
ensure `Active` ✔ and exactly one `Default` profile → press "Sync from Notion"
in CNS settings (or wait for the nightly sync) → check the reported summary.

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
  separate picker entries (exactly like today's vaeridion pair). A real
  per-simulation profile dropdown is future work and purely additive on this
  schema (`aircraft_id` + `profile_label` are already emitted for it).
- **Charger catalog** remains dev-managed JSON (D8).
