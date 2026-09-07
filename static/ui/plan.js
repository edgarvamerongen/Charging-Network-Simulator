/* CNS v2 — ui/plan.js: the Plan rail (form → simulate → result). Numbers come from CNSFlight. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc, fmt = UI.fmt;
  const tripLabel = { 'one-way': 'One-way', retour: 'Return', circular: 'Circular', training: 'Training' };
  const tripHint = { 'one-way': 'A to B · charge to full at the destination', retour: 'A to B and back · charge at both ends', circular: 'A → stops → A · needs at least one stop', training: 'Circuits at the departure airport' };
  const usableKm = p => { if (UI.planner) { const a = UI.planner.availRangeShownKm(p); if (a != null) return Math.round(a); } const f = (window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7; return (window.CNSFlight && CNSFlight.maxFlownLegKm) ? Math.round(CNSFlight.maxFlownLegKm(p)) : Math.round(p.range_km * f); };
  const TYPE_TAG = { small_airport: 'S', medium_airport: 'M', large_airport: 'L' };
  const BIAS = [['medium-large-small', 'Medium → Large → Small'], ['large-medium-small', 'Large → Medium → Small'], ['small-medium-large', 'Small → Medium → Large'], ['none', 'No preference']];
  const HARD_FAIL = 'No route within range. This aircraft can\'t bridge a leg to the destination at the current reserves. Use a longer-range aircraft, or lower the landing reserve, SID/STAR or alternate reserve.';
  // Every planning aid shows the SAME number the result table prints: routed + SID/STAR (UI.dispKm,
  // the classic's _dispKm, index.html:4596-4601) — a raw great-circle here contradicts the result.
  const dispKm = (a, b) => UI.dispKm(a, b);
  const directKm = () => { const c = UI.chain(); let d = 0; for (let i = 0; i < c.length - 1; i++) d += dispKm(c[i], c[i + 1]); return d; };
  const kwLabel = c => c.power_kw >= 1000 ? (c.power_kw / 1000) + ' MW' : c.power_kw + ' kW';
  // No photo → a glyph in the thumbnail's place (the classic's .charger-glyph, index.html:6506-6512).
  // Inline-styled: desktop.css sizes .chg img / .pick img, and this stands in for them.
  const glyph = (ch, w, h) => `<i style="width:${w}px;height:${h}px;display:inline-flex;align-items:center;justify-content:center;border-radius:2px;background:#dfe0e8;flex:none;font-style:normal;font-size:15px">${ch}</i>`;
  // Catalog values are printed VERBATIM (the classic escHtml's them): CTOL / STOL / eVTOL are cased
  // identifiers, only genuinely lower-case values (electric, hybrid, in development) take a capital.
  const cap1 = s => { s = String(s || ''); return /[A-Z]/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1); };
  const REGIMES = ['VFR', 'IFR+reserves'];               // canonical emitted values (index.html:3677)
  const regShort = r => r === 'IFR+reserves' ? 'IFR' : r;
  const hasBatt = p => !!(p && +p.battery_kwh > 0);      // a non-charging hybrid has no battery at all
  const reachKm = p => usableKm(p);
  const routeFactor = p => (window.CNSSettings && CNSSettings.routingFactor) ? (CNSSettings.routingFactor(p) || 1) : 1;
  function selectPlane(id) { S.planeId = id; S.picking = false; S.availOverride = null; const dc = UI.plane().default_charger_id; if (dc && UI.CHARGERS.find(c => c.id === dc)) S.chargerId = dc; onFormChange(false); }
  function prefsOf(p) { return { label: String(p.profile_label || ''), regime: String(p.regime || ''), propulsion: String(p.propulsion || '') }; }
  // Option 3 · Instrument (static/proto/aircraft-options.html): full-bleed stage with prev/next,
  // status + regime band, name, profile/propulsion knobs, 3×2 spec grid, reach bar, override.
  function aircraftHtml(p, reach, fits, pickHtml) {
    const AC = UI.aircraft, F = S.acFilters; const vis = AC.visible(F); const g = AC.groupOf(p.id); const idx = vis.findIndex(x => g && x.key === g.key);
    const climb = (window.CNSFlight && CNSFlight.climbParams) ? CNSFlight.climbParams(p) : { applies: false };
    const usage = (p.battery_kwh && p.range_km) ? p.battery_kwh / p.range_km * 100 : 0;
    const st = String(p.status || ''), stCls = st.toLowerCase().replace(/[^a-z0-9]+/g, '-'), cert = p.certification_year ? ' · cert. ' + esc(p.certification_year) : '';
    const hasR = r => !!g && g.entries.some(e => String(e.regime || '') === r);
    const labels = g ? [...new Set(g.entries.map(e => String(e.profile_label || '')).filter(Boolean))] : []; const modes = g ? [...new Set(g.entries.map(e => String(e.propulsion || '')).filter(Boolean))] : [];
    const dims = AC.dims(); const active = dims.map(d => F[d.key]).filter(Boolean);
    const summary = active.length ? active.map(v => esc(cap1(v))).join(' · ') : 'All aircraft';
    const pop = S.acFilterOpen ? `<div class="ac-pop">${dims.map(d => `<div class="k">${d.key}</div><div class="chips">${d.values.map(v => { const on = F[d.key] === v; const ok = on || AC.groups().some(gg => AC.matches(gg, Object.assign({}, F, { [d.key]: v }))); return `<button class="chip ${on ? 'on' : ''} ${ok ? '' : 'dis'}" data-act="acFilter" data-dim="${d.key}" data-val="${esc(v)}" ${ok ? '' : 'disabled'}>${esc(cap1(v))}</button>`; }).join('')}</div>`).join('')}${dims.length ? '' : '<div class="hint">The catalog has nothing to filter on yet — every aircraft is the same type and propulsion.</div>'}</div>` : '';
    const img = UI.planeImg(p);
    // Regime knob: the canonical catalog values, labelled short (VFR / IFR) with the classic's
    // titles; a regime the airframe has no profile row for is greyed, never silently "off".
    const rgHtml = REGIMES.map(r => { const exists = hasR(r), on = String(p.regime || '') === r;
      const title = exists ? (r === 'IFR+reserves' ? 'Range incl. IFR reserves' : 'VFR range') : `No ${regShort(r)} profile for this aircraft in the catalog`;
      return `<button data-act="acRegime" data-v="${esc(r)}" class="${on ? 'on' : ''}" aria-pressed="${on}" title="${esc(title)}" ${exists ? '' : 'disabled'}>${esc(regShort(r))}</button>`; }).join('');
    const specLine = [p.seats != null ? p.seats + ' seats' : '', hasBatt(p) ? p.battery_kwh + ' kWh' : 'no charge', p.range_km ? fmt.r(fmt.km(p.range_km)) + ' ' + fmt.ukm() : '', p.speed_kmh ? p.speed_kmh + ' km/h' : ''].filter(Boolean).join(' · ');
    const reachMeta = [`Reach ${fmt.r(fmt.km(reach))} of ${fmt.r(fmt.km(p.range_km || 0))} ${fmt.ukm()}`, usage ? Math.round(usage) + ' kWh/100 km' : '', climb.applies ? '+' + Math.round(climb.eMaxKwh) + ' climb' : '', S.availOverride != null ? '<b>override</b>' : ''].filter(Boolean).join(' · ');
    return `<div class="sec acsec"><div class="lbl"><span class="cap">Aircraft</span><span class="ac-tools"><button class="fbtn" data-act="acFilters">${summary} <span class="ch">▾</span></button><button class="lnk" data-act="pick">${S.picking ? 'Close' : 'Change'}</button>${pop}</span></div>
      ${pickHtml}
      <div class="ac-stage ov"${img ? ` style="background-image:url('${esc(img)}')"` : ''}><button class="ac-arrow l" data-act="acPrev" title="Previous aircraft" ${vis.length > 1 ? '' : 'disabled'}>‹</button><button class="ac-arrow r" data-act="acNext" title="Next aircraft" ${vis.length > 1 ? '' : 'disabled'}>›</button>
        <span class="ac-st"><i class="dot s-${stCls}"></i>${esc(cap1(st) || 'Status unknown')}${cert}</span><span class="seg ac-rg">${rgHtml}</span>
        <div class="ac-ov"><div class="nm"><span class="mk">${esc(p.oem || '')}</span> ${esc(UI.planeShort(p.name).replace(new RegExp('^' + (p.oem || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i'), ''))}</div>
          <div class="sp num">${specLine}</div></div></div>
        <div class="row" style="justify-content:space-between;margin-top:8px"><span class="meta num">${vis.length && idx >= 0 ? (idx + 1) + ' of ' + vis.length : ''}${p.max_charge_kw ? ' · accepts ' + p.max_charge_kw + ' kW' : ''}</span><button class="lnk" data-act="acEdit">${S.availOverride != null ? 'Reset override' : 'Edit for this flight'}</button></div>

      ${labels.length > 1 || modes.length > 1 ? `<div class="chips" style="margin-top:8px">${labels.length > 1 ? `<span class="seg">${labels.map(l => `<button data-act="acLabel" data-v="${esc(l)}" class="${String(p.profile_label || '') === l ? 'on' : ''}">${esc(l)}</button>`).join('')}</span>` : ''}${modes.length > 1 ? `<span class="seg">${modes.map(m => `<button data-act="acMode" data-v="${esc(m)}" class="${String(p.propulsion || '') === m ? 'on' : ''}">${esc(cap1(m))}</button>`).join('')}</span>` : ''}</div>` : ''}
      ${S.availOverride != null ? `<div class="row" style="margin-top:8px"><span class="hint" style="margin:0">Available range for this flight</span><input type="number" min="1" class="num" data-act="acOverride" value="${Math.round(S.availOverride * routeFactor(p))}" style="width:80px;height:26px;border:1px solid var(--line-2);border-radius:var(--r);padding:0 6px;margin-left:auto;background:var(--surface)"><span class="hint" style="margin:0">km</span></div>` : ''}
      ${hasBatt(p) ? `<div class="bar"><i class="${fits ? '' : 'over'}" style="width:${Math.min(100, Math.round(reach / (p.range_km || 1) * 100))}%"></i></div>` : ''}
      <div class="meta num">${reachMeta}</div></div>`;
  }
  const cName = c => c.name.replace(/\s*\d+(\.\d+)?\s*(k|M)W$/, '');

  function acHtml(list) { return list.map(a => `<button data-id="${esc(a.ident)}"><span class="id">${esc(a.ident)}</span><span class="nm">${esc(a.name)}<small>${esc(a.municipality || '')}</small></span><span class="ty">${esc((a.type || '').split('_')[0])}</span></button>`).join(''); }
  // ---- airport fields: the classic's setupAutocomplete (index.html:4076-4105) ----------------
  // Typed-but-unpicked text is remembered per field (S.acText) so a re-render keeps it, the airport
  // behind it is dropped, and the field carries .ac-unset — exactly what the classic shows.
  S.acText = {};
  const slotOf = key => key === 'origin' ? S.origin : key === 'dest' ? S.dest : S.stops[+key.slice(4)];
  const setSlot = (key, ap) => { if (key === 'origin') S.origin = ap; else if (key === 'dest') S.dest = ap; else S.stops[+key.slice(4)] = ap; };
  const acValue = key => { const t = S.acText[key]; if (t != null) return t; const s = slotOf(key); return s ? s.name : ''; };
  const acUnset = key => { const t = S.acText[key]; const s = slotOf(key); return t != null && t.trim() !== '' && (!s || s.name !== t); };
  function syncUnset(input) { input.classList.toggle('ac-unset', acUnset(input.dataset.ac)); }
  // ONE delegated outside-click closer for every field, ever (bindAc used to add one per input per
  // rail render and never remove it).
  document.addEventListener('mousedown', e => { if (e.target.closest('.ac') || e.target.closest('[data-ac]')) return; $$('#railBody .ac.open').forEach(b => b.classList.remove('open')); });
  function bindAc(input, box, onPick) {
    const key = input.dataset.ac; let hl = -1; const prev = slotOf(key);   // the chosen airport at render time — Escape puts it back
    const rows = () => $$('button', box);
    const mark = () => rows().forEach((b, i) => { b.classList.toggle('hl', i === hl); b.classList.toggle('active', i === hl); });   // .hl is the painted state in desktop.css, .active the classic's name
    const close = () => { box.classList.remove('open'); hl = -1; };
    const pick = b => { if (!b) return; close(); delete S.acText[key]; onPick(UI.byId()[b.dataset.id]); };
    input.addEventListener('input', () => {
      S.acText[key] = input.value;
      if (slotOf(key)) setSlot(key, null);          // classic 4085: the chosen airport is gone the moment the text stops naming it
      syncUnset(input);
      const l = UI.search(input.value); box.innerHTML = acHtml(l); hl = -1; box.classList.toggle('open', l.length > 0);
    });
    input.addEventListener('focus', () => { if (box.innerHTML) box.classList.add('open'); });
    input.addEventListener('keydown', e => {
      const n = rows().length;
      // Escape abandons the edit: the field goes back to the airport it named, so the route the
      // operator can still see on the map is the route the state holds.
      if (e.key === 'Escape') { if (S.acText[key] != null) { delete S.acText[key]; setSlot(key, prev); input.value = prev ? prev.name : ''; syncUnset(input); } close(); return; }
      if (!box.classList.contains('open') || !n) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, n - 1); mark(); rows()[hl].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); mark(); rows()[hl].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(rows()[hl >= 0 ? hl : 0]); }
    });
    box.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); pick(b); });
    // Keyboard blur (Tab) must close the list too; 150 ms is long enough for a mousedown pick.
    input.addEventListener('blur', () => setTimeout(() => { box.classList.remove('open'); if (document.body.contains(input)) syncUnset(input); }, 150));
  }
  /** Put the caret back after a pick: the rail re-render replaces the very element that had focus. */
  function refocusAc(key) { setTimeout(() => { const el = $('[data-ac=' + key + ']'); if (!el) return; el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} }, 0); }

  function renderForm() {
    const p = UI.plane(), ch = UI.charger(); const c = UI.chain(); const d = directKm(); const reach = reachKm(p); const P = S.planned; const fits = !P.legIssues.length && !P.error;
    const stopsHtml = S.stops.map((s, i) => `<div class="fld wp" data-stop="${i}"><input placeholder="Add a charging stop…" class="${acUnset('stop' + i) ? 'ac-unset' : ''}" value="${esc(acValue('stop' + i))}" data-ac="stop${i}"><button class="x" data-act="rmStop" data-i="${i}" title="Remove stop"><svg class="ic"><use href="#i-x"/></svg></button><span class="icao">${esc(s ? s.ident : '')}</span><div class="ac" id="ac-stop${i}"></div></div>`).join('');
    const chList = S.allChargers ? UI.CHARGERS.slice().sort((a, b) => b.power_kw - a.power_kw) : [ch, ...UI.CHARGERS.filter(x => x.id !== ch.id).sort((a, b) => Math.abs(a.power_kw - ch.power_kw) - Math.abs(b.power_kw - ch.power_kw)).slice(0, 2)].sort((a, b) => b.power_kw - a.power_kw);
    // Photo precedence + no photo = no <img> (a bare /pics/ is a 404 per row per render); ranges
    // follow the unit toggle like the card does; a battery-less hybrid reads 'no charge'.
    const pickHtml = S.picking ? `<div class="pick">${UI.PLANES.map(x => { const im = UI.planeImg(x);
      return `<button data-act="plane" data-id="${x.id}" class="${x.id === S.planeId ? 'on' : ''}">${im ? `<img src="${esc(im)}" alt="">` : glyph('✈', 56, 36)}<span><span class="n">${esc(x.name)}</span><br><span class="m">${esc(x.oem || '')} · ${x.seats} seats · ${hasBatt(x) ? x.battery_kwh + ' kWh' : 'no charge'} · ${esc(x.status || '')}</span></span><span class="r num">${fmt.r(fmt.km(x.range_km))} ${fmt.ukm()}<small>${esc(regShort(x.regime || ''))}${x.max_charge_kw ? ' · ' + x.max_charge_kw + ' kW max' : ''}</small></span></button>`; }).join('')}</div>` : '';
    $('#railBody').innerHTML = `
    <div class="ph"><h3>Create a route</h3><div class="tools"><span class="hint" style="margin:0">${esc(regShort(p.regime || ''))}${p.range_incl_reserves ? ' · range incl. reserves' : ''}</span></div></div>
    ${aircraftHtml(p, reach, fits, pickHtml)}
    <div class="sec"><div class="lbl"><span class="cap">Route</span><button class="lnk" data-act="addStop">+ Add stop</button></div>
      <div class="fld"><input placeholder="Departure airport" class="${acUnset('origin') ? 'ac-unset' : ''}" value="${esc(acValue('origin'))}" data-ac="origin"><span class="icao">${esc(S.origin ? S.origin.ident : '')}</span><div class="ac" id="ac-origin"></div></div>
      ${stopsHtml}
      ${S.trip === 'training' ? '' : `<div class="fld"><input placeholder="Destination airport" class="${acUnset('dest') ? 'ac-unset' : ''}" value="${esc(acValue('dest'))}" data-ac="dest"><span class="icao">${esc(S.dest ? S.dest.ident : '')}</span><div class="ac" id="ac-dest"></div></div>`}
      ${c.length >= 2 ? routeBlock(c, d, fits) : ''}</div>
    <div class="sec"><div class="cap" style="margin-bottom:8px">Trip type</div><div class="seg sm" data-seg="trip">${Object.keys(tripLabel).map(k => `<button data-v="${k}" class="${S.trip === k ? 'on' : ''}">${tripLabel[k]}</button>`).join('')}</div><div class="hint">${tripHint[S.trip]}</div></div>
    <div class="sec"><div class="cap" style="margin-bottom:8px">Frequency</div><div class="freq"><input type="number" min="1" max="2000" value="${S.freq}" data-act="freq" class="num"><span class="t">routes /</span><div class="seg sm" data-seg="per"><button data-v="day" class="${S.per === 'day' ? 'on' : ''}">day</button><button data-v="week" class="${S.per === 'week' ? 'on' : ''}">week</button></div></div></div>
    <div class="sec"><div class="lbl"><span class="cap">Charger</span><span style="display:flex;gap:10px"><button class="lnk" data-act="ccOpen">Custom</button><button class="lnk" data-act="allChargers">${S.allChargers ? 'Fewer' : 'All chargers'}</button></span></div>
      ${chList.map(x => { const im = x.image_url || (x.image ? '/pics/' + String(x.image).split('/').map(encodeURIComponent).join('/') : '');
        return `<button class="chg ${x.id === S.chargerId ? 'on' : ''}" data-act="charger" data-id="${x.id}">${im ? `<img src="${esc(im)}" alt="">` : glyph('⚡', 48, 32)}<span class="n">${esc(cName(x))}</span><span class="kw num">${kwLabel(x)}</span></button>`; }).join('')}
      ${p.max_charge_kw && ch.power_kw > p.max_charge_kw ? `<div class="hint num">Aircraft accepts max ${p.max_charge_kw} kW — the charger is capped.</div>` : ''}</div>
    ${S.err ? `<div class="sec err">${esc(S.err)}</div>` : ''}`;
    $('#railFoot').innerHTML = `<div class="btns"><button class="btn p ${S.busy ? 'busy' : ''}" data-act="simulate">${S.busy ? 'Simulating…' : 'Simulate'}</button><button class="btn i" id="planReset" data-act="reset" title="Reset"><svg class="ic"><use href="#i-reset"/></svg></button></div>`;
    $$('[data-ac]').forEach(inp => { const key = inp.dataset.ac; bindAc(inp, $('#ac-' + key), a => { setSlot(key, a); onFormChange(true); refocusAc(key); }); });
  }
  function routeBlock(c, d, fits) {
    const P = S.planned, PL = UI.planner; const remedy = P.error ? PL.noRouteRemedy() : null;
    const autoIdents = new Set([...P.stops, ...P.closing].filter(s => s && !S.stops.some(m => m && m.ident === s.ident)).map(s => s.ident));
    const title = P.error ? 'No route' : P.stops.length || P.closing.length ? (P.source === 'user' ? 'Edited route' : 'Suggested route') : 'Direct';
    const legs = c.length - 1;
    const rows = c.map((a, i) => { const bad = i > 0 && P.legIssues.includes(i - 1); const isAuto = i > 0 && i < c.length - 1 && autoIdents.has(a.ident); const ov = S.divertOverrides[a.ident];
      return `<div class="stop ${bad ? 'bad' : ''}"><span class="n num">${String(i + 1).padStart(2, '0')}</span><span>${esc(a.name)}${TYPE_TAG[a.type] ? ` <i class="tt">${TYPE_TAG[a.type]}</i>` : ''}${S.showAlternates && i > 0 ? (ov ? ` <span class="alt">ALT ${esc(ov)} <button class="lnk" data-act="altReset" data-ident="${esc(a.ident)}">reset</button></span>` : ` <button class="lnk alt" data-act="altPick" data-ident="${esc(a.ident)}">divert…</button>`) : ''}</span><span class="d num">${i === 0 ? esc(a.ident) : fmt.dist(dispKm(c[i - 1], a))}${bad ? ' <b style="color:var(--danger)">⚠</b>' : ''}</span>${isAuto ? `<button class="x" data-act="rmPlanned" data-ident="${esc(a.ident)}" title="Remove this stop and plan around it"><svg class="ic"><use href="#i-x"/></svg></button>` : '<span></span>'}</div>`; }).join('');
    const remedyBtn = remedy === 'types' ? `<button class="lnk" data-act="remedyTypes">Enable all airfield sizes</button>` : remedy === 'network' ? `<button class="lnk" data-act="remedyNet">Show charger sites</button>` : remedy === 'both' ? `<button class="lnk" data-act="remedyBoth">Enable all sizes + network</button>` : '';
    // No remedy would fix it → the classic's hard-fail copy (index.html:3211, 3290), which names the
    // real levers; the router's own message only makes sense next to a button that acts on it.
    const errText = P.error ? (remedy ? esc(P.error) : HARD_FAIL) : '';
    return `<div class="route"><div class="rh ${fits ? '' : 'bad'}"><span><b>${title}</b> · ${legs} leg${legs === 1 ? '' : 's'} · <span class="num">${fmt.dist(d)}</span></span><span>${P.error ? '' : fits ? 'fits the usable reach' : 'longest leg exceeds reach'}</span></div>
      ${rows}${P.error ? `<div class="err" style="margin-top:6px">${errText} ${remedyBtn} <button class="lnk" data-act="retry">Retry</button></div>` : ''}
      <div class="row" style="margin-top:8px;gap:8px"><span class="hint" style="margin:0">Prefer</span><select class="sel" data-act="bias">${BIAS.map(([k, l]) => `<option value="${k}" ${S.bias === k ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="sp" style="flex:1"></span>${S.blacklist.size ? `<button class="lnk" data-act="resuggest">Re-suggest</button>` : ''}</div></div>`;
  }
  function onFormChange(fit) { S.acText = {}; S.result = null; S.profile = null; S.err = ''; S.rail = 'form'; if (UI.planner) UI.planner.replan(); UI.render(); UI.map.drawRoute(fit); UI.map.drawAlternates(); if (window.CNSRangeGraph && CNSRangeGraph.refresh) CNSRangeGraph.refresh(); }

  // ---- simulate: the classic payload + the engine profile ---------------------
  const toC = a => ({ ident: a.ident, name: a.name, lat: a.latitude_deg, lon: a.longitude_deg });
  function engineProfile(data) {
    const p = UI.plane(); const o = data._origin, d = data._dest; const wp = x => ({ ident: x.ident, name: x.name, lat: x.lat, lon: x.lon });
    const waypoints = data.trip_type === 'training' ? [wp(o)] : [wp(o), ...(data.stops || []).map(wp), wp(d)];
    return CNSFlight.simulateTrip(p, waypoints, { tripType: data.trip_type, getTargetSoc: () => (window.CNSDemand && CNSDemand.resolveTargetSoc ? CNSDemand.resolveTargetSoc({}) : null), getChargerKw: () => (data.charger && data.charger.power_kw) || UI.charger().power_kw || 0, trainingRangeKm: data.training_range_km });
  }
  /** Every refusal clears the previous result: a stale S.result is a ghost flight waiting to be
      added with the wrong route (the classic nulls lastResult the same way, index.html:5361). */
  function refuse(msg) { S.err = msg; S.result = null; S.profile = null; S.rail = 'form'; S.busy = false; UI.render(); }
  async function simulate() {
    // The classic's own ladder (index.html:5297-5305). Text typed over a chosen airport has already
    // dropped it (bindAc), so this is the refusal an unpicked field lands on.
    if (!S.origin || (S.trip !== 'training' && !S.dest)) {
      return refuse(S.trip === 'training' ? 'Pick a departure airport — training flights loop around it.'
        : S.trip === 'circular' ? 'A circular trip needs a departure and at least one stop — the last stop is the loop\'s far point.'
        : 'Please pick both airports from the suggestions list.');
    }
    if (S.trip === 'circular' && !S.stops.filter(Boolean).length) return refuse('A circular trip needs at least one stop.');
    // An id that is not in the catalog must be SAID, not silently swapped for another aircraft.
    if (S.planeId && !UI.PLANES.some(x => x.id === S.planeId)) {
      const res = UI.resolvePlaneId(S.planeId);
      if (!res) return refuse(`Aircraft ${S.planeId} is not in the catalog.`);
      S.planeId = res; if (UI.planner) UI.planner.replan();
    }
    if (UI.planner) { UI.planner.replan(); if (S.planned.error) return refuse(S.planned.error); }
    const stopShape = s => ({ name: s.name, lat: s.lat, lon: s.lon, ident: s.ident, type: s.type });
    const stops = (UI.planner ? S.planned.stops : S.stops.filter(Boolean).map(toC)).map(stopShape); const p = UI.plane(), ch = UI.charger();
    const payload = { origin: toC(S.origin), destination: S.trip === 'training' ? toC(S.origin) : toC(S.dest), plane_id: S.planeId, charger_id: S.chargerId, trip_type: S.trip };
    if (S.trip === 'training') payload.training_range_km = p.training_range_km || 0;
    if (window.CNSChargers && CNSChargers.get && CNSChargers.get(S.chargerId)) payload.charger = CNSChargers.get(S.chargerId);
    if (S.trip === 'circular') { const ring = [...stops, stopShape(toC(S.dest)), ...(UI.planner ? S.planned.closing.map(stopShape) : [])]; payload.destination = ring[ring.length - 1]; payload.stops = ring.slice(0, -1); }
    else if (stops.length) payload.stops = stops;
    S.busy = true; S.err = ''; UI.render();
    try { const r = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const j = await r.json();
      if (!r.ok || j.error) { S.err = j.error || ('Simulate failed (' + r.status + ')'); S.result = null; S.profile = null; S.rail = 'form'; }
      else { j._origin = toC(S.origin);
        // Circular: the payload destination is the LAST RING NODE (which may be a closing-leg auto
        // stop), not the field the operator named — profiling the named one leaves a 0 km leg and a
        // bogus over-range leg (classic index.html:5365-5372). The named node rides along so
        // addToNetwork can anchor it _manual.
        j._dest = S.trip === 'training' ? toC(S.origin) : S.trip === 'circular' ? Object.assign({}, payload.destination) : toC(S.dest);
        if (S.trip === 'circular') j._namedDestIdent = S.dest.ident;
        j._chargerId = S.chargerId; j._freqN = Math.max(1, Math.min(2000, S.freq)); j._freqUnit = S.per; if (!j.charger) j.charger = { id: ch.id, name: ch.name, power_kw: ch.power_kw };
        S.result = j; S.profile = engineProfile(j); S.rail = 'result'; S.open = { route: true, charging: false, calc: false }; }
    } catch (e) { S.err = 'Simulate failed: ' + e.message; S.result = null; S.profile = null; S.rail = 'form'; }
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
    const batt = hasBatt(p);
    const soc = batt ? UI.soc.series(d.legs, d.charges, p.battery_kwh, climb, { training: d.training }) : null;
    const RES = Math.round((1 - ((window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7)) * 100);
    const X = v => 6 + v * 3.88, Y = v => 6 + (100 - Math.max(0, v)) * 0.72;
    // No battery = nothing to chart: a non-charging hybrid draws nothing from the network, so the
    // classic prints the fact instead of a 0 %-to-0 % curve (index.html:5153, 5190).
    const socSvg = !batt ? `<div class="sec"><div class="hint" style="margin:0">Non-charging aircraft: no battery in the catalog, so this flight draws nothing from the charging network — the grid supplies 0 kWh.</div></div>` : `<div class="soc"><div class="lbl"><span class="cap">Battery</span><span class="r">lowest <b class="${soc.low < RES ? 'low' : ''}">${Math.round(soc.low)} %</b>${(soc.pts.find(q => q.soc === soc.low) || {}).id ? ' at ' + esc(soc.pts.find(q => q.soc === soc.low).id) : ''} · reserve ${RES} %</span></div>
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
    <div class="cost"><div class="v num">€${fmt.eur(costDay)}<small>/ day</small></div><div class="m num">${chargedR} kWh · €${rate.toFixed(2)} / kWh${fpd === 1 ? '' : ` · ${S.freq} / ${S.per}`}</div></div>
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
      <div class="pane calc num"><div><span class="mu">Battery</span> ${batt ? `${p.battery_kwh} kWh · usable ${Math.round(((window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7) * 100)} %` : '— · no battery = non-charging aircraft, the grid supplies 0 kWh'}</div>
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
    // The saved destination is the result's own _dest (for a circular ring the LAST ring node, not
    // the field the operator named — classic index.html:5874).
    const entry = CNSFlightEntry.fromSim(r, { origin: r._origin || toC(S.origin), dest: r._dest || toC(S.trip === 'training' ? S.origin : S.dest), chargerId: S.chargerId, freqN: S.freq, freqUnit: S.per, id: String(Date.now()) });
    // _manual is lost on the sim round-trip; carry it back by ident, or the next recompute re-plans
    // the operator's own stops away (classic index.html:5891-5895). A circular ring additionally
    // anchors the NAMED destination, which now rides in stops.
    if (entry.stops && window.CNSRecompute && CNSRecompute.mergeManualFlags) {
      const planned = (S.planned && S.planned.stops) || [];
      const ref = (S.trip === 'circular' && r._namedDestIdent) ? [...planned, { ident: r._namedDestIdent, _manual: true }] : planned;
      entry.stops = CNSRecompute.mergeManualFlags(entry.stops, ref);
    }
    const folder = CNSDemand.loadFolder(); folder.push(entry); CNSDemand.saveFolder(folder); UI.folderChanged();
    UI.toast(`Added ${UI.chain().map(a => a.ident).join(' → ')} to the network`); UI.map.drawNet(); UI.render();
  }
  /** One-click no-route remedy: tick the Map-menu controls (the classic's `change` dispatch), so the
      menu's own listener sets the state, redraws AND snapshots cns_map_options. */
  function remedy(types, network) {
    let hit = false;
    if (types) $$('.airport-filter').forEach(cb => { if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); hit = true; } });
    if (network) { const t = $('#nrgChargerToggle'); if (t && !t.checked) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); hit = true; } }
    if (!hit) onFormChange(true);   // nothing to tick (no menu in the DOM) — still re-plan
  }
  function resetForm() { UI._applyDefaults(); S.stops = []; S.trip = 'one-way'; S.freq = 1; S.per = 'day'; S.picking = false; S.allChargers = false; S.availOverride = null; S.blacklist.clear(); S.divertOverrides = {}; onFormChange(true); }
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
      case 'share': UI.share.copyRouteLink(); break;
      case 'pick': S.picking = !S.picking; UI.render(); break;
      case 'plane': selectPlane(t.dataset.id); break;
      case 'acFilters': S.acFilterOpen = !S.acFilterOpen; UI.render(); break;
      case 'acFilter': { const F = S.acFilters; F[t.dataset.dim] = F[t.dataset.dim] === t.dataset.val ? null : t.dataset.val; const AC = UI.aircraft; const vis = AC.visible(F); const g = AC.groupOf(S.planeId);
        if (vis.length && (!g || !vis.some(x => x.key === g.key))) selectPlane(AC.pick(vis[0], prefsOf(UI.plane())).id); else UI.render(); break; }
      case 'acPrev': case 'acNext': { const AC = UI.aircraft; const vis = AC.visible(S.acFilters); if (!vis.length) break; const g = AC.groupOf(S.planeId); let i = vis.findIndex(x => g && x.key === g.key); i = (i + (t.dataset.act === 'acNext' ? 1 : -1) + vis.length) % vis.length; selectPlane(AC.pick(vis[i], prefsOf(UI.plane())).id); break; }
      case 'acRegime': case 'acLabel': case 'acMode': { const AC = UI.aircraft; const g = AC.groupOf(S.planeId); if (!g) break; const want = prefsOf(UI.plane()); want[{ acRegime: 'regime', acLabel: 'label', acMode: 'propulsion' }[t.dataset.act]] = t.dataset.v; const e = AC.pick(g, want); if (e.id !== S.planeId) selectPlane(e.id); break; }
      // The field shows the FULL (padded) range; the STORED override is the great-circle base the
      // router consumes — v / routingFactor, exactly like the classic (index.html:4052-4056).
      // Seeding it with the exact current base makes opening the editor a no-op on every number.
      case 'acEdit': { const pl = UI.plane(); const shown = (UI.planner && UI.planner.availRangeShownKm(pl)) || reachKm(pl);
        S.availOverride = S.availOverride != null ? null : shown / routeFactor(pl); onFormChange(false); break; }
      case 'charger': S.chargerId = t.dataset.id; onFormChange(false); break;
      case 'allChargers': S.allChargers = !S.allChargers; UI.render(); break;
      case 'addStop': S.stops.push(null); UI.render(); setTimeout(() => { const i = $$('[data-ac^=stop]').pop(); i && i.focus(); }, 0); break;
      case 'rmStop': S.stops.splice(+t.dataset.i, 1); onFormChange(true); break;
      case 'rmPlanned': S.blacklist.add(t.dataset.ident); onFormChange(true); break;
      case 'resuggest': S.blacklist.clear(); onFormChange(true); break;
      case 'retry': onFormChange(true); break;
      // Drive the Map-menu checkboxes and let their own change listener apply + PERSIST the pools,
      // exactly as the classic's remedy buttons do (index.html:3132, 3207) — reaching past them
      // leaves cns_map_options stale, so the change is lost on reload and invisible to the classic.
      case 'remedyTypes': remedy(true, false); break;
      case 'remedyNet': remedy(false, true); break;
      case 'remedyBoth': remedy(true, true); break;
      case 'altPick': UI.planner.altPick(t.dataset.ident); break;
      case 'altReset': UI.planner.altReset(t.dataset.ident); break;
    }
  });
  document.addEventListener('change', e => { const t = e.target; if (t.dataset.act === 'bias') { S.bias = t.value; onFormChange(false); } if (t.dataset.act === 'freq') { S.freq = Math.max(1, Math.min(2000, +t.value || 1)); if (S.result) UI.render(); } if (t.dataset.act === 'acOverride') { S.availOverride = Math.max(1, +t.value || 1) / routeFactor(UI.plane()); onFormChange(false); } });
  document.addEventListener('mousedown', e => { if (S.acFilterOpen && !e.target.closest('.ac-pop,[data-act=acFilters]')) { S.acFilterOpen = false; UI.render(); } });
  document.addEventListener('input', e => { if (e.target.dataset.act === 'freq') S.freq = Math.max(1, Math.min(2000, +e.target.value || 1)); });

  UI.plan = { render, simulate, resimulate, addToNetwork, derive, legsForMap, onFormChange, resetForm };
})();
