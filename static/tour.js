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
 * First-visit auto-trigger via the `cns_tour_done` localStorage flag. Always
 * replayable from the ? Tour button in the topbar.
 *
 * Assumes Driver.js is loaded globally as window.driver.
 */
window.CNSTour = (function () {
    const KEY_DONE = 'cns_tour_done';
    let _activeDriver = null;

    // ---- leadership cards (welcome slide) ------------------------------------
    // Rendered inline in the welcome popover in the nrg2fly.com/about.html
    // "Leadership" style: circular photo, name, role, bio, credential tag pills.
    // Data + photos come from the crew/ folder (photos served from pics/crew/).
    const _leadership = [
        {
            name: 'Jacco Bink', role: 'COO', photo: '/pics/crew/jacco.jpeg',
            bio: 'A background at KLM and Alliander brings deep expertise in aviation and energy systems. As Consulting Director he leads the rollout of charging infrastructure at airports across the Netherlands and Europe.',
            tags: ['KLM', 'Alliander'],
            linkedin: 'https://www.linkedin.com/in/jacco-bink-ba6254/', email: 'jacco@nrg2fly.com',
        },
        {
            name: 'Merlijn van Vliet', role: 'CEO', photo: '/pics/crew/merlijn.jpeg',
            bio: "Co-owner of Europe's first electric flight academy and board member of the Electric Flying Connection. Combines brand strategy with a passion for electric aviation; leads NRG2fly's European partnerships and ecosystem building.",
            tags: ['✈ Pilot', 'E-Flight Academy', 'Electric Flying Connection'],
            linkedin: 'https://www.linkedin.com/in/merlijnvanvliet/', email: 'merlijn@nrg2fly.com',
        },
    ];
    function _leadershipCardsHTML() {
        const card = (c) =>
            '<div class="tour-lead-card">' +
              `<img class="tlc-photo" src="${c.photo}" alt="${c.name}" onerror="this.style.visibility='hidden'">` +
              `<div class="tlc-name">${c.name}</div>` +
              `<div class="tlc-role">${c.role}</div>` +
              `<p class="tlc-bio">${c.bio}</p>` +
              `<div class="tlc-tags">${c.tags.map((t) => `<span class="tlc-tag">${t}</span>`).join('')}</div>` +
              `<div class="tlc-links"><a href="${c.linkedin}" target="_blank" rel="noopener">LinkedIn ↗</a> · <a href="mailto:${c.email}">${c.email}</a></div>` +
            '</div>';
        return '<div class="tour-lead">' +
                 `<div class="tour-lead-grid">${_leadership.map(card).join('')}</div>` +
               '</div>';
    }

    // ---- demo-data seeding ----------------------------------------------------
    // Seed a realistic Lelystad → Frankfurt retour with the Beta Alia CX300 so
    // the tour's downstream steps (result panel, demand calc, scheduler) have
    // non-zero numbers to show. We don't simulate or save to the folder yet —
    // those happen mid-tour to demonstrate the buttons.
    async function _seedDemoForm() {
        const airports = await fetch('/api/airports').then(r => r.json());
        const lelystad  = airports.find(a => a.ident === 'EHLE');
        const frankfurt = airports.find(a => a.ident === 'EDDF');
        if (!lelystad || !frankfurt) return;

        // Beta Alia CX300: 400 km range, but with the realistic model factors on
        // by default (30% landing reserve + ~5% routing padding) its usable reach
        // drops to ~280 km — so Lelystad→Frankfurt (~365 km) no longer fits in one
        // hop and the auto-planner inserts a charging stop. That's exactly what we
        // showcase at the Model-settings + Suggested-route steps.
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
        // NOTE: "Plan with charging stops" is left OFF here on purpose. The tour
        // enables it at the Suggested-route step so the operator sees the natural
        // progression — first the warning that the Beta can't reach Frankfurt
        // direct under the applied reserve, then the planner adding a stop.
        if (typeof pickAirport === 'function') {
            pickAirport('origin', lelystad);
            pickAirport('destination', frankfurt);
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
        // All out of Lelystad: local NL hops, a 2nd Frankfurt run (the demo flight
        // already in the folder is the 1st), and a one-way into N. France.
        const specs = [
            { dest: 'EHAM', plane: 'beta_plane', type: 'retour',  freqN: 4 },   // Schiphol (commuter)
            { dest: 'EHRD', plane: 'beta_plane', type: 'retour',  freqN: 3 },   // Rotterdam
            { dest: 'EHTE', plane: 'beta_plane', type: 'one-way', freqN: 2 },   // Teuge
            { dest: 'EDDF', plane: 'vaeridion',  type: 'one-way', freqN: 1 },   // Frankfurt (2nd)
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
        const existing = CNSDemand.loadFolder();        // keep the demo Lelystad→Frankfurt flight
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

    // The step list — every entry has element + popover. Side-effects live in
    // onHighlightStarted so they fire just before the popover appears.
    function _steps() {
        return [
            // 1. Welcome — what is this tool and why does it exist?
            {
                popover: {
                    title: 'NRG2fly Charging Network Simulator',
                    description:
                        '<p>At NRG2fly we are rolling out a European charging network that makes point-to-point electric aviation possible. This tool helps airports and operators answer the strategic questions we keep coming back to: <strong>what kind of charging infrastructure, and how much power, do we need?</strong></p>' +
                        '<p>Simulate traffic between airports with a variety of electric aircraft and explore what different situations look like as electric aviation takes off — a defensible, client-ready sizing brief exported as a PDF, not a back-of-envelope guess. We advise starting with this demo tour, then running your own simulations.</p>' +
                        '<p>Got questions about your network? <strong>Merlijn van Vliet</strong> and <strong>Jacco Bink</strong> would love to hear from you.</p>' +
                        _leadershipCardsHTML() +
                        '<p class="tour-foot">Pre-filled example: <strong>Beta Alia · Lelystad → Frankfurt</strong>. Press <kbd>Esc</kbd> to skip any time.</p>',
                    side: 'over', align: 'center',
                    popoverClass: 'cns-tour-popover cns-tour-welcome',
                },
            },
            // 2. Whole screen — the simulator at a glance.
            {
                element: 'body',
                popover: { title: 'Your simulator at a glance', description: 'Left: the route builder. Centre: the map. Bottom: the Demand Calculator drawer. Top-right: Options and this Tour. We\'ll walk the route builder top to bottom, then read the network it produces.', side: 'over', align: 'center' },
            },
            // 3. Departure
            {
                element: '#origin',
                popover: { title: 'Departure airport', description: 'Type to search by name, IATA, or municipality — or click any orange marker on the map and pick "Set as Departure".', side: 'right' },
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
                popover: { title: 'Trajectory', description: 'The straight-line distance between Departure and Destination. If it\'s further than the chosen aircraft can fly on one charge, this turns into an over-range warning — your cue to plan charging stops.', side: 'right' },
            },
            // 7. Trip type
            {
                element: '#tripType',
                popover: { title: 'Trip type', description: 'One-way, Retour (round trip), or Training (an A→A loop with a fixed pattern radius).', side: 'right' },
            },
            // 8. Aircraft
            {
                element: '#plane',
                popover: { title: 'Aircraft', description: 'Pick a model — the card below shows its range, battery and a photo. "Override for this flight" tweaks the specs just for this route, and ➕ adds a custom aircraft (saved on the server for your colleagues).', side: 'right' },
            },
            // 9. Model settings — surfaced BEFORE the route so the factors that
            // shape it (and force a stop) are understood first.
            {
                element: '#planModelSettingsBtn',
                popover: { title: 'Model settings — applied to every calculation', description: 'These operational factors are <strong>on by default</strong> so the numbers stay realistic: a 30% landing reserve, ~5% routing padding, the charging-curve taper, and an 80% default charge target. The reserve and padding are exactly why the Beta Alia\'s 400&nbsp;km range can\'t reach Frankfurt in one hop — so a charging stop is needed. Open this any time to adjust the factors or switch them off.', side: 'right' },
            },
            // 10. Plan with charging stops — toggle it ON here so the user watches
            // the suggested route appear in the next step.
            {
                element: '.stops-toggle-row',
                popover: { title: 'Plan with charging stops', description: 'Switching this on lets the planner split an over-range trip into legs through intermediate airports. Watch — we\'re turning it on now, and a charging stop appears for the Beta Alia\'s Lelystad → Frankfurt run.', side: 'right' },
                onHighlightStarted: async () => { await _ensureStopsOn(); },
            },
            // 11. Suggested route — the stop the applied factors forced.
            {
                element: '#stopsSection',
                popover: { title: 'Suggested route', description: 'The planner split the trajectory into legs through an intermediate airport (shortest-path A*). Each row shows the leg distance; over-range legs would flag red. Drag the ≡ handle to reorder a manual stop; × removes one. More airport types are under Options, top-right.', side: 'right' },
                onHighlightStarted: async () => { await _ensureStopsOn(); },
            },
            // 12. Expected frequency
            {
                element: '#freqField',
                popover: { title: 'Expected frequency', description: 'How often this route runs. For retour or training flights you can also choose whether one aircraft cycles the rotations or a fleet of separate planes flies them — which changes how many chargers each airport needs.', side: 'right' },
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
                popover: { title: 'Your route on the map', description: 'The blue line is the outbound leg; the green dashed line (for retour trips) is the return. Each blue marker is an intermediate charging stop. The map zooms to fit the whole trip between the side panels.', side: 'bottom', align: 'center' },
                onHighlightStarted: async () => { await _ensureSimulated(); await _zoomToSimulatedRoute(); },
            },
            // 13. Result panel — scroll the panel to the TOP so the user sees
            // the headline numbers first, not a mid-panel chunk.
            {
                element: '.rail-right .panel',
                popover: { title: 'Result panel', description: 'Per-flight breakdown: energy used, flight duration, charge time. Below: the aircraft spec and the trip details (legs, total distance, charger). Click "+ Add to demand calculator" next to track this route in your network model.', side: 'left', align: 'start' },
                onHighlightStarted: async () => {
                    await _ensureSimulated();
                    const r = document.querySelector('.rail-right');
                    if (r) r.scrollTop = 0;
                },
            },
            // 14. Add to demand — scroll the rail DOWN so the button is fully
            // visible (it sits below the trip-calculated table).
            {
                element: '#addFolder',
                popover: { title: 'Add to demand calculator', description: 'Saves the flight to the network. Demand at each airport touched by the trip (Departure, Destination, every stop) gets attributed and aggregated across ALL saved flights.', side: 'left' },
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
                popover: { title: 'Demand Calculator', description: 'Look at the bottom of the screen — the <strong>Demand Calculator</strong> pill is the pull-up drawer with one card per airport your flights touch. Click it now (or just hit Next) and you\'ll see per-airport daily energy, peak power, charger config, and an embedded rotation scheduler.', side: 'over', align: 'center' },
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
                popover: { title: 'Per-airport breakdown', description: 'Each airport touched by a flight gets its own card. Numbers shown — daily energy, peak power, charging time — are <strong>specific to this airport</strong>, not the whole network. Multiple flights through the same airport are aggregated.', side: 'top', align: 'center' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); },
            },
            // 17. NEW — Role / route column
            {
                element: '#folder [data-dest] .folder-trip td:first-child',
                popover: { title: 'Role / route', description: 'For each contributing flight: which role this airport plays in the trip (<span class="role role-home">DEPARTURE</span>, <span class="role role-dest">DESTINATION</span>, or <span class="role role-stop">STOP</span>) and where the flight goes. Same airport visited twice on a retour shows two rows with direction arrows.', side: 'top', align: 'start' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); },
            },
            // 18. NEW — Chargers row, with add/remove emphasis
            {
                element: '#folder [data-dest] .fleet-add',
                popover: { title: 'Chargers installed at this airport', description: 'The dropdown picks the charger model. Click the green <strong>+</strong> to add another charger (parallel chargers serve more aircraft simultaneously, raising peak power but cutting queue waits). The × on each existing charger removes it. Custom models added via the planner are available here too.', side: 'top' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); },
            },
            // 19. NEW — Charge target chip
            {
                element: '#folder .soc-chip',
                popover: { title: 'Charge target', description: '<strong>Auto</strong> inherits the global default charge target from Model settings (80% by default). Set a percentage here to override it for <em>this</em> airport — a LOCAL target always wins over the GLOBAL default. Higher targets give the plane more reserve but slow charging (lithium-ion tapers above ~80% SoC).', side: 'top' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); },
            },
            // 20. Rotation scheduler — lift the drawer above the tour overlay
            // (same pattern as the network-animation step) so the Gantt chart
            // is brightly visible, and pin the popover to the TOP of the
            // viewport so it doesn't cover the chart.
            {
                popover: { title: 'Rotation scheduler', description: 'Below is the time table (Gantt chart) of the airport\'s daily charging schedule. Each row is one aircraft; blue bars are flights, green bars are charging here, light-green are charges elsewhere, striped amber are queued (waiting for a charger). Drag bars to reschedule — the rest re-cascades to prevent overlap.', side: 'over', align: 'center', popoverClass: 'cns-tour-popover cns-tour-popover-top' },
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
                popover: { title: 'PDF report', description: 'Exports the whole plan as a print-ready PDF — cover with headline numbers, executive summary, network map, per-airport pages with rotation charts, methodology notes. Great for client deliverables.', side: 'top' },
                onHighlightStarted: async () => { await _ensureDrawerOpen(); },
            },
            // 23. NEW — Wow finish: seed a few more flights + open the animation
            // modal. We lift the modal above the tour overlay (via the
            // .tour-modal-front class) so the user actually sees the map
            // playing, and pin the popover near the bottom of the viewport
            // so it doesn't cover the map.
            {
                popover: { title: 'Overview', description: 'Above, every saved flight flies its real, routed trajectory — adjust the speed with the slider, and watch planes pause to charge. This is the demo network: a handful of real routes out of Lelystad — local hops to Schiphol, Rotterdam and Teuge, two runs to Frankfurt, and a one-way to Lille. Close the modal when you\'re done.', side: 'over', align: 'center', popoverClass: 'cns-tour-popover cns-tour-popover-bottom' },
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
                onDeselected: async () => { await _closeFlightsMap(); },
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
        _activeDriver = D({
            showProgress: true,
            // Don't close the tour when the user clicks outside the popover —
            // otherwise interacting with the page (e.g. dragging the speed slider
            // or panning the map on the Overview step) ends the tour unexpectedly.
            // Deliberate exit is via the footer Close button or Esc.
            allowClose: false,
            showButtons: ['next', 'previous', 'close'],
            stagePadding: 6,
            smoothScroll: true,
            popoverClass: 'cns-tour-popover',
            // Allow the user to interact with the highlighted element / page while
            // the tour is open (no input blocking).
            disableActiveInteraction: false,
            onDestroyed: () => {
                _activeDriver = null;
                try { CNSState.setJSON(KEY_DONE, true); } catch (e) {}
            },
            steps: _steps(),
        });
        _warnMissingAnchors();
        _activeDriver.drive();
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

    function autoStartIfFirstVisit() {
        let done = false;
        try { done = !!CNSState.getJSON(KEY_DONE, false); } catch (e) {}
        if (done) return;
        // Small delay so the page has time to render + airports load.
        setTimeout(() => start(), 1200);
    }

    function reset() {
        try { CNSState.setJSON(KEY_DONE, false); } catch (e) {}
    }

    return { start, autoStartIfFirstVisit, reset, check };
})();

// Wire the topbar Tour button + first-visit auto-start.
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('tourBtn');
    if (btn) btn.addEventListener('click', () => CNSTour.start());
    if (window.CNSTour) CNSTour.autoStartIfFirstVisit();
});
