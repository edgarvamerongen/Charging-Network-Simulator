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
