# External Flight-Data Import — Design Spec

**Date:** 2026-06-26
**Status:** Draft (brainstorming output)
**Related:** build-share (`/s/<slug>`), `shares.py`, the build blob `{v,k:'build',fl,cfg,sch,ms}`

## Summary

A way to take an external, provider-specific flight history (e.g. the PH-GOV
government-aircraft usage data — an xlsx of flights and a quarterly PDF report)
and turn it into a CNS **build-share link** (`/s/<slug>`) that opens directly in
the Demand Calculator, with the real route network pre-loaded.

The hard part is that **every source differs** — different columns, date
formats, code systems, route encodings. The design absorbs that variation in an
**LLM skill** (the interpretation layer) and keeps everything deterministic and
correctness-critical in a **server endpoint**. The two meet at one stable
contract: a normalized-flights JSON.

Crucially, the skill is **portable**: a colleague installs it as a plugin and
uses it with no access to this repo, no Python, and no local data files — they
need only the skill and an API token. All heavy logic lives on the server.

## Goals

1. Convert heterogeneous flight histories into the build blob and a shareable
   `/s/<slug>` link that opens in the DC.
2. Be **source-adaptive** — new providers exercise only the skill, never the
   server code.
3. Be **portable** — usable by colleagues without the codebase.
4. Preserve the **switchable** model: import assigns a default electric aircraft
   so the DC simulates immediately, but stores the real route/frequency so a
   viewer can re-pick the plane and re-simulate (normal DC flight editing).

## Non-goals

- Reproducing conventional-jet performance (CNS models electric aircraft only).
- A UI upload widget in the CNS app (v1 is skill-driven; a web upload can come
  later and reuse the same `/api/import` endpoint).
- Persisting per-airport charger config or rotation schedules from raw history
  (`cfg`/`sch` are empty on import; the viewer adds them in the DC).

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Import intent | **Both / switchable** — default electric plane assigned, viewer can re-pick and re-simulate. |
| Reusability | **General, source-adaptive** — skill interprets, server converts. |
| Portability | **Yes** — skill is an installable plugin; deterministic work is server-side. |
| Output | An instant `/s/<slug>` link (requires POST to the VPS shares DB). |

---

## Architecture

```
  source file (xlsx / PDF / CSV / pasted text)
        │
        ▼   SKILL  ·  cns-import-flights         (portable plugin; interpretation)
        │   LLM normalizes the source → normalized-flights.json  (codes + structure, NOT coords)
        ▼
  POST https://cns.nrg2fly.nl/api/import          (Bearer token)
        │   SERVER  ·  deterministic conversion (has airports.csv + shares DB):
        │     resolve codes→coords · classify trip type · aggregate→frequency ·
        │     assign default plane/charger · assemble build blob · shares.save_state → slug
        ▼
  { url: "https://cns.nrg2fly.nl/s/<slug>", report: {…} }
        │
        ▼   skill hands the colleague the link + a plain-language report
```

**Seam:** the normalized JSON is the single contract. The skill's only output is
it; the server's only input is it. Each side is built and tested independently.

**Two deliverables**, one shared contract:
1. **Server** — the `/api/import` endpoint + resolution/assembly modules + tests.
2. **Skill/plugin** — `cns-import-flights`, distributable, with bundled schema +
   examples.

Build order: **server first** (so the skill has something to call), then the skill.

---

## Component 1 — Normalized schema (skill → server contract)

The skill emits exactly this. Codes and structure only — **no coordinates**
(the server resolves those, so geo accuracy never depends on the LLM):

```json
{
  "source": "PH-GOV vluchten — Q1 2022 (xlsx)",
  "defaults": { "plane": "beta_plane", "charger": "dc_320", "freq_basis": "actual" },
  "flights": [
    {
      "route": ["AMS", "BER", "AMS"],
      "date": "2022-01-13",
      "positioning": [false, false, false],
      "pax": 8,
      "operator": "AZ",
      "note": "Technische vlucht"
    }
  ]
}
```

**Field rules:**

- `source` — free-text provenance, echoed in the report. Required.
- `defaults` — optional; server supplies fallbacks (see Component 2).
  - `plane` / `charger` — CNS catalog ids; default electric aircraft + charger.
  - `freq_basis` — `"actual"` (average rate over the covered span) or
    `"regular"` (one flight per unit per unique route). See Frequency below.
- `flights[]` — **one entry per real flight/row** (no aggregation here; that is
  the server's deterministic job).
  - `route` — ordered list of airport codes the aircraft visited, origin first,
    final airport last. A round trip starts and ends with the same code. Codes
    are verbatim from the source (IATA / ICAO / military); the server resolves.
    Required, length ≥ 2.
  - `date` — ISO 8601 (`YYYY-MM-DD`). A source range ("20-21 jan 2022") → the
    start date; the original string is preserved in `note`. Optional but used
    for frequency math when present.
  - `positioning` — optional boolean array parallel to `route`; `true` marks an
    empty ferry/positioning leg (the PDF's `(XXX)`). Server keeps these as
    waypoints by default.
  - `pax`, `operator`, `note` — optional metadata; carried into the report, not
    the simulation.

The server validates this against a JSON Schema on ingest; a malformed payload
→ `400` with the validation error, never a silent bad import.

---

## Component 2 — Server-side translation (the deterministic core)

What `/api/import` does with a valid normalized payload, in order.

### 1. Resolve code → airport

Against the bundled global **`airports.csv`** (the full OurAirports set already
in the repo — not the Europe-only `european_airports.csv`). For each code:

1. exact `ident` (ICAO), case-insensitive
2. exact `iata_code`, case-insensitive
3. exact `municipality` / `name` (last resort)

Returns `{ ident, name, lat: latitude_deg, lon: longitude_deg }`. A code that
resolves to nothing → the **whole flight is dropped**, and the code is recorded
in `report.unresolved_codes`. (Carrying coords in the blob is why
intercontinental airports work even though the CNS app catalog is Europe-only.)

### 2. Classify trip type

From the resolved route idents:

- `route[0] == route[-1]` (round trip):
  - exactly **one** distinct intermediate ident → **`retour`**: `o = route[0]`,
    `d = that intermediate`, `s = []`.
  - **multiple** distinct intermediates → **`circular`**: `o = route[0]`,
    `d = route[0]` (origin), `s = the intermediate idents in order` (per the
    circular model: origin → stops → origin, far point lives in stops).
- otherwise → **`oneway`**: `o = route[0]`, `d = route[-1]`,
  `s = route[1..-2]`.

### 3. Aggregate → frequency

Group flights by **route signature** = (ordered resolved idents + trip type).
Each group → one DC flight. Frequency depends on `freq_basis`:

- `"actual"` (default): `freqUnit = "week"`, `freqN = occurrences ÷ weeks_covered`
  (covered span = max date − min date across the dataset, min 1 week), rounded to
  2 decimals. The honest average steady-state rate; may be fractional.
- `"regular"`: `freqUnit = "week"`, `freqN = 1` per unique route — models each
  route as a hypothetical regular electric service.

If no flights in the dataset carry usable dates, `"actual"` cannot compute a
span and falls back to `"regular"` (with this noted in the report).

> The DC engine only understands `freqUnit ∈ {day, week}` (`flightsPerDay =
> unit==='week' ? freqN/7 : freqN`), so frequency is always expressed in those
> units — never per-year.

### 4. Assign default plane + charger

From `defaults.plane`/`defaults.charger`; if absent or unknown, the server
fallback is the mid-size showcase aircraft `beta_plane` (Beta Alia) + its
default charger — the same choice the embed default settled on (the
longest-range catalog plane has an outsized battery that yields absurd energy
numbers). Switchable later in the DC.

### 5. Assemble + store

Build `{ v:1, k:'build', fl:[…aggregated routes…], cfg:{}, sch:{}, ms:{} }`,
each `fl` entry carrying `{ id, p, c, t, fn, fu, o, d?, s? }` with `{i,la,lo,n}`
points (a stable `id` is generated per route). Enforce the 64 KB
`MAX_STATE_BYTES` (aggregation keeps real datasets well under it), then
`shares.save_state(blob)` → slug → URL.

---

## Component 3 — `/api/import` endpoint

- **`POST /api/import`**
- **Auth:** `Authorization: Bearer <token>` where the token is the env var
  `CNS_IMPORT_TOKEN` on the VPS — **separate** from `CNS_APP_PASSWORD`,
  constant-time compared. Missing/wrong → `401`. This keeps the write endpoint
  gated without a colleague's skill needing the interactive login flow.
- **Body:** the Component 1 JSON.
- **Response 200:** `{ url, slug, report }` (report below).
- **Errors:** `400` (schema-invalid body), `401` (token), `413` (assembled blob
  over 64 KB), `429` (per-token rate limit).
- **Reuse:** `shares.save_state` exists; resolution is a new module over
  `airports.csv`; classification/aggregation/assembly are new, pure, tested
  functions; the route is a thin controller over them.
- **Surface:** write-only to the shares DB; exposes no user data (only geo +
  catalog). Modest per-token rate limit guards abuse.

### Report

```json
{ "url": "https://cns.nrg2fly.nl/s/<slug>", "slug": "<slug>",
  "report": {
    "flights_in": 216,
    "routes_out": 53,
    "dropped": 9,
    "unresolved_codes": ["ADW", "ZZA"],
    "infeasible_for_default": 31
  } }
```

`infeasible_for_default` is a cheap server-side range pre-check (great-circle
leg distance vs the default plane's range) so the user immediately sees how many
legs need a different aircraft. Partial success is the rule: bad rows drop with
reasons, the rest import, both are reported. The skill relays this in plain
language.

---

## Component 4 — The portable skill

- Skill name: **`cns-import-flights`**, shipped as an installable plugin — no
  repo required.
- Responsibilities:
  1. **Clarify first** — before reading or parsing anything, ask the user a
     short, targeted set of questions and wait for answers, so it never burns
     tokens parsing the wrong thing or guessing intent. It asks only what it
     can't infer, keeps it to a handful, then proceeds.
  2. read the user's file (xlsx / PDF / CSV / pasted text) with available tools;
  3. interpret it into the Component 1 schema, handling the source's quirks
     (Dutch date ranges, dash-joined route strings, per-leg passengers,
     positioning `(XXX)`, mixed code systems);
  4. `POST /api/import` with the token;
  5. return the link + a plain-language report.
- **Clarify-first questions** (the upfront step — ask only those not already
  obvious from the request):
  - Which file(s), and — for a multi-sheet workbook or multi-table PDF — which
    sheet/section holds the flights?
  - Default electric aircraft + charger to assign? (offer the catalog default,
    `beta_plane`.)
  - Frequency basis: **`actual`** (default) or `regular`?
  - Keep positioning / empty ferry legs as waypoints, or drop them?
  - Any rows to exclude (e.g. technical or positioning-only flights)?
  - Scope to import — everything, or a specific quarter/year?
  - Target environment + token, if not already configured.
- One-time config the colleague provides: the **API token** (base URL defaults
  to `cns.nrg2fly.nl`).
- Bundled assets: the **JSON Schema** (the LLM targets it and self-validates
  before posting) + **two worked examples** (the PH-GOV xlsx and PDF shapes) as
  few-shot guidance.
- Distribution: packaged as a Claude Code plugin (`.plugin`/zip), installable by
  colleagues with no codebase access.

---

## Security

- **Token-gated** write endpoint; token is a dedicated secret, constant-time
  compared, stored in `/etc/cns.env` alongside the existing auth trio.
- **Schema validation** before any processing — the endpoint never assembles a
  blob from unvalidated input.
- **Size cap** (64 KB) and **rate limit** bound storage and abuse.
- **No user data** is read or returned — only the public geo/catalog data and
  the resulting share blob.
- The skill stores the token in the colleague's local skill config; treat it as
  a shared secret (rotate by changing the env var).

---

## Testing

**Server (deterministic core) — Python `unittest`:**
- Resolution: `AMS → EHAM` (IATA), ICAO passthrough (`EHAM → EHAM`), unknown
  code → flight dropped + recorded.
- Trip type: `AMS-BER-AMS → retour`; `AMS-LUN-WKF-NBO-AMS → circular`;
  `AMS-BER → oneway`.
- Aggregation: N identical routes → one flight, `freqN` per `freq_basis`
  (`actual` = N/weeks; `regular` = 1).
- Assembly: blob validates, fits the cap, round-trips through `shares.save_state`
  / `load_state`.
- Endpoint: `401` without token, happy path returns `url` + `report`, `413`
  oversize, `400` malformed body.
- Range pre-check: a long-haul leg (e.g. AMS→JFK) counts toward
  `infeasible_for_default`; a short leg (AMS→BER) does not.

**Skill — sample-driven:**
- Run on the two real PH-GOV samples; assert it emits schema-valid normalized
  JSON and the returned link opens in the DC with sensible routes (a golden
  check on the normalized output).

---

## Resolved decisions

**Frequency default = `"actual"`.** Imports use the real average weekly rate
over the dataset span (honest, even when small/fractional for sporadic flights).
The viewer can change any flight's frequency in the DC afterward, and the
`"regular"` basis (1 flight/week per unique route) remains available via the
knob. So the import stays truthful by default and the "scheduled electric
service" framing is one edit away.

## Future extensions

- A web upload page in the CNS app reusing `/api/import`.
- Importing `cfg`/`sch` when a source carries charger or schedule data.
- A reverse export (build blob → normalized JSON) for round-tripping.
- Caching resolution + a curated alias table for stubborn military/non-standard
  codes (ADW, BZZ, ZZA…).
