/*
 * AirSaathi - recommendation engine (pure logic, no DOM).
 *
 * Every function here is deterministic and unit-tested in tests/engine.test.mjs.
 * AQI banding follows the US EPA AQI scale (the scale returned by the
 * Open-Meteo Air Quality API's `us_aqi` field). Health guidance text follows
 * the US EPA action table for particle pollution in "Air Quality Index - A
 * Guide to Air Quality and Your Health" (EPA-456/F-14-002, airnow.gov):
 * https://www.airnow.gov/sites/default/files/2018-04/aqi_brochure_02_14_0.pdf
 *
 * Emission factors are all from one source on one consistent basis:
 * OECD/ITF (2020), "Good to Go? Assessing the Environmental Performance of
 * New Mobility", Figure 2, p.23 - central estimates of life-cycle GHG
 * emissions per passenger-km (vehicle + fuel + infrastructure + operations,
 * global-average occupancy), read approximately from the chart:
 * https://www.oecd.org/content/dam/oecd/en/publications/reports/2020/09/good-to-go-assessing-the-environmental-performance-of-new-mobility_fabe5eab/f5cd236b-en.pdf
 * They are shown to users as estimates, never as exact measurements.
 */

(function (root) {
  'use strict';

  var AQI_BANDS = [
    { max: 50, label: 'Good', color: '#22c55e',
      advice: 'Air quality is satisfactory. Great day for outdoor plans.' },
    { max: 100, label: 'Moderate', color: '#eab308',
      advice: 'Acceptable air. Unusually sensitive people should consider reducing prolonged or heavy exertion (EPA).' },
    { max: 150, label: 'Unhealthy for Sensitive Groups', color: '#f97316',
      advice: 'People with heart or lung disease, children and older adults should reduce prolonged or heavy exertion (EPA).' },
    { max: 200, label: 'Unhealthy', color: '#ef4444',
      advice: 'Sensitive groups should avoid prolonged or heavy exertion; everyone else should reduce it (EPA).' },
    { max: 300, label: 'Very Unhealthy', color: '#a855f7',
      advice: 'Sensitive groups should avoid all physical activity outdoors; everyone else should avoid prolonged or heavy exertion (EPA).' },
    { max: 10000, label: 'Hazardous', color: '#7f1d1d',
      advice: 'Everyone should avoid all physical activity outdoors. Stay indoors, keep windows shut, run a HEPA purifier if available (EPA).' }
  ];

  /* g CO2e per passenger-km, life-cycle basis (vehicle + fuel +
     infrastructure + operational services) at global-average occupancy -
     all read approximately from one chart: OECD/ITF (2020) "Good to Go?",
     Figure 2, p.23, central estimates. Private car (ICE) ~155; private
     moped (ICE) ~70, the closest ITF category to an Indian petrol
     two-wheeler; urban bus (ICE) ~90; metro/urban train ~65.
     Auto-rickshaw is not covered by that source (or any comparable
     published life-cycle factor we could verify), so it is null: the UI
     shows auto swaps without a numeric saving rather than inventing one.
     Values are order-of-magnitude comparisons, not measurements. */
  var EMISSION_FACTORS = {
    car: 155, two_wheeler: 70, auto: null, bus: 90, metro: 65, cycle_walk: 0
  };

  var COMMUTE_LABELS = {
    car: 'Car (petrol, solo)', two_wheeler: 'Two-wheeler (petrol)',
    auto: 'Auto-rickshaw', bus: 'City bus', metro: 'Metro / suburban rail',
    cycle_walk: 'Cycle / walk'
  };

  function aqiBand(aqi) {
    for (var i = 0; i < AQI_BANDS.length; i++) {
      if (aqi <= AQI_BANDS[i].max) return AQI_BANDS[i];
    }
    return AQI_BANDS[AQI_BANDS.length - 1];
  }

  function sensitiveGroup(profile) {
    return !!(profile && (profile.children || profile.elderly || profile.asthma || profile.heart));
  }

  /*
   * Find the contiguous `length`-hour daylight window (06:00-20:00) with the
   * lowest average US AQI from hourly series [{time, aqi}].
   */
  function bestOutdoorWindow(hourly, length) {
    if (!hourly || hourly.length === 0) return null;
    length = length || 2;
    var day = hourly.filter(function (h) {
      var hr = new Date(h.time).getHours();
      return hr >= 6 && hr <= 20 && typeof h.aqi === 'number';
    });
    if (day.length < length) return null;
    var best = null;
    for (var i = 0; i <= day.length - length; i++) {
      var sum = 0;
      for (var j = 0; j < length; j++) sum += day[i + j].aqi;
      var avg = sum / length;
      if (!best || avg < best.avgAqi) {
        best = { start: day[i].time, end: day[i + length - 1].time, avgAqi: Math.round(avg) };
      }
    }
    return best;
  }

  function fmtHour(iso) {
    var d = new Date(iso);
    var h = d.getHours();
    var suffix = h >= 12 ? 'PM' : 'AM';
    var hh = h % 12 === 0 ? 12 : h % 12;
    return hh + ' ' + suffix;
  }

  /* Estimated weekly CO2e saving from replacing a commute mode.
     Returns null when either mode has no sourced factor (unknown is not
     the same as zero), 0 when there is no distance or no saving. */
  function commuteSavingsGramsPerWeek(fromMode, toMode, dailyKm) {
    if (!dailyKm) return 0;
    var from = EMISSION_FACTORS[fromMode];
    var to = EMISSION_FACTORS[toMode];
    if (typeof from !== 'number' || typeof to !== 'number') return null;
    var saving = (from - to) * dailyKm * 7;
    return Math.max(0, Math.round(saving));
  }

  /*
   * Build the personalised plan.
   * profile: { children, elderly, asthma, heart, commuteMode, commuteKm,
   *            outdoorMinutes, exerciseTime, hasPurifier, hasMask }
   * Returns { routine: [], hacks: [], swaps: [], risk: '' }
   */
  function generatePlan(aqiNow, hourly, profile) {
    var band = aqiBand(aqiNow);
    var sensitive = sensitiveGroup(profile);
    var win = bestOutdoorWindow(hourly, 2);
    var routine = [];
    var hacks = [];
    var swaps = [];

    var risk = band.label +
      (sensitive && aqiNow > 100 ? ' - EPA guidance for children, older adults and people with heart or lung disease applies to your household at this level.' : '.');

    /* --- Daily routine --- */
    /* EPA-456/F-14-002 action table for particle pollution: at 101-150,
       sensitive groups reduce prolonged or heavy exertion; at 151-200,
       sensitive groups avoid it and everyone else reduces it. So outdoor
       exercise is only planned into a window whose average AQI is at or
       below 100 for sensitive households, 150 otherwise. Never present
       the day's relative AQI minimum as a safe window when it isn't. */
    var exertionLimit = sensitive ? 100 : 150;
    if (win) {
      var endHour = (parseInt(String(win.end).slice(11, 13), 10) + 1) % 24;
      var endLabel = (endHour % 12 === 0 ? 12 : endHour % 12) + ' ' + (endHour >= 12 ? 'PM' : 'AM');
      if (win.avgAqi <= exertionLimit) {
        routine.push('Cleanest outdoor window today: about ' + fmtHour(win.start) + ' to ' + endLabel +
          ' (avg AQI ~' + win.avgAqi + '). Schedule walks, errands and exercise there.');
      } else {
        routine.push('No genuinely clean outdoor window today - the lowest 2-hour stretch still averages ~' +
          win.avgAqi + ' AQI. Keep exercise indoors; if a trip is unavoidable, the least-bad time is about ' +
          fmtHour(win.start) + ' to ' + endLabel + '. Keep it short' +
          (aqiNow > 150 || (sensitive && aqiNow > 100) ? '; adults should wear a well-fitted N95.' : '.'));
      }
    }
    if (aqiNow > 150) {
      routine.push('Right now AQI is ' + Math.round(aqiNow) + ' (' + band.label + '). Postpone non-essential outdoor trips.');
      var maskLine = profile.hasMask
        ? 'Wear your N95/FFP2 for any unavoidable outdoor time - a well-fitted adult N95 filters at least 95% of airborne particles (its NIOSH rating).'
        : 'Consider N95/FFP2 masks for the adults - a well-fitted N95 filters at least 95% of airborne particles (its NIOSH rating).';
      if (profile.children) {
        maskLine += ' The US FDA notes N95 respirators are not designed for children and may not seal on small faces, so they may not provide full protection - on high-AQI days keeping children indoors is the safer plan; use only a mask made and sized for children.';
      }
      routine.push(maskLine);
    } else if (aqiNow > 100) {
      routine.push('AQI is ' + Math.round(aqiNow) + ' (' + band.label + '). Keep outdoor exertion light and short.');
    } else {
      routine.push('AQI is ' + Math.round(aqiNow) + ' (' + band.label + '). Normal outdoor activity is fine.');
    }
    if (profile.exerciseTime === 'morning' && aqiNow > 100) {
      routine.push('Shift your morning workout indoors or to the cleanest window - winter mornings often trap pollutants near the ground.');
    }
    if (profile.commuteMode && profile.commuteMode !== 'metro' && profile.commuteMode !== 'cycle_walk') {
      routine.push('During high-AQI spells, prefer the metro or a closed vehicle over an open two-wheeler or auto - exposure studies generally find lower particle intake than riding open in traffic.');
    }

    /* --- Indoor air hacks --- */
    if (aqiNow > 100) {
      hacks.push('Keep windows shut during peak-pollution hours and air the home briefly during the cleanest window instead.');
    } else {
      hacks.push('Air quality allows natural ventilation today - open windows during the cleanest hours to flush indoor pollutants.');
    }
    hacks.push(profile.hasPurifier
      ? 'Run your HEPA purifier in the room you use most; US EPA guidance on home air cleaners finds a properly sized HEPA unit substantially lowers indoor particle levels.'
      : 'A HEPA air purifier in the bedroom is the single most effective indoor upgrade for smog season - US EPA guidance on home air cleaners finds a properly sized unit substantially lowers indoor particle levels.');
    hacks.push('Avoid incense sticks, agarbatti smoke and indoor smoking on high-AQI days - they add directly to indoor PM2.5.');
    hacks.push('Wet-mop instead of dry-sweeping, and wash bedding weekly - settled dust re-enters the air otherwise.');
    if (profile.asthma) {
      hacks.push('Keep reliever inhalers accessible and follow the action plan from your doctor on poor-air days.');
    }

    /* --- Sustainable swaps with estimated impact --- */
    var km = profile.commuteKm || 0;
    if (profile.commuteMode === 'car' && km > 0) {
      swaps.push({ action: 'Swap solo car to metro or bus for your commute',
        saving: commuteSavingsGramsPerWeek('car', 'metro', km),
        why: 'Metro per-passenger CO2e is a small fraction of a solo petrol car (estimates), and a closed carriage usually means less direct roadside exhaust.' });
      swaps.push({ action: 'Carpool with one colleague two days a week',
        saving: Math.round(commuteSavingsGramsPerWeek('car', 'car', km) * 0.5 * 0.4),
        why: 'Sharing one car roughly halves per-person commute emissions on those days (estimate).' });
    }
    if (profile.commuteMode === 'two_wheeler' && km > 0) {
      swaps.push({ action: 'Move commute to metro/bus three days a week',
        saving: Math.round(commuteSavingsGramsPerWeek('two_wheeler', 'metro', km) * 0.6),
        why: 'Lower emissions per km and far less direct exhaust exposure in traffic (estimate).' });
    }
    if ((profile.commuteMode === 'auto') && km > 0) {
      swaps.push({ action: 'Replace auto rides with metro + a short walk',
        saving: null,
        why: 'Metro emits far less per passenger-km and keeps you out of roadside pollution. This prototype has no comparable sourced factor for auto-rickshaws, so it does not quote a number.' });
    }
    if (km > 0 && km <= 6) {
      swaps.push({ action: 'Walk or cycle trips under 3 km',
        saving: commuteSavingsGramsPerWeek(profile.commuteMode || 'car', 'cycle_walk', Math.min(km, 3)),
        why: 'Zero emissions - and on high-AQI days do it inside the cleanest window to keep exposure low (estimate).' });
    }
    swaps.push({ action: 'Consolidate errands into one trip instead of several',
      saving: null,
      why: 'Cold-start trips are the dirtiest part of urban driving; one planned loop cuts both emissions and your exposure.' });

    return { routine: routine, hacks: hacks, swaps: swaps, risk: risk };
  }

  var api = {
    AQI_BANDS: AQI_BANDS,
    EMISSION_FACTORS: EMISSION_FACTORS,
    COMMUTE_LABELS: COMMUTE_LABELS,
    aqiBand: aqiBand,
    sensitiveGroup: sensitiveGroup,
    bestOutdoorWindow: bestOutdoorWindow,
    fmtHour: fmtHour,
    commuteSavingsGramsPerWeek: commuteSavingsGramsPerWeek,
    generatePlan: generatePlan
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
