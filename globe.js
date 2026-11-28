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
  } catch (e) {
    /* WebGL unavailable (old device, disabled GPU, corporate lockdown): keep the rest of
       the product usable and say so, instead of a blank hero. The note goes outside
       #globe-wrap because that element is aria-hidden. */
    wrap.style.display = 'none';
    var note = document.createElement('p');
    note.textContent = 'The 3D globe needs WebGL, which this browser has turned off. ' +
      'Everything else works: use the search box or "Use my location" above to pick a place.';
    note.style.cssText = 'max-width:340px;margin:24px 0;padding:14px 16px;border:1px solid #334155;' +
      'border-radius:12px;color:#cbd5e1;background:rgba(15,23,42,.8);font-size:14px;line-height:1.5;';
    wrap.parentNode.insertBefore(note, wrap.nextSibling);
    return;
  }
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
  controls.maxDistance = 8;
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotate = !reducedMotion;
  controls.autoRotateSpeed = 0.55;
  controls.addEventListener('start', function () { controls.autoRotate = false; });

  var globe = new THREE.Group();
  var INIT_ROT_Y = (78 - 90) * Math.PI / 180;
  globe.rotation.y = INIT_ROT_Y; /* face India on load */
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

  /* Land dots + coastlines, rebuilt 2026-11-28 v3 on user request for minute detail.
     Geometry source: GSHHG 2.3.7 (Wessel & Smith, SOEST/NOAA; LGPL v3+, license texts
     ship in this repo as GSHHG-LICENSE.TXT and GSHHG-COPYING.LESSERv3), native binary
     parsed offline: high-res level-1 land polygons (144,744) + full-res islands the
     high-res decimation dropped (35,088) + lakes/river-lakes (L2), islands-in-lakes
     (L3), ponds (L4), Antarctica ice-front (L5) - 188,206 polygons in total.
     GSHHG shorelines derive from World Vector Shorelines (nominal 1:250,000 scale;
     the Natural Earth set used before is nominal 1:10,000,000). Dots: 66,931 fibonacci
     samples on the GSHHG land mask + one guaranteed dot on every land polygon
     (181,595) = 248,526. Coastlines: a 1.36M-segment line mesh in 415 chunks,
     frustum-culled, faded in as the camera zooms. These are dataset geometries, not
     surveys; vertex counts and storage precision say nothing about positional
     accuracy. AQI colours come from the model grid (interpolated), never point
     measurements. */
  function buildLand(kept) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(kept), 3));
    var baseCol = new Float32Array(kept.length), bc = new THREE.Color(0x9fd4ef);
    for (var q = 0; q < kept.length; q += 3) { baseCol[q] = bc.r; baseCol[q + 1] = bc.g; baseCol[q + 2] = bc.b; }
    g.setAttribute('color', new THREE.BufferAttribute(baseCol, 3));
    landGeom = g;
    globe.add(new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.008, sizeAttenuation: true, map: dotTex, vertexColors: true,
      alphaTest: 0.28, transparent: true, opacity: 0.95
    })));
    applyField();
  }
  function gunzip(buf) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('no DecompressionStream'));
    return new Response(new Response(buf).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  function loadBakedDots() {
    return fetch('dots-gshhg.bin.gz')
      .then(function (r) { if (!r.ok) throw new Error('dots ' + r.status); return r.arrayBuffer(); })
      .then(gunzip)
      .then(function (buf) {
        var a = new Float32Array(buf), pts = new Float32Array(a.length / 2 * 3);
        for (var k = 0, o = 0; k < a.length; k += 2, o += 3) {
          var p = llToVec3(a[k], a[k + 1], 1.002);
          pts[o] = p.x; pts[o + 1] = p.y; pts[o + 2] = p.z;
        }
        return pts;
      });
  }
  /* Coastline line mesh: subtle neutral colour, AQI dots stay the colour channel.
     Opacity ramps with zoom (far 0.12 -> near 0.90), updated in the render loop. */
  var coastMats = [];
  function loadCoast() {
    return fetch('coast.bin.gz')
      .then(function (r) { if (!r.ok) throw new Error('coast ' + r.status); return r.arrayBuffer(); })
      .then(gunzip)
      .then(function (buf) {
        var dv = new DataView(buf);
        if (dv.getUint32(0, true) !== 0x31485347) return;
        var nChunks = dv.getUint16(6, true), off = 8;
        for (var c = 0; c < nChunks; c++) {
          var lon0 = dv.getFloat32(off, true), lat0 = dv.getFloat32(off + 4, true), nseg = dv.getUint32(off + 8, true);
          off += 12;
          var pos = new Float32Array(nseg * 2 * 3), o = 0;
          for (var s = 0; s < nseg * 2; s++) {
            var lon = lon0 + dv.getUint16(off, true) / 3600, lat = lat0 + dv.getUint16(off + 2, true) / 3600;
            off += 4;
            var p = llToVec3(lat, lon, 1.0035);
            pos[o++] = p.x; pos[o++] = p.y; pos[o++] = p.z;
          }
          var g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          g.computeBoundingSphere();
          var mat = new THREE.LineBasicMaterial({ color: 0x86c5e8, transparent: true, opacity: 0.12, depthWrite: false });
          coastMats.push(mat);
          globe.add(new THREE.LineSegments(g, mat));
        }
      }).catch(function () { /* coastlines optional; dots alone still carry the map */ });
  }


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

  /* Camera fly-to (position + optional globe rotation reset) */
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
    if (typeof tween.rotTo === 'number') {
      globe.rotation.y = tween.rotFrom + (tween.rotTo - tween.rotFrom) * e;
    }
    if (k >= 1) tween = null;
  }
  function resetView() {
    tween = {
      t0: performance.now(), dur: reducedMotion ? 0 : 900,
      from: camera.position.clone(), to: defaultCamPos(),
      rotFrom: globe.rotation.y, rotTo: INIT_ROT_Y
    };
    controls.autoRotate = !reducedMotion;
  }
  var resetBtn = document.getElementById('globe-reset');
  if (resetBtn) resetBtn.addEventListener('click', resetView);

  /* Global AQI dot layer: one batched HTTP request, cached 3 hours on this device.
     Quota note (Open-Meteo, per maintainer): each coordinate in a batch multiplies the
     API-call count, so this grid is ~105 calls against the visitor's own free-tier
     budget (10k/day, non-commercial) - about 1% per cold load, refreshed at most 8x/day. */
  var legendTime = document.getElementById('legend-time');
  var landGeom = null, gridValues = null;
  /* Colour each land dot from the real model grid: inverse-distance blend of the 3 nearest
     grid points (24 deg spacing), then the AQI band colour. This is an interpolation of model
     values, not a measurement at that dot - the legend says so; tap gives the exact point. */
  function applyField() {
    if (!landGeom || !gridValues) return;
    var pts = gridValues.filter(function (v) { return typeof v.aqi === 'number'; }).map(function (v) {
      var p = llToVec3(v.lat, v.lon, 1); return { x: p.x, y: p.y, z: p.z, aqi: v.aqi };
    });
    if (pts.length < 3) return;
    var pos = landGeom.getAttribute('position'), col = landGeom.getAttribute('color'), n = pos.count;
    for (var i = 0; i < n; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), l = Math.sqrt(x * x + y * y + z * z);
      x /= l; y /= l; z /= l;
      var b = [{ d: 9, a: 0 }, { d: 9, a: 0 }, { d: 9, a: 0 }];
      for (var j = 0; j < pts.length; j++) {
        var d = 1 - (x * pts[j].x + y * pts[j].y + z * pts[j].z);
        if (d < b[2].d) { b[2] = { d: d, a: pts[j].aqi }; if (b[2].d < b[1].d) { var t1 = b[1]; b[1] = b[2]; b[2] = t1; } if (b[1].d < b[0].d) { var t0 = b[0]; b[0] = b[1]; b[1] = t0; } }
      }
      var ws = 0, av = 0;
      for (var k = 0; k < 3; k++) { var w = 1 / (b[k].d + 0.002); ws += w; av += w * b[k].a; }
      var c = new THREE.Color(bandFor(av / ws).color);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }
  /* Dots + coastlines load async; buildLand runs applyField, and buildAqiLayer re-runs
     applyField when the grid arrives - whichever lands second colours the dots. */
  loadCoast();
  loadBakedDots().then(function (pts) { buildLand(pts); }).catch(function () {
    /* Fallback if the baked set fails to decode: runtime raster of 50m coastlines
       (110m behind that), dense sampling. */
    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json')
      .then(function (r) { if (!r.ok) throw new Error('land50 ' + r.status); return r.json(); })
      .catch(function () {
        return fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json')
          .then(function (r) { return r.json(); });
      })
      .then(function (topo) {
        var land = feature(topo, topo.objects.land);
        var SAMPLES = 240000, kept = [];
        var MW = 2880, MH = 1440, maskData = null;
        try {
          var mc = document.createElement('canvas'); mc.width = MW; mc.height = MH;
          var mx = mc.getContext('2d', { willReadFrequently: true });
          mx.fillStyle = '#fff';
          var geoms = land.type === 'FeatureCollection' ? land.features.map(function (f) { return f.geometry; }) : [land.geometry || land];
          geoms.forEach(function (gm) {
            var polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.type === 'MultiPolygon' ? gm.coordinates : [];
            polys.forEach(function (poly) {
              mx.beginPath();
              poly.forEach(function (ringc) {
                ringc.forEach(function (pt, k) {
                  var px = (pt[0] + 180) / 360 * MW, py = (90 - pt[1]) / 180 * MH;
                  if (k === 0) mx.moveTo(px, py); else mx.lineTo(px, py);
                });
                mx.closePath();
              });
              mx.fill('evenodd');
            });
          });
          maskData = mx.getImageData(0, 0, MW, MH).data;
        } catch (e) { maskData = null; }
        function isLand(lon, lat) {
          if (!maskData) return geoContains(land, [lon, lat]);
          var px = Math.min(MW - 1, Math.max(0, Math.floor((lon + 180) / 360 * MW)));
          var py = Math.min(MH - 1, Math.max(0, Math.floor((90 - lat) / 180 * MH)));
          return maskData[(py * MW + px) * 4 + 3] > 127;
        }
        var ga = Math.PI * (3 - Math.sqrt(5));
        for (var i = 0; i < SAMPLES; i++) {
          var y = 1 - (i / (SAMPLES - 1)) * 2;
          var rad = Math.sqrt(Math.max(0, 1 - y * y));
          var th = ga * i;
          var x = Math.cos(th) * rad, z = Math.sin(th) * rad;
          var lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1)) * 180 / Math.PI;
          var lon = Math.atan2(z, x) * 180 / Math.PI;
          if (isLand(lon, lat)) kept.push(x * 1.002, y * 1.002, z * 1.002);
        }
        buildLand(kept);
      })
      .catch(function () { /* base sphere alone still works */ });
  });

  function buildAqiLayer(values) {
    gridValues = values; applyField();
    var missing = values.filter(function (v) { return typeof v.aqi !== 'number'; }).length;
    if (missing) setTimeout(function () { if (legendTime) legendTime.textContent += ' - ' + missing + ' of ' + values.length + ' grid points had no model value'; }, 0);
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
      size: 0.05, sizeAttenuation: true, vertexColors: true, map: dotTex,
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
    /* Budget guard: each grid coordinate counts as one Open-Meteo call, so a device that keeps
       cold-loading (cache cleared, private tabs) stops after ~4 loads/day (~420 of the 10k/day free
       allowance, leaving room for taps) and shows the last snapshot, however old, instead. */
    var BKEY = 'airsaathi.gridLoads', day = new Date().toISOString().slice(0, 10), bud = null;
    try { bud = JSON.parse(localStorage.getItem(BKEY) || 'null'); } catch (e) {}
    if (!bud || bud.day !== day) bud = { day: day, n: 0 };
    if (bud.n >= 4) {
      if (cached && cached.values && cached.values.length) {
        buildAqiLayer(cached.values);
        if (legendTime) legendTime.textContent = (cached.modelTime ? cached.modelTime + ' UTC' : 'cached snapshot') + ' (daily refresh limit reached)';
      } else if (legendTime) legendTime.textContent = 'dot layer paused today to respect the free data limit - tap the globe for a point reading';
      return;
    }
    bud.n++;
    try { localStorage.setItem(BKEY, JSON.stringify(bud)); } catch (e) {}
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
        if (legendTime) legendTime.textContent = modelTime ? modelTime + ' UTC' : 'model snapshot';
      })
      .catch(function () {
        if (cached && cached.values && cached.values.length) {
          buildAqiLayer(cached.values);
          if (legendTime) legendTime.textContent = (cached.modelTime ? cached.modelTime + ' UTC' : 'cached snapshot') + ' (could not refresh)';
          return;
        }
        if (legendTime) legendTime.textContent = 'dot layer unavailable - tap the globe for a point reading';
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
    $('gp-time').textContent = d.current.time ? 'CAMS model hour · ' + d.current.time.replace('T', ' ') + ' (place local time)' : '';
  });
  document.addEventListener('airsaathi:air-error', function () {
    /* Never leave the panel stuck on "loading": mark the reading unavailable;
       the error box next to it carries the message and the Retry button. */
    $('gp-aqi').textContent = '--';
    $('gp-band').textContent = 'unavailable';
    $('gp-band').style.background = '#475569';
    $('gp-time').textContent = 'Could not load this reading - see the notice above for Retry.';
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

  /* Demo hook: drives the exact selection path a tap takes (used by the demo video). */
  window.AirSaathiDemo = {
    pickPlace: function (lat, lon) { setMarker(lat, lon); flyTo(lat, lon); selectFromGlobe(lat, lon); },
    reset: resetView,
    stopRender: function () { rafOn = false; }
  };

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
  function defaultCamPos() {
    var w = wrap.clientWidth, h = wrap.clientHeight;
    var aspect = (w && h) ? w / h : 1.6;
    if (w < 760) {
      var need = 1.18 / (Math.tan(camera.fov * Math.PI / 360) * aspect);
      return new THREE.Vector3(0, 0, Math.min(7.5, Math.max(4.6, need)));
    }
    return new THREE.Vector3(0, 0.15, 3.9);
  }
  function resize() {
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (w < 760) { stage.position.x = 0; stage.position.y = -0.75; } else { stage.position.x = 0.62; stage.position.y = 0; }
    camera.position.copy(defaultCamPos());
  }
  window.addEventListener('resize', resize);
  resize();
  camera.position.copy(defaultCamPos());

  var clock = new THREE.Clock();
  var rafOn = true;
  (function loop() {
    if (!rafOn) return;
    requestAnimationFrame(loop);
    var t = clock.getElapsedTime();
    if (marker.visible) {
      var s = 1 + 0.18 * Math.sin(t * 3.2);
      ring.scale.set(s, s, s);
    }
    stepTween(performance.now());
    if (coastMats.length) {
      var cd = camera.position.length();
      var zt = Math.min(1, Math.max(0, (3.9 - cd) / (3.9 - 1.5)));
      var op = 0.12 + 0.78 * zt;
      for (var cm = 0; cm < coastMats.length; cm++) coastMats[cm].opacity = op;
    }
    controls.update();
    renderer.render(scene, camera);
  })();
})();
