/* CNS v2 — ui/gl.js: the v2 map on MapLibre GL (globe when zoomed out), behind the small part of Leaflet's API
   the map code uses. map.js, waypoints.js and the two modules shared with the Leaflet classic page (range-graph.js,
   divert-edit.js) keep their drawing code: CNSGL.map() stands in for L.map() and CNSGL.L for L.

   - Zoom is Leaflet's scale (256 px tiles): MapLibre's zoom + 1. Every threshold in the callers keeps its meaning.
   - Vector shapes (polyline, polygon, circle, circleMarker) are GeoJSON features in one source per pane and kind,
     styled from their own properties; panes order the layers by their zIndex as Leaflet panes do.
   - Markers with a divIcon are MapLibre HTML markers; tooltips and popups reuse the Leaflet classes, so they look the same.
   - One click dispatcher: an interactive shape or airport dot under the pointer (3 px tolerance) takes the click,
     else the map's own click handlers get it, as Leaflet's bubbling does. */
window.CNSGL = (function () {
  'use strict';
  const Z = 1;   // Leaflet zoom = MapLibre zoom + Z

  // ---- geometry (pure; tests/js_gl_bounds.test.mjs) ----------------------------------------------------------
  function latLng(a, b) {
    if (a == null) return null;
    if (typeof a === 'number') return { lat: +a, lng: +b };
    if (Array.isArray(a)) return { lat: +a[0], lng: +a[1] };
    return { lat: +a.lat, lng: +(a.lng != null ? a.lng : a.lon) };
  }
  const wrap = x => (x >= -180 && x <= 180) ? x : ((x + 540) % 360) - 180;   // in range: untouched (no float noise)
  /** Bounds over a set of points that never take the long way round: the east edge is the west edge plus the
      span of the smallest arc holding every longitude, so a set across 180° stays narrow (east may exceed 180). */
  class Bounds {
    constructor(pts) { this.pts = []; (pts || []).forEach(p => this.extend(p)); }
    extend(p) { if (p instanceof Bounds) { p.pts.forEach(q => this.pts.push(q)); } else { const q = latLng(p); if (q && isFinite(q.lat) && isFinite(q.lng)) this.pts.push(q); } this._c = null; return this; }
    isValid() { return this.pts.length > 0; }
    _calc() {
      if (this._c) return this._c;
      const lats = this.pts.map(p => p.lat), lons = this.pts.map(p => wrap(p.lng)).sort((a, b) => a - b);
      let w = lons[0], span = lons[lons.length - 1] - lons[0];
      for (let i = 1; i < lons.length; i++) { const gap = lons[i] - lons[i - 1]; if (360 - gap < span) { span = 360 - gap; w = lons[i]; } }
      return (this._c = { s: Math.min(...lats), n: Math.max(...lats), w, e: w + span });
    }
    getSouth() { return this._calc().s; } getNorth() { return this._calc().n; } getWest() { return this._calc().w; } getEast() { return this._calc().e; }
    getSouthWest() { const c = this._calc(); return { lat: c.s, lng: c.w }; } getNorthEast() { const c = this._calc(); return { lat: c.n, lng: c.e }; }
    getCenter() { const c = this._calc(); return { lat: (c.s + c.n) / 2, lng: wrap((c.w + c.e) / 2) }; }
    pad(r) { const c = this._calc(), dy = (c.n - c.s) * r, dx = (c.e - c.w) * r, b = new Bounds();
      b._c = { s: Math.max(-90, c.s - dy), n: Math.min(90, c.n + dy), w: c.w - dx, e: Math.min(c.w + 360, c.e + dx) }; b.pts = [{ lat: b._c.s, lng: b._c.w }, { lat: b._c.n, lng: b._c.e }]; return b; }
    contains(p) { const q = latLng(p), c = this._calc(); if (q.lat < c.s || q.lat > c.n) return false; if (c.e - c.w >= 360) return true;
      let x = wrap(q.lng); while (x < c.w) x += 360; return x <= c.e; }
  }
  const latLngBounds = (a, b) => new Bounds(b != null ? [a, b] : (a instanceof Bounds ? a.pts : a));

  /** Initial great-circle course a → b in degrees (0..360). */
  function course(a, b) {
    const R = Math.PI / 180, la1 = a.lat * R, la2 = b.lat * R, dl = (b.lng - a.lng) * R;
    return (Math.atan2(Math.sin(dl) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)) / R + 360) % 360;
  }
  /** A geodesic circle of `m` metres round `c` as a ring of [lat, lng]. */
  function circleRing(c, m, n) {
    n = n || 72; const R = Math.PI / 180, d = m / 6371008.8, la1 = c.lat * R, lo1 = c.lng * R, out = [];
    for (let i = 0; i <= n; i++) { const b = i / n * 2 * Math.PI;
      const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
      const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
      out.push({ lat: la2 / R, lng: lo2 / R }); }
    return out;
  }
  /** A line's longitudes made continuous (no 360° jump between neighbours), so a leg across 180° draws short. */
  function unwrapLine(pts) { const out = []; let prev = null; pts.forEach(p => { let x = p.lng; if (prev != null) { while (x - prev > 180) x -= 360; while (x - prev < -180) x += 360; } out.push([x, p.lat]); prev = x; }); return out; }

  // ---- layers ------------------------------------------------------------------------------------------------
  let SEQ = 0;
  class Layer {
    constructor(opts) { this.options = Object.assign({}, opts || {}); this._id = ++SEQ; this._map = null; this._ev = {}; }
    on(t, fn) { t.split(' ').forEach(k => (this._ev[k] = this._ev[k] || []).push(fn)); return this; }
    off(t, fn) { t.split(' ').forEach(k => { this._ev[k] = (this._ev[k] || []).filter(f => fn && f !== fn); }); return this; }
    fire(t, e) { (this._ev[t] || []).forEach(f => f(Object.assign({ target: this, type: t }, e || {}))); return this; }
    addTo(m) { (m instanceof Group ? m : m).addLayer(this); return this; }
    remove() { if (this._parent) this._parent.removeLayer(this); else if (this._map) this._map.removeLayer(this); return this; }
    bindPopup(c, o) { this._popup = { c, o: o || {} }; return this; }
    bindTooltip(c, o) { this._tip = { c, o: o || {} }; if (this._tipEl) this._renderTip(); return this; }
    setTooltipContent(c) { if (this._tip) { this._tip.c = c; this._renderTip && this._renderTip(); } return this; }
    _openPopupAt(ll) { if (!this._popup || !this._map) return; const c = typeof this._popup.c === 'function' ? this._popup.c(this) : this._popup.c; this._map.openPopup(c, ll || this.getLatLng(), this._popup.o); }
  }
  class Group extends Layer {
    constructor(layers, opts) { super(opts); this._kids = new Set(); (layers || []).forEach(l => this.addLayer(l)); }
    addLayer(l) { if (l._parent && l._parent !== this) l._parent.removeLayer(l); l._parent = this; if (!l.options.pane && this.options.pane) l.options.pane = this.options.pane; this._kids.add(l); if (this._map) this._map._attach(l); return this; }
    removeLayer(l) { if (this._kids.delete(l)) { if (this._map) this._map._detach(l); l._parent = null; } return this; }
    clearLayers() { [...this._kids].forEach(l => this.removeLayer(l)); return this; }
    eachLayer(fn) { this._kids.forEach(fn); return this; }
    getLayers() { return [...this._kids]; }
    hasLayer(l) { return this._kids.has(l); }
    _onAdd(m) { this._kids.forEach(l => m._attach(l)); }
    _onRemove(m) { this._kids.forEach(l => m._detach(l)); }
  }
  class Shape extends Layer {
    setStyle(s) { Object.assign(this.options, s); this._dirty(); return this; }
    _dirty() { if (this._map) this._map._dirty(); }
  }
  class Polyline extends Shape {
    constructor(lls, o) { super(o); this._lls = (lls || []).map(p => latLng(p)); }
    getLatLngs() { return this._lls.slice(); }
    setLatLngs(lls) { this._lls = lls.map(p => latLng(p)); this._dirty(); return this; }
    getBounds() { return new Bounds(this._lls); }
  }
  class Polygon extends Polyline {}
  class Circle extends Polygon {   // geodesic: radius in metres
    constructor(c, o) { const ll = latLng(c); super(circleRing(ll, (o && o.radius) || 0), o); this._c = ll; }
    getLatLng() { return this._c; }
  }
  class CircleMarker extends Shape {   // radius in pixels
    constructor(c, o) { super(Object.assign({ radius: 10 }, o)); this._ll = latLng(c); }
    getLatLng() { return this._ll; } setLatLng(c) { this._ll = latLng(c); this._dirty(); return this; }
    setRadius(r) { this.options.radius = r; this._dirty(); return this; }
    getLatLngs() { return [this._ll]; }
  }
  class Marker extends Layer {
    constructor(c, o) { super(o); this._ll = latLng(c); }
    getLatLng() { return this._ml ? latLng(this._ml.getLngLat().lat, this._ml.getLngLat().lng) : this._ll; }
    setLatLng(c) { this._ll = latLng(c); if (this._ml) this._ml.setLngLat([this._ll.lng, this._ll.lat]); return this; }
    getLatLngs() { return [this.getLatLng()]; }
    _build(map) {
      const ic = this.options.icon || divIcon({ className: 'cnsgl-default', html: '', iconSize: [10, 10] });
      const size = ic.iconSize || [0, 0], anchor = ic.iconAnchor || [size[0] / 2, size[1] / 2];
      const el = document.createElement('div');
      el.className = 'cnsgl-icon ' + (ic.className || '');
      el.style.width = size[0] + 'px'; el.style.height = size[1] + 'px';
      el.innerHTML = ic.html || '';
      if (this.options.title) el.title = this.options.title;
      const z = (map._paneZ(this.options.pane || 'markerPane')) + (this.options.zIndexOffset || 0);
      const wrapEl = document.createElement('div'); wrapEl.className = 'cnsgl-marker'; wrapEl.appendChild(el);
      if (this.options.interactive === false) wrapEl.style.pointerEvents = 'none';
      this._el = el; this._tipEl = null;
      // opacityWhenCovered 0: a marker on the far side of the globe is hidden, not drawn through it
      const ml = new maplibregl.Marker({ element: wrapEl, anchor: 'top-left', offset: [-anchor[0], -anchor[1]], draggable: !!this.options.draggable, opacityWhenCovered: '0' });
      ml.setLngLat([this._ll.lng, this._ll.lat]);
      ml.getElement().style.zIndex = String(z);
      if (this.options.draggable) { ml.on('drag', () => this.fire('drag')); ml.on('dragend', () => { this._ll = this.getLatLng(); this.fire('dragend'); }); }
      wrapEl.addEventListener('click', e => { if (this.options.interactive === false) return; e.stopPropagation(); this.fire('click', { latlng: this.getLatLng(), originalEvent: e }); this._openPopupAt(); });
      if (this._tip) this._renderTip();
      if (this._tip && !this._tip.o.permanent) { wrapEl.addEventListener('mouseenter', () => this._tipEl && (this._tipEl.style.display = '')); wrapEl.addEventListener('mouseleave', () => this._tipEl && (this._tipEl.style.display = 'none')); }
      this._ml = ml; return ml;
    }
    _renderTip() {
      if (!this._el || !this._tip) return;
      if (!this._tipEl) { this._tipEl = document.createElement('div'); this._el.parentNode.appendChild(this._tipEl); }
      const o = this._tip.o, off = o.offset || [0, 0], dir = o.direction || 'top';
      this._tipEl.className = `leaflet-tooltip leaflet-tooltip-${dir} cnsgl-tip ${o.className || ''}`;
      this._tipEl.innerHTML = typeof this._tip.c === 'function' ? this._tip.c(this) : this._tip.c;
      const ic = this.options.icon || {}, size = ic.iconSize || [0, 0], anchor = ic.iconAnchor || [size[0] / 2, size[1] / 2];
      this._tipEl.style.cssText = `position:absolute;left:${anchor[0] + off[0]}px;top:${anchor[1] + off[1]}px;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap;${o.permanent ? '' : 'display:none'}`;
    }
  }
  function divIcon(o) { return Object.assign({ className: '', html: '' }, o || {}); }

  // ---- the map -----------------------------------------------------------------------------------------------
  const KIND = { line: 'line', fill: 'fill', circle: 'circle' };
  class GLMap {
    constructor(el, opts) {
      opts = opts || {};
      this._el = typeof el === 'string' ? document.getElementById(el) : el;
      this._panes = { overlayPane: { style: { zIndex: 400 } }, markerPane: { style: { zIndex: 600 } } };
      this._layers = new Set(); this._ev = {}; this._interactive = []; this._srcs = {}; this._ready = false; this._pending = false;
      const c = latLng(opts.center || [51.6, 6.5]);
      this.ml = new maplibregl.Map({
        container: this._el, center: [c.lng, c.lat], zoom: (opts.zoom != null ? opts.zoom : 6) - Z,
        style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': opts.background || '#e9eaef' } }] },
        dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0, attributionControl: false, fadeDuration: 0,
      });
      this.ml.touchZoomRotate.disableRotation(); if (this.ml.keyboard && this.ml.keyboard.disableRotation) this.ml.keyboard.disableRotation();
      this.ml.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
      this._globe = opts.globe !== false;
      this.ml.on('style.load', () => { this._ready = true; this._applyProjection(); this._addArrow(); this._flush(); (this._onReady || []).forEach(f => f()); this._onReady = []; });
      // A basemap tile that fails to load (offline, a blocked host) leaves a grey square, as Leaflet does: one quiet
      // warning, not an error per tile. Anything else still reaches the console.
      this.ml.on('error', e => { const msg = String((e && e.error && e.error.message) || e && e.error || '');
        if (/Failed to fetch|AJAXError|NetworkError|Load failed/i.test(msg) || (e && e.tile)) { if (!this._tileWarned) { this._tileWarned = true; console.warn('[map] basemap tiles unavailable:', msg); } return; }
        console.error(e && e.error ? e.error : e); });
      this.ml.on('click', e => this._click(e));
      this.ml.on('mousemove', e => this._hover(e));
      ['moveend', 'zoomend', 'movestart', 'zoomstart'].forEach(t => this.ml.on(t, () => this.fire(t)));
    }
    whenReady(f) { if (this._ready) f(); else (this._onReady = this._onReady || []).push(f); return this; }
    // events
    on(t, fn) { t.split(' ').forEach(k => (this._ev[k] = this._ev[k] || []).push(fn)); return this; }
    off(t, fn) { t.split(' ').forEach(k => { this._ev[k] = (this._ev[k] || []).filter(f => fn && f !== fn); }); return this; }
    fire(t, e) { (this._ev[t] || []).slice().forEach(f => f(Object.assign({ target: this, type: t }, e || {}))); return this; }
    // view
    getZoom() { return this.ml.getZoom() + Z; }
    getCenter() { const c = this.ml.getCenter(); return { lat: c.lat, lng: c.lng }; }
    setView(c, z, o) { const ll = latLng(c); this.ml.jumpTo({ center: [ll.lng, ll.lat], zoom: (z != null ? z : this.getZoom()) - Z }); return this; }
    panTo(c, o) { const ll = latLng(c); (o && o.animate) ? this.ml.easeTo({ center: [ll.lng, ll.lat], duration: 300 }) : this.ml.jumpTo({ center: [ll.lng, ll.lat] }); return this; }
    flyTo(c, z) { const ll = latLng(c); this.ml.flyTo({ center: [ll.lng, ll.lat], zoom: (z != null ? z : this.getZoom()) - Z, duration: 900 }); return this; }
    getSize() { return { x: this._el.clientWidth, y: this._el.clientHeight }; }
    invalidateSize() { this.ml.resize(); return this; }
    latLngToContainerPoint(c) { const ll = latLng(c), p = this.ml.project([ll.lng, ll.lat]); return { x: p.x, y: p.y }; }
    containerPointToLatLng(p) { const ll = this.ml.unproject([p.x != null ? p.x : p[0], p.y != null ? p.y : p[1]]); return { lat: ll.lat, lng: ll.lng }; }
    getBounds() { const b = this.ml.getBounds(); const out = new Bounds(); out._c = { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() }; if (out._c.e - out._c.w > 360 || this.getZoom() < 3) out._c = { s: -90, n: 90, w: -180, e: 180 }; out.pts = [{ lat: out._c.s, lng: out._c.w }, { lat: out._c.n, lng: out._c.e }]; return out; }
    fitBounds(b, o) {
      o = o || {}; const B = b instanceof Bounds ? b : new Bounds(b); if (!B.isValid()) return this;
      const tl = o.paddingTopLeft || [o.padding || 0, o.padding || 0], br = o.paddingBottomRight || [o.padding || 0, o.padding || 0], sz = this.getSize();
      // padding wider than the map leaves MapLibre nothing to fit into: shrink it to leave a third of the map
      const fx = Math.min(1, (sz.x * .67) / Math.max(1, tl[0] + br[0])), fy = Math.min(1, (sz.y * .67) / Math.max(1, tl[1] + br[1]));
      const pad = { left: tl[0] * fx, right: br[0] * fx, top: tl[1] * fy, bottom: br[1] * fy };
      const c = B._calc(), opts = { padding: pad, animate: !!o.animate, duration: o.animate ? 450 : 0 };
      if (o.maxZoom != null) opts.maxZoom = o.maxZoom - Z;
      if (c.n - c.s < 1e-6 && c.e - c.w < 1e-6) { this.ml.jumpTo({ center: [c.w, c.s], zoom: Math.min(this.ml.getZoom(), opts.maxZoom != null ? opts.maxZoom : 22) }); return this; }
      this.ml.fitBounds([[c.w, c.s], [c.e, c.n]], opts); return this;
    }
    // globe
    setGlobe(on) { this._globe = !!on; if (this._ready) this._applyProjection(); return this; }
    _applyProjection() { try { this.ml.setProjection({ type: this._globe ? 'globe' : 'mercator' }); } catch (e) { console.warn('[gl] projection', e); } }
    // panes
    createPane(n) { return (this._panes[n] = this._panes[n] || { style: { zIndex: 400 } }); }
    getPane(n) { return this._panes[n]; }
    _paneZ(n) { const p = this._panes[n]; return p ? +p.style.zIndex || 400 : 400; }
    // layers
    addLayer(l) { if (l._parent) l._parent.removeLayer(l); this._layers.add(l); this._attach(l); return this; }
    removeLayer(l) { if (l._parent) { l._parent.removeLayer(l); return this; } if (this._layers.delete(l)) this._detach(l); return this; }
    hasLayer(l) { return this._layers.has(l) || (!!l._parent && !!l._parent._map); }
    _attach(l) {
      if (l._map === this) return; l._map = this;
      if (l instanceof Group) { l._onAdd(this); return; }
      if (l instanceof Marker) { l._build(this).addTo(this.ml); l.fire('add'); return; }
      this._dirty(); l.fire('add');
    }
    _detach(l) {
      if (l._map !== this) return; l._map = null;
      if (l instanceof Group) { l._onRemove(this); return; }
      if (l instanceof Marker) { if (l._ml) l._ml.remove(); l._ml = null; return; }
      this._dirty();
    }
    eachLayer(fn) { const walk = l => { if (l instanceof Group) l.eachLayer(walk); else fn(l); }; this._layers.forEach(walk); return this; }
    _dirty() { if (this._pending) return; this._pending = true; requestAnimationFrame(() => { this._pending = false; this._flush(); }); }
    // Every attached shape, by pane and kind, into one GeoJSON source each; styles ride as feature properties.
    _flush() {
      if (!this._ready) return;
      const by = {}, add = (pane, kind, f) => { const k = pane + '|' + kind; (by[k] = by[k] || []).push(f); };
      const ids = {}; this._interactive = [];
      this.eachLayer(l => {
        if (l instanceof Marker || !l._map) return;
        const o = l.options, pane = o.pane || 'overlayPane';
        if (l instanceof CircleMarker) {
          const fill = o.fill !== false;
          add(pane, 'circle', { type: 'Feature', id: l._id, properties: { id: l._id, r: o.radius, fc: o.fillColor || o.color || '#3388ff', fo: fill ? (o.fillOpacity != null ? o.fillOpacity : .2) : 0,
            sc: o.color || '#3388ff', sw: o.stroke === false ? 0 : (o.weight != null ? o.weight : 3), so: o.opacity != null ? o.opacity : 1 }, geometry: { type: 'Point', coordinates: [l._ll.lng, l._ll.lat] } });
          if (o.interactive !== false && (l._ev.click || l._popup || l._tip)) { ids[l._id] = l; this._interactive.push(pane + '|circle'); }
          return;
        }
        const lls = l._lls; if (!lls || lls.length < 2) return;
        const isPoly = l instanceof Polygon, coords = unwrapLine(isPoly ? lls.concat([lls[0]]) : lls);
        if (isPoly && o.fill !== false && (o.fillOpacity == null || o.fillOpacity > 0))
          add(pane, 'fill', { type: 'Feature', properties: { fc: o.fillColor || o.color || '#3388ff', fo: o.fillOpacity != null ? o.fillOpacity : .2 }, geometry: { type: 'Polygon', coordinates: [coords] } });
        if (o.stroke !== false && (o.opacity == null || o.opacity > 0)) {
          const w = o.weight != null ? o.weight : 3, dash = o.dashArray ? String(o.dashArray) : '';
          add(pane, 'line' + (dash ? '~' + dash : ''), { type: 'Feature', properties: { c: o.color || '#3388ff', w, o: o.opacity != null ? o.opacity : 1 }, geometry: { type: 'LineString', coordinates: coords } });
        }
        if (o.arrowEnd && lls.length >= 2) {
          const a = lls[lls.length - 2], b = lls[lls.length - 1];
          add(pane, 'arrow', { type: 'Feature', properties: { b: (course(b, a) + 180) % 360 }, geometry: { type: 'Point', coordinates: [b.lng, b.lat] } });
        }
      });
      this._ids = ids;
      // sources: write the live ones, empty the rest; layers are created on first use, in pane order
      Object.keys(this._srcs).forEach(k => { if (!by[k]) { by[k] = []; } });
      Object.keys(by).sort((x, y) => this._order(x) - this._order(y)).forEach(k => this._source(k).setData({ type: 'FeatureCollection', features: by[k] }));
    }
    _order(k) { const [pane, kind] = k.split('|'), base = kind.startsWith('line') ? 1 : kind === 'fill' ? 0 : kind === 'circle' ? 2 : 3; return this._paneZ(pane) * 10 + base; }
    _source(k) {
      if (this._srcs[k]) return this.ml.getSource(this._srcs[k]);
      const id = 'gl-' + Object.keys(this._srcs).length; this._srcs[k] = id;
      this.ml.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const [, kind] = k.split('|'), before = this._beforeFor(this._order(k));
      if (kind === 'fill') this.ml.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': ['get', 'fc'], 'fill-opacity': ['get', 'fo'] } }, before);
      else if (kind === 'circle') this.ml.addLayer({ id, type: 'circle', source: id, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'fc'], 'circle-opacity': ['get', 'fo'], 'circle-stroke-color': ['get', 'sc'], 'circle-stroke-width': ['get', 'sw'], 'circle-stroke-opacity': ['get', 'so'], 'circle-pitch-alignment': 'map' } }, before);
      else if (kind === 'arrow') this.ml.addLayer({ id, type: 'symbol', source: id, layout: { 'icon-image': 'cnsgl-arrow', 'icon-rotate': ['-', ['get', 'b'], 90], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-offset': [-14, 0] } }, before);
      else {
        const dash = kind.includes('~') ? kind.split('~')[1].split(/[ ,]+/).map(Number).filter(n => n > 0) : null;
        const paint = { 'line-color': ['get', 'c'], 'line-width': ['get', 'w'], 'line-opacity': ['get', 'o'] };
        if (dash && dash.length) paint['line-dasharray'] = dash.map(v => v / 2);   // dash units are line widths; ~2 px lines
        this.ml.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': dash ? 'butt' : 'round', 'line-join': 'round' }, paint }, before);
      }
      this._layerOrder = (this._layerOrder || []).concat([{ id, o: this._order(k) }]).sort((a, b) => a.o - b.o);
      return this.ml.getSource(id);
    }
    _beforeFor(o) { const next = (this._layerOrder || []).find(x => x.o > o && this.ml.getLayer(x.id)); return next ? next.id : undefined; }
    _addArrow() {
      if (this.ml.hasImage('cnsgl-arrow')) return;
      const s = 2, cv = document.createElement('canvas'); cv.width = 14 * s; cv.height = 12 * s; const g = cv.getContext('2d'); g.scale(s, s);
      g.beginPath(); g.moveTo(2, 2); g.lineTo(12, 6); g.lineTo(2, 10); g.closePath(); g.lineJoin = 'round'; g.lineWidth = 2; g.strokeStyle = '#fff'; g.fillStyle = '#c4421f'; g.fill(); g.stroke();
      this.ml.addImage('cnsgl-arrow', g.getImageData(0, 0, cv.width, cv.height), { pixelRatio: s });
    }
    // clicks + hover: an interactive feature under the pointer takes it, else the map's handlers
    _hits(e) {
      const layers = [...new Set(this._interactive)].map(k => this._srcs[k]).filter(Boolean).concat(this._extraLayers ? this._extraLayers.map(x => x.id) : []).filter(id => this.ml.getLayer(id));
      if (!layers.length) return [];
      const p = e.point, t = 3;
      return this.ml.queryRenderedFeatures([[p.x - t, p.y - t], [p.x + t, p.y + t]], { layers });
    }
    _click(e) {
      const ll = { lat: e.lngLat.lat, lng: e.lngLat.lng }, hits = this._hits(e);
      for (const f of hits) {
        const x = (this._extraLayers || []).find(q => q.id === f.layer.id); if (x) { x.onClick(f, ll, e); return; }
        const l = this._ids && this._ids[f.properties.id]; if (l) { l.fire('click', { latlng: l.getLatLng(), originalEvent: e.originalEvent }); l._openPopupAt(); return; }
      }
      this.fire('click', { latlng: ll, originalEvent: e.originalEvent });
    }
    _hover(e) {
      const hits = this._hits(e), f = hits[0];
      this.ml.getCanvas().style.cursor = f ? 'pointer' : '';
      const l = f && this._ids && this._ids[f.properties.id];
      const tip = l && l._tip ? (typeof l._tip.c === 'function' ? l._tip.c(l) : l._tip.c) : null;
      if (tip) { const o = l._tip.o, off = o.offset || [0, 0];
        if (!this._tipPopup) this._tipPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'cnsgl-hover', offset: [off[0], off[1] - 4] });
        this._tipPopup.setLngLat([l._ll.lng, l._ll.lat]).setHTML(tip).addTo(this.ml); }
      else if (this._tipPopup) this._tipPopup.remove();
    }
    /** A raw MapLibre layer (the airport dots) that joins the click dispatcher: onClick(feature, latlng, event). */
    addInteractiveLayer(id, onClick) { (this._extraLayers = this._extraLayers || []).push({ id, onClick }); return this; }
    /** A raw MapLibre layer's place among the panes (as if it were in a pane of this zIndex). */
    placeRaw(id, z) { this._layerOrder = (this._layerOrder || []).concat([{ id, o: z * 10 + 2 }]).sort((a, b) => a.o - b.o); return this; }
    // popups
    openPopup(html, c, o) {
      o = o || {}; const ll = latLng(c); this.closePopup();
      const off = o.offset || [0, 0];
      this._popup = new maplibregl.Popup({ closeButton: false, maxWidth: 'none', offset: [off[0], off[1] - 6], className: 'cnsgl-popup' }).setLngLat([ll.lng, ll.lat]).setHTML(html).addTo(this.ml);
      return this._popup;
    }
    closePopup() { if (this._popup) { this._popup.remove(); this._popup = null; } return this; }
    /** Everything drawn, for the tests: { pane, kind, latlngs, opacity, weight, radius }. */
    drawn() { const out = []; this.eachLayer(l => { const kind = l instanceof Marker ? 'marker' : l instanceof CircleMarker ? 'circleMarker' : l instanceof Circle ? 'circle' : l instanceof Polygon ? 'polygon' : 'polyline';
      out.push({ pane: l.options.pane || (kind === 'marker' ? 'markerPane' : 'overlayPane'), kind, latlngs: l.getLatLngs ? l.getLatLngs() : [], opacity: l.options.opacity, weight: l.options.weight, radius: l.options.radius, dash: l.options.dashArray || null, arrow: !!l.options.arrowEnd, html: l.options.icon ? l.options.icon.html : null }); }); return out; }
  }

  const L = {
    map: (el, o) => new GLMap(el, o), layerGroup: (ls, o) => new Group(ls, o), featureGroup: (ls, o) => new Group(ls, o),
    polyline: (a, o) => new Polyline(a, o), polygon: (a, o) => new Polygon(a, o), circle: (c, o) => new Circle(c, o), circleMarker: (c, o) => new CircleMarker(c, o),
    marker: (c, o) => new Marker(c, o), divIcon, latLng, latLngBounds,
    popup: o => { let ll = null, html = ''; const p = { setLatLng(c) { ll = c; return p; }, setContent(h) { html = h; return p; }, openOn(m) { m.openPopup(html, ll, o); return p; } }; return p; },
  };
  /** WebGL present? The page shows a message instead of a broken map when not. */
  function supported() { try { const c = document.createElement('canvas'); return !!(window.WebGL2RenderingContext && c.getContext('webgl2')) || !!c.getContext('webgl'); } catch (e) { return false; } }
  return { map: (el, o) => new GLMap(el, o), L, Bounds, latLngBounds, course, circleRing, unwrapLine, supported };
})();
if (typeof module !== 'undefined') module.exports = window.CNSGL;
