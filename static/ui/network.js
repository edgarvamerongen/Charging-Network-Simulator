/* CNS v2 — ui/network.js: Network rail, read-only over the shared folder (phase 1). */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, esc = UI.esc, fmt = UI.fmt;
  const tripLabel = { 'one-way': 'One-way', retour: 'Return', circular: 'Circular', training: 'Training' };
  function rows() {
    if (!window.CNSDemand) return [];
    const aps = CNSDemand.computeAirports(); const cfg = CNSDemand.loadCfg ? CNSDemand.loadCfg() : {};
    return Object.values(aps).map(a => {
      const trips = []; a.contribs.forEach(c => { if (!trips.includes(c.t)) trips.push(c.t); });
      const flights = trips.reduce((s, t) => s + CNSDemand.flightsPerDay(t), 0);
      const full = !!(cfg[a.ident] && cfg[a.ident].fullCharge);
      const kwh = a.contribs.reduce((s, c) => s + (CNSDemand.energyAt(c.t, a.ident, full) || 0) * CNSDemand.flightsPerDay(c.t), 0);
      const sum = (window.CNSScheduler && CNSScheduler.summary) ? CNSScheduler.summary(a.ident) : {};
      return { ident: a.ident, name: a.name, trips, flights, kwh, peak: sum.peakKw || 0, overflow: !!sum.overflow, chargeMin: sum.chargeMin || 0 };
    }).sort((x, y) => y.kwh - x.kwh);
  }
  function render() {
    const R = rows(); const flights = R.reduce((s, a) => s + a.flights, 0) / 2; const kwh = R.reduce((s, a) => s + a.kwh, 0); const peak = R.reduce((s, a) => s + a.peak, 0);
    const folder = CNSDemand.loadFolder(); const rate = (window.CNSSettings && CNSSettings.chargeRate) ? CNSSettings.chargeRate() : 0.6;
    $('#railBody').innerHTML = `
    <div class="ph"><div><h3>Network</h3><div class="sub num">${R.length} airport${R.length === 1 ? '' : 's'} · ${folder.length} route${folder.length === 1 ? '' : 's'}</div></div><div class="tools">${folder.length ? '<button class="lnk" data-act="clear">Clear all</button>' : ''}</div></div>
    ${folder.length ? `<div class="tiles"><div><div class="cap">Airports</div><div class="v num">${R.length}</div></div><div><div class="cap">Routes</div><div class="v num">${folder.length}</div></div><div><div class="cap">Energy</div><div class="v num">${kwh >= 1000 ? (kwh / 1000).toFixed(1) : Math.round(kwh)}<small>${kwh >= 1000 ? 'MWh' : 'kWh'} / day</small></div></div><div><div class="cap">Peak</div><div class="v num">${peak >= 1000 ? (peak / 1000).toFixed(1) : Math.round(peak)}<small>${peak >= 1000 ? 'MW' : 'kW'} · sum</small></div></div></div>
    <div class="ntool"><span class="cap">Show</span><select data-act="filter"><option value="">All airports</option>${R.map(a => `<option value="${a.ident}" ${S.filter === a.ident ? 'selected' : ''}>${a.ident} · ${esc(UI.shortName(a.name))}</option>`).join('')}</select><span class="sp"></span><span class="hint num" style="margin:0">€${fmt.eur(kwh * rate)} / day</span></div>
    ${R.filter(a => !S.filter || a.ident === S.filter).map(a => `<div class="ap ${S.openAp[a.ident] ? 'open' : ''}" data-ap="${a.ident}"><button><span class="id">${a.ident}</span><span class="nm">${esc(UI.shortName(a.name))}<small>${a.trips.length} route${a.trips.length === 1 ? '' : 's'}${a.overflow ? ' · <span style="color:var(--danger)">overflow</span>' : ''}</small></span>
      <span class="st num">${a.flights % 1 ? a.flights.toFixed(1) : a.flights}<small>movements / day</small></span><span class="st num">${a.kwh ? Math.round(a.kwh) : '—'}<small>kWh / day</small></span><span class="st num">${a.peak || '—'}<small>peak kW</small></span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane">${a.trips.map(t => `<div class="fl"><span class="t">${esc(t.originIdent)} → ${esc(t.destIdent)}${t.multiLeg ? ' <span class="mu">via ' + (t.stops || []).map(s => esc(s.ident)).join(', ') + '</span>' : ''}<small>${esc(UI.planeShort(t.planeName))} · ${tripLabel[t.tripType] || t.tripType}</small></span><span class="mu num">${t.freqN} / ${t.freqUnit}</span><span class="mu num">${Math.round(t.rechargeEnergy || t.totalRechargeKwh || 0)} kWh</span><button class="rm" data-act="rm" data-id="${esc(t.id)}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button></div>`).join('')}
      <div class="hint" style="padding-top:8px">Chargers, charge target and the rotation lanes land in phase 3 — edit them in the classic version for now.</div></div></div>`).join('')}`
    : `<div class="empty"><b>No routes in the network yet</b>Plan a route and add it — each flight contributes charging demand to its departure and arrival airports.</div>`}`;
    $('#railFoot').innerHTML = folder.length ? `<div class="btns"><button class="btn p" data-act="build">Share build</button><button class="btn" data-act="xlsx">XLSX</button></div>` : '';
    $('#netCount').textContent = folder.length || '';
  }
  function remove(id) { CNSDemand.saveFolder(CNSDemand.loadFolder().filter(t => t.id !== id)); if (window.CNSScheduler && CNSScheduler.runGlobal) CNSScheduler.runGlobal(); UI.map.drawNet(); UI.render(); }
  document.addEventListener('click', e => {
    if (S.mode !== 'network') return;
    const t = e.target.closest('[data-act],[data-ap]>button'); if (!t) return;
    const ap = t.closest('[data-ap]'); if (ap && !t.dataset.act) { S.openAp[ap.dataset.ap] = !S.openAp[ap.dataset.ap]; ap.classList.toggle('open'); return; }
    switch (t.dataset.act) {
      case 'rm': remove(t.dataset.id); break;
      case 'clear': if (confirm('Remove all routes from the network?')) { CNSDemand.saveFolder([]); if (window.CNSScheduler && CNSScheduler.runGlobal) CNSScheduler.runGlobal(); UI.map.drawNet(); UI.render(); } break;
      case 'build': if (window.CNSBuildShare && CNSBuildShare.copyBuildLink) CNSBuildShare.copyBuildLink({}); break;
      case 'xlsx': if (window.CNSSpreadsheet) CNSSpreadsheet.export(t); break;
    }
  });
  document.addEventListener('change', e => { if (e.target.dataset.act === 'filter') { S.filter = e.target.value; UI.render(); UI.map.drawNet(); UI.map.fitNet(); } });
  UI.network = { render, remove, rows };
})();
