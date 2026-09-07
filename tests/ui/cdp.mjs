/* tests/ui/cdp.mjs — dependency-free CDP driver over headless Chrome (Node ≥ 22 built-ins only:
   global WebSocket + fetch, child_process, fs). One WebSocket per browser, flat sessions.
   See tests/ui/README.md for the API and the pitfalls. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CHROME = process.env.CNS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Hosts the driver refuses (tiles, fonts, airport photos): every scenario runs offline for those.
export const BLOCK_PATTERNS = ['*://server.arcgisonline.com/*', '*://basemaps.cartocdn.com/*', '*://*.basemaps.cartocdn.com/*',
  '*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*', '*/api/airport-photo/*'];
export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const VK = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, what) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

// ---------------------------------------------------------------------------------------------
export async function launch({ profileDir, downloadDir, size = [1440, 900] } = {}) {
  if (!profileDir) throw new Error('launch: profileDir required');
  fs.mkdirSync(profileDir, { recursive: true }); if (downloadDir) fs.mkdirSync(downloadDir, { recursive: true });
  try { fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort')); } catch (e) {}
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--remote-allow-origins=*',
    `--window-size=${size[0]},${size[1]}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let port = 0, wsPath = '';
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode != null) throw new Error(`chrome exited (${proc.exitCode}): ${stderr.slice(-800)}`);
    try { const [p, w] = fs.readFileSync(portFile, 'utf8').split('\n'); if (+p && w) { port = +p; wsPath = w.trim(); break; } } catch (e) {}
    await sleep(50);
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('chrome: DevToolsActivePort never appeared: ' + stderr.slice(-800)); }
  const browser = new Browser(proc, profileDir, downloadDir, size);
  await browser._connect(`ws://127.0.0.1:${port}${wsPath}`);
  if (downloadDir) await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
  return browser;
}

export class Browser {
  constructor(proc, profileDir, downloadDir, size) {
    this.proc = proc; this.profileDir = profileDir; this.downloadDir = downloadDir; this.size = size;
    this.pages = []; this.downloads = []; this._id = 0; this._pending = new Map(); this._sessions = new Map(); this._closed = false;
  }
  _connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url); this.ws = ws;
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', e => rej(new Error('ws error ' + (e.message || ''))));
      ws.addEventListener('close', () => { this._closed = true; for (const [, p] of this._pending) p.reject(new Error('cdp socket closed')); this._pending.clear(); });
      ws.addEventListener('message', ev => this._onMessage(String(ev.data)));
    });
  }
  _onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id != null) { const p = this._pending.get(m.id); if (!p) return; this._pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(`${p.method}: ${m.error.message}${m.error.data ? ' — ' + m.error.data : ''}`), { cdp: m.error })); else p.resolve(m.result || {}); return; }
    if (m.method) {
      if (m.method === 'Browser.downloadWillBegin') this.downloads.push({ guid: m.params.guid, url: m.params.url, filename: m.params.suggestedFilename, state: 'inProgress', bytes: 0, t: Date.now() });
      if (m.method === 'Browser.downloadProgress') { const d = this.downloads.find(x => x.guid === m.params.guid); if (d) { d.state = m.params.state; d.bytes = m.params.receivedBytes; d.total = m.params.totalBytes; } }
      const page = m.sessionId && this._sessions.get(m.sessionId); if (page) page._onEvent(m.method, m.params);
    }
  }
  send(method, params = {}, sessionId) {
    if (this._closed) return Promise.reject(new Error('cdp socket closed'));
    const id = ++this._id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => { this._pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify(msg)); });
  }
  /** New tab in the same profile (shared localStorage / cookies) — used for the classic parity tab. */
  async newPage(label) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId, label || `page${this.pages.length + 1}`);
    this._sessions.set(sessionId, page); this.pages.push(page);
    await page._init();
    return page;
  }
  async close({ keepProfile = false } = {}) {
    if (!this._closed) { try { await withTimeout(this.send('Browser.close'), 2000, 'Browser.close'); } catch (e) {} }
    const exited = new Promise(r => { if (this.proc.exitCode != null) r(); else this.proc.once('exit', r); });
    try { await withTimeout(exited, 2000, 'chrome exit'); } catch (e) { try { this.proc.kill('SIGKILL'); } catch (e2) {} }
    try { this.ws.close(); } catch (e) {}
    if (!keepProfile) { try { fs.rmSync(this.profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

// ---------------------------------------------------------------------------------------------
export class Page {
  constructor(browser, sessionId, targetId, label) {
    this.browser = browser; this.sessionId = sessionId; this.targetId = targetId; this.label = label;
    this.errors = []; this.console = []; this.responses = []; this.failed = []; this.blocked = []; this.url = '';
    this._req = new Map(); this._seedId = null; this._waiters = []; this._seenDownloads = new Set();
  }
  send(method, params) { return this.browser.send(method, params, this.sessionId); }
  async _init() {
    const [w, h] = this.browser.size;
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Network.enable'); await this.send('Log.enable');
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.send('Fetch.enable', { patterns: BLOCK_PATTERNS.map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
  }
  _onEvent(method, p) {
    switch (method) {
      case 'Fetch.requestPaused': this.blocked.push(p.request.url); this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); break;
      case 'Runtime.consoleAPICalled': { const text = (p.args || []).map(a => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description || a.type)).join(' ');
        const e = { type: 'console.' + p.type, text, url: (p.stackTrace && p.stackTrace.callFrames[0] && p.stackTrace.callFrames[0].url) || '', t: Date.now() };
        this.console.push(e); if (p.type === 'error' || p.type === 'warning') this.errors.push(e); break; }
      case 'Runtime.exceptionThrown': { const d = p.exceptionDetails || {}; const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception';
        this.errors.push({ type: 'exception', text: String(text), url: `${d.url || ''}:${d.lineNumber || 0}`, t: Date.now() }); break; }
      case 'Log.entryAdded': { const e = p.entry || {}; if (e.level === 'error' && !this._isBlocked(e.url || '') && !/ERR_BLOCKED_BY_CLIENT/.test(e.text || '')) this.errors.push({ type: 'log.' + (e.source || 'other'), text: e.text, url: e.url || '', t: Date.now() }); break; }
      case 'Network.requestWillBeSent': this._req.set(p.requestId, { method: p.request.method, url: p.request.url }); break;
      case 'Network.responseReceived': { const r = this._req.get(p.requestId) || {}; this.responses.push({ requestId: p.requestId, url: p.response.url, status: p.response.status, mimeType: p.response.mimeType, method: r.method || 'GET', t: Date.now() }); break; }
      case 'Network.loadingFailed': { const r = this._req.get(p.requestId) || {}; this.failed.push({ url: r.url || '', errorText: p.errorText, blockedReason: p.blockedReason || '', t: Date.now() }); break; }
    }
    for (const w of this._waiters.slice()) if (w.method === method) { this._waiters.splice(this._waiters.indexOf(w), 1); w.resolve(p); }
  }
  _isBlocked(url) { return this.blocked.includes(url) || /server\.arcgisonline\.com|basemaps\.cartocdn\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|\/api\/airport-photo\//.test(url); }
  once(method, timeout = 25000) { return withTimeout(new Promise(resolve => this._waiters.push({ method, resolve })), timeout, 'event ' + method); }

  // ---- navigation ------------------------------------------------------------------------
  /** Script run before any page script on every new document (replaces the previous seed). */
  async seed(script) {
    if (this._seedId) { try { await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this._seedId }); } catch (e) {} }
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: script }); this._seedId = identifier;
  }
  static seedScript(seedLocalStorage = {}) {
    const entries = Object.assign({ cns_welcome_hide: true, cns_tour_done: true }, seedLocalStorage || {});
    const ls = Object.entries(entries).map(([k, v]) => v === null ? `localStorage.removeItem(${JSON.stringify(k)});` : `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`).join('');
    return `(function(){ try { ${ls} } catch (e) {}
      window.__cns = { confirms: [], alerts: [], prompts: [], clip: [], confirmResult: true, promptResult: undefined, moving: false, hooked: false };
      window.confirm = function (m) { __cns.confirms.push(String(m)); return __cns.confirmResult; };
      window.alert = function (m) { __cns.alerts.push(String(m)); };
      window.prompt = function (m, d) { __cns.prompts.push(String(m)); return __cns.promptResult !== undefined ? __cns.promptResult : (d == null ? null : d); };
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async function (t) { __cns.clip.push(String(t)); }, readText: async function () { return __cns.clip.at(-1) || ''; } } }); } catch (e) {}
    })();`;
  }
  static BOOT = {
    v2: `!!(window.CNSUI && CNSUI.map && CNSUI.map.map && CNSUI.airports().length > 100 && document.querySelector('#railBody') && document.querySelector('#railBody').children.length)`,
    classic: `typeof airportByIdent !== 'undefined' && Object.keys(airportByIdent).length > 100 && typeof lastResult !== 'undefined'`
  };
  static MAP_HOOK = `(function(){ if (window.__cns && !__cns.hooked && window.CNSUI && CNSUI.map && CNSUI.map.map) { __cns.hooked = true;
      CNSUI.map.map.on('movestart zoomstart', function () { __cns.moving = true; }).on('moveend zoomend', function () { __cns.moving = false; }); } return !!(window.__cns && __cns.hooked); })()`;
  async goto(url, { hash, seedLocalStorage, boot = null, timeout = 25000 } = {}) {
    const t0 = Date.now();
    await this.seed(Page.seedScript(seedLocalStorage));
    if (hash) url += (hash.startsWith('#') ? '' : '#') + hash;
    this.url = url;
    const loaded = this.once('Page.loadEventFired', timeout);
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
    await loaded;
    if (boot) {
      const pred = Page.BOOT[boot]; if (!pred) throw new Error('unknown boot: ' + boot);
      await this.waitFor(pred, Math.max(1000, timeout - (Date.now() - t0)), 100);
      if (boot === 'v2') await this.eval(Page.MAP_HOOK);
    }
    return this;
  }
  async reload(opts = {}) { return this.goto(this.url, opts); }

  // ---- evaluation ------------------------------------------------------------------------
  async eval(expr, { timeout = 15000 } = {}) {
    const r = await withTimeout(this.send('Runtime.evaluate', { expression: String(expr), awaitPromise: true, returnByValue: true, userGesture: true, timeout }), timeout + 1000, 'eval');
    if (r.exceptionDetails) { const d = r.exceptionDetails; const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate failed';
      throw new Error(`eval: ${String(msg).split('\n').slice(0, 3).join(' | ')} — in: ${String(expr).slice(0, 160)}`); }
    return r.result ? r.result.value : undefined;
  }
  evalAsync(body, opts) { return this.eval(`(async () => { ${body} })()`, opts); }
  /** Poll `predicateExpr` (an expression) until truthy. Throws with the last value / last error. */
  async waitFor(predicateExpr, timeout = 10000, every = 100) {
    const t0 = Date.now(); let last, lastErr = null;
    while (Date.now() - t0 < timeout) {
      try { last = await this.eval(predicateExpr, { timeout: Math.max(1000, timeout) }); lastErr = null; if (last) return last; } catch (e) { lastErr = e; }
      await sleep(every);
    }
    throw new Error(`waitFor timeout ${timeout} ms: ${String(predicateExpr).slice(0, 200)} — last=${lastErr ? 'ERR ' + lastErr.message : JSON.stringify(last)}`);
  }
  waitForMapIdle(timeout = 8000) { return this.waitFor('!!(window.__cns && !__cns.moving)', timeout, 50); }
  sleep(ms) { return sleep(ms); }

  // ---- geometry + real input (viewport CSS px) ------------------------------------------
  async rect(sel) {
    return this.eval(`(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy);
      const tag = e => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '') : null;
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx, cy, covered: !(top === el || el.contains(top)), topTag: tag(top) }; })()`);
  }
  async click(sel, opts = {}) {
    const r = await this.rect(sel); if (!r) throw new Error('click: not found ' + sel);
    if (!r.w && !r.h) throw new Error('click: zero-size ' + sel);
    if (r.covered && !opts.force) throw new Error(`click: ${sel} is covered by ${r.topTag}`);
    await this.clickAt(r.cx, r.cy, opts); return r;
  }
  async clickAt(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    x = Math.round(x * 2) / 2; y = Math.round(y * 2) / 2; const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, buttons, modifiers });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, buttons: 0, modifiers });
    }
  }
  async hover(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); }
  async drag(x0, y0, x1, y1, steps = 10) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) { const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }); await sleep(16); }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 0 });
  }
  async type(text) {
    for (const ch of String(text)) {
      const alnum = /^[a-z0-9]$/i.test(ch); const vk = alnum ? ch.toUpperCase().charCodeAt(0) : (ch === ' ' ? 32 : 0);
      const base = { key: ch, text: ch, unmodifiedText: ch }; if (vk) { base.windowsVirtualKeyCode = vk; base.nativeVirtualKeyCode = vk; }
      if (alnum) base.code = /\d/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase(); else if (ch === ' ') base.code = 'Space';
      await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
      await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    }
  }
  async press(key, modifiers = 0) {
    const vk = VK[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const code = VK[key] ? (key === 'Space' ? 'Space' : key) : (/^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : /^\d$/.test(key) ? 'Digit' + key : key);
    const base = { key: key === 'Space' ? ' ' : key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    const down = key === 'Enter' ? Object.assign({ type: 'keyDown', text: '\r', unmodifiedText: '\r' }, base) : Object.assign({ type: 'rawKeyDown' }, base);
    await this.send('Input.dispatchKeyEvent', down);
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }
  async setValue(sel, value, events = ['input', 'change']) {
    return this.eval(`(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('setValue: not found ${sel.replace(/'/g, "\\'")}');
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!${JSON.stringify(value)}; else el.value = ${JSON.stringify(value)};
      ${JSON.stringify(events)}.forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true }))); return el.value; })()`);
  }
  async focus(sel) { return this.eval(`(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('focus: not found'); el.focus(); return document.activeElement === el; })()`); }

  // ---- network + downloads -------------------------------------------------------------
  /** First response whose url includes `urlPart`, recorded at index ≥ `since` (snapshot `page.responses.length` before the action). */
  async waitForResponse(urlPart, { since = 0, timeout = 15000, method } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const hit = this.responses.slice(since).find(r => r.url.includes(urlPart) && (!method || r.method === method));
      if (hit) return hit; await sleep(50);
    }
    throw new Error(`waitForResponse timeout: ${method || ''} ${urlPart}`);
  }
  async responseBody(requestId) { const r = await this.send('Network.getResponseBody', { requestId }); return r.base64Encoded ? Buffer.from(r.body, 'base64') : r.body; }
  /** Next completed download (not returned before), optionally filtered by extension. */
  async waitForDownload({ timeout = 20000, ext } = {}) {
    const t0 = Date.now(); const dir = this.browser.downloadDir;
    while (Date.now() - t0 < timeout) {
      const d = this.browser.downloads.find(x => !this._seenDownloads.has(x.guid) && x.state === 'completed' && (!ext || (x.filename || '').toLowerCase().endsWith(ext.toLowerCase())));
      if (d) { this._seenDownloads.add(d.guid); let file = path.join(dir, d.filename || ''); let bytes = d.bytes;
        try { bytes = fs.statSync(file).size; } catch (e) { const cands = fs.readdirSync(dir).filter(f => !ext || f.toLowerCase().endsWith(ext.toLowerCase())).map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
          if (cands[0]) { file = path.join(dir, cands[0].f); bytes = fs.statSync(file).size; } }
        return { filename: d.filename, bytes, path: file, url: d.url }; }
      const bad = this.browser.downloads.find(x => !this._seenDownloads.has(x.guid) && x.state === 'canceled'); if (bad) { this._seenDownloads.add(bad.guid); throw new Error('download canceled: ' + bad.filename); }
      await sleep(100);
    }
    throw new Error(`waitForDownload timeout (${ext || 'any'})`);
  }

  // ---- evidence ------------------------------------------------------------------------
  async screenshot(file) { const { data } = await this.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(data, 'base64')); return file; }
  exceptions() { return this.errors.filter(e => e.type === 'exception'); }
  clearErrors() { this.errors.length = 0; this.console.length = 0; }

  // ---- map helpers (v2 shell) ----------------------------------------------------------
  /** Close every Leaflet popup AND wait until it left the DOM (Leaflet keeps a fading popup for 200 ms — it eats clicks). */
  async closePopups(timeout = 2000) { await this.eval(`(function(){ if (window.CNSUI && CNSUI.map && CNSUI.map.map) CNSUI.map.map.closePopup(); return true; })()`); await this.waitFor(`!document.querySelector('.leaflet-popup')`, timeout, 40); }
  /** Viewport position of an airport dot + what is on top of it (for REAL clicks). */
  mapPoint(ident) {
    return this.eval(`(function(){ const a = CNSUI.byId()[${JSON.stringify(ident)}]; if (!a) return null; const m = CNSUI.map.map;
      const ll = L.latLng(a.latitude_deg, a.longitude_deg); const p = m.latLngToContainerPoint(ll); const r = document.getElementById('map').getBoundingClientRect();
      const x = r.left + p.x, y = r.top + p.y; const el = (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) ? document.elementFromPoint(x, y) : null;
      const pane = el && el.closest('.leaflet-pane'); const tag = e => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '') : null;
      return { ident: a.ident, type: a.type, x, y, zoom: m.getZoom(), inView: m.getBounds().contains(ll) && !!el, asset: !!(CNSUI.assets() || {})[a.ident], topTag: tag(el),
        topPane: pane ? (pane.className.split(/\\s+/).find(c => /^leaflet-.+-pane$/.test(c) && c !== 'leaflet-map-pane') || pane.className) : null }; })()`);
  }
  /** Airport dots a human could click right now: allowed type (small only at zoom ≥ 7.5), in the map bounds, outside the rail /
      topbar (44 px) / drawer, not an NRG asset, ≥ 28 px from every route endpoint; nearest to the map centre first. */
  pickClickableDots(n = 3) {
    return this.eval(`(function(){ const S = CNSUI.S, m = CNSUI.map.map, z = m.getZoom(); const allowed = (S.allowedTypes || ['large_airport', 'medium_airport']).filter(t => t !== 'small_airport' || z >= 7.5);
      const b = m.getBounds(); const mr = document.getElementById('map').getBoundingClientRect(); const box = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      const rail = box('#rail'), drawer = box('#drawer'); const inBox = (r, x, y) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      const vp = a => { const p = m.latLngToContainerPoint(L.latLng(a.latitude_deg, a.longitude_deg)); return [mr.left + p.x, mr.top + p.y]; };
      const ends = CNSUI.chain().map(vp); const assets = CNSUI.assets() || {}; const cx = mr.left + mr.width / 2, cy = mr.top + mr.height / 2; const out = [];
      for (const a of CNSUI.airports()) { if (!allowed.includes(a.type) || assets[a.ident]) continue; const ll = L.latLng(a.latitude_deg, a.longitude_deg); if (!b.contains(ll)) continue;
        const [x, y] = vp(a); if (x < mr.left + 20 || x > mr.right - 20 || y < 44 + 20 || y > mr.bottom - 20) continue; if (inBox(rail, x, y) || inBox(drawer, x, y)) continue;
        if (ends.some(e => Math.hypot(e[0] - x, e[1] - y) < 28)) continue; out.push({ ident: a.ident, type: a.type, x, y, d: Math.hypot(x - cx, y - cy) }); }
      out.sort((p, q) => p.d - q.d); return out.slice(0, ${+n}).map(o => { const el = document.elementFromPoint(o.x, o.y); const pane = el && el.closest('.leaflet-pane');
        return { ident: o.ident, type: o.type, x: o.x, y: o.y, zoom: z, inView: true, asset: false, topTag: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : null,
          topPane: pane ? (pane.className.split(/\\s+/).find(c => /^leaflet-.+-pane$/.test(c) && c !== 'leaflet-map-pane') || pane.className) : null }; }); })()`);
  }
}
export { sleep };
