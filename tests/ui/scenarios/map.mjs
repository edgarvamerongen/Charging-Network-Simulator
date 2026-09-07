/* tests/ui/scenarios/map.mjs — the v2 map (static/ui/map.js) against the classic (templates/index.html).
   MAP-1: a REAL click on an airport dot must open its popup (classic: canvas dots under DOM pins, `_bindApCard`).
   Control A = a REAL click on an NRG pin head (DOM marker) — must work in both worlds.
   Control B = the same dot clicks with the covering rt/net/overlay canvases set to pointer-events:none
   (diagnostic; must become a no-op once A0 is fixed).
   MAP-3: the reach graph (#fReachGraph) must draw when the route's endpoint changes (classic pickAirport → CNSRangeGraph.show).
   Everything else: hit radius vs the classic, popup content + actions, route drawing, Map menu, network lines + fit. */
export const component = 'map';
export const module = 'map';

const POP = `!!document.querySelector('.leaflet-popup .pp .acts')`;                       // an airport popup (not a pin popup)
const POP_ID = `(function(){ const e = document.querySelector('.leaflet-popup .pp .ic2'); return e ? e.textContent.trim() : ''; })()`;
const CPOP = `!!document.querySelector('.leaflet-popup .ap-card-meta')`;                    // the classic airport card
const CPOP_ID = `(function(){ const e = document.querySelector('.leaflet-popup .ap-card-meta'); return e ? e.textContent.trim() : ''; })()`;
const OVERRIDE_CSS = '.leaflet-rt-pane canvas, .leaflet-net-pane canvas, .leaflet-overlay-pane canvas { pointer-events: none !important; }';
const LABEL_RE = /^[\d,]+ (km|NM) · \d+:\d\d h · [\d,]+ kWh$/;

// ---- in-page helpers (v2) ---------------------------------------------------------------------
const LAYERS = `(function(kind, pane){ const m = CNSUI.map.map; let n = 0; Object.values(m._layers).forEach(l => { if (pane && (l.options || {}).pane !== pane) return;
  if (kind === 'dot' && (l instanceof L.CircleMarker) && !(l instanceof L.Circle)) n++; else if (kind === 'line' && (l instanceof L.Polyline) && !(l instanceof L.Polygon)) n++;
  else if (kind === 'circle' && (l instanceof L.Circle)) n++; else if (kind === 'tile' && (l instanceof L.TileLayer)) n++; }); return n; })`;
const count = (page, kind, pane) => page.eval(`${LAYERS}(${JSON.stringify(kind)}, ${JSON.stringify(pane || '')})`);
const setOverride = (page, on) => page.eval(`(function(){ let s = document.getElementById('__cnsPeOverride'); if (${on ? 'true' : 'false'}) { if (!s) { s = document.createElement('style'); s.id = '__cnsPeOverride'; document.head.appendChild(s); } s.textContent = ${JSON.stringify(OVERRIDE_CSS)}; } else if (s) s.remove(); return !!document.getElementById('__cnsPeOverride'); })()`);
const mapOpts = page => page.eval(`(function(){ try { return JSON.parse(localStorage.getItem('cns_map_options') || '{}'); } catch (e) { return { parseError: true }; } })()`);
const openMenu = async page => { const open = await page.eval(`document.querySelector('#mapDd').classList.contains('open')`); if (!open) { await page.click('#mapBtn'); await page.waitFor(`document.querySelector('#mapDd').classList.contains('open')`, 1500); } };
const closeMenu = async page => { const open = await page.eval(`document.querySelector('#mapDd').classList.contains('open')`); if (open) { await page.click('.topbar .brand .t'); await page.waitFor(`!document.querySelector('#mapDd').classList.contains('open')`, 1500); } };
/** The classic's counterpart of page.mapPoint (its `map` / `airportByIdent` are top-level lexicals). */
const classicPoint = (page, ident) => page.eval(`(function(){ const a = airportByIdent[${JSON.stringify(ident)}]; if (!a) return null; const p = map.latLngToContainerPoint(L.latLng(a.latitude_deg, a.longitude_deg)); const r = document.getElementById('map').getBoundingClientRect();
  const x = r.left + p.x, y = r.top + p.y; const el = (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) ? document.elementFromPoint(x, y) : null; const pane = el && el.closest('.leaflet-pane');
  return { ident: a.ident, type: a.type, x, y, zoom: map.getZoom(), inView: map.getBounds().contains(L.latLng(a.latitude_deg, a.longitude_deg)) && !!el, topTag: el ? el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).join('.') : '') : null,
    topPane: pane ? (pane.className.split(/\\s+/).find(c => /^leaflet-.+-pane$/.test(c) && c !== 'leaflet-map-pane') || null) : null }; })()`);
/** Nearest-to-centre dot of one type in the v2 view: not an asset, ≥ 30 px from route endpoints, no other visible dot within 24 px, well inside the map. */
const pickType = (page, type) => page.eval(`(function(type){ const S = CNSUI.S, m = CNSUI.map.map; const b = m.getBounds(); const mr = document.getElementById('map').getBoundingClientRect();
  const box = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; }; const rail = box('#rail'), drawer = box('#drawer'); const inBox = (r, x, y) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const vp = a => { const p = m.latLngToContainerPoint(L.latLng(a.latitude_deg, a.longitude_deg)); return [mr.left + p.x, mr.top + p.y]; }; const assets = CNSUI.assets() || {}; const ends = CNSUI.chain().map(vp);
  const cx = mr.left + mr.width / 2, cy = mr.top + mr.height / 2; const vis = CNSUI.airports().filter(a => S.allowedTypes.includes(a.type) && b.contains(L.latLng(a.latitude_deg, a.longitude_deg))).map(a => ({ a, p: vp(a) })); const out = [];
  for (const { a, p } of vis) { if (a.type !== type || assets[a.ident]) continue; const [x, y] = p; if (Math.abs(x - cx) > 380 || Math.abs(y - cy) > 260) continue; if (inBox(rail, x, y) || inBox(drawer, x, y)) continue;
    if (ends.some(e => Math.hypot(e[0] - x, e[1] - y) < 30)) continue; if (vis.some(o => o.a !== a && Math.hypot(o.p[0] - x, o.p[1] - y) < 24)) continue; out.push({ ident: a.ident, type: a.type, x, y, d: Math.hypot(x - cx, y - cy) }); }
  out.sort((p, q) => p.d - q.d); return out[0] || null; })(${JSON.stringify(type)})`);

/** A REAL drag that a Leaflet marker completes: 40 ms between moves and a 200 ms hold before release. page.drag()
    (16 ms steps, immediate release) fires dragstart/drag but the FIRST drag after a setView misses the marker's dragend
    (verified on the classic: no override, marker snaps back) — harness gap, see the report. */
async function slowDrag(page, x0, y0, dx, dy, steps = 8) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none' });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + dx * i / steps, y: y0 + dy * i / steps, button: 'left', buttons: 1 }); await page.sleep(40); }
  await page.sleep(200);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button: 'left', clickCount: 1, buttons: 0 });
}
async function clickDot(page, d, wait = 1500) {
  await page.closePopups(); await page.clickAt(d.x, d.y);
  let opened = true; try { await page.waitFor(POP, wait); } catch (e) { opened = false; }
  const who = opened ? String(await page.eval(POP_ID)).trim() : '';
  return { ident: d.ident, type: d.type, x: +d.x.toFixed(0), y: +d.y.toFixed(0), topPane: d.topPane, topTag: d.topTag, opened: opened && who.startsWith(d.ident), popupFor: who };
}
/** Open the airport popup for `ident`: a real click, else a real click with the pointer-events override, else the marker API (the DOM-marker equivalent). */
async function openDotPopup(page, ident) {
  await page.closePopups();
  const p = await page.mapPoint(ident); if (!p || !p.inView) throw new Error('openDotPopup: ' + ident + ' not in view');
  const tryClick = async () => { await page.clickAt(p.x, p.y); try { await page.waitFor(POP, 1000); } catch (e) { return false; } return String(await page.eval(POP_ID)).startsWith(ident); };
  if (await tryClick()) return { method: 'real click', p };
  await page.closePopups(); await setOverride(page, true); const ok = await tryClick(); await setOverride(page, false);
  if (ok) return { method: 'real click + pointer-events override', p };
  await page.closePopups();
  const viaApi = await page.eval(`(function(){ const a = CNSUI.byId()[${JSON.stringify(ident)}]; const m = CNSUI.map.map; const l = Object.values(m._layers).find(l => (l instanceof L.CircleMarker) && !(l instanceof L.Circle) && (l.options || {}).pane === 'dots' && l.getLatLng().lat === a.latitude_deg && l.getLatLng().lng === a.longitude_deg); if (!l) return false; l.openPopup(); return true; })()`);
  if (!viaApi) throw new Error('openDotPopup: no dot marker for ' + ident);
  await page.waitFor(POP, 1500);
  return { method: 'marker.openPopup() (API fallback — real clicks failed)', p };
}
/** Offset sweep 0..max px (to the right of the dot): the largest offset whose REAL click still opens the popup FOR THAT ident. Stops at the first miss (the hit region is a disc). */
async function sweep(page, ident, { classic = false, max = 6, wait = 800 } = {}) {
  const pt = () => classic ? classicPoint(page, ident) : page.mapPoint(ident);
  const closeAll = async () => { if (classic) { await page.eval(`(function(){ try { map.closePopup(); } catch (e) {} return true; })()`); try { await page.waitFor(`!document.querySelector('.leaflet-popup')`, 2000, 40); } catch (e) {} } else await page.closePopups(); await page.sleep(350); };
  const res = []; let best = -1, top = null;
  for (let off = 0; off <= max; off++) {
    await closeAll(); const p = await pt(); if (!p) break; if (off === 0) top = p.topPane;
    await page.clickAt(p.x + off, p.y);
    let opened = true; try { await page.waitFor(classic ? CPOP : POP, wait); } catch (e) { opened = false; }
    const who = opened ? String(await page.eval(classic ? CPOP_ID : POP_ID)).trim() : '';
    const hit = opened && who.startsWith(ident); res.push(`${off}:${hit ? 'hit' : (opened ? 'other(' + who.slice(0, 8) + ')' : 'miss')}`);
    if (hit) best = off; else break;
  }
  await closeAll();
  return { ident, max: best, top, res: res.join(' ') };
}

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  let classic = null;   // opened lazily (after the small-airfield filter is persisted, so it boots with the same map options)

  // ---- dots-rendered ----------------------------------------------------------------------
  await ctx.check('dots-rendered', async () => {
    const st = await v2.eval(`(function(){ const m = CNSUI.map.map; const panes = {}; document.querySelectorAll('#map .leaflet-pane').forEach(p => { const c = [...p.classList].find(x => /^leaflet-.+-pane$/.test(x) && x !== 'leaflet-map-pane'); if (c) panes[c.replace(/^leaflet-|-pane$/g, '')] = { z: getComputedStyle(p).zIndex, kids: p.children.length, canvas: !!p.querySelector('canvas') }; });
      return { preferCanvas: !!m.options.preferCanvas, zoom: m.getZoom(), allowed: CNSUI.S.allowedTypes, expected: CNSUI.airports().filter(a => CNSUI.S.allowedTypes.includes(a.type)).length, dotsCanvas: !!document.querySelector('.leaflet-dots-pane canvas'), panes }; })()`);
    st.dots = await count(v2, 'dot', 'dots');
    if (!st.dotsCanvas) throw new Error('no canvas in .leaflet-dots-pane: ' + JSON.stringify(st));
    if (st.dots !== st.expected || st.dots < 1000) throw new Error(`${st.dots} dot markers on the map, expected ${st.expected} (allowed ${st.allowed})`);
    await ctx.screenshot(v2, 'dots');
    return { detail: `${st.dots} circleMarkers in pane dots (= ${st.allowed.join('+')}), preferCanvas=${st.preferCanvas}, zoom ${st.zoom}, panes ${JSON.stringify(st.panes)}`, evidence: [ctx.shot('dots')] };
  }, { retry: 0 });

  // ---- control A: a REAL click on the EHTE NRG pin head (DOM marker) opens the plug popup ---
  await ctx.check('pin-click-opens-popup', async () => {
    await v2.eval(`(function(){ CNSUI.map.map.closePopup(); CNSUI.map.flyTo(CNSUI.byId()['EHTE']); return true; })()`);
    await v2.sleep(100); await v2.waitForMapIdle(8000); await v2.sleep(600);   // flyTo opens its own popup after 400 ms
    await v2.closePopups();
    const mp = await v2.mapPoint('EHTE');
    const head = await v2.eval(`(function(){ const t = ${JSON.stringify(mp)}; let best = null; document.querySelectorAll('.nrg-pin .head').forEach(h => { const r = h.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const d = Math.hypot(cx - t.x, cy - t.y); if (!best || d < best.d) best = { cx, cy, d }; }); if (!best) return null; const top = document.elementFromPoint(best.cx, best.cy); best.top = top ? top.tagName.toLowerCase() + '.' + (typeof top.className === 'string' ? top.className : '') : null; return best; })()`);
    if (!head) throw new Error('no .nrg-pin .head in the DOM (assets: ' + JSON.stringify(await v2.eval('Object.keys(CNSUI.assets())')) + ')');
    await v2.clickAt(head.cx, head.cy);
    let opened = true; try { await v2.waitFor(`!!document.querySelector('.leaflet-popup .plugs')`, 2500); } catch (e) { opened = false; }
    const st = await v2.eval(`({ rows: document.querySelectorAll('.leaflet-popup .plugs > div').length, plugs: (CNSUI.assets().EHTE || {}).plugs.length, ic2: (document.querySelector('.leaflet-popup .pp .ic2') || {}).textContent || '' })`);
    await ctx.screenshot(v2, 'pin-click');
    if (!opened) throw new Error(`pin head at (${head.cx.toFixed(0)},${head.cy.toFixed(0)}) top=${head.top} — no .leaflet-popup .plugs after a real click`);
    if (st.rows !== st.plugs || !/^EHTE/.test(st.ic2)) throw new Error(`plug popup rows ${st.rows} ≠ assets().EHTE.plugs.length ${st.plugs} (ic2 ${st.ic2})`);
    return { detail: `EHTE pin at (${head.cx.toFixed(0)},${head.cy.toFixed(0)}) top=${head.top} → plug popup, ${st.rows} plug rows = assets().EHTE.plugs.length`, repro: 'v2: flyTo EHTE, real Input.dispatchMouseEvent on .nrg-pin .head', evidence: [ctx.shot('pin-click')] };
  }, { retry: 0 });
  await v2.closePopups();

  // ---- MAP-1: REAL clicks on 3 picked airport dots ----------------------------------------
  const dots = await v2.pickClickableDots(3); ctx.state.dots = dots;
  const clickDots = async label => { const res = []; for (const d of dots) res.push(await clickDot(v2, d)); await ctx.screenshot(v2, label); return res; };
  const fmtRes = res => res.map(r => `${r.ident}(${r.type.replace('_airport', '')}) @${r.x},${r.y} top=${r.topPane} → ${r.opened ? 'popup ' + r.popupFor : 'NO popup'}`).join('; ');
  await ctx.check('dot-real-click-opens-popup', async () => {
    if (dots.length < 3) throw new Error(`pickClickableDots returned ${dots.length} at zoom ` + await v2.eval('CNSUI.map.map.getZoom()'));
    const res = await clickDots('dot-click'); ctx.state.dotClick = res;
    const bad = res.filter(r => !r.opened);
    if (bad.length) throw new Error(`${bad.length}/${res.length} real dot clicks opened no .leaflet-popup .pp — ${fmtRes(res)}`);
    return { detail: fmtRes(res), repro: 'node tests/ui/run.mjs map --only dot-real-click', evidence: [ctx.shot('dot-click')] };
  }, { retry: 0 });

  // ---- control B: the same clicks with the covering canvases made click-through -----------
  await ctx.check('dot-click-with-pointer-events-override', async () => {
    await setOverride(v2, true);
    const before = dots.map(d => d.topPane); const now = []; for (const d of dots) now.push((await v2.mapPoint(d.ident)).topPane);
    const res = await clickDots('dot-click-override'); ctx.state.dotClickOverride = res;
    await setOverride(v2, false);
    const bad = res.filter(r => !r.opened);
    const detail = `topPane before=${JSON.stringify(before)} with override=${JSON.stringify(now)}; ` + res.map(r => `${r.ident} → ${r.opened ? 'popup ' + r.popupFor : 'NO popup'}`).join('; ') + (ctx.state.dotClick && ctx.state.dotClick.every(r => !r.opened) && res.every(r => r.opened) ? ' — the override MAKES the dots clickable (cause = covering canvases)' : '');
    if (bad.length) throw new Error(`${bad.length}/${res.length} dot clicks still opened no popup with the override — ${detail}`);
    return { detail, repro: 'inject <style> pointer-events:none on .leaflet-rt-pane/.leaflet-net-pane/.leaflet-overlay-pane canvas, click the same dots', evidence: [ctx.shot('dot-click-override')] };
  }, { retry: 0 });

  // ---- popup content + actions ------------------------------------------------------------
  await ctx.check('popup-content-and-actions', async () => {
    await v2.waitForMapIdle(); const [d0] = await v2.pickClickableDots(1); if (!d0) throw new Error('no clickable dot in view');
    const ident = d0.ident; const how = await openDotPopup(v2, ident);
    const c = await v2.eval(`(function(){ const pp = document.querySelector('.leaflet-popup .pp'); if (!pp) return null; const t = pp.querySelector('.t span:first-child'); return { name: t ? t.textContent.trim() : '', ic2: (pp.querySelector('.ic2') || {}).textContent || '', meta: [...pp.querySelectorAll('.m')].map(e => e.textContent.trim()), acts: [...pp.querySelectorAll('.acts button')].map(b => b.textContent.trim()) }; })()`);
    const a = await v2.eval(`(function(){ const a = CNSUI.byId()[${JSON.stringify(ident)}]; const p = CNSUI.plane(); const rw = a.rwy_paved_m || a.rwy_grass_m || a.rwy_unknown_m; return { name: a.name, type: (a.type || '').replace('_', ' '), rw: rw ? Math.round(rw) : null, plane: CNSUI.planeShort(p.name), fit: (window.CNSRunway && CNSRunway.suitability) ? CNSRunway.suitability(p, a) : null }; })()`);
    await ctx.screenshot(v2, 'popup-content');
    const probs = [];
    if (!c) probs.push('no .pp');
    else {
      if (c.name !== a.name) probs.push(`name "${c.name}" ≠ "${a.name}"`);
      if (!c.ic2.startsWith(ident)) probs.push(`ICAO "${c.ic2}" ≠ ${ident}`);
      if (!(c.meta[0] || '').includes(a.type)) probs.push(`type line "${c.meta[0]}" lacks "${a.type}"`);
      const rwTxt = a.rw ? `runway ${a.rw} m` : 'no runway data'; if (!(c.meta[0] || '').includes(rwTxt)) probs.push(`runway text "${c.meta[0]}" lacks "${rwTxt}"`);
      if (!c.meta.some(m => m.startsWith(a.plane + ':'))) probs.push(`no aircraft suitability line for "${a.plane}" in ${JSON.stringify(c.meta)}`);
      if (c.acts.join('|') !== 'Departure|Destination|Stop') probs.push(`actions ${JSON.stringify(c.acts)}`);
    }
    if (probs.length) throw new Error(`popup for ${ident} (${how.method}): ` + probs.join('; '));
    // actions — each on a freshly picked dot (the previous action re-fits the map)
    const act = async (label, nth, read) => {
      await v2.waitForMapIdle(); const [d] = await v2.pickClickableDots(1); if (!d) throw new Error('no clickable dot for ' + label);
      const h = await openDotPopup(v2, d.ident); await v2.click(`.leaflet-popup .pp .acts button:nth-child(${nth})`); await v2.sleep(300);
      const st = await v2.eval(`({ got: ${read}, popup: !!document.querySelector('.leaflet-popup'), popupFor: (document.querySelector('.leaflet-popup .pp .ic2') || {}).textContent || '' })`);
      return Object.assign({ label, ident: d.ident, method: h.method }, st); };
    const r1 = await act('Departure', 1, `CNSUI.S.origin && CNSUI.S.origin.ident`);
    const r2 = await act('Stop', 3, `(CNSUI.S.stops.slice(-1)[0] || {}).ident`);
    const r3 = await act('Destination', 2, `CNSUI.S.dest && CNSUI.S.dest.ident`);
    await ctx.screenshot(v2, 'popup-after-action');
    ctx.state.popupActions = [r1, r2, r3];
    await v2.eval(`(function(){ CNSUI.plan.resetForm(); return true; })()`);
    const wrong = [r1, r2, r3].filter(r => r.got !== r.ident);
    const detail = `content ok for ${ident} via ${how.method} (${JSON.stringify(c.meta)}); ` + [r1, r2, r3].map(r => `${r.label}(${r.ident}) → S=${r.got}, popup ${r.popup ? 'STILL OPEN (' + r.popupFor + ')' : 'closed'}`).join('; ');
    if (wrong.length) throw new Error('action did not set the state: ' + detail);
    return { detail, repro: 'node tests/ui/run.mjs map --only popup-content', evidence: [ctx.shot('popup-content'), ctx.shot('popup-after-action')] };
  }, { retry: 0 });
  await ctx.check('popup-closes-after-action', async () => {
    const acts = ctx.state.popupActions; if (!acts) throw new Error('popup-content-and-actions did not run');
    const open = acts.filter(r => r.popup);
    const detail = acts.map(r => `${r.label}(${r.ident}) → popup ${r.popup ? 'STILL OPEN (' + r.popupFor + ')' : 'closed'}`).join('; ');
    if (open.length) throw new Error(`popup stays open after ${open.map(r => r.label).join('/')} — the classic closes the card (index.html:2716 setOrigin → map.closePopup(); 4287-4289 closeAirportCard()) — ` + detail);
    return { detail, repro: 'node tests/ui/run.mjs map --only popup-closes', evidence: [ctx.shot('popup-after-action')] };
  }, { retry: 0 });

  // ---- route drawing ----------------------------------------------------------------------
  await ctx.check('route-drawing', async () => {
    const chain = await v2.eval(`(function(){ const S = CNSUI.S, by = CNSUI.byId(); S.origin = by.EHLE; S.dest = by.EDDM; S.stops = [by.EDDF]; S.trip = 'one-way'; S.blacklist.clear(); S.divertOverrides = {}; CNSUI.plan.onFormChange(true); return CNSUI.chain().map(a => a.ident); })()`);
    const read = () => v2.eval(`(function(){ const m = CNSUI.map.map; const lines = Object.values(m._layers).filter(l => (l instanceof L.Polyline) && !(l instanceof L.Polygon) && (l.options || {}).pane === 'rt').map(l => ({ dash: l.options.dashArray || null, w: l.options.weight, c: l.options.color }));
      return { chain: CNSUI.chain().map(a => a.ident), ep: document.querySelectorAll('.ep').length, stop: document.querySelectorAll('.ep.stop').length, labels: [...document.querySelectorAll('.leglbl')].map(e => e.textContent.trim()), lines, circles: Object.values(m._layers).filter(l => l instanceof L.Circle && (l.options || {}).pane === 'rt').map(l => l.getRadius()), showLabels: CNSUI.S.showLabels }; })()`);
    const pre = await read();
    const sim = await ctx.v2Simulate(v2); if (sim.err) throw new Error('simulate failed: ' + sim.err);
    await v2.waitForMapIdle(); const post = await read();
    const expect = await v2.eval(`(function(){ const legs = CNSUI.plan.legsForMap() || []; const f = CNSUI.fmt; return legs.map(l => f.dist(l.distKm) + ' · ' + f.h(l.flightMin) + ' h · ' + f.r(l.energyKwh) + ' kWh'); })()`);
    await ctx.screenshot(v2, 'route');
    const probs = [];
    const n = post.chain.length; if (n < 3) probs.push('chain ' + JSON.stringify(post.chain));
    if (post.ep !== n) probs.push(`.ep ${post.ep} ≠ chain ${n}`); if (post.stop !== n - 2) probs.push(`.ep.stop ${post.stop} ≠ ${n - 2}`);
    if (post.labels.length !== n - 1) probs.push(`.leglbl ${post.labels.length} ≠ legs ${n - 1}`);
    post.labels.forEach((t, i) => { if (!LABEL_RE.test(t)) probs.push(`label[${i}] "${t}" not 'km · h:mm h · kWh'`); else if (t !== expect[i]) probs.push(`label[${i}] "${t}" ≠ engine "${expect[i]}"`); });
    if (pre.labels.length !== n - 1 || pre.labels.some(t => !/^[\d,]+ (km|NM)$/.test(t))) probs.push(`pre-simulate labels ${JSON.stringify(pre.labels)} (expected distance-only per leg)`);
    if (post.lines.length !== 2 || post.lines.some(l => l.dash)) probs.push(`one-way route lines ${JSON.stringify(post.lines)} (expected casing + accent, no dash)`);
    // labels toggle (Map menu → Leg labels)
    await openMenu(v2); await v2.click('#flightLabelToggle'); await v2.sleep(150); const off = await read(); await v2.click('#flightLabelToggle'); await v2.sleep(150); const on = await read(); await closeMenu(v2);
    if (off.labels.length !== 0 || off.showLabels !== false) probs.push(`#flightLabelToggle off → ${off.labels.length} labels (showLabels ${off.showLabels})`);
    if (on.labels.length !== n - 1) probs.push(`#flightLabelToggle on again → ${on.labels.length} labels`);
    // return trip → dashed overlay; training → circle
    await v2.eval(`(function(){ CNSUI.S.trip = 'retour'; CNSUI.plan.onFormChange(false); return true; })()`); const ret = await read();
    if (!(ret.lines.length === 3 && ret.lines.some(l => l.dash))) probs.push(`return trip lines ${JSON.stringify(ret.lines)} (expected a dashed overlay)`);
    await ctx.screenshot(v2, 'route-return');
    await v2.eval(`(function(){ CNSUI.S.trip = 'training'; CNSUI.plan.onFormChange(false); return true; })()`); const tr = await read();
    if (!(tr.circles.length === 1 && tr.circles[0] > 0 && tr.ep === 0 && tr.lines.length === 0)) probs.push(`training → circles ${JSON.stringify(tr.circles)} ep ${tr.ep} lines ${tr.lines.length}`);
    await v2.eval(`(function(){ CNSUI.S.trip = 'one-way'; CNSUI.plan.onFormChange(true); return true; })()`);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `chain ${post.chain.join('→')}: ${post.ep} .ep (${post.stop} stop), labels ${JSON.stringify(post.labels)} = engine; toggle off→0/on→${on.labels.length}; return ${ret.lines.length} lines (dash ${ret.lines.filter(l => l.dash).map(l => l.dash)}); training circle r=${tr.circles[0]} m`, repro: 'node tests/ui/run.mjs map --only route-drawing', evidence: [ctx.shot('route'), ctx.shot('route-return')] };
  }, { retry: 0 });

  // ---- Map menu: small airfields + zoom 8 -------------------------------------------------
  await ctx.check('map-menu-small-airfields', async () => {
    await openMenu(v2);
    const before = await count(v2, 'dot', 'dots');
    await v2.click('#mapDd .airport-filter[value=small_airport]'); await v2.sleep(100);
    const z7 = await v2.eval(`(function(){ CNSUI.map.map.setView([52.0, 5.5], 7, { animate: false }); return CNSUI.map.map.getZoom(); })()`); const at7 = await count(v2, 'dot', 'dots');
    const z8 = await v2.eval(`(function(){ CNSUI.map.map.setView([52.0, 5.5], 8, { animate: false }); return CNSUI.map.map.getZoom(); })()`); const at8 = await count(v2, 'dot', 'dots');
    const st = await v2.eval(`({ allowed: CNSUI.S.allowedTypes, checked: document.querySelector('#mapDd .airport-filter[value=small_airport]').checked, smallTotal: CNSUI.airports().filter(a => a.type === 'small_airport').length })`);
    const opts = await mapOpts(v2); await closeMenu(v2);
    const small = await pickType(v2, 'small_airport');
    await ctx.screenshot(v2, 'small-dots');
    if (!st.checked || !st.allowed.includes('small_airport')) throw new Error('filter not applied: ' + JSON.stringify(st));
    if (at8 - before < 1000 || at8 !== before + st.smallTotal) throw new Error(`small dots at zoom ${z8}: ${at8 - before} added (before ${before}, small in catalog ${st.smallTotal})`);
    if (opts.fSmall !== true) throw new Error('cns_map_options.fSmall not persisted: ' + JSON.stringify(opts));
    if (!small) throw new Error('no small dot pickable near the centre at zoom 8');
    return { detail: `small on → zoom ${z7}: ${at7 - before} small dots (hidden below 7.5 by design), zoom ${z8}: ${at8 - before} = catalog ${st.smallTotal}; fSmall persisted; pickable small ${small.ident}`, repro: 'node tests/ui/run.mjs map --only small-airfields', evidence: [ctx.shot('small-dots')] };
  }, { retry: 0 });

  // ---- Map menu: Large / Medium size filters ----------------------------------------------
  await ctx.check('map-menu-size-filters', async () => {
    const totals = await v2.eval(`(function(){ const t = {}; CNSUI.airports().forEach(a => t[a.type] = (t[a.type] || 0) + 1); return t; })()`);
    const all = await count(v2, 'dot', 'dots');
    await openMenu(v2); await v2.click('#mapDd .airport-filter[value=large_airport]'); await v2.sleep(150);
    const noLarge = { dots: await count(v2, 'dot', 'dots'), allowed: await v2.eval('CNSUI.S.allowedTypes'), opts: await mapOpts(v2) };
    await v2.click('#mapDd .airport-filter[value=large_airport]'); await v2.sleep(150);
    const back = { dots: await count(v2, 'dot', 'dots'), allowed: await v2.eval('CNSUI.S.allowedTypes'), opts: await mapOpts(v2) }; await closeMenu(v2);
    const probs = [];
    if (noLarge.dots !== all - totals.large_airport || noLarge.allowed.includes('large_airport') || noLarge.opts.fLarge !== false) probs.push(`Large off → ${noLarge.dots} dots (expected ${all - totals.large_airport}), allowed ${noLarge.allowed}, fLarge ${noLarge.opts.fLarge}`);
    if (back.dots !== all || !back.allowed.includes('large_airport') || back.opts.fLarge !== true) probs.push(`Large on → ${back.dots} dots (expected ${all}), fLarge ${back.opts.fLarge}`);
    if (probs.length) throw new Error(probs.join('; '));
    return `Large off → ${noLarge.dots} dots (−${totals.large_airport} large, fLarge=false persisted); on → ${back.dots}`;
  }, { retry: 0 });

  // ---- hit radius sweep vs the classic ----------------------------------------------------
  await ctx.check('dot-hit-radius', async () => {
    if (!(await v2.eval(`CNSUI.S.allowedTypes.includes('small_airport')`))) { await openMenu(v2); await v2.click('#mapDd .airport-filter[value=small_airport]'); await v2.sleep(100); await closeMenu(v2); }   // self-sufficient under --only
    await v2.eval(`(function(){ CNSUI.map.map.setView([52.0, 5.5], 8, { animate: false }); return true; })()`); await v2.closePopups();
    const picks = {}; for (const t of ['large_airport', 'medium_airport', 'small_airport']) picks[t] = await pickType(v2, t);
    const missing = Object.entries(picks).filter(([, p]) => !p).map(([t]) => t); if (missing.length) throw new Error('no isolated dot near the centre for ' + missing.join(', '));
    const v2r = {};
    for (const [t, p] of Object.entries(picks)) { let r = await sweep(v2, p.ident); let mode = 'plain'; if (r.max < 0) { await setOverride(v2, true); r = await sweep(v2, p.ident); await setOverride(v2, false); mode = 'pointer-events override'; } v2r[t] = Object.assign({ mode }, r); }
    await ctx.screenshot(v2, 'hit-radius-v2');
    // classic control: same airports, same centre + zoom (its dots scale ×0.9 at z ≥ 8)
    classic = classic || await ctx.classicPage(v2.browser);
    const cst = await classic.eval(`(function(){ const cb = document.getElementById('fSmall'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } map.closePopup(); map.setView([52.0, 5.5], 8, { animate: false }); return { small: !!(cb && cb.checked), zoom: map.getZoom(), origin: selected.origin && selected.origin.ident, dest: selected.destination && selected.destination.ident }; })()`);
    await classic.sleep(400);
    const cr = {}; for (const [t, p] of Object.entries(picks)) cr[t] = await sweep(classic, p.ident, { classic: true });
    await ctx.screenshot(classic, 'hit-radius-classic');
    ctx.state.hit = { v2: v2r, classic: cr };
    const line = t => `${t.replace('_airport', '')} ${picks[t].ident}: v2 max ${v2r[t].max} px (${v2r[t].mode}; ${v2r[t].res}) vs classic ${cr[t].max} px (${cr[t].res})`;
    const detail = Object.keys(picks).map(line).join(' | ') + ` [classic ${JSON.stringify(cst)}]`;
    const bad = Object.keys(picks).filter(t => v2r[t].max < 0 || cr[t].max < 0 || v2r[t].max < cr[t].max - 1);
    if (bad.length) throw new Error(`hit radius below the classic for ${bad.map(t => t.replace('_airport', '')).join(', ')} — ` + detail);
    return { detail, repro: 'node tests/ui/run.mjs map --only dot-hit-radius', evidence: [ctx.shot('hit-radius-v2'), ctx.shot('hit-radius-classic')] };
  }, { retry: 0 });

  // ---- classic control: dot click → card → Origin closes the card + sets the state --------
  await ctx.check('classic-card-actions-control', async () => {
    classic = classic || await ctx.classicPage(v2.browser);
    const p = await pickType(v2, 'medium_airport'); if (!p) throw new Error('no medium dot to test on');
    await classic.eval(`(function(){ map.closePopup(); map.setView([52.0, 5.5], 8, { animate: false }); return true; })()`); await classic.sleep(400);
    const cp = await classicPoint(classic, p.ident); await classic.clickAt(cp.x, cp.y); await classic.waitFor(CPOP, 2000);
    const meta = await classic.eval(CPOP_ID);
    await classic.click('.leaflet-popup .ap-card-btn:nth-child(1)'); await classic.sleep(300);
    const st = await classic.eval(`({ origin: selected.origin && selected.origin.ident, popup: !!document.querySelector('.leaflet-popup') })`);
    await ctx.screenshot(classic, 'classic-card');
    if (!meta.startsWith(p.ident)) throw new Error(`classic card for ${meta} ≠ ${p.ident}`);
    if (st.origin !== p.ident || st.popup) throw new Error('classic Origin button: ' + JSON.stringify(st));
    return { detail: `classic: real click at (${cp.x.toFixed(0)},${cp.y.toFixed(0)}) top=${cp.topPane} → card "${meta}"; Origin → selected.origin=${st.origin}, popup closed=${!st.popup}`, evidence: [ctx.shot('classic-card')] };
  }, { retry: 0 });

  // ---- Map menu: NRG chargers toggle ------------------------------------------------------
  await ctx.check('map-menu-nrg-toggle', async () => {
    const known = await v2.eval(`Object.keys(CNSUI.assets()).filter(k => !!CNSUI.byId()[k]).length`);
    await openMenu(v2); await v2.click('#nrgChargerToggle'); await v2.sleep(150);
    const off = await v2.eval(`({ pins: document.querySelectorAll('.nrg-pin').length, show: CNSUI.S.showAssets })`); const o1 = await mapOpts(v2);
    await v2.click('#nrgChargerToggle'); await v2.sleep(150);
    const on = await v2.eval(`({ pins: document.querySelectorAll('.nrg-pin').length, show: CNSUI.S.showAssets })`); const o2 = await mapOpts(v2); await closeMenu(v2);
    if (off.pins !== 0 || off.show !== false || o1.nrgChargerToggle !== false) throw new Error(`off → ${JSON.stringify(off)}, persisted ${o1.nrgChargerToggle}`);
    if (on.pins !== known || on.show !== true || o2.nrgChargerToggle !== true) throw new Error(`on → ${JSON.stringify(on)} (expected ${known} pins), persisted ${o2.nrgChargerToggle}`);
    return `off → 0 .nrg-pin (persisted false); on → ${on.pins} = assets with a catalog airport (persisted true)`;
  }, { retry: 0 });

  // ---- network lines + fit (2 flights) ----------------------------------------------------
  await ctx.check('network-lines-and-fit', async () => {
    const seeded = await ctx.seedNetwork(v2, [{ o: 'EHLE', d: 'EDDF' }, { o: 'EHAM', d: 'EHGG' }]);
    const bad = seeded.filter(s => s.err); if (bad.length) throw new Error('seed failed: ' + JSON.stringify(bad));
    const folder = await v2.eval(`CNSDemand.loadFolder().length`); if (folder !== 2) throw new Error('folder has ' + folder);
    await v2.waitForMapIdle();
    const plan = await v2.eval(`({ ep: document.querySelectorAll('.ep').length, chain: CNSUI.chain().length, mode: CNSUI.S.mode })`);
    await v2.click('#modeSeg [data-mode=network]'); await v2.sleep(200); await v2.waitForMapIdle();
    const net = await v2.eval(`(function(){ const m = CNSUI.map.map; const b = m.getBounds(); const pts = []; CNSDemand.loadFolder().forEach(t => { pts.push([t.originLat, t.originLon], [t.destLat, t.destLon]); (t.stops || []).forEach(s => pts.push([s.lat, s.lon])); });
      return { mode: CNSUI.S.mode, ep: document.querySelectorAll('.ep').length, net: document.body.classList.contains('net'), inBounds: pts.filter(p => b.contains(L.latLng(p[0], p[1]))).length, pts: pts.length, zoom: m.getZoom(), lbl: document.querySelectorAll('.leglbl').length }; })()`);
    net.lines = await count(v2, 'line', 'net');
    await ctx.screenshot(v2, 'network-mode');
    await v2.click('#modeSeg [data-mode=plan]'); await v2.sleep(200); await v2.waitForMapIdle();
    const back = await v2.eval(`({ mode: CNSUI.S.mode, ep: document.querySelectorAll('.ep').length, chain: CNSUI.chain().length })`); back.lines = await count(v2, 'line', 'net'); back.rt = await count(v2, 'line', 'rt');
    await ctx.screenshot(v2, 'plan-mode-back');
    const probs = [];
    if (plan.ep !== plan.chain) probs.push(`plan mode before: .ep ${plan.ep} ≠ chain ${plan.chain}`);
    if (net.mode !== 'network' || !net.net) probs.push('mode switch failed ' + JSON.stringify(net));
    if (net.ep !== 0 || net.lbl !== 0) probs.push(`route not hidden in Network mode (.ep ${net.ep}, .leglbl ${net.lbl})`);
    if (net.lines !== 2) probs.push(`network lines ${net.lines} ≠ folder 2`);
    if (net.inBounds !== net.pts) probs.push(`map not fitted: ${net.inBounds}/${net.pts} flight points in view`);
    if (back.ep !== back.chain || back.rt < 2) probs.push(`route not restored in Plan mode (.ep ${back.ep}, chain ${back.chain}, rt lines ${back.rt})`);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `2 flights → Network: .ep ${net.ep}, ${net.lines} net lines, ${net.inBounds}/${net.pts} points in view at zoom ${net.zoom}; Plan: .ep ${back.ep} = chain ${back.chain}, rt lines ${back.rt}`, repro: 'node tests/ui/run.mjs map --only network-lines', evidence: [ctx.shot('network-mode'), ctx.shot('plan-mode-back')] };
  }, { retry: 0 });

  // ---- alternates overlay must not linger in Network mode ----------------------------------
  await ctx.check('alternates-cleared-in-network-mode', async () => {
    await openMenu(v2); await v2.click('#fAlternates'); await v2.sleep(200); await closeMenu(v2);
    const cnt = () => v2.eval(`({ markers: document.querySelectorAll('.divert-marker-wrap').length, labels: document.querySelectorAll('.alt-dist-label').length, show: CNSUI.S.showAlternates, mode: CNSUI.S.mode })`);
    const plan = await cnt();
    if (!plan.show) throw new Error('#fAlternates did not set S.showAlternates');
    if (!plan.markers) throw new Error('no divert markers drawn in Plan mode for the current route (' + JSON.stringify(plan) + ') — cannot test lingering');
    await v2.click('#modeSeg [data-mode=network]'); await v2.sleep(300); const net = await cnt(); await ctx.screenshot(v2, 'alternates-network');
    await v2.click('#modeSeg [data-mode=plan]'); await v2.sleep(300); const back = await cnt();
    await openMenu(v2); await v2.click('#fAlternates'); await v2.sleep(100); await closeMenu(v2);
    const detail = `plan: ${plan.markers} divert markers; network: ${net.markers} (route hidden); back to plan: ${back.markers}`;
    if (net.markers !== 0) throw new Error(`divert overlay lingers in Network mode while the route is hidden (map.js drawAlternates() is not called by app.js setMode) — ` + detail);
    if (back.markers !== plan.markers) throw new Error('overlay not restored in Plan mode — ' + detail);
    return { detail, repro: 'node tests/ui/run.mjs map --only alternates-cleared', evidence: [ctx.shot('alternates-network')] };
  }, { retry: 0 });

  // ---- alternates: a REAL drag of the divert handle must re-snap the divert (classic: onChange → divertOverrides) ----
  await ctx.check('alternates-drag', async () => {
    await v2.eval(`(function(){ const S = CNSUI.S, by = CNSUI.byId(); S.origin = by.EHLE; S.dest = by.EDDF; S.stops = []; S.trip = 'one-way'; S.divertOverrides = {}; CNSUI.plan.onFormChange(true); return true; })()`);
    await openMenu(v2); await v2.click('#fAlternates'); await v2.sleep(200); await closeMenu(v2); await v2.waitForMapIdle();
    // zoom 10 around the arrival so the handle (EDFE, 10 km from EDDF) is clear of the arrival marker in BOTH shells
    const HANDLE = `(function(){ const m = document.querySelector('.divert-marker-wrap'); if (!m) return null; const r = m.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy); const tip = document.querySelector('.alt-dist-label');
      return { x: cx, y: cy, w: r.width, h: r.height, tip: tip ? tip.textContent.trim() : '', covered: !(top === m || m.contains(top)), top: top ? top.tagName.toLowerCase() + '.' + (typeof top.className === 'string' ? top.className.trim().split(/\\s+/).join('.') : '') : null, interactive: m.classList.contains('leaflet-interactive'), draggable: m.classList.contains('leaflet-marker-draggable') }; })()`;
    await v2.eval(`(function(){ const a = CNSUI.byId().EDDF; CNSUI.map.map.setView([a.latitude_deg, a.longitude_deg], 10, { animate: false }); return true; })()`); await v2.sleep(500);
    const before = await v2.eval(HANDLE); if (before) before.overrides = await v2.eval('Object.assign({}, CNSUI.S.divertOverrides)');
    if (!before) throw new Error('no .divert-marker-wrap for EHLE→EDDF with #fAlternates on');
    const n0 = v2.errors.length;
    await slowDrag(v2, before.x, before.y, 45, 10); await v2.sleep(400);
    const after = await v2.eval(`(function(){ const m = document.querySelector('.divert-marker-wrap'); const r = m ? m.getBoundingClientRect() : null; const tip = document.querySelector('.alt-dist-label'); return { x: r ? r.left + r.width / 2 : null, y: r ? r.top + r.height / 2 : null, tip: tip ? tip.textContent.trim() : '', overrides: Object.assign({}, CNSUI.S.divertOverrides) }; })()`);
    const ex = v2.errors.slice(n0).filter(e => e.type === 'exception'); ctx.state.dragExceptions = new Set(ex);   // attributed here; no-exceptions must not count them twice
    await ctx.screenshot(v2, 'alternates-drag');
    await openMenu(v2); await v2.click('#fAlternates'); await v2.sleep(100); await closeMenu(v2);
    // classic control: same route, same drag on its divert handle
    classic = classic || await ctx.classicPage(v2.browser);
    await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', trip: 'one-way' });
    await classic.eval(`(function(){ const cb = document.getElementById('fAlternates'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } map.closePopup(); const a = airportByIdent.EDDF; map.setView([a.latitude_deg, a.longitude_deg], 10, { animate: false }); return true; })()`); await classic.sleep(500);
    const cb = await classic.eval(HANDLE); if (cb) cb.overrides = await classic.eval('Object.assign({}, divertOverrides)');
    let ca = null, cex = [];
    if (cb) { const c0 = classic.errors.length; await slowDrag(classic, cb.x, cb.y, 45, 10); await classic.sleep(400);
      ca = await classic.eval(`(function(){ const tip = document.querySelector('.alt-dist-label'); return { tip: tip ? tip.textContent.trim() : '', overrides: Object.assign({}, divertOverrides) }; })()`); cex = classic.errors.slice(c0).filter(e => e.type === 'exception' && !ctx.isKnownClassic(e));
      await ctx.screenshot(classic, 'alternates-drag-classic');
      await classic.eval(`(function(){ const cb = document.getElementById('fAlternates'); if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); }
    const detail = `v2: handle ${before.w}×${before.h} at (${before.x.toFixed(0)},${before.y.toFixed(0)}) top=${before.top} tip "${before.tip}" → drag +45,+10 → tip "${after.tip}", overrides ${JSON.stringify(after.overrides)}, exceptions ${ex.length}${ex.length ? ' [' + ex[0].text.split('\n')[0].slice(0, 160) + ']' : ''}; classic control: ${cb ? `handle top=${cb.top} tip "${cb.tip}" → "${ca.tip}", overrides ${JSON.stringify(ca.overrides)}, exceptions ${cex.length}` : 'no divert handle drawn'}`;
    if (ex.length) throw new Error('drag threw (planner.js:106 passes airports/isSuitable as values; divert-edit.js:95,154 call them as thunks) — ' + detail);
    if (!Object.keys(after.overrides).length) throw new Error('drag did not set S.divertOverrides — ' + detail);
    return { detail, repro: 'node tests/ui/run.mjs map --only alternates-drag', evidence: [ctx.shot('alternates-drag'), ctx.shot('alternates-drag-classic')] };
  }, { retry: 0 });

  // ---- Map menu: saved network routes toggle ----------------------------------------------
  await ctx.check('map-menu-saved-routes', async () => {
    if ((await v2.eval('CNSDemand.loadFolder().length')) < 2) { const s = await ctx.seedNetwork(v2, [{ o: 'EHLE', d: 'EDDF' }, { o: 'EHAM', d: 'EHGG' }]); if (s.some(x => x.err)) throw new Error('seed failed: ' + JSON.stringify(s)); }   // self-sufficient under --only
    const folder = await v2.eval('CNSDemand.loadFolder().length');
    await openMenu(v2); await v2.click('#fSavedRoutes'); await v2.sleep(150);
    const off = { lines: await count(v2, 'line', 'net'), show: await v2.eval('CNSUI.S.showNet') }; const o1 = await mapOpts(v2);
    await v2.click('#fSavedRoutes'); await v2.sleep(150);
    const on = { lines: await count(v2, 'line', 'net'), show: await v2.eval('CNSUI.S.showNet') }; const o2 = await mapOpts(v2); await closeMenu(v2);
    if (off.lines !== 0 || off.show !== false || o1.fSavedRoutes !== false) throw new Error(`off → ${JSON.stringify(off)}, persisted ${o1.fSavedRoutes}`);
    if (on.lines !== folder || on.show !== true || o2.fSavedRoutes !== true) throw new Error(`on → ${JSON.stringify(on)} (expected ${folder} lines = folder), persisted ${o2.fSavedRoutes}`);
    return `off → 0 network lines (persisted false); on → ${on.lines} = folder ${folder} (persisted true)`;
  }, { retry: 0 });

  // ---- MAP-3: reach graph ------------------------------------------------------------------
  const RG = `(function(){ const p = document.querySelector('.leaflet-rangeGraph-pane'); return { pane: !!p, kids: p ? p.children.length : -1, canvas: !!(p && p.querySelector('canvas')), svg: !!(p && p.querySelector('svg')), labels: document.querySelectorAll('.rg-lbl').length, checked: !!(document.getElementById('fReachGraph') || {}).checked }; })()`;
  await ctx.check('reach-graph-draws', async () => {
    await openMenu(v2); await v2.click('#fReachGraph'); await v2.sleep(100); await closeMenu(v2);
    await v2.eval(`(function(){ CNSUI.map.map.closePopup(); const by = CNSUI.byId(); CNSUI.S.origin = by.EHLE; CNSUI.S.stops = []; CNSUI.S.trip = 'one-way'; CNSUI.plan.onFormChange(false); window.setDest(by.EDDM); return true; })()`);   // the popup's Destination path
    await v2.sleep(500); await v2.waitForMapIdle();
    const st = await v2.eval(RG); st.lines = await count(v2, 'line', 'rangeGraphPane'); st.halos = await count(v2, 'dot', 'rangeGraphPane');
    const reach = await v2.eval(`CNSUI.planner.availableRangeKm(CNSUI.plane())`);
    await ctx.screenshot(v2, 'reach-graph');
    // classic control: same toggle + the same destination change
    classic = classic || await ctx.classicPage(v2.browser);
    const c = await classic.eval(`(function(){ const cb = document.getElementById('fReachGraph'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } window.setDest('EDDM'); const p = document.querySelector('.leaflet-rangeGraph-pane'); const n = Object.values(map._layers).filter(l => (l instanceof L.Polyline) && !(l instanceof L.Polygon) && (l.options || {}).pane === 'rangeGraphPane').length; return { checked: !!(cb && cb.checked), kids: p ? p.children.length : -1, lines: n, labels: document.querySelectorAll('.rg-lbl').length }; })()`);
    await ctx.screenshot(classic, 'reach-graph-classic');
    const detail = `v2: #fReachGraph checked=${st.checked}, reach ${Math.round(reach)} km, pane ${st.pane} kids ${st.kids} lines ${st.lines} halos ${st.halos} labels ${st.labels}; classic control after setDest(EDDM): ${JSON.stringify(c)}`;
    if (!st.checked) throw new Error('toggle not checked — ' + detail);
    if (!(st.kids > 0 && st.lines > 0)) throw new Error('reach graph not drawn (CNSRangeGraph.show() is never called by v2 — planner.js initMap only init()s it, plan.js onFormChange only refresh()es) — ' + detail);
    return { detail, repro: 'node tests/ui/run.mjs map --only reach-graph-draws', evidence: [ctx.shot('reach-graph'), ctx.shot('reach-graph-classic')] };
  }, { retry: 0 });
  await ctx.check('reach-graph-persists', async () => {
    if (!(await v2.eval(`!!document.getElementById('fReachGraph').checked`))) { await openMenu(v2); await v2.click('#fReachGraph'); await v2.sleep(100); await closeMenu(v2); }   // self-sufficient under --only
    const o = await mapOpts(v2); const checked = await v2.eval(`!!document.getElementById('fReachGraph').checked`);
    // v2 mirrors this flag to its own key: the classic rewrites cns_map_options wholesale from its own
    // checkbox list (index.html:6461-6467) and would drop a v2-only option, so either store counts.
    const mirror = await v2.eval(`localStorage.getItem('cns_v2_reach_graph')`);
    if (o.fReachGraph !== true && mirror !== '1') throw new Error(`#fReachGraph checked=${checked} but cns_map_options has no fReachGraph (${JSON.stringify(o)}) — palette.js saveOpts/loadOpts omit it (plan A6; the classic does not persist it either, index.html:6456)`);
    return `fReachGraph persisted: cns_map_options=${o.fReachGraph}, v2 mirror=${mirror}`;
  }, { retry: 0 });
  await v2.eval(`(function(){ const cb = document.getElementById('fReachGraph'); if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);

  // ---- Map menu: basemap + persistence across a reload -------------------------------------
  await ctx.check('map-menu-basemap', async () => {
    await openMenu(v2); await v2.click('#mapDd [data-base=sat]'); await v2.sleep(300);
    const read = () => v2.eval(`(function(){ const m = CNSUI.map.map; const tiles = Object.values(m._layers).filter(l => l instanceof L.TileLayer).map(l => l._url); return { base: CNSUI.S.base, tiles, imgs: document.querySelectorAll('.leaflet-tile-pane img[src*="World_Imagery"]').length, on: (document.querySelector('#mapDd [data-base].on') || {}).dataset ? document.querySelector('#mapDd [data-base].on').dataset.base : null, open: document.querySelector('#mapDd').classList.contains('open') }; })()`);
    const a = await read(); const o = await mapOpts(v2); await closeMenu(v2);
    await v2.reload({ boot: 'v2' }); await v2.waitForMapIdle();
    const b = await read();
    await ctx.screenshot(v2, 'basemap-sat');
    const probs = [];
    if (a.base !== 'sat' || !a.tiles.some(u => u.includes('World_Imagery')) || a.tiles.length !== 1) probs.push(`after click: base ${a.base}, tiles ${JSON.stringify(a.tiles)}`);
    if (a.imgs < 1) probs.push('no World_Imagery tile <img> in the tile pane');
    // the stored token may be either shell's name for the same basemap — v2 writes the classic's
    // vocabulary on this shared key (satellite/voyager) so a choice carries between /v2 and /, and
    // translates it back on load; what matters is that the reload below restores satellite.
    if (o.basemap !== 'sat' && o.basemap !== 'satellite') probs.push('cns_map_options.basemap = ' + o.basemap);
    if (b.base !== 'sat' || !b.tiles.some(u => u.includes('World_Imagery')) || b.on !== 'sat') probs.push(`after reload: base ${b.base}, tiles ${JSON.stringify(b.tiles)}, .on ${b.on}`);
    if (probs.length) throw new Error(probs.join('; '));
    return { detail: `sat → S.base ${a.base}, ${a.imgs} World_Imagery tiles, persisted basemap=${o.basemap}; reload → S.base ${b.base}, menu .on=${b.on}`, repro: 'node tests/ui/run.mjs map --only basemap', evidence: [ctx.shot('basemap-sat')] };
  }, { retry: 0 });

  // ---- the two shells share cns_map_options.basemap with different vocabularies -------------
  await ctx.check('basemap-shared-key-vocabulary', async () => {
    classic = classic || await ctx.classicPage(v2.browser);
    const c = await classic.eval(`(function(){ const b = document.querySelector('.seg-btn[data-basemap="voyager"]'); if (b) b.click(); return { active: (document.querySelector('.seg-btn[data-basemap].active') || {}).dataset ? document.querySelector('.seg-btn[data-basemap].active').dataset.basemap : null, values: [...document.querySelectorAll('.seg-btn[data-basemap]')].map(x => x.dataset.basemap) }; })()`);
    const o = await mapOpts(v2);
    await v2.reload({ boot: 'v2' });
    const v = await v2.eval(`({ base: CNSUI.S.base, values: [...document.querySelectorAll('#mapDd [data-base]')].map(x => x.dataset.base) })`);
    const detail = `classic Street click → cns_map_options.basemap="${o.basemap}" (classic values ${JSON.stringify(c.values)}); v2 reload reads it as S.base="${v.base}" (v2 values ${JSON.stringify(v.values)})`;
    if (v.base !== 'street') throw new Error('the classic\'s basemap choice does not carry into v2 (same key, different value vocabulary) — ' + detail);
    return detail;
  }, { retry: 0 });

  await ctx.check('no-exceptions', async () => {
    const drag = ctx.state.dragExceptions || new Set();
    const ex = [...v2.exceptions().filter(e => !drag.has(e)), ...(classic ? ctx.exceptions(classic) : [])];
    if (ex.length) throw new Error(ex.map(e => e.text.split('\n')[0]).join(' || '));
    return `v2 errors ${v2.errors.length} (${drag.size} attributed to alternates-drag), classic errors ${classic ? classic.errors.length : 'n/a'}; no other exceptions`;
  }, { retry: 0 });
}
