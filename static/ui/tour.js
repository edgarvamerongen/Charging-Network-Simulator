/* CNS v2 — ui/tour.js: the welcome dialog and the guided tour (Driver.js) against v2 anchors.
   CNSUI.tour.check() lists every step's anchor and whether it resolves, like CNSTour.check(). */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$;
  const HIDE = 'cns_welcome_hide';
  const ensureResult = async () => { if (!S.result) { if (S.mode !== 'plan') UI.setMode('plan'); await UI.plan.simulate(); } };
  const STEPS = () => [
    { title: 'Your simulator, in two modes', desc: 'Plan a route on the left, read the result, add it to the network. Network mode turns the flights into charging demand per airport and a day timeline.' },
    { el: '#modeSeg', title: 'Plan | Network', desc: 'Switch between planning one route and sizing the whole network. The count shows how many routes the network holds.' },
    { el: '.acsec', title: 'Aircraft', desc: 'Status, VFR or IFR, and the arrows step through the catalog. The filter button narrows by type, propulsion or status; "Edit for this flight" overrides the available range.' },
    { el: '[data-ac=origin]', title: 'Departure', desc: 'Type an ICAO code, IATA code or a name. Clicking an airport on the map also sets it.' },
    { el: '[data-ac=dest]', title: 'Destination', desc: 'Same for the destination. Add stops yourself with "+ Add stop", or let the planner suggest them.' },
    { el: '.route', title: 'Suggested route', desc: 'When the direct leg exceeds the usable reach, the planner inserts charging stops. Remove one to plan around it, change the size preference, or retry.', before: () => { S.dest = UI.byId()['EDDM'] || S.dest; UI.plan.onFormChange(true); } },
    { el: '[data-seg=trip]', title: 'Trip type', desc: 'One-way, return, circular via stops, or training circuits at the departure airfield.' },
    { el: '.freq', title: 'Frequency', desc: 'Flights per day or per week. This scales the daily energy and drives how many rotations the timeline schedules.' },
    { el: '.chg.on', title: 'Charger', desc: 'The charger this flight plans with. Custom chargers are shared with everyone on this server.' },
    { el: '[data-act=simulate]', title: 'Simulate', desc: 'Runs the flight engine: energy per leg with the climb model, charge times at the effective charger power, cost per day.' },
    { el: '#map', title: 'Route on the map', desc: 'Coral is the live route, with per-leg distance, time and energy. Orange teardrops are NRG2FLY charging sites. Map menu: basemaps, airfield sizes, alternates, reach graph.', before: ensureResult },
    { el: '.stats', title: 'The result', desc: 'Energy, block time and charging time per flight, then cost per day at the tariff from Model settings.' },
    { el: '.soc', title: 'Battery through the trip', desc: 'Navy is flying, coral is charging, the dashed line is the reserve. Climb and descent are shaded so the takeoff drain is visible.' },
    { el: '[data-act=add]', title: 'Add to network', desc: 'Each added flight contributes charging demand to its departure and arrival airports. The network is shared with the classic version.' },
    { el: '#modeSeg [data-mode=network]', title: 'Network mode', desc: 'Per airport: flights per day, energy, peak load. Expand a row for chargers, charge target and every flight.', before: async () => { await ensureResult(); if (!CNSDemand.loadFolder().length) UI.plan.addToNetwork(); UI.setMode('network'); } },
    { el: '.ap', title: 'An airport', desc: 'Change the chargers installed, set a charge target, edit or remove flights, isolate the airport, replay its day on the map.', before: () => { const first = document.querySelector('.ap'); if (first && !first.classList.contains('open')) first.querySelector('button').click(); } },
    { el: '#drawer', title: 'Demand timeline', desc: 'The day as the scheduler runs it: charging sessions per aircraft, waits for a free charger, and the concurrent load. Drag a rotation to move its take-off. Fleet lanes show how many aircraft the schedule needs.', before: () => { $('#drawer').classList.add('open'); UI.timeline.render(); } },
    { el: '#expBtn', title: 'Export', desc: 'The advisory PDF for one airport, the demand workbook, and share links for a route or the whole build.' },
    { el: '#kbdHint', title: 'Command palette', desc: '⌘K anywhere: airports, aircraft, chargers and every action in one box.' },
    { title: 'Ready to plan a network', desc: 'Reopen this tour from the Tour button any time. Feedback goes to the NRG2FLY team.' },
  ];
  function driverLib() { return window.driver && window.driver.js && window.driver.js.driver; }
  async function start() {
    const D = driverLib(); if (!D) { UI.toast('The tour library did not load.'); return; }
    if (S.mode !== 'plan') UI.setMode('plan'); if (S.rail !== 'form') { S.rail = 'form'; UI.render(); }
    const steps = STEPS().map(s => ({ element: s.el, popover: { title: s.title, description: s.desc }, onHighlightStarted: s.before ? async () => { await s.before(); } : undefined }));
    const d = D({ showProgress: true, allowClose: true, popoverClass: 'cns-tour', nextBtnText: 'Next', prevBtnText: 'Back', doneBtnText: 'Done', steps }); UI.tour._d = d; d.drive();
    try { localStorage.setItem('cns_tour_done', 'true'); } catch (e) {}
  }
  function check() { const rows = STEPS().map((s, i) => ({ step: i + 1, anchor: s.el || '(centered)', title: s.title, ok: !s.el || !!document.querySelector(s.el) })); console.table(rows); return rows; }
  function welcome() {
    UI.modal.open(`<div class="mb" style="padding:22px 24px"><img src="/pics/logos/NRG2fly_logo_kleur_wide.png" alt="NRG2FLY" style="height:26px;display:block;margin-bottom:14px"><h3 style="font-size:18px;font-weight:600;letter-spacing:-.01em">Charging Network Simulator</h3>
      <p class="hint" style="font-size:13px;margin:8px 0 14px;line-height:1.5">Plan electric-aviation routes, size the charging stops, and model the energy demand of a fleet across Europe. Every figure comes from the same engine the advisory reports use.</p>
      <div class="hint" style="line-height:1.7"><b style="color:var(--ink)">Plan</b> a route on the left · <b style="color:var(--ink)">Simulate</b> for energy, time and cost · <b style="color:var(--ink)">Add</b> it to the network · <b style="color:var(--ink)">Network</b> mode sizes chargers per airport and shows the day.</div>
      <label class="hint" style="display:flex;gap:8px;align-items:center;margin-top:16px"><input type="checkbox" id="welcomeHide"> Don't show this again</label></div>
      <div class="btns"><button class="btn p" data-act="tourStart">Take the tour</button><button class="btn" data-modal="close">Start planning</button></div>`);
  }
  document.addEventListener('click', e => {
    if (e.target.closest('#tourBtn')) { start(); return; }
    if (e.target.closest('[data-act=tourStart]')) { UI.modal.close(); start(); return; }
    if (e.target.closest('#modal') && e.target.id === 'welcomeHide') { try { localStorage.setItem(HIDE, JSON.stringify(e.target.checked)); } catch (err) {} }
  });
  function maybeWelcome() { let hide = false; try { hide = JSON.parse(localStorage.getItem(HIDE) || 'false'); } catch (e) {} if (!hide && !UI.D.shareState && !location.hash) setTimeout(welcome, 400); }
  UI.tour = { start, check, welcome, maybeWelcome, STEPS };
})();
