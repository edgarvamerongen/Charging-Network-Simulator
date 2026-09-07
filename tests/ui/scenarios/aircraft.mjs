/* Aircraft card (Plan rail, static/ui/plan.js aircraftHtml + the Change list) against the PRODUCTION catalog
   (18 rows / 13 airframes, 13 rows with image_url only, 3 battery-less hybrids, IFR+reserves regimes, STOL/eVTOL types).
   The classic shell (templates/index.html) is the behavioural spec and is driven in a second tab of the same profile:
   _planeImg (photo precedence, :3645), _planeSpecsLine ('no charge', :3619), _REGIMES/_regShort (:3677-3678),
   .pk-btn knobs (:3722-3805), .pf-chip filters (:3840-3872), the plane→default-charger rule (:6516-6522),
   #psoAvailRange override (:4047-4071) and the non-charging calc note (:5153-5193). */
export const component = 'aircraft';
export const module = 'plan';

const BAD = /\bundefined\b|\bNaN\b|\bnull\b/;
const EXPECT_IDS = ['beta_alia', 'electra_el9', 'aura_era', 'ehang_eh216s', 'heart_es30_25_pax'];
const NO_BATT = ['electra_el9', 'electra_el9_empty_0_pax_', 'aura_era'];
const q = s => JSON.stringify(s);
const stripOrigin = u => String(u || '').replace(/^https?:\/\/[^/]+/, '');
const reachOf = metas => { const m = (metas || []).map(t => t.match(/Reach\s+([\d,.]+)\s+of\s+([\d,.]+)\s+(km|NM)/)).find(Boolean); return m ? { reach: +m[1].replace(/,/g, ''), range: +m[2].replace(/,/g, ''), unit: m[3], text: m.input } : null; };

/** Everything the aircraft card shows + the state behind it (one round trip). */
const CARD = `(function(){ const S = CNSUI.S, p = CNSUI.plane(); const t = s => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
  const st = document.querySelector('.ac-stage'); const bg = st ? getComputedStyle(st).backgroundImage : null; const m = bg && bg.match(/url\\(["']?([^"')]*)["']?\\)/);
  const btns = s => [...document.querySelectorAll(s)].map(b => ({ v: b.dataset.v, text: b.textContent.trim(), on: b.classList.contains('on'), disabled: b.disabled, title: b.title || '' }));
  const ov = document.querySelector('[data-act=acOverride]');
  return { planeId: S.planeId, chargerId: S.chargerId, rail: S.rail, picking: S.picking, filters: S.acFilters, popOpen: S.acFilterOpen && !!document.querySelector('.ac-pop'),
    group: p.aircraft_id || p.id, name: p.name, image: p.image === undefined ? null : p.image, image_url: p.image_url === undefined ? null : p.image_url, battery: p.battery_kwh === undefined ? null : p.battery_kwh, regime: p.regime, range: p.range_km, type: p.type, defaultCharger: p.default_charger_id === undefined ? null : p.default_charger_id,
    stageBg: m ? m[1] : bg, stageStyle: st ? st.getAttribute('style') : null, st: t('.ac-st'), nm: t('.ac-ov .nm'), sp: t('.ac-ov .sp'), metas: [...document.querySelectorAll('.acsec .meta')].map(e => e.textContent.trim()),
    counter: t('.acsec .meta.num'), regimes: btns('.ac-rg button'), labels: btns('[data-act=acLabel]'), modes: btns('[data-act=acMode]'), acsec: ((document.querySelector('.acsec') || {}).textContent || '').replace(/\\s+/g, ' ').trim(),
    override: ov ? ov.value : null, editLabel: t('[data-act=acEdit]'), hint: t('.ph .hint'), visible: CNSUI.aircraft.visible(S.acFilters).length, availOverride: S.availOverride,
    planned: S.planned ? { stops: (S.planned.stops || []).map(s => s.ident), error: S.planned.error || null, source: S.planned.source } : null, routeTitle: t('.route .rh b') }; })()`;

export default async function run(ctx) {
  const v2 = await ctx.v2Page();
  const classic = await ctx.classicPage(v2.browser);
  const card = () => v2.eval(CARD);
  const status = async url => { try { const r = await fetch(ctx.base + url, { redirect: 'manual' }); return r.status; } catch (e) { return 'ERR ' + e.message; } };
  const ensureForm = async () => { if (await v2.eval('CNSUI.S.rail') === 'result') { await v2.click('[data-act=edit]'); await v2.waitFor(`CNSUI.S.rail === 'form' && !!document.querySelector('.acsec')`, 3000); } };
  /** The real UI path to an aircraft row: Change → row button (closes the list, applies the default charger). */
  const pickPlane = async id => {
    await ensureForm();
    if (!(await v2.eval('CNSUI.S.picking'))) { await v2.click('[data-act=pick]'); await v2.waitFor(`!!document.querySelector('.pick')`, 3000); }
    await v2.click(`[data-act=plane][data-id="${id}"]`);
    await v2.waitFor(`CNSUI.S.planeId === ${q(id)} && !CNSUI.S.picking`, 3000);
    return card();
  };
  const setDest = ident => v2.eval(`(function(){ window.setDest(CNSUI.byId()[${q(ident)}]); return CNSUI.S.dest && CNSUI.S.dest.ident; })()`);
  /** Classic control: pick the row in #plane and read the stage/spec card. */
  const classicPlane = async id => {
    await classic.setValue('#plane', id, ['change']);
    return classic.eval(`(function(){ const p = BUILTIN_PLANES_BY_ID[${q(id)}]; const t = s => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
      return { plane: document.getElementById('plane').value, charger: document.getElementById('charger').value, specs: _planeSpecsLine(p), img: _planeImg(p), stageImg: (document.querySelector('#planePicker img') || {}).getAttribute ? (document.querySelector('#planePicker img') || { getAttribute: () => null }).getAttribute('src') : null,
        regimes: [...document.querySelectorAll('.pk-btn[data-pk=regime]')].map(b => ({ regime: b.dataset.regime, text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') === 'true', disabled: b.disabled, title: b.title })),
        labels: [...document.querySelectorAll('.pk-btn[data-pk=profile]')].map(b => ({ label: b.dataset.label, pressed: b.getAttribute('aria-pressed') === 'true', disabled: b.disabled })),
        props: [...document.querySelectorAll('.pk-btn[data-pk=propulsion]')].map(b => ({ prop: b.dataset.prop, text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') === 'true' })),
        status: t('.plane-status .st-txt'), psRange: t('#psRange'), psRangeL: t('#psRangeL'), psBattery: t('#psBattery'), psUsage: t('#psUsage'), psAvail: t('#psAvail') }; })()`);
  };
  /** ‹ › walk over every visible airframe (memoised — spec-line / default-charger / loop checks reuse it). */
  const walk = async () => {
    if (ctx.state.walk) return ctx.state.walk;
    await pickPlane('beta_alia');
    const n = await v2.eval('CNSUI.aircraft.visible(CNSUI.S.acFilters).length');
    const steps = [await card()];
    for (let i = 0; i < n; i++) {
      const prev = steps[steps.length - 1].planeId;
      await v2.click('[data-act=acNext]');
      await v2.waitFor(`CNSUI.S.planeId !== ${q(prev)}`, 3000);
      const c = await card(); steps.push(c);
      await ctx.screenshot(v2, 'stage-' + c.planeId);
    }
    ctx.state.walk = { n, steps };
    return ctx.state.walk;
  };

  // ---- catalog + defaults -------------------------------------------------------------------
  await ctx.check('catalog-loaded', async () => {
    const st = await v2.eval(`({ n: CNSUI.PLANES.length, ids: CNSUI.PLANES.map(p => p.id), groups: CNSUI.aircraft.groups().length, imageUrlOnly: CNSUI.PLANES.filter(p => p.image_url && !p.image).length, noBattery: CNSUI.PLANES.filter(p => p.battery_kwh == null).map(p => p.id) })`);
    const cl = await classic.eval(`({ n: document.querySelectorAll('#plane option').length, builtin: BUILTIN_PLANES.length })`);
    const missing = EXPECT_IDS.filter(id => !st.ids.includes(id));
    if (st.n !== 18) throw new Error(`CNSUI.PLANES.length = ${st.n}, expected 18 (classic #plane options ${cl.n})`);
    if (missing.length) throw new Error('missing ids: ' + missing.join(', '));
    if (cl.n !== 18) throw new Error(`classic #plane has ${cl.n} options`);
    return { detail: `18 rows / ${st.groups} airframes; image_url-only ${st.imageUrlOnly}; no battery: ${st.noBattery.join(', ')}; classic options ${cl.n}`, repro: 'v2: CNSUI.PLANES.length; classic: #plane option count' };
  }, { retry: 0 });

  await ctx.check('default-selection', async () => {
    const c = await card(); const cl = await classic.eval(`({ plane: document.getElementById('plane').value, charger: document.getElementById('charger').value, status: (document.querySelector('.plane-status .st-txt') || {}).textContent || null })`);
    await ctx.screenshot(v2, 'default');
    const errs = [];
    if (c.planeId !== 'beta_alia') errs.push(`S.planeId ${c.planeId}`);
    if (c.chargerId !== 'dc_320') errs.push(`S.chargerId ${c.chargerId}`);
    if (!/^Prototype flying · cert\. \d{4}$/.test(c.st || '')) errs.push(`status line "${c.st}"`);
    if (cl.plane !== 'beta_alia' || cl.charger !== 'dc_320') errs.push(`classic control differs: ${JSON.stringify(cl)}`);
    if (errs.length) throw new Error(errs.join('; ') + ` (classic ${JSON.stringify(cl)})`);
    return { detail: `S.planeId ${c.planeId}, S.chargerId ${c.chargerId}, status "${c.st}", name "${c.nm}", spec "${c.sp}"; classic ${cl.plane}/${cl.charger} status "${cl.status}"`, evidence: [ctx.shot('default')] };
  }, { retry: 0 });

  // ---- stage photo precedence over every airframe (‹ › loop) -------------------------------
  await ctx.check('stage-image-precedence', async () => {
    const w = await walk();
    const classicImg = Object.fromEntries(await classic.eval('BUILTIN_PLANES.map(p => [p.id, _planeImg(p)])'));
    const rows = []; const bad = [];
    for (const s of w.steps.slice(0, -1)) {
      const actual = stripOrigin(s.stageBg); const expected = classicImg[s.planeId];
      const stA = actual ? await status(actual) : 'n/a'; const stE = expected ? await status(expected) : 'n/a';
      const row = { planeId: s.planeId, image: s.image, image_url: s.image_url, actual, actualStatus: stA, expected, expectedStatus: stE, style: s.stageStyle };
      rows.push(row);
      const reasons = [];
      if (actual !== expected) reasons.push(`bg ${actual || '(none)'} ≠ classic _planeImg ${expected || '(glyph)'}`);
      if (/\/pics\/(undefined)?$/.test(actual)) reasons.push('bg is a bare /pics/ or /pics/undefined');
      if (actual && stA !== 200) reasons.push(`bg URL → ${stA}`);
      if (expected && stE !== 200) reasons.push(`EXPECTED URL → ${stE} (environment: plane_images missing?)`);
      if (reasons.length) bad.push(`${s.planeId}: ${reasons.join(', ')}`);
    }
    ctx.state.imgRows = rows;
    const detail = `${rows.length} airframes stepped with [data-act=acNext]; ` + rows.map(r => `${r.planeId} → ${r.actual || '(none)'} [${r.actualStatus}]`).join('; ');
    if (bad.length) throw new Error(`${bad.length}/${rows.length} stage photos wrong — ${bad.join(' | ')} — style attrs: ${rows.filter(r => r.actual !== r.expected).slice(0, 3).map(r => r.style).join(' / ')}`);
    return { detail, repro: 'v2: click [data-act=acNext] 14×, read getComputedStyle(.ac-stage).backgroundImage; classic: _planeImg(p)', evidence: rows.map(r => ctx.shot('stage-' + r.planeId)) };
  }, { retry: 0 });

  await ctx.check('arrows-cycle-all-airframes', async () => {
    const w = await walk(); const groups = w.steps.slice(0, -1).map(s => s.group); const distinct = new Set(groups);
    const last = w.steps[w.steps.length - 1];
    if (distinct.size !== w.n) throw new Error(`visited ${distinct.size} distinct airframes in ${w.n} steps: ${groups.join(' → ')}`);
    if (last.planeId !== 'beta_alia') throw new Error(`after ${w.n} › clicks the card shows ${last.planeId}, not the starting beta_alia (loop broken)`);
    const counters = w.steps.map(s => (s.counter || '').split(' · ')[0]);
    if (!counters.every(c => /^\d+ of \d+$/.test(c))) throw new Error('counter texts: ' + JSON.stringify(counters));
    return { detail: `${w.n} airframes: ${groups.join(' → ')} → ${last.planeId}; counters ${counters.join(', ')}` };
  }, { retry: 0 });

  await ctx.check('spec-line-sane', async () => {
    const w = await walk(); const rows = w.steps.slice(0, -1); const bad = [];
    const classicSpecs = Object.fromEntries(await classic.eval('BUILTIN_PLANES.map(p => [p.id, _planeSpecsLine(p)])'));
    for (const s of rows) {
      const reasons = [];
      if (BAD.test(s.acsec)) reasons.push(`.acsec contains ${JSON.stringify(s.acsec.match(BAD)[0])}: "${s.acsec.slice(0, 160)}"`);
      if (s.battery == null) {
        if (!/no charge/i.test(s.sp || '')) reasons.push(`battery-less spec line "${s.sp}" lacks 'no charge' (classic: "${classicSpecs[s.planeId]}")`);
        if (/kwh/i.test(s.sp || '')) reasons.push(`battery-less spec line shows kWh: "${s.sp}"`);
      } else if (!/\d+ kWh/.test(s.sp || '')) reasons.push(`spec line lacks the battery: "${s.sp}"`);
      const dangling = (s.metas || []).filter(t => /(^·|·$|· ·)/.test(t));
      if (dangling.length) reasons.push(`dangling separator in meta: ${JSON.stringify(dangling)}`);
      if (!/^Reach \d[\d,]* of \d[\d,]* (km|NM)/.test((s.metas || []).find(t => /^Reach/.test(t)) || '')) reasons.push(`reach line: ${JSON.stringify(s.metas)}`);
      if (reasons.length) bad.push(`${s.planeId}: ${reasons.join('; ')}`);
    }
    const detail = rows.map(s => `${s.planeId}: "${s.sp}" | ${(s.metas || []).join(' | ')}`).join(' || ');
    if (bad.length) throw new Error(`${bad.length}/${rows.length} cards — ${bad.join(' | ')}`);
    return { detail, repro: 'walk the airframes with [data-act=acNext]; read .ac-ov .sp and .acsec .meta; classic _planeSpecsLine(p)' };
  }, { retry: 0 });

  await ctx.check('default-charger-rule', async () => {
    // classic index.html:6516-6522 — a plane with a default_charger_id switches the charger; without one the charger is kept.
    const w = await walk(); const chargers = await v2.eval('CNSUI.CHARGERS.map(c => c.id)'); const bad = [];
    for (let i = 1; i < w.steps.length; i++) {
      const prev = w.steps[i - 1], cur = w.steps[i]; const want = cur.defaultCharger && chargers.includes(cur.defaultCharger) ? cur.defaultCharger : prev.chargerId;
      if (cur.chargerId !== want) bad.push(`${prev.planeId}(${prev.chargerId}) › ${cur.planeId}(default ${cur.defaultCharger}) → ${cur.chargerId}, expected ${want}`);
    }
    const cl = []; for (const id of ['beta_alia', 'electra_el9', 'vaeridion_microliner', 'aura_era']) { const r = await classicPlane(id); cl.push(`${id}→${r.charger}`); }
    if (bad.length) throw new Error(bad.join('; ') + ` (classic: ${cl.join(', ')})`);
    return { detail: w.steps.map(s => `${s.planeId}:${s.chargerId}`).join(' › ') + ` | classic: ${cl.join(', ')}` };
  }, { retry: 0 });

  // ---- knobs: regime / label / propulsion ---------------------------------------------------
  await ctx.check('regime-knob', async () => {
    const h = await pickPlane('heart_es30'); await ctx.screenshot(v2, 'regime-heart');
    const hc = await classicPlane('heart_es30');
    const v = await pickPlane('pipistrel_velis'); await ctx.screenshot(v2, 'regime-velis');
    const vc = await classicPlane('pipistrel_velis');
    const find = (c, re) => c.regimes.find(b => re.test(b.v || '') || re.test(b.text || ''));
    const errs = [];
    const hI = find(h, /^IFR/), hV = find(h, /^VFR/);
    if (!hI) errs.push('heart_es30: no IFR button in .ac-rg');
    else { if (!hI.on) errs.push(`heart_es30 (regime "${h.regime}"): IFR button not ON`); if (hI.disabled) errs.push('heart_es30: IFR button disabled'); }
    if (hV && !hV.disabled) errs.push('heart_es30: VFR button enabled although the airframe has no VFR row');
    if (hI && !/reserves/i.test(hI.title)) errs.push(`heart_es30: IFR button title "${hI.title}" (classic: "Range incl. IFR reserves")`);
    const vV = find(v, /^VFR/), vI = find(v, /^IFR/);
    if (!vV || !vV.on) errs.push(`velis (regime "${v.regime}"): VFR button not ON (${JSON.stringify(v.regimes)})`);
    if (vI && !vI.disabled) errs.push('velis: IFR button enabled although the airframe has no IFR row');
    if (vV && !/VFR range/i.test(vV.title)) errs.push(`velis: VFR button title "${vV.title}" (classic: "VFR range")`);
    const detail = `heart_es30 regime "${h.regime}" → buttons ${JSON.stringify(h.regimes)}, header hint "${h.hint}"; velis → ${JSON.stringify(v.regimes)}; classic heart: ${JSON.stringify(hc.regimes)} range label "${hc.psRangeL}"; classic velis: ${JSON.stringify(vc.regimes)}`;
    if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
    return { detail, repro: 'Change → heart_es30; read .ac-rg button (class on / disabled); classic .pk-btn[data-pk=regime]', evidence: [ctx.shot('regime-heart'), ctx.shot('regime-velis')] };
  }, { retry: 0 });

  await ctx.check('label-knob', async () => {
    const c0 = await pickPlane('electra_el9');
    const btn = c0.labels.find(b => b.v === 'Empty (0 pax)');
    if (!btn) throw new Error(`no [data-act=acLabel][data-v="Empty (0 pax)"] — labels ${JSON.stringify(c0.labels)}`);
    await v2.click('[data-act=acLabel][data-v="Empty (0 pax)"]');
    await v2.waitFor(`CNSUI.S.planeId !== 'electra_el9'`, 3000).catch(() => {});
    const c1 = await card(); await ctx.screenshot(v2, 'label-empty');
    await v2.click('[data-act=acLabel][data-v="Full (9 pax)"]'); await v2.waitFor(`CNSUI.S.planeId === 'electra_el9'`, 3000).catch(() => {});
    const c2 = await card();
    await classicPlane('electra_el9'); await classic.eval(`document.querySelector('.pk-btn[data-pk=profile][data-label="Empty (0 pax)"]').click()`);
    const cl = await classic.eval(`document.getElementById('plane').value`);
    if (c1.planeId !== 'electra_el9_empty_0_pax_') throw new Error(`after Empty (0 pax): S.planeId ${c1.planeId} (classic → ${cl})`);
    if (!c1.labels.find(b => b.v === 'Empty (0 pax)' && b.on)) throw new Error('Empty (0 pax) not marked on: ' + JSON.stringify(c1.labels));
    if (c2.planeId !== 'electra_el9') throw new Error(`back to Full (9 pax): S.planeId ${c2.planeId}`);
    return { detail: `electra_el9 → Empty (0 pax) → ${c1.planeId} (range ${c1.range} km, spec "${c1.sp}") → Full → ${c2.planeId}; classic → ${cl}`, evidence: [ctx.shot('label-empty')] };
  }, { retry: 0 });

  await ctx.check('propulsion-knob', async () => {
    const c0 = await pickPlane('heart_es30');
    if (!c0.modes.find(b => b.v === 'hybrid')) throw new Error(`no [data-act=acMode][data-v=hybrid] — modes ${JSON.stringify(c0.modes)}`);
    await v2.click('[data-act=acMode][data-v=hybrid]'); await v2.waitFor(`CNSUI.S.planeId !== 'heart_es30'`, 3000).catch(() => {});
    const c1 = await card(); await ctx.screenshot(v2, 'mode-hybrid');
    await v2.click('[data-act=acMode][data-v=electric]'); await v2.waitFor(`CNSUI.S.planeId === 'heart_es30'`, 3000).catch(() => {});
    const c2 = await card();
    await classicPlane('heart_es30'); await classic.eval(`document.querySelector('.pk-btn[data-pk=propulsion][data-prop=hybrid]').click()`);
    const cl = await classic.eval(`document.getElementById('plane').value`);
    if (c1.planeId !== 'heart_es30_30_pax') throw new Error(`after hybrid: S.planeId ${c1.planeId} (classic → ${cl})`);
    if (c2.planeId !== 'heart_es30') throw new Error(`back to electric: S.planeId ${c2.planeId}`);
    return { detail: `heart_es30 → hybrid → ${c1.planeId} (range ${c1.range} km, labels ${JSON.stringify(c1.labels.map(l => l.v + (l.on ? '*' : '')))}) → electric → ${c2.planeId}; classic → ${cl}`, evidence: [ctx.shot('mode-hybrid')] };
  }, { retry: 0 });

  // ---- filters popover ------------------------------------------------------------------------
  await ctx.check('filters', async () => {
    await pickPlane('beta_alia');
    await v2.click('[data-act=acFilters]'); await v2.waitFor(`!!document.querySelector('.ac-pop')`, 3000);
    const chips = await v2.eval(`[...document.querySelectorAll('.ac-pop .chip')].map(b => ({ dim: b.dataset.dim, val: b.dataset.val, text: b.textContent.trim(), on: b.classList.contains('on'), disabled: b.disabled }))`);
    const catVals = await v2.eval(`CNSUI.aircraft.dims().map(d => [d.key, d.values])`);
    await ctx.screenshot(v2, 'filters-open');
    const errs = [];
    const typeChips = chips.filter(c => c.dim === 'type'), propChips = chips.filter(c => c.dim === 'propulsion');
    const typeVals = (catVals.find(d => d[0] === 'type') || [])[1] || [];
    for (const v of typeVals) { const ch = typeChips.find(c => c.val === v); if (!ch) errs.push(`no chip for type ${v}`); else if (ch.text !== v) errs.push(`type chip text "${ch.text}" ≠ catalog value "${v}" (casing)`); }
    for (const [val, want] of [['electric', 'Electric'], ['hybrid', 'Hybrid']]) { const ch = propChips.find(c => c.val === val); if (!ch) errs.push(`no chip for propulsion ${val}`); else if (ch.text !== want) errs.push(`propulsion chip "${ch.text}" ≠ "${want}"`); }
    // STOL → 2 airframes, counter 1 of 2, a chip that would leave nothing (Electric) disabled
    if (!typeChips.find(c => c.val === 'STOL')) errs.push('no STOL chip');
    else {
      await v2.click('[data-act=acFilter][data-dim=type][data-val=STOL]'); await v2.waitFor(`CNSUI.S.acFilters.type === 'STOL'`, 3000);
      const c = await card(); await ctx.screenshot(v2, 'filters-stol');
      const chips2 = await v2.eval(`[...document.querySelectorAll('.ac-pop .chip')].map(b => ({ dim: b.dataset.dim, val: b.dataset.val, on: b.classList.contains('on'), disabled: b.disabled }))`);
      if (c.visible !== 2) errs.push(`STOL → ${c.visible} airframes (expected 2)`);
      if (!/^1 of 2/.test(c.counter || '')) errs.push(`counter "${c.counter}" (expected "1 of 2")`);
      if (c.type !== 'STOL') errs.push(`selected plane ${c.planeId} is ${c.type}, not STOL`);
      const el = chips2.find(x => x.dim === 'propulsion' && x.val === 'electric'); if (!el || !el.disabled) errs.push(`Electric chip should be disabled under STOL (no electric STOL): ${JSON.stringify(el)}`);
      if (!c.popOpen) errs.push('popover closed after clicking a chip');
      // outside click closes the popover
      await v2.click('.ph h3'); await v2.sleep(150);
      const c2 = await card();
      if (c2.popOpen) errs.push('popover still open after a click outside (.ph h3)');
      if (c2.filters.type !== 'STOL') errs.push('outside click changed the filter');
      // clear the filter again through the UI
      await v2.click('[data-act=acFilters]'); await v2.waitFor(`!!document.querySelector('.ac-pop')`, 3000);
      await v2.click('[data-act=acFilter][data-dim=type][data-val=STOL]'); await v2.waitFor(`CNSUI.S.acFilters.type === null`, 3000);
      await v2.click('.ph h3'); await v2.sleep(150);
      const total = await v2.eval('CNSUI.aircraft.groups().length'); const c3 = await card(); if (c3.visible !== total || c3.popOpen) errs.push(`after clearing: visible ${c3.visible} of ${total}, popOpen ${c3.popOpen}`);
    }
    // classic control: clear the default 'electric' chip, pick STOL → strip count
    const cl = await classic.eval(`(function(){ const click = v => { const b = document.querySelector('.pf-chip[data-val=' + JSON.stringify(v) + ']'); if (b && !b.disabled) b.click(); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; };
      const before = [...document.querySelectorAll('.pf-chip')].map(b => ({ val: b.dataset.val, text: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true', disabled: b.disabled }));
      if (_planeFilters.propulsion) click(_planeFilters.propulsion); if (_planeFilters.type) click(_planeFilters.type); click('STOL');
      const n = document.querySelectorAll('#planeStrip .plane-thumb').length; const plane = document.getElementById('plane').value; click('STOL'); click('CTOL'); click('electric');
      return { before, stolCount: n, planeUnderStol: plane, after: { ..._planeFilters } }; })()`);
    if (cl.stolCount !== 2) errs.push(`classic STOL strip has ${cl.stolCount} airframes`);
    const detail = `chips ${JSON.stringify(chips.map(c => c.text + (c.disabled ? '(dis)' : '')))}; catalog ${JSON.stringify(catVals)}; classic chips ${JSON.stringify(cl.before.map(c => c.text + (c.on ? '*' : '') + (c.disabled ? '(dis)' : '')))}, classic STOL → ${cl.stolCount} (${cl.planeUnderStol})`;
    if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
    return { detail, repro: 'click [data-act=acFilters], read .ac-pop .chip texts; click STOL chip; click .ph h3', evidence: [ctx.shot('filters-open'), ctx.shot('filters-stol')] };
  }, { retry: 0 });

  // ---- Change list --------------------------------------------------------------------------
  await ctx.check('picker-images', async () => {
    await ensureForm(); await pickPlane('beta_alia');
    await v2.click('[data-act=pick]'); await v2.waitFor(`document.querySelectorAll('.pick button').length > 0`, 3000);
    await v2.sleep(900);   // let the <img onerror> fallbacks settle
    const rows = await v2.eval(`[...document.querySelectorAll('.pick button')].map(b => { const i = b.querySelector('img'); return { id: b.dataset.id, src: i ? i.getAttribute('src') : null, cur: i ? i.currentSrc : null, ok: i ? (i.complete && i.naturalWidth > 0) : false, m: (b.querySelector('.m') || {}).textContent || '', r: (b.querySelector('.r') || {}).textContent || '', text: b.textContent.replace(/\\s+/g, ' ').trim() }; })`);
    await ctx.screenshot(v2, 'picker');
    const classicImg = Object.fromEntries(await classic.eval('BUILTIN_PLANES.map(p => [p.id, _planeImg(p)])'));
    const classicSpecs = Object.fromEntries(await classic.eval('BUILTIN_PLANES.map(p => [p.id, _planeSpecsLine(p)])'));
    const bad = [];
    for (const r of rows) {
      const reasons = []; const expected = classicImg[r.id];
      if (r.src !== expected) reasons.push(`src ${r.src} ≠ ${expected || '(glyph)'} (resolved to ${stripOrigin(r.cur)})`);
      if (/\/pics\/(undefined)?$/.test(r.src || '')) reasons.push('bare /pics/');
      if (BAD.test(r.text)) reasons.push(`text "${r.text}"`);
      if (NO_BATT.includes(r.id) && !/no charge/i.test(r.m)) reasons.push(`battery-less label "${r.m.trim()}" (classic: "${classicSpecs[r.id]}")`);
      if (reasons.length) bad.push(`${r.id}: ${reasons.join(', ')}`);
    }
    const bareCount = rows.filter(r => /\/pics\/(undefined)?$/.test(r.src || '')).length;
    const netBad = v2.responses.filter(x => /\/pics\/(undefined)?$/.test(stripOrigin(x.url)) && x.status >= 400).length;
    await v2.click('[data-act=pick]'); await v2.waitFor('!CNSUI.S.picking', 3000);   // Close
    const detail = `${rows.length} rows; bare /pics/ srcs ${bareCount} (server 4xx for /pics/ so far: ${netBad}); ` + rows.map(r => `${r.id}: ${r.src} → ${stripOrigin(r.cur)} ${r.ok ? 'ok' : 'BROKEN'} · "${r.m.trim()}"`).join('; ');
    if (rows.length !== 18) bad.unshift(`list has ${rows.length} rows, expected 18`);
    if (bad.length) throw new Error(`${bad.length} rows wrong — ${bad.join(' | ')}`);
    return { detail, repro: 'click [data-act=pick]; read .pick button img[src] + .m; classic _planeImg / _planeSpecsLine', evidence: [ctx.shot('picker')] };
  }, { retry: 0 });

  // ---- eVTOL: no climb term, and a short hop simulates ---------------------------------------
  await ctx.check('evtol-card', async () => {
    const c = await pickPlane('vertical_vx4');
    const climb = await v2.eval(`CNSFlight.climbParams(CNSUI.plane())`);
    const climbTerm = (c.metas || []).find(t => /\+\s*\d+\s*climb/i.test(t));
    const cl = await classicPlane('vertical_vx4');
    const errs = [];
    if (climbTerm) errs.push(`climb term on an eVTOL card: "${climbTerm}" (climbParams ${JSON.stringify(climb)})`);
    if (/\/climb/.test(cl.psUsage || '')) errs.push(`classic control ALSO shows a climb term: "${cl.psUsage}"`);
    await setDest('EHRD');
    const r = await ctx.v2Simulate(v2); await ctx.screenshot(v2, 'evtol-result');
    if (r.err) errs.push(`v2 simulate EHLE→EHRD failed: ${r.err}`);
    const cs = await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EHRD', plane: 'vertical_vx4', trip: 'one-way' });
    const cr = await ctx.classicSimulate(classic);
    if (cr.error) errs.push(`classic simulate failed: ${cr.error}`);
    const vE = r.shown ? ctx.num(r.shown.stats[0]) : NaN, cE = cr.shown ? ctx.num(cr.shown.hlUsed) : NaN;
    if (!r.err && !cr.error && !ctx.close(vE, cE, 1)) errs.push(`energy differs: v2 ${vE} vs classic ${cE}`);
    const detail = `VX4 metas ${JSON.stringify(c.metas)}; climbParams.applies ${climb.applies}; classic psUsage "${cl.psUsage}"; v2 EHLE→EHRD ${r.err || 'ok'} stats ${JSON.stringify(r.shown && r.shown.stats)}; classic ${cr.error || 'ok'} hlUsed "${cr.shown && cr.shown.hlUsed}" (warnings ${JSON.stringify(cs.warnings)})`;
    if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
    return { detail, repro: 'Change → vertical_vx4; read .acsec .meta; setDest(EHRD); click Simulate', evidence: [ctx.shot('evtol-result')] };
  }, { retry: 0 });

  // ---- battery-less hybrid result -----------------------------------------------------------
  await ctx.check('battery-less-result', async () => {
    await ensureForm(); await pickPlane('electra_el9'); await setDest('EDDF');
    const c = await card();
    const r = await ctx.v2Simulate(v2); await ctx.screenshot(v2, 'nobatt-result');
    const res = await v2.eval(`(function(){ const t = s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
      return { soc: !!document.querySelector('.soc'), lowest: t('.soc .r'), calc: t('.calc'), stats: [...document.querySelectorAll('.stats > div')].map(d => d.textContent.replace(/\\s+/g, ' ').trim()), cost: t('.cost'), charging: t('[data-acc=charging] .sub'), rail: t('#railBody'), low: (CNSUI.plan.derive() ? CNSUI.soc.series(CNSUI.plan.derive().legs, CNSUI.plan.derive().charges, CNSUI.plane().battery_kwh || 1, CNSFlight.climbParams(CNSUI.plane()), {}).low : null) }; })()`);
    await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'electra_el9', trip: 'one-way' });
    const cr = await ctx.classicSimulate(classic);
    const ccalc = await classic.eval(`(document.getElementById('calcPanel') || {}).textContent || ''`);
    await ctx.screenshot(classic, 'nobatt-classic');
    const errs = [];
    if (r.err) errs.push(`v2 simulate failed: ${r.err}`);
    if (cr.error) errs.push(`classic simulate failed: ${cr.error}`);
    const vE = r.shown ? ctx.num(r.shown.stats[0]) : NaN, vC = r.shown ? ctx.num(r.shown.stats[2]) : NaN, cE = cr.shown ? ctx.num(cr.shown.hlUsed) : NaN;
    if (!r.err && !(vE === 0 && vC === 0) && !/non-charging/i.test(res.rail || '')) errs.push(`energy ${vE} kWh / charge ${vC} min and no non-charging note (classic hlUsed "${cr.shown && cr.shown.hlUsed}")`);
    if (res.soc) { const low = ctx.num(res.lowest); if (!(low >= 0 && low <= 100)) errs.push(`.soc chart drawn with lowest "${res.lowest}" (series low ${res.low})`); }
    if (BAD.test(res.calc || '')) errs.push(`Calculation pane contains ${JSON.stringify((res.calc || '').match(BAD)[0])}: "${res.calc}"`);
    if (BAD.test(res.rail || '')) errs.push(`result rail contains ${JSON.stringify((res.rail || '').match(BAD)[0])}`);
    if (!/non-charging/i.test(ccalc)) errs.push(`classic calc panel has no non-charging note: "${ccalc.slice(0, 120)}"`);
    const detail = `card spec "${c.sp}"; v2 stats ${JSON.stringify(res.stats)} cost "${res.cost}" soc ${res.soc} lowest "${res.lowest}" calc "${(res.calc || '').slice(0, 200)}"; classic hlUsed "${cr.shown && cr.shown.hlUsed}" hlTime "${cr.shown && cr.shown.hlTime}" calc "${ccalc.replace(/\s+/g, ' ').slice(0, 160)}"`;
    if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
    return { detail, repro: 'Change → electra_el9; EHLE→EDDF; Simulate; read .soc .r, .calc', evidence: [ctx.shot('nobatt-result'), ctx.shot('nobatt-classic')] };
  }, { retry: 0 });


  await ctx.check('battery-less-no-chart', async () => {
    // Plan §2 (A0d): a battery-less aircraft gets no battery chart and no reach bar; the result says it is non-charging
    // (classic calc note, index.html:5160/5190). The engine already guards batt > 0, so the profile is valid with 0 kWh.
    await ensureForm(); const c = await pickPlane('electra_el9'); await setDest('EDDF');
    const form = await v2.eval(`({ bar: !!document.querySelector('.acsec .bar'), barW: document.querySelector('.acsec .bar i') ? document.querySelector('.acsec .bar i').style.width : null, reach: [...document.querySelectorAll('.acsec .meta')].map(e => e.textContent.trim()).find(t => /^Reach/.test(t)) || null })`);
    const r = await ctx.v2Simulate(v2);
    const res = await v2.eval(`({ soc: !!document.querySelector('.soc'), socText: ((document.querySelector('.soc') || {}).textContent || '').replace(/\\s+/g, ' ').trim(), pts: document.querySelectorAll('.soc circle').length, note: /non-charging/i.test(document.querySelector('#railBody').textContent) })`);
    await ctx.screenshot(v2, 'nobatt-chart');
    const errs = [];
    if (r.err) errs.push('simulate failed: ' + r.err);
    if (form.bar) errs.push(`reach bar rendered for a battery-less aircraft (fill ${form.barW}, "${form.reach}")`);
    if (res.soc) errs.push(`battery chart rendered (${res.pts} points): "${res.socText}"`);
    if (!res.note) errs.push('result has no non-charging note (classic: "no battery = non-charging aircraft — grid supplies 0 kWh")');
    const detail = `${c.planeId} battery ${c.battery}: form bar ${form.bar} (${form.barW}) "${form.reach}"; result .soc ${res.soc} "${res.socText}"; non-charging note ${res.note}`;
    if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
    return { detail, repro: 'Change → electra_el9; read .acsec .bar; EHLE→EDDF Simulate; read .soc + a non-charging note', evidence: [ctx.shot('nobatt-chart')] };
  }, { retry: 0 });

  // ---- range override -------------------------------------------------------------------------
  await ctx.check('override', async () => {
    await ensureForm(); const c0 = await pickPlane('beta_alia'); await setDest('EDDF');
    const before = await card(); const r0 = reachOf(before.metas);
    if (!r0) throw new Error('no Reach line: ' + JSON.stringify(before.metas));
    if (before.editLabel !== 'Edit for this flight') throw new Error(`edit link reads "${before.editLabel}"`);
    await v2.click('[data-act=acEdit]'); await v2.waitFor(`!!document.querySelector('[data-act=acOverride]')`, 3000);
    const c1 = await card(); await ctx.screenshot(v2, 'override-open');
    const errs = [];
    if (+c1.override !== r0.reach) errs.push(`override input prefilled with ${c1.override}, reach shown was ${r0.reach}`);
    if (c1.editLabel !== 'Reset override') errs.push(`edit link after opening reads "${c1.editLabel}"`);
    // type 200 (real keys) and commit with Tab (→ change)
    await v2.click('[data-act=acOverride]'); await v2.eval(`document.querySelector('[data-act=acOverride]').select()`); await v2.type('200'); await v2.press('Tab');
    await v2.waitFor(`CNSUI.S.availOverride === 200`, 3000).catch(() => {});
    const c2 = await card(); await ctx.screenshot(v2, 'override-200');
    const r2 = reachOf(c2.metas);
    if (c2.availOverride !== 200) errs.push(`S.availOverride is ${c2.availOverride} after typing 200 + Tab (input value "${c2.override}")`);
    if (!r2 || r2.reach !== 200) errs.push(`reach line after override: ${r2 && r2.text}`);
    if (!c2.planned || !c2.planned.stops.length) errs.push(`no stop suggested for EHLE→EDDF (${Math.round(r0.range)} km class) at 200 km: planned ${JSON.stringify(c2.planned)}`);
    if (!/Suggested route/.test(c2.routeTitle || '')) errs.push(`route title "${c2.routeTitle}"`);
    // reset
    await v2.click('[data-act=acEdit]'); await v2.waitFor(`CNSUI.S.availOverride === null`, 3000).catch(() => {});
    const c3 = await card(); const r3 = reachOf(c3.metas);
    if (c3.availOverride !== null) errs.push(`S.availOverride ${c3.availOverride} after Reset override`);
    if (c3.override !== null) errs.push('override input still present after reset');
    if (!r3 || r3.reach !== r0.reach) errs.push(`reach after reset ${r3 && r3.reach} ≠ ${r0.reach}`);
    if (c3.planned && c3.planned.stops.length) errs.push(`stops still planned after reset: ${c3.planned.stops.join(',')}`);
    // classic control: #psoAvailRange = 200 → a planned stop
    await ctx.classicSetRoute(classic, { o: 'EHLE', d: 'EDDF', plane: 'beta_alia', trip: 'one-way' });
    const cl = await classic.eval(`(function(){ const av0 = document.getElementById('psAvail').textContent; const f = document.getElementById('psoAvailRange'); const pre = f.value; f.value = '200'; f.dispatchEvent(new Event('change')); const stops = plannedStops.map(s => s.ident); const av1 = document.getElementById('psAvail').textContent; document.getElementById('psoReset').click(); return { av0, prefill: pre, stops, av1, avReset: document.getElementById('psAvail').textContent, stopsReset: plannedStops.length }; })()`);
    if (!cl.stops.length) errs.push(`classic control: no planned stop at 200 km (${JSON.stringify(cl)})`);
    const detail = `reach ${r0.text} → Edit prefill ${c1.override} → 200: reach "${r2 && r2.text}", planned ${JSON.stringify(c2.planned && c2.planned.stops)}, title "${c2.routeTitle}" → reset: reach ${r3 && r3.reach}, stops ${c3.planned && c3.planned.stops.length}; classic: avail "${cl.av0}" prefill ${cl.prefill} → 200: "${cl.av1}" stops ${JSON.stringify(cl.stops)} → reset "${cl.avReset}"`;
    if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
    return { detail, repro: 'beta_alia EHLE→EDDF; click [data-act=acEdit]; type 200 + Tab; click Reset override', evidence: [ctx.shot('override-open'), ctx.shot('override-200')] };
  }, { retry: 0 });

  await ctx.check('override-prefill-keeps-reach-ifr', async () => {
    // A15: the classic prefills the field with the SHOWN reach and stores v / routingFactor (index.html:4056), so opening the
    // editor never moves the reach. v2 stores the shown value as the pre-padding base (planner.js:30) → reach ×route on open.
    await ensureForm();
    await v2.eval(`CNSSettings.save({ routingPadding: { enabled: true, factor: 1.05 } })`);
    await classic.eval(`CNSSettings.save({ routingPadding: { enabled: true, factor: 1.05 } })`);
    try {
      const c0 = await pickPlane('heart_es30'); await setDest('EDDF');
      const f = await v2.eval(`({ route: CNSSettings.routingFactor(CNSUI.plane()), sid: CNSSettings.sidStarPaddingKm(CNSUI.plane()), flownMax: CNSFlight.maxFlownLegKm(CNSUI.plane()), avail: CNSUI.planner.availableRangeKm(CNSUI.plane()), shown: CNSUI.planner.availRangeShownKm(CNSUI.plane()) })`);
      const r0 = reachOf(c0.metas);
      await v2.click('[data-act=acEdit]'); await v2.waitFor(`!!document.querySelector('[data-act=acOverride]')`, 3000);
      const c1 = await card(); const r1 = reachOf(c1.metas); await ctx.screenshot(v2, 'override-ifr');
      const f1 = await v2.eval(`({ override: CNSUI.S.availOverride, avail: CNSUI.planner.availableRangeKm(CNSUI.plane()), shown: CNSUI.planner.availRangeShownKm(CNSUI.plane()) })`);
      await v2.click('[data-act=acEdit]'); await v2.waitFor(`CNSUI.S.availOverride === null`, 3000);
      const cl = await classic.eval(`(function(){ const sel = document.getElementById('plane'); sel.value = 'heart_es30'; sel.dispatchEvent(new Event('change')); const av0 = document.getElementById('psAvail').textContent; const f = document.getElementById('psoAvailRange'); const pre = f.value; f.dispatchEvent(new Event('change')); const av1 = document.getElementById('psAvail').textContent; const stored = _availRangeOverride; document.getElementById('psoReset').click(); return { av0, prefill: pre, av1, stored, route: CNSSettings.routingFactor(BUILTIN_PLANES_BY_ID.heart_es30) }; })()`);
      const errs = [];
      if (!r0 || !r1) errs.push('no reach line');
      else if (r1.reach !== r0.reach) errs.push(`opening the override moved the reach ${r0.reach} → ${r1.reach} ${r1.unit} (route ${f.route}, sid ${f.sid}; availableRangeKm ${f.avail.toFixed(1)} → ${f1.avail.toFixed(1)})`);
      if (ctx.num(cl.av1) !== ctx.num(cl.av0)) errs.push(`classic control ALSO moved: ${cl.av0} → ${cl.av1}`);
      const detail = `heart_es30 route ${f.route} sid ${f.sid} flownMax ${f.flownMax.toFixed(1)}: reach ${r0 && r0.reach} → after Edit ${r1 && r1.reach} (S.availOverride ${f1.override}, planner avail ${f.avail.toFixed(1)} → ${f1.avail.toFixed(1)}); classic avail "${cl.av0}" prefill ${cl.prefill} → commit unchanged "${cl.av1}" stored ${cl.stored && cl.stored.toFixed(1)} (= ${cl.prefill}/${cl.route})`;
      if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
      return { detail, repro: 'CNSSettings.save({routingPadding:{enabled:true}}); Change → heart_es30; click [data-act=acEdit]; compare the Reach line', evidence: [ctx.shot('override-ifr')] };
    } finally {
      await v2.eval(`CNSSettings.save({ routingPadding: { enabled: false } })`).catch(() => {});
      await classic.eval(`CNSSettings.save({ routingPadding: { enabled: false } })`).catch(() => {});
    }
  }, { retry: 0 });

  // ---- units ----------------------------------------------------------------------------------
  await ctx.check('units-in-card', async () => {
    await ensureForm(); const km = await pickPlane('beta_alia');
    const rk = reachOf(km.metas);
    await v2.click('#unitSeg [data-u=nm]'); await v2.waitFor(`CNSUnits.isNautical() && /NM/.test(document.querySelector('.acsec').textContent)`, 3000).catch(() => {});
    const nm = await card(); const rn = reachOf(nm.metas); await ctx.screenshot(v2, 'units-nm');
    await v2.click('[data-act=pick]'); await v2.waitFor(`document.querySelectorAll('.pick button').length > 0`, 3000);
    const pickR = await v2.eval(`[...document.querySelectorAll('.pick button')].slice(0, 5).map(b => (b.querySelector('.r') || {}).textContent)`);
    await v2.click('[data-act=pick]'); await v2.waitFor('!CNSUI.S.picking', 3000);
    await classicPlane('beta_alia');
    const cl = await classic.eval(`(function(){ CNSUnits.set('nautical'); return { nautical: CNSUnits.isNautical(), fmt600: CNSUnits.fmtDist(600), psRange: document.getElementById('psRange').textContent, psAvail: document.getElementById('psAvail').textContent }; })()`);
    await v2.click('#unitSeg [data-u=km]'); await v2.waitFor(`!CNSUnits.isNautical() && /km/.test(document.querySelector('.acsec').textContent)`, 3000).catch(() => {});
    const back = await card(); const rb = reachOf(back.metas);
    await classic.eval(`CNSUnits.set('metric')`);
    const errs = [];
    const want600 = Math.ceil(600 / 1.852 - 1e-9);
    if (!new RegExp(`\\b${want600} NM\\b`).test(nm.sp || '')) errs.push(`spec line after NM: "${nm.sp}" (expected ${want600} NM; classic fmtDist(600) "${cl.fmt600}")`);
    if (!rn || rn.unit !== 'NM') errs.push(`reach line not in NM: ${JSON.stringify(nm.metas)}`);
    else if (rk && rn.reach !== Math.ceil(rk.reach / 1.852 - 1e-9)) errs.push(`reach ${rk.reach} km → ${rn.reach} NM (expected ${Math.ceil(rk.reach / 1.852 - 1e-9)})`);
    if (rn && rn.range !== want600) errs.push(`range in reach line ${rn.range} ${rn.unit}`);
    if (!rb || rb.unit !== 'km' || (rk && rb.reach !== rk.reach)) errs.push(`back to km: ${JSON.stringify(back.metas)}`);
    const pickKm = pickR.filter(t => /\d\s*km/.test(t || '')).length; ctx.state.pickUnderNm = { pickR, pickKm };
    const detail = `km: "${km.sp}" / ${rk && rk.text}; NM: "${nm.sp}" / ${rn && rn.text}; Change list under NM: ${JSON.stringify(pickR)} (${pickKm} rows still in km); classic NM: psRange "${cl.psRange}" psAvail "${cl.psAvail}"; back: "${back.sp}" / ${rb && rb.text}`;
    if (errs.length) throw new Error(errs.join('; ') + ' — ' + detail);
    return { detail, repro: 'click #unitSeg [data-u=nm]; read .ac-ov .sp + Reach line; classic CNSUnits.fmtDist(600)', evidence: [ctx.shot('units-nm')] };
  }, { retry: 0 });


  await ctx.check('picker-units-follow-toggle', async () => {
    // classic index.html:6006 prints aircraft ranges with fmtDist (units-aware); v2's Change list hard-codes `${range_km} km`.
    let st = ctx.state.pickUnderNm;
    if (!st) {
      await ensureForm(); await v2.click('#unitSeg [data-u=nm]'); await v2.waitFor('CNSUnits.isNautical()', 3000);
      await v2.click('[data-act=pick]'); await v2.waitFor(`document.querySelectorAll('.pick button').length > 0`, 3000);
      const pickR = await v2.eval(`[...document.querySelectorAll('.pick button')].slice(0, 5).map(b => (b.querySelector('.r') || {}).textContent)`);
      await v2.click('[data-act=pick]'); await v2.waitFor('!CNSUI.S.picking', 3000);
      await v2.click('#unitSeg [data-u=km]'); await v2.waitFor('!CNSUnits.isNautical()', 3000);
      st = { pickR, pickKm: pickR.filter(t => /\d\s*km/.test(t || '')).length };
    }
    const cl = await classic.eval(`(function(){ CNSUnits.set('nautical'); const s = CNSUnits.fmtDist(87.5); CNSUnits.set('metric'); return s; })()`);
    const detail = `Change list under NM: ${JSON.stringify(st.pickR)} — ${st.pickKm}/${st.pickR.length} rows in km; classic fmtDist(87.5) under NM = "${cl}"`;
    if (st.pickKm) throw new Error(detail);
    return { detail, repro: 'click #unitSeg [data-u=nm]; click [data-act=pick]; read .pick .r' };
  }, { retry: 0 });

  await ctx.check('no-exceptions', async () => {
    const ex = v2.exceptions(); const cx = ctx.exceptions(classic);
    if (ex.length || cx.length) throw new Error(`v2 ${ex.length}: ${ex.map(e => e.text).join(' || ')} · classic ${cx.length}: ${cx.map(e => e.text).join(' || ')}`);
    return `v2 exceptions 0 (errors ${v2.errors.length}), classic exceptions 0 (errors ${classic.errors.length}, known TDZ filtered ${classic.exceptions().length - cx.length})`;
  }, { retry: 0 });
}
