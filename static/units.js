/*
 * CNSUnits — display-only unit system + rounding/formatting helpers.
 * ------------------------------------------------------------------
 * Calculations are always done in metric. This module is purely about
 * how numbers are shown to the user. Modules call CNSUnits.fmtDist(km),
 * CNSUnits.fmtDuration(min), etc., and (optionally) subscribe via
 * CNSUnits.onChange to re-render when the user flips metric ↔ nautical.
 *
 * Depends on: CNSState (load earlier).
 */
window.CNSUnits = (function () {
    const KEY = CNSState.KEYS.units;
    const NM_PER_KM = 1 / 1.852;

    let system = CNSState.getRaw(KEY) || 'metric';
    const subs = [];

    const isNautical = () => system === 'nautical';
    const get = () => system;
    const set = (v) => {
        if (v !== 'metric' && v !== 'nautical') return;
        if (v === system) return;
        system = v;
        CNSState.setRaw(KEY, v);
        subs.forEach(fn => { try { fn(v); } catch (e) { console.error('units subscriber', e); } });
    };
    const onChange = (fn) => { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; };

    // Round UP (ceiling) for display, and avoid -0 from ceil(0 - 1e-9).
    const r = n => Math.ceil(n - 1e-9) || 0;
    const num = n => r(n).toLocaleString('en-US');

    const fmtDist = (km) => num(isNautical() ? km * NM_PER_KM : km) + (isNautical() ? ' nm' : ' km');
    const fmtSpeed = (kmh) => num(isNautical() ? kmh * NM_PER_KM : kmh) + (isNautical() ? ' kn' : ' km/h');
    const fmtUsage = (per100km) => num(isNautical() ? per100km / NM_PER_KM : per100km) + (isNautical() ? ' kWh/100nm' : ' kWh/100km');
    const fmtEnergy = (kwh) => num(kwh) + ' kWh';
    const fmtPower = (kw) => num(kw) + ' kW';
    // Charging durations switch to h:min once they exceed 60 minutes.
    const fmtDuration = (minutes) => {
        if (!isFinite(minutes)) return '—';
        const m = r(minutes);
        if (m <= 60) return m + ' min';
        return (m % 60) ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m / 60}h`;
    };
    const fmtClock = (min) => {
        const c = Math.max(0, Math.round(min));
        return String(Math.floor(c / 60)).padStart(2, '0') + ':' + String(c % 60).padStart(2, '0');
    };

    return { isNautical, get, set, onChange, r, num, fmtDist, fmtSpeed, fmtUsage, fmtEnergy, fmtPower, fmtDuration, fmtClock };
})();
