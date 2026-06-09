# Feature proposal: circular trips & custom-coordinate landing strips

Status: **idea / not designed yet.** This document only describes *what* we
want, in plain terms. The *how* (data model, UI, scheduler/sim changes) comes
later.

## Where this fits today

A route ("trip") in CNS currently has one of these shapes:

- **one-way** — take off at the origin, land at the destination, stay there.
- **retour** — origin → destination → back to origin (2 legs).
- **multi-leg** — origin → an ordered list of `stops` → destination.

Every place a plane can touch down is an **airport** referenced by its ident
code (e.g. `EHLE`, `EDDF`), which the simulator resolves to a latitude /
longitude from the bundled European-airports catalog.

The two features below extend that picture.

---

## Feature 1 — Circular (round-robin) trip type

### What we want

A new trip type where an aircraft flies a **closed loop through several stops
and returns to where it started**, e.g.:

```
A → B → C → A   (and then repeats)
```

Unlike a retour (which is just out-and-back along the *same* leg), a circular
trip visits **multiple distinct waypoints in order** and the **last leg closes
the loop back to the origin**. Unlike the current multi-leg one-way (origin →
stops → a *different* destination), here the destination **is** the origin, so
the pattern can be flown over and over by the same aircraft.

### Why

- Models real recurring patrol / supply / shuttle routes that serve a ring of
  sites from a single home base.
- Lets one aircraft service several outstations per rotation instead of needing
  a separate trip per pair.

### Behaviour we expect

- The user defines an **ordered list of waypoints** (A, B, C, …). The loop
  automatically closes from the last waypoint back to A — the user does **not**
  re-enter A at the end.
- Each leg (A→B, B→C, …, last→A) has its own distance / flight time, derived
  from the waypoint coordinates just like existing legs.
- Charging can happen at **any** waypoint in the loop, including intermediate
  ones — the scheduler should treat every stop as a potential charge point, not
  only origin/destination.
- "Flights per day" / rotations should mean **complete loops** per day.
- Energy and battery sizing must account for the **longest single leg** in the
  loop (so the plane can always reach the next stop), and for the full loop
  when sizing daily energy.

### Open questions (for the design phase)

- Can a waypoint appear more than once in a loop?
- Do we allow a minimum turnaround/charge time per waypoint, or only at the
  home base?
- How does this interact with `fleetMode` (shared vs separate aircraft)?

---

## Feature 2 — Custom-coordinate landing strips

### What we want

The ability to define a **landing point by raw latitude / longitude** instead
of picking a known airport from the catalog. This lets a trip touch down at a
location that isn't a registered airport — for example a **drilling platform or
vessel at sea**, a private strip, a heliport, or any ad-hoc site.

> "Not see, but the sea" — the key case is an **offshore** destination (oil/gas
> platform, ship) that has no airport ident at all.

### Why

- Many realistic missions land somewhere with no ICAO/IATA code (offshore
  platforms, remote sites, temporary strips).
- Today every stop must resolve to a catalog airport, which blocks these
  scenarios entirely.

### Behaviour we expect

- When adding an origin, destination, or stop, the user can choose **"custom
  location"** and enter:
  - a **name / label** (e.g. "Platform Alpha"),
  - **latitude** and **longitude** (decimal degrees),
  - optionally an **elevation** (platforms sit near sea level; could matter for
    energy later).
- A custom location behaves like an airport everywhere downstream:
  distance/leg-time come from its coordinates (same haversine math), it can be a
  charge point, and it appears on the map and in reports with its label.
- Custom locations should be **savable/reusable**, so a platform defined once
  can be dropped into other trips without re-typing coordinates.
- Mixed routes are allowed: e.g. catalog airport → catalog airport → **custom
  platform** → back (combines naturally with Feature 1's circular trips).

### Open questions (for the design phase)

- Where do custom locations live — per trip, or a shared user catalog
  (alongside `planes.json` / `chargers.json`)?
- Do we validate lat/lon ranges and warn on obviously-wrong values?
- Should custom locations carry their own charger availability, or assume the
  aircraft must arrive with enough charge to leave again (likely true for an
  offshore platform with no charger)?
- Input format: decimal degrees only, or also accept degrees-minutes-seconds?

---

## How the two features combine

The headline scenario is **both at once**: a circular supply run from a coastal
base out to one or more offshore platforms and back —

```
Home airport → Platform Alpha (custom coords) → Platform Bravo (custom coords) → Home airport
```

flown as a repeating loop, where the platforms are pure lat/lon points with no
airport ident and (probably) no charger, so battery sizing must guarantee the
aircraft can complete the longest over-water leg and get home.
