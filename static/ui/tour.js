/* CNS v2 — ui/tour.js: the welcome dialog and the guided tour (Driver.js) against v2 anchors.
   CNSUI.tour.check() lists every step's anchor and whether it resolves, like CNSTour.check(). */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$;
  const HIDE = 'cns_welcome_hide';
  // The result on screen: simulate when there is none; the classic-style rail shows it only in its result view.
  const ensureResult = async () => { if (S.mode !== 'plan') UI.setMode('plan');
    if (!S.origin || (S.trip !== 'training' && !S.dest)) { const by = UI.byId(); S.origin = by[UI.SEED.origin] || S.origin; S.dest = by[UI.SEED.dest] || S.dest; UI.plan.onFormChange(true); }   // an empty form borrows the demo route
    if (!S.result) await UI.plan.simulate(); else if (S.rail !== 'result') { S.rail = 'result'; UI.render(); } };
  // Five steps on a real network (audit P8): plan, result, add, network, the day. The network steps run on
  // the operator's own network, or on the Hub base scenario when there is none yet; empty states teach
  // the rest. `next` / `prev` run before the tour moves, so every step's element exists when it shows.
  const ensureNetwork = async () => { await ensureResult(); if (!CNSDemand.loadFolder().length) await UI.network.loadScenario('hub'); if (S.mode !== 'network') UI.setMode('network'); };
  const openDay = () => { $('#drawer').classList.add('open'); UI.timeline.render(); };
  const STEPS = () => [
    { el: '#rail', title: 'Plan a route', desc: 'Pick an aircraft, a departure and a destination. Where a leg is longer than the usable reach the planner adds charging stops; remove one to plan around it. The search field (⌘K) finds airports, aircraft and every action.', next: ensureResult },
    { el: '.stats', title: 'The result', desc: 'Energy, block time, charging time and revenue for one flight, from the same engine as the advisory report. Calculation shows the chain behind each figure.' },
    { el: '[data-act=add]', title: 'Add to network', desc: 'Each flight adds charging demand at the airports it charges at. The network is shared with the classic version.', next: ensureNetwork },
    { el: '#rail', title: 'Network', desc: 'Per airport: flights, energy, peak load and revenue. Open an airport to size its chargers and see how long they delay the flights.', next: openDay, prev: () => UI.setMode('plan') },
    { el: '#drawer', title: 'The day', desc: 'Take-offs are placed so aircraft do not queue for a charger; a wait shows where the day is too full. Drag a rotation to fix its take-off, double-click to release it.' },
  ];
  function driverLib() { return window.driver && window.driver.js && window.driver.js.driver; }
  async function start() {
    const D = driverLib(); if (!D) { UI.toast('The tour library did not load.'); return; }
    if (S.mode !== 'plan') UI.setMode('plan'); if (S.rail !== 'form') { S.rail = 'form'; UI.render(); }
    let d = null;
    const steps = STEPS().map(s => { const pop = { title: s.title, description: s.desc };   // a hook key only where a step has one: Driver.js skips its own Next when the key is set
      if (s.next) pop.onNextClick = async () => { await s.next(); d.moveNext(); };
      if (s.prev) pop.onPrevClick = async () => { await s.prev(); d.movePrevious(); };
      return { element: s.el, popover: pop }; });
    d = D({ showProgress: true, allowClose: true, popoverClass: 'cns-tour', nextBtnText: 'Next', prevBtnText: 'Back', doneBtnText: 'Done', steps }); UI.tour._d = d; d.drive();
    try { CNSState.setJSON('cns_tour_done', true); } catch (e) {}
  }
  function check() { const rows = STEPS().map((s, i) => ({ step: i + 1, anchor: s.el || '(centered)', title: s.title, ok: !s.el || !!document.querySelector(s.el) })); console.table(rows); return rows; }
  function welcome() {
    UI.modal.open(`<div class="mb" style="padding:22px 24px"><img src="/pics/logos/NRG2fly_logo_kleur_wide.png" alt="NRG2FLY" style="height:26px;display:block;margin-bottom:14px"><h3 style="font-size:18px;font-weight:600;letter-spacing:-.01em">Charging Network Simulator</h3>
      <p class="hint" style="font-size:13px;margin:8px 0 14px;line-height:1.5">Plan electric-aviation routes, size the charging stops, and model the energy demand of a fleet, anywhere in the world. Every figure comes from the same engine the advisory reports use.</p>
      <div class="hint" style="line-height:1.6">The quickest way in is a real network: the <b style="color:var(--ink)">Hub base</b> scenario flies 8 return routes, 18 flights a day, from Lelystad. Read its airports, its chargers and its day, then plan your own.</div>
      <label class="hint" style="display:flex;gap:8px;align-items:center;margin-top:16px"><input type="checkbox" id="welcomeHide"> Don't show this again</label></div>
      <div class="btns"><button class="btn p" data-act="welcomeHub">Open the Hub base scenario</button><button class="btn" data-act="tourStart">Take the tour</button><span style="flex:1"></span><button class="btn" data-modal="close">Start planning</button></div>`);
  }
  document.addEventListener('click', e => {
    if (e.target.closest('#tourBtn')) { start(); return; }
    if (e.target.closest('[data-act=tourStart]')) { UI.modal.close(); start(); return; }
    if (e.target.closest('[data-act=welcomeHub]')) { UI.modal.close(); UI.network.loadScenario('hub'); return; }
    if (e.target.closest('#modal') && e.target.id === 'welcomeHide') { try { CNSState.setJSON(HIDE, e.target.checked); } catch (err) {} }
  });
  function maybeWelcome() { let hide = false; try { hide = !!CNSState.getJSON(HIDE, false); } catch (e) {} if (!hide && !UI.D.shareState && !location.hash) setTimeout(welcome, 400); }
  UI.tour = { start, check, welcome, maybeWelcome, STEPS };
})();
