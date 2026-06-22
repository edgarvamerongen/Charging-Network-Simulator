# CNS Embed — Integration Guide

Embed a live Charging Network Simulator preview card on your site with a
single `<iframe>` tag. No API keys, no authentication, no JavaScript
integration required.

## Quick Start

```html
<iframe src="https://cns.nrg2fly.nl/embed?origin=den+helder"
        width="100%" height="320" frameborder="0"
        style="border:0; border-radius:12px;">
</iframe>
```

## URL

```
https://cns.nrg2fly.nl/embed?origin=...&destination=...
```

## Parameters

All parameters are optional. The embed adapts to whatever you provide.

| Parameter     | Example                 | Description                                   |
|---------------|-------------------------|-----------------------------------------------|
| `origin`      | `EHKD` or `den helder` | Origin airport (ICAO code or name)            |
| `destination` | `EDDF` or `frankfurt`   | Destination airport (ICAO code or name)       |
| `plane`       | `beta_plane`            | Aircraft ID from the CNS catalog              |
| `charger`     | `dc_320`                | Charger ID from the CNS catalog               |
| `tripType`    | `one-way`               | `one-way` (default) or `retour`               |
| `theme`       | `light`                 | `light` (default) or `dark`                   |
| `utm_source`  | `quickscan`             | Analytics tag (passed through to click URL)   |

### Airport names

You can pass either an ICAO code (`EHKD`) or a plain name (`den helder`,
`schiphol`, `frankfurt`). The embed resolves names automatically — no need
to look up codes.

### Aircraft & charger IDs

| Aircraft ID       | Name                           |
|-------------------|--------------------------------|
| `pipistrel_velis` | Velis Electro                  |
| `beta_plane`      | Beta Alia CX300                |
| `vaeridion`       | Vaeridion Microliner Max       |
| `vaeridion_light` | Vaeridion Microliner Light     |
| `elysian_e9x`     | Elysian E9X                    |

If omitted, the embed defaults to the Beta Alia CX300.

## What the embed shows

The card adapts based on the parameters you provide:

| You provide                          | The embed shows                                       |
|--------------------------------------|-------------------------------------------------------|
| Nothing                              | European charger network overview                     |
| `origin` only                        | Airport on map + range circle with reachable airports |
| `origin` + `destination`             | Route line + distance and energy stats                |
| `origin` + `destination` + `plane`   | Route + full stats (energy, charge time)              |

## Click-through

Clicking the embed opens the full Charging Network Simulator in a new tab
with the route pre-filled. The user will need to log in if they don't have
an active session.

## Examples

### Network overview (no params)

```html
<iframe src="https://cns.nrg2fly.nl/embed"
        width="100%" height="320" frameborder="0"
        style="border:0; border-radius:12px;">
</iframe>
```

### Single airport with reachable destinations

```html
<iframe src="https://cns.nrg2fly.nl/embed?origin=schiphol"
        width="100%" height="320" frameborder="0"
        style="border:0; border-radius:12px;">
</iframe>
```

### Full route with stats

```html
<iframe src="https://cns.nrg2fly.nl/embed?origin=EHLE&destination=EDDF&plane=beta_plane"
        width="100%" height="320" frameborder="0"
        style="border:0; border-radius:12px;">
</iframe>
```

### Dynamic (set from JavaScript)

```javascript
const iframe = document.querySelector('#cns-embed');
const params = new URLSearchParams({
  origin: userAirport,   // e.g. from a form field
  utm_source: 'quickscan'
});
iframe.src = `https://cns.nrg2fly.nl/embed?${params}`;
```

## Sizing

Recommended: `width="100%"` and `height="320"`. The embed is responsive
horizontally but expects a fixed height. Minimum usable height is around
250px; the stat bar and CTA take ~80px, the rest is map.

## Caching

Responses are cached for 1 hour (`Cache-Control: public, max-age=3600`).
The same parameter set always produces the same card.
