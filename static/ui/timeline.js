/* CNS v2 — ui/timeline.js: drawer header + summary (phase 1); lanes from CNSScheduler land in phase 3. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$;
  function render() {
    const folder = window.CNSDemand ? CNSDemand.loadFolder() : [];
    const R = UI.network ? UI.network.rows() : [];
    $('#drawerSub').textContent = folder.length ? `${R.length} airports · ${folder.length} routes · peak ${UI.fmt.kw(R.reduce((s, a) => s + a.peak, 0))} (sum of airports)` : 'no flights yet';
    $('#gantt').innerHTML = folder.length ? `<div class="empty">Rotation lanes arrive in phase 3. The classic version shows them per airport in the demand calculator.</div>` : `<div class="empty">Add a route to the network to see its charging sessions on the day.</div>`;
    $('#drawer').style.setProperty('--drawer-h', '140px');
    $('#laneSeg').hidden = true; $('#depSw').hidden = true; $('.dep-lbl').hidden = true;
  }
  document.addEventListener('click', e => { if (e.target.closest('#drawerHead') && !e.target.closest('button')) $('#drawer').classList.toggle('open'); });
  UI.timeline = { render };
})();
