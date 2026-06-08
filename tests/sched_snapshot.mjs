// DES parity gate: capture CNSScheduler.runGlobal() (rotation phases + energies + peak)
// for a seeded 4-trip-type network. `--capture` writes the baseline; bare run diffs against it.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadStack, AP } from './golden_capture.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO,'planes.json'),'utf8')).map(p=>[p.id,p]));
const BASE = process.env.CNS_BASE_URL || 'http://127.0.0.1:5057';
const SNAP = path.join(REPO, 'tests', 'goldens', 'sched-snapshot.json');
const co = k => ({ident:k, name:AP[k].name, lat:AP[k].lat, lon:AP[k].lon});
const round = (x,n=2) => (x==null||!isFinite(+x)) ? (x??null) : +(+x).toFixed(n);
const NETWORK = [
  { id:'t-ow', plane:'beta_plane', o:'EHAM', d:'LFPG', trip:'one-way', charger:'dc_250' },
  { id:'t-ret', plane:'beta_plane', o:'EHAM', d:'EHGG', trip:'retour', charger:'dc_250' },
  { id:'t-multi', plane:'beta_plane', o:'EHAM', d:'EGLL', trip:'one-way', stops:['EHRD'], charger:'dc_250' },
  { id:'t-train', plane:'pipistrel_velis', o:'EHAM', d:'EHAM', trip:'training', charger:'dc_60' },
];
async function sim(c){ const dest=c.trip==='training'?c.o:c.d; const p={origin:co(c.o),destination:co(dest),plane_id:c.plane,charger_id:c.charger,trip_type:c.trip}; if(c.stops)p.stops=c.stops.map(co); return (await fetch(BASE+'/api/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})).json(); }
function savedTrip(c,data){ const P=PLANES[c.plane], dest=c.trip==='training'?c.o:c.d; const t={id:c.id,planeId:c.plane,planeName:P.name,tripType:c.trip,originIdent:c.o,originName:AP[c.o].name,originLat:AP[c.o].lat,originLon:AP[c.o].lon,destIdent:dest,destName:AP[dest].name,destLat:AP[dest].lat,destLon:AP[dest].lon,battery:P.battery_kwh,range_km:P.range_km,speed_kmh:P.speed_kmh,c_rate:P.c_rate,chargerId:c.charger,chargerName:c.charger,chargerPower:c.charger==='dc_250'?250:60,legEnergy:data.leg_energy_kwh,flightTimeH:data.multi_leg?data.total_flight_time_h:data.flight_time_h,freqN:1,freqUnit:'day',fleetMode:'separate'}; if(data.multi_leg)Object.assign(t,{multiLeg:true,stops:(c.stops||[]).map(co),legs:data.legs,charges:data.charges,totalFlightTimeH:data.total_flight_time_h}); else if(c.trip==='training')t.trainingRangeKm=data.training_range_km; return t; }
async function capture(){
  const S=loadStack(); S.CNSSettings.reset();
  const trips=[]; for(const c of NETWORK){ const data=await sim(c); if(data.error){console.log('SKIP',c.id,data.error);continue;} trips.push(savedTrip(c,data)); }
  S.localStorage.setItem('cns_folder',JSON.stringify(trips));
  S.localStorage.setItem('cns_airport_cfg',JSON.stringify({}));
  S.CNSScheduler.init({chargers:{dc_250:{id:'dc_250',name:'250 kW DC',power_kw:250},dc_60:{id:'dc_60',name:'60 kW DC',power_kw:60}}});
  const g=S.CNSScheduler.runGlobal();
  const lanes=(g.lanes||[]).map(L=>({trip:L.trip&&L.trip.id,rotations:(L.rotations||[]).map(r=>({takeoff:round(r.takeoff),end:round(r.end),phases:(r.phases||[]).map(p=>({kind:p.kind,ident:p.ident||null,start:round(p.start),dur:round(p.dur),energy:round(p.energy)}))}))}));
  const airports={}; for(const id of ['EHAM','LFPG','EHGG','EGLL','EHRD']){ const s=S.CNSScheduler.summary(id); airports[id]={peakKw:round(s.peakKw),latestEnd:round(s.latestEnd)}; }
  return {laneCount:lanes.length, lanes, airports};
}
const snap=await capture();
if(process.argv[2]==='--capture'){ fs.writeFileSync(SNAP,JSON.stringify(snap,null,2)+'\n'); console.log(`captured baseline (${snap.laneCount} lanes) -> ${SNAP}`); console.log('airports:',JSON.stringify(snap.airports)); }
else { const base=JSON.parse(fs.readFileSync(SNAP,'utf8')); if(JSON.stringify(snap)===JSON.stringify(base)) console.log(`OK: runGlobal IDENTICAL to baseline (${snap.laneCount} lanes, zero DES drift)`); else { console.log('DRIFT vs baseline:'); for(let i=0;i<Math.max(snap.lanes.length,base.lanes.length);i++){ if(JSON.stringify(snap.lanes[i])!==JSON.stringify(base.lanes[i])){console.log('lane',i,'A',JSON.stringify(snap.lanes[i]));console.log('lane',i,'B',JSON.stringify(base.lanes[i]));break;} } if(JSON.stringify(snap.airports)!==JSON.stringify(base.airports)){console.log('airports A',JSON.stringify(snap.airports));console.log('airports B',JSON.stringify(base.airports));} process.exit(1);} }
