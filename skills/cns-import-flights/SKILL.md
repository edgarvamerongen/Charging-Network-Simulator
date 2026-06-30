---
name: cns-import-flights
description: Use when a user wants to import an external flight history (xlsx, PDF, CSV, or pasted text) into the NRG2fly Charging Network Simulator. Interprets the source into normalized JSON, posts it to the CNS import API, and returns a shareable /s/<slug> link that opens the routes in the Demand Calculator.
---

# CNS Flight-Data Import

Turn any provider's flight history into a CNS build-share link.

## Step 1 — Clarify first (before reading anything)

Do NOT parse the file yet. Ask the user only the questions you cannot infer from
their request, then wait for answers. This avoids wasting tokens parsing the
wrong thing:

- Which file(s)? For a multi-sheet workbook or multi-table PDF, which sheet/section holds the flights?
- Default electric aircraft + charger to assign? (Default `beta_plane`; the viewer can change it in the DC.)
- Frequency basis: `actual` (real average rate — default) or `regular` (1 flight/week per route)?
- Keep positioning / empty ferry legs as waypoints, or drop them?
- Any rows to exclude (e.g. technical or positioning-only flights)?
- Scope — everything, or a specific quarter/year?
- The CNS base URL + import token, if not already configured.

## Step 2 — Interpret the source → normalized JSON

Read the file and produce JSON matching `schema.json` (bundled here). Codes stay
verbatim (IATA/ICAO/military) — the server resolves coordinates, so never invent
lat/lon. One entry per real flight; do NOT aggregate (the server does). See
`examples/ph-gov-xlsx.md` and `examples/ph-gov-pdf.md` for the two common shapes.
Validate your JSON against `schema.json` before posting.

## Step 3 — Post to the import API

```
POST {base_url}/api/import
Authorization: Bearer {import_token}
Content-Type: application/json

{ ...the normalized JSON... }
```

`base_url` defaults to `https://cns.nrg2fly.nl`. The token is a shared secret the
user provides once.

## Step 4 — Report back

On `200`, return the `url` and translate the `report` into plain language, e.g.:
"Imported 53 routes from 216 flights. 9 dropped (7 codes unresolved: ADW, ZZA…).
31 legs are infeasible for the Beta default — switch the aircraft in the DC to
test electrifying them. Open: <url>".

Handle errors: `401` = bad/missing token; `400` = the JSON didn't match the
schema (fix and retry); `413` = too many routes to share in one link.
