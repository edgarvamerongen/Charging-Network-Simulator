"""Aircraft-catalog schema: provenance normalizer + stdlib validator.

Roadmap step 1 of docs/performance-engine.md. This is the single Python entry
point for the `planes.json` contract (`planes.schema.json`):

  * `value(plane, key)` / `provenance(plane, key)` — read a field whether it is a
    bare scalar OR a provenance object `{value, basis?, source?, confidence?}`.
    This is the "loader normalises bare scalars" piece (§3.3) so every consumer
    reads `.value` uniformly.
  * `ifr_capable(plane)` — explicit value if present, else inferred from `class`
    (§5.1).
  * `validate(planes)` -> (errors, warnings) — structural + domain checks.

Deliberately STDLIB-ONLY (json/os/re) so it runs in CI, the macOS app venv, and
the Linux sandbox alike — no jsonschema dependency. It reads/computes only; it
never mutates planes.json and is not wired into the running app (no behaviour
change in step 1). `validate_planes.py` is the CLI wrapper.
"""
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(_HERE, "planes.schema.json")

_NUMERIC = (int, float)


def load_schema(path=SCHEMA_PATH):
    with open(path, "r") as f:
        return json.load(f)


# --------------------------------------------------------------------------- #
# Provenance normalizer
# --------------------------------------------------------------------------- #
def _is_provenance(v):
    return isinstance(v, dict) and "value" in v


def value(plane, key, default=None):
    """Field value, unwrapping a provenance object. `default` when absent."""
    if not isinstance(plane, dict) or key not in plane:
        return default
    v = plane[key]
    return v["value"] if _is_provenance(v) else v


def provenance(plane, key):
    """Always returns {value, basis, source, confidence} or None when absent.
    A bare scalar reads as confidence 'assumed'."""
    if not isinstance(plane, dict) or key not in plane:
        return None
    v = plane[key]
    if _is_provenance(v):
        return {"value": v["value"], "basis": v.get("basis"),
                "source": v.get("source"), "confidence": v.get("confidence", "assumed")}
    return {"value": v, "basis": None, "source": None, "confidence": "assumed"}


# --------------------------------------------------------------------------- #
# Measurements: multiple data points per quantity + a selector
# --------------------------------------------------------------------------- #
_CONF_RANK = {"certified": 3, "manufacturer-stated": 2, "estimated": 1, "assumed": 0}


def _norm(x):
    return x.lower() if isinstance(x, str) else x


def measurements(plane, quantity=None):
    out = plane.get("measurements") if isinstance(plane, dict) else None
    out = out if isinstance(out, list) else []
    out = [m for m in out if isinstance(m, dict)]
    return out if quantity is None else [m for m in out if m.get("quantity") == quantity]


def select_measurement(plane, quantity, context=None):
    """Best-matching measurement RECORD for `quantity` under `context` (a dict of
    conditions), or None. A measurement whose conditions CONFLICT with the context
    (same key, different value) is excluded; otherwise the score is
    (#matched conditions, confidence rank), so a more specific / better-sourced
    point wins and a conditionless point is the last resort."""
    ctx = {k: _norm(v) for k, v in (context or {}).items()}
    best, best_key = None, None
    for m in measurements(plane, quantity):
        cond = {k: _norm(v) for k, v in (m.get("conditions") or {}).items()}
        if any(k in ctx and ctx[k] != cv for k, cv in cond.items()):
            continue  # conflicts with the requested context
        matched = sum(1 for k, cv in cond.items() if ctx.get(k) == cv)
        if cond and matched == 0:
            continue  # conditioned point, but the context matched none of its conditions
        key = (matched, _CONF_RANK.get(m.get("confidence", "assumed"), 0))
        if best is None or key > best_key:
            best, best_key = m, key
    return best


def select(plane, quantity, context=None, default=None):
    """Selected VALUE: best-matching measurement, else the scalar field, else default."""
    m = select_measurement(plane, quantity, context)
    if m is not None:
        return m.get("value")
    v = value(plane, quantity)
    return v if v is not None else default


# --------------------------------------------------------------------------- #
# IFR capability (explicit > inferred from class > inferred from shape)
# --------------------------------------------------------------------------- #
def infer_ifr_capable(plane):
    cls = value(plane, "class")
    if cls == "trainer":
        return False
    if cls in ("commuter", "regional", "evtol"):
        return True
    seats = value(plane, "seats") or 0
    rng = value(plane, "range_km") or 0
    return not (seats <= 2 and rng < 200)   # tiny short-range -> assume VFR-only


def ifr_capable(plane):
    if isinstance(plane, dict) and "ifr_capable" in plane:
        return bool(value(plane, "ifr_capable"))
    return infer_ifr_capable(plane)


# --------------------------------------------------------------------------- #
# Usable range: gross --(min-SoC floor)--> usable battery --(reserve)--> planning
# --------------------------------------------------------------------------- #
# Regulatory final-reserve defaults (minutes); the engine overrides from settings.
RESERVE_MIN = {"vfr": 30, "vfr_day": 30, "vfr_night": 45, "ifr": 45}
DEFAULT_MIN_SOC = 0.30


def _min_soc(plane, override=None):
    if override is not None:
        return override
    v = value(plane, "min_landing_soc")
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else DEFAULT_MIN_SOC


def usable_range(plane, regime="vfr", context=None, *, min_soc=None,
                 alternate_km=0.0, routing_factor=1.0, reserve_min=None):
    """Usable planning range (km), built DOWN from the gross (full-battery) range:

        gross  ──×(1 − min_soc)──▶  usable battery  ──− reserve──▶  planning range
                                                       (IFR also − alternate, ÷ routing)

    Min-SoC is the unusable floor (battery health); the final reserve is held
    *within* the usable battery — two separate buffers, subtracted in sequence.
    An explicit measurement tagged basis 'usable_incl_reserve' for the regime
    wins outright (a published with-reserves figure, e.g. Vaeridion 400 km @ MTOW
    IFR) and bypasses the build-down. Pure; the engine passes settings-derived args."""
    reserve_min = reserve_min or RESERVE_MIN
    ctx = dict(context or {})
    ctx["regime"] = regime
    m = select_measurement(plane, "range_km", ctx)
    if m is not None and m.get("basis") == "usable_incl_reserve":
        return m.get("value")
    gross = m.get("value") if (m is not None and m.get("basis") == "gross") else value(plane, "range_km")
    spd = value(plane, "speed_kmh")
    if not gross or not spd:
        return value(plane, "range_km")
    base = gross * (1.0 - _min_soc(plane, min_soc))                       # remove the min-SoC floor
    reserve_km = (spd / 60.0) * reserve_min.get(regime, reserve_min.get("vfr", 30))
    usable = base - reserve_km                                           # hold the final reserve
    if regime == "ifr":
        usable = (usable - (alternate_km or 0.0)) / (routing_factor or 1.0)
    return max(0.0, usable)


# --------------------------------------------------------------------------- #
# Validator
# --------------------------------------------------------------------------- #
def _type_ok(val, t):
    if t == "number":
        return isinstance(val, _NUMERIC) and not isinstance(val, bool)
    if t == "integer":
        return isinstance(val, int) and not isinstance(val, bool)
    if t == "string":
        return isinstance(val, str)
    if t == "boolean":
        return isinstance(val, bool)
    if t == "array":
        return isinstance(val, list)
    if t == "object":
        return isinstance(val, dict)
    return True


def _check_scalar(pid, key, val, spec, errors):
    """Type / enum / bounds for one (already-unwrapped) value."""
    t = spec.get("type")
    if t and not _type_ok(val, t):
        errors.append((pid, f"'{key}' should be {t}, got {type(val).__name__} ({val!r})"))
        return
    if "enum" in spec and val not in spec["enum"]:
        errors.append((pid, f"'{key}'={val!r} not in {spec['enum']}"))
    if isinstance(val, _NUMERIC) and not isinstance(val, bool):
        if "gt" in spec and not val > spec["gt"]:
            errors.append((pid, f"'{key}'={val} must be > {spec['gt']}"))
        if "minimum" in spec and val < spec["minimum"]:
            errors.append((pid, f"'{key}'={val} below minimum {spec['minimum']}"))
        if "maximum" in spec and val > spec["maximum"]:
            errors.append((pid, f"'{key}'={val} above maximum {spec['maximum']}"))
    if t == "array" and isinstance(val, list) and "items" in spec and "enum" in spec["items"]:
        for it in val:
            if it not in spec["items"]["enum"]:
                errors.append((pid, f"'{key}' item {it!r} not in {spec['items']['enum']}"))
    if t == "object" and isinstance(val, dict) and "properties" in spec:
        for sub, subspec in spec["properties"].items():
            if sub in val:
                _check_scalar(pid, f"{key}.{sub}", val[sub], subspec, errors)


def _check_measurements(pid, meas, props, allowed_conf, errors):
    if not isinstance(meas, list):
        errors.append((pid, "'measurements' must be an array"))
        return
    for j, m in enumerate(meas):
        if not isinstance(m, dict):
            errors.append((pid, f"measurements[{j}] must be an object"))
            continue
        q = m.get("quantity")
        if q not in props:
            errors.append((pid, f"measurements[{j}].quantity {q!r} is not a known field"))
            continue
        if "value" not in m:
            errors.append((pid, f"measurements[{j}] ({q}) missing 'value'"))
            continue
        _check_scalar(pid, f"measurements[{j}].value({q})", m["value"], props[q], errors)
        conf = m.get("confidence")
        if conf is not None and allowed_conf and conf not in allowed_conf:
            errors.append((pid, f"measurements[{j}].confidence {conf!r} not in {allowed_conf}"))
        if "conditions" in m and not isinstance(m["conditions"], dict):
            errors.append((pid, f"measurements[{j}].conditions must be an object"))


def validate(planes, schema=None):
    """Return (errors, warnings); each is a list of (plane_id, message)."""
    schema = schema or load_schema()
    item = schema.get("items", {})
    props = item.get("properties", {})
    required = item.get("required", [])
    allowed_conf = item.get("x-provenance", {}).get("confidence", [])
    errors, warnings = [], []

    if not isinstance(planes, list):
        return ([("<root>", "planes.json must be a JSON array")], [])

    for i, plane in enumerate(planes):
        if not isinstance(plane, dict):
            errors.append((f"[{i}]", "catalog entry must be an object"))
            continue
        pid = value(plane, "id") or f"[{i}]"

        for r in required:
            if r not in plane:
                errors.append((pid, f"missing required field '{r}'"))

        for key, raw in plane.items():
            spec = props.get(key)
            if spec is None:
                warnings.append((pid, f"unknown field '{key}' (typo? not in schema)"))
                continue
            if key == "measurements":
                _check_measurements(pid, raw, props, allowed_conf, errors)
                continue
            if _is_provenance(raw):
                conf = raw.get("confidence", "assumed")
                if allowed_conf and conf not in allowed_conf:
                    errors.append((pid, f"'{key}'.confidence {conf!r} not in {allowed_conf}"))
            _check_scalar(pid, key, value(plane, key), spec, errors)

        # ---- domain rules ----
        if value(plane, "range_basis") == "incl_reserve" and "reserve_included" not in plane:
            errors.append((pid, "range_basis=incl_reserve requires 'reserve_included' (else reserves double-count, §5.3)"))
        if "ifr_capable" not in plane:
            warnings.append((pid, f"ifr_capable absent -> inferred {infer_ifr_capable(plane)} "
                                  f"from class={value(plane, 'class')!r} (confirm vs type certificate)"))

    return errors, warnings
