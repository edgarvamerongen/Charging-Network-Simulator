/*
 * CNSFlightEntry — map an /api/simulate response into a demand-folder entry.
 * --------------------------------------------------------------------------
 * One source of truth for "sim response → folder entry", shared by the guided
 * tour's network seeding and the multi-route build-share restore. Pure: no DOM,
 * no globals — give it the sim response `d` plus the route context and it
 * returns the entry object the demand calculator stores.
 *
 *   fromSim(d, { origin, dest, chargerId, freqN, freqUnit, id })
 *     origin / dest : { ident, name, lat, lon }
 *     id            : the entry id VERBATIM (caller owns the id scheme)
 */
window.CNSFlightEntry = (function () {
    'use strict';
    function fromSim(d, opts) {
        const o = opts.origin, dst = opts.dest;
        const e = {
            id: opts.id,
            destIdent: dst.ident, destName: dst.name, destLat: dst.lat, destLon: dst.lon,
            originIdent: o.ident, originName: o.name, originLat: o.lat, originLon: o.lon,
            planeName: d.plane.name, planeId: d.plane.id, planeSvg: d.plane.svg, tripType: d.trip_type,
            chargerId: opts.chargerId, chargerName: d.charger.name, chargerPower: d.charger.power_kw,
            legEnergy: d.leg_energy_kwh, battery: d.plane.battery_kwh, c_rate: d.plane.c_rate,
            freqN: opts.freqN, freqUnit: opts.freqUnit, fleetMode: 'separate',
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
    return { fromSim };
})();
