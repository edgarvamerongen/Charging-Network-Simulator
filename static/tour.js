/*
 * CNSTour — guided walkthrough for new operators.
 * ------------------------------------------------------------------------------
 * Drives the user through the full happy path: planner → simulate → result panel
 * → demand calculator → scheduler → flights-map animation → PDF report. Uses
 * Driver.js for the spotlight + popover mechanics; we own the step content,
 * the demo-data seeding, and the auto-advance side-effects that progress the
 * app's state between steps (clicking Simulate, opening the demand drawer,
 * opening the flights-map modal, etc.).
 *
 * The standalone welcome modal (#welcomeModal, in index.html) is the onboarding
 * entry point — it shows on every load until the user opts out via the
 * `cns_welcome_hide` flag, and its "Start demo" button calls start(). The tour
 * itself is always replayable from the ? Tour button in the topbar.
 *
 * Assumes Driver.js is loaded globally as window.driver.
 */
window.CNSTour = (function () {
    const KEY_DONE = 'cns_tour_done';
    const KEY_WELCOME_HIDE = 'cns_welcome_hide';   // "don't show the welcome again"
    let _activeDriver = null;

    // The welcome hero + leadership bios now live in the standalone welcome modal
    // (#welcomeModal in index.html); the tour starts at the first UI step.

    // ---- demo-data seeding ----------------------------------------------------
    // Seed a realistic Lelystad → Munich retour with the Beta Alia CX300 so
    // the tour's downstream steps (result panel, demand calc, scheduler) have
    // non-zero numbers to show. We don't simulate or save to the folder yet —
    // those happen mid-tour to demonstrate the buttons.
    async function _seedDemoForm() {
        const airports = await fetch('/api/airports').then(r => r.json());
        const lelystad = airports.find(a => a.ident === 'EHLE');
        const munich   = airports.find(a => a.ident === 'EDDM');
        if (!lelystad || !munich) return;

        // Beta Alia CX300: 500 km range, but with the realistic model factors on
        // by default (20% landing reserve + ~5% routing padding) its usable reach
        // drops to ~400 km — so Lelystad→Munich (~636 km) no longer fits in one
        // hop and the auto-planner inserts a charging stop (Siegerland). That's
        // exactly what we showcase at the Model-settings + Suggested-route steps.
        //
        // Order matters: set plane FIRST, so that when pickAirport fires its
        // smartReplan + updateTrajectory the over-range warning in the trajectory
        // pill is suppressed (the pill only warns in direct-flight mode — the
        // Suggested route panel handles it once stops are on).
        document.getElementById('tripType').value = 'retour';
        document.getElementById('tripType').dispatchEvent(new Event('change'));
        document.getElementById('plane').value = 'beta_plane';
        document.getElementById('plane').dispatchEvent(new Event('change'));
        document.getElementById('charger').value = 'dc_250';
        document.getElementById('charger').dispatchEvent(new Event('change'));
        document.getElementById('freqN').value = 1;
        // "Plan with charging stops" must START OFF so the tour can reveal it at
        // its dedicated step — the operator then sees the natural progression:
        // first the over-range warning (the Beta can't reach Munich direct
        // under the applied 20% reserve + padding), then the toggle flips on and
        // the planner adds the stop. The page's own _applyDefaultFlight() enables
        // the toggle on load and planReset does NOT clear it, so we explicitly
        // switch it back off here — otherwise the route is already split before
        // the user reaches the toggle, and steps 6 + 10 read as stale.
        const stopsToggle = document.getElementById('withStops');
        if (stopsToggle && stopsToggle.checked) {
            stopsToggle.checked = false;
            stopsToggle.dispatchEvent(new Event('change'));
        }
        if (typeof pickAirport === 'function') {
            pickAirport('origin', lelystad);
            pickAirport('destination', munich);
        }
    }

    // Helper: turn ON "Plan with charging stops" if it isn't already. Used
    // by the Suggested route step so the planner has run by the time the
    // popover appears. We also fire updateTrajectory explicitly because
    // some browser revs treat synthetic `change` events slightly differently
    // and the trajectory pill needs to drop its over-range warning when
    // stops mode kicks in.
    async function _ensureStopsOn() {
        const t = document.getElementById('withStops');
        if (t && !t.checked) {
            t.checked = true;
            t.dispatchEvent(new Event('change'));
            await _wait(250);
            if (typeof updateTrajectory === 'function') updateTrajectory();
        }
    }

    // For the final "Overview" step we seed a small but REAL network — a handful
    // of flights out of Lelystad, each routed (charging stops via the same A*
    // planner) and simulated through the same backend the planner uses, so legs/
    // energy/charges are physically valid rather than faked. Sims run in parallel.
    function _seedWp(ap) { return { ident: ap.ident, name: ap.name, lat: ap.latitude_deg, lon: ap.longitude_deg, type: ap.type }; }

    // Map a /api/simulate response into a demand-folder entry — same shape the
    // planner's "Add to demand calculator" builds (keep in sync with that code).
    function _entryFromSim(d, origin, dest, chargerId, freqN, freqUnit, tag) {
        const e = {
            id: 'tour_' + tag,
            destIdent: dest.ident, destName: dest.name, destLat: dest.latitude_deg, destLon: dest.longitude_deg,
            originIdent: origin.ident, originName: origin.name, originLat: origin.latitude_deg, originLon: origin.longitude_deg,
            planeName: d.plane.name, planeId: d.plane.id, planeSvg: d.plane.svg, tripType: d.trip_type,
            chargerId: chargerId, chargerName: d.charger.name, chargerPower: d.charger.power_kw,
            legEnergy: d.leg_energy_kwh, battery: d.plane.battery_kwh, c_rate: d.plane.c_rate,
            freqN: freqN, freqUnit: freqUnit, fleetMode: 'separate',
        };
        if (d.multi_leg) {
            Object.assign(e, {
                multiLeg: true, flightTimeH: d.total_flight_time_h,
                rechargeEnergy: d.total_recharge_energy_kwh,
                stops: d.stops, charges: d.charges, legs: d.legs,
                totalDistanceKm: d.total_distance_km, totalFlightTimeH: d.total_flight_time_h,
                totalChargeMin: d.total_charge_time_min, totalRechargeKwh: d.total_recharge_energy_kwh,
            });
        } else {
            Object.assign(e, { rechargeEnergy: d.recharge_energy_kwh, flightTimeH: d.flight_time_h });
        }
        return e;
    }

    async function _seedNetworkFlights() {
        const airports = await fetch('/api/airports').then(r => r.json());
        const A = (id) => airports.find((x) => x.ident === id);
        const lelystad = A('EHLE');
        if (!lelystad) return;
        const planeOf = (id) => (window.PLANES_BY_ID || {})[id];
        const chargerId = 'dc_250';
        const coord = (ap) => ({ ident: ap.ident, name: ap.name, lat: ap.latitude_deg, lon: ap.longitude_deg });
        // All out of Lelystad: local NL hops, a Frankfurt run (the Lelystad→Munich
        // demo flight is already in the folder), and a one-way into N. France.
        const specs = [
            { dest: 'EHAM', plane: 'beta_plane', type: 'retour',  freqN: 4 },   // Schiphol (commuter)
            { dest: 'EHRD', plane: 'beta_plane', type: 'retour',  freqN: 3 },   // Rotterdam
            { dest: 'EHTE', plane: 'beta_plane', type: 'one-way', freqN: 2 },   // Teuge
            { dest: 'EDDF', plane: 'vaeridion',  type: 'one-way', freqN: 1 },   // Frankfurt (Vaeridion)
            { dest: 'LFQQ', plane: 'beta_plane', type: 'one-way', freqN: 1 },   // Lille, FR
        ];
        async function build(spec) {
            const dest = A(spec.dest); const plane = planeOf(spec.plane);
            if (!dest || !plane) return null;
            // Plan charging stops for over-range hops (returns [] when it fits).
            let stops = [];
            try {
                const r = (window.CNSRouting) ? CNSRouting.planRoute({
                    origin: _seedWp(lelystad), destination: _seedWp(dest), plane,
                    allAirports: airports,
                    allowedTypes: ['small_airport', 'medium_airport', 'large_airport'],
                    options: {},
                }) : { stops: [] };
                stops = (r && Array.isArray(r.stops)) ? r.stops : [];
            } catch (e) { stops = []; }
            const payload = {
                origin: coord(lelystad), destination: coord(dest),
                plane_id: spec.plane, charger_id: chargerId, trip_type: spec.type,
            };
            if (stops.length) payload.stops = stops.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, ident: s.ident, type: s.type }));
            let d;
            try {
                d = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
            } catch (e) { return null; }
            if (!d || d.error || !d.plane) return null;
            return _entryFromSim(d, lelystad, dest, chargerId, spec.freqN, 'day', spec.plane + '_' + spec.dest + '_' + spec.type);
        }
        const entries = (await Promise.all(specs.map(build))).filter(Boolean);
        if (!entries.length) return;
        const existing = CNSDemand.loadFolder();        // keep the demo Lelystad→Munich flight
        CNSDemand.saveFolder(existing.concat(entries));
        if (typeof renderFolder === 'function') renderFolder();
    }

    // Pre-condition the canvas: empty folder + reset settings + close drawer.
    async function _resetWorld() {
        try {
            CNSDemand.saveFolder([]);
            CNSDemand.saveCfg({});
            CNSSettings.reset();
        } catch (e) { /* ignore */ }
        if (typeof renderFolder === 'function') renderFolder();
        // Close drawer if open
        const drawer = document.getElementById('demandDrawer');
        if (drawer && drawer.classList.contains('open')) {
            const t = document.getElementById('drawerToggle'); if (t) t.click();
        }
        // Reset planner form
        const reset = document.getElementById('planReset');
        if (reset) reset.click();
        await new Promise(r => setTimeout(r, 200));
    }

    // ---- step orchestration ---------------------------------------------------
    // Each step is a Driver.js step descriptor. `onHighlightStarted` (set as
    // the step is about to show) is where we run side-effects that bring the
    // app into the state the popover is describing — clicking Simulate before
    // the result-panel step, opening the drawer before the demand-card step,
    // etc. Keeps the tour declarative without race conditions.

    function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Simulate but DON'T pan/zoom the map yet — the tour's "Your route on
    // the map" step does the explicit zoom so the user sees cause-and-
    // effect (clicking Simulate produced this map view). We set a global
    // suppress flag BEFORE dispatching submit; the submit handler's
    // drawRoute call sees it and skips fitBounds. The next "Your route"
    // step clears the flag and re-fits.
    async function _ensureSimulated() {
        if (typeof lastResult !== 'undefined' && lastResult) return;
        window.__tourSuppressFit = true;
        document.getElementById('simForm').dispatchEvent(new Event('submit'));
        for (let i = 0; i < 25; i++) {
            await _wait(80);
            if (typeof lastResult !== 'undefined' && lastResult) return;
        }
    }
    // Manually fit the map to the simulated route when the "Your route on
    // the map" step opens — clears the suppress flag and redraws with fit.
    async function _zoomToSimulatedRoute() {
        window.__tourSuppressFit = false;
        if (typeof lastResult === 'undefined' || !lastResult) return;
        if (typeof drawRoute === 'function') drawRoute({ ...lastResult, fitBounds: true });
    }
    // Open one result-panel section (Route / Charging / Revenue) by id and collapse
    // the others so the spotlight is clean, then scroll it into the rail's viewport.
    // The sections render collapsed; the tour opens each as its dedicated slide arrives.
    async function _expandResultSection(id) {
        await _ensureSimulated();
        document.querySelectorAll('.rail-right .result-group').forEach((g) => {
            const open = (g.id === id);
            g.classList.toggle('collapsed', !open);
            const header = g.querySelector('.sec-header');
            if (header) header.setAttribute('aria-expanded', String(open));
        });
        const el = document.getElementById(id);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'auto' });
        await _wait(350);
    }
    async function _ensureInFolder() {
        const folder = (typeof CNSDemand !== 'undefined') ? CNSDemand.loadFolder() : [];
        if (folder.length === 0) {
            const add = document.getElementById('addFolder');
            if (add) add.click();
            await _wait(300);
        }
    }
    async function _ensureDrawerOpen() {
        const d = document.getElementById('demandDrawer');
        if (d && !d.classList.contains('open')) {
            document.getElementById('drawerToggle').click();
            await _wait(450);
        }
    }
    async function _ensureSchedulerOpen() {
        const card = document.querySelector('#folder [data-dest]');
        if (!card) return;
        const btn = card.querySelector('.sched-card');
        if (btn && !document.querySelector('[data-schedbox]:not(.d-none)')) {
            btn.click();
            await _wait(400);
        }
    }
    // The per-flight rows now live in a collapsed "Route breakdown" section on
    // each card (a .routes-toggle button reveals them). Expand it so the
    // Role/route and Edit-flight steps spotlight a visible row, not a hidden one.
    async function _ensureRoutesOpen() {
        const card = document.querySelector('#folder [data-dest]');
        if (!card) return;
        const trip = card.querySelector('.folder-trip');
        if (!trip || trip.getBoundingClientRect().height === 0) {
            const toggle = card.querySelector('.routes-toggle');
            if (toggle) { toggle.click(); await _wait(350); }
        }
    }
    // A demand card can be taller than the #folder scroll window, and Driver only
    // scrolls the page (not the inner #folder container), so a per-card anchor
    // below the window would land off-screen. Scroll the target into the drawer's
    // view before the spotlight lands (same approach as the scheduler step).
    async function _revealInDrawer(sel, block) {
        const el = document.querySelector(sel);
        if (el && el.scrollIntoView) { el.scrollIntoView({ block: block || 'center', behavior: 'auto' }); await _wait(300); }
    }
    async function _ensureFlightsMapOpen() {
        const btn = document.querySelector('#folder [data-map]');
        if (btn && !document.querySelector('#flightsMapModal.show')) {
            btn.click();
            await _wait(900);
        }
    }
    async function _closeFlightsMap() {
        const close = document.querySelector('#flightsMapModal.show .btn-close');
        if (close) { close.click(); await _wait(400); }
    }
    // Model-settings step: open #modelSettingsModal and lift it above the tour
    // overlay (same recipe as the flights-map step) so the user sees the live
    // panel while the popover overviews its groups; closed again on step exit.
    async function _openModelSettings() {
        const el = document.getElementById('modelSettingsModal');
        if (!el) return;
        if (window.bootstrap && window.bootstrap.Modal) window.bootstrap.Modal.getOrCreateInstance(el).show();
        await _wait(450);   // let the show transition settle before lifting
        el.classList.add('tour-modal-front');
        document.body.classList.add('tour-modalfront-step');
    }
    async function _closeModelSettings() {
        const el = document.getElementById('modelSettingsModal');
        if (!el) return;
        el.classList.remove('tour-modal-front');
        document.body.classList.remove('tour-modalfront-step');
        if (window.bootstrap && window.bootstrap.Modal) window.bootstrap.Modal.getOrCreateInstance(el).hide();
        await _wait(300);
    }

    // The step list — every entry has element + popover. Side-effects live in
    // onHighlightStarted so they fire just before the popover appears.
    function _steps() {
        return [
            // 1. Whole screen — the simulator at a glance. (The welcome/intro is
            // now the standalone #welcomeModal; the tour opens on the live app.)
            {
                element: 'body',
                popover: { title: 'Your simulator at a glance', description: 'Left: the route builder. Centre: the map. Bottom: the Demand Calculator drawer. Top-right: Options and this Tour. We\'ll walk the route builder top to bottom, then read the network it produces.', side: 'over', align: 'center' },
            },
            // 3. Departure
            {
                element: '#origin',
                popover: { title: 'Departure airport', description: 'Type to search by name, IATA, or municipality, or click any orange marker on the map and pick "Set as Departure".', side: 'right' },
            },
            // 4. + Add stop (the small button itself, not the whole row)
            {
                element: '#addStopLink',
                popover: { title: 'Manual stops', description: '+ Add stop inserts an intermediate airport between Departure and Destination when you want to control the route yourself. The auto-planner still fills in further stops between manual ones if a leg is too long.', side: 'right' },
            },
            // 5. Destination
            {
                element: '#destination',
                popover: { title: 'Pick a destination', description: 'Where the route ends. Type to search, or click an orange marker and choose "Set as Destination". For training flights (a loop around one airport) this field hides automatically.', side: 'right' },
            },
            // 6. Trajectory pill
            {
                element: '#trajInfo',
                popover: { title: 'Trajectory', description: 'The straight-line distance between Departure and Destination. If it\'s further than the chosen aircraft can fly on one charge, this turns into an over-range warning, your cue to plan charging stops.', side: 'right' },
            },
            // 7. Trip type
            {
                element: '#tripType',
                popover: { title: 'Trip type', description: 'One-way, Retour (round trip), or Training (an A→A loop with a fixed pattern radius).', side: 'right' },
            },
            // 8. Aircraft
            {
                element: '#plane',
                popover: { title: 'Aircraft', description: 'Pick a model. The card shows its catalog range and the model-adjusted <strong>available range</strong>, plus battery, cruise speed and seats. "Override for this flight" tweaks the specs just for this route, and ➕ adds a custom aircraft (saved on the server for your colleagues).', side: 'right' },
            },
            // 9. Model settings — surfaced BEFORE the route so the factors that
            // shape it (and force a stop) are understood first.
            {
                element: '#planModelSettingsBtn',
                popover: { title: 'Model settings: applied to every calculation', description: 'These operational factors are <strong>on by default</strong> so the numbers stay realistic: a 20% landing reserve, ~5% routing padding, the charging-curve taper, and an 80% default charge target. They also set the charging price (€/kWh) and charger efficiency used for the result panel\'s <strong>Airport revenue</strong>. The reserve and padding are why the Beta Alia\'s 500&nbsp;km range cannot reach Munich in one hop, so a charging stop is needed. Open this any time to adjust the factors or switch them off.', side: 'right' },
            },
            // 9a. Model settings panel — open it and walk its three groups. Pinned
            // popover (top) with the modal lifted above the tour overlay, same
            // recipe as the Overview flights-map step.
            {
                popover: {
                    title: 'Inside the model settings',
                    description: 'This panel holds the operational assumptions behind the simulation; changing any of them updates the route, charge times, demand and revenue. Three groups: <strong>Available range</strong> sets the landing reserve and routing padding, which determine how far each aircraft can fly before it must charge; <strong>Charging</strong> sets how full each aircraft charges and how quickly it does so; <strong>Revenue</strong> sets the charging efficiency and the price per kWh that drive the energy and revenue figures.',
                    side: 'over', align: 'center',
                    // Bottom-pinned: the panel is tall (taper chart), so a top pin would
                    // cover its title — pinning low leaves the title + all three groups
                    // visible and only overlaps the footer buttons.
                    popoverClass: 'cns-tour-popover cns-tour-popover-bottom',
                },
                onHighlightStarted: async () => { await _openModelSettings(); },
                onDeselected: async () => { await _closeModelSettings(); },
            },
            // 10. Plan with charging stops — toggle it ON here so the user watches
            // the suggested route appear in the next step.
            {
                element: '.stops-toggle-row',
                popover: { title: 'Charging stops', description: 'Switching this on lets the planner split an over-range trip into legs through intermediate airports. We are turning it on now, and a charging stop appears for the Beta Alia\'s Lelystad → Munich run. On routes the aircraft can fly direct, the toggle switches itself back off — no stops needed.', side: 'right' },
                onHighlightStarted: async () => { await _ensureStopsOn(); },
            },
            // 11. Suggested route — the stop the applied factors forced.
            {
                element: '#stopsSection',
                popover: { title: 'Suggested route', description: 'The planner split the trajectory into legs through an intermediate airport (shortest-path A*). The <strong>Prefer</strong> dropdown biases which airport sizes it favours when picking stops. Each row shows the leg distance; over-range legs would flag red. Drag the ≡ handle to reorder a manual stop; × removes one. More airport types are under Options, top-right.', side: 'right' },
                onHighlightStarted: async () => { await _ensureStopsOn(); },
            },
            // 12. Expected frequency
            {
                element: '#freqField',
                popover: { title: 'Expected frequency', description: 'How often this route runs. For retour or training flights you can also choose whether one aircraft cycles the rotations or a fleet of separate planes flies them, which changes how many chargers each airport needs.', side: 'right' },
            },
            // 13. Charger
            {
                element: '#charger',
                popover: { title: 'Charger', description: 'The charger model offered at the airports on this route. Its power and the aircraft\'s battery (and C-rate) set the per-flight charge time.', side: 'right' },
            },
            // 14. Simulate — fires the simulate then we step to the map
            {
                element: '.sim-btn',
                popover: { title: 'Simulate', description: 'Computes the per-flight energy, flight time and charge time for the whole chain. The result panel appears on the right and the route is drawn on the map.', side: 'right' },
                onHighlightStarted: async () => { await _ensureSimulated(); },
            },
            // 12. NEW — Show the full route on the map. Zoom happens HERE (not
            // at the Simulate step) so the user sees the action–consequence
            // pair: clicking Simulate produced this map view.
            {
                element: '#map',
                popover: { title: 'Your route on the map', description: 'The blue line is the outbound leg; the green dashed line (for retour trips) is the return. Each blue marker is an intermediate charging stop, and every leg carries a label with its distance, time and energy. The map zooms to fit the whole trip between the side panels.', side: 'bottom', align: 'center' },
                onHighlightStarted: async () => { await _ensureSimulated(); await _zoomToSimulatedRoute(); },
            },
            // 13. Result panel — scroll the panel to the TOP so the user sees
            // the headline numbers first, then we drill into each section below.
            {
                element: '.rail-right .panel',
                popover: { title: 'Result panel', description: 'Headline per-flight numbers up top: energy used, flight time, charge time, and the airport\'s <strong>revenue potential</strong>. Below are two expandable breakdowns, <strong>Route</strong> and <strong>Charging</strong>, which we\'ll open in turn.', side: 'left', align: 'start' },
                onHighlightStarted: async () => {
                    await _ensureSimulated();
                    // Start clean: collapse every section so the headline reads first;
                    // the next three slides open them one at a time.
                    document.querySelectorAll('.rail-right .result-group').forEach((g) => {
                        g.classList.add('collapsed');
                        const h = g.querySelector('.sec-header'); if (h) h.setAttribute('aria-expanded', 'false');
                    });
                    const r = document.querySelector('.rail-right');
                    if (r) r.scrollTop = 0;
                },
            },
            // 13a. Route — the itinerary (one row per leg + en-route charge).
            {
                element: '#rgRoute',
                popover: { title: 'Route', description: 'The trip itinerary, top to bottom: a row per <strong>flight leg</strong> (distance, time, energy) and per en-route charging stop, a Return divider on retour trips, and a Total travel row. The final-destination top-up sits in Charging, not here.', side: 'left', align: 'start' },
                onHighlightStarted: async () => { await _expandResultSection('rgRoute'); },
            },
            // 13b. Charging — the terminal top-up, separate from travel time.
            {
                element: '#rgCharging',
                popover: { title: 'Charging', description: 'The top-up at the trip\'s terminal airport, after arrival and <strong>separate from travel time</strong>: arrival state-of-charge, charge-to target, top-up minutes (or no charge needed), plus the charger model and, with efficiency on, grid demand in kWh.', side: 'left', align: 'start' },
                onHighlightStarted: async () => { await _expandResultSection('rgCharging'); },
            },
            // 14. Add to demand — scroll the rail DOWN so the button is fully
            // visible (it sits below the trip-calculated table).
            {
                element: '#addFolder',
                popover: { title: 'Add to demand calculator', description: 'Saves the flight to the network. The <strong>Demand Calculator</strong> pill at the bottom briefly confirms it. Demand at each airport the trip touches (Departure, Destination, every stop) is attributed and aggregated across every saved flight.', side: 'left' },
                onHighlightStarted: async () => {
                    await _ensureSimulated(); await _ensureInFolder();
                    // The Add button is the LAST element in the result panel, which
                    // scrolls independently. Scroll its rail fully to the bottom
                    // (instant) so the button is visible, then wait so Driver
                    // measures the settled position — otherwise the highlight box
                    // lands a margin above the button.
                    const rail = document.querySelector('.rail-right');
                    if (rail) rail.scrollTop = rail.scrollHeight;
                    const btn = document.getElementById('addFolder');
                    if (btn && btn.scrollIntoView) btn.scrollIntoView({ block: 'center', behavior: 'auto' });
                    await _wait(450);
                },
            },
            // 15. Demand Calculator — centered popover, no element. Anchoring
            // to the bottom-of-viewport pill caused the popover itself to
            // visually swallow the pill (only ~50px between popover bottom
            // and pill top). Centered popover leaves the pill clean at the
            // bottom edge; the description tells the user to look there.
            // A body class lifts the pill above the tour overlay so it
            // reads as a highlighted action target rather than dimmed UI.
            {
                popover: { title: 'Demand Calculator', description: 'Look at the bottom of the screen: the <strong>Demand Calculator</strong> pill is the pull-up drawer with one card per airport your flights touch. Click it now (or just hit Next) and you\'ll see per-airport daily energy, peak power, charger config, and an embedded rotation scheduler.', side: 'over', align: 'center' },
                onHighlightStarted: async () => {
                    const d = document.getElementById('demandDrawer');
                    if (d && d.classList.contains('open')) {
                        document.getElementById('drawerToggle').click();
                        await _wait(400);
                    }
                    document.body.classList.add('tour-demand-step');
                },
                onDeselected: async () => {
                    document.body.classList.remove('tour-demand-step');
                },
            },
            // 16. Airport card overview
            {
                element: '#folder [data-dest]',
                popover: { title: 'Per-airport breakdown', description: 'Each airport touched by a flight gets its own card. Numbers shown (daily energy, peak power, charging time) are <strong>specific to this airport</strong>, not the whole network. Multiple flights through the same airport are aggregated.', side: 'top', align: 'center' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); await _revealInDrawer('#folder [data-dest]', 'start'); },
            },
            // 17. NEW — Role / route column
            {
                element: '#folder [data-dest] .folder-trip td:first-child',
                popover: { title: 'Role / route', description: 'For each contributing flight: which role this airport plays in the trip (<span class="role role-home">DEPARTURE</span>, <span class="role role-dest">DESTINATION</span>, or <span class="role role-stop">STOP</span>) and where the flight goes. Same airport visited twice on a retour shows two rows with direction arrows.', side: 'top', align: 'start' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); await _ensureRoutesOpen(); await _revealInDrawer('#folder [data-dest] .folder-trip td:first-child'); },
            },
            // 18. NEW — Chargers row, with add/remove emphasis
            {
                element: '#folder [data-dest] .fleet-add',
                popover: { title: 'Chargers installed at this airport', description: 'The dropdown picks the charger model. Click the green <strong>+</strong> to add another charger (parallel chargers serve more aircraft simultaneously, raising peak power but cutting queue waits). The × on each existing charger removes it. Custom models added via the planner are available here too.', side: 'top' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); await _revealInDrawer('#folder [data-dest] .fleet-add'); },
            },
            // 19. NEW — Charge target chip
            {
                element: '#folder .soc-chip',
                popover: { title: 'Charge target', description: '<strong>Auto</strong> inherits the global default charge target from Model settings (80% by default). Set a percentage here to override it for <em>this</em> airport; a LOCAL target always wins over the GLOBAL default. Higher targets give the plane more reserve but slow charging (lithium-ion tapers above ~80% SoC).', side: 'top' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); await _revealInDrawer('#folder .soc-chip'); },
            },
            // 19a. NEW — Edit / remove a saved flight (pencil + ×) on any row.
            {
                element: '#folder [data-dest] [data-edit]',
                popover: { title: 'Edit a saved flight', description: 'The <strong>pencil</strong> on any row reopens that flight in an edit dialog, where its trip type, aircraft or charger can be changed without re-planning from scratch. The red <strong>×</strong> beside it removes the flight from the network. Saving updates every figure immediately.', side: 'top' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); await _ensureRoutesOpen(); await _revealInDrawer('#folder [data-dest] [data-edit]'); },
            },
            // 20. Rotation scheduler — lift the drawer above the tour overlay
            // (same pattern as the network-animation step) so the Gantt chart
            // is brightly visible, and pin the popover to the TOP of the
            // viewport so it doesn't cover the chart.
            {
                popover: { title: 'Rotation scheduler', description: 'Below is the time table (Gantt chart) of the airport\'s daily charging schedule. Each row is one aircraft; blue bars are flights, green bars are charging here, light-green are charges elsewhere, striped amber are queued (waiting for a charger). Drag bars to reschedule; the rest reflows to prevent overlap.', side: 'over', align: 'center', popoverClass: 'cns-tour-popover cns-tour-popover-top' },
                onHighlightStarted: async () => {
                    await _ensureDrawerOpen(); await _ensureSchedulerOpen();
                    document.body.classList.add('tour-scheduler-step');
                    // Scroll the scheduler into the drawer's viewport so the
                    // user actually sees it under the (top-pinned) popover.
                    const box = document.querySelector('[data-schedbox]:not(.d-none)');
                    if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await _wait(300);
                },
                onDeselected: async () => {
                    document.body.classList.remove('tour-scheduler-step');
                },
            },
            // (Model settings is now shown earlier, in the planner flow — right
            // after "Plan with charging stops" — so its factors are introduced
            // before the route is computed.)
            // PDF report
            {
                element: '#generateReport',
                popover: { title: 'PDF report', description: 'Exports the whole plan as a print-ready PDF: a cover with headline numbers, an executive summary, the network map, per-airport pages with rotation charts, and methodology notes. Great for client deliverables.', side: 'top' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); },
            },
            // 23. NEW — Wow finish: seed a few more flights + open the animation
            // modal. We lift the modal above the tour overlay (via the
            // .tour-modal-front class) so the user actually sees the map
            // playing, and pin the popover near the bottom of the viewport
            // so it doesn't cover the map.
            {
                popover: { title: 'Overview', description: 'Above, every saved flight flies its real, routed trajectory. Adjust the speed with the slider, and watch planes pause to charge. This is the demo network: a handful of real routes out of Lelystad, with local hops to Schiphol, Rotterdam and Teuge, longer runs to Munich and Frankfurt, and a one-way to Lille. Close the modal when you\'re done.', side: 'over', align: 'center', popoverClass: 'cns-tour-popover cns-tour-popover-bottom' },
                onHighlightStarted: async () => {
                    // Drawer must be open momentarily so the View-flights-
                    // on-map button is available to click; then close it so
                    // the modal isn't visually competing with the drawer
                    // body (stacking context issues — drawer-body's blur
                    // creates its own context that traps the modal).
                    await _ensureDrawerOpen();
                    await _seedNetworkFlights();
                    await _wait(300);
                    await _ensureFlightsMapOpen();
                    // Close the drawer now that the modal is open.
                    const d = document.getElementById('demandDrawer');
                    if (d && d.classList.contains('open')) {
                        document.getElementById('drawerToggle').click();
                        await _wait(350);
                    }
                    // Lift the modal above the tour overlay so the map is
                    // visible (not darkened). The class is removed in
                    // onDeselected to restore Bootstrap's default stacking.
                    document.getElementById('flightsMapModal')?.classList.add('tour-modal-front');
                    document.body.classList.add('tour-network-step');
                    // Tight map fit — extra wait so Leaflet finishes the
                    // initial render BEFORE we fit, then a smaller padding
                    // so the routes are close-cropped.
                    await _wait(400);
                    try {
                        const fm = window.folderMap;
                        if (fm && fm.invalidateSize) fm.invalidateSize();
                        if (fm && fm.eachLayer) {
                            const group = [];
                            fm.eachLayer(l => { if (l.getLatLng || l.getBounds) group.push(l); });
                            if (group.length) {
                                const fg = L.featureGroup(group);
                                fm.fitBounds(fg.getBounds(), { padding: [20, 20], maxZoom: 8 });
                            }
                        }
                    } catch (e) { /* best-effort */ }
                },
                onDeselected: async () => {
                    await _closeFlightsMap();
                    // Undo the stacking overrides added in onHighlightStarted so
                    // they don't linger after the tour ends (the other interaction
                    // steps clean up their body classes the same way) — otherwise
                    // the flights modal keeps a very high z-index for normal use.
                    document.getElementById('flightsMapModal')?.classList.remove('tour-modal-front');
                    document.body.classList.remove('tour-network-step');
                },
            },
            // 24. Wrap up
            {
                element: '#tourBtn',
                popover: {
                    title: 'You\'re ready to plan a network',
                    description:
                        '<p>That\'s the tour. The demo data is still loaded — feel free to poke around it, or click <strong>↺ Reset</strong> on the planner to start your own.</p>' +
                        '<p>You can replay this tour any time via the <strong>? Tour</strong> button up here.</p>',
                    side: 'bottom',
                },
            },
        ];
    }

    // ---- public ---------------------------------------------------------------
    async function start(opts) {
        if (_activeDriver) { try { _activeDriver.destroy(); } catch (e) {} _activeDriver = null; }
        if (!(window.driver && window.driver.js)) {
            console.warn('Driver.js not loaded — tour skipped.'); return;
        }
        const fresh = !opts || opts.seed !== false;
        if (fresh) {
            await _resetWorld();
            await _seedDemoForm();
        }
        const D = window.driver.js.driver;
        // Esc must always exit the tour. Driver.js (v1.3.1) only honours Esc when
        // allowClose is true — but we keep allowClose:false so outside-clicks
        // don't end the tour (see below). So bind our own Esc handler. Capture
        // phase fires it before the planner's autocomplete reads the key; it is
        // removed in onDestroyed so it never outlives the tour.
        const _onEsc = (e) => {
            if (e.key === 'Escape' && _activeDriver) {
                e.preventDefault();
                try { _activeDriver.destroy(); } catch (err) {}
            }
        };
        _activeDriver = D({
            showProgress: true,
            // Don't close the tour when the user clicks outside the popover —
            // otherwise interacting with the page (e.g. dragging the speed slider
            // or panning the map on the Overview step) ends the tour unexpectedly.
            // Deliberate exit is via the footer Close button or Esc (bound above).
            allowClose: false,
            showButtons: ['next', 'previous', 'close'],
            stagePadding: 6,
            smoothScroll: true,
            popoverClass: 'cns-tour-popover',
            // Allow the user to interact with the highlighted element / page while
            // the tour is open (no input blocking).
            disableActiveInteraction: false,
            onDestroyed: () => {
                document.removeEventListener('keydown', _onEsc, true);
                _activeDriver = null;
                try { CNSState.setJSON(KEY_DONE, true); } catch (e) {}
            },
            steps: _steps(),
        });
        _warnMissingAnchors();
        _activeDriver.drive();
        document.addEventListener('keydown', _onEsc, true);
    }

    // ---- drift detection ------------------------------------------------------
    // The tour points each step at a DOM selector. As the app's markup evolves
    // those anchors can silently break. check() reports every anchor + whether it
    // currently resolves — run CNSTour.check() in the console (or a Claude session
    // runs it during "update the tour") to find steps whose target moved or
    // vanished. NOTE: '#folder …' anchors only exist once the demand drawer has
    // rendered flights mid-tour, so they read `found:false` until then.
    function check() {
        return _steps().map((s, i) => ({
            step: i + 1,
            title: (s.popover && s.popover.title) || '',
            element: s.element || null,
            found: s.element ? !!document.querySelector(s.element) : 'centered (no element)',
        }));
    }
    // On start, warn about any STATIC anchor already missing (skip the dynamic
    // #folder ones) — an instant signal that a step needs updating.
    function _warnMissingAnchors() {
        try {
            check()
                .filter((r) => r.element && r.element.indexOf('#folder') !== 0 && r.found === false)
                .forEach((r) => console.warn(`[CNSTour] step ${r.step} "${r.title}" — anchor not found: ${r.element}`));
        } catch (e) { /* never block the tour on diagnostics */ }
    }

    // Show the welcome modal (Bootstrap). Safe no-op if the markup or Bootstrap
    // isn't present. Exposed so the topbar/tests can re-open it.
    function showWelcome() {
        const el = document.getElementById('welcomeModal');
        if (!el || !(window.bootstrap && window.bootstrap.Modal)) return;
        window.bootstrap.Modal.getOrCreateInstance(el).show();
    }

    function reset() {
        try { CNSState.setJSON(KEY_DONE, false); } catch (e) {}
        try { CNSState.setJSON(KEY_WELCOME_HIDE, false); } catch (e) {}
    }

    return { start, showWelcome, reset, check };
})();

// Onboarding wiring: the welcome modal is the landing entry point; the topbar
// ? Tour button replays the walkthrough directly.
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('tourBtn');
    if (btn) btn.addEventListener('click', () => CNSTour.start());

    const wmEl = document.getElementById('welcomeModal');
    const Modal = window.bootstrap && window.bootstrap.Modal;

    // "Don't show again" — reflect the saved preference and persist on change.
    const dontShow = document.getElementById('welcomeDontShow');
    if (dontShow) {
        try { dontShow.checked = !!CNSState.getJSON('cns_welcome_hide', false); } catch (e) {}
        dontShow.addEventListener('change', () => {
            try { CNSState.setJSON('cns_welcome_hide', dontShow.checked); } catch (e) {}
        });
    }

    // "Start demo" — close the welcome, then launch the tour once it's fully
    // hidden so Driver.js doesn't fight the closing backdrop.
    const startBtn = document.getElementById('welcomeStartBtn');
    if (startBtn && wmEl) {
        startBtn.addEventListener('click', () => {
            wmEl.addEventListener('hidden.bs.modal', () => CNSTour.start(), { once: true });
            if (Modal) Modal.getOrCreateInstance(wmEl).hide();
            else CNSTour.start();
        });
    }

    // Show the landing modal on load unless the user opted out.
    let optedOut = false;
    try { optedOut = !!CNSState.getJSON('cns_welcome_hide', false); } catch (e) {}
    if (wmEl && Modal && !optedOut) setTimeout(() => Modal.getOrCreateInstance(wmEl).show(), 300);
});
