# Example: PH-GOV usage spreadsheet (column-per-stop)

Source columns: `Datum | Van | Stop 1..6 | Naar | Passagiers | Aanvrager | Kwartaal | Opmerking`.
Codes are IATA. A trip is `Van → Stop… → Naar` (often a round trip back to AMS).
Dates may be ranges ("20-21 jan 2022") — take the start date, keep the original in `note`.

Sample rows:

| Datum | Van | Stop 1 | Stop 2 | Naar | Passagiers | Aanvrager |
|-------|-----|--------|--------|------|-----------|-----------|
| 13 jan 2022 | AMS | BER | | AMS | 8 | AZ |
| 1-2 feb 2022 | AMS | KBP | KIV | AMS | 16 | AZ |

Normalized output:

```json
{
  "source": "PH-GOV vluchten (xlsx)",
  "defaults": { "freq_basis": "actual" },
  "flights": [
    { "route": ["AMS", "BER", "AMS"], "date": "2022-01-13", "pax": 8, "operator": "AZ" },
    { "route": ["AMS", "KIV", "AMS"], "date": "2022-02-01", "pax": 16, "operator": "AZ",
      "note": "1-2 feb 2022; via KBP" }
  ]
}
```
