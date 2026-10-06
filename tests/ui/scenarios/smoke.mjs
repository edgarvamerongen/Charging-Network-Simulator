/* Smoke: both shells boot with zero exceptions; a REAL click on an NRG pin opens its popup; a REAL click on
   picked airport dots opens the airport popup (the classic behaviour); the same dots clicked 3 px off-centre
   (MapLibre map: the dots are one GL circle layer hit-tested with a 3 px tolerance, so nothing drawn above them
   can swallow the click — the old Leaflet canvas pointer-events override no longer exists). */
export const component = 'smoke';
export const module = 'shell';

const POP = `!!document.querySelector('.cnsgl-popup .pp')`;

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  await ctx.check('v2-boots', async () => {
    const st = await v2.eval(`({ airports: CNSUI.airports().length, planes: CNSUI.PLANES.length, plane: CNSUI.S.planeId, charger: CNSUI.S.chargerId, o: CNSUI.S.origin && CNSUI.S.origin.ident, d: CNSUI.S.dest && CNSUI.S.dest.ident, rail: document.querySelector('#railBody').children.length, gl: !!(window.maplibregl && CNSUI.map.map && CNSUI.map.map.ml) })`);
    const ex = v2.exceptions();
    if (st.airports < 1000) throw new Error('airports ' + st.airports);
    if (!st.gl) throw new Error('the v2 map is not a MapLibre map: ' + JSON.stringify(st));
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
    let opened = true; try { await v2.waitFor(`!!document.querySelector('.cnsgl-popup .plugs')`, 2500); } catch (e) { opened = false; }
    await ctx.screenshot(v2, 'pin-click');
    if (!opened) throw new Error(`pin head at (${head.cx.toFixed(0)},${head.cy.toFixed(0)}) top=${head.top} — no .cnsgl-popup .plugs after a real click`);
    return { detail: `EHTE pin at (${head.cx.toFixed(0)},${head.cy.toFixed(0)}) d=${head.d.toFixed(1)} top=${head.top} → plug popup opened`, repro: 'v2: flyTo EHTE, real click on .nrg-pin .head', evidence: [ctx.shot('pin-click')] };
  });
  await v2.closePopups();

  // ---- MAP-1: REAL clicks on picked airport dots must open the airport popup -----------------
  const dots = await v2.pickClickableDots(3);
  ctx.state.dots = dots;
  const clickDots = async (label, off = 0) => {
    const res = [];
    for (const d of dots) {
      await v2.closePopups();
      await v2.clickAt(d.x + off, d.y);
      let opened = true; try { await v2.waitFor(POP, 2000); } catch (e) { opened = false; }
      const who = opened ? String(await v2.eval(`(document.querySelector('.cnsgl-popup .pp .ic2') || {}).textContent || ''`)).trim() : '';
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
    if (bad.length) throw new Error(`${bad.length}/${res.length} real dot clicks opened no .cnsgl-popup .pp — ${detail}`);
    return { detail, repro: 'v2: pickClickableDots(3) (from CNSUI.map.dots()), Input.dispatchMouseEvent at each dot', evidence: [ctx.shot('dot-click')] };
  }, { retry: 0 });

  // ---- control B: the same dots clicked 3 px off-centre ---------------------------------------
  // Was: the covering Leaflet canvases (rt/net/overlay panes) set to pointer-events:none. The MapLibre map has no such
  // panes: every shape is on one WebGL canvas and the click dispatcher (gl.js _hits) takes the airport dot within 3 px
  // of the pointer whatever is drawn above it. Equivalent behaviour: a click near (not on) the dot centre opens it.
  await ctx.check('dot-click-with-pointer-events-override', async () => {
    await v2.closePopups(); const before = dots.map(d => d.topPane); const now = []; for (const d of dots) now.push((await v2.mapPoint(d.ident)).topPane);
    const res = await clickDots('dot-click-override', 3);
    ctx.state.dotClickOverride = res;
    const bad = res.filter(r => !r.opened);
    const detail = `topPane at pick=${JSON.stringify(before)} now=${JSON.stringify(now)}; ` + res.map(r => `${r.ident} +3px → ${r.opened ? 'popup ' + r.popupFor : 'NO popup (' + (r.popupFor || 'none') + ')'}`).join('; ');
    if (bad.length) throw new Error(`${bad.length}/${res.length} dot clicks 3 px off-centre opened no popup for that dot — ${detail}`);
    return { detail, repro: 'v2: pickClickableDots(3), Input.dispatchMouseEvent 3 px right of each dot centre', evidence: [ctx.shot('dot-click-override')] };
  }, { retry: 0 });

  await ctx.check('no-exceptions-after-clicks', async () => {
    const ex = [...v2.exceptions(), ...classic.exceptions()];
    if (ex.length) throw new Error(ex.map(e => e.text).join(' || '));
    return `v2 errors ${v2.errors.length}, classic errors ${classic.errors.length} (exceptions 0)`;
  }, { retry: 0 });
}
