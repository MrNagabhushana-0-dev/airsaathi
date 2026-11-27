/* AirSaathi globe: dotted 3D Earth with a data-backed global AQI layer.
   - Land dots: world-atlas land-110m + d3-geo geoContains (one-time sampling)
   - AQI dots: ONE batched Open-Meteo request for a 24deg grid, cached 3 h in localStorage
   - Tap: raycast -> lat/lon -> one reverse-geocode + one AQI request via the app's selectPlace
   No per-frame network calls: fetches happen once (grid) or once per tap (point). */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { geoContains } from 'd3-geo';
import { feature } from 'topojson-client';

(function () {
  var wrap = document.getElementById('globe-wrap');
  var canvas = document.getElementById('globe-canvas');
  if (!wrap || !canvas || !window.WebGLRenderingContext) return;

  var BANDS = [
    { max: 50, color: 0x22c55e, css: '#22c55e', label: 'Good' },
    { max: 100, color: 0xeab308, css: '#eab308', label: 'Moderate' },
    { max: 150, color: 0xf97316, css: '#f97316', label: 'Unhealthy for sensitive groups' },
    { max: 200, color: 0xef4444, css: '#ef4444', label: 'Unhealthy' },
    { max: 300, color: 0xa855f7, css: '#a855f7', label: 'Very unhealthy' },
    { max: 1e9, color: 0xb91c1c, css: '#b91c1c', label: 'Hazardous' }
  ];
  function bandFor(aqi) {
    for (var i = 0; i < BANDS.length; i++) if (aqi <= BANDS[i].max) return BANDS[i];
    return BANDS[BANDS.length - 1];
  }

  function llToVec3(lat, lon, r) {
    var latR = lat * Math.PI / 180, lonR = lon * Math.PI / 180;
    var rad = r * Math.cos(latR);
    return new THREE.Vector3(rad * Math.cos(lonR), r * Math.sin(latR), rad * Math.sin(lonR));
  }
  function vec3ToLL(p) {
    return { lat: Math.atan2(p.y, Math.hypot(p.x, p.z)) * 180 / Math.PI, lon: Math.atan2(p.z, p.x) * 180 / Math.PI };
  }

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  } catch (e) { wrap.style.display = 'none'; return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  /* Round soft sprite for all point layers (squares without a texture) */
  function makeDotTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }
  var dotTex = makeDotTexture();

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.15, 3.9);

  var stage = new THREE.Group();
  scene.add(stage);

  var controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.45;
  controls.minDistance = 1.5;
  controls.maxDistance = 4.2;
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotate = !reducedMotion;
  controls.autoRotateSpeed = 0.55;
  controls.addEventListener('start', function () { controls.autoRotate = false; });

  var globe = new THREE.Group();
  globe.rotation.y = (78 - 90) * Math.PI / 180; /* face India on load */
  stage.add(globe);

  /* Base sphere + fresnel atmosphere */
  var baseSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0x0a1626 })
  );
  globe.add(baseSphere);

  var atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.18, 64, 64),
    new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal);' +
        ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec3 vN; void main(){' +
        ' float i = pow(0.62 - dot(vN, vec3(0.0, 0.0, 1.0)), 2.4);' +
        ' gl_FragColor = vec4(0.35, 0.65, 1.0, 1.0) * i; }',
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false
    })
  );
  stage.add(atmo);

  /* Stars */
  (function () {
    var n = 800, pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var v = new THREE.Vector3().randomDirection().multiplyScalar(26 + Math.random() * 30);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x9db4d0, size: 0.07, sizeAttenuation: true, transparent: true, opacity: 0.65,
      depthWrite: false
    })));
  })();

  /* Land dots */
  fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json')
    .then(function (r) { return r.json(); })
    .then(function (topo) {
      var land = feature(topo, topo.objects.land);
      var SAMPLES = 20000, kept = [];
      var ga = Math.PI * (3 - Math.sqrt(5));
      for (var i = 0; i < SAMPLES; i++) {
        var y = 1 - (i / (SAMPLES - 1)) * 2;
        var rad = Math.sqrt(Math.max(0, 1 - y * y));
        var th = ga * i;
        var x = Math.cos(th) * rad, z = Math.sin(th) * rad;
        var lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1)) * 180 / Math.PI;
        var lon = Math.atan2(z, x) * 180 / Math.PI;
        if (geoContains(land, [lon, lat])) kept.push(x * 1.002, y * 1.002, z * 1.002);
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(kept), 3));
      globe.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: 0x9fd4ef, size: 0.013, sizeAttenuation: true, map: dotTex,
        alphaTest: 0.28, transparent: true, opacity: 0.95
      })));
    })
    .catch(function () { /* base sphere alone still works */ });

  /* Selection marker */
  var marker = new THREE.Group();
  var ring = new THREE.Mesh(
    new THREE.RingGeometry(0.028, 0.042, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
  );
  var dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x2dd4bf })
  );
  marker.add(ring); marker.add(dot);
  marker.visible = false;
  globe.add(marker);

  function setMarker(lat, lon) {
    var p = llToVec3(lat, lon, 1.01);
    marker.position.copy(p);
    marker.lookAt(p.clone().multiplyScalar(2));
    marker.visible = true;
  }

  /* Camera fly-to */
  var tween = null;
  function flyTo(lat, lon) {
    var dir = globe.localToWorld(llToVec3(lat, lon, 1)).normalize();
    var end = dir.multiplyScalar(2.25);
    tween = { t0: performance.now(), dur: reducedMotion ? 0 : 900, from: camera.position.clone(), to: end };
    controls.autoRotate = false;
  }
  function stepTween(now) {
    if (!tween) return;
    var k = tween.dur === 0 ? 1 : Math.min(1, (now - tween.t0) / tween.dur);
    var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(tween.from, tween.to, e);
    if (k >= 1) tween = null;
  }

  /* Global AQI dot layer: one batched request, cached 3 hours */
  var legendTime = document.getElementById('legend-time');
  function buildAqiLayer(values) {
    var pos = [], col = [];
    values.forEach(function (v) {
      if (typeof v.aqi !== 'number') return;
      var p = llToVec3(v.lat, v.lon, 1.018);
      var c = new THREE.Color(bandFor(v.aqi).color);
      pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b);
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    globe.add(new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.028, sizeAttenuation: true, vertexColors: true, map: dotTex,
      transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending
    })));
  }
  function loadAqiLayer() {
    var KEY = 'airsaathi.globeAqi.v1';
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (cached && Date.now() - cached.t < 3 * 3600 * 1000 && cached.values && cached.values.length) {
      buildAqiLayer(cached.values);
      if (legendTime) legendTime.textContent = cached.modelTime ? cached.modelTime + ' UTC' : 'cached snapshot';
      return;
    }
    var lats = [], lons = [];
    for (var la = -72; la <= 72; la += 24) {
      for (var lo = -180; lo < 180; lo += 24) { lats.push(la); lons.push(lo); }
    }
    var url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lats.join(',') +
      '&longitude=' + lons.join(',') + '&current=us_aqi&timezone=GMT';
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('aqi ' + r.status); return r.json(); })
      .then(function (data) {
        var arr = Array.isArray(data) ? data : [data];
        var modelTime = arr[0] && arr[0].current && arr[0].current.time ? arr[0].current.time : null;
        var values = arr.map(function (d, i) {
          return { lat: lats[i], lon: lons[i], aqi: d && d.current ? d.current.us_aqi : null };
        });
        try { localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), modelTime: modelTime, values: values })); } catch (e) {}
        buildAqiLayer(values);
        if (legendTime) legendTime.textContent = modelTime ? modelTime + ' UTC' : 'live snapshot';
      })
      .catch(function () {
        if (legendTime) legendTime.textContent = 'dot layer unavailable - tap the globe for a live point reading';
      });
  }
  loadAqiLayer();

  /* Tap vs drag */
  var pd = null;
  canvas.addEventListener('pointerdown', function (e) {
    pd = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointerup', function (e) {
    if (!pd) return;
    var moved = Math.hypot(e.clientX - pd.x, e.clientY - pd.y);
    var dt = performance.now() - pd.t;
    pd = null;
    if (moved < 7 && dt < 500) handleTap(e);
  });

  var raycaster = new THREE.Raycaster();
  var skipNextFly = false;
  function handleTap(e) {
    var rect = canvas.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    var hit = raycaster.intersectObject(baseSphere, false)[0];
    if (!hit) return;
    var local = globe.worldToLocal(hit.point.clone());
    var ll = vec3ToLL(local);
    setMarker(ll.lat, ll.lon);
    flyTo(ll.lat, ll.lon);
    selectFromGlobe(ll.lat, ll.lon);
  }

  var geoTimer = null;
  function selectFromGlobe(lat, lon) {
    clearTimeout(geoTimer);
    geoTimer = setTimeout(function () {
      fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat.toFixed(4) +
            '&longitude=' + lon.toFixed(4) + '&localityLanguage=en')
        .then(function (r) { return r.json(); })
        .then(function (g) {
          var name = g.city || g.locality || g.principalSubdivision || g.countryName || 'Open ocean';
          var admin = (name === g.principalSubdivision || name === g.countryName) ? '' : (g.principalSubdivision || '');
          var country = (name === g.countryName) ? '' : (g.countryName || '');
          skipNextFly = true;
          if (window.AirSaathi && window.AirSaathi.selectPlace) {
            window.AirSaathi.selectPlace({ name: name, admin: admin, country: country, lat: lat, lon: lon });
          }
        })
        .catch(function () {
          skipNextFly = true;
          if (window.AirSaathi && window.AirSaathi.selectPlace) {
            window.AirSaathi.selectPlace({ name: 'Dropped pin', admin: '', country: '', lat: lat, lon: lon });
          }
        });
    }, 120);
  }

  /* Panel */
  var panel = document.getElementById('globe-panel');
  var $ = function (id) { return document.getElementById(id); };
  document.addEventListener('airsaathi:place', function (ev) {
    var p = ev.detail;
    if (!p) return;
    setMarker(p.lat, p.lon);
    if (skipNextFly) { skipNextFly = false; } else { flyTo(p.lat, p.lon); }
    panel.classList.remove('hidden');
    $('gp-place').textContent = p.name + (p.admin ? ', ' + p.admin : '') + (p.country ? ', ' + p.country : '');
    $('gp-coords').textContent = Math.abs(p.lat).toFixed(2) + (p.lat >= 0 ? '°N' : '°S') + ', ' +
      Math.abs(p.lon).toFixed(2) + (p.lon >= 0 ? '°E' : '°W');
    $('gp-aqi').textContent = '--';
    $('gp-band').textContent = 'loading';
    $('gp-band').style.background = '#475569';
    $('gp-pm25').textContent = '--';
    $('gp-time').textContent = '';
  });
  document.addEventListener('airsaathi:air', function (ev) {
    var d = ev.detail;
    if (!d || !d.current) return;
    var aqi = Math.round(d.current.us_aqi);
    var band = bandFor(aqi);
    $('gp-aqi').textContent = aqi;
    $('gp-aqi').style.color = band.css;
    $('gp-band').textContent = band.label;
    $('gp-band').style.background = band.css;
    $('gp-pm25').textContent = typeof d.current.pm2_5 === 'number' ? d.current.pm2_5.toFixed(1) : '--';
    $('gp-time').textContent = d.current.time ? 'Model value · ' + d.current.time.replace('T', ' ') + ' local' : '';
  });
  $('gp-close').addEventListener('click', function () { panel.classList.add('hidden'); });
  $('gp-goto-dash').addEventListener('click', function () {
    document.getElementById('dashboard').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
  });
  $('gp-ask').addEventListener('click', function () {
    document.getElementById('assistant').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
    var t = document.getElementById('chat-text');
    if (t) setTimeout(function () { t.focus(); }, reducedMotion ? 0 : 600);
  });

  /* On mobile the panel is a fixed bottom sheet: hide it once the hero scrolls away. */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      panel.classList.toggle('gp-away', !entries[0].isIntersecting);
    }, { threshold: 0.05 }).observe(document.getElementById('globe-hero'));
  }

  /* Restore the saved place (search/geo selections dispatch the event themselves) */
  if (window.AirSaathi && window.AirSaathi.snapshot) {
    var snap = window.AirSaathi.snapshot();
    if (snap && snap.place) {
      setMarker(snap.place.lat, snap.place.lon);
    }
  }

  /* Test hooks (also used by the demo capture): ?tap=lat,lon runs the post-raycast
     selection path; ?tapxy=fx,fy dispatches real pointer events at a canvas fraction,
     exercising the full tap -> raycast -> geocode -> AQI -> panel path. */
  var qs = new URLSearchParams(location.search);
  var tapLL = (qs.get('tap') || '').split(',').map(Number);
  if (tapLL.length === 2 && isFinite(tapLL[0]) && isFinite(tapLL[1])) {
    setTimeout(function () { setMarker(tapLL[0], tapLL[1]); flyTo(tapLL[0], tapLL[1]); selectFromGlobe(tapLL[0], tapLL[1]); }, 1200);
  }
  var tapXY = (qs.get('tapxy') || '').split(',').map(Number);
  if (tapXY.length === 2 && isFinite(tapXY[0]) && isFinite(tapXY[1])) {
    setTimeout(function () {
      var r = canvas.getBoundingClientRect();
      var cx = r.left + r.width * tapXY[0], cy = r.top + r.height * tapXY[1];
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true }));
    }, 1500);
  }

  /* Resize + render loop */
  function resize() {
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (w < 760) { stage.position.x = 0; } else { stage.position.x = 0.62; }
  }
  window.addEventListener('resize', resize);
  resize();

  var clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    var t = clock.getElapsedTime();
    if (marker.visible) {
      var s = 1 + 0.18 * Math.sin(t * 3.2);
      ring.scale.set(s, s, s);
    }
    stepTween(performance.now());
    controls.update();
    renderer.render(scene, camera);
  })();
})();
