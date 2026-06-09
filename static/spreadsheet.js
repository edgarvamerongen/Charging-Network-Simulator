/*
 * CNS Spreadsheet export — client trigger.
 * ------------------------------------------------------------------------------
 * Reads the current plan (READ-ONLY) and POSTs a whole-Demand-Calculator payload
 * to /api/report.xlsx, then downloads the workbook. Reuses CNSReport.buildPayload
 * with no focus (= the whole network) and enriches it with the full flight
 * records from CNSDemand.loadFolder() for the standardised Flights input sheet.
 * Touches none of the existing report logic.
 *
 * Depends on: CNSReport.buildPayload, CNSDemand.loadFolder.
 */
window.CNSSpreadsheet = (function () {
    // Full, canonical flight records for the round-trippable Flights sheet.
    function _flightsFull() {
        return (CNSDemand.loadFolder() || []).map(t => ({
            id: t.id, planeId: t.planeId, planeName: t.planeName, battery: t.battery,
            originIdent: t.originIdent, originName: t.originName, originLat: t.originLat, originLon: t.originLon,
            destIdent: t.destIdent, destName: t.destName, destLat: t.destLat, destLon: t.destLon,
            stops: (t.stops || []).map(s => ({ ident: s.ident, name: s.name, lat: s.lat, lon: s.lon })),
            chargerId: t.chargerId, chargerName: t.chargerName, chargerPower: t.chargerPower,
            tripType: t.tripType, multiLeg: !!t.multiLeg, freqN: t.freqN, freqUnit: t.freqUnit,
        }));
    }

    async function exportXlsx(btn) {
        const folder = CNSDemand.loadFolder();
        if (!folder || !folder.length) {
            alert('Add at least one flight to the folder before exporting a spreadsheet.');
            return;
        }
        const original = btn && btn.innerHTML;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Exporting…';
        }
        try {
            const payload = CNSReport.buildPayload(null);   // whole DC, no airport focus
            payload.flightsFull = _flightsFull();
            const resp = await fetch('/api/report.xlsx', {
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
            a.download = `nrg2fly-charging-plan-${today}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (err) {
            alert('Could not export the spreadsheet: ' + (err && err.message ? err.message : err));
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        }
    }

    return { export: exportXlsx };
})();
