/* CNS v2 — ui/soc.js: battery-through-the-trip series. Pure. Each leg's total is the engine's
   energyKwh; inside the leg the draw is three stages (climb / cruise / descent) that sum to it. */
(function () {
  const DESC = 0.20, PHASE = 0.60;   // display knobs: descent draw as a fraction of cruise; phase length as a fraction of min(d, d_sat)
  function phases(leg, climb, training) {
    const dk = leg.distKm, E = leg.energyKwh;
    if (!climb || !climb.applies || training || !(dk > 0)) return [{ t: 'cruise', km: dk, e: E }];
    const ph = Math.min(PHASE * Math.min(dk, climb.dSatKm), dk / 2);
    const eDesc = DESC * climb.cruisePerKm * ph, eCr = climb.cruisePerKm * Math.max(0, dk - 2 * ph), eCl = Math.max(0, E - eCr - eDesc);
    return [{ t: 'climb', km: ph, e: eCl }, { t: 'cruise', km: Math.max(0, dk - 2 * ph), e: eCr }, { t: 'descent', km: ph, e: E - eCl - eCr }].filter(s => s.km > 0);
  }
  // batteryKwh must be a REAL battery: a non-charging hybrid has none, and dividing by a
  // stand-in 1 kWh draws a chart that reads 0 % end to end. Callers gate on battery_kwh > 0.
  function series(legs, charges, batteryKwh, climb, opts) {
    opts = opts || {}; const B = (+batteryKwh > 0) ? +batteryKwh : 1; const total = legs.reduce((s, l) => s + l.distKm, 0) || 1;
    const segs = [], zones = [], pts = [];
    let x = 0, soc = (legs[0] && legs[0].socStartFrac != null ? legs[0].socStartFrac : 1) * 100;
    pts.push({ x: 0, soc, id: legs[0] && legs[0].fromIdent || '' });
    legs.forEach((l, i) => {
      let x0 = x, s0 = soc;
      phases(l, climb, opts.training).forEach(p => { const x1 = x0 + p.km / total * 100, s1 = s0 - p.e / B * 100; segs.push({ t: 'fly', x0, y0: s0, x1, y1: s1 }); if (p.t !== 'cruise') zones.push({ t: p.t, x0, x1 }); x0 = x1; s0 = s1; });
      soc -= l.energyKwh / B * 100; x += l.distKm / total * 100;
      pts.push({ x, soc, id: l.toIdent || '' });
      // Training tops up back AT the origin, so the engine tags that charge atIndex 0
      // (static/flight-model.js:190) — without this the pattern chart never draws its recharge.
      const q = charges.find(c => c.atIndex === i + 1 || (opts.training && c.atIndex === 0));
      if (q && q.energyKwh > 0.05) { const s2 = q.departSocFrac != null ? q.departSocFrac * 100 : Math.min(100, soc + q.energyKwh / B * 100); segs.push({ t: 'chg', x0: x, y0: soc, x1: x, y1: s2, id: q.ident, min: q.chargeMin }); soc = s2; }
    });
    return { segs, zones, pts, low: pts.reduce((m, p) => Math.min(m, p.soc), 100) };
  }
  window.CNSUI = window.CNSUI || {}; window.CNSUI.soc = { series, phases };
})();
