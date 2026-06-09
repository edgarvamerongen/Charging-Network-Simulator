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

*(Captured while exploring — see notes below; expand as the idea develops.)*

**Goal:** mine real short-haul flights (e.g. **< 400 km, conventional/ICE
aircraft, recent**) from real airspace/ADS-B data and integrate them into CNS as
realistic demand — i.e. identify routes that are good **electrification
candidates** and pre-populate the simulator with true flight patterns.

This feeds the existing demand/folder model and reinforces both the realism work
and the network-platform vision (real edges between real airports).
