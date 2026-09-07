/* CNS v2 — ui/settings.js: the Model settings dialog over CNSSettings (same keys, same storage —
   both shells read the same values), plus the active-flags badge on the topbar gear. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc;
  const ST = () => window.CNSSettings;
  const pct = v => Math.round(v * 100);
  const FIELDS = [
    { key: 'landingReserve', title: 'Landing reserve', desc: 'Minimum state of charge on landing. Reduces the usable range of every leg.', sliders: [{ f: 'minLandingSoc', label: 'Reserve', min: 5, max: 50, step: 5, to: v => v / 100, from: v => pct(v), unit: '%' }] },
    { key: 'alternateReserve', title: 'Alternate reserve', desc: 'Energy to divert to the nearest suitable airport after a missed approach. Uses each airport\'s pre-computed alternate or your manual divert.' },
    { key: 'climbModel', title: 'Climb overhead', desc: 'Net climb-minus-descent energy per leg, ramping to full by a fraction of the catalog range (CLIMB_ENERGY_MODEL.md).', sliders: [{ f: 'overheadPct', label: 'Overhead', min: 0, max: 20, step: 1, to: v => v / 100, from: v => pct(v), unit: '% of battery', show: v => v > 0 ? v + ' % of battery' : '10 % of battery (model default)' }, { f: 'satFrac', label: 'Saturates at', min: 5, max: 30, step: 1, to: v => v / 100, from: v => pct(v), unit: '% of range' }], example: true },
    { key: 'sidStarPadding', title: 'SID / STAR padding', desc: 'Fixed kilometres added to each leg for terminal procedures. Not applied to VFR aircraft.', sliders: [{ f: 'km', label: 'Per leg', min: 5, max: 50, step: 5, to: v => v, from: v => v, unit: 'km' }] },
    { key: 'routingPadding', title: 'Airways padding', desc: 'Multiplier on great-circle distance for airways routing. Off by default; SID / STAR padding is the preferred model.', sliders: [{ f: 'factor', label: 'Factor', min: 100, max: 125, step: 1, to: v => v / 100, from: v => Math.round(v * 100), unit: '%', show: v => (v / 100).toFixed(2) + '×' }] },
    { key: 'chargeTaper', title: 'Charge taper', desc: 'Real charging curve: full power up to the knee, then an exponential roll-off toward the floor.', sliders: [{ f: 'threshold', label: 'Knee', min: 50, max: 95, step: 5, to: v => v / 100, from: v => pct(v), unit: '% SoC' }, { f: 'taperPower', label: 'Floor', min: 5, max: 90, step: 5, to: v => v / 100, from: v => pct(v), unit: '% of peak' }] },
    { key: 'chargeTarget', title: 'Charge target', desc: 'Default state of charge every aircraft charges to. Per-airport targets in Network mode override it.', sliders: [{ f: 'value', label: 'Target', min: 50, max: 100, step: 5, to: v => v / 100, from: v => pct(v), unit: '%' }] },
    { key: 'chargerEfficiency', title: 'Charger efficiency', desc: 'Grid-to-cell efficiency. Inflates grid energy and peak load versus what the aircraft receives.', sliders: [{ f: 'value', label: 'Efficiency', min: 50, max: 100, step: 1, to: v => v / 100, from: v => pct(v), unit: '%' }] },
  ];
  function example() {
    const p = UI.plane(); if (!p || !window.CNSFlight || !CNSFlight.climbParams) return '';
    const c = CNSFlight.climbParams(p); return c.applies ? `${esc(UI.planeShort(p.name))}: +${Math.round(c.eMaxKwh)} kWh per leg, full from ${Math.round(c.dSatKm)} km` : `${esc(UI.planeShort(p.name))}: not applied (powered-lift or no battery)`;
  }
  function body() {
    const s = ST().loadAll(); const rate = (s.chargeRate || {}).value ?? 0.6;
    return `<div class="mh"><h3>Model settings</h3><button class="tb icon" data-modal="close"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div class="mb ms">
        ${FIELDS.map(F => { const v = s[F.key] || {}; return `<div class="msr ${v.enabled ? '' : 'off'}"><div class="row" style="align-items:flex-start;gap:10px"><button class="sw ${v.enabled ? 'on' : ''}" data-ms="toggle" data-key="${F.key}" title="${v.enabled ? 'On' : 'Off'}"></button><div style="flex:1"><div class="name" style="font-size:13px">${F.title}</div><div class="hint" style="margin-top:2px">${F.desc}</div>
          ${(F.sliders || []).map(sl => `<div class="msl"><span class="cap">${sl.label}</span><input type="range" min="${sl.min}" max="${sl.max}" step="${sl.step}" value="${sl.from(v[sl.f])}" data-ms="slider" data-key="${F.key}" data-f="${sl.f}" ${v.enabled ? '' : 'disabled'}><b class="num" data-ms-val="${F.key}.${sl.f}">${sl.show ? sl.show(sl.from(v[sl.f])) : sl.from(v[sl.f]) + ' ' + sl.unit}</b></div>`).join('')}
          ${F.example ? `<div class="hint num" data-ms="example">${example()}</div>` : ''}</div></div></div>`; }).join('')}
        <div class="msr"><div class="row" style="align-items:flex-start;gap:10px"><span style="width:26px"></span><div style="flex:1"><div class="name" style="font-size:13px">Charge tariff</div><div class="hint" style="margin-top:2px">Price per charged kWh for the revenue figures.</div>
          <div class="msl"><span class="cap">Tariff</span><input type="range" min="0" max="200" step="5" value="${Math.round(rate * 100)}" data-ms="rate"><b class="num" data-ms-val="rate">€${(+rate).toFixed(2)} / kWh</b></div></div></div></div>
        <div class="hint" style="margin-top:12px">Applies to every calculation and to both the classic and the v2 shell.</div></div>
      <div class="btns"><button class="btn" data-ms="reset">Reset to defaults</button><span style="flex:1"></span><button class="btn p" data-modal="close">Done</button></div>`;
  }
  function open() { UI.modal.open(body()); }
  function refresh() { if (!UI.modal.isOpen() || !$('#modalBox .ms')) return; const box = $('#modalBox'); const top = box.scrollTop; box.innerHTML = body(); box.scrollTop = top; }
  function badge() { const b = $('#setBadge'); if (!b || !ST()) return; const f = ST().activeFlags(); const n = Object.entries(f).filter(([k, v]) => k !== 'anyOn' && v).length; b.textContent = n; b.hidden = !n; }
  document.addEventListener('click', e => {
    if (e.target.closest('#setBtn')) { open(); return; }   // must precede the [data-ms] guard — the gear is not a [data-ms] element
    const t = e.target.closest('[data-ms]'); if (!t) return;
    if (t.dataset.ms === 'toggle') { const cur = ST().loadAll()[t.dataset.key] || {}; ST().save({ [t.dataset.key]: { enabled: !cur.enabled } }); refresh(); badge(); }
    if (t.dataset.ms === 'reset') { if (confirm('Reset every model setting to its default?')) { ST().reset(); refresh(); badge(); } }
  });
  document.addEventListener('input', e => { const t = e.target; if (!t.dataset || !t.dataset.ms) return;
    if (t.dataset.ms === 'slider') { const F = FIELDS.find(f => f.key === t.dataset.key); const sl = F.sliders.find(x => x.f === t.dataset.f); const lbl = $(`[data-ms-val="${t.dataset.key}.${t.dataset.f}"]`); if (lbl) lbl.textContent = sl.show ? sl.show(+t.value) : t.value + ' ' + sl.unit; }
    if (t.dataset.ms === 'rate') { const lbl = $('[data-ms-val=rate]'); if (lbl) lbl.textContent = '€' + (+t.value / 100).toFixed(2) + ' / kWh'; } });
  document.addEventListener('change', e => { const t = e.target; if (!t.dataset || !t.dataset.ms) return;
    if (t.dataset.ms === 'slider') { const F = FIELDS.find(f => f.key === t.dataset.key); const sl = F.sliders.find(x => x.f === t.dataset.f); ST().save({ [t.dataset.key]: { [sl.f]: sl.to(+t.value) } }); const ex = $('[data-ms=example]'); if (ex) ex.textContent = example().replace(/<[^>]+>/g, ''); }
    if (t.dataset.ms === 'rate') ST().save({ chargeRate: { value: +t.value / 100 } }); });
  if (ST() && ST().subscribe) ST().subscribe(badge);
  document.addEventListener('DOMContentLoaded', badge);
  UI.settings = { open, badge, FIELDS };
})();
