/* CNS v2 — ui/timeline.js: the demand timeline drawer, rendered from CNSScheduler's day.
   Airport lanes = the rotations touching an airport (its charges highlighted, waits striped);
   fleet lanes = the scheduler's aircraft lanes. Load row = charging power over the day, taper included (CNSScheduler.loadCurve), on a kW axis.
   Take-offs are automatic (the scheduler places them) until dragged: a drag FIXES one (CNSScheduler.setTakeoff),
   as the classic Gantt does, and a double-click hands it back to automatic placement. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc;
  const D = () => window.CNSDemand, SC = () => window.CNSScheduler;
  const H0 = 360, H1 = 1380, SPAN = H1 - H0;            // 06:00 – 23:00 (scheduler DAY_END)
  const pct = m => Math.max(0, Math.min(100, (m - H0) / SPAN * 100)), w = m => Math.max(.4, m / SPAN * 100);
  const clock = CNSUnits.fmtClock;   // units.js:45 — one hh:mm formatter (rounds the WHOLE minute, so 07:59.7 reads 08:00, not 07:60)
  const gridMul = () => (window.CNSSettings && CNSSettings.gridDemandFactor) ? CNSSettings.gridDemandFactor() : 1;
  /** Grid-side coincident peak, taper included (CNSScheduler.loadCurve): at `ident`, or the whole network. */
  const peakKw = ident => (ident ? SC().summary(ident).peakKw || 0 : SC().loadCurve(null).peakKw) * gridMul();
  /** A round axis top ≥ v (1, 2, 2.5 or 5 × 10ⁿ steps, as the PDF's load curve). */
  const niceMax = v => { if (!(v > 0)) return 1; const raw = v / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw - 1e-9); return Math.ceil(v / step - 1e-9) * step; };
  /** The load row: charging power over the day on a kW axis. An isolated airport's axis tops at its installed
      chargers, so a full strip reads as every charger drawing full power. */
  function loadRow(foc, R, bare) {
    const gm = gridMul(), lc = SC().loadCurve(foc || null), peak = lc.peakKw * gm, H = 52;
    const inst = foc ? ((R.find(a => a.ident === foc) || {}).fleet || []).reduce((s, c) => s + (+c.power_kw || 0), 0) * gm : 0;
    const top = inst >= peak - 1e-6 && inst > 0 ? inst : niceMax(peak), pk = UI.fmt.prefixFor([top]);
    const X = t => Math.max(0, Math.min(SPAN, t - H0)).toFixed(1), Y = kw => (H - kw * gm / top * (H - 1)).toFixed(2);
    let d = `M0 ${H}`, prev = 0; lc.pts.forEach(p => { d += `L${X(p.t)} ${Y(prev)}L${X(p.t)} ${Y(p.kw)}`; prev = p.kw; });
    d += `L${SPAN} ${Y(prev)}L${SPAN} ${H}Z`;
    const at = v => `bottom:${(v / top * (H - 1)).toFixed(1)}px`, q = v => UI.fmt.as(v, pk, 'W');
    const yax = `<i class="yg" style="${at(top)}"></i><i class="yg" style="${at(top / 2)}"></i><span class="yl" style="${at(top)}">${q(top).n} ${q(top).u}</span><span class="yl" style="${at(top / 2)}">${q(top / 2).n}</span><span class="yl z" style="bottom:0">0</span>`;
    return { peak, html: `<div class="grow load"><div class="lab">${foc ? foc + ' load' : 'Network load'}<small>peak ${UI.fmt.kw(peak)}</small></div><div class="track">${bare}${yax}<svg viewBox="0 0 ${SPAN} ${H}" preserveAspectRatio="none"><path d="${d}"/></svg></div></div>` };
  }
  const fixTick = rot => rot.fixed ? `<i class="fix" style="left:${pct(rot.takeoff)}%"></i>` : '';   // a fixed take-off, marked where it leaves
  const blk = (kind, start, dur, label, title, extra) => `<div class="blk ${kind}" style="left:${pct(start)}%;width:${w(dur)}%" title="${esc(title || '')}" ${extra || ''}>${dur / SPAN * 100 > 5 ? esc(label || '') : ''}</div>`;
  function render() {
    const folder = D() ? D().loadFolder() : []; const R = UI.network ? UI.network.rows() : [];
    const foc = S.filter && R.find(a => a.ident === S.filter) ? S.filter : '';
    const chip = $('#focChip'); chip.hidden = !foc; if (foc) chip.innerHTML = `${foc} ${esc(UI.shortName((UI.byId()[foc] || {}).name || foc))} <svg class="ic" style="width:12px;height:12px"><use href="#i-x"/></svg>`;
    const ticks = []; for (let m = H0; m < H1; m += 120) ticks.push(`<div class="tick" style="left:${pct(m)}%"><span>${clock(m)}</span></div>`);
    const bare = ticks.map(t => t.replace(/<span>.*?<\/span>/, '')).join('');
    let rows = `<div class="grow axis"><div class="lab"></div><div class="track">${ticks.join('')}</div></div>`, lanes = 0, anyWait = false;
    let laneN = 0; const zebra = () => (laneN++ % 2) ? ' alt' : '';   // banded lanes: a wide network is unreadable without them
    if (!folder.length || !SC()) { rows += `<div class="empty">Add a route to the network to see its charging sessions on the day.</div>`; $('#drawerSub').textContent = 'no flights yet'; }
    else {
      const g = SC().runGlobal(); const load = loadRow(foc, R, bare), netPeak = load.peak; const flights = folder.reduce((s, t) => s + D().flightsPerDay(t), 0);
      rows += load.html;
      // The selection decides the view (no lane or departures switches). Nothing isolated: every aircraft once,
      // grouped under its home base (the route's origin). An airport isolated: the aircraft that use it, with
      // charging here vs elsewhere and the waits at other airports.
      const grp = a => `<div class="grow grp"><div class="lab"><button data-act="focus" data-ap="${a.ident}" title="Isolate ${a.ident}">${a.ident}</button><small>${esc(UI.shortName(a.name))} · peak ${UI.fmt.kw(peakKw(a.ident))}</small></div><div class="track">${bare}</div></div>`;
      const lab = (t, L) => `<div class="lab" data-trip="${esc(t.id)}" role="button" tabindex="0" title="Open this route in Plan">${esc(UI.planeShort(t.planeName))}${L.planeTotal > 1 ? ' ' + L.planeIdx : ''}<small>${esc(t.originIdent)} → ${esc(t.destIdent)}</small></div>`;
      if (!foc) {
        const byBase = new Map(); g.lanes.forEach(L => { const k = L.trip.originIdent; if (!byBase.has(k)) byBase.set(k, []); byBase.get(k).push(L); });
        const order = [...R.map(a => a.ident).filter(k => byBase.has(k)), ...[...byBase.keys()].filter(k => !R.some(a => a.ident === k))];
        order.forEach(k => { const a = R.find(x => x.ident === k) || { ident: k, name: (UI.byId()[k] || {}).name || k }; rows += grp(a); lanes++;
          byBase.get(k).forEach(L => { const t = L.trip; const blocks = L.rotations.map((rot, n) => { const hd = `data-drag="${esc(t.id)}:${L.schedSlot != null ? L.schedSlot : n}" data-takeoff="${rot.takeoff}" data-fixed="${rot.fixed ? 1 : 0}"`; return fixTick(rot) + rot.phases.map(ph => { if (ph.kind === 'charge' && ph.wait > 0) { anyWait = true; } return (ph.kind === 'charge' && ph.wait > 0 ? blk('wait', ph.start - ph.wait, ph.wait, '', `Waits ${Math.round(ph.wait)} min for a charger at ${ph.ident}`, hd) : '') + blk(ph.kind === 'fly' ? 'fly' : 'chg', ph.start, ph.dur, ph.kind === 'fly' ? (ph.label || '').replace(/^Fly (to|back to) /, '→ ') : (ph.ident || ''), `${ph.label || ph.kind} · ${clock(ph.start)}–${clock(ph.start + ph.dur)}${ph.power ? ' · ' + ph.power + ' kW' : ''}`, hd); }).join(''); }).join('');
            rows += `<div class="grow sub${zebra()}">${lab(t, L)}<div class="track">${bare}${blocks}</div></div>`; lanes++; }); });
        $('#drawerSub').textContent = `${g.lanes.length} aircraft · ${R.length} airport${R.length === 1 ? '' : 's'} · ${flights % 1 ? flights.toFixed(1) : flights} flight${flights === 1 ? '' : 's'} / day · peak load ${UI.fmt.kw(netPeak)}`;
      } else {
        const a = R.find(x => x.ident === foc), rl = SC().rotationsAt(foc);
        if (rl.length) { rows += grp(a); lanes++; }
        rl.forEach(L => { const t = L.trip; const blocks = L.rotations.map((rot, k) => { const handle = () => `data-drag="${esc(t.id)}:${L.schedSlot != null ? L.schedSlot : k}" data-takeoff="${rot.takeoff}" data-fixed="${rot.fixed ? 1 : 0}"`;   // every block of the strip drags the rotation
          return fixTick(rot) + rot.phases.map(ph => { const st = rot.takeoff + ph.start;
            if (ph.kind === 'wait') { anyWait = true; return blk('wait', st, ph.dur, '', ph.label, handle()); }
            if (ph.kind === 'waitElsewhere') return blk('wait away', st, ph.dur, '', ph.label, handle());
            if (ph.kind === 'fly') return blk('fly', st, ph.dur, (ph.label || '').replace(/^Fly (to|back to) /, '→ '), `${ph.label} · ${clock(st)}–${clock(st + ph.dur)}`, handle());
            return blk(ph.atX ? 'chg' : 'chg away', st, ph.dur, ph.atX ? (ph.power ? UI.fmt.kw(ph.power) : '') : '', `${ph.label} · ${clock(st)}–${clock(st + ph.dur)}${ph.power ? ' · ' + UI.fmt.kw(ph.power) : ''}`, handle()); }).join(''); }).join('');
          rows += `<div class="grow sub${zebra()}">${lab(t, L)}<div class="track">${bare}${blocks}</div></div>`; lanes++; });
        const nCh = (a.fleet || []).length;
        $('#drawerSub').textContent = `${rl.length} aircraft · ${nCh} ${UI.fmt.pl(nCh, 'charger')} · peak ${UI.fmt.kw(netPeak)}`;
      }
    }
    const nFix = folder.length && SC() ? SC().fixedCount() : 0;
    // With no airport isolated there is no "here": one charge colour, one legend entry.
    const chgKey = !foc ? '<span><i class="c"></i>Charging</span>' : '<span><i class="c"></i>Charging here</span><span><i class="a"></i>Charging elsewhere</span>';
    $('#gantt').innerHTML = rows + `<div class="glegend">${chgKey}${anyWait ? '<span><i class="w"></i>Waiting for a charger</span>' : ''}<span><i></i>Flying</span>${nFix ? `<span><i class="fx"></i>Fixed take-off<button class="lnk" data-act="releaseAll">Release ${nFix === 1 ? '' : 'all '}${nFix}</button></span>` : ''}<span style="margin-left:auto">Drag to fix a take-off · double-click to release</span></div>`;
    $('#drawer').style.setProperty('--drawer-h', Math.min(Math.round(window.innerHeight * 0.6), 36 + 22 + (folder.length ? 44 : 60) + lanes * 28 + 44) + 'px');
  }
  // ---- drag a rotation → fixed take-off; double-click → back to automatic (each with an Undo) ----
  const changed = () => { UI.folderChanged(); UI.render(); };
  const undo = prev => ({ label: 'Undo', run: () => { try { if (prev == null) localStorage.removeItem('cns_schedule'); else localStorage.setItem('cns_schedule', prev); } catch (e) { /* private mode */ } changed(); } });
  let drag = null;
  document.addEventListener('pointerdown', e => { const b = e.target.closest('.blk[data-drag]'); if (!b) return; const track = b.parentElement; drag = { key: b.dataset.drag, takeoff: +b.dataset.takeoff, x0: e.clientX, wpx: track.getBoundingClientRect().width, el: b }; b.setPointerCapture(e.pointerId); e.preventDefault(); });
  document.addEventListener('pointermove', e => { if (!drag) return; const dm = (e.clientX - drag.x0) / drag.wpx * SPAN; drag.el.style.transform = `translateX(${(e.clientX - drag.x0)}px)`; drag.dm = dm; });
  document.addEventListener('pointerup', e => { if (!drag) return; const d = drag; drag = null; d.el.style.transform = '';
    // A plain click is not a drag: below the dead zone nothing is written, re-rendered or toasted (the classic
    // Gantt, static/scheduler.js:761-780, gives no feedback on a click either).
    if (Math.abs(d.dm || 0) < 2.5) return;
    const [tripId, k] = d.key.split(':'); const nt = Math.max(H0 + 60, Math.min(H1, Math.round((d.takeoff + d.dm) / 5) * 5));
    try { const prev = localStorage.getItem('cns_schedule'); SC().setTakeoff(tripId, +k, nt); changed(); UI.toast(`Take-off fixed at ${clock(nt)}`, undo(prev)); } catch (err) { console.warn('[v2] reschedule failed', err); }
  });
  document.addEventListener('dblclick', e => { const b = e.target.closest('#gantt .blk[data-drag]'); if (!b) return;
    const [tripId, k] = b.dataset.drag.split(':'), fixed = b.dataset.fixed === '1', at = +b.dataset.takeoff, prev = localStorage.getItem('cns_schedule');
    SC().setTakeoff(tripId, +k, fixed ? null : at); changed(); UI.toast(fixed ? 'Take-off released' : `Take-off fixed at ${clock(at)}`, undo(prev)); });
  const openLane = e => { const lab = e.target.closest && e.target.closest('#gantt .lab[data-trip]'); if (!lab) return false; UI.plan.openTrip(lab.dataset.trip); return true; };
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && openLane(e)) e.preventDefault(); });
  document.addEventListener('click', e => { if (openLane(e)) return; const t = e.target.closest('#focChip,#drawerHead,#gantt [data-act=releaseAll]'); if (!t) return;
    if (t.dataset.act === 'releaseAll') { const prev = localStorage.getItem('cns_schedule'); SC().releaseAll(); changed(); UI.toast('Take-offs released', undo(prev)); return; }
    if (t.id === 'focChip') { S.filter = ''; UI.render(); UI.map.drawNet(); UI.map.fitNet(); return; }
    if (t.id === 'drawerHead' && !e.target.closest('button')) $('#drawer').classList.toggle('open'); });
  UI.timeline = { render, peak: ident => (SC() ? peakKw(ident) : 0) };   // grid side, coincident
})();
