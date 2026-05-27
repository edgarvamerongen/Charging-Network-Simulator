/*
 * CNS PDF Report — client-side payload assembler.
 * ------------------------------------------------------------------------------
 * Walks CNSDemand + CNSScheduler to build a self-contained snapshot of the
 * current plan, POSTs it to /api/report.pdf, and triggers a download. All of
 * the heavy domain logic (per-airport demand, rotation peaks, queue cascade)
 * stays in the browser modules so the server doesn't need a parallel Python
 * port that could drift out of sync.
 *
 * Depends on: CNSDemand, CNSScheduler, CNSCharging, CNSPlanes, CNSChargers.
 */
window.CNSReport = (function () {
    const DAY_START = 7 * 60, DAY_END = 23 * 60;
    const _short = (s, n = 18) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');
    const _flightsPerDay = t => t.freqUnit === 'week' ? t.freqN / 7 : t.freqN;

    // ---------- charger lookup (catalog: window.CHARGERS_BY_ID set by index.html) -
    function _chargerById(id, fallbackName, fallbackPower) {
        const cat = window.CHARGERS_BY_ID || {};
        return cat[id] || (CNSChargers.get && CNSChargers.get(id)) ||
            (fallbackName && fallbackPower != null
                ? { id, name: fallbackName, power_kw: +fallbackPower }
                : null);
    }

    // ---------- per-airport: charger fleet, contribs, rotations ------------
    function _buildAirport(a) {
        const ident = a.ident;
        const cfg = (CNSDemand.loadCfg()[ident]) || {};
        const fullCharge = !!cfg.fullCharge;
        const defaultTrip = a.contribs[0].t;
        const fleetIds = (cfg.chargers && cfg.chargers.length)
            ? cfg.chargers
            : CNSDemand.defaultChargerFleet(a.contribs);
        const fleet = fleetIds.map((id) => {
            // Find the contribution-trip that uses this charger so we can fall
            // back to its per-trip name/power when the catalog doesn't know id.
            const carrierTrip = (a.contribs.find(c => c.t.chargerId === id) || {}).t || defaultTrip;
            return _chargerById(id, carrierTrip.chargerName, carrierTrip.chargerPower);
        }).filter(Boolean);

        // Aggregate fleet into { name, power_kw, count } rows.
        const fleetAgg = {};
        fleet.forEach(c => {
            if (!fleetAgg[c.id]) fleetAgg[c.id] = { id: c.id, name: c.name, power_kw: c.power_kw, count: 0 };
            fleetAgg[c.id].count++;
        });
        const chargers = Object.values(fleetAgg);

        // One aircraft per contribution feeds CNSCharging — same realism +
        // cross-airport target-SoC logic as renderFolder, so the PDF agrees
        // with what the operator sees on screen.
        const route = (window.CNSSettings ? CNSSettings.routingFactor() : 1.0);
        const cfgs = CNSDemand.loadCfg();
        const getTargetSoc = (id) => CNSDemand.targetSocFromCfg(cfgs[id]);
        const multiCache = {};
        const aircraftList = a.contribs.map((c, i) => {
            const plane = (window.PLANES_BY_ID || {})[c.t.planeId] || c.t;
            const usable = window.CNSSettings ? CNSSettings.usableFraction(plane) : 1.0;
            const battery = c.t.battery ?? c.t.legEnergy * 2;
            const usableBattery = battery * usable;
            const legPadded = (c.t.legEnergy || 0) * route;
            let energy;
            if (c.t.multiLeg) {
                const recomputed = multiCache[c.t.id]
                    || (multiCache[c.t.id] = CNSDemand.recomputeMultiLegCharges(c.t, getTargetSoc, usableBattery));
                const newC = (c.chargeIdx != null && recomputed[c.chargeIdx]) ? recomputed[c.chargeIdx] : null;
                energy = newC ? newC.energy_kwh : c.base * route;
            } else {
                const targetThis = getTargetSoc(a.ident);
                const otherIdent = c.role === 'home' ? c.t.destIdent
                                 : c.role === 'dest' ? c.t.originIdent
                                 : null;
                const targetOther = otherIdent ? getTargetSoc(otherIdent) : null;
                energy = CNSDemand.deliveredEnergy(c.t, c.role, legPadded, battery, usableBattery, targetThis, targetOther);
            }
            return { _i: i, name: c.t.planeName, energy, size: battery };
        });
        const plan = CNSCharging.planCharging(fleet, aircraftList);

        let dailyKwh = 0, dailyChargingHours = 0;
        const contribs = a.contribs.map((c, i) => {
            const t = c.t;
            const asg = plan.assignments[i];
            const energy = asg.aircraft.energy;
            const power = asg.charger ? asg.charger.power_kw : 0;
            const battery = t.battery ?? t.legEnergy * 2;
            const chargeMin = window.CNSSettings && power
                ? CNSSettings.chargeTimeMin(energy, power, battery)
                : asg.chargeTimeMin;
            const fpd = _flightsPerDay(t);
            dailyKwh += energy * fpd;
            if (isFinite(chargeMin)) dailyChargingHours += (chargeMin / 60) * fpd;
            return {
                planeName: t.planeName,
                tripType: t.tripType,
                multiLeg: !!t.multiLeg,
                role: c.role,
                other: c.other,
                direction: c.direction || null,
                freqN: t.freqN,
                freqUnit: t.freqUnit,
                flightsPerDay: fpd,
                energyPerFlight: energy,
                chargeMin: isFinite(chargeMin) ? chargeMin : 0,
                chargerName: asg.charger ? asg.charger.name : 'no charger',
            };
        });

        const sInfo = CNSScheduler.summary(ident);
        const peakKw = sInfo.peakKw || plan.peakPower || 0;

        // Rotations — replicate the lane structure the on-screen scheduler renders,
        // including the per-charge wait injections so the Gantt matches the screen.
        const res = CNSScheduler.resolveAirport(ident);
        const rotations = res.lanes.map((L, li) => {
            const t = L.trip;
            const role = (t.destIdent === ident) ? 'dest'
                       : (t.originIdent === ident && t.tripType === 'retour') ? 'home'
                       : 'stop';
            const instances = L.desired.map((d, k) => {
                const takeoff = res.takeoffs[res.keyOf(li, k)];
                const atXIdxs = [];
                L.ph.forEach((p, i) => { if (p.kind === 'charge' && p.atX) atXIdxs.push(i); });
                const phases = L.ph.map(p => ({
                    // Mark off-airport charges as a distinct kind so the renderer
                    // tints them lighter (the Gantt for THIS airport only cares
                    // about local charges; the others fade into the background).
                    kind: p.kind === 'charge' ? (p.atX ? 'charge' : 'elsewhere') : p.kind,
                    start: p.start,
                    dur: p.dur,
                    label: p.label || '',
                }));
                // Insert wait phases ahead of any queued charges and push the rest right.
                let anyWait = false;
                for (let ci = 0; ci < atXIdxs.length; ci++) {
                    if ((res.waits[res.evKey(li, k, ci)] || 0) > 0) { anyWait = true; break; }
                }
                if (anyWait) {
                    const origLen = phases.length;
                    atXIdxs.forEach((origChIdx, ci) => {
                        const w = res.waits[res.evKey(li, k, ci)] || 0;
                        if (w <= 0) return;
                        const cs = phases[origChIdx].start;
                        for (let i = origChIdx; i < origLen; i++) phases[i].start += w;
                        phases.push({ kind: 'wait', start: cs, dur: w, label: 'Waiting for free charger' });
                    });
                }
                phases.sort((a, b) => a.start - b.start);
                return { start: takeoff, phases };
            });
            return {
                route: `${_short(t.originName)} → ${_short(t.destName)}`,
                planeName: t.planeName,
                role,
                multiLeg: !!t.multiLeg,
                instances,
            };
        });

        return {
            ident,
            name: a.name,
            lat: a.lat,
            lon: a.lon,
            fullCharge,
            chargers,
            contribs,
            rotations,
            dailyKwh,
            dailyChargingHours,
            peakKw,
            latestEnd: sInfo.latestEnd || DAY_END,
            overflow: !!sInfo.overflow,
        };
    }

    // ---------- routes for the network map ---------------------------------
    function _routesFromFlights(flights) {
        return flights.map(t => {
            const wp = [[+t.originLat, +t.originLon]];
            if (t.multiLeg && Array.isArray(t.stops)) t.stops.forEach(s => wp.push([+s.lat, +s.lon]));
            wp.push([+t.destLat, +t.destLon]);
            return { waypoints: wp, retour: t.tripType === 'retour' };
        }).filter(r => r.waypoints.every(p => isFinite(p[0]) && isFinite(p[1])));
    }

    // ---------- planes / chargers actually used ----------------------------
    function _usedPlanes(flights) {
        // Saved flights carry planeId + planeName + planeSvg + battery. Range,
        // speed, seats, load_kg only live in the plane catalog (built-in or
        // custom). Try both catalogs and fall back to saved fields if neither
        // knows about this plane (e.g. an old saved trip whose plane was deleted).
        const builtin = window.PLANES_BY_ID || {};
        const seen = new Map();
        flights.forEach(t => {
            if (seen.has(t.planeId)) return;
            const cat = builtin[t.planeId] || (CNSPlanes.get ? CNSPlanes.get(t.planeId) : null);
            seen.set(t.planeId, {
                id: t.planeId,
                name: t.planeName,
                svg: t.planeSvg || (cat && cat.svg) || '',
                battery_kwh: (cat && cat.battery_kwh) ?? t.battery ?? 0,
                range_km: (cat && cat.range_km) ?? 0,
                speed_kmh: (cat && cat.speed_kmh) ?? 0,
                seats: cat && cat.seats,
                load_kg: cat && cat.load_kg,
            });
        });
        return Array.from(seen.values());
    }
    function _usedChargers(rawAirports) {
        // rawAirports = the un-decorated computeAirports() output (contribs still
        // carry their underlying trip via .t). We need that to recover the
        // default chargerId when no per-airport config is set.
        const seen = new Map();
        const cfgs = CNSDemand.loadCfg();
        rawAirports.forEach(a => {
            const cfg = cfgs[a.ident] || {};
            const dflt = a.contribs[0].t;
            const ids = (cfg.chargers && cfg.chargers.length) ? cfg.chargers : [dflt.chargerId];
            ids.forEach((id, i) => {
                const c = _chargerById(id, i === 0 ? dflt.chargerName : null, i === 0 ? dflt.chargerPower : null);
                if (c && !seen.has(c.id)) seen.set(c.id, { id: c.id, name: c.name, power_kw: c.power_kw });
            });
        });
        return Array.from(seen.values());
    }

    // ---------- assemble + send --------------------------------------------
    function buildPayload() {
        const flights = CNSDemand.loadFolder();
        const rawAirports = Object.values(CNSDemand.computeAirports());
        const airports = rawAirports.map(_buildAirport);
        const totals = {
            airportCount: airports.length,
            flightCount: flights.length,
            planeCount: new Set(flights.map(t => t.planeId)).size,
            totalDailyKwh: airports.reduce((s, a) => s + a.dailyKwh, 0),
            peakKw: airports.reduce((m, a) => Math.max(m, a.peakKw), 0),
        };
        return {
            generatedAt: new Date().toLocaleString('en-GB', {
                year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
            }),
            totals,
            airports,
            planes: _usedPlanes(flights),
            chargers: _usedChargers(rawAirports),
            flights: flights.map(t => ({
                originName: t.originName, destName: t.destName, planeName: t.planeName,
                tripType: t.tripType, multiLeg: !!t.multiLeg,
            })),
            routes: _routesFromFlights(flights),
        };
    }

    async function generate(btn) {
        const folder = CNSDemand.loadFolder();
        if (!folder.length) {
            alert('Add at least one flight to the folder before generating a report.');
            return;
        }
        const original = btn && btn.innerHTML;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Generating PDF…';
        }
        try {
            const payload = buildPayload();
            const resp = await fetch('/api/report.pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) {
                let msg = `Server returned ${resp.status}`;
                try { msg = (await resp.json()).error || msg; } catch (e) {}
                throw new Error(msg);
            }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const today = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `nrg2fly-charging-plan-${today}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (err) {
            alert('Could not generate the PDF: ' + (err && err.message ? err.message : err));
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        }
    }

    return { generate, buildPayload };
})();
