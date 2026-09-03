/* CNS v2 — ui/report.js: the PDF advisory report — pick an airport, generate through CNSReport. */
(function () {
  const UI = window.CNSUI, $ = UI.$, esc = UI.esc;
  function pick() {
    const R = UI.network ? UI.network.rows() : [];
    if (!R.length) { UI.toast('Add a route to the network first — the report is per airport.'); return; }
    UI.modal.open(`<div class="mh"><h3>Advisory report</h3><button class="tb icon" data-modal="close"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div class="mb"><div class="hint" style="margin-bottom:8px">One airport per report. Pick the site the advice is for.</div>
      ${R.map((a, i) => `<label class="fl rp" style="grid-template-columns:18px auto 1fr auto;cursor:pointer"><input type="radio" name="rp" value="${a.ident}" ${i === 0 ? 'checked' : ''}><b>${a.ident}</b><span>${esc(UI.shortName(a.name))}</span><span class="mu num">${a.flights % 1 ? a.flights.toFixed(1) : a.flights} flights / day · ${UI.fmt.kw(a.peak)} peak</span></label>`).join('')}</div>
      <div class="btns"><button class="btn p" data-act="rpGo">Generate PDF</button><button class="btn" data-modal="close">Cancel</button></div>`);
  }
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act=rpGo]'); if (!t) return;
    const sel = ($('input[name=rp]:checked') || {}).value; if (!sel || !window.CNSReport) return;
    t.textContent = 'Generating…'; t.classList.add('busy');
    try { await CNSReport.generate(t, sel); UI.modal.close(); UI.toast('Report downloaded'); }
    catch (err) { t.classList.remove('busy'); t.textContent = 'Generate PDF'; UI.toast('Report failed: ' + (err && err.message || err)); }
  });
  UI.report = { pick };
})();
