/* Node tests for the AirSaathi engine: run `node tests/engine.test.mjs`. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Engine = require('../engine.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('ok   - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}

/* AQI banding (US EPA scale) */
check('AQI 25 is Good', Engine.aqiBand(25).label === 'Good');
check('AQI 75 is Moderate', Engine.aqiBand(75).label === 'Moderate');
check('AQI 120 is USG', Engine.aqiBand(120).label === 'Unhealthy for Sensitive Groups');
check('AQI 175 is Unhealthy', Engine.aqiBand(175).label === 'Unhealthy');
check('AQI 250 is Very Unhealthy', Engine.aqiBand(250).label === 'Very Unhealthy');
check('AQI 350 is Hazardous', Engine.aqiBand(350).label === 'Hazardous');
check('bands have colors', Engine.AQI_BANDS.every(b => /^#[0-9a-f]{6}$/i.test(b.color)));

/* Sensitive groups */
check('no profile -> not sensitive', !Engine.sensitiveGroup(null));
check('asthma -> sensitive', Engine.sensitiveGroup({ asthma: true }));
check('empty profile -> not sensitive', !Engine.sensitiveGroup({}));

/* Best outdoor window */
const hourly = [];
for (let h = 0; h < 24; h++) {
  hourly.push({ time: '2026-11-27T' + String(h).padStart(2, '0') + ':00', aqi: h < 10 ? 180 - h * 10 : 60 + h });
}
const win = Engine.bestOutdoorWindow(hourly, 2);
check('window found', !!win);
check('window inside daylight', new Date(win.start).getHours() >= 6 && new Date(win.end).getHours() <= 20);
check('window picks lowest stretch', win.avgAqi <= 100);
check('empty hourly -> null', Engine.bestOutdoorWindow([], 2) === null);

/* Emission savings */
check('car->metro 10km saves weekly', Engine.commuteSavingsGramsPerWeek('car', 'metro', 10) === (155 - 65) * 10 * 7);
check('unsourced factor -> null, not zero', Engine.commuteSavingsGramsPerWeek('auto', 'metro', 10) === null);
check('auto swap quotes no number', !Engine.generatePlan(120, [], { commuteMode: 'auto', commuteKm: 8 }).swaps.some(s => /auto rides/i.test(s.action) && s.saving !== null));
check('metro->car never negative', Engine.commuteSavingsGramsPerWeek('metro', 'car', 10) === 0);
check('zero km -> zero saving', Engine.commuteSavingsGramsPerWeek('car', 'metro', 0) === 0);

/* Plan generation */
const plan = Engine.generatePlan(180, hourly, {
  children: true, elderly: false, asthma: true, heart: false,
  commuteMode: 'car', commuteKm: 12, exerciseTime: 'morning', hasMask: false, hasPurifier: false
});
check('plan has routine items', plan.routine.length >= 3);
check('plan warns sensitive household', /heart or lung disease|children|older adults/i.test(plan.risk));
check('plan has indoor hacks', plan.hacks.length >= 3);
check('car commute gets a metro swap with saving', plan.swaps.some(s => /metro/i.test(s.action) && s.saving > 0));
check('low AQI keeps windows open advice', Engine.generatePlan(40, hourly, { commuteKm: 0 })
  .hacks.some(h => /natural ventilation/i.test(h)));

/* Health gating: relative minimum must not be sold as a safe window */
const badDay = [];
for (let h = 0; h < 24; h++) badDay.push({ time: '2026-11-27T' + String(h).padStart(2, '0') + ':00', aqi: 185 + (h % 5) });
const sensitivePlan = Engine.generatePlan(190, badDay, { children: true, commuteKm: 0, exerciseTime: 'morning' });
check('unhealthy + sensitive: no "cleanest outdoor window"', !sensitivePlan.routine.some(r => /Cleanest outdoor window/.test(r)));
check('unhealthy + sensitive: least-bad framing present', sensitivePlan.routine.some(r => /least-bad/.test(r) && /N95/.test(r)));
const okDay = badDay.map(h => ({ time: h.time, aqi: 40 }));
const fitPlan = Engine.generatePlan(40, okDay, { commuteKm: 0 });
check('good day + non-sensitive: window recommended', fitPlan.routine.some(r => /Cleanest outdoor window/.test(r)));
const moderateSensitive = Engine.generatePlan(120, badDay.map(h => ({ time: h.time, aqi: 120 })), { elderly: true, commuteKm: 0 });
check('USG + sensitive: no exercise window', !moderateSensitive.routine.some(r => /Cleanest outdoor window/.test(r)));

/* Hour formatting */
check('fmtHour AM/PM', Engine.fmtHour('2026-11-27T13:00') === '1 PM' && Engine.fmtHour('2026-11-27T00:00') === '12 AM');

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll engine tests passed');
process.exit(failures ? 1 : 0);
