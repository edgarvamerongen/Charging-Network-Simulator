"""Runway-based airport suitability — does an aircraft's take-off / landing
distance fit a runway? (docs/performance-engine.md §7).

Bridges the catalog `measurements` (takeoff_distance_m / landing_distance_m,
selected by surface) and runways.csv (length_ft, surface, closed). Stdlib-only,
pure functions. NOT wired into the app — this is the foundation the route-planner
candidate filter + the CNSRangeGraph overlay call later (step 7). Adding it
changes no current behaviour.
"""
import plane_schema

FT_TO_M = 0.3048

# runways.csv `surface` is free text (25+ variants). Map to our categories.
_SURFACE_KEYS = {
    "paved":  ("ASP", "ASPH", "CON", "CONC", "PEM", "PAVED", "BIT", "TAR", "MAC", "SEAL", "COP", "COM"),
    "grass":  ("TURF", "GRS", "GRE", "GRASS", "SOD", "LAWN"),
    "gravel": ("GVL", "GRVL", "GRAVEL", "PER", "LATERITE", "CORAL", "SHELL", "STONE"),
    "dirt":   ("DIRT", "EARTH", "CLAY", "SAND", "SAN", "GROUND", "SOIL", "NAT"),
    "water":  ("WATER", "WAT"),
}


def normalize_surface(raw):
    """Map a runways.csv surface string to a category, or 'unknown'."""
    if raw is None:
        return "unknown"
    s = str(raw).strip().upper()
    if not s or s in ("UNK", "U", "X", "N", "NIL", "NONE", "?"):
        return "unknown"
    for cat, keys in _SURFACE_KEYS.items():
        if any(s.startswith(k) or k in s for k in keys):
            return cat
    return "unknown"


def airport_suitability(plane, runway, context=None, margin=1.15):
    """Can `plane` operate from `runway`? `runway` is a runways.csv row (dict)
    with length_ft / surface / closed. Returns:
        { operable, limiting_factor, required_m?, available_m?, surface? }
    `operable` is None when the aircraft has no distance data (graceful: we can't
    assess, so we don't claim a verdict). `margin` is a safety factor on the
    required distance (default 15%)."""
    if str(runway.get("closed", "0")).strip() in ("1", "true", "True", "yes"):
        return {"operable": False, "limiting_factor": "closed"}

    surf = normalize_surface(runway.get("surface"))
    surfaces_ok = plane_schema.value(plane, "surfaces_ok") or ["paved"]
    if surf != "unknown" and surf not in surfaces_ok:
        return {"operable": False, "limiting_factor": "wrong_surface", "runway_surface": surf}

    try:
        length_m = float(runway.get("length_ft") or 0) * FT_TO_M
    except (TypeError, ValueError):
        length_m = 0.0

    ctx = dict(context or {})
    ctx["surface"] = surf if surf != "unknown" else ctx.get("surface", "paved")
    todr = plane_schema.select(plane, "takeoff_distance_m", ctx)
    ldr = plane_schema.select(plane, "landing_distance_m", ctx)
    need = max([d for d in (todr, ldr) if d], default=None)
    if not need:
        return {"operable": None, "limiting_factor": "no_distance_data",
                "available_m": round(length_m), "surface": surf}

    required = need * margin
    ok = length_m >= required
    return {"operable": ok, "limiting_factor": None if ok else "too_short",
            "required_m": round(required), "available_m": round(length_m), "surface": surf}
