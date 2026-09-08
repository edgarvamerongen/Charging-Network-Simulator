/* CNS v2 — ui/network.js: Network mode. The ledger over the shared folder, per-airport chargers and
   charge target, flights with roles / pins / feasibility, the edit-flight and replay dialogs,
   isolation and scenarios. Numbers mirror the classic demand card (index.html renderFolder). */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc, fmt = UI.fmt;
  const tripLabel = { 'one-way': 'One-way', retour: 'Return', circular: 'Circular', training: 'Training' };
  const ROLE = { training: 'Training', home: 'Departure', origin: 'Departure', stop: 'Stop', dest: 'Destination' };
  Object.assign(S, { revYear: true, socOpen: {} });
  const D = () => window.CNSDemand, SC = () => window.CNSScheduler, ST = () => window.CNSSettings;
  const cat = id => (window.PLANES_BY_ID || {})[id] || {};
  const rate = () => (ST() && ST().chargeRate) ? ST().chargeRate() : 0.6;
  const gridMul = () => (ST() && ST().gridDemandFactor) ? ST().gridDemandFactor() : 1;
  // Clock times round to the nearest minute (CNSUnits.fmtClock, units.js:45) — fmt.h is a DURATION formatter (ceil).
  const clockOf = m => { if (window.CNSUnits && CNSUnits.fmtClock) return CNSUnits.fmtClock(m); const c = Math.max(0, Math.round(m || 0)); return String(Math.floor(c / 60)).padStart(2, '0') + ':' + String(c % 60).padStart(2, '0'); };

  // ---- recompute (classic _recomputeCtx / recomputeAllFlights) ----
  function recomputeCtx() {
    return { allAirports: UI.airports(), allowedTypes: ['small_airport', 'medium_airport', 'large_airport'], allowedIdents: new Set(Object.keys(UI.assets() || {})),
      planeFor: t => ({ id: t.planeId, name: t.planeName, battery_kwh: t.battery, range_km: t.range_km, speed_kmh: t.speed_kmh, c_rate: t.c_rate, runway_req: cat(t.planeId).runway_req, type: cat(t.planeId).type, range_incl_reserves: cat(t.planeId).range_incl_reserves, regime: cat(t.planeId).regime, max_charge_kw: cat(t.planeId).max_charge_kw }),
      availableRangeKm: p => UI.planner ? UI.planner.availableRangeKm(p) : null, routingOptions: UI.planner ? UI.planner.routingOptions() : {} };
  }
  function recomputeAll() { if (!window.CNSRecompute || !D()) return; const trips = D().loadFolder(); if (!trips.length) return; D().saveFolder(CNSRecompute.recomputeAll(trips, recomputeCtx())); UI.folderChanged(); }
  let _rt = null; const recomputeAllDebounced = () => { clearTimeout(_rt); _rt = setTimeout(() => { recomputeAll(); UI.render(); UI.map.drawNet(); }, 250); };

  // ---- per-airport numbers, exactly like the classic card ----
  // Charger-fleet plan peak — the classic's fallback (index.html:5656) for airports the DES gives no charge
  // phase (multi-leg-only traffic): a sensible upper bound so the card stays meaningful instead of reading 0.
  function planPeak(fleet, contribs, energyOf) {
    if (!window.CNSCharging || !CNSCharging.planCharging || !fleet.length || !contribs.length) return 0;
    const list = contribs.map(c => ({ name: c.t.planeName, energy: c.t.feasible === false ? 0 : energyOf(c), size: c.t.battery ?? c.t.legEnergy * 2,
      forcedChargerId: c.t.chargerOverride, nChargers: (window.CNSFlight && CNSFlight.nChargers) ? CNSFlight.nChargers(cat(c.t.planeId) || c.t) : 1 }));
    try { return CNSCharging.planCharging(fleet, list).peakPower || 0; } catch (e) { return 0; }
  }
  function rows() {
    if (!D()) return [];
    const aps = D().computeAirports(); const cfgs = D().loadCfg ? D().loadCfg() : {};
    const gm = gridMul();
    const getTargetSoc = id => (D().resolveTargetSoc ? D().resolveTargetSoc(cfgs[id]) : null);
    const cache = {};
    // Classic renderFolder (index.html:5610-5613): the engine profile is the only source — no profile ⇒ 0 kWh
    // (`_engEnergyAt(c) ?? 0`). The old CNSDemand.energyAt fallback was called with an undefined ident and double-counted.
    const energyOf = c => { if (c.t.feasible === false) return 0; const pr = (c.t.id in cache) ? cache[c.t.id] : (cache[c.t.id] = (window.CNSFlight && CNSFlight.profileForTrip) ? CNSFlight.profileForTrip(c.t, { getTargetSoc }) : null); return (pr && CNSFlight.chargeEnergyAt) ? (CNSFlight.chargeEnergyAt(pr, c) ?? 0) : 0; };
    return Object.values(aps).map(a => {
      const cfg = cfgs[a.ident] || {};
      const trips = []; a.contribs.forEach(c => { if (!trips.includes(c.t)) trips.push(c.t); });
      const flights = a.contribs.reduce((s, c) => s + D().flightsPerDay(c.t), 0);
      const kwhAircraft = a.contribs.reduce((s, c) => s + energyOf(c) * D().flightsPerDay(c.t), 0);
      const fleetIds = (cfg.chargers && cfg.chargers.length) ? cfg.chargers : (D().defaultChargerFleet ? D().defaultChargerFleet(a.contribs) : []);
      const fleet = fleetIds.map(id => window.CHARGERS_BY_ID[id]).filter(Boolean);
      const sum = (SC() && SC().summary) ? SC().summary(a.ident) : {};
      const peakKw = sum.peakKw || planPeak(fleet, a.contribs, energyOf);
      // Grid side (charger losses included) is what the classic card prints for energy AND peak; revenue is
      // priced on the CHARGED (aircraft-side) kWh, so both figures travel with the row.
      return { ident: a.ident, name: a.name, contribs: a.contribs, trips, flights, kwh: kwhAircraft * gm, kwhAircraft, gridMul: gm, fleetIds, fleet, cfg, targetSoc: D().targetSocFromCfg ? D().targetSocFromCfg(cfg) : null, peakKw, peak: peakKw * gm, overflow: !!sum.overflow, chargeMin: sum.chargeMin || 0, latestEnd: sum.latestEnd || 0 };
    }).sort((x, y) => y.flights - x.flights || y.kwh - x.kwh);   // busiest first by daily flights, like the classic (index.html:5537)
  }
  const infeasibleCount = R => R.reduce((s, a) => s + a.trips.filter(t => t.feasible === false).length, 0);

  // ---- render ----
  function airportPane(a) {
    // Revenue is priced per CHARGED kWh (aircraft side, classic index.html:5708); energy is grid side.
    const rev = a.kwhAircraft * rate() * (S.revYear ? 365 : 1);
    const grid = a.gridMul > 1 ? ' (grid)' : '';
    const opts = UI.CHARGERS.slice().sort((x, y) => y.power_kw - x.power_kw);
    const socPct = a.targetSoc != null ? Math.round(a.targetSoc * 100) : null;
    return `<div class="pane">
      <div class="tiles3"><div><div class="cap">Revenue <span class="seg xs" data-rev><button data-act="revDay" class="${S.revYear ? '' : 'on'}">day</button><button data-act="revYear" class="${S.revYear ? 'on' : ''}">year</button></span></div><div class="v num">€${Math.round(rev).toLocaleString('en')}</div><div class="s num">€${rate().toFixed(2)} / kWh</div></div>
        <div><div class="cap">Energy${grid}</div><div class="v num">${fmt.parts(a.kwh, 'Wh').n}<small>${fmt.parts(a.kwh, 'Wh').u} / day</small></div><div class="s num">${fmt.kwh(a.kwh * 365)} / year</div></div>
        <div><div class="cap">Charging</div><div class="v num">${fmt.min(a.chargeMin)}<small>/ day</small></div><div class="s">${a.overflow ? '<span style="color:var(--danger)">runs past 23:00</span>' : 'ends ' + clockOf(a.latestEnd)}</div></div></div>
      ${a.overflow ? `<div class="alert">Rotations run past 23:00 at this airport — add a charger or spread the flights.</div>` : ''}
      <div class="lbl" style="margin-top:10px"><span class="cap">Chargers</span><button class="lnk" data-act="fleetAdd" data-ap="${a.ident}">+ Add charger</button></div>
      <div class="fleet">${a.fleetIds.map((id, i) => `<span class="slot"><select class="sel" data-act="fleetSel" data-ap="${a.ident}" data-i="${i}">${opts.map(c => `<option value="${c.id}" ${c.id === id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${a.fleetIds.length > 1 ? `<button class="rm" data-act="fleetRm" data-ap="${a.ident}" data-i="${i}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button>` : ''}</span>`).join('')}</div>
      <div class="lbl" style="margin-top:10px"><span class="cap">Charge target</span><button class="chip" data-act="socToggle" data-ap="${a.ident}">${socPct == null ? 'auto' : 'at least ' + socPct + ' %'}</button></div>
      ${S.socOpen[a.ident] ? `<div class="socp"><label><input type="radio" name="soc-${a.ident}" value="auto" data-act="socMode" data-ap="${a.ident}" ${socPct == null ? 'checked' : ''}> Auto — the global charge target</label><label><input type="radio" name="soc-${a.ident}" value="target" data-act="socMode" data-ap="${a.ident}" ${socPct != null ? 'checked' : ''}> Charge to at least <b class="num">${socPct != null ? socPct : 80} %</b></label><input type="range" min="20" max="100" step="5" value="${socPct != null ? socPct : 80}" data-act="socSlider" data-ap="${a.ident}" ${socPct == null ? 'disabled' : ''}></div>` : ''}
      <div class="lbl" style="margin-top:12px"><span class="cap">Flights</span><button class="lnk" data-act="replay" data-ap="${a.ident}">View flights on map</button></div>
      ${a.contribs.map(c => { const t = c.t; const bad = t.feasible === false; return `<div class="fl ${bad ? 'bad' : ''}"><span class="t"><span class="tag">${ROLE[c.role] || c.role}</span> ${esc(t.originIdent)} → ${esc(t.destIdent)}${t.multiLeg && (t.stops || []).length ? ' <span class="mu">via ' + t.stops.map(s => esc(s.ident)).join(', ') + '</span>' : ''}${t.chargerOverride ? ' <span class="mu" title="Pinned to a charger">📌</span>' : ''}<small>${esc(UI.planeShort(t.planeName))} · ${tripLabel[t.tripType] || t.tripType}${bad ? ' · <span style="color:var(--danger)">no route at current settings' + (t.infeasibleReason ? ': ' + esc(t.infeasibleReason) : '') + '</span>' : ''}</small></span>
        <span class="mu num freq"><input type="number" min="1" max="2000" value="${t.freqN}" data-act="tripFreq" data-id="${esc(t.id)}"><select class="sel" data-act="tripUnit" data-id="${esc(t.id)}"><option value="day" ${t.freqUnit === 'day' ? 'selected' : ''}>/ day</option><option value="week" ${t.freqUnit === 'week' ? 'selected' : ''}>/ week</option></select></span>
        <button class="lnk" data-act="editTrip" data-id="${esc(t.id)}" data-ap="${a.ident}">Edit</button><button class="rm" data-act="rm" data-id="${esc(t.id)}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button></div>`; }).join('')}
      ${S.filter ? '' : `<div class="row" style="justify-content:flex-end;margin-top:8px"><button class="lnk" data-act="focus" data-ap="${a.ident}">Isolate ${a.ident}</button></div>`}</div>`;
  }
  function render() {
    const R = rows(); const folder = D() ? D().loadFolder() : [];
    const foc = S.filter && R.find(a => a.ident === S.filter) || null; if (foc) S.openAp[foc.ident] = true;
    const flights = folder.reduce((s, t) => s + D().flightsPerDay(t), 0); const kwh = R.reduce((s, a) => s + a.kwh, 0); const kwhAc = R.reduce((s, a) => s + a.kwhAircraft, 0); const peak = R.reduce((s, a) => s + a.peak, 0); const bad = infeasibleCount(R);
    const grid = gridMul() > 1 ? ' (grid)' : '';
    const head = foc
      ? `<div><h3>${foc.ident} <span style="font-weight:400;color:var(--muted)">${esc(UI.shortName(foc.name))}</span></h3><div class="sub num">${foc.trips.length} route${foc.trips.length === 1 ? '' : 's'} · ${foc.flights % 1 ? foc.flights.toFixed(1) : foc.flights} flights / day · ${foc.fleet.length} charger${foc.fleet.length === 1 ? '' : 's'}</div></div><div class="tools"><button class="lnk" data-act="focus" data-ap="">← All airports</button></div>`
      : `<div><h3>Network</h3><div class="sub num">${R.length} airport${R.length === 1 ? '' : 's'} · ${folder.length} route${folder.length === 1 ? '' : 's'} · ${flights % 1 ? flights.toFixed(1) : flights} flight${flights === 1 ? '' : 's'} / day${bad ? ' · <span style="color:var(--danger)">' + bad + ' without a route</span>' : ''}</div></div><div class="tools">${folder.length ? '<button class="lnk" data-act="clear">Clear all</button>' : ''}</div>`;
    const tiles = foc
      ? `<div class="tiles"><div><div class="cap">Energy / day${grid}</div><div class="v num">${fmt.parts(foc.kwh, 'Wh').n}<small>${fmt.parts(foc.kwh, 'Wh').u}</small></div></div><div><div class="cap">Peak load${grid}</div><div class="v num">${fmt.parts(foc.peak, 'W').n}<small>${fmt.parts(foc.peak, 'W').u}</small></div></div><div><div class="cap">Charging / day</div><div class="v num">${fmt.r(foc.chargeMin)}<small>min</small></div></div><div><div class="cap">Revenue</div><div class="v num">€${Math.round(foc.kwhAircraft * rate() * (S.revYear ? 365 : 1)).toLocaleString('en')}<small>/ ${S.revYear ? 'year' : 'day'}</small></div></div></div>`
      : folder.length ? `<div class="tiles"><div><div class="cap">Airports</div><div class="v num">${R.length}</div></div><div><div class="cap">Flights / day</div><div class="v num">${flights % 1 ? flights.toFixed(1) : flights}</div></div><div><div class="cap">Energy / day${grid}</div><div class="v num">${fmt.parts(kwh, 'Wh').n}<small>${fmt.parts(kwh, 'Wh').u}</small></div></div><div><div class="cap">Peak (sum)${grid}</div><div class="v num">${fmt.parts(peak, 'W').n}<small>${fmt.parts(peak, 'W').u}</small></div></div></div>` : '';
    $('#railBody').innerHTML = `<div class="ph">${head}</div>${tiles}
    ${folder.length ? `<div class="ntool"><span class="cap">Show</span><select class="sel" data-act="filter">${['<option value="">All airports</option>', ...R.map(a => `<option value="${a.ident}" ${S.filter === a.ident ? 'selected' : ''}>${a.ident} · ${esc(UI.shortName(a.name))}</option>`)].join('')}</select><span class="sp"></span><span class="hint num" style="margin:0">€${fmt.eur(kwhAc * rate())} / day</span></div>
    ${R.filter(a => !S.filter || a.ident === S.filter).map((a, i) => `<div class="ap ${S.openAp[a.ident] ? 'open' : ''}${i % 2 ? ' alt' : ''}" data-ap="${a.ident}"><button><span class="id">${a.ident}</span><span class="nm">${esc(UI.shortName(a.name))}<small>${a.trips.length} route${a.trips.length === 1 ? '' : 's'}${a.overflow ? ' · <span style="color:var(--danger)">overflow</span>' : ''}${UI.assets()[a.ident] ? ' · NRG2FLY site' : ''}</small></span>
      <span class="st num">${a.flights % 1 ? a.flights.toFixed(1) : a.flights}<small>flights / day</small></span><span class="st num">${a.peak ? fmt.parts(a.peak, 'W').n : '—'}<small>peak ${a.peak ? fmt.parts(a.peak, 'W').u : 'kW'}</small></span><svg class="ic"><use href="#i-chev"/></svg></button>${airportPane(a)}</div>`).join('')}`
    : `<div class="cap" style="padding:12px var(--pad) 8px">Empty network · start from a scenario</div><div class="scen">${Object.entries(SCENARIOS).map(([k, s]) => `<div class="sc"><b>${s.title}</b><small>${s.meta}</small><div class="sp">${s.spark.map(v => `<i style="height:${v}%"></i>`).join('')}</div><button class="lnk" data-act="scenario" data-k="${k}">Load</button></div>`).join('')}</div><div class="hint" style="padding:0 var(--pad) 14px">Or plan a route in Plan mode and add it — each flight contributes charging demand to its departure and arrival airports.</div>`}`;
    $('#railFoot').innerHTML = folder.length ? `<div class="btns"><button class="btn p" data-act="build">Share build</button><button class="btn" data-act="pdf">PDF</button><button class="btn" data-act="xlsx">XLSX</button></div>` : '';
    $('#netCount').textContent = folder.length || '';
    // Tie the expanded row to the map: ring the airports whose pane is open.
    syncHighlight();
  }

  /** Ring the open airports on the map so the expanded ledger row is findable in the view. */
  function syncHighlight() { if (UI.map && UI.map.highlightAirports) UI.map.highlightAirports(Object.keys(S.openAp).filter(k => S.openAp[k])); }

  // ---- cfg + folder edits ----
  const cfgPatch = (ap, patch) => { const c = D().loadCfg(); c[ap] = Object.assign({}, c[ap] || {}, patch); D().saveCfg(c); UI.folderChanged(); UI.render(); };
  function remove(id) { D().saveFolder(D().loadFolder().filter(t => t.id !== id)); UI.folderChanged(); UI.map.drawNet(); UI.render(); }
  function fleetOf(a) { const R = rows().find(x => x.ident === a); return R ? R.fleetIds.slice() : []; }

  // ---- edit flight (classic openFlightEdit / _rebuildEditedTrip) ----
  function rebuildEditedTrip(prev, d, o) {
    const isTraining = d.trip_type === 'training';
    const trip = { id: prev.id, destIdent: isTraining ? prev.originIdent : prev.destIdent, destName: isTraining ? prev.originName : prev.destName, destLat: isTraining ? prev.originLat : prev.destLat, destLon: isTraining ? prev.originLon : prev.destLon,
      originIdent: prev.originIdent, originName: prev.originName, originLat: prev.originLat, originLon: prev.originLon, planeName: d.plane.name, planeId: d.plane.id, planeSvg: d.plane.svg, tripType: d.trip_type,
      chargerId: prev.chargerId, chargerName: d.charger.name, chargerPower: d.charger.power_kw, legEnergy: d.leg_energy_kwh, battery: d.plane.battery_kwh, c_rate: d.plane.c_rate, range_km: d.plane.range_km, speed_kmh: d.plane.speed_kmh,
      freqN: o.freqN, freqUnit: o.freqUnit, fleetMode: o.fleetMode, chargerOverride: o.chargerOverride || undefined };
    if (d.multi_leg) Object.assign(trip, { multiLeg: true, flightTimeH: d.total_flight_time_h, rechargeEnergy: d.total_recharge_energy_kwh, stops: (window.CNSRecompute && CNSRecompute.mergeManualFlags) ? CNSRecompute.mergeManualFlags(d.stops, prev.stops) : d.stops, charges: d.charges, legs: d.legs, totalDistanceKm: d.total_distance_km, totalFlightTimeH: d.total_flight_time_h, totalChargeMin: d.total_charge_time_min, totalRechargeKwh: d.total_recharge_energy_kwh });
    else if (isTraining) Object.assign(trip, { rechargeEnergy: d.recharge_energy_kwh, flightTimeH: d.flight_time_h, trainingRangeKm: d.training_range_km, rawPatternEnergyKwh: d.raw_pattern_energy_kwh });
    else Object.assign(trip, { rechargeEnergy: d.recharge_energy_kwh, flightTimeH: d.flight_time_h });
    return trip;
  }
  function openEdit(id, ap) {
    const t = D().loadFolder().find(x => x.id === id); if (!t) return;
    // Charger options: the airport's fleet, deduped, plus the current pin even when it is no longer in the
    // fleet — labelled '(not in fleet)' and selected, so the choice stays visible (classic index.html:6046-6060).
    const seen = new Set(); const chOpts = [];
    fleetOf(ap).forEach(cid => { const c = window.CHARGERS_BY_ID[cid]; if (!c || seen.has(c.id)) return; seen.add(c.id); chOpts.push({ id: c.id, label: c.name }); });
    if (t.chargerOverride && !seen.has(t.chargerOverride) && window.CHARGERS_BY_ID[t.chargerOverride]) { seen.add(t.chargerOverride); chOpts.push({ id: t.chargerOverride, label: window.CHARGERS_BY_ID[t.chargerOverride].name + ' (not in fleet)' }); }
    const chSel = (t.chargerOverride && seen.has(t.chargerOverride)) ? t.chargerOverride : '';
    const fm = t.fleetMode || (t.tripType === 'training' ? 'shared' : 'separate');
    UI.modal.open(`<div class="mh"><h3>Edit flight · ${esc(t.originIdent)} → ${esc(t.destIdent)}</h3><button class="tb icon" data-modal="close"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div class="mb" id="efBox" data-id="${esc(t.id)}" data-ap="${esc(ap)}">
        <div class="grid2"><label><span class="cap">Trip type</span><select class="sel" id="efTripType">${Object.keys(tripLabel).map(k => `<option value="${k}" ${t.tripType === k ? 'selected' : ''}>${tripLabel[k]}</option>`).join('')}</select></label>
          <label><span class="cap">Aircraft</span><select class="sel" id="efPlane">${UI.PLANES.map(p => `<option value="${p.id}" ${p.id === t.planeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label><span class="cap">Charger at ${esc(ap)}</span><select class="sel" id="efCharger"><option value="" ${chSel ? '' : 'selected'}>Automatic (biggest with biggest)</option>${chOpts.map(c => `<option value="${esc(c.id)}" ${chSel === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
          <label><span class="cap">Frequency</span><span class="row" style="gap:6px"><input type="number" min="1" max="2000" id="efFreqN" value="${t.freqN || 1}" class="num sel" style="width:80px"><select class="sel" id="efFreqUnit"><option value="day" ${t.freqUnit !== 'week' ? 'selected' : ''}>/ day</option><option value="week" ${t.freqUnit === 'week' ? 'selected' : ''}>/ week</option></select></span></label></div>
        <div id="efFleetRow" style="margin-top:12px" ${t.tripType === 'training' ? 'hidden' : ''}><span class="cap">Aircraft for repeated flights</span><div class="row" style="gap:14px;margin-top:6px"><label><input type="radio" name="efFleetMode" value="separate" ${fm === 'separate' ? 'checked' : ''}> One aircraft per flight (fleet)</label><label><input type="radio" name="efFleetMode" value="shared" ${fm === 'shared' ? 'checked' : ''}> One aircraft, sequential rotations</label></div></div>
        <div class="err" id="efError" hidden></div></div>
      <div class="btns"><button class="btn p" data-act="efSave">Save</button><button class="btn" data-modal="close">Cancel</button></div>`);
  }
  async function saveEdit() {
    const box = $('#efBox'); const id = box.dataset.id; const trips = D().loadFolder(); const idx = trips.findIndex(t => t.id === id); if (idx < 0) return; const prev = trips[idx];
    const tripType = $('#efTripType').value, planeId = $('#efPlane').value, freqN = Math.min(2000, Math.max(1, parseInt($('#efFreqN').value || '1', 10))), freqUnit = $('#efFreqUnit').value === 'week' ? 'week' : 'day';
    const fleetMode = ($('input[name=efFleetMode]:checked') || {}).value || prev.fleetMode || 'separate'; const chargerOverride = $('#efCharger').value || '';
    const err = $('#efError');
    // A training flight has no separate destination — it cannot become a routed trip (classic index.html:6135).
    if (tripType !== 'training' && (!prev.destIdent || prev.destIdent === prev.originIdent)) {
      err.textContent = 'This flight loops around a single airport (no destination). Add a new flight to give it a route.'; err.hidden = false; return;
    }
    // Metadata-only (frequency / fleet mode / charger pin): save + re-render, no recompute, no backend round-trip
    // (classic index.html:6141-6147).
    if (tripType === prev.tripType && planeId === prev.planeId) { err.hidden = true; trips[idx] = Object.assign({}, prev, { freqN, freqUnit, fleetMode, chargerOverride: chargerOverride || undefined }); D().saveFolder(trips); UI.modal.close(); UI.folderChanged(); UI.render(); UI.map.drawNet(); return; }
    const btn = $('[data-act=efSave]'); btn.classList.add('busy');
    const o = { ident: prev.originIdent, name: prev.originName, lat: prev.originLat, lon: prev.originLon }, dd = { ident: prev.destIdent, name: prev.destName, lat: prev.destLat, lon: prev.destLon };
    const payload = { origin: o, destination: tripType === 'training' ? o : dd, plane_id: planeId, charger_id: prev.chargerId, trip_type: tripType };
    // A custom charger only exists client-side: send the object so the backend can size the charge (classic index.html:6161).
    const custom = (window.CNSChargers && CNSChargers.get) ? CNSChargers.get(prev.chargerId) : null;
    if (custom) payload.charger = custom; else if (window.CHARGERS_BY_ID && window.CHARGERS_BY_ID[prev.chargerId]) payload.charger = window.CHARGERS_BY_ID[prev.chargerId];
    if (tripType === 'training') payload.training_range_km = cat(planeId).training_range_km || 0;
    const manual = (prev.stops || []).filter(s => s && s._manual).map(s => ({ name: s.name, lat: s.lat, lon: s.lon, ident: s.ident, type: s.type }));
    if (tripType === 'circular') { const ring = [...manual, dd]; payload.destination = ring[ring.length - 1]; payload.stops = ring.slice(0, -1); } else if (manual.length && tripType !== 'training') payload.stops = manual;
    try { const r = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ('Simulate failed (' + r.status + ')'));
      trips[idx] = rebuildEditedTrip(prev, d, { freqN, freqUnit, fleetMode, chargerOverride }); D().saveFolder(trips); UI.modal.close(); recomputeAll(); UI.render(); UI.map.drawNet(); UI.toast('Flight updated');
    } catch (e) { err.textContent = e.message; err.hidden = false; btn.classList.remove('busy'); }
  }

  // ---- replay map (classic flightsMapModal + CNSAnimation) ----
  let replayMap = null, _replayT = null;
  function openReplay(ap) {
    const a = rows().find(x => x.ident === ap);
    UI.modal.open(`<div class="mh"><h3>Flights at ${esc(a ? UI.shortName(a.name) : ap)} <span class="hint" style="margin-left:8px" id="animClock"></span></h3><button class="tb icon" data-modal="close"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div id="folderMap" style="height:420px"></div>
      <div class="btns" style="align-items:center;gap:12px"><span class="cap">Speed</span><input type="range" id="animSpeed" min="2" max="60" step="2" value="20" style="flex:1"><span class="hint num" id="animSpeedLbl" style="margin:0">20 s / hour</span></div>`);
    $('#modalBox').style.width = '760px';
    // No zoom/fade animation: CNSAnimation's fitBounds (60 ms after open) would otherwise still be animating when the
    // dialog is closed, and Leaflet's 250 ms transition fallback then runs against a removed map (_leaflet_pos TypeError).
    // The classic dodges this by never removing #folderMap (index.html:6404-6407); v2 rebuilds the dialog each time.
    replayMap = L.map('folderMap', { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([50, 10], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png' + ((UI.D && UI.D.cartoKeyQs) || ''), { attribution: '© OSM © CARTO', subdomains: 'abcd', maxZoom: 19 }).addTo(replayMap);
    window.folderMap = replayMap;
    _replayT = setTimeout(() => { _replayT = null; if (!replayMap) return; replayMap.invalidateSize(); if (window.CNSAnimation) CNSAnimation.start(replayMap, ap, { clockEl: $('#animClock'), speed: 20 }); }, 60);
  }
  function closeReplay() {
    clearTimeout(_replayT); _replayT = null;
    if (window.CNSAnimation) { try { CNSAnimation.stop(); } catch (e) { /* animation already torn down */ } }
    if (replayMap) { const m = replayMap; replayMap = null; window.folderMap = null; try { m.stop(); } catch (e) {} try { m.remove(); } catch (e) { console.warn('[v2] replay map teardown', e); } }
    $('#modalBox').style.width = '';
  }
  document.addEventListener('input', e => { if (e.target.id === 'animSpeed') { const v = +e.target.value; if (window.CNSAnimation) CNSAnimation.setSpeed(v); $('#animSpeedLbl').textContent = v + ' s / hour'; } });
  const _close = UI.modal.close; UI.modal.close = function () { if (replayMap) closeReplay(); _close(); };

  // ---- scenarios (the demos behind the empty state and the deep links) ----
  const SCENARIOS = {
    hub: { title: 'Hub base', meta: '1 base · 8 return routes · 18 flights / day', chargers: { EHLE: ['dc_320', 'dc_320'] }, focus: 'EHLE', spark: [20, 90, 70, 40, 30, 95, 60, 35, 20],
      routes: [['EHLE', 'EDDF', 'beta_plane', 3, 'day', 'retour'], ['EHLE', 'EDDL', 'beta_plane', 3, 'day', 'retour'], ['EHLE', 'EBBR', 'beta_plane', 2, 'day', 'retour'], ['EHLE', 'EGKB', 'beta_plane', 2, 'day', 'retour'], ['EHLE', 'LFPB', 'beta_plane', 2, 'day', 'retour'], ['EHLE', 'EDDH', 'vaeridion', 2, 'day', 'retour'], ['EHLE', 'EDDV', 'beta_plane', 2, 'day', 'retour'], ['EHLE', 'EDDS', 'beta_plane', 2, 'day', 'retour']] },
    regional: { title: 'Regional network', meta: '15 airports · 12 routes · 26 flights / day', chargers: {}, focus: '', spark: [30, 60, 80, 50, 40, 70, 55, 45, 25],
      routes: [['EHLE', 'EDDF', 'beta_plane', 1, 'day', 'one-way'], ['EHAM', 'EDLS', 'beta_plane', 3, 'day', 'one-way'], ['EHRD', 'EBBR', 'beta_plane', 2, 'day', 'one-way'], ['EHGG', 'EDDH', 'beta_plane', 1, 'day', 'retour'], ['EHEH', 'EDDL', 'vaeridion', 2, 'day', 'one-way'], ['EDDF', 'EDDM', 'beta_plane', 2, 'day', 'one-way'], ['EHLE', 'EHHV', 'pipistrel_velis', 4, 'day', 'retour'], ['EBBR', 'LFPB', 'vaeridion', 1, 'day', 'one-way'], ['EHBK', 'EDDL', 'pipistrel_velis', 2, 'day', 'one-way'], ['EHAM', 'EHGG', 'beta_plane', 2, 'day', 'retour'], ['EDLS', 'EDDF', 'beta_plane', 1, 'day', 'one-way'], ['EHBD', 'EHEH', 'pipistrel_velis', 5, 'day', 'one-way']] },
    training: { title: 'Training school', meta: '1 airfield · Velis circuits · 12 sorties / day', chargers: { EHTE: ['dc_22', 'dc_22', 'dc_22'] }, focus: 'EHTE', spark: [50, 50, 50, 50, 50, 50, 50, 50, 50], routes: [['EHTE', 'EHTE', 'pipistrel_velis', 12, 'day', 'training']] }
  };
  // Scenario plane ids are prototype names; the live catalog may spell them differently (production: beta_alia,
  // vaeridion_microliner). app.js owns the mapping — consume it defensively so a shell without it still loads.
  const PLANE_ALIAS = { beta_plane: 'beta_alia', vaeridion: 'vaeridion_microliner', vaeridion_light: 'vaeridion_microliner_9_seats' };
  const knownPlane = id => !!id && UI.PLANES.some(p => p.id === id);
  function resolvePlane(id) {
    if (knownPlane(id)) return id;
    const viaApp = (typeof UI.resolvePlaneId === 'function') ? UI.resolvePlaneId(id) : null; if (knownPlane(viaApp)) return viaApp;
    if (knownPlane(PLANE_ALIAS[id])) return PLANE_ALIAS[id];
    const byAirframe = UI.PLANES.find(p => p.aircraft_id === id); if (byAirframe) return byAirframe.id;
    const byPrefix = UI.PLANES.find(p => String(p.id).indexOf(String(id)) === 0); if (byPrefix) return byPrefix.id;
    return id;
  }
  async function loadScenario(key) {
    const sc = SCENARIOS[key]; if (!sc) return; const by = UI.byId();
    // A scenario is a fresh network: the previous one's per-airport chargers and hand-placed take-offs must not survive it.
    D().saveFolder([]); const cfg = {}; Object.entries(sc.chargers).forEach(([ap, ch]) => { cfg[ap] = { chargers: ch.slice() }; }); D().saveCfg(cfg);
    try { localStorage.removeItem('cns_schedule'); } catch (e) { /* private mode */ }
    S.filter = ''; S.openAp = {};
    UI.setMode('plan'); UI.toast(`Loading ${sc.title}…`);
    // One render + one fit for the whole batch, not one per route (each simulate/add re-renders the shell).
    const _render = UI.render, _fit = UI.map.fitNet, _drawNet = UI.map.drawNet, _drawRoute = UI.map.drawRoute;
    const fails = [];
    try {
      UI.render = () => {}; UI.map.fitNet = () => {}; UI.map.drawNet = () => {}; UI.map.drawRoute = () => {};
      for (const [o, d, pl, fr, per, tr] of sc.routes) {
        if (!by[o] || !by[d]) { fails.push(`${o}→${d}: airport not in the catalog`); continue; }
        const planeId = resolvePlane(pl);
        if (!UI.PLANES.some(p => p.id === planeId)) { fails.push(`${o}→${d}: aircraft "${pl}" is not in the catalog`); continue; }
        S.origin = by[o]; S.dest = by[d]; S.stops = []; S.planeId = planeId;
        const dc = UI.plane().default_charger_id; if (dc && UI.CHARGERS.find(c => c.id === dc)) S.chargerId = dc;
        S.freq = fr; S.per = per; S.trip = tr; S.blacklist.clear(); S.result = null; S.err = '';
        await UI.plan.simulate();
        if (S.result) UI.plan.addToNetwork(); else fails.push(`${o}→${d} ${planeId}: ${S.err || 'no result'}`);
      }
    } finally { UI.render = _render; UI.map.fitNet = _fit; UI.map.drawNet = _drawNet; UI.map.drawRoute = _drawRoute; }
    UI.plan.resetForm(); if (sc.focus) S.openAp[sc.focus] = true;
    UI.setMode('network'); $('#drawer').classList.add('open'); UI.timeline.render();
    const n = D().loadFolder().length;
    if (fails.length) console.warn('[v2] scenario ' + key + ': ' + fails.length + ' route(s) failed —', fails);
    UI.toast(`${sc.title} loaded — ${n} route${n === 1 ? '' : 's'}` + (fails.length ? ` · ${fails.length} failed: ${fails[0]}` : ''));
  }

  // ---- events ----
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act],[data-ap]>button'); if (!t) return;
    if (t.dataset.act === 'efSave') { saveEdit(); return; }
    // #focChip carries data-act="focus" in the markup but is owned by timeline.js — handling it here as well would
    // run two full renders and two map fits per click.
    if (t.id === 'focChip') return;
    // The demand drawer renders in BOTH modes, so its 'Isolate <ICAO>' buttons must work in Plan mode too — they
    // switch to Network mode, where the isolation lives. Everything else stays Network-only.
    if (S.mode !== 'network' && !['scenario', 'focus'].includes(t.dataset.act)) return;
    const ap = t.closest('[data-ap]'); if (ap && !t.dataset.act && t.tagName === 'BUTTON' && t.parentElement === ap) { S.openAp[ap.dataset.ap] = !S.openAp[ap.dataset.ap]; ap.classList.toggle('open'); syncHighlight(); return; }
    switch (t.dataset.act) {
      case 'rm': remove(t.dataset.id); break;
      case 'clear': if (confirm('Remove all routes from the network?')) { D().saveFolder([]); UI.folderChanged(); UI.map.drawNet(); UI.render(); } break;
      case 'build': UI.share.copyBuildLink(); break;
      case 'xlsx': if (window.CNSSpreadsheet) CNSSpreadsheet.export(t); break;
      case 'pdf': UI.report && UI.report.pick(); break;
      case 'focus': S.filter = t.dataset.ap || ''; if (S.filter) S.openAp[S.filter] = true;
        if (S.mode !== 'network') { UI.setMode('network'); } else { UI.render(); UI.map.drawNet(); UI.map.fitNet(); } break;
      case 'revDay': case 'revYear': S.revYear = t.dataset.act === 'revYear'; UI.render(); break;
      case 'fleetAdd': { const ids = fleetOf(t.dataset.ap); ids.push(ids[ids.length - 1] || (UI.CHARGERS[0] && UI.CHARGERS[0].id)); cfgPatch(t.dataset.ap, { chargers: ids }); break; }
      case 'fleetRm': { const ids = fleetOf(t.dataset.ap); ids.splice(+t.dataset.i, 1); cfgPatch(t.dataset.ap, { chargers: ids }); break; }
      case 'socToggle': S.socOpen[t.dataset.ap] = !S.socOpen[t.dataset.ap]; UI.render(); break;
      case 'editTrip': openEdit(t.dataset.id, t.dataset.ap); break;
      case 'replay': openReplay(t.dataset.ap); break;
      case 'scenario': loadScenario(t.dataset.k); break;
    }
  });
  document.addEventListener('change', e => { const t = e.target; if (!t.dataset) return;
    if (t.dataset.act === 'filter') { S.filter = t.value; UI.render(); UI.map.drawNet(); UI.map.fitNet(); }
    if (t.dataset.act === 'fleetSel') { const ids = fleetOf(t.dataset.ap); ids[+t.dataset.i] = t.value; cfgPatch(t.dataset.ap, { chargers: ids }); }
    if (t.dataset.act === 'socMode') { if (t.value === 'auto') { const c = D().loadCfg(); c[t.dataset.ap] = Object.assign({}, c[t.dataset.ap] || {}); delete c[t.dataset.ap].targetDepartureSoc; delete c[t.dataset.ap].fullCharge; D().saveCfg(c); UI.folderChanged(); UI.render(); } else { const sl = $(`[data-act=socSlider][data-ap="${t.dataset.ap}"]`); cfgPatch(t.dataset.ap, { targetDepartureSoc: (+(sl ? sl.value : 80)) / 100, fullCharge: undefined }); } }
    if (t.dataset.act === 'socSlider') cfgPatch(t.dataset.ap, { targetDepartureSoc: (+t.value) / 100, fullCharge: undefined });
    if (t.dataset.act === 'tripFreq') { D().updateTrip(t.dataset.id, { freqN: Math.min(2000, Math.max(1, parseInt(t.value || '1', 10))) }); UI.folderChanged(); UI.render(); }
    if (t.dataset.act === 'tripUnit') { D().updateTrip(t.dataset.id, { freqUnit: t.value }); UI.folderChanged(); UI.render(); }
  });
  UI.network = { render, remove, rows, recomputeAll, recomputeAllDebounced, loadScenario, SCENARIOS, openEdit, openReplay };
})();
