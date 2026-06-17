"""
CNS — PDF report generator.

The browser computes the heavy lifting (per-airport demand + rotation peaks)
using the existing JS scheduler, then POSTs a self-contained JSON payload to
/api/report.pdf. This module:

1. Augments the payload with SVG charts (executive bar charts + per-airport
   rotation Gantt) and a server-rendered network map (OSM tiles via staticmap).
2. Renders templates/report.html with Jinja2.
3. Pipes the HTML through WeasyPrint and returns the PDF bytes.

Keeping all of the layout in HTML/CSS means the report can be redesigned
without touching this file — only templates/report.html + static/report.css.
"""
import base64
import ctypes
import io
import json
import math
import mimetypes
import os
import platform
import re
import threading
import urllib.parse
import urllib.request
from datetime import datetime


def _macos_setup_weasyprint():
    """WeasyPrint relies on Cairo/Pango/GLib via cffi. On macOS those live under
    Homebrew (`/opt/homebrew/lib` on Apple Silicon, `/usr/local/lib` on Intel),
    and DYLD_* environment variables are routinely scrubbed by SIP — so cffi's
    `ctypes.util.find_library('gobject-2.0-0')` returns None and the whole
    bind chain fails. We do two things:
      1. Preload the dylibs by full path (RTLD_GLOBAL) so the symbols are live.
      2. Monkey-patch `ctypes.util.find_library` to also check Homebrew prefixes
         so cffi resolves the name without crashing.
    Linux/Windows don't need any of this — the function returns immediately."""
    if platform.system() != 'Darwin':
        return
    prefixes = [p for p in ('/opt/homebrew/lib', '/usr/local/lib') if os.path.isdir(p)]
    if not prefixes:
        return

    name_map = {
        'gobject-2.0-0':    'libgobject-2.0.0.dylib',
        'gobject-2.0':      'libgobject-2.0.0.dylib',
        'glib-2.0-0':       'libglib-2.0.0.dylib',
        'glib-2.0':         'libglib-2.0.0.dylib',
        'pango-1.0-0':      'libpango-1.0.0.dylib',
        'pango-1.0':        'libpango-1.0.0.dylib',
        'pangoft2-1.0-0':   'libpangoft2-1.0.0.dylib',
        'pangoft2-1.0':     'libpangoft2-1.0.0.dylib',
        'harfbuzz':         'libharfbuzz.0.dylib',
        'fontconfig-1':     'libfontconfig.1.dylib',
        'fontconfig':       'libfontconfig.1.dylib',
        'freetype':         'libfreetype.6.dylib',
        'cairo':            'libcairo.2.dylib',
        'cairo-2':          'libcairo.2.dylib',
        'gdk_pixbuf-2.0-0': 'libgdk_pixbuf-2.0.0.dylib',
        'gdk_pixbuf-2.0':   'libgdk_pixbuf-2.0.0.dylib',
    }

    # 1) preload — ignore failures (a library that's not installed shouldn't
    # crash startup; weasyprint will surface a clearer error later).
    for fname in set(name_map.values()):
        for prefix in prefixes:
            path = os.path.join(prefix, fname)
            if os.path.exists(path):
                try:
                    ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
                break

    # 2) monkey-patch find_library so cffi's name lookup succeeds.
    import ctypes.util as cu
    _orig = cu.find_library

    def _patched(name):
        path = _orig(name)
        if path:
            return path
        fname = name_map.get(name)
        if not fname:
            return None
        for prefix in prefixes:
            cand = os.path.join(prefix, fname)
            if os.path.exists(cand):
                return cand
        return None

    cu.find_library = _patched


_macos_setup_weasyprint()

# Heavy deps are imported lazily inside generate_pdf() so a misconfigured
# environment surfaces a single clear error at request time rather than
# breaking module import (and the whole Flask app).
#
# Operating day + revenue/cost assumptions are shared with spreadsheet.py via
# economics.py so the PDF and XLSX exports never disagree.
from economics import (DAY_START_MIN as DAY_START, DAY_END_MIN as DAY_END,
                       REALISATION_LOW, REALISATION_HIGH, PROCUREMENT_EUR_PER_KWH)

# Bonus: auto-embed an airport photo on the cover (curated local first, then
# Wikimedia). Flip to False to disable the network fallback entirely.
AIRPORT_PHOTO_WIKIMEDIA = True

# House palette for the energy-mix donut (muted base + accents).
_DONUT_PALETTE = ['#2563eb', '#F0892B', '#10b981', '#6f42c1', '#0ea5e9',
                  '#f59e0b', '#14b8a6', '#ef4444', '#8b5cf6', '#64748b']

# House colours reused by the server-drawn SVGs / map.
_C_NAVY = '#152455'
_C_BLUE = '#2563eb'
_C_ORANGE = '#F0892B'
_C_GREEN = '#10b981'
_C_INK = '#0f1729'
_C_BODY = '#334155'
_C_MUTED = '#94a3b8'
_C_LINE = '#e2e8f0'
_C_SOFT = '#f1f5f9'

ROOT = os.path.dirname(__file__)
PICS_DIR = os.path.join(ROOT, 'pics')

# ---------- helpers ----------------------------------------------------------

def _fmt_clock(minutes: float) -> str:
    """e.g. 405.9 -> '13:46' (rounded). Wraps to 24h."""
    m = max(0, int(round(minutes))) % (24 * 60)
    return f'{m // 60:02d}:{m % 60:02d}'


def _safe_pics_path(rel) -> str:
    """Resolve a payload-supplied, pics-relative path, refusing anything that
    escapes PICS_DIR (absolute paths or ../ traversal). The plane `image`/`svg`
    fields come from the client-POSTed payload, so an unguarded os.path.join
    would let `/etc/passwd` or `../../secret` be base64-embedded into the PDF.
    Returns the absolute path, or '' if it isn't safely inside PICS_DIR."""
    if not rel or not isinstance(rel, str):
        return ''
    base = os.path.realpath(PICS_DIR)
    real = os.path.realpath(os.path.join(base, rel))
    if real == base or real.startswith(base + os.sep):
        return real
    return ''


def _file_data_uri(path: str) -> str:
    """Embed a local file as a data: URI so WeasyPrint doesn't have to fetch it."""
    if not path or not os.path.exists(path):
        return ''
    mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    return f'data:{mime};base64,{b64}'


def _png_data_uri(png_bytes: bytes) -> str:
    return 'data:image/png;base64,' + base64.b64encode(png_bytes).decode('ascii')


def _fmt_energy(kwh) -> str:
    """kWh, switching to MWh (2 dp) at >= 1000 — matches the in-app unit display."""
    try:
        v = float(kwh)
    except (TypeError, ValueError):
        return ''
    return f'{v / 1000:.2f} MWh' if v >= 1000 else f'{v:.0f} kWh'


def _fmt_power(kw) -> str:
    try:
        v = float(kw)
    except (TypeError, ValueError):
        return ''
    return f'{v / 1000:.2f} MW' if v >= 1000 else f'{v:.0f} kW'


def _fmt_money(eur) -> str:
    """Whole euros with thousands separators, e.g. 1234.5 -> '€1,235'."""
    try:
        v = float(eur)
    except (TypeError, ValueError):
        return ''
    return f'€{v:,.0f}'


def _append_onepager(pdf_bytes: bytes) -> bytes:
    """Append static/NRG2fly_onepager.pdf as the final pages, if present. Skips
    silently (returns the original bytes) when the file or pypdf is unavailable."""
    onepager = os.path.join(ROOT, 'static', 'NRG2fly_onepager.pdf')
    if not os.path.exists(onepager):
        return pdf_bytes
    try:
        import io
        from pypdf import PdfReader, PdfWriter
        writer = PdfWriter()
        writer.append(PdfReader(io.BytesIO(pdf_bytes)))
        writer.append(PdfReader(onepager))
        buf = io.BytesIO()
        writer.write(buf)
        return buf.getvalue()
    except Exception:
        return pdf_bytes


# ---------- SVG charts -------------------------------------------------------
# All chart sizing is in CSS pixels (the template scales width to 100% so the
# absolute width here doesn't really matter — what matters is the aspect ratio).

_BAR_W = 720
_BAR_BAR_H = 22
_BAR_GAP = 6
_BAR_LBL_W = 200
_BAR_VAL_W = 70

def _bar_chart_svg(items, fmt, color='#2563eb'):
    """items: [(label, value)]. fmt(value) -> the value-label string. Returns SVG."""
    if not items:
        return '<p class="lede">No data.</p>'
    vmax = max(v for _, v in items) or 1
    track_w = _BAR_W - _BAR_LBL_W - _BAR_VAL_W - 12
    rows = len(items)
    h = rows * (_BAR_BAR_H + _BAR_GAP) + 10
    out = [f'<svg class="bar-chart" viewBox="0 0 {_BAR_W} {h}" '
           f'preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg" '
           f'font-family="Inter, sans-serif">']
    for i, (label, value) in enumerate(items):
        y = 5 + i * (_BAR_BAR_H + _BAR_GAP)
        bar_len = max(2, track_w * (value / vmax))
        # label
        out.append(f'<text x="{_BAR_LBL_W - 6}" y="{y + _BAR_BAR_H * 0.7}" '
                   f'text-anchor="end" font-size="11" fill="#0f1729">{_xml_escape(label)}</text>')
        # bar track
        out.append(f'<rect x="{_BAR_LBL_W}" y="{y}" width="{track_w}" height="{_BAR_BAR_H}" '
                   f'fill="#f1f5f9" rx="3"/>')
        # bar fill
        out.append(f'<rect x="{_BAR_LBL_W}" y="{y}" width="{bar_len:.1f}" height="{_BAR_BAR_H}" '
                   f'fill="{color}" rx="3"/>')
        # value label
        val_x = _BAR_LBL_W + bar_len + 6
        out.append(f'<text x="{val_x:.1f}" y="{y + _BAR_BAR_H * 0.7}" '
                   f'font-size="10.5" fill="#475569">{_xml_escape(fmt(value))}</text>')
    out.append('</svg>')
    return ''.join(out)


def _xml_escape(s):
    if s is None:
        return ''
    return (str(s)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;')
            .replace("'", '&#39;'))


def _nice_axis(vmax, target_ticks=4):
    """Return (nice_max, step) so a 0..nice_max axis has ~target_ticks gridlines
    at round values."""
    if vmax is None or vmax <= 0:
        return (1.0, 1.0)
    raw = vmax / max(1, target_ticks)
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1.0
    step = mag
    for m in (1, 2, 2.5, 5, 10):
        if m * mag >= raw:
            step = m * mag
            break
    nice_max = math.ceil(vmax / step) * step
    return (nice_max, step)


# ---------- Time-of-day load curve -------------------------------------------
_CURVE_W = 720
_CURVE_H = 205

def _load_curve_svg(series, peak_kw=None, installed_kw=None):
    """Daily power load profile. `series` is a step function: a list of
    {'t': <minute from 00:00>, 'kw': <number>} breakpoints where the power is
    `kw` from this t until the next breakpoint. Draws a filled area + top line,
    a dashed peak line, and a faint installed-capacity line."""
    pts = sorted(({'t': float(p['t']), 'kw': max(0.0, float(p['kw']))}
                  for p in (series or []) if p.get('t') is not None),
                 key=lambda p: p['t'])
    if not pts or all(p['kw'] <= 0 for p in pts):
        return '<p class="lede">No charging load on this day.</p>'

    t0 = DAY_START
    last_activity = max(p['t'] for p in pts)
    last_hour = min(30, max(int(math.ceil(DAY_END / 60)), int(math.ceil(last_activity / 60))))
    t1 = last_hour * 60
    # clamp / pad the series to the drawn window
    if pts[0]['t'] > t0:
        pts.insert(0, {'t': t0, 'kw': 0.0})
    if pts[-1]['t'] < t1:
        pts.append({'t': t1, 'kw': 0.0})

    vmax = max([p['kw'] for p in pts] + [peak_kw or 0, installed_kw or 0])
    nice_max, step = _nice_axis(vmax, 4)
    mw = nice_max >= 1000
    div = 1000.0 if mw else 1.0
    unit = 'MW' if mw else 'kW'

    left, right, top, bottom = 60, _CURVE_W - 16, 16, _CURVE_H - 26
    span_t = (t1 - t0) or 1
    px = lambda t: left + (t - t0) / span_t * (right - left)
    py = lambda kw: bottom - (kw / nice_max) * (bottom - top)

    out = [f'<svg class="curve" viewBox="0 0 {_CURVE_W} {_CURVE_H}" '
           f'preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg" '
           f'font-family="Inter, sans-serif">']
    # y gridlines + labels
    n = int(round(nice_max / step))
    for i in range(n + 1):
        v = i * step
        y = py(v)
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" '
                   f'stroke="{_C_LINE}" stroke-width="1"/>')
        out.append(f'<text x="{left - 6}" y="{y + 3:.1f}" text-anchor="end" '
                   f'font-size="9" fill="{_C_MUTED}">{v / div:.2f}</text>' if mw
                   else f'<text x="{left - 6}" y="{y + 3:.1f}" text-anchor="end" '
                   f'font-size="9" fill="{_C_MUTED}">{v / div:.0f}</text>')
    out.append(f'<text x="{left - 6}" y="{top - 5:.1f}" text-anchor="end" '
               f'font-size="8.5" fill="{_C_MUTED}">{unit}</text>')
    # x hour ticks
    for hr in range(t0 // 60, last_hour + 1):
        x = px(hr * 60)
        out.append(f'<text x="{x:.1f}" y="{bottom + 14:.1f}" text-anchor="middle" '
                   f'font-size="9" fill="{_C_MUTED}">{hr:02d}</text>')

    # area + line (step-after)
    area = [f'M {px(t0):.1f} {bottom:.1f}']
    line = []
    prev = 0.0
    for j, p in enumerate(pts):
        x = px(p['t'])
        area.append(f'L {x:.1f} {py(prev):.1f} L {x:.1f} {py(p["kw"]):.1f}')
        cmd = 'M' if not line else 'L'
        line.append(f'{cmd} {x:.1f} {py(prev):.1f} L {x:.1f} {py(p["kw"]):.1f}')
        prev = p['kw']
    area.append(f'L {px(t1):.1f} {bottom:.1f} Z')
    out.append(f'<path d="{" ".join(area)}" fill="{_C_BLUE}" fill-opacity="0.14"/>')
    out.append(f'<path d="{" ".join(line)}" fill="none" stroke="{_C_BLUE}" '
               f'stroke-width="2" stroke-linejoin="round"/>')

    # installed-capacity line (faint grey dashed)
    if installed_kw and installed_kw > 0 and installed_kw <= nice_max:
        y = py(installed_kw)
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" '
                   f'stroke="{_C_MUTED}" stroke-width="1.2" stroke-dasharray="2 3"/>')
        out.append(f'<text x="{right}" y="{y - 4:.1f}" text-anchor="end" '
                   f'font-size="8.5" fill="{_C_MUTED}">Installed {installed_kw / div:.2f} {unit}</text>')
    # peak line (dashed orange) + label at the peak time
    if peak_kw and peak_kw > 0:
        peak_t = max(pts, key=lambda p: p['kw'])['t']
        y = py(peak_kw)
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" '
                   f'stroke="{_C_ORANGE}" stroke-width="1.4" stroke-dasharray="4 3"/>')
        out.append(f'<text x="{px(peak_t) + 6:.1f}" y="{y - 4:.1f}" '
                   f'font-size="9" font-weight="700" fill="{_C_ORANGE}">'
                   f'Peak {peak_kw / div:.2f} {unit} @ {_fmt_clock(peak_t)}</text>')
    out.append('</svg>')
    return ''.join(out)


# ---------- Energy-mix donut -------------------------------------------------
_DONUT_W = 720
_DONUT_H = 184

def _polar(cx, cy, r, deg):
    a = math.radians(deg - 90)
    return (cx + r * math.cos(a), cy + r * math.sin(a))

def _donut_svg(slices, center_value, center_unit):
    """`slices`: [{'label', 'value'}] (value in kWh/day). Renders a donut sized
    by value, a centre total, and a legend with per-slice value + percentage."""
    data = [{'label': s.get('label', ''), 'value': max(0.0, float(s.get('value') or 0))}
            for s in (slices or [])]
    data = [s for s in data if s['value'] > 0]
    total = sum(s['value'] for s in data)
    if not data or total <= 0:
        return '<p class="lede">No energy throughput on this day.</p>'

    cx, cy, rO, rI = 104, 92, 70, 43
    out = [f'<svg class="donut" viewBox="0 0 {_DONUT_W} {_DONUT_H}" '
           f'preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg" '
           f'font-family="Inter, sans-serif">']
    if len(data) == 1:
        c = _DONUT_PALETTE[0]
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{(rO + rI) / 2}" fill="none" '
                   f'stroke="{c}" stroke-width="{rO - rI}"/>')
    else:
        a0 = 0.0
        for i, s in enumerate(data):
            a1 = a0 + s['value'] / total * 360.0
            large = 1 if (a1 - a0) > 180 else 0
            ox0, oy0 = _polar(cx, cy, rO, a0)
            ox1, oy1 = _polar(cx, cy, rO, a1)
            ix1, iy1 = _polar(cx, cy, rI, a1)
            ix0, iy0 = _polar(cx, cy, rI, a0)
            c = _DONUT_PALETTE[i % len(_DONUT_PALETTE)]
            out.append(
                f'<path d="M {ox0:.2f} {oy0:.2f} A {rO} {rO} 0 {large} 1 {ox1:.2f} {oy1:.2f} '
                f'L {ix1:.2f} {iy1:.2f} A {rI} {rI} 0 {large} 0 {ix0:.2f} {iy0:.2f} Z" '
                f'fill="{c}"/>')
            a0 = a1
    # centre total
    out.append(f'<text x="{cx}" y="{cy - 2}" text-anchor="middle" font-size="20" '
               f'font-weight="800" fill="{_C_INK}">{center_value}</text>')
    out.append(f'<text x="{cx}" y="{cy + 14}" text-anchor="middle" font-size="9" '
               f'fill="{_C_MUTED}">{_xml_escape(center_unit)}</text>')
    # legend
    lx, ly = 250, 28
    for i, s in enumerate(data):
        c = _DONUT_PALETTE[i % len(_DONUT_PALETTE)]
        pct = s['value'] / total * 100
        out.append(f'<rect x="{lx}" y="{ly - 9}" width="11" height="11" rx="2" fill="{c}"/>')
        out.append(f'<text x="{lx + 18}" y="{ly}" font-size="11" fill="{_C_INK}">'
                   f'{_xml_escape(s["label"])}</text>')
        out.append(f'<text x="{_DONUT_W - 8}" y="{ly}" text-anchor="end" font-size="10.5" '
                   f'fill="{_C_BODY}">{_fmt_energy(s["value"])} · {pct:.0f}%</text>')
        ly += 24
    out.append('</svg>')
    return ''.join(out)


# ---------- Rotation Gantt ---------------------------------------------------
_GANTT_W = 720
_GANTT_LBL_W = 176
_GANTT_LANE_H = 40
_PHASE_COLOR = {
    'fly':          _C_BLUE,
    'charge':       _C_GREEN,
    'elsewhere':    '#9bd3ad',          # off-airport charge phases
    'wait':         'url(#wait-stripe)',
    'waitElsewhere': 'url(#queue-stripe)',
}

def _truncate(s, n):
    s = s or ''
    return s if len(s) <= n else s[:n - 1].rstrip() + '…'

def _gantt_svg(rotations, last_hour=23):
    """Render an airport's rotation lanes as a vector Gantt chart.
    rotations: [{ planeName, role, multiLeg, freq, instances: [
        { start: minutes, phases: [{kind, start, dur, label}] } ]}]
    """
    if not rotations:
        return ''
    # extend axis if a rotation spills past 23:00
    for r in rotations:
        for inst in r.get('instances', []):
            for p in inst.get('phases', []):
                end_clock = inst['start'] + p['start'] + p['dur']
                last_hour = max(last_hour, int(end_clock // 60) + 1)
    last_hour = min(30, max(23, last_hour))
    track_x = _GANTT_LBL_W
    track_w = _GANTT_W - _GANTT_LBL_W - 16          # right padding so the last bar/tick isn't clipped
    span = (last_hour * 60) - DAY_START
    px = lambda mins: track_x + (mins - DAY_START) / span * track_w
    width_px = lambda mins: max(1.5, (mins / span) * track_w)
    lanes = len(rotations)
    top = 22
    h = lanes * _GANTT_LANE_H + top + 8

    out = [f'<svg class="gantt" viewBox="0 0 {_GANTT_W} {h}" '
           f'preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg" '
           f'font-family="Inter, sans-serif">']
    # stripe patterns for waits (here = amber, elsewhere = grey)
    out.append('<defs>'
               '<pattern id="wait-stripe" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">'
               '<rect width="6" height="6" fill="#fde9cf"/><rect width="3" height="6" fill="#F0892B"/></pattern>'
               '<pattern id="queue-stripe" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">'
               '<rect width="6" height="6" fill="#eef2f6"/><rect width="3" height="6" fill="#cbd5e1"/></pattern>'
               '</defs>')
    # hour axis
    for hr in range(7, last_hour + 1):
        x = px(hr * 60)
        out.append(f'<text x="{x:.1f}" y="14" font-size="10" fill="{_C_MUTED}" '
                   f'text-anchor="middle">{hr:02d}</text>')
        out.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{h - 6}" '
                   f'stroke="{_C_SOFT}" stroke-width="1"/>')
    # frame + label-gutter divider
    out.append(f'<rect x="{track_x}" y="{top}" width="{track_w}" height="{lanes * _GANTT_LANE_H}" '
               f'fill="none" stroke="{_C_LINE}" rx="4"/>')
    out.append(f'<line x1="{track_x - 8}" y1="{top}" x2="{track_x - 8}" y2="{top + lanes * _GANTT_LANE_H}" '
               f'stroke="{_C_LINE}" stroke-width="1"/>')

    for li, rot in enumerate(rotations):
        y = top + li * _GANTT_LANE_H
        # row separator
        if li:
            out.append(f'<line x1="0" y1="{y}" x2="{_GANTT_W}" y2="{y}" '
                       f'stroke="#f4f4f4" stroke-width="1"/>')
        # label (truncated, full name in <title>)
        route = rot.get('route', '')
        out.append(f'<text x="6" y="{y + 15}" font-size="10" font-weight="700" fill="{_C_INK}">'
                   f'{_xml_escape(_truncate(route, 30))}<title>{_xml_escape(route)}</title></text>')
        sub = f'{rot.get("planeName", "")} · {rot.get("role", "")}'
        if rot.get('multiLeg'):
            sub += ' · multi-leg'
        sub += f' · {len(rot.get("instances", []))}/day'
        out.append(f'<text x="6" y="{y + 28}" font-size="9" fill="{_C_MUTED}">{_xml_escape(_truncate(sub, 34))}</text>')

        # bars
        for inst in rot.get('instances', []):
            for p in inst.get('phases', []):
                start_clock = inst['start'] + p['start']
                if start_clock + p['dur'] < DAY_START or start_clock > last_hour * 60:
                    continue
                x = px(start_clock)
                w = width_px(p['dur'])
                kind = p.get('kind', 'fly')
                color = _PHASE_COLOR.get(kind, _C_MUTED)
                tooltip = _xml_escape(p.get('label', ''))
                out.append(f'<rect x="{x:.1f}" y="{y + 9}" width="{w:.1f}" height="{_GANTT_LANE_H - 18}" '
                           f'fill="{color}" rx="2"><title>{tooltip}</title></rect>')

    out.append('</svg>')
    return ''.join(out)


# ---------- Network map ------------------------------------------------------

def _network_map_png(routes, airports, width=900, height=520):
    """Render a static OSM map with all routes + airport markers.
    Returns PNG bytes, or b'' if anything fails (so the report still generates).
    """
    if not routes and not airports:
        return b''
    try:
        from staticmap import StaticMap, Line, CircleMarker
    except ImportError:
        return b''

    m = StaticMap(
        width, height,
        url_template='https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        headers={'User-Agent': 'NRG2FLY-CNS/1.0 (cns.ghettofaust.exposed)'},
        tile_request_timeout=6,   # without this staticmap waits forever on a slow tile → hung worker
    )
    # routes (staticmap takes (lon, lat)). White casing + orange line so legs
    # read clearly over busy OSM tiles.
    for r in routes:
        wp = r.get('waypoints') or []
        if len(wp) < 2:
            continue
        coords = [(lon, lat) for lat, lon in wp]
        m.add_line(Line(coords, '#ffffff', 7))   # casing
        m.add_line(Line(coords, _C_ORANGE, 4))    # route
    # airport markers — drawn AFTER lines (on top); white halo UNDER the colour
    # so the dot stays visible (the old code drew a black ring over the colour).
    for a in airports:
        lat, lon = a.get('lat'), a.get('lon')
        if lat is None or lon is None:
            continue
        color = _C_BLUE if a.get('role') == 'terminal' else _C_GREEN
        m.add_marker(CircleMarker((lon, lat), '#ffffff', 12))  # halo
        m.add_marker(CircleMarker((lon, lat), color, 8))

    try:
        img = m.render()
        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        return buf.getvalue()
    except Exception:
        return b''


# ---------- Airport photo (bonus) -------------------------------------------
_PHOTO_CACHE_DIR = os.path.join(PICS_DIR, 'airports', '_cache')
_WIKI_UA = 'NRG2FLY-CNS/1.0 (https://nrg2fly.com; charging advisory report)'
# Bound concurrent COLD hover-thumbnail builds (a Wikidata/Esri fetch + render that
# holds a worker for 1-2s) so a map pan firing several preloads at once can't tie up
# every gunicorn worker. Non-blocking: over the cap the build returns the '__busy__'
# sentinel immediately (the route answers 503 and the client retries) — no worker is
# ever held waiting on the lock. Per-process; the on-disk cache makes it one-time.
_THUMB_SEM = threading.BoundedSemaphore(2)
# The ident comes straight from the client-POSTed payload and is used to build
# filesystem paths (curated pics + the download cache) and a SPARQL query. Only
# an ICAO-shaped code is acceptable — anything else (e.g. ../../etc/passwd)
# must be treated as "no ident" or it becomes a path-traversal read/write.
_SAFE_IDENT_RE = re.compile(r'^[A-Za-z0-9_-]{2,8}$')

# SSRF guard: the photo pipeline resolves an image URL from Wikidata/Wikipedia
# responses (steered by the client-supplied airport name) and then fetches it.
# Restrict every outbound _http_get to https on the Wikimedia family of hosts so
# a crafted name can never make the server fetch an arbitrary/internal URL and
# reflect its bytes back inside the PDF.
_ALLOWED_FETCH_HOSTS = ('wikipedia.org', 'wikimedia.org', 'wikidata.org', 'wmcloud.org')


def _fetch_host_allowed(url):
    try:
        parts = urllib.parse.urlparse(url)
    except (ValueError, AttributeError):
        return False
    if parts.scheme != 'https':
        return False
    host = (parts.hostname or '').lower()
    return any(host == d or host.endswith('.' + d) for d in _ALLOWED_FETCH_HOSTS)


def _http_get(url, timeout=6, accept_json=False, params=None):
    # Prefer requests (bundles certifi) — this framework Python's urllib has no
    # CA bundle and fails SSL verification against Wikimedia. staticmap already
    # pulls requests in, so it's always available; urllib is a last resort.
    if not _fetch_host_allowed(url):
        raise ValueError(f'refusing to fetch disallowed URL host: {url!r}')
    try:
        import requests
        resp = requests.get(url, params=params, headers={'User-Agent': _WIKI_UA}, timeout=timeout)
        resp.raise_for_status()
        return resp.json() if accept_json else resp.content
    except ImportError:
        if params:
            url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            'User-Agent': _WIKI_UA,
            'Accept': 'application/json' if accept_json else '*/*',
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        return json.loads(data) if accept_json else data


def _commons_filepath(filename):
    """A directly-fetchable URL for a Commons file (redirects to the upload)."""
    return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + urllib.parse.quote(filename.replace(' ', '_'))


def _is_svg_url(url):
    """A vector source — usually an airport crest/logo arriving via Wikidata P18.
    Also catches Wikimedia SVG thumbnails (rasterised as PNG but sourced from an
    SVG — URL pattern: .../Name.svg/250px-Name.svg.png). These are logos/crests
    that look wrong as a cover photo."""
    path = (url or '').lower().split('?')[0].rstrip('/')
    return path.endswith('.svg') or '.svg/' in path


_ISO_TO_WIKI = {
    'NL': 'nl', 'DE': 'de', 'FR': 'fr', 'ES': 'es', 'IT': 'it', 'PT': 'pt',
    'BE': 'nl', 'AT': 'de', 'CH': 'de', 'SE': 'sv', 'NO': 'no', 'DK': 'da',
    'FI': 'fi', 'PL': 'pl', 'CZ': 'cs', 'SK': 'sk', 'HU': 'hu', 'RO': 'ro',
    'BG': 'bg', 'HR': 'hr', 'SI': 'sl', 'RS': 'sr', 'GR': 'el', 'TR': 'tr',
    'IE': 'ga', 'IS': 'is', 'LT': 'lt', 'LV': 'lv', 'EE': 'et',
    'JP': 'ja', 'KR': 'ko', 'CN': 'zh', 'TW': 'zh', 'TH': 'th', 'ID': 'id',
    'BR': 'pt', 'AR': 'es', 'MX': 'es', 'CL': 'es', 'CO': 'es',
}


def _wikidata_image(ident, name, iso_country=''):
    """Resolve an airport to a representative photo, by ICAO code (P239) first
    — exact and language-independent — then by name. Within each match, prefer
    the linked Wikipedia ARTICLE's lead image (editorially curated; what a
    reader sees as "the photo on the page") over Wikidata's P18 image property,
    which is community-set and often a montage/crest (e.g. RAF Lakenheath).
    When the English Wikipedia has no lead image, try the domestic-language
    Wikipedia (derived from iso_country) before falling back to P18.
    Returns (image_url, credit) or ('', ''). Each step is best-effort."""
    domestic = _ISO_TO_WIKI.get((iso_country or '').upper(), '')
    # by ICAO — the canonical identifier (matches the right airport every time)
    if ident:
        try:
            domestic_clause = ''
            if domestic:
                domestic_clause = (
                    'OPTIONAL { ?domArticle schema:about ?i ; '
                    'schema:isPartOf <https://%s.wikipedia.org/> } ' % domestic)
            q = ('SELECT ?img ?article ?domArticle WHERE { ?i wdt:P239 "%s" . '
                 'OPTIONAL { ?i wdt:P18 ?img } '
                 'OPTIONAL { ?article schema:about ?i ; '
                 'schema:isPartOf <https://en.wikipedia.org/> } '
                 '%s} LIMIT 1'
                 % (ident.replace('"', ''), domestic_clause))
            j = _http_get('https://query.wikidata.org/sparql', accept_json=True,
                          timeout=12, params={'format': 'json', 'query': q})
            rows = (j.get('results') or {}).get('bindings') or []
            if rows:
                dom_article = (rows[0].get('domArticle') or {}).get('value')
                if dom_article and domestic:
                    url, credit = _wiki_lead_image(
                        urllib.parse.unquote(dom_article.rsplit('/', 1)[-1]),
                        lang=domestic)
                    if url:
                        return url, credit
                article = (rows[0].get('article') or {}).get('value')
                if article:
                    url, credit = _wiki_lead_image(urllib.parse.unquote(article.rsplit('/', 1)[-1]))
                    if url:
                        return url, credit
                img = (rows[0].get('img') or {}).get('value', '').replace('http://', 'https://', 1)
                if img:
                    return img, ''   # caller builds a Commons credit from the filename
        except Exception:
            pass
    # by name — fuzzy entity search; same preference per hit
    if name:
        try:
            s = _http_get('https://www.wikidata.org/w/api.php', accept_json=True,
                          params={'action': 'wbsearchentities', 'search': name, 'language': 'en',
                                  'format': 'json', 'type': 'item', 'limit': 5})
            ids = [h['id'] for h in (s.get('search') or [])]
            if ids:
                sitelink_props = 'enwiki'
                if domestic:
                    sitelink_props += '|' + domestic + 'wiki'
                e = _http_get('https://www.wikidata.org/w/api.php', accept_json=True,
                              params={'action': 'wbgetentities', 'ids': '|'.join(ids),
                                      'props': 'claims|sitelinks', 'sitefilter': sitelink_props,
                                      'format': 'json'})
                ents = e.get('entities') or {}
                for i in ids:
                    ent = ents.get(i) or {}
                    sitelinks = ent.get('sitelinks') or {}
                    dom_title = (sitelinks.get(domestic + 'wiki') or {}).get('title') if domestic else None
                    if dom_title:
                        url, credit = _wiki_lead_image(dom_title, lang=domestic)
                        if url:
                            return url, credit
                    title = (sitelinks.get('enwiki') or {}).get('title')
                    if title:
                        url, credit = _wiki_lead_image(title)
                        if url:
                            return url, credit
                    p18 = (ent.get('claims') or {}).get('P18')
                    if p18:
                        return _commons_filepath(p18[0]['mainsnak']['datavalue']['value']), ''
        except Exception:
            pass
    return '', ''


def _wiki_lead_image(title, lang='en'):
    """The lead (infobox) image of a Wikipedia article, via the REST page
    summary. Skips SVG sources. Returns (image_url, credit) or ('', '')."""
    try:
        j = _http_get('https://%s.wikipedia.org/api/rest_v1/page/summary/' % lang
                      + urllib.parse.quote(str(title).replace(' ', '_'), safe=''),
                      accept_json=True)
        src = (j.get('originalimage') or j.get('thumbnail') or {}).get('source')
        if src and not _is_svg_url(src):
            wiki_name = {'en': 'Wikipedia'}.get(lang, lang + '.wikipedia')
            return src, f'{j.get("title", title)} — {wiki_name}'
    except Exception:
        pass
    return '', ''


def _satellite_photo(lat, lon, airport_type=None, size=(1500, 600)):
    """Esri World Imagery centred on the field — the deterministic last-resort
    cover. Every airport has coordinates and a runway is always on-topic,
    unlike the old Commons geosearch lottery (which could return any nearby
    photo). Same imagery as the in-app map's satellite layer; rendered with
    the staticmap dependency the network map already uses. `size` is the output
    canvas in px — the PDF cover keeps the wide default; the live-map hover
    thumbnail passes a small size so only a couple of tiles are fetched. Returns
    JPEG bytes or b'' (any failure ⇒ the cover falls back to its photo-less form)."""
    try:
        from staticmap import StaticMap
        # large fields don't fit at z15 (~5 km across); everything else does
        zoom = 14 if 'large' in str(airport_type or '').lower() else 15
        m = StaticMap(
            size[0], size[1],
            url_template='https://server.arcgisonline.com/ArcGIS/rest/services/'
                         'World_Imagery/MapServer/tile/{z}/{y}/{x}',
            headers={'User-Agent': _WIKI_UA},
            tile_request_timeout=6,   # bound the per-tile wait (see _network_map_png)
        )
        img = m.render(zoom=zoom, center=(float(lon), float(lat)))
        buf = io.BytesIO()
        img.convert('RGB').save(buf, format='JPEG', quality=88)
        return buf.getvalue()
    except Exception:
        return b''


def _airport_photo(ident, name, lat, lon, airport_type=None, iso_country=''):
    """Return {'uri': <data-uri>, 'credit': <str>} for the chosen airport, or
    blanks. Order: curated local pics/airports/<ICAO>.* → cache → (when
    AIRPORT_PHOTO_WIKIMEDIA) Wikidata image by ICAO then by name → an Esri
    satellite render of the field by coordinates. Downloads cache under
    pics/airports/_cache/. Any failure is swallowed → the cover renders
    photo-less (the band is hidden)."""
    blank = {'uri': '', 'credit': ''}
    ident = (ident or '').strip()
    if not _SAFE_IDENT_RE.match(ident):
        ident = ''

    # 1) curated local, then a prior cached download
    for base in ([os.path.join(PICS_DIR, 'airports', ident)] if ident else []) + \
                ([os.path.join(_PHOTO_CACHE_DIR, ident)] if ident else []):
        for ext in ('jpg', 'jpeg', 'png', 'webp', 'svg'):
            p = f'{base}.{ext}'
            if os.path.exists(p):
                credit = ''
                meta = f'{base}.txt'
                if os.path.exists(meta):
                    try:
                        with open(meta, encoding='utf-8') as f:
                            credit = f.read().strip()
                    except OSError:
                        pass
                return {'uri': _file_data_uri(p), 'credit': credit}

    if not AIRPORT_PHOTO_WIKIMEDIA:
        return blank

    # 2) Wikidata-resolved image — by ICAO, then by name (article lead image
    #    preferred; P18 fallback comes back credit-less)
    img_url, credit = _wikidata_image(ident, name, iso_country=iso_country)
    if img_url and _is_svg_url(img_url):
        img_url, credit = '', ''   # vector logo/crest — skip so the satellite render wins
    if img_url and not credit:
        fn = urllib.parse.unquote(img_url.rstrip('/').rsplit('/', 1)[-1]).replace('_', ' ')
        credit = f'{os.path.splitext(fn)[0]} — Wikimedia Commons'
    # 3) deterministic last resort: a satellite image of the field itself
    #    (replaces the old Commons geosearch, which returned any nearby photo)
    raw = b''
    if not img_url and lat is not None and lon is not None:
        raw = _satellite_photo(lat, lon, airport_type)
        if raw:
            credit = 'Satellite imagery © Esri — World Imagery'

    if not img_url and not raw:
        return blank
    # download (unless already rendered) + cache + embed
    try:
        if img_url:
            raw = _http_get(img_url)
            mime = mimetypes.guess_type(img_url.split('?')[0])[0] or 'image/jpeg'
        else:
            mime = 'image/jpeg'
        ext = 'svg' if 'svg' in mime else ('png' if 'png' in mime else 'jpg')
        if ident:
            try:
                os.makedirs(_PHOTO_CACHE_DIR, exist_ok=True)
                with open(os.path.join(_PHOTO_CACHE_DIR, f'{ident}.{ext}'), 'wb') as f:
                    f.write(raw)
                with open(os.path.join(_PHOTO_CACHE_DIR, f'{ident}.txt'), 'w', encoding='utf-8') as f:
                    f.write(credit)
            except OSError:
                pass
        return {'uri': f'data:{mime};base64,' + base64.b64encode(raw).decode('ascii'),
                'credit': credit}
    except Exception:
        return blank


def airport_photo_thumb(ident, name, lat, lon, airport_type=None, box=360, iso_country=''):
    """A small WebP thumbnail of the airport for the live map's hover preview.
    Same resolution order as the PDF cover (_airport_photo): curated local →
    Wikidata/Wikipedia lead image → an Esri satellite render of the field — but
    rendered and cached SMALL so a hover is cheap (the satellite fallback pulls a
    couple of tiles, not the cover's 1500x600). Caches separately as
    <ICAO>_thumb.webp so it never overwrites the full-res cover source. Returns
    (webp_bytes, credit) or (None, '')."""
    ident = (ident or '').strip()
    safe = ident if _SAFE_IDENT_RE.match(ident) else ''
    thumb = os.path.join(_PHOTO_CACHE_DIR, f'{safe}_thumb.webp') if safe else None
    credf = os.path.join(_PHOTO_CACHE_DIR, f'{safe}_thumb.txt') if safe else None

    def _read(p):
        try:
            with open(p, encoding='utf-8') as f:
                return f.read().strip()
        except OSError:
            return ''

    # fast path: thumbnail already built on a prior hover/preload (no lock — instant)
    if thumb and os.path.exists(thumb):
        try:
            with open(thumb, 'rb') as f:
                return f.read(), (_read(credf) if credf else '')
        except OSError:
            pass

    # cold build: reserve one of the bounded slots, or report busy so the caller
    # (route -> 503) lets the client retry instead of us queueing a held worker.
    if not _THUMB_SEM.acquire(blocking=False):
        return None, '__busy__'
    try:
        return _build_airport_thumb(safe, name, lat, lon, airport_type, box, thumb, credf, _read, iso_country=iso_country)
    finally:
        _THUMB_SEM.release()


def _build_airport_thumb(safe, name, lat, lon, airport_type, box, thumb, credf, _read, iso_country=''):
    """The cold path of airport_photo_thumb: resolve a source image (curated /
    Wikidata / small satellite), bomb-guard the decode, downscale to WebP, cache.
    Runs under _THUMB_SEM. Returns (webp_bytes, credit) or (None, '')."""
    raw, credit = b'', ''
    # 1) reuse a curated photo or the PDF's cached source (same image — just downscale)
    for base in ([os.path.join(PICS_DIR, 'airports', safe),
                  os.path.join(_PHOTO_CACHE_DIR, safe)] if safe else []):
        for ext in ('jpg', 'jpeg', 'png', 'webp'):
            p = f'{base}.{ext}'
            if os.path.exists(p):
                try:
                    with open(p, 'rb') as f:
                        raw = f.read()
                    credit = _read(f'{base}.txt')
                    break
                except OSError:
                    pass
        if raw:
            break
    # 2) Wikidata/Wikipedia lead image — by ICAO, then by name
    if not raw and AIRPORT_PHOTO_WIKIMEDIA:
        img_url, credit = _wikidata_image(safe, name, iso_country=iso_country)
        if img_url and _is_svg_url(img_url):
            img_url, credit = '', ''   # vector logo/crest — skip so the satellite render wins
        if img_url:
            if not credit:
                fn = urllib.parse.unquote(img_url.rstrip('/').rsplit('/', 1)[-1]).replace('_', ' ')
                credit = f'{os.path.splitext(fn)[0]} — Wikimedia Commons'
            try:
                raw = _http_get(img_url)
            except Exception:
                raw = b''
    # 3) deterministic last resort: a SMALL Esri satellite render of the field
    if not raw and lat is not None and lon is not None:
        raw = _satellite_photo(lat, lon, airport_type, size=(box * 2, box * 2 * 9 // 16))
        if raw:
            credit = 'Satellite imagery © Esri — World Imagery'
    if not raw:
        return None, ''

    # downscale → WebP. Bound the decode: a legitimately huge upstream image
    # (Wikipedia infobox photos can be 100M+ px) would otherwise inflate to a
    # multi-hundred-MB RGB buffer on a worker. Promote the decompression-bomb
    # warning to an error so an oversized image degrades to "no photo" (404).
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(raw))
        # Reject an oversized upstream image (Wikipedia infobox photos can be 100M+
        # px) by its header dimensions BEFORE decoding, so it can't inflate to a
        # multi-hundred-MB RGB buffer on a worker. Thread-safe (no global filter).
        if (im.size[0] * im.size[1]) > 40_000_000:
            return None, ''
        im = im.convert('RGB')
        im.thumbnail((box, box))
        buf = io.BytesIO()
        im.save(buf, format='WEBP', quality=80, method=4)
        data = buf.getvalue()
    except Exception:
        return None, ''
    if thumb:
        try:
            os.makedirs(_PHOTO_CACHE_DIR, exist_ok=True)
            with open(thumb, 'wb') as f:
                f.write(data)
            if credf:
                with open(credf, 'w', encoding='utf-8') as f:
                    f.write(credit or '')
        except OSError:
            pass
    return data, (credit or '')


# ---------- main entry -------------------------------------------------------

def generate_pdf(payload, css_url, request_root):
    """Render the report PDF and return its bytes.
    Raises RuntimeError with a human-readable message if dependencies are missing.
    """
    try:
        from weasyprint import HTML
    except ImportError as e:
        raise RuntimeError(
            'WeasyPrint is not installed on the server. Install it with '
            '`pip install weasyprint` plus its system deps (libcairo, libpango, '
            f'libgdk-pixbuf, shared-mime-info). Original error: {e}'
        )
    from flask import current_app

    # ---- Decorate the payload with chart SVGs + map PNG --------------------
    totals = payload.get('totals') or {}
    airports = payload.get('airports') or []
    planes = payload.get('planes') or []
    chargers = payload.get('chargers') or []
    routes = payload.get('routes') or []

    # The report is single-airport. The focus is the client-chosen airport (or
    # the busiest one as a robust fallback if the payload wasn't scoped).
    focus = None
    focus_ident = payload.get('focusIdent')
    if focus_ident:
        focus = next((a for a in airports if a.get('ident') == focus_ident), None)
    if focus is None and airports:
        focus = max(airports, key=lambda a: float(a.get('dailyKwh') or 0))

    # per-airport Gantts + derived bits
    for a in airports:
        a['gantt_svg'] = _gantt_svg(a.get('rotations') or [])
        a['latestEndClock'] = _fmt_clock(float(a.get('latestEnd') or DAY_END))
        a['chargerCount'] = sum(int(c.get('count') or 1) for c in (a.get('chargers') or []))
        a['installedKw'] = sum(float(c.get('power_kw') or 0) * int(c.get('count') or 1)
                               for c in (a.get('chargers') or []))

    # Executive-summary charts (focus airport): time-of-day load curve + donut.
    installed_kw = float((focus or {}).get('installedKw') or 0)
    peak_kw = float((focus or {}).get('peakKw') or 0)
    load_curve_svg = _load_curve_svg(
        (focus or {}).get('loadCurvePoints') or payload.get('loadCurvePoints') or [],
        peak_kw=peak_kw, installed_kw=installed_kw)
    energy_by_type = payload.get('energyByType') or (focus or {}).get('energyByType') or []
    donut_slices = [{'label': s.get('label') or s.get('planeName'),
                     'value': s.get('value') if s.get('value') is not None else s.get('dailyKwh')}
                    for s in energy_by_type]
    total_daily = sum(float(s.get('value') or 0) for s in donut_slices) \
        or float((focus or {}).get('dailyKwh') or 0)
    center_val = ('%.2f' % (total_daily / 1000)) if total_daily >= 1000 else ('%.0f' % total_daily)
    center_unit = 'MWh / day' if total_daily >= 1000 else 'kWh / day'
    donut_svg = _donut_svg(donut_slices, center_val, center_unit)

    # plane embeds (so WeasyPrint doesn't have to fetch them): photo + glyph.
    # Paths come from the client payload, so resolve them through _safe_pics_path,
    # which refuses anything that escapes PICS_DIR (path-traversal / abs paths).
    for p in planes:
        svg = p.get('svg')
        p['svg_data_uri'] = _file_data_uri(_safe_pics_path(os.path.join('plane_svgs', svg))) if svg else ''
        img = p.get('image')
        p['image_data_uri'] = _file_data_uri(_safe_pics_path(img)) if img else ''

    # network map — markers from EVERY route waypoint (so charging stops are
    # visible, not just the focus airport). Ends of a leg = terminal, middle
    # waypoints = charging stop; a point seen as terminal anywhere stays terminal.
    pts = {}
    for r in routes:
        wp = r.get('waypoints') or []
        n = len(wp)
        for i, pt in enumerate(wp):
            if not pt or len(pt) < 2:
                continue
            try:
                lat, lon = float(pt[0]), float(pt[1])
            except (TypeError, ValueError):
                continue
            key = (round(lat, 3), round(lon, 3))
            role = 'terminal' if (i == 0 or i == n - 1) else 'stop'
            cur = pts.get(key)
            if cur is None:
                pts[key] = {'lat': lat, 'lon': lon, 'role': role}
            elif role == 'terminal':
                cur['role'] = 'terminal'
    map_airports = list(pts.values())
    map_png = _network_map_png(routes, map_airports)
    map_data_uri = _png_data_uri(map_png) if map_png else ''

    # logo
    logo_path = os.path.join(PICS_DIR, 'logos', 'NRG2fly_logo_kleur_wide.png')
    logo_data_uri = _file_data_uri(logo_path)

    # totals (compute on the server if the client didn't pre-aggregate)
    totals.setdefault('airportCount', len(airports))
    totals.setdefault('flightCount', len(payload.get('flights') or []))
    totals.setdefault('planeCount', len({p.get('id') or p.get('name') for p in planes}))
    totals.setdefault('totalDailyKwh', sum(float(a.get('dailyKwh') or 0) for a in airports))
    totals.setdefault('peakKw', max([float(a.get('peakKw') or 0) for a in airports] or [0]))

    generated_at = payload.get('generatedAt') or datetime.now().strftime('%Y-%m-%d %H:%M')

    charge_rate = payload.get('chargeRate')
    charge_rate = float(charge_rate) if charge_rate is not None else 0.60

    # Revenue & cost scenario (clearly-labelled, tunable — see module constants).
    daily_kwh = float(totals.get('totalDailyKwh') or 0)
    annual_kwh = daily_kwh * 365
    margin_rate = charge_rate - PROCUREMENT_EUR_PER_KWH
    scenario = {
        'tariff': charge_rate,
        'procurement': PROCUREMENT_EUR_PER_KWH,
        'realisation_low': REALISATION_LOW,
        'realisation_high': REALISATION_HIGH,
        'daily_kwh': daily_kwh,
        'annual_kwh': annual_kwh,
        'annual_mwh': annual_kwh / 1000.0,
        'gross_rev_year': charge_rate * annual_kwh,
        'rev_year_low': charge_rate * annual_kwh * REALISATION_LOW,
        'rev_year_high': charge_rate * annual_kwh * REALISATION_HIGH,
        'energy_cost_year': PROCUREMENT_EUR_PER_KWH * annual_kwh,
        'margin_year_low': margin_rate * annual_kwh * REALISATION_LOW,
        'margin_year_high': margin_rate * annual_kwh * REALISATION_HIGH,
    }
    model_settings = payload.get('modelSettings') or {}

    # Bonus: airport cover photo (graceful — '' hides the band).
    photo = _airport_photo((focus or {}).get('ident'),
                           payload.get('focusAirport') or (focus or {}).get('name'),
                           (focus or {}).get('lat'), (focus or {}).get('lon'),
                           airport_type=(focus or {}).get('type'),
                           iso_country=(focus or {}).get('iso_country'))

    # ---- Render template + PDF ---------------------------------------------
    env = current_app.jinja_env
    env.filters['fmt_energy'] = _fmt_energy   # kWh / MWh
    env.filters['fmt_power'] = _fmt_power      # kW / MW
    env.filters['fmt_money'] = _fmt_money      # € with thousands sep
    html_str = env.get_template('report.html').render(
        totals=totals,
        airports=airports,
        planes=planes,
        chargers=chargers,
        load_curve_svg=load_curve_svg,
        donut_svg=donut_svg,
        map_data_uri=map_data_uri,
        logo_data_uri=logo_data_uri,
        generated_at=generated_at,
        css_url=css_url,
        focus_airport=payload.get('focusAirport'),
        charge_rate=charge_rate,
        scenario=scenario,
        model_settings=model_settings,
        airport_photo=photo.get('uri'),
        airport_photo_credit=photo.get('credit'),
    )

    # WeasyPrint → PDF, then append the NRG2fly onepager (if present) as the
    # closing pages.
    pdf_bytes = _append_onepager(HTML(string=html_str, base_url=request_root).write_pdf())
    return pdf_bytes
