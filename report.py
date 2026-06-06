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
import mimetypes
import os
import platform
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
DAY_START = 7 * 60
DAY_END = 23 * 60

ROOT = os.path.dirname(__file__)
PICS_DIR = os.path.join(ROOT, 'pics')

# ---------- helpers ----------------------------------------------------------

def _fmt_clock(minutes: float) -> str:
    """e.g. 405.9 -> '13:46' (rounded). Wraps to 24h."""
    m = max(0, int(round(minutes))) % (24 * 60)
    return f'{m // 60:02d}:{m % 60:02d}'


def _file_data_uri(path: str) -> str:
    """Embed a local file as a data: URI so WeasyPrint doesn't have to fetch it."""
    if not os.path.exists(path):
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
            .replace('>', '&gt;'))


# ---------- Rotation Gantt ---------------------------------------------------
_GANTT_W = 720
_GANTT_LBL_W = 150
_GANTT_LANE_H = 38
_PHASE_COLOR = {
    'fly':       '#0d6efd',
    'charge':    '#198754',
    'elsewhere': '#9bd3ad',  # off-airport charge phases
    'wait':      'url(#wait-stripe)',
}

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
    track_w = _GANTT_W - _GANTT_LBL_W - 10
    span = (last_hour * 60) - DAY_START
    px = lambda mins: _GANTT_LBL_W + (mins - DAY_START) / span * track_w
    width_px = lambda mins: max(1.5, (mins / span) * track_w)
    lanes = len(rotations)
    h = lanes * _GANTT_LANE_H + 28

    out = [f'<svg class="gantt" viewBox="0 0 {_GANTT_W} {h}" '
           f'preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg" '
           f'font-family="Inter, sans-serif">']
    # stripe pattern for waits
    out.append('<defs><pattern id="wait-stripe" patternUnits="userSpaceOnUse" '
               'width="6" height="6" patternTransform="rotate(45)">'
               '<rect width="6" height="6" fill="#fbe4c4"/>'
               '<rect width="3" height="6" fill="#f0ad4e"/></pattern></defs>')
    # hour axis
    for hr in range(7, last_hour + 1):
        x = px(hr * 60)
        out.append(f'<text x="{x:.1f}" y="14" font-size="9" fill="#94a3b8" '
                   f'text-anchor="middle">{hr:02d}</text>')
        out.append(f'<line x1="{x:.1f}" y1="20" x2="{x:.1f}" y2="{h}" '
                   f'stroke="#f1f5f9" stroke-width="1"/>')
    # frame
    out.append(f'<rect x="{_GANTT_LBL_W}" y="20" width="{track_w}" height="{lanes * _GANTT_LANE_H}" '
               f'fill="none" stroke="#e2e8f0" rx="4"/>')

    for li, rot in enumerate(rotations):
        y = 20 + li * _GANTT_LANE_H
        # row separator
        if li:
            out.append(f'<line x1="0" y1="{y}" x2="{_GANTT_W}" y2="{y}" '
                       f'stroke="#f4f4f4" stroke-width="1"/>')
        # label
        plane = _xml_escape(rot.get('planeName', ''))
        route = _xml_escape(rot.get('route', ''))
        out.append(f'<text x="6" y="{y + 14}" font-size="9" font-weight="600" fill="#0f1729">{route}</text>')
        sub = f'{plane} · {rot.get("role", "")}'
        if rot.get('multiLeg'):
            sub += ' · multi-leg'
        sub += f' · {len(rot.get("instances", []))}/day'
        out.append(f'<text x="6" y="{y + 26}" font-size="8" fill="#94a3b8">{_xml_escape(sub)}</text>')

        # bars
        for inst in rot.get('instances', []):
            for p in inst.get('phases', []):
                start_clock = inst['start'] + p['start']
                if start_clock + p['dur'] < DAY_START or start_clock > last_hour * 60:
                    continue
                x = px(start_clock)
                w = width_px(p['dur'])
                kind = p.get('kind', 'fly')
                color = _PHASE_COLOR.get(kind, '#94a3b8')
                tooltip = _xml_escape(p.get('label', ''))
                out.append(f'<rect x="{x:.1f}" y="{y + 7}" width="{w:.1f}" height="{_GANTT_LANE_H - 14}" '
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
    )
    # routes (staticmap takes (lon, lat))
    for r in routes:
        wp = r.get('waypoints') or []
        if len(wp) < 2:
            continue
        coords = [(lon, lat) for lat, lon in wp]
        m.add_line(Line(coords, '#6c8aa4', 3))
    # airport markers
    for a in airports:
        lat, lon = a.get('lat'), a.get('lon')
        if lat is None or lon is None:
            continue
        color = '#ff7800' if a.get('role') == 'terminal' else '#2563eb'
        m.add_marker(CircleMarker((lon, lat), color, 8))
        m.add_marker(CircleMarker((lon, lat), '#000', 9))  # outline

    try:
        img = m.render()
        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        return buf.getvalue()
    except Exception:
        return b''


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

    # peak + energy bar charts, sorted big → small
    peak_items = sorted(
        [(a['name'], float(a.get('peakKw') or 0)) for a in airports],
        key=lambda x: x[1], reverse=True,
    )
    energy_items = sorted(
        [(a['name'], float(a.get('dailyKwh') or 0)) for a in airports],
        key=lambda x: x[1], reverse=True,
    )
    bar_chart_peak = _bar_chart_svg(peak_items, _fmt_power, '#2563eb')
    bar_chart_energy = _bar_chart_svg(energy_items, _fmt_energy, '#10b981')

    # per-airport Gantts
    for a in airports:
        a['gantt_svg'] = _gantt_svg(a.get('rotations') or [])
        a['latestEndClock'] = _fmt_clock(float(a.get('latestEnd') or DAY_END))
        a['chargerCount'] = sum(int(c.get('count') or 1) for c in (a.get('chargers') or []))

    # plane svg embeds (so WeasyPrint doesn't have to fetch them)
    for p in planes:
        svg = p.get('svg')
        if svg:
            p['svg_data_uri'] = _file_data_uri(os.path.join(PICS_DIR, 'plane_svgs', svg))
        else:
            p['svg_data_uri'] = ''

    # network map
    map_airports = []
    for a in airports:
        map_airports.append({'lat': a.get('lat'), 'lon': a.get('lon'),
                             'role': 'terminal' if any(c.get('role') in ('home', 'dest', 'origin')
                                                       for c in a.get('contribs') or [])
                                                   else 'stop'})
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

    # ---- Render template + PDF ---------------------------------------------
    env = current_app.jinja_env
    env.filters['fmt_energy'] = _fmt_energy   # kWh / MWh
    env.filters['fmt_power'] = _fmt_power      # kW / MW
    env.filters['fmt_money'] = _fmt_money      # € with thousands sep
    charge_rate = payload.get('chargeRate')
    charge_rate = float(charge_rate) if charge_rate is not None else 0.60
    html_str = env.get_template('report.html').render(
        totals=totals,
        airports=airports,
        planes=planes,
        chargers=chargers,
        bar_chart_peak=bar_chart_peak,
        bar_chart_energy=bar_chart_energy,
        map_data_uri=map_data_uri,
        logo_data_uri=logo_data_uri,
        generated_at=generated_at,
        css_url=css_url,
        focus_airport=payload.get('focusAirport'),
        charge_rate=charge_rate,
    )

    # WeasyPrint → PDF, then append the NRG2fly onepager (if present) as the
    # closing pages.
    pdf_bytes = _append_onepager(HTML(string=html_str, base_url=request_root).write_pdf())
    return pdf_bytes
