/* CNS v2 — ui/proto.js: the docked layout of the prototype (?proto; design audit P1). The rail and the
   timeline stop floating over the map: the map gets the rectangle they leave, and a splitter sets the
   timeline's height. Inert without ?proto. */
(function () {
  const UI = window.CNSUI; if (!UI || !UI.PROTO) return;
  const KEY = 'cns_proto_tl_h', BAR = 36;
  const drawer = () => document.getElementById('drawer');
  let tlH = 0; try { tlH = +localStorage.getItem(KEY) || 0; } catch (e) { /* private mode: default height */ }
  const clamp = h => Math.max(140, Math.min(window.innerHeight - 44 - 180, h));   // the map keeps at least 180 px
  let _t = null;
  function layout(settle) {
    const d = drawer(); if (!d) return;
    const h = clamp(tlH || Math.round(window.innerHeight * 0.4)), open = d.classList.contains('open');
    document.body.style.setProperty('--tl-h', h + 'px');
    document.body.style.setProperty('--map-b', (open ? h : BAR) + 'px');
    const m = UI.map && UI.map.map; if (!m) return;
    m.invalidateSize({ pan: false });
    // Opening or closing the timeline changes the map's size: re-frame only what fell out of view.
    if (settle) { clearTimeout(_t); _t = setTimeout(() => UI.map.ensureVisible && UI.map.ensureVisible(), 60); }
  }
  const d = drawer(); if (!d) return;
  const sp = document.createElement('div'); sp.className = 'tl-split'; sp.title = 'Drag to resize the timeline'; d.prepend(sp);
  sp.addEventListener('pointerdown', e => {
    e.preventDefault(); sp.setPointerCapture(e.pointerId);
    const move = ev => { tlH = clamp(window.innerHeight - ev.clientY); layout(false); };
    const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); try { localStorage.setItem(KEY, String(tlH)); } catch (e2) { /* keep it for this visit */ } layout(true); };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
  });
  new MutationObserver(() => layout(true)).observe(d, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => layout(false));
  layout(false);
})();
