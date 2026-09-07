/* Smoke: both shells boot with zero exceptions; a REAL click on an NRG pin opens its popup; a REAL click on
   picked airport dots opens the airport popup (the classic behaviour — expected to FAIL while map.js layers
   canvases over the dots, A0); the same click with the covering canvases set to pointer-events:none (a
   diagnostic override that must be a no-op once A0 is fixed). */
export const component = 'smoke';
export const module = 'shell';

const POP = `!!document.querySelector('.leaflet-popup .pp')`;

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  await ctx.check('v2-boots', async () => {
    const st = await v2.eval(`({ airports: CNSUI.airports().length, planes: CNSUI.PLANES.length, plane: CNSUI.S.planeId, charger: CNSUI.S.chargerId, o: CNSUI.S.origin && CNSUI.S.origin.ident, d: CNSUI.S.dest && CNSUI.S.dest.ident, rail: document.querySelector('#railBody').children.length, leaflet: !!window.L })`);
    const ex = v2.exceptions();
    if (st.airports < 1000) throw new Error('airports ' + st.airports);
    if (ex.length) throw new Error(`${ex.length} exception(s): ` + ex.map(e => e.text).join(' || '));
    await ctx.screenshot(v2, 'v2-boot');
    return { detail: JSON.stringify(st), evidence: [`console errors so far: ${v2.errors.length}`, ctx.shot('v2-boot')] };
  }, { retry: 0 });

  const classic = await ctx.classicPage(v2.browser);
  await ctx.check('classic-boots', async () => {
    const st = await classic.eval(`({ airports: Object.keys(airportByIdent).length, lastResult: lastResult, plane: document.getElementById('plane').value, planes: document.querySelectorAll('#plane option').length, simForm: !!document.getElementById('simForm'), welcome: !!document.querySelector('.modal.show') })`);
    const ex = classic.exceptions();
    if (st.airports < 1000 || !st.simForm) throw new Error(JSON.stringify(st));
    if (ex.length) throw new Error(`${ex.length} exception(s): ` + ex.map(e => e.text).join(' || '));
    await ctx.screenshot(classic, 'classic-boot');
    return { detail: JSON.stringify(st), evidence: [ctx.shot('classic-boot')] };
  }, { retry: 0 });

  // ---- control A: a REAL click on the EHTE NRG pin head opens the plug popup -----------------
  await ctx.check('pin-click-opens-popup', async () => {
    await v2.eval(`(function(){ CNSUI.map.map.closePopup(); CNSUI.map.flyTo(CNSUI.byId()['EHTE']); return true; })()`);
    await v2.sleep(100); await v2.waitForMapIdle(8000); await v2.sleep(600);   // flyTo opens its own popup after 400 ms
    await v2.closePopups();
    const mp = await v2.mapPoint('EHTE');
    const head = await v2.eval(`(function(){ const t = ${JSON.stringify(mp)}; let best = null; document.querySelectorAll('.nrg-pin .head').forEach(h => { const r = h.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const d = Math.hypot(cx - t.x, cy - t.y); if (!best || d < best.d) best = { cx, cy, d, w: r.width, h: r.height }; }); if (!best) return null; const top = document.elementFromPoint(best.cx, best.cy); best.top = top ? top.tagName.toLowerCase() + '.' + (typeof top.className === 'string' ? top.className : '') : null; return best; })()`);
    if (!head) throw new Error('no .nrg-pin .head in the DOM (assets: ' + JSON.stringify(await v2.eval('Object.keys(CNSUI.assets())')) + ')');
    await v2.clickAt(head.cx, head.cy);
    let opened = true; try { await v2.waitFor(`!!document.querySelector('.leaflet-popup .plugs')`, 2500); } catch (e) { opened = false; }
    await ctx.screenshot(v2, 'pin-click');
    if (!opened) throw new Error(`pin head at (${head.cx.toFixed(0)},${head.cy.toFixed(0)}) top=${head.top} — no .leaflet-popup .plugs after a real click`);
    return { detail: `EHTE pin at (${head.cx.toFixed(0)},${head.cy.toFixed(0)}) d=${head.d.toFixed(1)} top=${head.top} → plug popup opened`, repro: 'v2: flyTo EHTE, real click on .nrg-pin .head', evidence: [ctx.shot('pin-click')] };
  });
  await v2.closePopups();

  // ---- MAP-1: REAL clicks on picked airport dots must open the airport popup -----------------
  const dots = await v2.pickClickableDots(3);
  ctx.state.dots = dots;
  const clickDots = async label => {
    const res = [];
    for (const d of dots) {
      await v2.closePopups();
      await v2.clickAt(d.x, d.y);
      let opened = true; try { await v2.waitFor(POP, 2000); } catch (e) { opened = false; }
      const who = opened ? String(await v2.eval(`(document.querySelector('.leaflet-popup .pp .ic2') || {}).textContent || ''`)).trim() : '';
      res.push({ ident: d.ident, type: d.type, x: +d.x.toFixed(0), y: +d.y.toFixed(0), topPane: d.topPane, topTag: d.topTag, opened: opened && who.startsWith(d.ident), popupFor: who });
    }
    await ctx.screenshot(v2, label);
    return res;
  };
  await ctx.check('dot-click-opens-popup', async () => {
    if (!dots.length) throw new Error('pickClickableDots returned nothing at zoom ' + await v2.eval('CNSUI.map.map.getZoom()'));
    const res = await clickDots('dot-click');
    ctx.state.dotClick = res;
    const bad = res.filter(r => !r.opened);
    const detail = res.map(r => `${r.ident}(${r.type.replace('_airport', '')}) @${r.x},${r.y} top=${r.topPane} → ${r.opened ? 'popup ' + r.popupFor : 'NO popup'}`).join('; ');
    if (bad.length) throw new Error(`${bad.length}/${res.length} real dot clicks opened no .leaflet-popup .pp — ${detail}`);
    return { detail, repro: 'v2 at zoom ≥ 8: pickClickableDots(3), Input.dispatchMouseEvent at each dot', evidence: [ctx.shot('dot-click')] };
  }, { retry: 0 });

  // ---- control B: the same clicks with the covering canvases made click-through --------------
  await ctx.check('dot-click-with-pointer-events-override', async () => {
    await v2.eval(`(function(){ let s = document.getElementById('__cnsPeOverride'); if (!s) { s = document.createElement('style'); s.id = '__cnsPeOverride'; document.head.appendChild(s); } s.textContent = '.leaflet-rt-pane canvas, .leaflet-net-pane canvas, .leaflet-overlay-pane canvas { pointer-events: none !important; }'; return true; })()`);
    const before = dots.map(d => d.topPane); const now = []; for (const d of dots) now.push((await v2.mapPoint(d.ident)).topPane);
    const res = await clickDots('dot-click-override');
    ctx.state.dotClickOverride = res;
    await v2.eval(`(function(){ const s = document.getElementById('__cnsPeOverride'); if (s) s.remove(); return true; })()`);
    const bad = res.filter(r => !r.opened);
    const detail = `topPane before=${JSON.stringify(before)} with override=${JSON.stringify(now)}; ` + res.map(r => `${r.ident} → ${r.opened ? 'popup ' + r.popupFor : 'NO popup'}`).join('; ');
    if (bad.length) throw new Error(`${bad.length}/${res.length} dot clicks still opened no popup with the override — ${detail}`);
    return { detail, repro: 'inject <style> pointer-events:none on .leaflet-rt-pane/.leaflet-net-pane/.leaflet-overlay-pane canvas, click the same dots', evidence: [ctx.shot('dot-click-override')] };
  }, { retry: 0 });

  await ctx.check('no-exceptions-after-clicks', async () => {
    const ex = [...v2.exceptions(), ...classic.exceptions()];
    if (ex.length) throw new Error(ex.map(e => e.text).join(' || '));
    return `v2 errors ${v2.errors.length}, classic errors ${classic.errors.length} (exceptions 0)`;
  }, { retry: 0 });
}
