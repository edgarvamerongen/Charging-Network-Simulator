"""
CNS — XLSX spreadsheet export of the Demand Calculator.

A standardised, responsive workbook that mirrors the PDF report's data and
figures. Deliberately SEPARATE from report.py: it only *reads* the same
self-contained payload the browser already assembles (plus a richer
`flightsFull` list), and never touches the PDF pipeline or the JS engine.

Format = inputs + outputs:
  * INPUT sheets (Flights / Aircraft / Chargers / Settings) are the canonical,
    versioned schema — Excel Tables + named ranges — that a FUTURE importer will
    read to rebuild a plan. (Import is not built yet; the format is the contract.)
  * OUTPUT sheets (Overview, Airports, one per airport) are computed: native
    Excel formulas (daily / revenue / installed / totals / % mix recompute when
    the user edits an input) and native charts bound to cell ranges.

Scheduler-derived figures (per-flight charge energy, peak kW, the load-curve
series, rotation timing) can't be expressed as cell formulas, so they're
exported as values; charts over them still redraw if the user edits the series.
"""
import io
from datetime import datetime

from economics import (DAY_START_MIN, DAY_END_MIN, REALISATION_LOW,
                       REALISATION_HIGH, PROCUREMENT_EUR_PER_KWH)

FORMAT_NAME = 'NRG2FLY Charging Network Simulator — workbook'
FORMAT_VERSION = 'CNS Workbook v1'

# ---- styling (Arial per xlsx conventions; house accent for headers) ---------
FONT = 'Arial'
C_INPUT = 'FF0000FF'    # blue — hardcoded inputs the user may change
C_FORMULA = 'FF000000'  # black — formulas / calculations
C_LINK = 'FF008000'     # green — links pulling from another sheet
C_MUTED = 'FF6B7280'
NAVY = 'FF152455'
BLUE = 'FF2563EB'
ORANGE = 'FFF0892B'
GREEN = 'FF10B981'
SOFT = 'FFF1F5F9'
WHITE = 'FFFFFFFF'

FMT_KWH = '#,##0 "kWh"'
FMT_KW = '#,##0 "kW"'
FMT_EUR = '€#,##0'
FMT_PCT = '0.0%'
FMT_COORD = '0.0000'
FMT_NUM = '#,##0'


def _fpd_expr(n_ref, unit_ref):
    """Flights/day as a live formula: weekly trips amortise over 7 days."""
    return f'=IF({unit_ref}="week",{n_ref}/7,{n_ref})'


class SpreadsheetBuilder:
    def __init__(self, payload):
        from openpyxl import Workbook
        self.p = payload or {}
        self.wb = Workbook()
        self.airports = self.p.get('airports') or []
        self.planes = self.p.get('planes') or []
        self.chargers = self.p.get('chargers') or []
        self.flights = self.p.get('flightsFull') or self.p.get('flights') or []
        self.settings = self.p.get('modelSettings') or {}
        try:
            self.tariff = float(self.p.get('chargeRate'))
        except (TypeError, ValueError):
            self.tariff = 0.60
        self.realisation_low = REALISATION_LOW
        self.realisation_high = REALISATION_HIGH
        self.procurement = PROCUREMENT_EUR_PER_KWH
        self._tab_names = set()
        # filled while building per-airport sheets, consumed by the summary
        self._airport_refs = []   # [{ident, name, lat, lon, sheet, daily, peak, installed}]

    # ---- low-level helpers --------------------------------------------------
    def _cell(self, ws, r, c, value=None, *, bold=False, size=11, color=C_FORMULA,
              fill=None, fmt=None, align=None, wrap=False, italic=False):
        from openpyxl.styles import Font, PatternFill, Alignment
        cell = ws.cell(row=r, column=c)
        if value is not None:
            cell.value = value
        cell.font = Font(name=FONT, bold=bold, size=size, color=color, italic=italic)
        if fill:
            cell.fill = PatternFill('solid', fgColor=fill)
        if fmt:
            cell.number_format = fmt
        if align or wrap:
            cell.alignment = Alignment(horizontal=align or 'left', vertical='center', wrap_text=wrap)
        return cell

    def _header_row(self, ws, r, labels, start_col=1):
        for i, lab in enumerate(labels):
            self._cell(ws, r, start_col + i, lab, bold=True, color=WHITE, fill=NAVY, align='left')

    def _title(self, ws, r, text, c=1, size=16, color=NAVY):
        self._cell(ws, r, c, text, bold=True, size=size, color=color)

    def _table(self, ws, name, first_row, last_row, first_col, last_col):
        """Wrap a written range in an Excel Table (import anchor + styling)."""
        from openpyxl.utils import get_column_letter
        from openpyxl.worksheet.table import Table, TableStyleInfo
        ref = f'{get_column_letter(first_col)}{first_row}:{get_column_letter(last_col)}{last_row}'
        tbl = Table(displayName=name, ref=ref)
        tbl.tableStyleInfo = TableStyleInfo(name='TableStyleLight9', showRowStripes=True,
                                            showFirstColumn=False, showLastColumn=False)
        ws.add_table(tbl)

    def _named(self, name, ws_title, cell_ref):
        from openpyxl.workbook.defined_name import DefinedName
        self.wb.defined_names.add(DefinedName(name, attr_text=f"'{ws_title}'!{cell_ref}"))

    def _widths(self, ws, widths):
        from openpyxl.utils import get_column_letter
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w

    def _tab(self, raw):
        """A valid, unique worksheet tab name (≤31 chars, no []:*?/\\)."""
        base = ''.join(ch for ch in str(raw or 'Airport') if ch not in '[]:*?/\\').strip()[:31] or 'Airport'
        name, i = base, 2
        while name.lower() in self._tab_names:
            suffix = f' ({i})'
            name = base[:31 - len(suffix)] + suffix
            i += 1
        self._tab_names.add(name.lower())
        return name

    # ---- sheets -------------------------------------------------------------
    def _about(self):
        ws = self.wb.create_sheet('About')
        ws.sheet_view.showGridLines = False
        self._widths(ws, [22, 90])
        self._title(ws, 1, 'NRG2FLY · Charging Network Plan', size=18)
        rows = [
            ('Format', FORMAT_NAME),
            ('Version', FORMAT_VERSION),
            ('Generated', self.p.get('generatedAt') or datetime.now().strftime('%Y-%m-%d %H:%M')),
            ('Airports', len(self.airports)),
            ('Flights', len(self.flights)),
            ('', ''),
            ('Input sheets', 'Flights, Aircraft, Chargers, Settings — the standardised, '
                             'round-trippable data. A future import reads ONLY these.'),
            ('Computed sheets', 'Overview, Airports, and one tab per airport — derived from the '
                                'inputs. Regenerated on (re)import; edits there are not read back.'),
            ('Live figures', 'Daily energy, revenue, installed power, totals and % mix are Excel '
                             'formulas — they recompute when you edit a frequency, tariff or charger.'),
            ('Snapshot figures', 'Per-flight charge energy, peak power and the load curve come from '
                                 'the CNS simulator (state-of-charge + queue logic) and are exported '
                                 'as values. Editing aircraft specs here does not recompute them — '
                                 're-run the simulator for that.'),
        ]
        r = 3
        for k, v in rows:
            self._cell(ws, r, 1, k, bold=True, color=NAVY if k else C_FORMULA)
            self._cell(ws, r, 2, v, color=C_MUTED, wrap=True)
            r += 1
        return ws

    def _flights(self):
        ws = self.wb.create_sheet('Flights')
        cols = ['Flight ID', 'Aircraft ID', 'Aircraft', 'Origin ICAO', 'Origin', 'Origin Lat',
                'Origin Lon', 'Dest ICAO', 'Dest', 'Dest Lat', 'Dest Lon', 'Stops (ICAO;…)',
                'Trip type', 'Multi-leg', 'Charger ID', 'Charger', 'Freq N', 'Freq unit']
        self._header_row(ws, 1, cols)
        r = 2
        for f in self.flights:
            stops = ';'.join(s.get('ident', '') for s in (f.get('stops') or []) if isinstance(s, dict))
            vals = [f.get('id'), f.get('planeId'), f.get('planeName'),
                    f.get('originIdent'), f.get('originName'), _num(f.get('originLat')), _num(f.get('originLon')),
                    f.get('destIdent'), f.get('destName'), _num(f.get('destLat')), _num(f.get('destLon')),
                    stops, f.get('tripType'), 'yes' if f.get('multiLeg') else 'no',
                    f.get('chargerId'), f.get('chargerName'), _num(f.get('freqN')), f.get('freqUnit')]
            for i, v in enumerate(vals, start=1):
                fmt = FMT_COORD if i in (6, 7, 10, 11) else None
                self._cell(ws, r, i, v, color=C_INPUT, fmt=fmt)
            r += 1
        last = max(r - 1, 2)
        self._table(ws, 'tblFlights', 1, last, 1, len(cols))
        self._widths(ws, [10, 14, 26, 11, 22, 11, 11, 11, 22, 11, 11, 18, 12, 9, 12, 20, 8, 9])
        return ws

    def _aircraft(self):
        ws = self.wb.create_sheet('Aircraft')
        cols = ['Aircraft ID', 'Name', 'Battery (kWh)', 'Range (km)', 'Speed (km/h)', 'Seats', 'Payload (kg)']
        self._header_row(ws, 1, cols)
        r = 2
        for p in self.planes:
            vals = [p.get('id'), p.get('name'), _num(p.get('battery_kwh')), _num(p.get('range_km')),
                    _num(p.get('speed_kmh')), _num(p.get('seats')), _num(p.get('load_kg'))]
            for i, v in enumerate(vals, start=1):
                self._cell(ws, r, i, v, color=C_INPUT, fmt=(FMT_NUM if i in (3, 4, 5, 7) else None))
            r += 1
        last = max(r - 1, 2)
        self._table(ws, 'tblAircraft', 1, last, 1, len(cols))
        self._named('Aircraft_id', 'Aircraft', f'$A$2:$A${last}')
        self._named('Aircraft_battery', 'Aircraft', f'$C$2:$C${last}')
        self._named('Aircraft_range', 'Aircraft', f'$D$2:$D${last}')
        self._widths(ws, [14, 30, 14, 12, 13, 8, 13])
        return ws

    def _chargers(self):
        ws = self.wb.create_sheet('Chargers')
        cols = ['Charger ID', 'Name', 'Power (kW)']
        self._header_row(ws, 1, cols)
        r = 2
        for c in self.chargers:
            self._cell(ws, r, 1, c.get('id'), color=C_INPUT)
            self._cell(ws, r, 2, c.get('name'), color=C_INPUT)
            self._cell(ws, r, 3, _num(c.get('power_kw')), color=C_INPUT, fmt=FMT_KW)
            r += 1
        last = max(r - 1, 2)
        self._table(ws, 'tblChargers', 1, last, 1, len(cols))
        self._named('Charger_id', 'Chargers', f'$A$2:$A${last}')
        self._named('Charger_power', 'Chargers', f'$C$2:$C${last}')
        self._widths(ws, [14, 28, 14])
        return ws

    def _settings(self):
        ws = self.wb.create_sheet('Settings')
        self._header_row(ws, 1, ['Setting', 'Value'])
        s = self.settings
        rp = s.get('routingPadding') or {}
        rows = [
            ('Charge target (SoC)', _num(s.get('chargeTarget')), FMT_PCT, 'Settings_chargeTarget'),
            ('Charging tariff (EUR/kWh)', self.tariff, '€0.00', 'Settings_tariff'),
            ('Routing padding', ('on' if rp.get('enabled') else 'off'), None, None),
            ('Routing padding factor', _num(rp.get('factor')) or 1.0, '0.00', None),
            ('SID/STAR padding (km/leg)', _num(s.get('sidStarPaddingKm')) or 0, FMT_NUM, None),
            ('Alternate reserve', ('on' if s.get('alternateReserve') else 'off'), None, None),
            ('Grid demand factor', _num(s.get('gridDemandFactor')) or 1.0, '0.00', None),
            ('Operating day start', _clock(DAY_START_MIN), None, None),
            ('Operating day end', _clock(DAY_END_MIN), None, None),
            ('Revenue realisation — low', self.realisation_low, FMT_PCT, 'Settings_realisationLow'),
            ('Revenue realisation — high', self.realisation_high, FMT_PCT, 'Settings_realisationHigh'),
            ('Energy procurement (EUR/kWh)', self.procurement, '€0.00', 'Settings_procurement'),
        ]
        r = 2
        for label, val, fmt, named in rows:
            self._cell(ws, r, 1, label, bold=True, color=NAVY)
            self._cell(ws, r, 2, val, color=C_INPUT, fmt=fmt)
            if named:
                self._named(named, 'Settings', f'$B${r}')
            r += 1
        self._table(ws, 'tblSettings', 1, r - 1, 1, 2)
        self._widths(ws, [30, 16])
        return ws

    def _airport_detail(self, a):
        name = a.get('name') or a.get('ident') or 'Airport'
        ident = a.get('ident') or ''
        ws = self.wb.create_sheet(self._tab(ident or name))
        ws.sheet_view.showGridLines = False
        self._widths(ws, [30, 14, 16, 16, 14])
        self._title(ws, 1, name, size=16)
        self._cell(ws, 2, 1, ident, bold=True, color=C_MUTED)
        self._cell(ws, 2, 2, f"{_num(a.get('lat')):.4f}, {_num(a.get('lon')):.4f}"
                   if a.get('lat') is not None else '', color=C_MUTED)

        contribs = a.get('contribs') or []
        chargers = a.get('chargers') or []

        # --- Installed charging ---
        r = 4
        self._cell(ws, r, 1, 'INSTALLED CHARGING', bold=True, color=NAVY)
        r += 1
        self._header_row(ws, r, ['Charger', 'Count', 'Power each (kW)', 'Total (kW)'])
        ch_first = r + 1
        r += 1
        for c in chargers:
            self._cell(ws, r, 1, c.get('name'), color=C_INPUT)
            self._cell(ws, r, 2, _num(c.get('count')) or 1, color=C_INPUT, fmt=FMT_NUM)
            self._cell(ws, r, 3, _num(c.get('power_kw')), color=C_INPUT, fmt=FMT_NUM)
            self._cell(ws, r, 4, f'=B{r}*C{r}', color=C_FORMULA, fmt=FMT_KW)
            r += 1
        ch_last = r - 1
        installed_cell = f'D{r}'
        self._cell(ws, r, 1, 'Total installed power', bold=True, color=NAVY)
        self._cell(ws, r, 4, (f'=SUM(D{ch_first}:D{ch_last})' if ch_last >= ch_first else 0),
                   bold=True, color=C_FORMULA, fmt=FMT_KW)
        r += 2

        # --- Contributing flights (energy/flight = value; daily = formula) ---
        self._cell(ws, r, 1, 'CONTRIBUTING FLIGHTS', bold=True, color=NAVY)
        r += 1
        self._header_row(ws, r, ['Route', 'Aircraft', 'Trip', 'Freq N', 'Freq unit',
                                 'Energy/flight (kWh)', 'Flights/day', 'Daily total (kWh)', 'Charge time (min)'])
        cf_first = r + 1
        r += 1
        ac_col, daily_col = 2, 8
        for c in contribs:
            role = (c.get('role') or '').upper()
            other = c.get('other') or ''
            route = {'HOME': f'{role} → {other} & back', 'ORIGIN': f'{role} → {other}',
                     'STOP': f'{role} on {other}'}.get(role, f'{role} from {other}')
            trip = ('Retour' if c.get('tripType') == 'retour' else 'One-way') + (' · multi-leg' if c.get('multiLeg') else '')
            self._cell(ws, r, 1, route)
            self._cell(ws, r, 2, c.get('planeName'))
            self._cell(ws, r, 3, trip)
            self._cell(ws, r, 4, _num(c.get('freqN')), color=C_INPUT, fmt=FMT_NUM)
            self._cell(ws, r, 5, c.get('freqUnit'), color=C_INPUT)
            self._cell(ws, r, 6, _num(c.get('energyPerFlight')), color=C_INPUT, fmt=FMT_NUM)
            self._cell(ws, r, 7, _fpd_expr(f'D{r}', f'E{r}'), color=C_FORMULA, fmt='0.00')
            self._cell(ws, r, 8, f'=F{r}*G{r}', color=C_FORMULA, fmt=FMT_NUM)
            self._cell(ws, r, 9, _num(c.get('chargeMin')), color=C_INPUT, fmt=FMT_NUM)
            r += 1
        cf_last = r - 1
        daily_total_cell = f'H{r}'
        self._cell(ws, r, 1, 'Daily total', bold=True, color=NAVY)
        self._cell(ws, r, daily_col, (f'=SUM(H{cf_first}:H{cf_last})' if cf_last >= cf_first else 0),
                   bold=True, color=C_FORMULA, fmt=FMT_KWH)
        r += 2

        # --- KPI header cells (now that totals exist) ---
        self._cell(ws, 3, 3, 'Daily', bold=True, color=C_MUTED, align='right')
        self._cell(ws, 3, 4, f'={daily_total_cell}', color=C_LINK, fmt=FMT_KWH, align='right')
        self._cell(ws, 2, 3, 'Peak', bold=True, color=C_MUTED, align='right')
        self._cell(ws, 2, 4, _num(a.get('peakKw')), color=C_INPUT, fmt=FMT_KW, align='right')
        self._cell(ws, 1, 3, 'Revenue/day', bold=True, color=C_MUTED, align='right')
        self._cell(ws, 1, 4, f'={daily_total_cell}*Settings_tariff', color=C_FORMULA, fmt=FMT_EUR, align='right')

        # --- Energy by aircraft type (SUMIF over the contrib rows) ---
        types = []
        for c in contribs:
            t = c.get('planeName') or 'Unknown'
            if t not in types:
                types.append(t)
        ebt_first = r
        self._cell(ws, r, 1, 'ENERGY BY AIRCRAFT TYPE', bold=True, color=NAVY)
        r += 1
        self._header_row(ws, r, ['Aircraft', 'Daily (kWh)', '% of day'])
        ebt_data_first = r + 1
        r += 1
        from openpyxl.utils import get_column_letter as _gcl
        ac_rng = f'${_gcl(ac_col)}${cf_first}:${_gcl(ac_col)}${cf_last}'
        daily_rng = f'${_gcl(daily_col)}${cf_first}:${_gcl(daily_col)}${cf_last}'
        for t in types:
            if cf_last >= cf_first:
                self._cell(ws, r, 1, t)
                self._cell(ws, r, 2, f'=SUMIF({ac_rng},A{r},{daily_rng})', color=C_FORMULA, fmt=FMT_NUM)
                self._cell(ws, r, 3, f'=IF({daily_total_cell}=0,0,B{r}/{daily_total_cell})', color=C_FORMULA, fmt=FMT_PCT)
                r += 1
        ebt_data_last = r - 1

        # --- Load curve (values) ---
        curve = a.get('loadCurvePoints') or []
        lc_first = r + 1
        if curve:
            r += 1
            self._cell(ws, r, 1, 'DAILY LOAD PROFILE', bold=True, color=NAVY)
            r += 1
            self._header_row(ws, r, ['Time', 'Power (kW)'])
            lc_data_first = r + 1
            r += 1
            for pt in curve:
                self._cell(ws, r, 1, _clock(pt.get('t')), color=C_INPUT)
                self._cell(ws, r, 2, _num(pt.get('kw')), color=C_INPUT, fmt=FMT_NUM)
                r += 1
            lc_data_last = r - 1
        else:
            lc_data_first = lc_data_last = None

        # --- charts ---
        self._add_donut(ws, ident, ebt_data_first, ebt_data_last, anchor='F4')
        if lc_data_first:
            self._add_line(ws, lc_data_first, lc_data_last, anchor='F22')

        self._airport_refs.append({
            'ident': ident, 'name': name, 'lat': a.get('lat'), 'lon': a.get('lon'),
            'sheet': ws.title, 'daily': daily_total_cell, 'peak': _num(a.get('peakKw')),
            'installed': installed_cell,
        })
        return ws

    def _airports_summary(self):
        ws = self.wb.create_sheet('Airports')
        ws.sheet_view.showGridLines = False
        cols = ['Airport', 'ICAO', 'Lat', 'Lon', 'Daily energy (kWh)', 'Peak (kW)',
                'Installed (kW)', 'Revenue/day (EUR)']
        self._header_row(ws, 1, cols)
        r = 2
        for ref in self._airport_refs:
            q = f"'{ref['sheet']}'"
            self._cell(ws, r, 1, ref['name'])
            self._cell(ws, r, 2, ref['ident'])
            self._cell(ws, r, 3, _num(ref['lat']), fmt=FMT_COORD)
            self._cell(ws, r, 4, _num(ref['lon']), fmt=FMT_COORD)
            self._cell(ws, r, 5, f"={q}!{ref['daily']}", color=C_LINK, fmt=FMT_NUM)
            self._cell(ws, r, 6, ref['peak'], color=C_INPUT, fmt=FMT_NUM)
            self._cell(ws, r, 7, f"={q}!{ref['installed']}", color=C_LINK, fmt=FMT_NUM)
            self._cell(ws, r, 8, f'=E{r}*Settings_tariff', color=C_FORMULA, fmt=FMT_EUR)
            r += 1
        self._ap_last = max(r - 1, 2)
        self._table(ws, 'tblAirports', 1, self._ap_last, 1, len(cols))
        self._widths(ws, [28, 10, 11, 11, 18, 12, 14, 18])
        return ws

    def _overview(self):
        ws = self.wb.create_sheet('Overview')
        ws.sheet_view.showGridLines = False
        self._widths(ws, [30, 18, 18, 6, 30, 18])
        self._title(ws, 1, 'Network overview', size=18)
        n = self._ap_last
        daily_col = '\'Airports\'!$E$2:$E$%d' % n
        peak_col = '\'Airports\'!$F$2:$F$%d' % n
        kpis = [
            ('Total daily energy (kWh)', f'=SUM({daily_col})', FMT_NUM),
            ('Peak demand (kW)', f'=MAX({peak_col})', FMT_NUM),
            ('Annual energy (MWh)', f'=SUM({daily_col})*365/1000', FMT_NUM),
            ('Gross revenue / year (EUR)', f'=SUM({daily_col})*365*Settings_tariff', FMT_EUR),
            ('Revenue / year — low (EUR)', f'=SUM({daily_col})*365*Settings_tariff*Settings_realisationLow', FMT_EUR),
            ('Revenue / year — high (EUR)', f'=SUM({daily_col})*365*Settings_tariff*Settings_realisationHigh', FMT_EUR),
            ('Energy cost / year (EUR)', f'=SUM({daily_col})*365*Settings_procurement', FMT_EUR),
            ('Gross margin / year (EUR)', f'=SUM({daily_col})*365*(Settings_tariff-Settings_procurement)', FMT_EUR),
        ]
        r = 3
        for label, formula, fmt in kpis:
            self._cell(ws, r, 1, label, bold=True, color=NAVY)
            self._cell(ws, r, 2, formula, color=C_FORMULA, fmt=fmt)
            r += 1
        # charts bound to the Airports table
        self._add_bar(ws, 'Daily energy per airport (kWh)', col=5, anchor='A13')
        self._add_bar(ws, 'Peak demand per airport (kW)', col=6, anchor='A30')
        return ws

    # ---- charts -------------------------------------------------------------
    def _add_donut(self, ws, ident, first, last, anchor):
        if not first or last < first:
            return
        from openpyxl.chart import DoughnutChart, Reference
        ch = DoughnutChart()
        ch.title = 'Energy by aircraft type'
        ch.height, ch.width = 7.5, 11
        data = Reference(ws, min_col=2, min_row=first - 1, max_row=last)
        cats = Reference(ws, min_col=1, min_row=first, max_row=last)
        ch.add_data(data, titles_from_data=True)
        ch.set_categories(cats)
        ws.add_chart(ch, anchor)

    def _add_line(self, ws, first, last, anchor):
        from openpyxl.chart import LineChart, Reference
        ch = LineChart()
        ch.title = 'Daily load profile (kW)'
        ch.height, ch.width = 7.5, 14
        ch.y_axis.title = 'kW'
        ch.x_axis.title = 'Time'
        data = Reference(ws, min_col=2, min_row=first - 1, max_row=last)
        cats = Reference(ws, min_col=1, min_row=first, max_row=last)
        ch.add_data(data, titles_from_data=True)
        ch.set_categories(cats)
        ch.legend = None
        ws.add_chart(ch, anchor)

    def _add_bar(self, ws, title, col, anchor):
        from openpyxl.chart import BarChart, Reference
        aws = self.wb['Airports']
        n = self._ap_last
        if n < 2:
            return
        ch = BarChart()
        ch.type = 'col'
        ch.title = title
        ch.height, ch.width = 8, 16
        ch.legend = None
        data = Reference(aws, min_col=col, min_row=1, max_row=n)
        cats = Reference(aws, min_col=1, min_row=2, max_row=n)
        ch.add_data(data, titles_from_data=True)
        ch.set_categories(cats)
        ws.add_chart(ch, anchor)

    # ---- assembly -----------------------------------------------------------
    def build(self):
        self.wb.remove(self.wb.active)   # drop the default sheet
        self._about()
        self._flights()
        self._aircraft()
        self._chargers()
        self._settings()
        for a in self.airports:
            self._airport_detail(a)
        self._airports_summary()
        self._overview()
        # presentation order: About, Overview, Airports, inputs, per-airport tabs
        order = ['About', 'Overview', 'Airports', 'Flights', 'Aircraft', 'Chargers', 'Settings']
        order += [r['sheet'] for r in self._airport_refs]
        self.wb._sheets.sort(key=lambda s: order.index(s.title) if s.title in order else 999)
        self.wb.active = 0
        buf = io.BytesIO()
        self.wb.save(buf)
        return buf.getvalue()


# ---- small value coercers ---------------------------------------------------
def _num(v):
    try:
        if v is None or v == '':
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _clock(minutes):
    try:
        m = max(0, int(round(float(minutes)))) % (24 * 60)
        return f'{m // 60:02d}:{m % 60:02d}'
    except (TypeError, ValueError):
        return ''


def generate_xlsx(payload):
    """Render the workbook and return its bytes. Raises RuntimeError if openpyxl
    is unavailable (mirrors report.py's WeasyPrint handling)."""
    try:
        import openpyxl  # noqa: F401
    except ImportError as e:
        raise RuntimeError('openpyxl is not installed on the server. Install it with '
                           f'`pip install openpyxl`. Original error: {e}')
    return SpreadsheetBuilder(payload).build()
