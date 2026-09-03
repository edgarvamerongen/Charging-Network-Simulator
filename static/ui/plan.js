/* CNS v2 — ui/plan.js: the Plan rail (form → simulate → result). Numbers come from CNSFlight. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc, fmt = UI.fmt;
  const tripLabel = { 'one-way': 'One-way', retour: 'Return', circular: 'Circular', training: 'Training' };
  const tripHint = { 'one-way': 'A to B · charge to full at the destination', retour: 'A to B and back · charge at both ends', circular: 'A → stops → A · needs at least one stop', training: 'Circuits at the departure airport' };
  const hav = (a, b) => { const R = 6371, dL = (b[0] - a[0]) * Math.PI / 180, dN = (b[1] - a[1]) * Math.PI / 180, x = Math.sin(dL / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dN / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const usableKm = p => { const f = (window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7; return (window.CNSFlight && CNSFlight.maxFlownLegKm) ? Math.round(CNSFlight.maxFlownLegKm(p)) : Math.round(p.range_km * f); };
  const directKm = () => { const c = UI.chain(); let d = 0; for (let i = 0; i < c.length - 1; i++) d += hav(UI.ll(c[i]), UI.ll(c[i + 1])); return d; };
  const longestLeg = () => { const c = UI.chain(); let m = 0; for (let i = 0; i < c.length - 1; i++) m = Math.max(m, hav(UI.ll(c[i]), UI.ll(c[i + 1]))); return m; };
  const kwLabel = c => c.power_kw >= 1000 ? (c.power_kw / 1000) + ' MW' : c.power_kw + ' kW';
  const cName = c => c.name.replace(/\s*\d+(\.\d+)?\s*(k|M)W$/, '');

  function acHtml(list) { return list.map(a => `<button data-id="${esc(a.ident)}"><span class="id">${esc(a.ident)}</span><span class="nm">${esc(a.name)}<small>${esc(a.municipality || '')}</small></span><span class="ty">${esc((a.type || '').split('_')[0])}</span></button>`).join(''); }
  function bindAc(input, box, onPick) {
    input.addEventListener('input', () => { const l = UI.search(input.value); box.innerHTML = acHtml(l); box.classList.toggle('open', l.length > 0); });
    input.addEventListener('focus', () => { if (box.innerHTML) box.classList.add('open'); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') box.classList.remove('open'); if (e.key === 'Enter') { const b = $('button', box); if (b) { b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); e.preventDefault(); } } });
    box.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); onPick(UI.byId()[b.dataset.id]); box.classList.remove('open'); });
    document.addEventListener('mousedown', e => { if (!box.contains(e.target) && e.target !== input) box.classList.remove('open'); });
  }

  function renderForm() {
    const p = UI.plane(), ch = UI.charger(); const c = UI.chain(); const d = directKm(); const reach = usableKm(p); const fits = longestLeg() <= reach;
    const stopsHtml = S.stops.map((s, i) => `<div class="fld wp" data-stop="${i}"><input placeholder="Add a charging stop…" value="${esc(s ? s.name : '')}" data-ac="stop${i}"><button class="x" data-act="rmStop" data-i="${i}" title="Remove stop"><svg class="ic"><use href="#i-x"/></svg></button><span class="icao">${esc(s ? s.ident : '')}</span><div class="ac" id="ac-stop${i}"></div></div>`).join('');
    const chList = S.allChargers ? UI.CHARGERS.slice().sort((a, b) => b.power_kw - a.power_kw) : [ch, ...UI.CHARGERS.filter(x => x.id !== ch.id).sort((a, b) => Math.abs(a.power_kw - ch.power_kw) - Math.abs(b.power_kw - ch.power_kw)).slice(0, 2)].sort((a, b) => b.power_kw - a.power_kw);
    const pickHtml = S.picking ? `<div class="pick">${UI.PLANES.map(x => `<button data-act="plane" data-id="${x.id}" class="${x.id === S.planeId ? 'on' : ''}"><img src="/pics/${esc(x.image || '')}" onerror="this.onerror=null;this.src='/pics/plane_svgs/${esc(x.svg || 'beta.svg')}'" alt=""><span><span class="n">${esc(x.name)}</span><br><span class="m">${esc(x.oem || '')} · ${x.seats} seats · ${x.battery_kwh ? x.battery_kwh + ' kWh' : 'no battery'} · ${esc(x.status || '')}</span></span><span class="r num">${x.range_km} km<small>${esc(x.regime || '')}${x.max_charge_kw ? ' · ' + x.max_charge_kw + ' kW max' : ''}</small></span></button>`).join('')}</div>` : '';
    $('#railBody').innerHTML = `
    <div class="ph"><h3>Create a route</h3><div class="tools"><span class="hint" style="margin:0">${esc(p.regime || '')}${p.range_incl_reserves ? ' · range incl. reserves' : ''}</span></div></div>
    <div class="sec"><div class="lbl"><span class="cap">Aircraft</span><button class="lnk" data-act="pick">${S.picking ? 'Close' : 'Change'}</button></div>${pickHtml}
      <div class="row" style="${S.picking ? 'margin-top:10px' : ''}"><img class="thumb" src="/pics/${esc(p.image || '')}" onerror="this.onerror=null;this.src='/pics/plane_svgs/${esc(p.svg || 'beta.svg')}'" alt=""><div><div class="name">${esc(p.name)}</div><div class="meta">${esc(p.oem || '')} · ${p.seats} seats · ${p.battery_kwh} kWh · ${p.range_km} km · ${esc(p.regime || '')}</div></div></div>
      <div class="bar"><i class="${fits ? '' : 'over'}" style="width:${Math.min(100, Math.round(reach / p.range_km * 100))}%"></i></div>
      <div class="meta num">Usable reach ${fmt.dist(reach)} of ${fmt.dist(p.range_km)} · ${p.speed_kmh} km/h</div></div>
    <div class="sec"><div class="lbl"><span class="cap">Route</span><button class="lnk" data-act="addStop">+ Add stop</button></div>
      <div class="fld"><input placeholder="Departure airport" value="${esc(S.origin ? S.origin.name : '')}" data-ac="origin"><span class="icao">${esc(S.origin ? S.origin.ident : '')}</span><div class="ac" id="ac-origin"></div></div>
      ${stopsHtml}
      ${S.trip === 'training' ? '' : `<div class="fld"><input placeholder="Destination airport" value="${esc(S.dest ? S.dest.name : '')}" data-ac="dest"><span class="icao">${esc(S.dest ? S.dest.ident : '')}</span><div class="ac" id="ac-dest"></div></div>`}
      ${c.length >= 2 ? `<div class="route"><div class="rh ${fits ? '' : 'bad'}"><span><b>${c.length > 2 ? (c.length - 1) + ' legs' : 'Direct'}</b> · <span class="num">${fmt.dist(d)}</span></span><span>${fits ? 'fits the usable reach' : 'longest leg exceeds reach'}</span></div>
        ${c.map((a, i) => `<div class="stop"><span class="n num">${String(i + 1).padStart(2, '0')}</span><span>${esc(a.name)}</span><span class="d num">${i === 0 ? esc(a.ident) : fmt.dist(hav(UI.ll(c[i - 1]), UI.ll(a)))}</span></div>`).join('')}</div>` : ''}</div>
    <div class="sec"><div class="cap" style="margin-bottom:8px">Trip type</div><div class="seg sm" data-seg="trip">${Object.keys(tripLabel).map(k => `<button data-v="${k}" class="${S.trip === k ? 'on' : ''}">${tripLabel[k]}</button>`).join('')}</div><div class="hint">${tripHint[S.trip]}</div></div>
    <div class="sec"><div class="cap" style="margin-bottom:8px">Frequency</div><div class="freq"><input type="number" min="1" max="2000" value="${S.freq}" data-act="freq" class="num"><span class="t">routes /</span><div class="seg sm" data-seg="per"><button data-v="day" class="${S.per === 'day' ? 'on' : ''}">day</button><button data-v="week" class="${S.per === 'week' ? 'on' : ''}">week</button></div></div></div>
    <div class="sec"><div class="lbl"><span class="cap">Charger</span><button class="lnk" data-act="allChargers">${S.allChargers ? 'Fewer' : 'All chargers'}</button></div>
      ${chList.map(x => `<button class="chg ${x.id === S.chargerId ? 'on' : ''}" data-act="charger" data-id="${x.id}"><img src="/pics/${esc(x.image || '')}" alt=""><span class="n">${esc(cName(x))}</span><span class="kw num">${kwLabel(x)}</span></button>`).join('')}
      ${p.max_charge_kw && ch.power_kw > p.max_charge_kw ? `<div class="hint num">Aircraft accepts max ${p.max_charge_kw} kW — the charger is capped.</div>` : ''}</div>
    ${S.err ? `<div class="sec err">${esc(S.err)}</div>` : ''}`;
    $('#railFoot').innerHTML = `<div class="btns"><button class="btn p ${S.busy ? 'busy' : ''}" data-act="simulate">${S.busy ? 'Simulating…' : 'Simulate'}</button><button class="btn i" data-act="reset" title="Reset"><svg class="ic"><use href="#i-reset"/></svg></button></div>`;
    $$('[data-ac]').forEach(inp => { const key = inp.dataset.ac; bindAc(inp, $('#ac-' + key), a => { if (key === 'origin') S.origin = a; else if (key === 'dest') S.dest = a; else S.stops[+key.slice(4)] = a; onFormChange(true); }); });
  }
  function onFormChange(fit) { S.result = null; S.profile = null; S.err = ''; S.rail = 'form'; UI.render(); UI.map.drawRoute(fit); }

  // ---- simulate: the classic payload + the engine profile ---------------------
  const toC = a => ({ ident: a.ident, name: a.name, lat: a.latitude_deg, lon: a.longitude_deg });
  function engineProfile(data) {
    const p = UI.plane(); const o = data._origin, d = data._dest; const wp = x => ({ ident: x.ident, name: x.name, lat: x.lat, lon: x.lon });
    const waypoints = data.trip_type === 'training' ? [wp(o)] : [wp(o), ...(data.stops || []).map(wp), wp(d)];
    return CNSFlight.simulateTrip(p, waypoints, { tripType: data.trip_type, getTargetSoc: () => (window.CNSDemand && CNSDemand.resolveTargetSoc ? CNSDemand.resolveTargetSoc({}) : null), getChargerKw: () => (data.charger && data.charger.power_kw) || UI.charger().power_kw || 0, trainingRangeKm: data.training_range_km });
  }
  async function simulate() {
    if (S.trip === 'training' && !S.origin) { S.err = 'Pick a departure airport.'; UI.render(); return; }
    if (S.trip !== 'training' && (!S.origin || !S.dest)) { S.err = 'Pick a departure and a destination.'; UI.render(); return; }
    if (S.trip === 'circular' && !S.stops.filter(Boolean).length) { S.err = 'A circular trip needs at least one stop.'; UI.render(); return; }
    const stops = S.stops.filter(Boolean).map(toC); const p = UI.plane(), ch = UI.charger();
    const payload = { origin: toC(S.origin), destination: S.trip === 'training' ? toC(S.origin) : toC(S.dest), plane_id: S.planeId, charger_id: S.chargerId, trip_type: S.trip };
    if (S.trip === 'training') payload.training_range_km = p.training_range_km || 0;
    if (window.CNSChargers && CNSChargers.get && CNSChargers.get(S.chargerId)) payload.charger = CNSChargers.get(S.chargerId);
    if (S.trip === 'circular') { const ring = [...stops, toC(S.dest)]; payload.destination = ring[ring.length - 1]; payload.stops = ring.slice(0, -1); }
    else if (stops.length) payload.stops = stops;
    S.busy = true; S.err = ''; UI.render();
    try { const r = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const j = await r.json();
      if (!r.ok || j.error) { S.err = j.error || ('Simulate failed (' + r.status + ')'); S.result = null; S.profile = null; }
      else { j._origin = toC(S.origin); j._dest = S.trip === 'training' ? toC(S.origin) : toC(S.dest); j._chargerId = S.chargerId; j._freqN = Math.max(1, Math.min(2000, S.freq)); j._freqUnit = S.per; if (!j.charger) j.charger = { id: ch.id, name: ch.name, power_kw: ch.power_kw };
        S.result = j; S.profile = engineProfile(j); S.rail = 'result'; S.open = { route: true, charging: false, calc: false }; }
    } catch (e) { S.err = 'Simulate failed: ' + e.message; }
    S.busy = false; UI.render(); UI.map.drawRoute(true);
  }
  function resimulate() { if (S.result) { S.profile = engineProfile(S.result); UI.map.drawRoute(false); } }

  // ---- result -----------------------------------------------------------------
  function derive() {
    const pr = S.profile; if (!pr) return null; const T = pr.totals || {};
    const charged = (pr.charges || []).reduce((s, c) => s + (c.energyKwh || 0), 0);
    return { legs: pr.legs || [], charges: pr.charges || [], used: T.energyUsedKwh || 0, charged, chargeMin: T.chargeMin || 0, flyMin: T.flightMin || 0, travelMin: T.travelMin || ((T.flightMin || 0) + (T.enRouteMin || 0)), dist: T.distKm || 0, terminal: pr.terminal || {}, training: !!pr.training };
  }
  const legsForMap = () => { const d = derive(); return d ? d.legs : null; };
  function renderResult() {
    const r = S.result, d = derive(), p = UI.plane(), ch = UI.charger(); const c = UI.chain();
    const fpd = UI.perDay({ freq: S.freq, per: S.per }); const rate = (window.CNSSettings && CNSSettings.chargeRate) ? CNSSettings.chargeRate() : 0.6; const chargedR = fmt.r(d.charged); const costDay = chargedR * fpd * rate;   // classic: revenue from the DISPLAYED (rounded-up) kWh so the sub-line audits
    const climb = (window.CNSFlight && CNSFlight.climbParams) ? CNSFlight.climbParams(p) : { applies: false };
    const soc = UI.soc.series(d.legs, d.charges, p.battery_kwh || 1, climb, { training: d.training });
    const RES = Math.round((1 - ((window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7)) * 100);
    const X = v => 6 + v * 3.88, Y = v => 6 + (100 - Math.max(0, v)) * 0.72;
    const socSvg = `<div class="soc"><div class="lbl"><span class="cap">Battery</span><span class="r">lowest <b class="${soc.low < RES ? 'low' : ''}">${Math.round(soc.low)} %</b>${(soc.pts.find(q => q.soc === soc.low) || {}).id ? ' at ' + esc(soc.pts.find(q => q.soc === soc.low).id) : ''} · reserve ${RES} %</span></div>
      <svg viewBox="0 0 400 92" preserveAspectRatio="none">${soc.zones.map(z => `<rect x="${X(z.x0).toFixed(1)}" y="4" width="${(X(z.x1) - X(z.x0)).toFixed(1)}" height="74" fill="${z.t === 'climb' ? 'rgba(216,76,38,.07)' : 'rgba(50,50,110,.05)'}"/>`).join('')}
      <line x1="6" y1="${Y(RES).toFixed(1)}" x2="394" y2="${Y(RES).toFixed(1)}" stroke="#cfcfda" stroke-dasharray="3 4"/><line x1="6" y1="${Y(0).toFixed(1)}" x2="394" y2="${Y(0).toFixed(1)}" stroke="#e2e2ea"/>
      ${soc.segs.map(s => `<path d="M${X(s.x0).toFixed(1)} ${Y(s.y0).toFixed(1)} L${X(s.x1).toFixed(1)} ${Y(s.y1).toFixed(1)}" stroke="${s.t === 'fly' ? '#32326E' : '#d84c26'}" stroke-width="${s.t === 'fly' ? 2 : 2.5}" fill="none" stroke-linecap="round"/>`).join('')}
      ${soc.pts.map((q, i) => `<circle cx="${X(q.x).toFixed(1)}" cy="${Y(q.soc).toFixed(1)}" r="3" fill="${q.soc < RES ? '#b3261e' : '#32326E'}"/><text x="${X(q.x).toFixed(1)}" y="${(Y(q.soc) + (i === 0 ? -8 : 14)).toFixed(1)}" font-size="10" font-weight="600" fill="${q.soc < RES ? '#b3261e' : '#32326E'}" text-anchor="${i === 0 ? 'start' : i === soc.pts.length - 1 ? 'end' : 'middle'}">${Math.round(q.soc)} %${q.id ? ' · ' + esc(q.id) : ''}</text>`).join('')}
      <text x="6" y="${(Y(RES) + 11).toFixed(1)}" font-size="9" fill="#6f7290">reserve ${RES} %</text></svg></div>`;
    $('#railBody').innerHTML = `
    <div class="rh2"><div><div class="ttl">${c.map(a => esc(a.ident)).join(' <span class="ar">→</span> ')}</div><div class="m">${esc(p.name)} · ${tripLabel[S.trip]} · ${S.freq} / ${S.per} · ${esc(ch.name)}</div></div><button class="lnk" data-act="edit">Edit</button></div>
    <div class="stats"><div><div class="cap">Energy</div><div class="v num">${fmt.r(d.used)}<small>kWh</small></div><div class="s">${d.legs.length > 1 ? d.legs.length + ' legs' : 'per flight'}</div></div>
      <div><div class="cap">Travel</div><div class="v num">${fmt.h(d.travelMin)}<small>h</small></div><div class="s">${d.travelMin > d.flyMin + 0.5 ? 'incl. charging' : 'block time'}</div></div>
      <div><div class="cap">Charge</div><div class="v num">${fmt.r(d.chargeMin)}<small>min</small></div><div class="s">${d.charges.length > 1 ? 'over ' + d.charges.length + ' stops' : 'at ' + esc(d.terminal.ident || 'destination')}</div></div></div>
    <div class="cost"><div class="v num">€${fmt.eur(costDay)}<small>/ day</small></div><div class="m num">${fmt.r(chargedR * fpd)} kWh · €${rate.toFixed(2)} / kWh</div></div>
    <div class="split"><div class="b"><i class="f" style="flex:${(d.flyMin / 60).toFixed(3)}"></i><i class="c" style="flex:${(d.chargeMin / 60).toFixed(3)}"></i></div><div class="lg"><span><i></i>Fly ${fmt.h(d.flyMin)} h</span><span><i class="c"></i>Charge ${fmt.min(d.chargeMin)}</span><span style="margin-left:auto" class="num">${fmt.dist(d.dist)}</span></div></div>
    ${socSvg}
    <div class="acc ${S.open.route ? 'open' : ''}" data-acc="route"><button><span>Route <span class="sub">${d.legs.length} leg${d.legs.length > 1 ? 's' : ''} · ${c.length - 2 > 0 ? (c.length - 2) + ' stop' + (c.length - 2 > 1 ? 's' : '') : 'no stops'}</span></span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane"><table class="tbl"><tr><th>Leg</th><th class="r">${fmt.ukm()}</th><th class="r">Time</th><th class="r">kWh</th></tr>
      ${d.legs.map((l, i) => `<tr><td><span class="mu num">${String(i + 1).padStart(2, '0')}</span> ${esc(UI.shortName(l.fromName))} → ${esc(UI.shortName(l.toName))}${l.overRange ? ' <span class="mu" style="color:var(--danger)">over range</span>' : ''}</td><td class="r num">${fmt.r(fmt.km(l.distKm))}</td><td class="r num">${fmt.h(l.flightMin)}</td><td class="r num">${fmt.r(l.energyKwh)}</td></tr>`).join('')}</table>
      ${climb.applies && !d.training ? `<div class="hint num">Includes up to ${Math.round(climb.eMaxKwh)} kWh net climb per leg, saturating at ${Math.round(climb.dSatKm)} km.</div>` : ''}</div></div>
    <div class="acc ${S.open.charging ? 'open' : ''}" data-acc="charging"><button><span>Charging <span class="sub">${esc(ch.name)} · ${fmt.r(d.charged)} kWh</span></span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane"><table class="tbl"><tr><th>Where</th><th class="r">Arrive</th><th class="r">To</th><th class="r">kWh</th><th class="r">Time</th></tr>
      ${d.charges.map(x => `<tr><td>${esc(x.ident || '')} ${esc(UI.shortName(x.name))} <span class="mu">${x.isTerminal ? 'terminal' : 'en route'}</span></td><td class="r num">${Math.round((x.arrivalSocFrac || 0) * 100)} %</td><td class="r num">${Math.round((x.targetSocFrac || 0) * 100)} %</td><td class="r num">${fmt.r(x.energyKwh)}</td><td class="r num">${fmt.min(x.chargeMin)}</td></tr>`).join('')}</table></div></div>
    <div class="acc ${S.open.calc ? 'open' : ''}" data-acc="calc"><button><span>Calculation</span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane calc num"><div><span class="mu">Battery</span> ${p.battery_kwh} kWh · usable ${Math.round(((window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7) * 100)} %</div>
      <div><span class="mu">Energy</span> ${d.legs.map(l => fmt.r(l.energyKwh)).join(' + ')} = <b>${fmt.r(d.used)} kWh</b></div>
      <div><span class="mu">Charge</span> ${chargedR} kWh at ${esc(ch.name)} = <b>${fmt.min(d.chargeMin)}</b></div>
      <div><span class="mu">Cost</span> ${chargedR} kWh × ${fpd.toFixed(fpd % 1 ? 2 : 0)} / day × €${rate.toFixed(2)} = <b>€${fmt.eur(costDay)}</b></div>
      <div class="mu" style="margin-top:6px">Engine audit (raw model): ${esc(String(r.leg_energy_kwh))} kWh/leg · ${esc(String(r.charge_time_min ?? r.total_charge_time_min))} min charge</div></div></div>`;
    $('#railFoot').innerHTML = `<div class="btns"><button class="btn p" data-act="add">Add to network</button><button class="btn i" data-act="share" title="Copy a share link"><svg class="ic"><use href="#i-share"/></svg></button></div>`;
  }
  function addToNetwork() {
    const r = S.result; if (!r || !window.CNSFlightEntry || !window.CNSDemand) return;
    // fromSim wants {ident,name,lat,lon} (the API shape), not the airport record — without lat/lon the
    // engine profile is null and the scheduler sees a flight with no phases. An id is required too:
    // remove/edit/recompute address flights by id (the classic uses Date.now()).
    const entry = CNSFlightEntry.fromSim(r, { origin: toC(S.origin), dest: toC(S.trip === 'training' ? S.origin : S.dest), chargerId: S.chargerId, freqN: S.freq, freqUnit: S.per, id: String(Date.now()) });
    const folder = CNSDemand.loadFolder(); folder.push(entry); CNSDemand.saveFolder(folder); UI.folderChanged();
    UI.toast(`Added ${UI.chain().map(a => a.ident).join(' → ')} to the network`); UI.map.drawNet(); UI.render();
  }
  function resetForm() { UI._applyDefaults(); S.stops = []; S.trip = 'one-way'; S.freq = 1; S.per = 'day'; S.picking = false; S.allChargers = false; onFormChange(true); }
  function render() { if (S.rail === 'result' && S.profile) renderResult(); else renderForm(); }

  document.addEventListener('click', e => {
    if (S.mode !== 'plan') return;
    const t = e.target.closest('[data-act],[data-seg] button,[data-acc]>button'); if (!t) return;
    const seg = t.closest('[data-seg]'); if (seg) { S[seg.dataset.seg] = t.dataset.v; if (seg.dataset.seg === 'trip') onFormChange(true); else UI.render(); return; }
    const acc = t.closest('[data-acc]'); if (acc) { S.open[acc.dataset.acc] = !S.open[acc.dataset.acc]; acc.classList.toggle('open'); return; }
    switch (t.dataset.act) {
      case 'simulate': simulate(); break;
      case 'reset': resetForm(); UI.toast('Form reset'); break;
      case 'edit': S.rail = 'form'; UI.render(); break;
      case 'add': addToNetwork(); break;
      case 'share': if (window.CNSShare && CNSShare.copyLink) CNSShare.copyLink(); else UI.toast('Share link — phase 2'); break;
      case 'pick': S.picking = !S.picking; UI.render(); break;
      case 'plane': { S.planeId = t.dataset.id; S.picking = false; const dc = UI.plane().default_charger_id; if (dc && UI.CHARGERS.find(c => c.id === dc)) S.chargerId = dc; onFormChange(false); break; }
      case 'charger': S.chargerId = t.dataset.id; onFormChange(false); break;
      case 'allChargers': S.allChargers = !S.allChargers; UI.render(); break;
      case 'addStop': S.stops.push(null); UI.render(); setTimeout(() => { const i = $$('[data-ac^=stop]').pop(); i && i.focus(); }, 0); break;
      case 'rmStop': S.stops.splice(+t.dataset.i, 1); onFormChange(true); break;
    }
  });
  document.addEventListener('change', e => { const t = e.target; if (t.dataset.act === 'freq') { S.freq = Math.max(1, Math.min(2000, +t.value || 1)); if (S.result) UI.render(); } });
  document.addEventListener('input', e => { if (e.target.dataset.act === 'freq') S.freq = Math.max(1, Math.min(2000, +e.target.value || 1)); });

  UI.plan = { render, simulate, resimulate, addToNetwork, derive, legsForMap, onFormChange, resetForm };
})();
