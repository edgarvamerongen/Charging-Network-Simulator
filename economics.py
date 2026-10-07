"""Shared assumptions for the two export pipelines.

report.py (PDF) and spreadsheet.py (XLSX) both present the same revenue/cost
scenario and operating day. Keeping the numbers here means the two exports can
never quietly disagree — change a figure once and both pick it up.
"""

# Operating day (minutes from 00:00). The scheduler runs 07:00–23:00.
DAY_START_MIN = 7 * 60
DAY_END_MIN = 23 * 60

# Revenue realisation BAND: not every available kWh is billed at the headline
# tariff (off-peak, contracted rates, idle capacity), so annual revenue is shown
# as a low–high range rather than a single figure.
REALISATION_LOW = 0.70
REALISATION_HIGH = 1.00

# Wholesale energy procurement cost (EUR/kWh). Tariff minus this is the gross
# margin, before grid fees, demand charges and operating costs.
PROCUREMENT_EUR_PER_KWH = 0.15

# Annualising: the network flies 5 days a week, so a year is 52 x 5 = 260 operating days and a month a
# twelfth of that (~21.7). Per-year figures are the per-day figure times this. Twin: static/settings.js.
OPERATING_DAYS_PER_YEAR = 52 * 5
OPERATING_DAYS_PER_MONTH = OPERATING_DAYS_PER_YEAR / 12


def fmt_clock(minutes) -> str:
    """Minutes from 00:00 as 'hh:mm', rounded and wrapped to 24h
    (e.g. 405.9 -> '06:46', 1470 -> '00:30'). '' for anything unparseable."""
    try:
        m = max(0, int(round(float(minutes)))) % (24 * 60)
    except (TypeError, ValueError):
        return ''
    return f'{m // 60:02d}:{m % 60:02d}'
