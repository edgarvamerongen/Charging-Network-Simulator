# Notion Aircraft Catalog — Complete Integration Plan

**Status:** implemented in `notion_sync.py` + `deploy/cns-sync.*`; this file is
the design record.
**Written:** 2026-07-07 by a Claude session, as a handoff guide for a future
session (Opus) that will implement it. Revised same day after Edgar's review —
see D9/D10. Decisions below are LOCKED with Edgar — do not re-litigate them;
implement them.
**Lane:** backend/desktop (per CLAUDE.md worktree rules). Everything here is
backend-lane work: `sim.py`, `app.py`, new `notion_sync.py`, `tests/`,
`static/settings.js`, desktop `templates/index.html`.

---

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
| D4 | Notion DB creation | **Edgar creates the databases with Notion's AI assistant** using a drafted prompt, then shares both with CNS-Connector and copies the two database IDs into `/etc/cns.env`. |
| D5 | In-app custom planes | **Deleted at cutover** (phase 3). Custom **chargers** feature stays — only the planes side goes. |
| D6 | Tracked `planes.json` | **Deleted at cutover** (phase 3), together with the loader fallback. No multi-week confidence period. |
| D7 | Validation failures | **Per-aircraft quarantine with carry-forward** (§8), not all-or-nothing. |
| D8 | Chargers catalog | Stays in `chargers.json` (dev-managed) for now. Aircraft↔charger link lives in Notion as a multi-select of charger ids. Moving chargers to Notion is a possible later phase, same pattern. |
| D9 | **No legacy-compat constraint.** | The tool has not shipped — there are no users, saved links, or results to protect. The generated catalog does NOT need to reproduce today's `planes.json` values; seeds use best-known real figures; verification is **functional**, not byte-comparison. Optimize the end-state; leave no shrapnel from the old system. |
| D10 | Catalog visibility | Aircraft rows carry a **`CNS` checkbox** (as-built name — an earlier draft called it "Show in CNS"); unchecked aircraft (and their profiles) are silently excluded from the sync output. This is how colleagues stage "planes to come". |

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

## 4. Notion workspace setup (phase 0 — DONE 2026-07-07, verified via API)

As-built state, confirmed by querying the live databases with the
CNS-Connector token:

- ✅ Integration **CNS-Connector** (workspace NRG2fly), token works. Secret →
  `CNS_NOTION_TOKEN` in `/etc/cns.env` ONLY — never in the repo.
- ✅ **Aircraft** database: `3a08f9303e8848e797056c3f62c75178`
  → `CNS_NOTION_AIRCRAFT_DB`
- ✅ **Performance Profiles** database: `0a16fd09aabb490ebe1f1119687c9bdc`
  → `CNS_NOTION_PROFILES_DB`
- ✅ Both shared with the integration; relation Profiles→Aircraft wired
  correctly; 4 seeded aircraft + 5 profiles verified (emit ids
  `pipistrel_velis`, `beta_plane`, `vaeridion`, `vaeridion_light`,
  `elysian_e9x`; exactly one Default per aircraft).
- ⚠️ As-built deviations from the original draft (schema §5 below reflects
  reality — **code targets these names**):
  - the visibility checkbox is named **`CNS`**, not "Show in CNS";
  - Edgar added **`Max kW`** (number — aircraft-side max charging power
    acceptance) and **`Country`** (rich text — country of manufacturing) to
    Aircraft.
- ⚠️ One stray empty Aircraft row exists (only `CNS` unchecked, no data) —
  harmless (hidden rows are skipped) but should be deleted in Notion.

Remaining phase-0 step for Edgar: put the token + both database IDs into
`/etc/cns.env` (§12 — the IDs are pre-filled there).

Seed values are best-known real figures per **D9** (e.g. Velis cruise 80 kt
from Edgar's spec sheet, not reverse-engineered from the old JSON) —
colleagues refine them in Notion; that's the point of the system.

## 5. Notion schema (exact)

### 5.1 `Aircraft` database — one row per airframe

| Property (exact name) | Type | Required | Notes / options |
|---|---|---|---|
| `Name` | Title | yes | e.g. "Vaeridion Microliner" (no profile suffix) |
| `Slug` | Rich text | yes | stable grouping id, `[a-z0-9_]+`, unique |
| `CNS` | Checkbox | yes | **D10** — unchecked = aircraft (and all its profiles) excluded from the sync output; how "planes to come" are staged |
| `OEM` | Select | no | Pipistrel, Beta, Vaeridion, Elysian, … |
| `Type` | Select | no | CTOL / STOL / eVTOL |
| `Status` | Select | no | concept / under construction / prototype flying / certified |
| `Certification year` | Number | no | blank if certified |
| `Propulsion` | Select | no | fully electric / hybrid / hydrogen |
| `Battery (kWh)` | Number | yes | plain number |
| `Cruise speed (kt)` | Number | yes | knots; transform emits `speed_kmh = round(kt × 1.852)` |
| `Max kW` | Number | no | aircraft-side max charging power acceptance; emits `max_charge_kw`. Passthrough in v1 — the sim does NOT yet cap charger power with it (future work) |
| `Country` | Rich text | no | country of manufacturing (free text, e.g. "NL, DE"); emits `country` |
| `MTOW (kg)` | Number | no | |
| `Training range (km)` | Number | no | emits `training_range_km` (Velis) |
| `Simultaneous charging max` | Number | no | ≥2 emits `simultaneous_charging {enabled:true, max:N}` |
| `Chargers` | Multi-select | no | options are charger **ids** from `chargers.json` (see that file for the full list); **first selected = default** → `default_charger_id`; empty allowed (Elysian) |
| `Photo` | Files & media | no | **preferred picture source** — upload an image here in Notion and the sync downloads it to `data/plane_images/` and emits `image_url` (served at `/plane-images/`). First file wins. Takes precedence over `Image` in the picker + PDF; falls back to `Image` when absent. Colleagues can now add an aircraft's picture with no code/commit. |
| `Image` | Rich text | no | filename existing in `pics/` — fallback when `Photo` is empty |
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

> **As-built note:** the live databases already contain these rows (verified
> 2026-07-07), plus values Edgar filled in beyond the seed: `Max kW`
> (Velis 40, Beta 400, Vaeridion 800), `Country` (SI / USA / "NL, DE" / NL)
> and Beta's Status = prototype flying. **The live databases are the truth**;
> the tables below are the historical seed reference.

Aircraft rows (all `CNS` ✔):

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
entry **per profile** of every `CNS` aircraft (this is exactly the
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
  `certification_year`, `propulsion`, `max_charge_kw` (← `Max kW`),
  `country` (← `Country`), `mtow_kg`, `regime`, `surface`, `min_runway_m`,
  `max_flight_duration_min`, `profile_label`, `source`, `confidence` — each
  omitted when blank. Note `max_charge_kw` is passthrough-only in v1: the sim
  keeps using the charger's rated kW unmodified (wiring
  `min(charger_kw, max_charge_kw)` into charge-time math is future work —
  it would change sim results, e.g. Vaeridion accepts 800 kW but is paired
  with the 1000 kW charger).

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
  The CLI prints it; the endpoint returns it. (`hidden` = `CNS`
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
(An aircraft deliberately unchecked from `CNS` is NOT carried forward
— hiding is a valid edit, not an error.)
**Global abort** (keep last-good file untouched, exit non-zero): zero valid
aircraft, or emitted entry count < 50% of the last-good count, or Notion
API/auth failure.

## 12. Ops runbook (Edgar executes; Claude sessions have no SSH)

```bash
# --- one-time (phase 0/1) ---
sudo tee -a /etc/cns.env >/dev/null <<'EOF'
CNS_NOTION_TOKEN=<the CNS-Connector secret — never commit it anywhere>
CNS_NOTION_AIRCRAFT_DB=3a08f9303e8848e797056c3f62c75178
CNS_NOTION_PROFILES_DB=0a16fd09aabb490ebe1f1119687c9bdc
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

# --- sync timer (phase 2): cns-sync.service + cns-sync.timer ---
# service: Type=oneshot, User=cns, WorkingDirectory=app dir,
#          EnvironmentFile=/etc/cns.env, ExecStart=<venv python> notion_sync.py
# timer:   OnCalendar=*:0/15 (every 15 min) + OnBootSec=2min, Persistent=true
sudo systemctl enable --now cns-sync.timer

# --- phase 3 (cutover) precheck ---
cat ~/Charging-Network-Simulator/data/custom_planes.json   # migrate keepers to Notion first
```

Colleague workflow (document on the Notion page itself): edit/add rows →
tick `CNS` when the aircraft is ready to appear, and give it exactly
one `Default` profile → press "Sync from Notion" in CNS settings (or wait for
the 15-min timer) → check the reported summary.

## 13. Known limitations & risks (accepted)

- **Images**: RESOLVED for the common case — the `Photo` property lets
  colleagues attach a picture in Notion (downloaded on sync). Only `SVG`
  route glyphs and brand assets still live in `pics/` and need a commit.
- **Photo storage is per-server**: `data/plane_images/` is local to the VPS
  (gitignored, like the generated catalog). A fresh deploy re-downloads on the
  first sync; it is not committed, so back it up with the catalog snapshots if
  offline resilience matters.
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

