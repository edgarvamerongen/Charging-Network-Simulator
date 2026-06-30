# Example: PH-GOV quarterly PDF (dash-joined route string)

The `Bestemming/Route` column is one string: `AMS-LUZ-AMS`,
`AMS-LUN-WKF-(CPT)-WKF-CPT-NBO-AMS`. Parentheses `(XXX)` mark an empty
positioning leg. Passengers are per-leg ("19 heen / 18 tussen / 13 retour").
Split the route on `-`; a parenthesised code is still a visited airport — list
it and mark it in `positioning`.

Sample rows:

| Datum | Bestemming/Route | Aantal passagiers | Aanvrager |
|-------|------------------|-------------------|-----------|
| 1 - 3 oktober 2023 | AMS-LUZ-AMS | 4 | BuZa |
| 13 oktober 2023 | (AMS)-KIV-AMS | 0 heen / 7 retour | AZ |

Normalized output:

```json
{
  "source": "PH-GOV overzicht Q4 2023 (pdf)",
  "defaults": { "freq_basis": "actual" },
  "flights": [
    { "route": ["AMS", "LUZ", "AMS"], "date": "2023-10-01", "operator": "BuZa",
      "note": "1 - 3 oktober 2023" },
    { "route": ["AMS", "KIV", "AMS"], "date": "2023-10-13", "operator": "AZ",
      "positioning": [true, false, false], "note": "(AMS) outbound was positioning" }
  ]
}
```
