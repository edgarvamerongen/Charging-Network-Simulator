/* CNS v2 — ui/report.js: the PDF advisory report — pick an airport, generate through CNSReport. */
(function () {
  const UI = window.CNSUI, $ = UI.$, esc = UI.esc;
  function pick() {
    const R = UI.network ? UI.network.rows() : [];
    if (!R.length) { UI.toast('Add a route to the network first — the report is per airport.'); return; }
    UI.modal.open(`<div class="mh"><h3>Advisory report</h3><button class="tb icon" data-modal="close"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div class="mb"><div class="hint" style="margin-bottom:8px">One airport per report. Pick the site the advice is for.</div>
      ${R.map((a, i) => `<label class="fl rp" style="grid-template-columns:18px auto 1fr auto;cursor:pointer"><input type="radio" name="rp" value="${a.ident}" ${i === 0 ? 'checked' : ''}><b>${a.ident}</b><span>${esc(UI.shortName(a.name))}</span><span class="mu num">${a.flights % 1 ? a.flights.toFixed(1) : a.flights} flights / day · ${UI.fmt.kw(a.peak)} peak</span></label>`).join('')}
      <div class="err" id="rpError" hidden></div></div>
      <div class="btns"><button class="btn p" data-act="rpGo">Generate PDF</button><button class="btn" data-modal="close">Cancel</button></div>`);
  }
  /** The engine's CNSReport.generate() catches its own failure and alert()s instead of throwing (static/report.js:394,
      read-only), so awaiting it tells us nothing about the outcome. Drive the request here — the engine's buildPayload()
      still owns the report content — and toast only on a PDF we actually received. */
  async function generate(focusIdent) {
    if (!window.CNSReport || !CNSReport.buildPayload) throw new Error('The report module did not load.');
    if (window.CNSDemand && !CNSDemand.loadFolder().length) throw new Error('Add at least one flight to the network before generating a report.');
    const resp = await fetch('/api/report.pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CNSReport.buildPayload(focusIdent)) });
    if (!resp.ok) { let msg = `Server returned ${resp.status}`; try { msg = (await resp.json()).error || msg; } catch (e) {} throw new Error(msg); }
    const blob = await resp.blob();
    if (!blob || !blob.size) throw new Error('The server returned an empty PDF.');
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `nrg2fly-charging-plan-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return blob.size;
  }
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act=rpGo]'); if (!t) return;
    const sel = ($('input[name=rp]:checked') || {}).value; if (!sel || !window.CNSReport) return;
    const err = $('#rpError'); if (err) { err.hidden = true; err.textContent = ''; }
    t.textContent = 'Generating…'; t.classList.add('busy');
    try { await generate(sel); UI.modal.close(); UI.toast('Report downloaded'); }
    catch (ex) {
      // A failure keeps the dialog open with the reason — never the success toast.
      t.classList.remove('busy'); t.textContent = 'Generate PDF';
      const msg = 'Report failed: ' + ((ex && ex.message) || ex);
      if (err) { err.textContent = msg; err.hidden = false; }
      UI.toast(msg);
    }
  });
  UI.report = { pick, generate };
})();
