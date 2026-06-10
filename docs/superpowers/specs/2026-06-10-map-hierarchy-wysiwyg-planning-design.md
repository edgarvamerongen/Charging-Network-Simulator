# Map layer hierarchy + WYSIWYG planning — design

**Date:** 2026-06-10 · **Status:** approved (Edgar) · **Scope:** desktop (`templates/index.html`, `static/routing.js`, `static/recompute.js`, tests)

## Problem

Three half-overlapping mechanisms govern what the map shows and what the planner
may route through:

1. The S/M/L size checkboxes drive both the visible dot clusters **and** the
   planner's `_allowedTypes()` — WYSIWYG holds here.
2. The NRG2fly network layer draws charger sites whenever "Show charger sites"
   is on — even when their size class is unchecked — but the planner only
   consults size classes. **Visible network sites can be unroutable** (the
   Velis "no route" confusion).
3. "Hide when route is planned" hides only the size clusters; network teardrops
   stay and clutter the planned-route view. Leg pins ("flight labels") overlap
   markers.

Additionally, the DC recompute inherits the live map filters (`ctx.allowedTypes`),
so toggling a **map option** could re-plan or flag **saved** flights — mixing a
view concern into the persistent model.

## Principle: two domains, two pools

| Domain | Candidate pool | Reacts to |
|---|---|---|
| **Live planner** (Create-a-route) | **WYSIWYG** — checked size classes ∪ network sites while the network layer is on | map options + model settings |
| **DC recompute** (saved flights) | **Full catalog** — every airport type + all network sites, always | **model settings only** |

- Map options are a *usability lens* for building new routes. They have **zero**
  effect on saved flights.
- The DC `⚠ no route` flag is a **pure physics verdict** (range, reserves,
  SID/STAR, alternate divert) — exactly the Model-settings domain. Recompute
  triggers stay as-is (settings change + modal open; never map-option changes).
- Planner and DC may legitimately disagree for the same city pair: the planner
  answers "what can I build with what I've chosen to see", the DC answers
  "does my network still physically work".

## Layer hierarchy (bottom → top)

| # | Layer | Shown when | Routable (live planner)? |
|---|-------|-----------|--------------------------|
| 1 | Base tiles (satellite/street) | always | — |
| 2 | Catalog airports (S/M/L clusters) | size checkbox on, **and** not decluttered | yes, iff shown by filter |
| 3 | NRG2fly charger sites (dot + teardrop) | network toggle on, **and** not decluttered | yes, iff toggle on |
| 4 | Leg labels (per-leg dist · time · energy) | route exists + "Leg labels" on | — (route metadata) |
| 5 | Route: line, blue dots, endpoint/stop teardrops, alternates | route exists — **never hidden** | — (route output) |

## Changes

### C1 — WYSIWYG candidate pool (live planner only)
`planRoute`/`planChain` accept `allowedIdents` (a `Set` of airport idents)
alongside `allowedTypes`; a candidate passes when
`allowedTypes.has(a.type) || allowedIdents.has(a.ident)`.

- Live planner callers (`recomputeRoute`, `validateRoute` remedies) pass
  `allowedIdents` = all NRG2fly charger idents **when the network toggle is on**,
  else an empty set.
- `_couldEnablingTypesRoute()` (the "Enable all types" remedy gate) uses the same
  pool so it never offers a dead remedy — and the no-route message can now also
  hint at switching the network layer on when *that* would route the legs.

### C2 — DC recompute pool = full catalog
`_recomputeCtx()` stops reading `_allowedTypes()`; it passes all three size
classes + `allowedIdents` = all network charger idents, unconditionally.
`routingOptions` (Prefer/typePenalty) stays forwarded — with the soft-preference
fallback it biases stop *choice*, never feasibility. Manual stops stay preserved.

### C3 — True declutter
"Hide when route is planned" → label **"Declutter when route is planned"**, moved
to the ROUTE group. When a route exists and it's on, layers **2 and 3** hide
(today: only 2). Route artifacts (layer 5) and leg labels (4) stay. Declutter is
**view-only**: the planner pool is computed from the filter state, not from what
declutter currently displays.

### C4 — Leg labels
- Rename "Show flight labels" → **"Leg labels"** (+ tour copy if referenced).
- Render label pins in a dedicated map pane **below** routePane/teardropPane so a
  label can never cover a marker — pins win, labels peek.
- Offset labels perpendicular to the leg midpoint instead of sitting on the line.
- Existing hover/Expand behavior unchanged.

### C5 — Options menu regrouped to read as the hierarchy
`AIRPORTS (planning)` → S/M/L · `NRG2FLY NETWORK (planning)` → Show charger
sites · `ROUTE` → Leg labels, Expand labels, Alternates, Declutter when route is
planned. ("planning" suffix communicates the WYSIWYG rule.)

## Out of scope (YAGNI)
- Per-airport pin/exclude UI (the removed-stop blacklist already covers it).
- Label collision detection (pane order + offset suffices; revisit on evidence).
- Mobile (`/m/`) — other session's lane; this spec is desktop-only.
- Changing recompute triggers (already settings-only).

## Edge cases
- **Manual stops** are exempt from pools everywhere (pinned = honored), as today.
- A flight **added** under WYSIWYG keeps its as-planned route until a model-settings
  change recomputes it against the full catalog.
- "Enable all types" button: unchanged semantics, but its feasibility probe uses
  the C1 pool (types ∪ network idents).
- Tour: anchors into the options menu and the network toggle must be re-verified
  after C5 (`CNSTour.check()`); demo route (Lelystad→Munich) unaffected.

## Testing
- `js_routing`: `allowedIdents` admits an ident whose type is filtered off;
  empty set preserves today's behavior (regression).
- `js_recompute`: ctx pool independence — a flight routable only via a
  small/network airport stays feasible with `allowedTypes=['medium','large']`-style
  map state (i.e., ctx no longer derived from map filters).
- Existing suites (goldens, sched snapshot) must stay green — no model change.
- Browser smoke on :5055: declutter hides network teardrops; leg labels sit
  under pins; network-only stop plans while Small is off.
