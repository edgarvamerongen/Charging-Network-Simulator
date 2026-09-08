/* CNS v2 — ui/timeline.js: the demand timeline drawer, rendered from CNSScheduler's day.
   Airport lanes = the rotations touching an airport (its charges highlighted, waits striped);
   fleet lanes = the scheduler's aircraft lanes. Load row = concurrent charging kW per 15 min.
   Dragging a rotation writes the desired take-off to cns_schedule, as the classic Gantt does. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc;
  const D = () => window.CNSDemand, SC = () => window.CNSScheduler;
  const H0 = 360, H1 = 1380, SPAN = H1 - H0;            // 06:00 – 23:00 (scheduler DAY_END)
  const pct = m => Math.max(0, Math.min(100, (m - H0) / SPAN * 100)), w = m => Math.max(.4, m / SPAN * 100);
  const clock = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
  const gridMul = () => (window.CNSSettings && CNSSettings.gridDemandFactor) ? CNSSettings.gridDemandFactor() : 1;
  /** 15-min bins of concurrent charging power — the SHADING under the load row. A bin sums every charge that
      touches it, so two consecutive charges sharing one bin add up: `peak` here is an upper bound, NOT the peak.
      Every printed peak comes from eventPeak() / CNSScheduler.summary() instead (aircraft side; × gridMul to print). */
  function loadProfile(lanes, ident) {
    const N = SPAN / 15, load = new Array(N).fill(0);
    lanes.forEach(L => L.rotations.forEach(rot => rot.phases.forEach(ph => { if (ph.kind !== 'charge' || !ph.power || (ident && ph.ident !== ident)) return; const a = Math.max(0, Math.floor((ph.start - H0) / 15)), b = Math.min(N, Math.ceil((ph.start + ph.dur - H0) / 15)); for (let i = a; i < b; i++) load[i] += ph.power; })));
    return { load, peak: load.reduce((m, v) => Math.max(m, v), 0), N };
  }
  /** Event-based concurrent peak (the algorithm CNSScheduler.summary uses, scheduler.js:606-633) over every charge
      phase — with `ident` it equals summary(ident).peakKw exactly; without one it is the whole network's peak. */
  function eventPeak(lanes, ident) {
    if (ident && SC() && SC().summary) return SC().summary(ident).peakKw || 0;
    const evs = [];
    lanes.forEach(L => L.rotations.forEach(rot => rot.phases.forEach(ph => { if (ph.kind !== 'charge' || !ph.power || !(ph.dur > 0)) return; evs.push({ tm: ph.start, d: ph.power }); evs.push({ tm: ph.start + ph.dur, d: -ph.power }); })));
    evs.sort((a, b) => a.tm - b.tm || a.d - b.d);
    let cur = 0, peak = 0; evs.forEach(e => { cur += e.d; if (cur > peak) peak = cur; });
    return peak;
  }
  /** Grid-side peak for display — what the rail row (network.js) and the classic card (index.html:5745) print. */
  const peakKw = (lanes, ident) => eventPeak(lanes, ident) * gridMul();
  const blk = (kind, start, dur, label, title, extra) => `<div class="blk ${kind}" style="left:${pct(start)}%;width:${w(dur)}%" title="${esc(title || '')}" ${extra || ''}>${dur / SPAN * 100 > 5 ? esc(label || '') : ''}</div>`;
  function render() {
    const folder = D() ? D().loadFolder() : []; const R = UI.network ? UI.network.rows() : [];
    const foc = S.filter && R.find(a => a.ident === S.filter) ? S.filter : '';
    const chip = $('#focChip'); chip.hidden = !foc; if (foc) chip.innerHTML = `${foc} ${esc(UI.shortName((UI.byId()[foc] || {}).name || foc))} <svg class="ic" style="width:12px;height:12px"><use href="#i-x"/></svg>`;
    $$('#laneSeg button').forEach(b => b.classList.toggle('on', b.dataset.lanes === S.lanes));
    $('#laneSeg').hidden = false; $('#depSw').hidden = S.lanes === 'fleet'; $('.dep-lbl').hidden = S.lanes === 'fleet'; $('#depSw').classList.toggle('on', S.showDep);
    const ticks = []; for (let m = H0; m < H1; m += 120) ticks.push(`<div class="tick" style="left:${pct(m)}%"><span>${clock(m)}</span></div>`);
    const bare = ticks.map(t => t.replace(/<span>.*?<\/span>/, '')).join('');
    let rows = `<div class="grow axis"><div class="lab"></div><div class="track">${ticks.join('')}</div></div>`, lanes = 0, anyWait = false;
    let laneN = 0; const zebra = () => (laneN++ % 2) ? ' alt' : '';   // banded lanes: a wide network is unreadable without them
    if (!folder.length || !SC()) { rows += `<div class="empty">Add a route to the network to see its charging sessions on the day.</div>`; $('#drawerSub').textContent = 'no flights yet'; }
    else {
      const g = SC().runGlobal(); const prof = loadProfile(g.lanes, foc); const netPeak = peakKw(g.lanes, foc); const flights = folder.reduce((s, t) => s + D().flightsPerDay(t), 0);
      const path = prof.load.map((v, i) => { const y = (40 - (prof.peak ? v / prof.peak * 36 : 0)).toFixed(1); return `L${i} ${y} L${i + 1} ${y}`; }).join(' ');
      rows += `<div class="grow load"><div class="lab">${foc ? foc + ' load' : 'Network load'}<small>peak ${UI.fmt.kw(netPeak)}</small></div><div class="track">${bare}<svg viewBox="0 0 ${prof.N} 40" preserveAspectRatio="none"><path d="M0 40 ${path} L${prof.N} 40 Z"/></svg></div></div>`;
      if (S.lanes === 'fleet') {
        g.lanes.forEach((L, li) => { const t = L.trip; const blocks = L.rotations.map((rot, k) => rot.phases.map(ph => { if (ph.kind === 'charge' && ph.wait > 0) { anyWait = true; } return (ph.kind === 'charge' && ph.wait > 0 ? blk('wait', ph.start - ph.wait, ph.wait, '', `Waits ${Math.round(ph.wait)} min for a charger at ${ph.ident}`) : '') + blk(ph.kind === 'fly' ? 'fly' : 'chg', ph.start, ph.dur, ph.kind === 'fly' ? (ph.label || '').replace(/^Fly (to|back to) /, '→ ') : (ph.ident || ''), `${ph.label || ph.kind} · ${clock(ph.start)}–${clock(ph.start + ph.dur)}${ph.power ? ' · ' + ph.power + ' kW' : ''}`, ph === rot.phases[0] ? `data-drag="${esc(t.id)}:${L.schedSlot != null ? L.schedSlot : k}" data-takeoff="${rot.takeoff}"` : ''); }).join('')).join('');
          rows += `<div class="grow${zebra()}"><div class="lab">${esc(UI.planeShort(t.planeName))}${L.planeTotal > 1 ? ' ' + L.planeIdx : ''}<small>${esc(t.originIdent)} → ${esc(t.destIdent)}</small></div><div class="track">${bare}${blocks}</div></div>`; lanes++; });
        $('#drawerSub').textContent = `${g.lanes.length} aircraft · ${flights % 1 ? flights.toFixed(1) : flights} flights / day · peak load ${UI.fmt.kw(netPeak)}`;
      } else {
        const aps = R.filter(a => (!foc || a.ident === foc) && a.contribs.some(c => c.role));
        aps.forEach(a => { const rl = SC().rotationsAt(a.ident); if (!rl.length) return;
          const apPeak = peakKw(g.lanes, a.ident);   // = rows().peak = the classic card's peak
          rows += `<div class="grow grp"><div class="lab"><button data-act="focus" data-ap="${a.ident}" title="Isolate ${a.ident}">${a.ident}</button><small>${esc(UI.shortName(a.name))} · peak ${UI.fmt.kw(apPeak)}</small></div><div class="track">${bare}</div></div>`; lanes++;
          rl.forEach(L => { const t = L.trip; const blocks = L.rotations.map((rot, k) => { let handled = false; const handle = () => { if (handled) return ''; handled = true; return `data-drag="${esc(t.id)}:${L.schedSlot != null ? L.schedSlot : k}" data-takeoff="${rot.takeoff}"`; };
            return rot.phases.map(ph => { const st = rot.takeoff + ph.start;
              if (ph.kind === 'wait') { anyWait = true; return blk('wait', st, ph.dur, '', ph.label, handle()); }
              if (ph.kind === 'waitElsewhere') return blk('wait away', st, ph.dur, '', ph.label, handle());
              if (ph.kind === 'fly') return S.showDep ? blk('fly', st, ph.dur, (ph.label || '').replace(/^Fly (to|back to) /, '→ '), `${ph.label} · ${clock(st)}–${clock(st + ph.dur)}`, handle()) : '';
              return blk(ph.atX ? 'chg' : 'chg away', st, ph.dur, ph.atX ? (ph.power ? ph.power + ' kW' : '') : '', `${ph.label} · ${clock(st)}–${clock(st + ph.dur)}${ph.power ? ' · ' + ph.power + ' kW' : ''}`, handle()); }).join(''); }).join('');
            rows += `<div class="grow sub${zebra()}"><div class="lab">${esc(UI.planeShort(t.planeName))}${L.planeTotal > 1 ? ' ' + L.planeIdx : ''}<small>${esc(t.originIdent)} → ${esc(t.destIdent)}</small></div><div class="track">${bare}${blocks}</div></div>`; lanes++; }); });
        $('#drawerSub').textContent = foc ? `${(R.find(a => a.ident === foc) || {}).fleet?.length || 0} chargers · peak ${UI.fmt.kw(netPeak)}` : `${R.length} airports · ${flights % 1 ? flights.toFixed(1) : flights} flights / day · peak load ${UI.fmt.kw(netPeak)}`;
      }
    }
    $('#gantt').innerHTML = rows + `<div class="glegend"><span><i class="c"></i>Charging here</span><span><i class="a"></i>Charging elsewhere</span>${anyWait ? '<span><i class="w"></i>Waiting for a charger</span>' : ''}${(S.showDep || S.lanes === 'fleet') ? '<span><i></i>Flying</span>' : ''}<span style="margin-left:auto">Drag a rotation to move its take-off</span></div>`;
    $('#drawer').style.setProperty('--drawer-h', Math.min(Math.round(window.innerHeight * 0.6), 36 + 22 + (folder.length ? 44 : 60) + lanes * 28 + 44) + 'px');
  }
  // ---- drag a rotation → desired take-off (cns_schedule) ----
  let drag = null;
  document.addEventListener('pointerdown', e => { const b = e.target.closest('.blk[data-drag]'); if (!b) return; const track = b.parentElement; drag = { key: b.dataset.drag, takeoff: +b.dataset.takeoff, x0: e.clientX, wpx: track.getBoundingClientRect().width, el: b }; b.setPointerCapture(e.pointerId); e.preventDefault(); });
  document.addEventListener('pointermove', e => { if (!drag) return; const dm = (e.clientX - drag.x0) / drag.wpx * SPAN; drag.el.style.transform = `translateX(${(e.clientX - drag.x0)}px)`; drag.dm = dm; });
  document.addEventListener('pointerup', e => { if (!drag) return; const d = drag; drag = null; d.el.style.transform = '';
    // A plain click is not a drag: below the dead zone nothing is written, re-rendered or toasted (the classic
    // Gantt, static/scheduler.js:761-780, gives no feedback on a click either).
    if (Math.abs(d.dm || 0) < 2.5) return;
    const [tripId, k] = d.key.split(':'); const nt = Math.max(H0 + 60, Math.min(H1, Math.round((d.takeoff + d.dm) / 5) * 5));
    try { const sched = JSON.parse(localStorage.getItem('cns_schedule') || '{}'); const arr = sched[tripId]; if (Array.isArray(arr) && arr.length > +k) { arr[+k] = nt; sched[tripId] = arr; localStorage.setItem('cns_schedule', JSON.stringify(sched)); UI.folderChanged(); UI.render(); UI.toast(`Take-off moved to ${clock(nt)}`); } } catch (err) { console.warn('[v2] reschedule failed', err); }
  });
  document.addEventListener('click', e => { const t = e.target.closest('#laneSeg button,#depSw,.dep-lbl,#focChip,#drawerHead'); if (!t) return;
    if (t.closest('#laneSeg')) { S.lanes = t.dataset.lanes; render(); return; }
    // The caption is the switch's label — it toggles the switch, it does not collapse the drawer.
    if (t.id === 'depSw' || t.classList.contains('dep-lbl')) { S.showDep = !S.showDep; render(); return; }
    if (t.id === 'focChip') { S.filter = ''; UI.render(); UI.map.drawNet(); UI.map.fitNet(); return; }
    if (t.id === 'drawerHead' && !e.target.closest('button')) $('#drawer').classList.toggle('open'); });
  UI.timeline = { render, loadProfile, eventPeak };
})();
