"""Tests for notion_sync.py (transform/validate/quarantine) and the sim.py
generated-catalog loader. Pure + fixture-driven — no live Notion network.

Covers NOTION_CATALOG_PLAN §6–§9: emit shape, kt→km/h, CNS-hiding,
per-aircraft quarantine with carry-forward, global abort, string normalization,
emit-id collisions, and the loader's prefer/fallback/mtime-reload behavior.
"""
import json
import os
import sys
import tempfile
import threading
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import notion_sync as ns  # noqa: E402
import sim  # noqa: E402

KNOWN_CHARGERS = {"dc_22", "dc_320", "dc_1000"}


# --- Notion property-object builders ---------------------------------------
def _title(v):
    return {"type": "title", "title": ([{"plain_text": v}] if v else [])}


def _rt(v):
    return {"type": "rich_text", "rich_text": ([{"plain_text": v}] if v else [])}


def _n(v):
    return {"type": "number", "number": v}


def _sel(v):
    return {"type": "select", "select": ({"name": v} if v is not None else None)}


def _chk(v):
    return {"type": "checkbox", "checkbox": v}


def _ms(vs):
    return {"type": "multi_select", "multi_select": [{"name": x} for x in vs]}


def _rel(ids):
    return {"type": "relation", "relation": [{"id": x} for x in ids]}


def aircraft(pid, created="2026-07-07T00:00:00Z", name="Plane", slug="plane",
             cns=True, battery=100, cruise=100, chargers=("dc_22",), props=None):
    p = {
        "Name": _title(name),
        "Slug": _rt(slug),
        "CNS": _chk(cns),
        "Battery (kWh)": _n(battery),
        "Cruise speed (kt)": _n(cruise),
        "Chargers": _ms(list(chargers)),
    }
    if props:
        p.update(props)
    return {"id": pid, "created_time": created, "properties": p}


def profile(pid, ac_id, label="Standard", emit="plane", default=True,
            seats=2, regime="VFR", rng=100, props=None):
    p = {
        "Label": _title(label),
        "Aircraft": _rel([ac_id]),
        "Emit ID": _rt(emit),
        "Default": _chk(default),
        "Seats": _n(seats),
        "Regime": _sel(regime),
        "Range (km)": _n(rng),
    }
    if props:
        p.update(props)
    return {"id": pid, "created_time": created_stamp(pid), "properties": p}


def created_stamp(pid):
    return "2026-07-07T00:00:00Z"


class TransformTest(unittest.TestCase):
    def test_basic_emit_shape_and_speed_conversion(self):
        ac = [aircraft("A", name="Velis Electro", slug="pipistrel_velis",
                       battery=22, cruise=80, chargers=("dc_22",),
                       props={"Image": _rt("pipistrel.jpg"), "OEM": _sel("Pipistrel")})]
        pr = [profile("P", "A", emit="pipistrel_velis", seats=2, regime="vfr", rng=87.5)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertIsNone(report["abort"])
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["id"], "pipistrel_velis")
        self.assertEqual(e["name"], "Velis Electro")
        self.assertEqual(e["battery_kwh"], 22)
        self.assertEqual(e["range_km"], 87.5)
        self.assertEqual(e["speed_kmh"], 148)          # 80 kt × 1.852 = 148.16 → 148
        self.assertEqual(e["default_charger_id"], "dc_22")
        self.assertEqual(e["image"], "pipistrel.jpg")
        self.assertEqual(e["regime"], "VFR")           # canonicalized from "vfr"
        self.assertEqual(report["ok"], ["pipistrel_velis"])

    def test_kt_to_kmh_rounding(self):
        self.assertEqual(ns.kt_to_kmh(80), 148)
        self.assertEqual(ns.kt_to_kmh(135), 250)
        self.assertEqual(ns.kt_to_kmh(216), 400)
        self.assertEqual(ns.kt_to_kmh(389), 720)

    def test_two_profiles_get_label_suffix_and_default_first(self):
        ac = [aircraft("A", name="Vaeridion Microliner", slug="vaeridion_microliner",
                       battery=600, cruise=216, chargers=("dc_1000",))]
        pr = [
            profile("P1", "A", label="Light (4 seats)", emit="vaeridion_light",
                    default=False, seats=4, rng=687.5),
            profile("P2", "A", label="Max (9 seats)", emit="vaeridion",
                    default=True, seats=9, rng=500),
        ]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual([e["id"] for e in entries], ["vaeridion", "vaeridion_light"])  # default first
        self.assertEqual(entries[0]["name"], "Vaeridion Microliner — Max (9 seats)")
        self.assertEqual(entries[1]["name"], "Vaeridion Microliner — Light (4 seats)")

    def test_simultaneous_charging_and_no_charger(self):
        ac = [aircraft("A", name="Elysian E9X", slug="elysian_e9x", battery=14000,
                       cruise=389, chargers=(),
                       props={"Simultaneous charging max": _n(2)})]
        pr = [profile("P", "A", emit="elysian_e9x", seats=90, rng=1000)]
        entries, _ = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual(entries[0]["simultaneous_charging"], {"enabled": True, "max": 2})
        self.assertNotIn("default_charger_id", entries[0])   # empty Chargers → omitted

    def test_cns_unchecked_is_hidden_not_emitted(self):
        ac = [
            aircraft("A", name="Shown", slug="shown"),
            aircraft("B", name="Concept", slug="concept_plane", cns=False),
        ]
        pr = [
            profile("P1", "A", emit="shown", rng=100),
            profile("P2", "B", emit="concept_plane", rng=100),
        ]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        ids = [e["id"] for e in entries]
        self.assertIn("shown", ids)
        self.assertNotIn("concept_plane", ids)
        self.assertIn("concept_plane", report["hidden"])

    def test_quarantine_bad_battery_carries_forward(self):
        last_good = {"velis": {"id": "velis", "name": "Velis (last good)",
                               "battery_kwh": 22, "range_km": 87.5, "speed_kmh": 148}}
        ac = [
            aircraft("A", name="Velis", slug="velis", battery=0, cruise=80),   # bad battery
            aircraft("B", name="Beta", slug="beta", battery=225, cruise=135),
        ]
        pr = [
            profile("P1", "A", emit="velis", rng=87.5),
            profile("P2", "B", emit="beta", rng=500),
        ]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, last_good)
        ids = [e["id"] for e in entries]
        self.assertIn("beta", ids)                       # valid one emitted fresh
        self.assertIn("velis", ids)                      # bad one carried forward
        self.assertEqual(next(e for e in entries if e["id"] == "velis")["name"],
                         "Velis (last good)")            # the carried (old) entry
        self.assertEqual(report["carried_forward"], ["velis"])
        self.assertEqual(report["ok"], ["beta"])
        self.assertEqual(len(report["skipped"]), 1)
        self.assertEqual(report["skipped"][0]["slug"], "velis")

    # ---- hybrids: battery optional (absent = non-charging aircraft) ----------
    def test_hybrid_without_battery_emits_as_non_charging(self):
        ac = [aircraft("A", name="HyBird", slug="hybird", battery=None,
                       props={"Propulsion": _sel("Hybrid electric")})]
        pr = [profile("P1", "A", emit="hybird", rng=800)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual(report["ok"], ["hybird"])
        e = next(x for x in entries if x["id"] == "hybird")
        self.assertNotIn("battery_kwh", e)          # key absent, never null
        self.assertEqual(e["propulsion"], "Hybrid electric")

    def test_electric_without_battery_still_skipped(self):
        ac = [aircraft("A", name="NoBatt", slug="nobatt", battery=None,
                       props={"Propulsion": _sel("Fully electric")})]
        pr = [profile("P1", "A", emit="nobatt", rng=100)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual([x["id"] for x in entries], [])
        self.assertEqual(report["skipped"][0]["slug"], "nobatt")

    def test_hybrid_with_zero_battery_rejected(self):
        # 0 is a data-entry mistake, not "no battery" — the field must be
        # omitted entirely for a non-charging hybrid.
        ac = [aircraft("A", name="HyBird", slug="hybird", battery=0,
                       props={"Propulsion": _sel("Hybrid")})]
        pr = [profile("P1", "A", emit="hybird", rng=800)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual(report["skipped"][0]["slug"], "hybird")

    def test_hybrid_with_battery_is_a_plugin_and_keeps_bounds(self):
        ac = [aircraft("A", name="PlugIn", slug="plugin", battery=250,
                       props={"Propulsion": _sel("Hybrid electric")})]
        pr = [profile("P1", "A", emit="plugin", rng=800)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual(report["ok"], ["plugin"])
        self.assertEqual(next(x for x in entries if x["id"] == "plugin")["battery_kwh"], 250)

    def test_hidden_aircraft_is_not_carried_forward(self):
        # Hiding is a valid edit, not an error — it must remove the plane even
        # if a last-good entry exists.
        last_good = {"gone": {"id": "gone", "name": "Gone", "battery_kwh": 1,
                              "range_km": 1, "speed_kmh": 100}}
        ac = [
            aircraft("A", name="Keep", slug="keep", battery=100, cruise=100),
            aircraft("B", name="Gone", slug="gone", cns=False),
        ]
        pr = [
            profile("P1", "A", emit="keep", rng=100),
            profile("P2", "B", emit="gone", rng=100),
        ]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, last_good)
        self.assertNotIn("gone", [e["id"] for e in entries])
        self.assertEqual(report["carried_forward"], [])
        self.assertIn("gone", report["hidden"])

    def test_emit_id_collision_quarantines_both(self):
        ac = [
            aircraft("A", name="One", slug="one", battery=100, cruise=100),
            aircraft("B", name="Two", slug="two", battery=100, cruise=100),
            aircraft("C", name="Ok", slug="ok", battery=100, cruise=100),
        ]
        pr = [
            profile("P1", "A", emit="dup", rng=100),
            profile("P2", "B", emit="dup", rng=100),
            profile("P3", "C", emit="unique", rng=100),
        ]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual([e["id"] for e in entries], ["unique"])
        self.assertEqual(sorted(s["slug"] for s in report["skipped"]), ["one", "two"])

    def test_string_normalization_surface_and_regime(self):
        ac = [aircraft("A", name="X", slug="x", battery=100, cruise=100)]
        pr = [profile("P", "A", emit="x", regime="  vfr ", rng=100,
                      props={"Surface": _sel("Grass ")})]
        entries, _ = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual(entries[0]["regime"], "VFR")     # trimmed + canonicalized
        self.assertEqual(entries[0]["surface"], "grass")  # trimmed + lowered

    def test_empty_pull_aborts(self):
        # No aircraft pages at all == broken pull → refuse to publish.
        entries, report = ns.transform([], [], KNOWN_CHARGERS, {})
        self.assertEqual(entries, [])
        self.assertIn("no aircraft", report["abort"])

    def test_intentional_shrink_is_allowed(self):
        # CNS is the availability switch: turning most planes off must be honored,
        # NOT blocked as a suspicious shrink (last-good had 4, only 1 stays on).
        last_good = {f"p{i}": {"id": f"p{i}", "name": f"P{i}", "battery_kwh": 1,
                               "range_km": 1, "speed_kmh": 100} for i in range(4)}
        ac = [aircraft("A", name="Solo", slug="solo", battery=100, cruise=100)]
        pr = [profile("P", "A", emit="solo", rng=100)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, last_good)
        self.assertEqual([e["id"] for e in entries], ["solo"])
        self.assertIsNone(report["abort"])                # shrink allowed

    def test_all_hidden_aborts_keeps_last_good(self):
        # Every aircraft unchecked → nothing to publish → abort (keep last-good).
        ac = [aircraft("A", name="Off1", slug="off1", cns=False),
              aircraft("B", name="Off2", slug="off2", cns=False)]
        pr = [profile("P1", "A", emit="off1", rng=100),
              profile("P2", "B", emit="off2", rng=100)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual(entries, [])
        self.assertIn("no aircraft to publish", report["abort"])
        self.assertEqual(sorted(report["hidden"]), ["off1", "off2"])

    def test_unknown_charger_id_quarantines(self):
        ac = [aircraft("A", name="X", slug="x", battery=100, cruise=100,
                       chargers=("dc_does_not_exist",))]
        pr = [profile("P", "A", emit="x", rng=100)]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertEqual(entries, [])
        self.assertEqual(report["skipped"][0]["slug"], "x")
        self.assertTrue(any("unknown charger" in e for e in report["skipped"][0]["errors"]))


def _files(entries):
    """Notion files property: entries = [(name, url, kind)] with kind file|external."""
    fs = []
    for name, url, kind in entries:
        f = {"name": name, "type": kind}
        f[kind] = {"url": url}
        fs.append(f)
    return {"type": "files", "files": fs}


class PhotoPipelineTest(unittest.TestCase):
    """Notion "Photo" uploads → data/plane_images + image_url (warnings-only)."""

    def _entries_and_pages(self, photo_prop):
        ac = [aircraft("A", name="Velis", slug="pipistrel_velis",
                       props={"Photo": photo_prop} if photo_prop else None)]
        pr = [profile("P", "A", emit="pipistrel_velis")]
        entries, report = ns.transform(ac, pr, KNOWN_CHARGERS, {})
        self.assertIsNone(report["abort"])
        return entries, ac, report

    def test_files_property_extraction_signed_and_external(self):
        prop = _files([("shot.jpg", "https://s3/signed", "file"),
                       ("ext.png", "https://x/ext.png", "external")])
        self.assertEqual(ns._extract(prop), [
            {"name": "shot.jpg", "url": "https://s3/signed"},
            {"name": "ext.png", "url": "https://x/ext.png"}])

    def test_photo_filename_sanitized_and_extension_guarded(self):
        self.assertEqual(ns._photo_filename("velis", "My Photo (1).JPG"), "velis__My_Photo_1.jpg")
        self.assertEqual(ns._photo_filename("velis", "../../etc/passwd"), "velis__passwd.jpg")
        self.assertEqual(ns._photo_filename("velis", ""), "velis__photo.jpg")

    def test_download_patches_entries_and_caches_and_prunes(self):
        entries, pages, report = self._entries_and_pages(
            _files([("new.jpg", "https://s3/a", "file")]))
        with tempfile.TemporaryDirectory() as base:
            pdir = os.path.join(base, "data", ns.PHOTO_DIR)
            os.makedirs(pdir)
            with open(os.path.join(pdir, "pipistrel_velis__old.jpg"), "wb") as f:
                f.write(b"stale")
            calls = []
            ns.apply_photos(entries, pages, base, report,
                            fetch=lambda url: calls.append(url) or b"JPEGDATA")
            self.assertEqual(calls, ["https://s3/a"])
            self.assertEqual(entries[0]["image_url"], "/plane-images/pipistrel_velis__new.jpg")
            self.assertTrue(os.path.exists(os.path.join(pdir, "pipistrel_velis__new.jpg")))
            self.assertFalse(os.path.exists(os.path.join(pdir, "pipistrel_velis__old.jpg")))
            self.assertEqual(report["images"],
                             {"linked": 1, "downloaded": 1, "cached": 0, "failed": 0})
            # second sync: same filename → served from cache, no fetch
            report2 = {"images": {}, "image_warnings": []}
            ns.apply_photos(entries, pages, base, report2, fetch=lambda url: self.fail("refetched"))
            self.assertEqual(report2["images"]["cached"], 1)

    def test_download_failure_is_warning_not_fatal(self):
        entries, pages, report = self._entries_and_pages(
            _files([("x.jpg", "https://s3/broken", "file")]))
        def boom(url):
            raise RuntimeError("403 expired")
        with tempfile.TemporaryDirectory() as base:
            ns.apply_photos(entries, pages, base, report, fetch=boom)
        self.assertNotIn("image_url", entries[0])
        self.assertEqual(report["images"]["failed"], 1)
        self.assertIn("pipistrel_velis", report["image_warnings"][0])

    def test_no_photo_property_is_noop(self):
        entries, pages, report = self._entries_and_pages(None)
        with tempfile.TemporaryDirectory() as base:
            ns.apply_photos(entries, pages, base, report, fetch=lambda url: self.fail("fetched"))
        self.assertNotIn("image_url", entries[0])
        self.assertEqual(report["images"]["linked"], 0)


class PropertyExtractionTest(unittest.TestCase):
    def test_rich_text_runs_are_concatenated(self):
        prop = {"type": "rich_text",
                "rich_text": [{"plain_text": "NL, "}, {"plain_text": "DE"}]}
        self.assertEqual(ns._extract(prop), "NL, DE")

    def test_missing_select_is_none(self):
        self.assertIsNone(ns._extract({"type": "select", "select": None}))

    def test_number_and_checkbox_and_relation(self):
        self.assertEqual(ns._extract(_n(42)), 42)
        self.assertTrue(ns._extract(_chk(True)))
        self.assertEqual(ns._extract(_rel(["x", "y"])), ["x", "y"])

    def test_formula_result_is_unwrapped_by_subtype(self):
        # Formula properties surface a typed payload — unwrap it so a field like
        # Emit ID can be driven by a Notion formula (e.g. slug + label suffix)
        # instead of a hand-typed value.
        def _f(sub, val):
            return {"type": "formula", "formula": {"type": sub, sub: val}}
        self.assertEqual(ns._extract(_f("string", "vaeridion_light")), "vaeridion_light")
        self.assertEqual(ns._extract(_f("number", 42)), 42)
        self.assertTrue(ns._extract(_f("boolean", True)))
        # date-typed formulas map to no schema field → None (unchanged behaviour).
        self.assertIsNone(ns._extract(_f("date", {"start": "2026-01-01"})))
        self.assertIsNone(ns._extract({"type": "formula", "formula": None}))

    def test_formula_emit_id_is_slugged_by_parse_profile(self):
        page = {"id": "p1", "properties": {
            "Emit ID": {"type": "formula",
                        "formula": {"type": "string", "string": "Vaeridion_Light"}}}}
        self.assertEqual(ns.parse_profile(page)["emit_id"], "vaeridion_light")


class GeneratedCatalogLoaderTest(unittest.TestCase):
    """sim.Simulator catalog loader — built via __new__ to skip the heavy
    airports CSV read. Post-cutover the generated file is the single source of
    truth: there is NO planes.json fallback, so a missing/invalid catalog fails
    fast rather than serving stale data."""

    def _bare(self, tmp):
        s = sim.Simulator.__new__(sim.Simulator)
        s._generated_planes_path = os.path.join(tmp, "data", "planes.generated.json")
        s._planes_lock = threading.Lock()
        s._gen_seen_mtime = None
        s.planes_source = None
        return s

    @staticmethod
    def _write(path, obj, mtime=None):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(obj, f)
        if mtime is not None:
            os.utime(path, (mtime, mtime))

    def test_loads_generated_then_reloads_on_change(self):
        tmp = tempfile.mkdtemp()
        s = self._bare(tmp)
        self._write(s._generated_planes_path,
                    [{"id": "g1", "name": "G1", "battery_kwh": 2, "range_km": 2, "speed_kmh": 2}],
                    mtime=1000)
        s.planes = s._load_planes()
        self.assertTrue(s.planes_source.endswith("planes.generated.json"))
        self.assertEqual(s.planes[0]["id"], "g1")

        self._write(s._generated_planes_path,
                    [{"id": "g2", "name": "G2", "battery_kwh": 3, "range_km": 3, "speed_kmh": 3}],
                    mtime=2000)
        s.maybe_reload_planes()
        self.assertEqual(s.planes[0]["id"], "g2")

    def test_missing_catalog_raises(self):
        # No generated file and no fallback → fail fast (Phase 3 cutover).
        s = self._bare(tempfile.mkdtemp())
        with self.assertRaises(RuntimeError):
            s._load_planes()

    def test_invalid_generated_raises_on_load(self):
        # Present but shape-invalid (missing speed_kmh) → RuntimeError, not fallback.
        s = self._bare(tempfile.mkdtemp())
        self._write(s._generated_planes_path,
                    [{"id": "bad", "name": "Bad", "battery_kwh": 2, "range_km": 2}], mtime=1000)
        with self.assertRaises(RuntimeError):
            s._load_planes()

    def test_invalid_generated_keeps_previous_on_reload(self):
        tmp = tempfile.mkdtemp()
        s = self._bare(tmp)
        self._write(s._generated_planes_path,
                    [{"id": "g1", "name": "G1", "battery_kwh": 2, "range_km": 2, "speed_kmh": 2}],
                    mtime=1000)
        s.planes = s._load_planes()
        with open(s._generated_planes_path, "w") as f:
            f.write("{ not valid json")
        os.utime(s._generated_planes_path, (2000, 2000))
        s.maybe_reload_planes()
        self.assertEqual(s.planes[0]["id"], "g1")         # kept the last good load


if __name__ == "__main__":
    unittest.main()
