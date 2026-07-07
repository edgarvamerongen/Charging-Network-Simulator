#!/usr/bin/env python3
"""Sync the CNS aircraft catalog FROM Notion into data/planes.generated.json.

Notion is the master catalog (colleagues edit it there); CNS only reads. This
script pulls the two Notion databases (Aircraft + Performance Profiles),
transforms them into today's planes.json shape — one array entry per emitted
profile of every `CNS`-checked aircraft — validates each aircraft, and writes
the result atomically. sim.py loads that generated file in preference to the
tracked planes.json.

Full spec: `NOTION_CATALOG_PLAN.md` (repo root), §6–§8. Decisions D1–D10 there
are locked. This module is intentionally self-contained (no dependency on the
abandoned plane_schema.py experiment) and validates fresh per §8.

Design guarantees:
  * A bad Notion edit can NEVER take the app down. Per-aircraft quarantine
    carries the last-good entry forward (§8, D7); a suspicious global result
    (empty pull, <50% of last-good, API failure) aborts and leaves the live
    file untouched.
  * "You own your data": every successful sync snapshots the output under
    data/snapshots/ (newest 30 kept), so the catalog survives Notion lock-in.

CLI:
    python notion_sync.py [--dry-run]

Env (from /etc/cns.env on the VPS; never hard-coded):
    CNS_NOTION_TOKEN         internal-integration secret (CNS-Connector)
    CNS_NOTION_AIRCRAFT_DB   Aircraft database id
    CNS_NOTION_PROFILES_DB   Performance Profiles database id
"""
import argparse
import glob
import json
import math
import os
import re
import sys
import tempfile
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone

import requests

# --- Notion API -------------------------------------------------------------
# Pin the API version: newer versions ("2025-09-03"+) split databases into
# "data sources" and change the query response shape. 2022-06-28 is the stable
# shape this transform targets.
NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"

ENV_TOKEN = "CNS_NOTION_TOKEN"
ENV_AIRCRAFT_DB = "CNS_NOTION_AIRCRAFT_DB"
ENV_PROFILES_DB = "CNS_NOTION_PROFILES_DB"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Slugs / emit ids are catalog identifiers referenced by static/tour.js and the
# test goldens — keep them boring and machine-safe.
SLUG_RE = re.compile(r"^[a-z0-9_]+$")

# Sanity bounds — reject absurd-but-finite values that would later overflow the
# simulator's energy/time math. Mirrors the spirit of app.py's custom-plane
# checks (app.py:714-736), tightened to realistic electric-airframe ranges.
BATTERY_MAX_KWH = 100_000
RANGE_MAX_KM = 20_000
SEATS_MAX = 1_000
SPEED_MIN_KMH, SPEED_MAX_KMH = 40, 1_000

KT_TO_KMH = 1.852

# Snapshots retained (newest-first) after each successful sync.
SNAPSHOT_KEEP = 30

# Abort the whole sync (leave last-good untouched) if the fresh result collapses
# to below this fraction of the previous catalog — guards against a Notion
# outage / accidental mass-unpublish silently emptying CNS.
MIN_FRACTION_OF_LAST_GOOD = 0.5

_REGIME_CANON = {"vfr": "VFR", "ifr+reserves": "IFR+reserves", "ifr": "IFR+reserves"}


class NotionError(RuntimeError):
    """Notion API / auth / transport failure — treated as a global abort."""


# ---------------------------------------------------------------------------
# Notion property extraction (pure — the seam the tests exercise)
# ---------------------------------------------------------------------------
def _extract(prop):
    """Reduce a Notion property object to a plain Python value by its type."""
    if not isinstance(prop, dict):
        return None
    t = prop.get("type")
    if t in ("title", "rich_text"):
        return "".join(r.get("plain_text", "") for r in (prop.get(t) or []))
    if t == "number":
        return prop.get("number")
    if t in ("select", "status"):
        s = prop.get(t)
        return s.get("name") if isinstance(s, dict) else None
    if t == "multi_select":
        return [o.get("name") for o in (prop.get("multi_select") or [])]
    if t == "checkbox":
        return bool(prop.get("checkbox", False))
    if t == "relation":
        return [r.get("id") for r in (prop.get("relation") or [])]
    return None  # date/formula/rollup/people/… — not part of our schema


def _props(page):
    return {name: _extract(prop) for name, prop in (page.get("properties") or {}).items()}


def _norm_text(v):
    """Trim + collapse inner whitespace. Kills the 'Grass ' vs 'grass' drift."""
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def _slug(v):
    """Lowercase + trim (no space→underscore rewrite — a slug with spaces should
    FAIL validation loudly, not be silently 'fixed')."""
    return _norm_text(v).lower()


def _num(v):
    """Notion number → finite float/int, else None (rejects bool / NaN / inf)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v if math.isfinite(v) else None


def _canon_regime(v):
    t = _norm_text(v)
    return _REGIME_CANON.get(t.lower(), t)


def kt_to_kmh(kt):
    return round(kt * KT_TO_KMH)


# ---------------------------------------------------------------------------
# Page → normalized record (pure)
# ---------------------------------------------------------------------------
def parse_aircraft(page):
    p = _props(page)
    return {
        "page_id": page.get("id"),
        "created_time": page.get("created_time", ""),
        "name": _norm_text(p.get("Name")),
        "slug": _slug(p.get("Slug")),
        "cns": bool(p.get("CNS")),
        "oem": _norm_text(p.get("OEM")),
        "type_": _norm_text(p.get("Type")),
        "status": _norm_text(p.get("Status")),
        "cert_year": _num(p.get("Certification year")),
        "propulsion": _norm_text(p.get("Propulsion")),
        "battery_kwh": _num(p.get("Battery (kWh)")),
        "cruise_kt": _num(p.get("Cruise speed (kt)")),
        "max_kw": _num(p.get("Max kW")),
        "country": _norm_text(p.get("Country")),
        "mtow_kg": _num(p.get("MTOW (kg)")),
        "training_range_km": _num(p.get("Training range (km)")),
        "simul_max": _num(p.get("Simultaneous charging max")),
        "chargers": [_norm_text(c) for c in (p.get("Chargers") or []) if c],
        "image": _norm_text(p.get("Image")),
        "svg": _norm_text(p.get("SVG")),
    }


def parse_profile(page):
    p = _props(page)
    return {
        "page_id": page.get("id"),
        "label": _norm_text(p.get("Label")),
        "aircraft_ids": list(p.get("Aircraft") or []),
        "emit_id": _slug(p.get("Emit ID")),
        "default": bool(p.get("Default")),
        "seats": _num(p.get("Seats")),
        "payload_kg": _num(p.get("Payload (kg)")),
        "regime": _canon_regime(p.get("Regime")),
        "range_km": _num(p.get("Range (km)")),
        "surface": _norm_text(p.get("Surface")).lower(),
        "min_runway_m": _num(p.get("Min runway (m)")),
        "max_duration_min": _num(p.get("Max flight duration (min)")),
        "display_name": _norm_text(p.get("Display name")),
        "source": _norm_text(p.get("Source")),
        "confidence": _norm_text(p.get("Confidence")),
    }


# ---------------------------------------------------------------------------
# Validation (pure, §8)
# ---------------------------------------------------------------------------
def validate_aircraft(ac, profs, known_charger_ids, duplicated_emit_ids):
    """Return a list of fatal-error strings. Empty list == aircraft is emittable.
    Any error quarantines the aircraft AND all its profiles (§8, D7)."""
    errors = []

    if not ac["slug"] or not SLUG_RE.match(ac["slug"]):
        errors.append("missing or invalid Slug (need [a-z0-9_]+)")

    battery = ac["battery_kwh"]
    if battery is None or battery <= 0:
        errors.append("Battery (kWh) missing or <= 0")
    elif not (1 <= battery <= BATTERY_MAX_KWH):
        errors.append(f"Battery {battery} kWh out of bounds [1, {BATTERY_MAX_KWH}]")

    cruise = ac["cruise_kt"]
    if cruise is None or cruise <= 0:
        errors.append("Cruise speed (kt) missing or <= 0")
    else:
        spd = kt_to_kmh(cruise)
        if not (SPEED_MIN_KMH <= spd <= SPEED_MAX_KMH):
            errors.append(
                f"Cruise {cruise} kt -> {spd} km/h out of bounds "
                f"[{SPEED_MIN_KMH}, {SPEED_MAX_KMH}]"
            )

    for cid in ac["chargers"]:
        if cid not in known_charger_ids:
            errors.append(f"unknown charger id '{cid}' (not in chargers.json)")

    if not profs:
        errors.append("no performance profiles linked")
    else:
        defaults = sum(1 for p in profs if p["default"])
        if defaults != 1:
            errors.append(f"expected exactly one Default profile, found {defaults}")

    for p in profs:
        tag = p["label"] or p["emit_id"] or "(profile)"
        if not p["emit_id"] or not SLUG_RE.match(p["emit_id"]):
            errors.append(f"{tag}: missing or invalid Emit ID")
        elif p["emit_id"] in duplicated_emit_ids:
            errors.append(f"{tag}: Emit ID '{p['emit_id']}' collides with another profile")
        if p["seats"] is None or p["seats"] <= 0:
            errors.append(f"{tag}: Seats missing or <= 0")
        elif not (1 <= p["seats"] <= SEATS_MAX):
            errors.append(f"{tag}: Seats {p['seats']} out of bounds [1, {SEATS_MAX}]")
        if not p["regime"]:
            errors.append(f"{tag}: Regime missing")
        if p["range_km"] is None or p["range_km"] <= 0:
            errors.append(f"{tag}: Range (km) missing or <= 0")
        elif not (1 <= p["range_km"] <= RANGE_MAX_KM):
            errors.append(f"{tag}: Range {p['range_km']} km out of bounds [1, {RANGE_MAX_KM}]")

    return errors


# ---------------------------------------------------------------------------
# Emission (pure, §6)
# ---------------------------------------------------------------------------
def _emit_name(ac, prof, single):
    if prof["display_name"]:
        return prof["display_name"]
    if single:
        return ac["name"]
    return f"{ac['name']} — {prof['label']}".strip(" —")


def _clean_int(v):
    """Emit whole numbers as int (22, not 22.0) but keep genuine fractions."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def build_entries(ac, profs):
    """Build the emitted plane dicts for one valid aircraft (default profile
    first, per §6). One dict per profile — mirrors the old vaeridion/
    vaeridion_light split, so the frontend needs no change in Phase 1."""
    ordered = sorted(profs, key=lambda p: (not p["default"]))
    single = len(ordered) == 1
    speed_kmh = kt_to_kmh(ac["cruise_kt"])
    out = []
    for p in ordered:
        entry = {
            "id": p["emit_id"],
            "name": _emit_name(ac, p, single),
            "seats": int(p["seats"]),
            "battery_kwh": _clean_int(ac["battery_kwh"]),
            "range_km": _clean_int(p["range_km"]),
            "speed_kmh": speed_kmh,
        }
        if p["payload_kg"] is not None:
            entry["load_kg"] = _clean_int(p["payload_kg"])
        if ac["training_range_km"] is not None:
            entry["training_range_km"] = _clean_int(ac["training_range_km"])
        if ac["image"]:
            entry["image"] = ac["image"]
        if ac["svg"]:
            entry["svg"] = ac["svg"]
        if ac["chargers"]:
            entry["default_charger_id"] = ac["chargers"][0]
        if ac["simul_max"] is not None and ac["simul_max"] >= 2:
            entry["simultaneous_charging"] = {"enabled": True, "max": int(ac["simul_max"])}

        # Additive metadata — templates/JS ignore unknown keys today and may
        # start surfacing these later (filters, spec sheet). Omit blanks.
        meta = {
            "aircraft_id": ac["slug"],
            "oem": ac["oem"],
            "type": ac["type_"],
            "status": ac["status"],
            "certification_year": _clean_int(ac["cert_year"]) if ac["cert_year"] is not None else None,
            "propulsion": ac["propulsion"],
            "max_charge_kw": _clean_int(ac["max_kw"]) if ac["max_kw"] is not None else None,
            "country": ac["country"],
            "mtow_kg": _clean_int(ac["mtow_kg"]) if ac["mtow_kg"] is not None else None,
            "regime": p["regime"],
            "surface": p["surface"],
            "min_runway_m": _clean_int(p["min_runway_m"]) if p["min_runway_m"] is not None else None,
            "max_flight_duration_min": _clean_int(p["max_duration_min"]) if p["max_duration_min"] is not None else None,
            "profile_label": p["label"],
            "source": p["source"],
            "confidence": p["confidence"],
        }
        for k, v in meta.items():
            if v is not None and v != "":
                entry[k] = v
        out.append(entry)
    return out


# ---------------------------------------------------------------------------
# Transform: pages -> (entries, report)   (pure — no network, no disk)
# ---------------------------------------------------------------------------
def transform(aircraft_pages, profile_pages, known_charger_ids, last_good_by_id=None):
    """Group profiles under aircraft, filter to `CNS`-checked, validate, emit;
    quarantine invalid aircraft (carrying their last-good entries forward).

    Returns (entries, report). report['abort'] is a string reason when the
    result is too suspicious to write, else None.
    """
    last_good_by_id = last_good_by_id or {}
    last_good_count = len(last_good_by_id)

    aircraft = [parse_aircraft(pg) for pg in aircraft_pages]
    profiles = [parse_profile(pg) for pg in profile_pages]

    # Emit-id collisions are a GLOBAL property — pre-scan so the outcome doesn't
    # depend on aircraft iteration order.
    counts = Counter(p["emit_id"] for p in profiles if p["emit_id"])
    duplicated = {eid for eid, c in counts.items() if c > 1}

    profs_by_ac = defaultdict(list)
    for pr in profiles:
        for ac_id in pr["aircraft_ids"]:
            profs_by_ac[ac_id].append(pr)

    # Deterministic order: aircraft by Notion creation time.
    aircraft.sort(key=lambda a: a["created_time"])

    entries, ok_ids, hidden, skipped, carried = [], [], [], [], []
    for ac in aircraft:
        profs = profs_by_ac.get(ac["page_id"], [])
        label = ac["slug"] or ac["name"] or ac["page_id"]

        if not ac["cns"]:
            hidden.append(label)  # staged "planes to come" — not an error
            continue

        errors = validate_aircraft(ac, profs, known_charger_ids, duplicated)
        if errors:
            # Carry forward this aircraft's known emit ids from the last-good
            # file so a colleague's typo never *removes* a plane from CNS.
            for eid in (p["emit_id"] for p in profs if p["emit_id"]):
                prev = last_good_by_id.get(eid)
                if prev is not None and prev["id"] not in carried:
                    entries.append(prev)
                    carried.append(prev["id"])
            skipped.append({"slug": label, "errors": errors})
            continue

        built = build_entries(ac, profs)
        entries.extend(built)
        ok_ids.extend(e["id"] for e in built)

    abort = None
    if not ok_ids and not carried:
        abort = "no valid aircraft emitted"
    elif last_good_count and len(entries) < MIN_FRACTION_OF_LAST_GOOD * last_good_count:
        abort = (f"emitted {len(entries)} entries < {int(MIN_FRACTION_OF_LAST_GOOD * 100)}% "
                 f"of last-good {last_good_count} — refusing to shrink the catalog")

    report = {
        "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "emitted": len(entries),
        "ok": ok_ids,
        "hidden": hidden,
        "skipped": skipped,
        "carried_forward": carried,
        "notion_pages_read": len(aircraft_pages) + len(profile_pages),
        "abort": abort,
    }
    return entries, report


# ---------------------------------------------------------------------------
# Notion network layer
# ---------------------------------------------------------------------------
def _session(token):
    s = requests.Session()
    s.headers.update({
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    })
    return s


def notion_query(db_id, session, page_size=100, max_retries=5):
    """Return all pages of a database query, following pagination and honoring
    429 Retry-After (Notion rate-limits ~3 req/s)."""
    url = f"{NOTION_API}/databases/{db_id}/query"
    payload = {"page_size": page_size}
    results = []
    while True:
        resp = None
        for _ in range(max_retries + 1):
            resp = session.post(url, json=payload, timeout=30)
            if resp.status_code == 429:
                time.sleep(min(float(resp.headers.get("Retry-After", "1") or 1), 30))
                continue
            break
        if resp is None or resp.status_code != 200:
            code = getattr(resp, "status_code", "no response")
            body = (getattr(resp, "text", "") or "")[:300]
            raise NotionError(f"database {db_id}: HTTP {code}: {body}")
        data = resp.json()
        results.extend(data.get("results", []))
        if not data.get("has_more"):
            return results
        payload["start_cursor"] = data.get("next_cursor")


# ---------------------------------------------------------------------------
# Disk IO
# ---------------------------------------------------------------------------
def _load_json_list(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _atomic_write_json(path, obj):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)  # atomic on POSIX — never a torn read
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _snapshot(entries, base_dir):
    snap_dir = os.path.join(base_dir, "data", "snapshots")
    os.makedirs(snap_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    _atomic_write_json(os.path.join(snap_dir, f"planes-{ts}.json"), entries)
    snaps = sorted(glob.glob(os.path.join(snap_dir, "planes-*.json")))
    for old in snaps[:-SNAPSHOT_KEEP]:
        try:
            os.remove(old)
        except OSError:
            pass


def _known_charger_ids(base_dir):
    return {c.get("id") for c in _load_json_list(os.path.join(base_dir, "chargers.json"))
            if isinstance(c, dict) and c.get("id")}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def sync(dry_run=False, base_dir=BASE_DIR):
    """Pull Notion, transform, and (unless dry-run) write the generated catalog.
    Returns a process exit code: 0 success, 2 abort (last-good left untouched)."""
    token = os.environ.get(ENV_TOKEN)
    ac_db = os.environ.get(ENV_AIRCRAFT_DB)
    prof_db = os.environ.get(ENV_PROFILES_DB)
    missing = [n for n, v in ((ENV_TOKEN, token), (ENV_AIRCRAFT_DB, ac_db),
                              (ENV_PROFILES_DB, prof_db)) if not v]
    if missing:
        print(f"ABORT: missing env: {', '.join(missing)} "
              f"(source /etc/cns.env before running)", file=sys.stderr)
        return 2

    generated = os.path.join(base_dir, "data", "planes.generated.json")
    report_path = os.path.join(base_dir, "data", "sync_report.json")

    try:
        session = _session(token)
        aircraft_pages = notion_query(ac_db, session)
        profile_pages = notion_query(prof_db, session)
    except (NotionError, requests.RequestException) as exc:
        print(f"ABORT: Notion pull failed: {exc}", file=sys.stderr)
        return 2

    last_good = _load_json_list(generated)
    last_good_by_id = {e["id"]: e for e in last_good if isinstance(e, dict) and e.get("id")}

    entries, report = transform(aircraft_pages, profile_pages,
                                _known_charger_ids(base_dir), last_good_by_id)

    print(json.dumps(report, indent=2, ensure_ascii=False))

    if report["abort"]:
        print(f"ABORT: {report['abort']} — leaving {os.path.basename(generated)} "
              f"untouched", file=sys.stderr)
        return 2

    if dry_run:
        print(f"[dry-run] would write {len(entries)} entries to {generated}", file=sys.stderr)
        return 0

    _atomic_write_json(generated, entries)
    _snapshot(entries, base_dir)
    _atomic_write_json(report_path, report)
    print(f"OK: wrote {len(entries)} entries to {generated}", file=sys.stderr)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Sync the CNS aircraft catalog from Notion.")
    ap.add_argument("--dry-run", action="store_true",
                    help="pull + validate + print the report, but write nothing")
    args = ap.parse_args(argv)
    return sync(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
