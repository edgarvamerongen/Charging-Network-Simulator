# CNS — Long-Term Ideas & Vision

A parking lot for **big-picture, long-horizon ideas** that shape where CNS is
heading — distinct from `BACKLOG.md`, which tracks near-term, scoped tasks.
Nothing here is committed work; it's the north star we keep in mind while
building smaller features so today's choices stay compatible with tomorrow's
direction.

---

## Vision: CNS as an owner-maintained airport network platform

**The idea in one line:** evolve CNS from a single-user simulator into a shared,
crowdsourced network where **airport owners maintain their own airport's real
data**, and every contribution makes the whole simulator more realistic and
trustworthy.

### How it works
- **Verified accounts.** A legitimate airport owner/operator can register, is
  verified ("granted a certificate"), and can log in to create and maintain
  **their own** airport profile.
- **Owners maintain ground truth** for the airport they own:
  - chargers (count, power, type) and **grid capacity / site cap**
  - **energy sources** (grid, solar, storage, etc.)
  - their **based aircraft / fleet**
  - **daily flight schedule**
  - **real SID/STAR** procedures
  - **connections** to other aircraft and other airports (the network edges)
- **Network effect (the flywheel).** Every airport that joins adds real data, so
  the simulator gets more accurate → more useful → attracts more owners. The
  shared database becomes a defensible, trustworthy picture of electric-aviation
  ground infrastructure — something nobody has today.

### Why this is the north star
The "make the simulator realistic" feature work (real grid caps, real charger
fleets, contract-gated charger access, true SID/STAR) is **the same data an
owner would fill in**. So realism work and the platform vision are not
competing — the physics/realism features are the *substance the platform
collects*. Building them well now keeps the door open to the platform later.

### Risk assessment (where the difficulty actually lives)
Ordered by risk — note the engineering is the *least* risky part, which is a
good sign for an infrastructure registry:

1. **Ownership verification (KYC).** Proving a person/org really owns an airport
   is a trust/legal problem, not a code problem.
   - *Our advantage:* **we work in the business and already know most airport
     owners in NL** — a strong, warm-start path to verified contributors.
2. **Contributor incentives.** Some data (grid cap, energy mix, schedules) is
   commercially sensitive; owners need a reason to share.
   - *Our angle:* **a working, successful network + modelling software makes it
     materially easier to attract funding** — the platform's existence is itself
     the incentive flywheel for the ecosystem.
3. **Engineering.** Multi-tenant accounts, auth, per-owner edit permissions, and
   a shared database are a real re-platforming from today's single-shared-state
   + localStorage app — but very doable. **Problem for later.**
4. **Governance / data trust.** Dispute resolution, stale/wrong data,
   provenance ("who entered what, when, verified?"), moderation.
5. **Cold-start.** Seed with public data first (OurAirports, OpenChargeMap,
   published charger info) so the network view is useful on day one, then invite
   owners to *claim and correct* their profile.

### Connection to ISO 15118 / PKI
The "grant a certificate to a legit owner" instinct is the **ISO 15118 identity
concept applied at the human/organization layer**: a trusted authority vouches
that an actor is who they claim to be. Same principle scales from *a charger
proving itself to an aircraft* (machine-to-machine, automatic) up to *an airport
owner proving themselves to the platform* (org-level KYC). Worth keeping the
mental model consistent across both layers.

### Cheapest experiment to validate before building
Don't build the platform to test the idea. Seed public airport data, mark a
couple as "verified by owner," and see whether the **network view** is
compelling enough that an operator would want their airport in it. That tells us
if the flywheel will spin before investing in the accounts system.

---

## Data ingestion: real flight data to seed realistic demand

*(Exploration notes — not a build plan.)*

**Goal:** mine real short-haul flights (**< 400 km, conventional / non-electric
aircraft, recent**) from real airspace data and integrate them into CNS as
realistic demand — identify routes that are good **electrification candidates**
and pre-populate the simulator with true flight patterns. The 400 km threshold
is meaningful because it's roughly the electric-aviation range frontier, so the
filter literally selects the addressable market.

This feeds the existing demand/folder model and reinforces both the realism work
and the network-platform vision (real flights become real **network edges**
between real airports — the same edges an owner would later confirm or correct).

### Terminology nuance
"ICE flights" in practice ≈ **every flight flying today** (piston GA + turbine
turboprops/jets — all non-electric). The useful filter is "**conventional /
non-electric flights < 400 km**" = the electrification-candidate pool. The
sub-question that matters is *aircraft type*, because it tells us which CNS
electric model is the realistic replacement (a 4-seat piston trainer ≠ an ATR
turboprop).

### Data sources (two flavors)
**What actually flew (ADS-B / surveillance):**
- **OpenSky Network** — *free for research/non-commercial*, REST API + multi-year
  historical archive. Best starting point for "past month" at zero cost.
  Rate-limited; coverage gaps for low-altitude GA and over water.
- **Eurocontrol** (DDR2 / aviation data repository) — *actual flown* trajectories
  + flight tables for European airspace, free for research with registration.
  **The gold source for NL/EU short-haul** given our EU focus.
- **ADS-B Exchange / Flightradar24 / FlightAware** — better coverage, but
  commercial/paid.

**What was scheduled (schedule data):** OAG, Cirium — cleaner
origin/dest/type/frequency, but *scheduled commercial service only*, so it
**misses GA** — and much sub-400 km flying is GA/training, possibly our market.

*Recommendation:* start with **OpenSky** (free, prove the pipeline), graduate to
**Eurocontrol** for the authoritative EU dataset.

### The < 400 km filter — CNS is already set up for it
Filter *after* resolving each flight to an **origin → destination airport pair**,
using assets CNS already has:
- **`european_airports.csv`** — airport coordinates (already loaded/indexed).
- **The haversine / great-circle math in `sim.py`** — same distance function the
  simulator already uses for routing.

Pipeline: raw flight → resolve departure & arrival airport → compute
great-circle distance with the existing function → keep if **< 400 km**.

### Mapping onto existing CNS structures (no new concepts)
Aggregate raw flights into objects CNS already has:
- **Raw flights → a route** (origin-dest pair).
- **Count over the month → frequency** — trips already carry `freqN` / `freqUnit`
  (e.g. a month of ADS-B becomes "Lelystad→Groningen, 4 flights/day").
- **Real aircraft type → nearest CNS electric plane** — map observed ICAO type
  designator (via registration lookup) to the closest model in `planes.json`:
  the "what if this route went electric?" substitution.
- **Aggregated routes → the demand/folder model**; per-airport demand falls out.

*Shape:* an **offline batch script** (mirroring `prepare_data.py`) that
pulls → filters → aggregates → writes a tracked JSON catalog (like
`planes.json` / `chargers.json`) the app loads. Keeping it offline avoids live
API costs/rate-limits and preserves the app's stateless design.

### Gotchas
- **Airport resolution is the messy part** — ADS-B gives positions, not
  "departed EHLE"; infer origin/dest from where the track starts/ends near a
  known airport (fiddly for GA fields and touch-and-gos).
- **Coverage gaps** for low-altitude GA — undercounts exactly the small-aircraft
  flights that matter most.
- **Aircraft type needs a second lookup** (registration → type database).
- **GA vs commercial** — decide early which you care about; sub-400 km is heavy
  on GA, which schedule data won't show.
