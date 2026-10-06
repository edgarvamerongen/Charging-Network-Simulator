/* CNS v2 — ui/network.js: Network mode. The ledger over the shared folder, per-airport chargers and
   charge target, flights with roles / pins / feasibility, the edit-flight and replay dialogs,
   isolation and scenarios. Numbers mirror the classic demand card (index.html renderFolder). */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc, fmt = UI.fmt;
  const tripLabel = { 'one-way': 'One-way', retour: 'Return', circular: 'Circular', training: 'Training' };
  const ROLE = { training: 'Training', home: 'Departure', origin: 'Departure', stop: 'Stop', dest: 'Destination' };
  Object.assign(S, { socOpen: {} });
  const D = () => window.CNSDemand, SC = () => window.CNSScheduler, ST = () => window.CNSSettings;
  const cat = id => (window.PLANES_BY_ID || {})[id] || {};
  const rate = () => (ST() && ST().chargeRate) ? ST().chargeRate() : 0.6;
  const gridMul = () => (ST() && ST().gridDemandFactor) ? ST().gridDemandFactor() : 1;
  // Clock times round to the nearest minute (units.js:45) — fmt.h is a DURATION formatter (ceil).
  const clockOf = CNSUnits.fmtClock;

  // ---- recompute (classic _recomputeCtx / recomputeAllFlights) ----
  function recomputeCtx() {
    return { allAirports: UI.airports(), allowedTypes: ['small_airport', 'medium_airport', 'large_airport'], allowedIdents: new Set(Object.keys(UI.assets() || {})),
      planeFor: t => ({ id: t.planeId, name: t.planeName, battery_kwh: t.battery, range_km: t.range_km, speed_kmh: t.speed_kmh, runway_req: cat(t.planeId).runway_req, type: cat(t.planeId).type, range_incl_reserves: cat(t.planeId).range_incl_reserves, regime: cat(t.planeId).regime, max_charge_kw: cat(t.planeId).max_charge_kw }),
      availableRangeKm: p => UI.planner ? UI.planner.availableRangeKm(p) : null, routingOptions: UI.planner ? UI.planner.routingOptions() : {} };
  }
  function recomputeAll() { if (!window.CNSRecompute || !D()) return; const trips = D().loadFolder(); if (!trips.length) return; D().saveFolder(CNSRecompute.recomputeAll(trips, recomputeCtx())); UI.folderChanged(); }
  let _rt = null; const recomputeAllDebounced = () => { clearTimeout(_rt); _rt = setTimeout(() => { recomputeAll(); UI.render(); UI.map.drawNet(); }, 250); };

  // ---- per-airport numbers, exactly like the classic card ----
  // Charger-fleet plan peak — the classic's fallback (index.html:5656) for airports the DES gives no charge
  // phase (multi-leg-only traffic): a sensible upper bound so the card stays meaningful instead of reading 0.
  function planPeak(fleet, contribs, energyOf) {
    if (!window.CNSCharging || !CNSCharging.planCharging || !fleet.length || !contribs.length) return 0;
    const list = contribs.map(c => ({ name: c.t.planeName, energy: c.t.feasible === false ? 0 : energyOf(c), size: CNSDemand.batteryOf(c.t),
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
    // (`_engEnergyAt(c) ?? 0`). The old demand-side fallback it replaced was called with an undefined ident and double-counted.
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

  // ---- prototype (?proto; design audit P3): how many chargers an airport needs ----------------------
  // What-if runs of the scheduler's day (CNSScheduler.whatIfChargers saves nothing), from one charger
  // fewer to three more than today: the longest delay a charger queue causes (a later take-off, or a wait
  // where that can't absorb it), the delay per day, the peak load.
  const hm = m => { const t = Math.round(m || 0); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  function waitsAt(ident) {
    const g = SC().runGlobal(); let maxWait = 0, queue = 0, queued = 0;
    g.lanes.forEach(L => L.rotations.forEach(rot => rot.phases.forEach(ph => { if (ph.kind === 'charge' && ph.ident === ident && ph.queue > 0) { maxWait = Math.max(maxWait, ph.queue); queue += ph.queue; queued++; } })));
    const sm = SC().summary(ident); return { maxWait, queue, queued, peak: (sm.peakKw || 0) * gridMul(), overflow: !!sm.overflow };
  }
  const _size = {};
  function sizing(a) {
    if (!SC() || !SC().whatIfChargers || !a.fleetIds.length) return null;
    const key = ['cns_folder', 'cns_airport_cfg', 'cns_schedule', ST() ? ST().KEY : ''].map(k => localStorage.getItem(k) || '').join('¦') + '¦' + a.ident;
    if (_size[a.ident] && _size[a.ident].key === key) return _size[a.ident].v;
    const cur = a.fleetIds.length, lo = Math.max(1, cur - 1);
    const idsFor = n => { const ids = a.fleetIds.slice(0, n); while (ids.length < n) ids.push(ids[ids.length - 1]); return ids; };   // more = the last charger again, like "+ Add charger"
    const cols = [];
    for (let n = lo; n < lo + 5; n++) { const ids = idsFor(n); cols.push(Object.assign({ n, ids, now: n === cur }, n === cur ? waitsAt(a.ident) : SC().whatIfChargers(a.ident, ids, () => waitsAt(a.ident)))); }
    const v = { cols, cur }; _size[a.ident] = { key, v }; return v;
  }
  function sizingHtml(a) {
    const z = sizing(a); if (!z) return '';
    const lim = S.waitOk || 15, rec = z.cols.find(c => c.maxWait <= lim) || null, now = z.cols.find(c => c.now), last = z.cols[z.cols.length - 1];
    const pk = fmt.prefixFor(z.cols.map(c => c.peak)), pkOf = c => fmt.as(c.peak, pk, 'W');
    const cls = c => `${c.now ? ' now' : ''}${rec && c.n === rec.n ? ' rec' : ''}`;
    const row = (label, f) => `<tr><td>${label}</td>${z.cols.map(c => `<td class="r num${cls(c)}">${f(c)}</td>`).join('')}</tr>`;
    const msg = !rec ? `Even ${last.n} chargers leave a delay of ${hm(last.maxWait)}&nbsp;h: spread the departures or use a faster charger.`
      : rec.n === z.cur ? `The ${z.cur} charger${z.cur === 1 ? '' : 's'} here keep the longest delay under ${lim}&nbsp;min.`
      : rec.n > z.cur ? `${rec.n} chargers keep the longest delay under ${lim}&nbsp;min (${hm(rec.maxWait)}&nbsp;h) at a ${pkOf(rec).n}&nbsp;${pkOf(rec).u} peak.`
      : `${rec.n} charger${rec.n === 1 ? '' : 's'} would already keep the longest delay under ${lim}&nbsp;min.`;
    return `${now && now.maxWait > lim ? `<div class="alert">Aircraft delayed up to ${hm(now.maxWait)}&nbsp;h by the chargers here.</div>` : ''}
      <div class="size"><div class="lbl"><span class="cap">Chargers needed</span><span class="hint" style="margin:0">longest delay under <select class="sel" data-act="waitOk">${[5, 10, 15, 30, 60].map(v => `<option value="${v}" ${v === lim ? 'selected' : ''}>${v} min</option>`).join('')}</select></span></div>
      <table class="tbl"><tr><th>Chargers</th>${z.cols.map(c => `<th class="r${cls(c)}">${c.n}${c.now ? ' now' : ''}</th>`).join('')}</tr>
        ${row('Longest delay', c => hm(c.maxWait))}${row('Delay per day', c => hm(c.queue))}${row(`Peak load, <span class="u">${pk}W</span>`, c => pkOf(c).n)}</table>
      <div class="size-rec"><span>${msg}</span>${rec && rec.n !== z.cur ? `<button class="btn sm p" data-act="useN" data-ap="${a.ident}" data-ids="${rec.ids.join(',')}">Use ${rec.n}</button>` : ''}</div></div>`;
  }
  const waitTag = a => { if (!SC()) return ''; const w = waitsAt(a.ident); return w.maxWait > (S.waitOk || 15) ? ` · <span style="color:var(--danger)">delays up to ${hm(w.maxWait)}&nbsp;h</span>` : ''; };

  // ---- render ----
  function airportPane(a) {
    // Revenue is priced per CHARGED kWh (aircraft side, classic index.html:5708); energy is grid side.
    const rev = a.kwhAircraft * rate();   // per day; the year sits under it, like energy (audit T8)
    const grid = a.gridMul > 1 ? ' (grid)' : '';
    const opts = UI.CHARGERS.slice().sort((x, y) => y.power_kw - x.power_kw);
    const socPct = a.targetSoc != null ? Math.round(a.targetSoc * 100) : null;
    return `<div class="pane">
      <div class="tiles3"><div><div class="cap">Revenue</div><div class="v num">€${Math.round(rev).toLocaleString('en')}<small>/ day</small></div><div class="s num">€${Math.round(rev * 365).toLocaleString('en')} / year</div></div>
        <div><div class="cap">Energy${grid}</div><div class="v num">${fmt.parts(a.kwh, 'Wh').n}<small>${fmt.parts(a.kwh, 'Wh').u} / day</small></div><div class="s num">${fmt.kwh(a.kwh * 365)} / year</div></div>
        <div><div class="cap">Charging</div><div class="v num">${fmt.min(a.chargeMin)}<small>/ day</small></div><div class="s">${a.overflow ? '<span style="color:var(--danger)">runs past 23:00</span>' : 'ends ' + clockOf(a.latestEnd)}</div></div></div>
      ${a.overflow ? `<div class="alert">Rotations run past 23:00 at this airport. Add a charger or spread the flights.</div>` : ''}
      ${UI.PROTO ? sizingHtml(a) : ''}
      <div class="lbl" style="margin-top:10px"><span class="cap">Chargers</span><button class="lnk" data-act="fleetAdd" data-ap="${a.ident}">+ Add charger</button></div>
      <div class="fleet">${a.fleetIds.map((id, i) => `<span class="slot"><select class="sel" data-act="fleetSel" data-ap="${a.ident}" data-i="${i}">${opts.map(c => `<option value="${c.id}" ${c.id === id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${a.fleetIds.length > 1 ? `<button class="rm" data-act="fleetRm" data-ap="${a.ident}" data-i="${i}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button>` : ''}</span>`).join('')}</div>
      <div class="lbl" style="margin-top:10px"><span class="cap">Charge target</span><button class="chip" data-act="socToggle" data-ap="${a.ident}">${socPct == null ? 'auto' : 'at least ' + socPct + ' %'}</button></div>
      ${S.socOpen[a.ident] ? `<div class="socp"><label><input type="radio" name="soc-${a.ident}" value="auto" data-act="socMode" data-ap="${a.ident}" ${socPct == null ? 'checked' : ''}> Auto (the global charge target)</label><label><input type="radio" name="soc-${a.ident}" value="target" data-act="socMode" data-ap="${a.ident}" ${socPct != null ? 'checked' : ''}> Charge to at least <b class="num">${socPct != null ? socPct : 80} %</b></label><input type="range" min="20" max="100" step="5" value="${socPct != null ? socPct : 80}" data-act="socSlider" data-ap="${a.ident}" ${socPct == null ? 'disabled' : ''}></div>` : ''}
      <div class="lbl" style="margin-top:12px"><span class="cap">Flights</span><button class="lnk" data-act="replay" data-ap="${a.ident}">View flights on map</button></div>
      ${a.contribs.map(c => { const t = c.t; const bad = t.feasible === false; return `<div class="fl ${bad ? 'bad' : ''}"><button class="t" data-act="openTrip" data-id="${esc(t.id)}" title="Open this route in Plan"><span class="tag">${ROLE[c.role] || c.role}</span> <span class="r">${esc(t.originIdent)} → ${esc(t.destIdent)}</span>${t.multiLeg && (t.stops || []).length ? ' <span class="mu">via ' + t.stops.map(s => esc(s.ident)).join(', ') + '</span>' : ''}${t.chargerOverride ? ' <span class="mu" title="Pinned to a charger">📌</span>' : ''}<small>${esc(UI.planeShort(t.planeName))} · ${(t.custom ? 'Waypoints' : tripLabel[t.tripType] || t.tripType)}${c.noCharge ? ' · no charging here' : ''}${bad ? ' · <span style="color:var(--danger)">no route at current settings' + (t.infeasibleReason ? ': ' + esc(t.infeasibleReason) : '') + '</span>' : ''}</small></button>
        <span class="mu num freq"><input type="number" min="1" max="2000" value="${t.freqN}" data-act="tripFreq" data-id="${esc(t.id)}"><button class="u" data-act="tripUnit" data-id="${esc(t.id)}" data-v="${t.freqUnit === 'week' ? 'day' : 'week'}" title="Per ${t.freqUnit === 'week' ? 'week' : 'day'}, click for per ${t.freqUnit === 'week' ? 'day' : 'week'}">/${t.freqUnit === 'week' ? 'wk' : 'day'}</button></span>
        <button class="rm" data-act="rm" data-id="${esc(t.id)}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button></div>`; }).join('')}
      ${S.filter ? '' : `<div class="row" style="justify-content:flex-end;margin-top:8px"><button class="lnk" data-act="focus" data-ap="${a.ident}">Isolate ${a.ident}</button></div>`}</div>`;
  }
  function render() {
    const R = rows(); const folder = D() ? D().loadFolder() : [];
    const foc = S.filter && R.find(a => a.ident === S.filter) || null; if (foc) S.openAp = { [foc.ident]: true };
    const flights = folder.reduce((s, t) => s + D().flightsPerDay(t), 0); const kwh = R.reduce((s, a) => s + a.kwh, 0); const kwhAc = R.reduce((s, a) => s + a.kwhAircraft, 0); const peak = R.reduce((s, a) => s + a.peak, 0); const netPeak = UI.timeline && UI.timeline.peak ? UI.timeline.peak() : peak; const bad = infeasibleCount(R);
    const grid = gridMul() > 1 ? ' (grid)' : '';
    const pk = fmt.prefixFor(R.map(a => a.peak));   // the ledger's peak column reads in ONE unit (T1)
    const head = foc
      ? `<div><h3>${foc.ident} <span style="font-weight:400;color:var(--muted)">${esc(UI.shortName(foc.name))}</span></h3><div class="sub num">${foc.trips.length} route${foc.trips.length === 1 ? '' : 's'} · ${foc.flights % 1 ? foc.flights.toFixed(1) : foc.flights} ${fmt.pl(foc.flights, 'flight')} / day · ${foc.fleet.length} charger${foc.fleet.length === 1 ? '' : 's'}</div></div><div class="tools"><button class="lnk" data-act="focus" data-ap="">← All airports</button></div>`
      : `<div><h3>Network</h3><div class="sub num">${R.length} airport${R.length === 1 ? '' : 's'} · ${folder.length} route${folder.length === 1 ? '' : 's'} · ${flights % 1 ? flights.toFixed(1) : flights} flight${flights === 1 ? '' : 's'} / day${bad ? ' · <span style="color:var(--danger)">' + bad + ' without a route</span>' : ''}</div></div><div class="tools">${folder.length ? '<button class="lnk" data-act="clear">Clear all</button>' : ''}</div>`;
    const tiles = foc
      ? `<div class="tiles"><div><div class="cap">Energy / day${grid}</div><div class="v num">${fmt.parts(foc.kwh, 'Wh').n}<small>${fmt.parts(foc.kwh, 'Wh').u}</small></div></div><div><div class="cap">Peak load${grid}</div><div class="v num">${fmt.parts(foc.peak, 'W').n}<small>${fmt.parts(foc.peak, 'W').u}</small></div></div><div><div class="cap">Charging / day</div><div class="v num">${foc.chargeMin >= 60 ? fmt.h(foc.chargeMin) + '<small>h</small>' : fmt.r(foc.chargeMin) + '<small>min</small>'}</div></div><div><div class="cap">Revenue / day</div><div class="v num">€${Math.round(foc.kwhAircraft * rate()).toLocaleString('en')}</div></div></div>`
      // The counts live in the header line; the tiles carry the three totals, each with its context (audit T4, T8).
      : folder.length ? `<div class="tiles t3"><div><div class="cap">Energy / day${grid}</div><div class="v num">${fmt.parts(kwh, 'Wh').n}<small>${fmt.parts(kwh, 'Wh').u}</small></div><div class="s num">${fmt.kwh(kwh * 365)} / year</div></div><div><div class="cap">Network peak${grid}</div><div class="v num">${fmt.parts(netPeak, 'W').n}<small>${fmt.parts(netPeak, 'W').u}</small></div><div class="s num" title="Each airport's own peak, added up">airports ${fmt.kw(peak)}</div></div><div><div class="cap">Revenue / day</div><div class="v num">€${Math.round(kwhAc * rate()).toLocaleString('en')}</div><div class="s num">€${Math.round(kwhAc * rate() * 365).toLocaleString('en')} / year</div></div></div>` : '';
    $('#railBody').innerHTML = `<div class="ph">${head}</div>${tiles}
    ${folder.length ? `<div class="ntool"><span class="cap">Show</span><select class="sel" data-act="filter">${['<option value="">All airports</option>', ...R.map(a => `<option value="${a.ident}" ${S.filter === a.ident ? 'selected' : ''}>${a.ident} · ${esc(UI.shortName(a.name))}</option>`)].join('')}</select></div>
    ${R.filter(a => !S.filter || a.ident === S.filter).map((a, i) => `<div class="ap ${S.openAp[a.ident] ? 'open' : ''}${i % 2 ? ' alt' : ''}" data-ap="${a.ident}"><button><span class="id">${a.ident}</span><span class="nm">${esc(UI.shortName(a.name))}<small>${a.trips.length} route${a.trips.length === 1 ? '' : 's'}${a.overflow ? ' · <span style="color:var(--danger)">overflow</span>' : ''}${UI.assets()[a.ident] ? ' · NRG2FLY site' : ''}${UI.PROTO ? waitTag(a) : ''}</small></span>
      <span class="st num">${a.flights % 1 ? a.flights.toFixed(1) : a.flights}<small>${fmt.pl(a.flights, 'flight')} / day</small></span><span class="st num">${fmt.as(a.peak, pk, 'W').n}<small>peak <span class="u">${fmt.as(a.peak, pk, 'W').u}</span></small></span><svg class="ic"><use href="#i-chev"/></svg></button>${airportPane(a)}</div>`).join('')}`
    : `<div class="cap" style="padding:12px var(--pad) 8px">Empty network · start from a scenario</div><div class="scen">${Object.entries(SCENARIOS).map(([k, s]) => `<div class="sc"><b>${s.title}</b><small>${s.meta}</small><div class="sp">${s.spark.map(v => `<i style="height:${v}%"></i>`).join('')}</div><button class="lnk" data-act="scenario" data-k="${k}">Load</button></div>`).join('')}</div><div class="hint" style="padding:0 var(--pad) 14px">Or plan a route in Plan mode and add it. Each flight adds charging demand at its departure and arrival airports.</div>`}`;
    $('#railFoot').innerHTML = folder.length ? `<div class="btns"><button class="btn p" data-act="pdf">Advisory report</button><button class="btn" data-act="xlsx">XLSX</button><button class="btn i" data-act="build" title="Copy a link to the network build" aria-label="Copy a link to the network build"><svg class="ic"><use href="#i-share"/></svg></button></div>` : '';
    $('#netCount').textContent = folder.length || '';
    // Tie the expanded row to the map: ring the airports whose pane is open.
    syncHighlight();
  }

  /** Ring the open airports on the map so the expanded ledger row is findable in the view. */
  function syncHighlight() { if (UI.map && UI.map.drawNet) UI.map.drawNet(); }   // drawNet rings the selected airport

  // ---- cfg + folder edits ----
  const cfgPatch = (ap, patch) => { const c = D().loadCfg(); c[ap] = Object.assign({}, c[ap] || {}, patch); D().saveCfg(c); UI.folderChanged(); UI.render(); };
  function remove(id) { D().saveFolder(D().loadFolder().filter(t => t.id !== id)); UI.folderChanged(); UI.map.drawNet(); UI.render(); }
  function fleetOf(a) { const R = rows().find(x => x.ident === a); return R ? R.fleetIds.slice() : []; }

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
    // The Velis flies EHLE → EHHV one-way: back into Lelystad it cannot also hold the 43 km divert to Teuge.
    regional: { title: 'Regional network', meta: '15 airports · 12 routes · 26 flights / day', chargers: {}, focus: '', spark: [30, 60, 80, 50, 40, 70, 55, 45, 25],
      routes: [['EHLE', 'EDDF', 'beta_plane', 1, 'day', 'one-way'], ['EHAM', 'EDLS', 'beta_plane', 3, 'day', 'one-way'], ['EHRD', 'EBBR', 'beta_plane', 2, 'day', 'one-way'], ['EHGG', 'EDDH', 'beta_plane', 1, 'day', 'retour'], ['EHEH', 'EDDL', 'vaeridion', 2, 'day', 'one-way'], ['EDDF', 'EDDM', 'beta_plane', 2, 'day', 'one-way'], ['EHLE', 'EHHV', 'pipistrel_velis', 4, 'day', 'one-way'], ['EBBR', 'LFPB', 'vaeridion', 1, 'day', 'one-way'], ['EHBK', 'EDDL', 'pipistrel_velis', 2, 'day', 'one-way'], ['EHAM', 'EHGG', 'beta_plane', 2, 'day', 'retour'], ['EDLS', 'EDDF', 'beta_plane', 1, 'day', 'one-way'], ['EHBD', 'EHEH', 'pipistrel_velis', 5, 'day', 'one-way']] },
    training: { title: 'Training school', meta: '1 airfield · Velis circuits · 12 sorties / day', chargers: { EHTE: ['dc_22', 'dc_22', 'dc_22'] }, focus: 'EHTE', spark: [50, 50, 50, 50, 50, 50, 50, 50, 50], routes: [['EHTE', 'EHTE', 'pipistrel_velis', 12, 'day', 'training']] }
  };
  // Scenario plane ids are prototype names; the live catalog may spell them differently (production: beta_alia,
  // vaeridion_microliner). app.js owns the mapping (alias table + airframe + name + id prefix); an unresolvable
  // id is passed through so the failure surfaces as "unknown aircraft" rather than the wrong one.
  const resolvePlane = id => UI.resolvePlaneId(id) || id;
  async function loadScenario(key) {
    const sc = SCENARIOS[key]; if (!sc) return; const by = UI.byId();
    if (UI.plan && UI.plan.cancelLive) UI.plan.cancelLive();   // the prototype's pending live run must not race the batch
    // A scenario is a fresh network: the previous one's per-airport chargers and hand-placed take-offs must not survive it.
    D().saveFolder([]); const cfg = {}; Object.entries(sc.chargers).forEach(([ap, ch]) => { cfg[ap] = { chargers: ch.slice() }; }); D().saveCfg(cfg);
    try { localStorage.removeItem('cns_schedule'); } catch (e) { /* private mode */ }
    S.filter = ''; S.openAp = {};
    UI.setMode('plan'); UI.toast(`Loading ${sc.title}…`);
    // One render + one fit for the whole batch, not one per route (each simulate/add re-renders the shell).
    // ensureRouteVisible too: each batch simulate would otherwise animate the map to its own route, and the last
    // animation lands AFTER the network fit below (a Leaflet zoom transition re-applies its target when it ends).
    const _render = UI.render, _fit = UI.map.fitNet, _drawNet = UI.map.drawNet, _drawRoute = UI.map.drawRoute, _ensure = UI.map.ensureRouteVisible;
    const fails = [];
    try {
      UI.render = () => {}; UI.map.fitNet = () => {}; UI.map.drawNet = () => {}; UI.map.drawRoute = () => {}; UI.map.ensureRouteVisible = () => {};
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
    } finally { UI.render = _render; UI.map.fitNet = _fit; UI.map.drawNet = _drawNet; UI.map.drawRoute = _drawRoute; UI.map.ensureRouteVisible = _ensure; }
    UI.plan.resetForm(); if (sc.focus) S.openAp = { [sc.focus]: true };
    // Open the timeline BEFORE Network mode fits the map, so the fit knows the drawer's height and
    // nothing lands behind it (fitting first framed the network, then the drawer covered half of it).
    $('#drawer').classList.add('open'); UI.timeline.render(); UI.setMode('network');
    const n = D().loadFolder().length;
    if (fails.length) console.warn('[v2] scenario ' + key + ': ' + fails.length + ' route(s) failed —', fails);
    UI.toast(`${sc.title} loaded: ${n} route${n === 1 ? '' : 's'}` + (fails.length ? ` · ${fails.length} failed: ${fails[0]}` : ''));
  }

  // ---- events ----
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act],[data-ap]>button'); if (!t) return;
    // #focChip carries data-act="focus" in the markup but is owned by timeline.js — handling it here as well would
    // run two full renders and two map fits per click.
    if (t.id === 'focChip') return;
    // The demand drawer renders in BOTH modes, so its 'Isolate <ICAO>' buttons must work in Plan mode too — they
    // switch to Network mode, where the isolation lives. Everything else stays Network-only.
    if (S.mode !== 'network' && !['scenario', 'focus'].includes(t.dataset.act)) return;
    const ap = t.closest('[data-ap]'); if (ap && !t.dataset.act && t.tagName === 'BUTTON' && t.parentElement === ap) { S.openAp = S.openAp[ap.dataset.ap] ? {} : { [ap.dataset.ap]: true }; UI.render(); syncHighlight(); return; }
    switch (t.dataset.act) {
      case 'rm': remove(t.dataset.id); break;
      case 'clear': { const prev = D().loadFolder(); const redraw = () => { UI.folderChanged(); UI.map.drawNet(); UI.render(); };
        D().saveFolder([]); redraw(); UI.toast(`Network cleared: ${prev.length} route${prev.length === 1 ? '' : 's'} removed`, { label: 'Undo', run: () => { D().saveFolder(prev); redraw(); } }); break; }
      case 'build': UI.share.copyBuildLink(); break;
      case 'xlsx': if (window.CNSSpreadsheet) CNSSpreadsheet.export(t); break;
      case 'pdf': UI.report && UI.report.pick(); break;
      case 'focus': S.filter = t.dataset.ap || ''; if (S.filter) S.openAp = { [S.filter]: true };
        if (S.mode !== 'network') { UI.setMode('network'); } else { UI.render(); UI.map.drawNet(); UI.map.fitNet(); } break;
      case 'fleetAdd': { const ids = fleetOf(t.dataset.ap); ids.push(ids[ids.length - 1] || (UI.CHARGERS[0] && UI.CHARGERS[0].id)); cfgPatch(t.dataset.ap, { chargers: ids }); break; }
      case 'fleetRm': { const ids = fleetOf(t.dataset.ap); ids.splice(+t.dataset.i, 1); cfgPatch(t.dataset.ap, { chargers: ids }); break; }
      case 'useN': cfgPatch(t.dataset.ap, { chargers: t.dataset.ids.split(',') }); UI.toast(`${t.dataset.ap}: ${t.dataset.ids.split(',').length} chargers`); break;
      case 'socToggle': S.socOpen[t.dataset.ap] = !S.socOpen[t.dataset.ap]; UI.render(); break;
      case 'openTrip': UI.plan.openTrip(t.dataset.id); break;
      case 'tripUnit': D().updateTrip(t.dataset.id, { freqUnit: t.dataset.v }); UI.folderChanged(); UI.render(); break;
      case 'replay': openReplay(t.dataset.ap); break;
      case 'scenario': loadScenario(t.dataset.k); break;
    }
  });
  document.addEventListener('change', e => { const t = e.target; if (!t.dataset) return;
    if (t.dataset.act === 'filter') { S.filter = t.value; UI.render(); UI.map.drawNet(); UI.map.fitNet(); }
    if (t.dataset.act === 'waitOk') { S.waitOk = +t.value; UI.render(); }
    if (t.dataset.act === 'fleetSel') { const ids = fleetOf(t.dataset.ap); ids[+t.dataset.i] = t.value; cfgPatch(t.dataset.ap, { chargers: ids }); }
    if (t.dataset.act === 'socMode') { if (t.value === 'auto') { const c = D().loadCfg(); c[t.dataset.ap] = Object.assign({}, c[t.dataset.ap] || {}); delete c[t.dataset.ap].targetDepartureSoc; delete c[t.dataset.ap].fullCharge; D().saveCfg(c); UI.folderChanged(); UI.render(); } else { const sl = $(`[data-act=socSlider][data-ap="${t.dataset.ap}"]`); cfgPatch(t.dataset.ap, { targetDepartureSoc: (+(sl ? sl.value : 80)) / 100, fullCharge: undefined }); } }
    if (t.dataset.act === 'socSlider') cfgPatch(t.dataset.ap, { targetDepartureSoc: (+t.value) / 100, fullCharge: undefined });
    if (t.dataset.act === 'tripFreq') { D().updateTrip(t.dataset.id, { freqN: Math.min(2000, Math.max(1, parseInt(t.value || '1', 10))) }); UI.folderChanged(); UI.render(); }
  });
  UI.network = { render, rows, recomputeAll, recomputeAllDebounced, loadScenario, SCENARIOS };
})();
