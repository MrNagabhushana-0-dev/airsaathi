/* AirSaathi - UI wiring. Requires engine.js (Engine) and ai.js (AI). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    place: null,          // {name, admin, country, lat, lon}
    current: null,        // Open-Meteo current block
    hourly: [],           // [{time, aqi}]
    profile: loadJSON('airsaathi.profile', null),
    adopted: loadJSON('airsaathi.adopted', []),
    plan: null,
    chat: [],
    aiSettings: loadJSON('airsaathi.ai', { provider: 'auto', geminiKey: '', geminiModel: 'gemini-2.5-flash' })
  };

  function loadJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  function showError(msg) {
    var box = $('error-box');
    box.textContent = msg;
    box.style.display = msg ? 'block' : 'none';
  }

  /* ---------- Location search (Open-Meteo geocoding, free, keyless) ---------- */
  var searchTimer = null;
  $('city-input').addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = this.value.trim();
    if (q.length < 3) { $('city-results').style.display = 'none'; return; }
    searchTimer = setTimeout(function () { findCities(q); }, 350);
  });
  $('city-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('search-btn').click(); }
  });
  document.addEventListener('click', function (e) {
    if (!$('city-results').contains(e.target) && e.target !== $('city-input')) {
      $('city-results').style.display = 'none';
    }
  });

  function findCities(q) {
    fetch('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=' +
      encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var box = $('city-results');
        box.innerHTML = '';
        (data.results || []).forEach(function (p) {
          var b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', 'option');
          b.textContent = p.name + (p.admin1 ? ', ' + p.admin1 : '') + (p.country ? ', ' + p.country : '');
          b.addEventListener('click', function () {
            box.style.display = 'none';
            selectPlace({ name: p.name, admin: p.admin1 || '', country: p.country || '',
                          lat: p.latitude, lon: p.longitude });
          });
          box.appendChild(b);
        });
        box.style.display = box.children.length ? 'block' : 'none';
      })
      .catch(function () { showError('City search failed. Check your connection and retry.'); });
  }

  $('search-btn').addEventListener('click', function () {
    var first = $('city-results').querySelector('button');
    if (first) { first.click(); return; }
    var q = $('city-input').value.trim();
    if (q.length >= 3) findCities(q);
    else showError('Type at least 3 letters of a city name.');
  });

  $('geo-btn').addEventListener('click', function () {
    if (!navigator.geolocation) { showError('Geolocation is not supported by this browser.'); return; }
    showError('');
    this.disabled = true;
    var btn = this;
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      selectPlace({ name: 'My location', admin: '', country: '',
                    lat: pos.coords.latitude, lon: pos.coords.longitude });
    }, function () {
      btn.disabled = false;
      showError('Location permission was denied. Search your city instead.');
    }, { timeout: 10000 });
  });

  function selectPlace(place) {
    state.place = place;
    saveJSON('airsaathi.place', place);
    $('city-input').value = place.name + (place.admin ? ', ' + place.admin : '');
    document.dispatchEvent(new CustomEvent('airsaathi:place', { detail: place }));
    loadAir();
  }

  /* ---------- Live air quality (Open-Meteo, free, keyless) ---------- */
  function loadAir() {
    if (!state.place) return;
    showError('');
    var p = state.place;
    var url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + p.lat +
      '&longitude=' + p.lon +
      '&current=us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide' +
      '&hourly=us_aqi&forecast_days=3&timezone=auto';
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('Air-quality service error ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.current = data.current;
        var times = (data.hourly && data.hourly.time) || [];
        var aqis = (data.hourly && data.hourly.us_aqi) || [];
        state.hourly = times.map(function (t, i) { return { time: t, aqi: aqis[i] }; })
          .filter(function (h) { return typeof h.aqi === 'number'; });
        renderDashboard();
        rebuildPlan();
        document.dispatchEvent(new CustomEvent('airsaathi:air', {
          detail: { place: state.place, current: state.current, hourly: state.hourly }
        }));
      })
      .catch(function (e) { showError('Could not load live air data: ' + e.message); });
  }

  function renderDashboard() {
    var c = state.current;
    if (!c) return;
    var aqi = Math.round(c.us_aqi);
    var band = Engine.aqiBand(aqi);
    $('aqi-num').textContent = aqi;
    $('band-chip').textContent = band.label;
    $('band-chip').style.background = band.color;
    $('band-advice').textContent = band.advice;
    var pct = Math.min(100, Math.round(aqi / 400 * 100));
    var g = $('gauge');
    g.style.setProperty('--pct', pct);
    g.style.setProperty('--band', band.color);
    g.setAttribute('aria-label', 'Current US AQI ' + aqi + ', ' + band.label);
    $('where-when').textContent = ' - ' + state.place.name +
      (state.place.admin ? ', ' + state.place.admin : '') +
      ', updated ' + new Date(c.time).toLocaleString(undefined,
        { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    setText('pm25', c.pm2_5); setText('pm10', c.pm10); setText('no2', c.nitrogen_dioxide);
    setText('o3', c.ozone); setText('so2', c.sulphur_dioxide); setText('co', c.carbon_monoxide);
    drawChart();
  }
  function setText(id, v) { $(id).textContent = (typeof v === 'number') ? Math.round(v) : '--'; }

  function drawChart() {
    var cv = $('forecast');
    var dpr = window.devicePixelRatio || 1;
    var cssW = Math.max(cv.clientWidth, 560), cssH = 210;
    cv.width = cssW * dpr; cv.height = cssH * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    var data = state.hourly.slice(0, 48);
    if (!data.length) return;
    var maxAqi = Math.max(80, Math.max.apply(null, data.map(function (h) { return h.aqi; })) * 1.15);
    var padL = 34, padB = 22, padT = 8, padR = 6;
    var w = cssW - padL - padR, h = cssH - padT - padB;
    function x(i) { return padL + w * i / (data.length - 1); }
    function y(v) { return padT + h * (1 - v / maxAqi); }

    /* best window shading */
    var win = Engine.bestOutdoorWindow(data, 2);
    if (win) {
      var i0 = data.findIndex(function (d) { return d.time === win.start; });
      if (i0 >= 0) {
        ctx.fillStyle = 'rgba(15,118,110,.12)';
        var x0 = x(i0), x1 = x(Math.min(i0 + 1, data.length - 1));
        ctx.fillRect(x0 - (x(1) - x(0)) / 2, padT, (x1 - x0) + (x(1) - x(0)), h);
      }
    }
    /* gridlines + labels */
    ctx.strokeStyle = '#e2eae6'; ctx.fillStyle = '#5b6b64'; ctx.font = '11px system-ui';
    [0, 50, 100, 150, 200, 300].forEach(function (v) {
      if (v > maxAqi) return;
      ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(padL + w, y(v)); ctx.stroke();
      ctx.fillText(String(v), 4, y(v) + 4);
    });
    for (var i = 0; i < data.length; i += 6) {
      ctx.fillText(Engine.fmtHour(data[i].time), x(i) - 12, cssH - 6);
    }
    /* the line */
    ctx.beginPath();
    data.forEach(function (d, i) { i ? ctx.lineTo(x(i), y(d.aqi)) : ctx.moveTo(x(i), y(d.aqi)); });
    ctx.strokeStyle = '#0f766e'; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.lineTo(x(data.length - 1), padT + h); ctx.lineTo(x(0), padT + h); ctx.closePath();
    ctx.fillStyle = 'rgba(15,118,110,.10)'; ctx.fill();
  }
  window.addEventListener('resize', drawChart);

  /* ---------- Profile & plan ---------- */
  var PROFILE_IDS = { children: 'p-children', elderly: 'p-elderly', asthma: 'p-asthma', heart: 'p-heart' };
  function readProfileForm() {
    return {
      children: $('p-children').checked, elderly: $('p-elderly').checked,
      asthma: $('p-asthma').checked, heart: $('p-heart').checked,
      commuteMode: $('p-commute').value, commuteKm: parseFloat($('p-km').value) || 0,
      exerciseTime: $('p-exercise').value,
      hasMask: $('p-mask').checked, hasPurifier: $('p-purifier').checked
    };
  }
  function fillProfileForm(p) {
    if (!p) return;
    Object.keys(PROFILE_IDS).forEach(function (k) { $(PROFILE_IDS[k]).checked = !!p[k]; });
    if (p.commuteMode) $('p-commute').value = p.commuteMode;
    if (typeof p.commuteKm === 'number') $('p-km').value = p.commuteKm;
    if (p.exerciseTime) $('p-exercise').value = p.exerciseTime;
    $('p-mask').checked = !!p.hasMask;
    $('p-purifier').checked = !!p.hasPurifier;
  }
  $('profile-form').addEventListener('submit', function (e) {
    e.preventDefault();
    state.profile = readProfileForm();
    saveJSON('airsaathi.profile', state.profile);
    rebuildPlan();
    document.getElementById('plan').scrollIntoView({ behavior: 'smooth' });
  });

  function rebuildPlan() {
    if (!state.current || !state.profile) return;
    state.plan = Engine.generatePlan(state.current.us_aqi, state.hourly, state.profile);
    $('plan-risk').textContent = 'Current risk: ' + state.plan.risk;
    fillList('routine-list', state.plan.routine);
    fillList('hacks-list', state.plan.hacks);
    renderSwaps();
    renderImpact();
  }
  function fillList(id, items) {
    var ul = $(id); ul.innerHTML = '';
    items.forEach(function (t) {
      var li = document.createElement('li'); li.textContent = t; ul.appendChild(li);
    });
  }
  function renderSwaps() {
    var box = $('swaps-list'); box.innerHTML = '';
    state.plan.swaps.forEach(function (s, i) {
      var row = document.createElement('label');
      row.className = 'swap';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.adopted.indexOf(s.action) >= 0;
      cb.addEventListener('change', function () {
        if (cb.checked) state.adopted.push(s.action);
        else state.adopted = state.adopted.filter(function (a) { return a !== s.action; });
        saveJSON('airsaathi.adopted', state.adopted);
        renderImpact();
      });
      var body = document.createElement('div');
      var head = document.createElement('div');
      head.innerHTML = '<strong></strong>' +
        (s.saving ? ' <span class="saving">&asymp;' + s.saving.toLocaleString() + ' g CO&#8322;e/week</span>' : '');
      head.querySelector('strong').textContent = s.action;
      var why = document.createElement('p');
      why.className = 'why'; why.textContent = s.why;
      body.appendChild(head); body.appendChild(why);
      row.appendChild(cb); row.appendChild(body);
      box.appendChild(row);
    });
  }
  function renderImpact() {
    if (!state.plan) return;
    var total = 0, adopted = 0, unquantified = 0;
    state.plan.swaps.forEach(function (s) {
      if (state.adopted.indexOf(s.action) < 0) return;
      adopted++;
      if (typeof s.saving === 'number') total += s.saving; else unquantified++;
    });
    $('impact-unit').style.display = '';
    if (adopted === 0) {
      $('impact-num').textContent = '0';
      $('impact-eq').textContent = 'Adopt a swap above to see the estimated weekly saving and what it means.';
      return;
    }
    if (total === 0 && unquantified === adopted) {
      $('impact-num').textContent = 'Not quantified';
      $('impact-unit').style.display = 'none';
      $('impact-eq').textContent = 'The swap(s) you adopted have no comparable sourced factor, so this prototype does not quote a number for them. They are still worthwhile.';
      return;
    }
    $('impact-num').textContent = total.toLocaleString();
    var km = Math.round(total / 155);
    $('impact-eq').textContent = 'That is roughly the CO2 from driving ' + km.toLocaleString() +
      ' km in a petrol car, avoided every week (estimate). Note: this is a climate (CO2e) estimate, not a measured reduction in the pollution you personally breathe.' +
      (unquantified > 0 ? ' ' + unquantified + ' adopted swap(s) have no sourced factor and are not counted here.' : '');
  }

  /* ---------- Assistant ---------- */
  function aiContext() {
    var c = state.current;
    return {
      place: state.place ? state.place.name + (state.place.admin ? ', ' + state.place.admin : '') : 'not set',
      aqi_now: c ? Math.round(c.us_aqi) : null,
      band: c ? Engine.aqiBand(c.us_aqi).label : null,
      pollutants_ug_m3: c ? {
        pm2_5: c.pm2_5, pm10: c.pm10, no2: c.nitrogen_dioxide,
        ozone: c.ozone, so2: c.sulphur_dioxide, co: c.carbon_monoxide
      } : null,
      next_12h_aqi: state.hourly.slice(0, 12).map(function (h) {
        return Engine.fmtHour(h.time) + ': ' + Math.round(h.aqi);
      }),
      /* Minimized: only the profile facts an answer actually needs. */
      profile: state.profile ? {
        sensitive_members: [
          state.profile.children ? 'young children' : null,
          state.profile.elderly ? 'elders (60+)' : null,
          state.profile.asthma ? 'asthma / respiratory condition' : null,
          state.profile.heart ? 'heart condition' : null
        ].filter(Boolean),
        has_n95_mask: !!state.profile.hasMask,
        has_hepa_purifier: !!state.profile.hasPurifier
      } : 'not provided'
    };
  }
  function addMsg(kind, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text;
    $('chat-log').appendChild(div);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
    return div;
  }
  $('chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('chat-text').value.trim();
    if (!text) return;
    $('chat-text').value = '';
    addMsg('user', text);
    var thinking = addMsg('bot', 'Thinking...');
    $('chat-send').disabled = true;
    AI.chat(state.aiSettings, aiContext(), state.chat, text)
      .then(function (res) {
        thinking.remove();
        addMsg('bot', res.text);
        addMsg('meta', 'Answered by ' + res.provider + ', grounded in your live AQI and profile.');
        $('provider-line').textContent = 'Assistant backend: ' + res.provider + '.';
        state.chat.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
        state.chat = state.chat.slice(-8);
      })
      .catch(function (err) {
        thinking.remove();
        addMsg('bot', err.message +
          ' The dashboard, plan and impact tracker keep working on live data meanwhile.');
      })
      .finally(function () { $('chat-send').disabled = false; });
  });

  /* ---------- Settings dialog ---------- */
  var dlg = $('settings');
  $('open-settings').addEventListener('click', function () {
    $('s-provider').value = state.aiSettings.provider || 'auto';
    $('s-key').value = state.aiSettings.geminiKey || '';
    $('s-model').value = state.aiSettings.geminiModel || 'gemini-2.5-flash';
    dlg.showModal();
  });
  $('settings-close').addEventListener('click', function () { dlg.close(); });
  $('settings-save').addEventListener('click', function () {
    state.aiSettings = {
      provider: $('s-provider').value,
      geminiKey: $('s-key').value.trim(),
      geminiModel: $('s-model').value.trim() || 'gemini-2.5-flash'
    };
    saveJSON('airsaathi.ai', state.aiSettings);
    dlg.close();
    $('provider-line').textContent = 'Assistant backend: ' +
      ({ auto: 'Auto - your key if set, then free Pollinations.ai, then on-device AI',
         pollinations: 'Pollinations.ai (free text API)',
         nano: 'Browser AI (Gemini Nano)',
         gemini: 'Google Gemini API (your key)' })[state.aiSettings.provider] + '.';
  });

  /* ---------- Boot ---------- */
  fillProfileForm(state.profile);
  /* ?city=Name deep link: geocode the first match and load it (used for demos/tests). */
  var cityParam = new URLSearchParams(location.search).get('city');
  if (cityParam) {
    fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' +
      encodeURIComponent(cityParam))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var p = data.results && data.results[0];
        if (p) selectPlace({ name: p.name, admin: p.admin1 || '', country: p.country || '',
                             lat: p.latitude, lon: p.longitude });
      });
  }
  var savedPlace = loadJSON('airsaathi.place', null);
  if (savedPlace) {
    state.place = savedPlace;
    $('city-input').value = savedPlace.name + (savedPlace.admin ? ', ' + savedPlace.admin : '');
    loadAir();
  }

  /* Test/demo hooks: ?scrollto=<section id> jumps straight to a section after load;
     ?hide=<section id> removes a section (used to capture inner sections headlessly). */
  var qsBoot = new URLSearchParams(location.search);
  var scrollTarget = qsBoot.get('scrollto');
  if (scrollTarget) {
    setTimeout(function () {
      var el = $(scrollTarget);
      if (el) el.scrollIntoView({ behavior: 'auto' });
    }, 900);
  }
  var hideTarget = qsBoot.get('hide');
  if (hideTarget) {
    var hel = $(hideTarget);
    if (hel) hel.style.display = 'none';
  }

  /* Bridge for globe.js: lets the 3D globe select places and read the shared state. */
  window.AirSaathi = {
    selectPlace: selectPlace,
    snapshot: function () { return { place: state.place, current: state.current, hourly: state.hourly }; }
  };
})();
