/* =========================================================================
   main.js — bootstrap with quality toggle, IndexedDB persistence,
             racing wiring, and 120 Hz detection.
   ========================================================================= */
'use strict';

(function () {

  /* ------------------------- boot guard ------------------------------
     index.html loads several plain <script> files in order. If one of
     those requests is dropped (a keep-alive socket being reset by the
     dev server used to do this), the browser can run main.js without a
     dependency such as `Drone` or `SimAudio`, producing a blank page.
     Check every dependency first and reload any missing file once with a
     cache-busted URL before starting the app. -------------------------- */
  const DEPENDENCIES = [
    { name: 'THREE',    src: 'vendor/three.min.js', ready: () => window.THREE && window.THREE.WebGLRenderer },
    { name: 'CFG',      src: 'js/config.js',        ready: () => !!window.CFG },
    { name: 'SimAudio', src: 'js/audio.js',         ready: () => window.SimAudio && typeof window.SimAudio.update === 'function' },
    { name: 'World',    src: 'js/world.js',         ready: () => !!window.World },
    { name: 'Drone',    src: 'js/physics.js',       ready: () => typeof window.Drone === 'function' },
    { name: 'Input',    src: 'js/input.js',         ready: () => !!window.Input },
    { name: 'HUD',      src: 'js/hud.js',           ready: () => !!window.HUD }
  ];

  function missingDependencies() {
    return DEPENDENCIES.filter(function (dep) {
      try { return !dep.ready(); } catch (err) { return true; }
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve) {
      const el = document.createElement('script');
      /* Cache-bust so a truncated cached response is not reused. */
      el.src = src + (src.indexOf('?') === -1 ? '?' : '&') + 'retry=' + Date.now();
      el.async = false;
      el.onload = function () { resolve(); };
      el.onerror = function () { resolve(); };
      document.head.appendChild(el);
    });
  }

  let bootRetries = 0;

  function startWhenReady() {
    const missing = missingDependencies();
    if (!missing.length) { boot(); return; }
    if (bootRetries >= 5) {
      console.error('FPV: unable to load ' + missing.map(function (dep) {
        return dep.name;
      }).join(', '));
      return;
    }
    bootRetries += 1;
    setTimeout(function () {
      /* Reload in dependency order so THREE is in place before the
         modules that use it are re-executed. */
      (function next(i) {
        if (i >= missing.length) { startWhenReady(); return; }
        loadScript(missing[i].src).then(function () { next(i + 1); });
      })(0);
    }, 150 * bootRetries);
  }

  function boot() {

  const canvas = document.getElementById('scene');
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
  const dpr = window.devicePixelRatio || 1;

  /* ---------------------- quality presets ---------------------------- */
  const QUALITY = {
    LOW:  { dpr: 1.0 },
    MED:  { dpr: 1.5 },
    HIGH: { dpr: 2.0 }
  };
  let qualityName = isMobile ? 'MED' : 'HIGH';

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !isMobile,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(dpr, QUALITY[qualityName].dpr));

  function setDPRCap(cap) {
    const next = Math.min(window.devicePixelRatio || 1, cap);
    if (Math.abs(next - renderer.getPixelRatio()) > 0.01) {
      renderer.setPixelRatio(next);
    }
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(100, 1, 0.08, 2000);

  /* --------------------------- world --------------------------------- */
  function disposeWorldObjects(w) {
    if (!w) return;
    try {
      if (w.root && w.root.parent) scene.remove(w.root);
    } catch(e){}
    try {
      if (w.sky && w.sky.parent) scene.remove(w.sky);
    } catch(e){}
    try {
      if (w.sun && w.sun.parent) scene.remove(w.sun);
    } catch(e){}
    try {
      if (w.hemi && w.hemi.parent) scene.remove(w.hemi);
    } catch(e){}
    try {
      if (w.fill && w.fill.parent) scene.remove(w.fill);
    } catch(e){}
    try {
      if (typeof w.dispose === 'function') w.dispose();
    } catch(e){}
  }

  let world = World.build(scene);
  /* Environment-preset refs */
  let envSun    = world.sun    || null;
  let envHemi   = world.hemi   || null;
  let envFill   = world.fill   || null;
  let envSkyMat = (world.skyMat || (world.sky && world.sky.material)) || null;

  /* --------------------------- drone --------------------------------- */
  const drone = new window.Drone();
  drone.colliders = world.colliders;

  function setFloorFromWorld(w) {
    drone.getFloorY = function (x, z) {
      const h = w.heightAt(x, z);
      return (isFinite(h) ? h : 0) + CFG.groundY;
    };
  }
  setFloorFromWorld(world);
  drone.reset(world.spawn.x, world.spawn.z);

  /* Build the visible drone model (follows physics state each frame). */
  if (window.DroneVisual) DroneVisual.build(scene);
/* Initialize ghost trail */
if (window.GhostTrail) GhostTrail.init(scene);
/* Initialize replay */
if (window.Replay) Replay.init(scene);

  /* Debug globals — accessible from Safari Web Inspector */
  window.__scene = scene;
  window.__drone = drone;
  window.__world = world;

  /* Multiplayer scene hook — MP needs a reference to the main scene
     so it can spawn remote DroneVisual instances into it. */
  if (window.MP) MP.init(scene);

  /* --------------------------- loadout preview ------------ */
  /* A second small WebGLRenderer lazily initialised when the LOADOUT
     tab opens. Renders a rotating preview of the current loadout in a
     small dedicated canvas, using a second DroneVisual instance. Zero
     cost during flight (only renders when panel is open on LOADOUT). */
  const settingsPanelEl = document.getElementById('settings-panel');
  let previewRenderer = null;
  let previewScene    = null;
  let previewCamera   = null;
  let previewVisual   = null;
  const previewDrone = {
    position: new THREE.Vector3(),
    quat:     new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    armed:    true,
    crashed:  false
  };
  const previewIdleState = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };

  function initPreview() {
    if (previewRenderer) return;
    const canvas = document.getElementById('loadout-preview-canvas');
    if (!canvas) return;
    try {
      previewRenderer = new THREE.WebGLRenderer({
        canvas: canvas, antialias: true, alpha: true,
        powerPreference: 'low-power'
      });
      previewRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      previewRenderer.setClearColor(0x000000, 0);
    } catch (e) {
      console.warn('[preview] renderer init failed:', e && e.message);
      previewRenderer = null;
      return;
    }
    previewScene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight(0xdcefff, 0x3a5030, 1.10);
    previewScene.add(hemi);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.20);
    keyLight.position.set(2, 3, 2);
    previewScene.add(keyLight);
    const fill = new THREE.DirectionalLight(0xa0c0e0, 0.40);
    fill.position.set(-2, 1, -2);
    previewScene.add(fill);
    previewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    previewVisual = window.DroneVisual ? DroneVisual.createInstance(previewScene) : null;
    if (previewVisual && window.Loadout) previewVisual.setLoadout(settings.loadout);
    console.log('[preview] initialized');
  }

  function renderPreview(dt) {
    if (!previewRenderer || !previewScene || !previewVisual) return;
    const canvas = previewRenderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const sz = previewRenderer.getSize(new THREE.Vector2());
    if (Math.abs(sz.x - w) > 1 || Math.abs(sz.y - h) > 1) {
      previewRenderer.setSize(w, h, false);
      previewCamera.aspect = w / h;
      previewCamera.updateProjectionMatrix();
    }
    previewVisual.update(previewDrone, previewIdleState, dt || 0.016);

    /* Compute camera distance so the drone fills ~70% of the smaller
       canvas dimension. Derived from the actual drone prop envelope
       (~0.19 m radius at frame scale 1.0) so the tinywhoop doesn't end
       up a speck and the 7" doesn't overflow. */
    const _frame = (window.PARTS && PARTS.FRAMES)
      ? PARTS.FRAMES[settings.loadout.frame]
      : null;
    const _fScale = (_frame && typeof _frame.scale === 'number') ? _frame.scale : 1.0;
    const _droneRadius = 0.19 * _fScale;
    const _fovHalf = (previewCamera.fov * Math.PI / 180) * 0.5;
    const _dist = _droneRadius / (0.70 * Math.tan(_fovHalf));

    const t = performance.now() * 0.0004;
    const _elev = Math.PI * 0.28;          /* ~50 deg above horizon */
    const _horiz = Math.cos(_elev) * _dist;
    const _vert  = Math.sin(_elev) * _dist;
    previewCamera.position.set(
      Math.sin(t) * _horiz,
      _vert,
      Math.cos(t) * _horiz
    );
    previewCamera.lookAt(0, 0.02, 0);
    previewRenderer.render(previewScene, previewCamera);
  }

  /* --------------------------- input / hud / racing ------------------ */
  Input.init();
  HUD.init();

  /* --------------------------- camera rig ---------------------------- */
  const _camTiltAxis = new THREE.Vector3(1, 0, 0);
  let camTilt = new THREE.Quaternion().setFromAxisAngle(
    _camTiltAxis, CFG.camera.tiltDeg * Math.PI / 180);
  function setCamTilt(deg) {
    camTilt.setFromAxisAngle(_camTiltAxis, deg * Math.PI / 180);
  }
  const _shakeQ = new THREE.Quaternion();
  const _shakeE = new THREE.Euler();
  const camOffsetLocal = new THREE.Vector3(0, 0.06, 0);
  const tmpV = new THREE.Vector3();

  /* --------------------------- resizing ------------------------------ */
  function viewportSize() {
    const vv = window.visualViewport;
    return { w: vv ? vv.width : window.innerWidth,
             h: vv ? vv.height : window.innerHeight };
  }
  function resize() {
    const sz = viewportSize();
    const w = sz.w, h = sz.h;
    renderer.setSize(w, h, false);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    camera.aspect = w / h;
    const hfov = CFG.camera.fovH * Math.PI / 180;
    let vfov = 2 * Math.atan(Math.tan(hfov / 2) / camera.aspect) * 180 / Math.PI;
    if (vfov > 112) vfov = 112;
    if (vfov < 58) vfov = 58;
    camera.fov = vfov;
    camera.updateProjectionMatrix();
    Input.resize();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));
if (window.HUD && HUD.resizeStickHUD) window.addEventListener('resize', HUD.resizeStickHUD);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
  resize();

  /* --------------------------- FPS overlay --------------------------- */
  const fpsEl = document.createElement('div');
  fpsEl.id = 'fps-counter';
  fpsEl.textContent = '— FPS';
  document.body.appendChild(fpsEl);

  const fpsSamples = [];
  let fpsDisplay = 60;
  let fpsUpdateTimer = 0;
  let fpsLowTimer = 0;

  /* 120 Hz detection — measures how fast rAF actually fires */
  let displayHz = 60;
  let _rafStart = performance.now();
  let _rafCount = 0;

  function updateFPS(dt) {
    fpsSamples.push(1 / Math.max(dt, 0.001));
    if (fpsSamples.length > 30) fpsSamples.shift();
    fpsDisplay = 0;
    for (let i = 0; i < fpsSamples.length; i++) fpsDisplay += fpsSamples[i];
    fpsDisplay /= fpsSamples.length;

    _rafCount++;
    const now = performance.now();
    if (now - _rafStart > 1500) {
      displayHz = Math.round(_rafCount * 1000 / (now - _rafStart));
      _rafCount = 0;
      _rafStart = now;
    }

    fpsUpdateTimer += dt;
    if (fpsUpdateTimer >= 0.25) {
      fpsUpdateTimer = 0;
      const dc = renderer.info.render.calls;
      const tri = renderer.info.render.triangles;
      const triStr = tri > 1000 ? Math.round(tri / 1000) + 'k' : String(tri);
      fpsEl.textContent =
        Math.round(fpsDisplay) + ' FPS · ' + dc + ' dc · ' + triStr + ' tri · ' +
        displayHz + ' Hz';
      fpsEl.classList.remove('warn', 'bad');
      if (fpsDisplay < 30) fpsEl.classList.add('bad');
      else if (fpsDisplay < 50) fpsEl.classList.add('warn');
    }

    /* auto-degrade DPR if FPS stays below 45 */
    if (fpsDisplay < 45 && renderer.getPixelRatio() > 0.75) {
      fpsLowTimer += dt;
      if (fpsLowTimer > 2.0) {
        fpsLowTimer = 0;
        setDPRCap(Math.max(0.75, renderer.getPixelRatio() - 0.15));
      }
    } else {
      fpsLowTimer = 0;
    }
  }

  /* --------------------------- game state ---------------------------- */
  let flightTime = 0;
  let crashShown = false;
  let lastTime = performance.now();

  const btnArm = document.getElementById('btn-arm');
  const btnSpring = document.getElementById('btn-spring');
  const btnSound = document.getElementById('btn-sound');
  const btnMap = document.getElementById('btn-map');
  const mapInput = document.getElementById('map-file');
  const btnUnloadMap = document.getElementById('btn-unload-map');
  const btnGfx = document.getElementById('btn-gfx');

  function updateArmButton() {
    btnArm.textContent = drone.armed ? 'DISARM' : 'ARM';
    btnArm.classList.toggle('on', drone.armed);
  }
  function toggleArm() {
    if (drone.crashed) return;
    if (window.SimAudio) SimAudio.resume();
    drone.toggleArm();
    if (window.SimAudio) SimAudio.armBeep(drone.armed);
    if (drone.armed) flightTime = 0;
    updateArmButton();
  }
  function respawn() {
    if (window.SimAudio) SimAudio.resume();
    drone.reset(world.spawn.x, world.spawn.z);
    flightTime = 0;
    crashShown = false;
    HUD.showCrash(false);
    updateArmButton();
    /* Stop recording/preview on respawn */
    if (window.Replay) {
        if (Replay.isRecording()) Replay.stopRecording();
        if (Replay.isPreviewing()) Replay.stopPreview();
        refreshReplayUI();
    }
    chaseInit = false;
  }

  btnArm.addEventListener('click', toggleArm);
  document.getElementById('btn-reset').addEventListener('click', respawn);
  document.getElementById('btn-respawn').addEventListener('click', respawn);

  btnSpring.addEventListener('click', () => {
    Input.throttleSpring = !Input.throttleSpring;
    Input.left.springY = Input.throttleSpring;
    btnSpring.textContent = Input.throttleSpring ? 'THR: SPRING' : 'THR: HOLD';
    btnSpring.classList.toggle('on', Input.throttleSpring);
  });

  btnSound.addEventListener('click', () => {
    if (window.SimAudio) SimAudio.resume();
    const next = window.SimAudio ? !SimAudio.isMuted() : true;
    if (window.SimAudio) SimAudio.setMuted(next);
    btnSound.textContent = next ? 'SND: OFF' : 'SND: ON';
    btnSound.classList.toggle('off', next);
    btnSound.classList.toggle('on', !next);
  });
  btnSound.classList.add('on');
  
  /* ---- Replay panel ---- */
  var btnReplay = document.getElementById('btn-replay');
  var replayPanel = document.getElementById('replay-panel');
  var rpStatus = document.getElementById('rp-status');
  var rpRecord = document.getElementById('rp-record');
  var rpPreview = document.getElementById('rp-preview');
  var rpExport = document.getElementById('rp-export');
  var rpImport = document.getElementById('rp-import');
  var rpClear = document.getElementById('rp-clear');
  var rpClose = document.getElementById('rp-close');
  var rpFile = document.getElementById('rp-file');
  var rpList = document.getElementById('rp-list');
  var rpLibraryCount = document.getElementById('rp-library-count');
  var replayLibrarySeq = 0;

  function fmtReplayTime(sec) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function fmtReplayDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function rpActionButton(label, act, extraClass) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'rp-act' + (extraClass ? ' ' + extraClass : '');
    b.setAttribute('data-act', act);
    b.textContent = label;
    return b;
  }

  /* Rendering the library hits IndexedDB, so it is only called when the
     panel opens or the library actually changes — never from the
     200 ms recording/preview repaint. */
  function refreshReplayLibrary() {
    if (!rpList || !window.Replay || !Replay.listLibrary) return;
    var seq = ++replayLibrarySeq;
    Replay.listLibrary().then(function (items) {
      if (seq !== replayLibrarySeq || !rpList) return;
      items = items || [];
      if (rpLibraryCount) {
        rpLibraryCount.textContent = items.length ? String(items.length) : '';
      }
      rpList.textContent = '';

      if (!items.length) {
        var empty = document.createElement('div');
        empty.className = 'rp-empty';
        empty.textContent = 'No saved replays yet.';
        rpList.appendChild(empty);
        return;
      }

      var currentId = (Replay.getState && Replay.getState().id) || null;
      items.forEach(function (rec) {
        var item = document.createElement('div');
        item.className = 'rp-item' + (rec.id === currentId ? ' active' : '');
        item.setAttribute('data-id', rec.id);

        var name = document.createElement('div');
        name.className = 'rp-item-name';
        name.textContent = rec.name || 'Untitled';
        name.title = rec.name || '';

        var meta = document.createElement('div');
        meta.className = 'rp-item-meta';
        var bits = [fmtReplayTime(rec.duration)];
        if (rec.frameCount) bits.push(rec.frameCount + ' frames');
        if (rec.createdAt) bits.push(fmtReplayDate(rec.createdAt));
        meta.textContent = bits.join('  \u00b7  ');

        var acts = document.createElement('div');
        acts.className = 'rp-item-acts';
        acts.appendChild(rpActionButton('PLAY', 'play', 'play'));
        acts.appendChild(rpActionButton('RENAME', 'rename'));
        acts.appendChild(rpActionButton('EXPORT', 'export'));
        acts.appendChild(rpActionButton('DELETE', 'delete', 'del'));

        item.appendChild(name);
        item.appendChild(meta);
        item.appendChild(acts);
        rpList.appendChild(item);
      });
    }).catch(function (err) {
      console.warn('Replay library refresh failed:', err);
    });
  }

  function refreshReplayUI() {
    if (!replayPanel || !rpStatus) return;
    var st = (window.Replay && Replay.getState) ? Replay.getState()
      : { recording: false, previewing: false, hasData: false, duration: 0, time: 0 };

    rpStatus.classList.toggle('recording', st.recording);
    rpStatus.classList.toggle('previewing', st.previewing);
    document.documentElement.classList.toggle('replay-preview', st.previewing);
    if (st.recording) {
      rpStatus.textContent = 'REC ' + fmtReplayTime(st.duration);
    } else if (st.previewing) {
      rpStatus.textContent = 'PREVIEW ' + fmtReplayTime(st.time) + ' / ' + fmtReplayTime(st.duration);
    } else if (st.hasData) {
      rpStatus.textContent = 'READY \u00b7 ' + fmtReplayTime(st.duration);
    } else {
      rpStatus.textContent = 'NO RECORDING';
    }
    rpStatus.title = st.name || '';

    if (rpRecord) {
      rpRecord.textContent = st.recording ? 'STOP RECORDING' : 'RECORD';
      rpRecord.classList.toggle('on', st.recording);
    }
    if (rpPreview) {
      rpPreview.textContent = st.previewing ? 'STOP PREVIEW' : 'PREVIEW';
      rpPreview.classList.toggle('on', st.previewing);
      rpPreview.disabled = (!st.hasData || st.recording) && !st.previewing;
    }
    if (rpExport) rpExport.disabled = !st.hasData || st.recording;
    if (rpClear) rpClear.disabled = !st.hasData && !st.recording;
    if (rpImport) rpImport.disabled = st.recording || st.previewing;

    if (btnReplay) {
      btnReplay.textContent = st.recording ? 'STOP REC' : (st.previewing ? 'STOP' : 'REPLAY');
      btnReplay.classList.toggle('on', st.recording || st.previewing);
    }
  }

  function openReplayPanel() {
    if (!replayPanel) return;
    replayPanel.classList.remove('hidden');
    refreshReplayUI();
    refreshReplayLibrary();
  }
  function closeReplayPanel() {
    if (replayPanel) replayPanel.classList.add('hidden');
  }

  if (window.Replay) {
    Replay.setOnChange(refreshReplayUI);
    if (Replay.setLibraryChanged) Replay.setLibraryChanged(refreshReplayLibrary);
  }

  if (btnReplay) {
    btnReplay.addEventListener('click', function () {
      if (!window.Replay) return;
      if (Replay.isRecording()) {
        Replay.stopRecording();
        openReplayPanel();
      } else if (Replay.isPreviewing()) {
        Replay.stopPreview();
        openReplayPanel();
      } else {
        openReplayPanel();
      }
      refreshReplayUI();
    });
  }

  if (rpRecord) {
    rpRecord.addEventListener('click', function () {
      if (!window.Replay) return;
      if (Replay.isRecording()) {
        Replay.stopRecording();
        refreshReplayUI();
      } else if (Replay.startRecording()) {
        closeReplayPanel();
      }
    });
  }

  if (rpPreview) {
    rpPreview.addEventListener('click', function () {
      if (!window.Replay) return;
      if (Replay.isPreviewing()) {
        Replay.stopPreview();
        refreshReplayUI();
      } else if (Replay.startPreview()) {
        closeReplayPanel();
      }
    });
  }

  if (rpExport) {
    rpExport.addEventListener('click', function () {
      if (window.Replay) Replay.exportFile();
    });
  }

  if (rpImport) {
    rpImport.addEventListener('click', function () {
      if (rpFile) rpFile.click();
    });
  }

  if (rpFile) {
    rpFile.addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file || !window.Replay) return;
      Replay.importFile(file).then(function () {
        refreshReplayUI();
        refreshReplayLibrary();
        rpStatus.textContent = 'IMPORTED \u00b7 ' + fmtReplayTime(Replay.getDuration());
      }).catch(function (err) {
        console.error('Replay import failed:', err);
        rpStatus.textContent = 'IMPORT FAILED';
      });
    });
  }

  if (rpClear) {
    rpClear.addEventListener('click', function () {
      if (window.Replay) Replay.clear();
      refreshReplayUI();
      refreshReplayLibrary();
    });
  }

  /* Local library — one delegated handler for every row action. */
  if (rpList) {
    rpList.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.rp-act') : null;
      if (!btn) return;
      var item = btn.closest ? btn.closest('.rp-item') : null;
      if (!item || !window.Replay) return;
      var id = item.getAttribute('data-id');
      var act = btn.getAttribute('data-act');
      if (!id) return;

      if (act === 'play') {
        Replay.loadFromLibrary(id).then(function () {
          Replay.startPreview();
          closeReplayPanel();
          refreshReplayUI();
        }).catch(function (err) {
          console.error('Replay load failed:', err);
          rpStatus.textContent = 'LOAD FAILED';
        });
        return;
      }

      if (act === 'rename') {
        var nameEl = item.querySelector('.rp-item-name');
        var current = nameEl ? nameEl.textContent : '';
        var next = window.prompt('Rename replay', current);
        if (next == null) return;
        next = String(next).trim();
        if (!next || next === current) return;
        Replay.renameInLibrary(id, next).then(function () {
          refreshReplayUI();
        }).catch(function (err) {
          console.error('Replay rename failed:', err);
        });
        return;
      }

      if (act === 'export') {
        Replay.exportFromLibrary(id).catch(function (err) {
          console.error('Replay export failed:', err);
        });
        return;
      }

      if (act === 'delete') {
        var nEl = item.querySelector('.rp-item-name');
        var label = nEl ? nEl.textContent : 'this replay';
        if (!window.confirm('Delete "' + label + '" from local replays?')) return;
        Replay.deleteFromLibrary(id).then(function () {
          refreshReplayUI();
        }).catch(function (err) {
          console.error('Replay delete failed:', err);
        });
      }
    });
  }

  if (rpClose) rpClose.addEventListener('click', closeReplayPanel);
  if (replayPanel) {
    replayPanel.addEventListener('click', function (ev) {
      if (ev.target === replayPanel) closeReplayPanel();
    });
  }

  refreshReplayUI();


  /* -------------------- quality toggle ------------------- */
  const gfxOrder = ['LOW', 'MED', 'HIGH'];
  function applyQuality(name) {
    qualityName = name;
    setDPRCap(QUALITY[name].dpr);
    document.body.classList.toggle('gfx-low', name === 'LOW');
    if (btnGfx) {
      btnGfx.textContent = 'GFX: ' + name;
      btnGfx.classList.remove('on', 'off');
      btnGfx.classList.add(name === 'HIGH' ? 'on' : 'off');
    }
  }
  applyQuality(qualityName);

  if (btnGfx) {
    btnGfx.addEventListener('click', () => {
      const i = gfxOrder.indexOf(qualityName);
      applyQuality(gfxOrder[(i + 1) % gfxOrder.length]);
    });
  }

  /* -------------------- IndexedDB map library ------------------- */
  const IDB_NAME = 'fpv-sim';
  const IDB_STORE = 'maps';
  const IDB_KEY_LAST = 'lastMap';
  const MAP_LIB_KEY = 'mapLibrary';

  function idbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, 2);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  async function idbGetMapLibrary() {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readonly');
          tx.objectStore(IDB_STORE).get(MAP_LIB_KEY).onsuccess = (ev) => {
            res((ev.target.result && ev.target.result.items) || []);
          };
        } catch (e) { rej(e); return; }
        tx.onerror = () => rej(tx.error || new Error('tx error'));
      });
    } catch (e) {
      return [];
    }
  }

  async function idbSaveMapLibrary(items) {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put({ items: items || [] }, MAP_LIB_KEY);
        } catch (e) { rej(e); return; }
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error || new Error('tx error'));
        tx.onabort = () => rej(tx.error || new Error('tx aborted'));
      });
    } catch (e) {
      return false;
    }
  }

  async function idbPutMapEntry(entry) {
    try {
      const items = await idbGetMapLibrary();
      const list = items.filter(i => i.id !== entry.id);
      list.unshift({
        id: entry.id,
        name: entry.name,
        size: entry.size,
        savedAt: entry.savedAt
      });
      let dataToStore = entry.data;
      if (entry.data && typeof entry.data.arrayBuffer === 'function') {
        try {
          dataToStore = await entry.data.arrayBuffer();
        } catch (e) {
          // fall through
        }
      }
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readwrite');
          const store = tx.objectStore(IDB_STORE);
          store.put(dataToStore, 'map:' + entry.id);
          store.put({ items: list }, MAP_LIB_KEY);
        } catch (e) { rej(e); return; }
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error || new Error('tx error'));
        tx.onabort = () => rej(tx.error || new Error('tx aborted'));
      });
    } catch (e) {
      return false;
    }
  }

  async function idbGetMapData(id) {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readonly');
          tx.objectStore(IDB_STORE).get('map:' + id).onsuccess = (ev) => res(ev.target.result || null);
        } catch (e) { rej(e); return; }
        tx.onerror = () => rej(tx.error || new Error('tx error'));
      });
    } catch (e) {
      return null;
    }
  }

  async function idbRemoveMap(id) {
    try {
      const db = await idbOpen();
      const items = await idbGetMapLibrary();
      const next = items.filter(i => i.id !== id);
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readwrite');
          const store = tx.objectStore(IDB_STORE);
          store.delete('map:' + id);
          store.put({ items: next }, MAP_LIB_KEY);
        } catch (e) { rej(e); return; }
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error || new Error('tx error'));
        tx.onabort = () => rej(tx.error || new Error('tx aborted'));
      });
    } catch (e) {
      return false;
    }
  }

  // Migration from old single-map storage
  async function migrateOldMap() {
    try {
      const db = await idbOpen();
      const old = await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readonly');
          tx.objectStore(IDB_STORE).get(IDB_KEY_LAST).onsuccess = (ev) => res(ev.target.result || null);
        } catch (e) { rej(e); return; }
        tx.onerror = () => rej(tx.error || new Error('tx error'));
      });
      if (old && old.data) {
        const lib = await idbGetMapLibrary();
        if (!lib.length) {
          const id = uid();
          await idbPutMapEntry({
            id: id,
            name: old.name || 'imported.glb',
            size: old.size || 0,
            savedAt: old.savedAt || Date.now(),
            data: old.data
          });
        }
        // Remove old key to avoid confusion
        try {
          const db2 = await idbOpen();
          const tx2 = db2.transaction(IDB_STORE, 'readwrite');
          tx2.objectStore(IDB_STORE).delete(IDB_KEY_LAST);
        } catch (e) {}
      }
    } catch (e) {}
  }

  migrateOldMap().catch(()=>{});

  /* -------------------- map loading ------------------- */
  let currentCustomMapId = null;

  function refreshMapBrowser() {
    var listEl = document.getElementById('map-list');
    if (!listEl) return;
    idbGetMapLibrary().then(function(items) {
      items = items || [];
      listEl.textContent = '';
      if (items.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'map-empty';
        empty.textContent = 'No saved maps.';
        listEl.appendChild(empty);
        return;
      }
      items.forEach(function(item) {
        var row = document.createElement('div');
        row.className = 'map-row' + (currentCustomMapId === item.id ? ' active' : '');
        var name = document.createElement('div');
        name.className = 'map-name';
        name.textContent = (item.name || 'map').replace(/\.[^.]+$/, '');
        name.title = item.name || '';
        var meta = document.createElement('div');
        meta.className = 'map-meta';
        if (item.savedAt) {
          try {
            var d = new Date(item.savedAt);
            meta.textContent = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
          } catch(e) { meta.textContent = ''; }
        }
        var acts = document.createElement('div');
        acts.className = 'map-acts';
        var loadBtn = document.createElement('button');
        loadBtn.className = 'map-act';
        loadBtn.textContent = 'LOAD';
        loadBtn.onclick = function(e) {
          e.stopPropagation();
          idbGetMapData(item.id).then(function(data) {
            if (!data) return;
            var blob;
            if (data instanceof ArrayBuffer) {
              blob = new Blob([data], { type: 'model/gltf-binary' });
            } else if (data instanceof Blob) {
              blob = data;
            } else if (data && data.buffer && data.byteLength) {
              blob = new Blob([data], { type: 'model/gltf-binary' });
            } else {
              blob = new Blob([data], { type: 'model/gltf-binary' });
            }
            var file = new File([blob], item.name || 'map.glb', { type: 'model/gltf-binary' });
            currentCustomMapId = item.id;
            loadMapFromFile(file, false);
            refreshMapBrowser();
          });
        };
        var delBtn = document.createElement('button');
        delBtn.className = 'map-act danger';
        delBtn.textContent = 'DELETE';
        delBtn.onclick = function(e) {
          e.stopPropagation();
          if (!window.confirm('Delete saved map "' + name.textContent + '"?')) return;
          if (currentCustomMapId === item.id && world && world.isCustomMap) {
            unloadCustomMap();
          }
          idbRemoveMap(item.id).then(function() {
            refreshMapBrowser();
          });
        };
        acts.appendChild(loadBtn);
        acts.appendChild(delBtn);
        row.appendChild(name);
        row.appendChild(meta);
        row.appendChild(acts);
        listEl.appendChild(row);
      });
    }).catch(function(){});
  }

  function unloadCustomMap() {
    if (!world || !world.isCustomMap) {
      if (btnUnloadMap) { btnUnloadMap.classList.remove('on'); btnUnloadMap.textContent = 'UNLOAD CUSTOM MAP'; }
      return;
    }
    disposeWorldObjects(world);
    world = World.build(scene);
    envSun = world.sun || null;
    envHemi = world.hemi || null;
    envFill = world.fill || null;
    envSkyMat = (world.skyMat || (world.sky && world.sky.material)) || null;
    setFloorFromWorld(world);
    window.__world = world;
    drone.colliders = world.colliders;
    drone.colliderIndex = world.colliderIndex || null;
    if (typeof drone._disposeBVH === 'function') drone._disposeBVH();
    drone._bvhColliderCount = -1;
    setDPRCap(QUALITY[qualityName].dpr);
    drone.reset(world.spawn.x, world.spawn.z);
    if (window.GhostTrail) GhostTrail.clear();
    flightTime = 0;
    crashShown = false;
    if (window.HUD) HUD.showCrash(false);
    updateArmButton();
    currentCustomMapId = null;
    if (btnMap) { btnMap.textContent = 'IMPORT MAP (.GLB/.GLTF)'; btnMap.classList.remove('on'); }
    if (btnUnloadMap) { btnUnloadMap.classList.remove('on'); btnUnloadMap.textContent = 'UNLOAD CUSTOM MAP'; }
    applyEnv(settings.env || 'DAY');
    refreshMapBrowser();
  }

  function loadMapFromFile(file, saveToIDB) {
    if (btnMap) { btnMap.textContent = 'LOADING…'; btnMap.classList.remove('off','on'); }

    MAP.load(file).then(result => {
      disposeWorldObjects(world);
      // Clear any remaining lights
      var lightsToRm = [];
      scene.traverse(function(o){ if (o.isLight) lightsToRm.push(o); });
      lightsToRm.forEach(function(l){ try { if(l.parent) l.parent.remove(l); } catch(e){} });
      scene.fog = null;
      scene.background = new THREE.Color(0x87a9c8);

      // Add simple lighting for custom maps
      const hemiLight = new THREE.HemisphereLight(0xdcefff, 0x3a5030, 1.4);
      scene.add(hemiLight);
      const dirLight = new THREE.DirectionalLight(0xfff2d6, 1.2);
      dirLight.position.set(150, 250, 100);
      scene.add(dirLight);

      scene.add(result.scene);

      const _loadedScene = result.scene;
      world = {
        root: _loadedScene,
        sky: null,
        gates: result.gates || [],
        colliders: result.colliders,
        colliderIndex: result.colliderIndex,
        heightAt: result.heightAt,
        ground: null,
        spawn: new THREE.Vector3(0, 0, 0),
        isCustomMap: true,
        sun: dirLight,
        hemi: hemiLight,
        dispose: function () {
          try { scene.remove(_loadedScene); } catch(e) {}
          try { if (hemiLight.parent) scene.remove(hemiLight); } catch(e){}
          try { if (dirLight.parent) scene.remove(dirLight); } catch(e){}
          _loadedScene.traverse(function (o) {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
              if (Array.isArray(o.material)) {
                o.material.forEach(function (m) { try { m.dispose(); } catch(e){} });
              } else {
                try { o.material.dispose(); } catch(e){}
              }
            }
          });
        }
      };
      envSun = dirLight;
      envHemi = hemiLight;
      envFill = null;
      envSkyMat = null;
      setFloorFromWorld(world);
      window.__world = world;
      drone.colliders = result.colliders;
      drone.colliderIndex = result.colliderIndex;
      if (typeof drone._disposeBVH === 'function') {
        drone._disposeBVH();
      }
      drone._bvhColliderCount = -1;
      applyEnv(settings.env || 'DAY');

      if (result.meshCount > 2000) setDPRCap(1.0);
      else if (result.meshCount > 800) setDPRCap(1.25);
      else setDPRCap(QUALITY[qualityName].dpr);

      drone.reset(0, 0);
      if (window.GhostTrail) GhostTrail.clear();
      flightTime = 0;
      crashShown = false;
      if (window.HUD) HUD.showCrash(false);
      updateArmButton();

      const label = (file.name || 'MAP').replace(/\.[^.]+$/, '').slice(0, 12);
      if (btnMap) { btnMap.textContent = 'MAP: ' + label; btnMap.classList.add('on'); }
      if (btnUnloadMap) { btnUnloadMap.classList.add('on'); btnUnloadMap.textContent = 'UNLOAD CUSTOM MAP'; }

      if (saveToIDB) {
        const id = uid();
        currentCustomMapId = id;
        try {
          idbPutMapEntry({
            id: id,
            name: file.name || 'map.glb',
            size: file.size || 0,
            savedAt: Date.now(),
            data: file
          }).then(function() { refreshMapBrowser(); }).catch(function(err) {
            console.warn('Map save failed:', err && err.message);
          });
        } catch(err) {
          console.warn('Map save failed:', err && err.message);
        }
      }
      refreshMapBrowser();

      var _sp = document.getElementById('settings-panel');
      if (_sp) _sp.classList.add('hidden');
      console.log('DPR ' + renderer.getPixelRatio().toFixed(2) +
                  ', ' + result.meshCount + ' meshes, ' +
                  result.colliders.length + ' colliders');
    }).catch(err => {
      console.error('Map load failed:', err);
      if (btnMap) {
        btnMap.textContent = 'LOAD FAILED';
        setTimeout(() => {
          btnMap.textContent = 'IMPORT MAP (.GLB/.GLTF)';
          btnMap.classList.remove('on');
        }, 2500);
      }
    });
  }

  if (btnMap) {
    btnMap.addEventListener('click', () => mapInput.click());
  }
  if (mapInput) {
    mapInput.addEventListener('change', ev => {
      const file = ev.target.files && ev.target.files[0];
      if (file) loadMapFromFile(file, true);
      mapInput.value = '';
    });
  }

  if (btnUnloadMap) {
    btnUnloadMap.addEventListener('click', unloadCustomMap);
  }

  refreshMapBrowser();

  Input.onArmToggle = toggleArm;
  Input.onReset = respawn;

  setTimeout(() => {
    const h = document.getElementById('help');
    if (h) h.classList.add('fade');
  }, 9000);
  document.getElementById('help-close').addEventListener('click', () => {
    document.getElementById('help').classList.add('fade');
  });

  updateArmButton();

  /* -------------------- settings panel ------------------- */
  const SETTINGS_KEY = 'fpv-settings-v1';
  const settings = {
    quality: qualityName,
    fpsCap: 0,
    fpsCounter: true,
    cameraMode: 'FPV',
    camTilt: 24,
    wind: 'CALM',
    shake: 'LOW',
    chaseDist: 'MID',
    tab: 'GENERAL',
    flightMode: 'ACRO',
    env: 'DAY',
    batteryMode: 'REAL',
    loadout: {
      frame:   'freestyle_5',
      motors:  'default_2207',
      props:   'default_5140',
      battery: 'default_6s_1300'
    },
    hud: {
      crosshair: true, mode: true, arm: true, batt: true,
      time: true, spd: true, alt: true, thr: true,
      ghostTrail: false
    }
  };
  let fpsCap = 0;

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        if (s.quality && QUALITY[s.quality]) settings.quality = s.quality;
        if (typeof s.fpsCap === 'number') settings.fpsCap = s.fpsCap;
        if (typeof s.fpsCounter === 'boolean') settings.fpsCounter = s.fpsCounter;
        if (typeof s.cameraMode === 'string'
            && ['FPV','TOW','CHASE','ORBIT'].indexOf(s.cameraMode) !== -1) {
          settings.cameraMode = s.cameraMode;
        }
        if (typeof s.camTilt === 'number' && s.camTilt >= 0 && s.camTilt <= 90) {
          settings.camTilt = s.camTilt;
        }
        if (typeof s.wind === 'string'
            && ['CALM','BREEZY','GUSTY'].indexOf(s.wind) !== -1) {
          settings.wind = s.wind;
        }
        if (typeof s.shake === 'string'
            && ['OFF','LOW','MED','HIGH'].indexOf(s.shake) !== -1) {
          settings.shake = s.shake;
        }
        if (typeof s.chaseDist === 'string'
            && ['NEAR','MID','FAR'].indexOf(s.chaseDist) !== -1) {
          settings.chaseDist = s.chaseDist;
        }
        if (typeof s.tab === 'string'
            && ['GENERAL','CAMERA','FLIGHT','LOADOUT','HUD'].indexOf(s.tab) !== -1) {
          settings.tab = s.tab;
        }
        var VALID_MODES = { ACRO:1, SLOW:1, SPORT:1, FAST:1 };
        if (typeof s.flightMode === 'string' && VALID_MODES[s.flightMode]) {
          settings.flightMode = s.flightMode;
        } else if (typeof s.easyMode === 'boolean') {
          /* Migration: old toggle → preset. */
          settings.flightMode = s.easyMode ? 'SPORT' : 'ACRO';
        }
        if (typeof s.env === 'string'
            && window.CFG && CFG.env && CFG.env[s.env]) {
          settings.env = s.env;
        }
        if (typeof s.batteryMode === 'string'
            && ['REAL','INFINITE'].indexOf(s.batteryMode) !== -1) {
          settings.batteryMode = s.batteryMode;
        }
        if (s.loadout && typeof s.loadout === 'object') {
          var P = window.PARTS || {};
          if (s.loadout.frame   && P.FRAMES  && P.FRAMES[s.loadout.frame])   settings.loadout.frame   = s.loadout.frame;
          if (s.loadout.motors  && P.MOTORS  && P.MOTORS[s.loadout.motors])  settings.loadout.motors  = s.loadout.motors;
          if (s.loadout.props   && P.PROPS   && P.PROPS[s.loadout.props])    settings.loadout.props   = s.loadout.props;
          if (s.loadout.battery && P.BATTERY && P.BATTERY[s.loadout.battery])settings.loadout.battery = s.loadout.battery;
        }
        if (s.hud && typeof s.hud === 'object') Object.assign(settings.hud, s.hud);
      }
    } catch (e) { /* ignore */ }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  const HUD_ELS = {
    crosshair: function () { return document.getElementById('crosshair'); },
    mode:  function () { return document.getElementById('osd-row-mode'); },
    arm:   function () { return document.getElementById('osd-row-arm'); },
    batt:  function () { return document.getElementById('osd-row-batt'); },
    time:  function () { return document.getElementById('osd-row-time'); },
    spd:   function () { return document.getElementById('osd-row-spd'); },
    alt:   function () { return document.getElementById('osd-row-alt'); },
    thr:   function () { return document.getElementById('osd-bc'); }
  };

  function applyHudVisibility() {
    for (const key in HUD_ELS) {
      const el = HUD_ELS[key]();
      if (!el) continue;
      el.classList.toggle('hud-off', !settings.hud[key]);
    }
    /* Collapse the telemetry panel when every row inside is hidden.
       Otherwise the panel's padding + border + backdrop stays visible
       as a ghost rectangle. */
    var tl = document.querySelector('.osd-tl');
    if (tl) {
      var anyVisible = tl.querySelector('.row:not(.hud-off)');
      tl.classList.toggle('hud-off', !anyVisible);
      /* Ghost trail visibility */
      if (window.GhostTrail) GhostTrail.setVisible(!!settings.hud.ghostTrail);
    }
  }
  function applyFpsCap() { fpsCap = settings.fpsCap; }
  function applyFpsCounter() {
    fpsEl.style.display = settings.fpsCounter ? '' : 'none';
  }
  function applyEasyMode() {
    var mode = settings.flightMode || 'ACRO';
    drone.flightMode = mode;
    drone.easyMode = (mode !== 'ACRO');
    const modeEl = document.getElementById('osd-mode');
    if (modeEl) {
      modeEl.textContent = (mode === 'ACRO') ? 'ACRO' : ('ANGLE ' + mode);
    }
  }
  let cameraMode = 'FPV';
  const chaseSmoothPos = new THREE.Vector3();
  let chaseInit = false;
  let replayVisualHidden = false;

  function applyCameraMode() {
    const prev = cameraMode;
    cameraMode = settings.cameraMode || 'FPV';
    if (prev !== cameraMode) chaseInit = false;
    if (window.DroneVisual && DroneVisual.setFPVMode) {
      DroneVisual.setFPVMode(cameraMode === 'FPV');
      if (window.Replay && Replay.isPreviewing()) DroneVisual.setVisible(false);
    }
    if (window.Replay && Replay.setFPVMode) {
      Replay.setFPVMode(cameraMode === 'FPV');
    }
  }
  function applyCamTilt() {
    setCamTilt(settings.camTilt);
  }
  function applyWind() {
    CFG.windPreset = settings.wind;
  }
  const SHAKE_LEVELS = { OFF: 0, LOW: 0.0003, MED: 0.0008, HIGH: 0.0015 };
  let shakeAmt = SHAKE_LEVELS.LOW;
  function applyShake() {
    shakeAmt = SHAKE_LEVELS[settings.shake] != null
      ? SHAKE_LEVELS[settings.shake]
      : SHAKE_LEVELS.LOW;
  }
  const CHASE_DIST = { NEAR: 0.5, MID: 1.0, FAR: 1.8 };
  let chaseDist = CHASE_DIST.MID;
  function applyChaseDist() {
    chaseDist = CHASE_DIST[settings.chaseDist] != null
      ? CHASE_DIST[settings.chaseDist]
      : CHASE_DIST.MID;
  }

  function applyBatteryMode() {
    CFG.infiniteBattery = (settings.batteryMode === 'INFINITE');
    if (CFG.infiniteBattery && window.__drone) {
      // Snap to fresh-pack state so the switch is visible immediately
      __drone.mahUsed = 0;
      __drone._smoothCurrent = 0;
      __drone.voltage = CFG.battery.cells * 4.20;
    }
  }

  function applyLoadout() {
    if (!window.Loadout) return;
    Loadout.apply(settings.loadout);
    if (previewVisual) previewVisual.setLoadout(settings.loadout);
    if (window.Replay && Replay.setLoadout) Replay.setLoadout(settings.loadout);
    saveSettings();
  }

  function applyEnv(name) {
    var envs = (window.CFG && CFG.env) ? CFG.env : null;
    if (!envs) return;
    var e = envs[name] || envs.DAY;
    if (!e) return;

    if (e.background != null) {
      scene.background = new THREE.Color(e.background);
    }
    if (e.fogColor != null) {
      if (!scene.fog) {
        scene.fog = new THREE.Fog(e.fogColor,
          (e.fogNear != null) ? e.fogNear : 140,
          (e.fogFar  != null) ? e.fogFar  : 580);
      } else {
        scene.fog.color.setHex(e.fogColor);
        if (e.fogNear != null) scene.fog.near = e.fogNear;
        if (e.fogFar  != null) scene.fog.far  = e.fogFar;
      }
    }
    if (envSun) {
      if (e.sunColor     != null) envSun.color.setHex(e.sunColor);
      if (e.sunIntensity != null) envSun.intensity = e.sunIntensity;
    }
    if (envHemi) {
      if (e.hemiSkyColor    != null) envHemi.color.setHex(e.hemiSkyColor);
      if (e.hemiGroundColor != null) envHemi.groundColor.setHex(e.hemiGroundColor);
      if (e.hemiIntensity   != null) envHemi.intensity = e.hemiIntensity;
    }
    if (envFill) {
      if (e.fillColor     != null) envFill.color.setHex(e.fillColor);
      if (e.fillIntensity != null) envFill.intensity = e.fillIntensity;
    }
    if (envSkyMat && envSkyMat.uniforms) {
      if (e.skyTop != null && envSkyMat.uniforms.uTop && envSkyMat.uniforms.uTop.value) {
        envSkyMat.uniforms.uTop.value.setHex(e.skyTop);
      }
      if (e.skyBot != null && envSkyMat.uniforms.uBot && envSkyMat.uniforms.uBot.value) {
        envSkyMat.uniforms.uBot.value.setHex(e.skyBot);
      }
    }
  }
  function applySettingsTab(name) {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    const valid = ['GENERAL','CAMERA','FLIGHT','LOADOUT','HUD'];
    const tabName = (valid.indexOf(name) !== -1) ? name : 'GENERAL';
    panel.querySelectorAll('.sp-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tabName);
    });
    panel.querySelectorAll('.sp-pane').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === tabName);
    });
    settings.tab = tabName;
    saveSettings();
  }
  function applyAllSettings() {
    applyQuality(settings.quality);
    applyFpsCap();
    applyFpsCounter();
    applyEasyMode();
    applyBatteryMode();
    applyLoadout();
    applyHudVisibility();
    applyCameraMode();
    applyCamTilt();
    applyWind();
    applyShake();
    applyChaseDist();
    applyEnv(settings.env || 'DAY');
  }

  function showDrillMetrics(m) {
  if (!m) return;
  var el = document.getElementById('drill-metrics');
  if (!el) return;
  var lines = [];
  if (m.name === 'HOVER') {
  lines.push('DRIFT RMS ' + m.driftRMS.toFixed(2) + 'm');
  lines.push('MAX ' + m.maxDrift.toFixed(2) + 'm');
  lines.push('THR \u03c3 ' + m.throttleStdDev.toFixed(3));
  } else if (m.name === 'LAND') {
  if (m.contactVSpeed !== null) lines.push('V-SPD ' + m.contactVSpeed.toFixed(2) + ' m/s');
  if (m.contactLSpeed !== null) lines.push('L-SPD ' + m.contactLSpeed.toFixed(2) + ' m/s');
  if (m.settleTime !== null) lines.push('SETTLE ' + m.settleTime.toFixed(2) + 's');
  } else if (m.name === 'EIGHT') {
  lines.push('PATH ' + m.pathLength.toFixed(1) + 'm');
  lines.push('MAX DEV ' + m.maxDeviation.toFixed(2) + 'm');
  lines.push('CROSS ' + m.crossings);
  } else if (m.name === 'ORBIT') {
  lines.push('R MEAN ' + m.radiusMean.toFixed(2) + 'm');
  lines.push('R \u03c3 ' + m.radiusStdDev.toFixed(2) + 'm');
  lines.push('DRIFT ' + m.driftRate.toFixed(3) + ' m/s');
  }
  el.textContent = m.name + ': ' + lines.join(' \u00b7 ');
  el.classList.remove('hidden', 'fade');
  setTimeout(function() { el.classList.add('fade'); }, 5000);
  }
  function buildSettingsPanel() {
    const panel = document.getElementById('settings-panel');
    if (!panel) { console.warn('settings-panel missing in HTML'); return; }

    panel.addEventListener('click', function (e) {
      if (e.target === panel) panel.classList.add('hidden');
    });
    var closeBtn = panel.querySelector('#sp-close');
    if (closeBtn) closeBtn.addEventListener('click', function () {
      panel.classList.add('hidden');
    });

    panel.querySelectorAll('.sp-group').forEach(function (group) {
      group.addEventListener('click', function (e) {
        var btn = e.target.closest('.sp-opt');
        if (!btn) return;
        var setting = group.getAttribute('data-setting');
        var val = btn.getAttribute('data-val');
        if (setting === 'quality') {
          settings.quality = val;
          applyQuality(val);
        } else if (setting === 'fpsCap') {
          settings.fpsCap = parseInt(val, 10);
          applyFpsCap();
        } else if (setting === 'fpsCounter') {
          settings.fpsCounter = (val === '1');
          applyFpsCounter();
        } else if (setting === 'flightMode') {
          settings.flightMode = val;
          applyEasyMode();
        } else if (setting === 'cameraMode') {
          settings.cameraMode = val;
          applyCameraMode();
        } else if (setting === 'camTilt') {
          settings.camTilt = parseInt(val, 10);
          applyCamTilt();
        } else if (setting === 'wind') {
          settings.wind = val;
          applyWind();
          if (window.SimAudio && SimAudio.resume) SimAudio.resume();
        } else if (setting === 'shake') {
          settings.shake = val;
          applyShake();
        } else if (setting === 'chaseDist') {
          settings.chaseDist = val;
          applyChaseDist();
        } else if (setting === 'env') {
          settings.env = val;
          applyEnv(val);
        } else if (setting === 'batteryMode') {
          settings.batteryMode = val;
          applyBatteryMode();
        } else if (setting === 'drill') {
        if (window.Drills) {
        if (val === 'none') Drills.end();
        else Drills.start(val, showDrillMetrics);
        }
        refreshSegmented();
        return;
        } else if (setting && setting.indexOf('loadout.') === 0) {
          var _loKey = setting.split('.')[1];
          if (settings.loadout && _loKey in settings.loadout) {
            settings.loadout[_loKey] = val;
            applyLoadout();
          }
        }
        saveSettings();
        refreshSegmented();
      });
    });

    panel.querySelectorAll('.sp-row[data-toggle]').forEach(function (row) {
      row.addEventListener('click', function () {
        var key = row.getAttribute('data-toggle');
        settings.hud[key] = !settings.hud[key];
        applyHudVisibility();
        saveSettings();
        refreshSegmented();
      });
    });

    function refreshSegmented() {
      panel.querySelectorAll('.sp-group').forEach(function (group) {
        var setting = group.getAttribute('data-setting');
        group.querySelectorAll('.sp-opt').forEach(function (btn) {
          var val = btn.getAttribute('data-val');
          var active = false;
          if (setting === 'quality') active = (val === settings.quality);
          else if (setting === 'fpsCap') active = (parseInt(val, 10) === settings.fpsCap);
          else if (setting === 'fpsCounter') active = ((val === '1') === settings.fpsCounter);
          else if (setting === 'flightMode') active = (val === settings.flightMode);
          else if (setting === 'cameraMode') active = (val === settings.cameraMode);
          else if (setting === 'camTilt') active = (parseInt(val, 10) === settings.camTilt);
          else if (setting === 'wind') active = (val === settings.wind);
          else if (setting === 'shake') active = (val === settings.shake);
          else if (setting === 'chaseDist') active = (val === settings.chaseDist);
          else if (setting === 'env') active = (val === settings.env);
          else if (setting === 'batteryMode') active = (val === settings.batteryMode);
          else if (setting === 'drill') active = (val === (window.Drills && Drills.isActive() ? Drills.getActiveName() : 'none'));
          else if (setting && setting.indexOf('loadout.') === 0) {
            var _sub = setting.split('.')[1];
            active = (settings.loadout && settings.loadout[_sub] === val);
          }
          btn.classList.toggle('active', active);
        });
      });
      panel.querySelectorAll('.sp-row[data-toggle]').forEach(function (row) {
        var key = row.getAttribute('data-toggle');
        row.classList.toggle('sp-on', !!settings.hud[key]);
      });
      updateLoadoutSummary();
    }

    function updateLoadoutSummary() {
      if (!window.Loadout) return;
      var e = Loadout.buildEffective(settings.loadout);
      if (!e) return;
      var massEl  = document.getElementById('lo-mass');
      var twEl    = document.getElementById('lo-tw');
      var rateEl  = document.getElementById('lo-rate');
      var cellsEl = document.getElementById('lo-cells');
      if (massEl)  massEl.textContent  = (e.mass * 1000).toFixed(0) + 'g';
      if (twEl)    twEl.textContent    = e.thrustToWeight.toFixed(2);
      if (rateEl)  rateEl.textContent  = Math.round(e.maxRates.roll) + '/s';
      if (cellsEl) cellsEl.textContent = e.battery.cells + 'S ' + e.battery.capacityMah + 'mAh';
    }

    panel.querySelectorAll('.sp-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        applySettingsTab(t.getAttribute('data-tab'));
      });
    });

    refreshSegmented();

    var btnSettings = document.getElementById('btn-settings');
    if (btnSettings) {
      btnSettings.addEventListener('click', function () {
        refreshSegmented();
        applySettingsTab(settings.tab || 'GENERAL');
        panel.classList.remove('hidden');
      });
    }
  }

  loadSettings();
  buildSettingsPanel();
  applyAllSettings();

  /* keep settings.quality in sync when GFX button cycles */
  if (btnGfx) {
    btnGfx.addEventListener('click', function () {
      settings.quality = qualityName;
      saveSettings();
    });
  }

  /* refresh map browser when settings panel opens */
  var btnSettings2 = document.getElementById('btn-settings');
  if (btnSettings2) {
    btnSettings2.addEventListener('click', function () {
      refreshMapBrowser();
    });
  }

  /* ==================== multiplayer UI + event wiring ================= */
  (function mpSetup() {
    var mpBtn = document.getElementById('btn-mp');
    var mpPanel = document.getElementById('mp-panel');
    if (!mpBtn || !mpPanel) return;

    fetch('./mp-status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.enabled) mpBtn.style.display = ''; })
      .catch(function () { /* no server — leave button hidden */ });

    function showConnect() {
      document.getElementById('mp-connect').style.display = '';
      document.getElementById('mp-inroom').style.display = 'none';
    }
    function showInRoom() {
      document.getElementById('mp-connect').style.display = 'none';
      document.getElementById('mp-inroom').style.display = '';
    }
    function setStatus(txt) {
      var el = document.getElementById('mp-status');
      if (el) el.textContent = txt || '';
    }

    /* --- live multiplayer HUD + transient notices --- */
    var mpHud = document.getElementById('mp-hud');
    var mpHudCount = document.getElementById('mp-hud-count');
    var mpHudPing = document.getElementById('mp-hud-ping');
    var toastRoot = document.getElementById('mp-toasts');

    function showToast(text, kind) {
      if (!toastRoot || !text) return;
      var el = document.createElement('div');
      el.className = 'mp-toast' + (kind ? ' ' + kind : '');
      el.textContent = text;
      toastRoot.appendChild(el);
      while (toastRoot.children.length > 4) toastRoot.removeChild(toastRoot.firstChild);
      setTimeout(function () { el.classList.add('out'); }, 2400);
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 2850);
    }

    function updateMpHud() {
      if (!mpHud) return;
      var on = !!(window.Net && Net.isConnected());
      mpHud.classList.toggle('hidden', !on);
      if (!on) return;

      var count = (window.Net && Net.getPlayerCount) ? Net.getPlayerCount() : 1;
      if (count < 1) count = 1;
      if (mpHudCount) {
        mpHudCount.textContent = count + (count === 1 ? ' PILOT' : ' PILOTS');
      }
      var rtt = (window.Net && Net.getLatency) ? Net.getLatency() : 0;
      if (mpHudPing) {
        mpHudPing.textContent = rtt > 0 ? Math.max(1, Math.round(rtt)) + 'ms' : '—';
        mpHudPing.className = 'mp-hud-ping' +
          (rtt > 0 ? (rtt > 140 ? ' bad' : (rtt > 70 ? ' warn' : ' good')) : '');
      }
    }
    setInterval(updateMpHud, 500);

    /* --- lobby roster model --- */
    var peerInfo = {};
    var currentHostPid = null;

    function playerRow(name, pid, isMe) {
      var row = document.createElement('div');
      row.className = 'mp-player' + (isMe ? ' me' : '') +
        (pid && pid === currentHostPid ? ' host' : '');
      row.id = 'mp-peer-' + (pid || 'self');

      var label = document.createElement('span');
      label.className = 'mp-player-name';
      label.textContent = name || pid || 'Pilot';
      row.appendChild(label);

      if (pid && pid === currentHostPid) {
        var host = document.createElement('span');
        host.className = 'mp-player-tag';
        host.textContent = 'HOST';
        row.appendChild(host);
      }
      if (isMe) {
        var you = document.createElement('span');
        you.className = 'mp-player-you';
        you.textContent = 'YOU';
        row.appendChild(you);
      }
      return row;
    }

    function renderPlayers() {
      var list = document.getElementById('mp-players');
      if (!list) return;
      list.textContent = '';
      var myPid = (window.Net && Net.getMyPid) ? Net.getMyPid() : null;
      list.appendChild(playerRow(myNickname, myPid, true));
      Object.keys(peerInfo).forEach(function (pid) {
        var o = peerInfo[pid] || {};
        list.appendChild(playerRow(o.nickname || pid, pid, false));
      });
    }

    var myNickname = localStorage.getItem('fpv-nickname') || ('Pilot_' + Math.floor(Math.random()*1000));
    var nickInput = document.getElementById('mp-nick-input');
    if (nickInput) {
      nickInput.value = myNickname;
      nickInput.addEventListener('change', function() {
        myNickname = this.value.trim() || 'Pilot';
        localStorage.setItem('fpv-nickname', myNickname);
        if (window.MP) MP.setLocalNickname(myNickname);
      });
    }
    if (window.MP) MP.setLocalNickname(myNickname);

    /* --- lobby visibility + public server browser --- */
    var visibility = 'public';
    var visibilityGroup = document.getElementById('mp-visibility');
    var visibilityHint = document.getElementById('mp-visibility-hint');
    var serverListEl = document.getElementById('mp-server-list');

    function setVisibility(value) {
      visibility = (value === 'private') ? 'private' : 'public';
      if (visibilityGroup) {
        var opts = visibilityGroup.querySelectorAll('.mp-opt');
        for (var i = 0; i < opts.length; i++) {
          opts[i].classList.toggle('active', opts[i].getAttribute('data-val') === visibility);
        }
      }
      if (visibilityHint) {
        visibilityHint.textContent = visibility === 'public'
          ? 'Listed in the server browser. Anyone can join.'
          : 'Hidden from the server browser. Join with the room code.';
      }
    }
    if (visibilityGroup) {
      visibilityGroup.addEventListener('click', function (e) {
        var val = e.target && e.target.getAttribute ? e.target.getAttribute('data-val') : null;
        if (val) setVisibility(val);
      });
    }
    setVisibility('public');

    function renderServers(rooms) {
      if (!serverListEl) return;
      serverListEl.textContent = '';
      if (!rooms || !rooms.length) {
        var empty = document.createElement('div');
        empty.className = 'mp-empty';
        empty.textContent = 'No public lobbies. Create one!';
        serverListEl.appendChild(empty);
        return;
      }
      rooms.forEach(function (room) {
        var row = document.createElement('div');
        row.className = 'mp-server';

        var info = document.createElement('div');
        info.className = 'mp-server-info';

        var name = document.createElement('div');
        name.className = 'mp-server-name';
        name.textContent = room.name || 'Lobby';

        var meta = document.createElement('div');
        meta.className = 'mp-server-meta';
        meta.textContent = (room.host || 'Pilot') + ' · ' +
          room.players + '/' + room.max + ' · ' + room.room +
          (room.map ? ' · MAP' : '');

        info.appendChild(name);
        info.appendChild(meta);

        var btn = document.createElement('button');
        btn.className = 'mp-btn';
        btn.textContent = room.full ? 'FULL' : 'JOIN';
        btn.disabled = !!room.full;
        btn.addEventListener('click', function () { joinRoom(room.room); });

        row.appendChild(info);
        row.appendChild(btn);
        serverListEl.appendChild(row);
      });
    }

    function refreshServers() {
      if (!window.Net || !Net.listServers) return;
      Net.listServers().then(renderServers).catch(function () {
        if (!serverListEl) return;
        serverListEl.textContent = '';
        var empty = document.createElement('div');
        empty.className = 'mp-empty';
        empty.textContent = 'Server list unavailable.';
        serverListEl.appendChild(empty);
      });
    }

    function copyText(text, okMessage) {
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          setStatus(okMessage);
        } catch (e) {
          setStatus('copy failed');
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          setStatus(okMessage);
        }).catch(fallback);
      } else {
        fallback();
      }
    }

    function inviteUrl() {
      var room = (window.Net && Net.getRoom) ? Net.getRoom() : '';
      if (!room) return '';
      return location.href.split('#')[0].split('?')[0] + '?room=' + room;
    }

    function joinRoom(code) {
      if (!window.Net) { setStatus('multiplayer unavailable'); return; }
      code = (code || '').trim().toUpperCase();
      if (!code) { setStatus('enter a room code'); return; }
      var nick = (document.getElementById('mp-nick-input').value || 'Pilot').trim();
      localStorage.setItem('fpv-nickname', nick);
      myNickname = nick;
      if (window.MP) MP.setLocalNickname(myNickname);
      setStatus('joining…');
      Net.join(code, settings.loadout, myNickname).catch(function (e) {
        setStatus('join failed: ' + (e.message || 'error'));
      });
    }

    var refreshBtn = document.getElementById('mp-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshServers);

    setInterval(function () {
      if (!mpPanel.classList.contains('hidden') && !(window.Net && Net.isConnected())) {
        refreshServers();
      }
    }, 5000);

    function amHost() {
      var myPid = (window.Net && Net.getMyPid) ? Net.getMyPid() : null;
      return !!(myPid && currentHostPid && myPid === currentHostPid);
    }

    function refreshHostUi() {
      var row = document.getElementById('mp-share-map-row');
      if (row) row.style.display = amHost() ? '' : 'none';
      renderPlayers();
    }

    function loadMapFromUrl(url) {
      setStatus('Downloading map...');
      fetch(url).then(function(r) {
        if (!r.ok) throw new Error('Map download failed');
        return r.blob();
      }).then(function(blob) {
        var file = new File([blob], 'shared-map.glb', { type: 'model/gltf-binary' });
        loadMapFromFile(file, false);
        setStatus('Map loaded!');
      }).catch(function(e) {
        console.error('Map load failed:', e);
        setStatus('Map load failed');
      });
    }

    mpBtn.addEventListener('click', function () {
      mpPanel.classList.remove('hidden');
      if (window.Net && Net.isConnected()) showInRoom();
      else { showConnect(); refreshServers(); }
    });
    document.getElementById('mp-close').addEventListener('click', function () {
      mpPanel.classList.add('hidden');
    });
    mpPanel.addEventListener('click', function (e) {
      if (e.target === mpPanel) mpPanel.classList.add('hidden');
    });

    /* Invite links: ?room=ABC123 pre-fills the join code and opens the
       lobby panel without silently joining (the pilot still presses JOIN). */
    (function handleInviteLink() {
      var invite = '';
      try {
        invite = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
      } catch (e) { /* old browser */ }
      if (!/^[A-Z0-9]{1,12}$/.test(invite)) return;
      var codeInput = document.getElementById('mp-code-input');
      if (codeInput) codeInput.value = invite;
      mpPanel.classList.remove('hidden');
      showConnect();
      refreshServers();
      setStatus('Invite code ' + invite + ' loaded — press JOIN');
    })();

    function handleRoom(msg) {
      currentHostPid = msg.host || ((window.Net && Net.getMyPid) ? Net.getMyPid() : null);

      // Rebuild the roster and remote visuals from the authoritative
      // snapshot. This also cleans up peers that left while we were
      // disconnected and reconnected.
      peerInfo = {};
      (msg.others || []).forEach(function (o) {
        if (o && o.pid) peerInfo[o.pid] = { nickname: o.nickname };
      });
      if (window.MP) {
        MP.clearAll();
        (msg.others || []).forEach(function (o) {
          MP.spawnRemote(o.pid, o.loadout, o.nickname);
        });
      }

      document.getElementById('mp-room-code').textContent = msg.room;
      var titleEl = document.getElementById('mp-lobby-title');
      if (titleEl) titleEl.textContent = msg.name || 'Lobby';
      var badge = document.getElementById('mp-visibility-badge');
      if (badge) {
        badge.textContent = msg.public ? 'PUBLIC' : 'PRIVATE';
        badge.className = 'mp-badge ' + (msg.public ? 'public' : 'private');
      }
      refreshHostUi();
      showInRoom();
      setStatus('');
      if (msg.map_url) loadMapFromUrl(msg.map_url);
      var b = document.getElementById('net-badge');
      if (b) b.classList.add('hidden');
      updateMpHud();
    }

    /* CREATE LOBBY */
    document.getElementById('mp-create').addEventListener('click', function () {
      if (!window.Net) { setStatus('multiplayer unavailable'); return; }
      var nick = (document.getElementById('mp-nick-input').value || 'Pilot').trim();
      localStorage.setItem('fpv-nickname', nick);
      myNickname = nick;
      if (window.MP) MP.setLocalNickname(myNickname);
      var lobbyName = (document.getElementById('mp-lobby-name').value || '').trim();
      setStatus('creating…');
      Net.create(settings.loadout, myNickname, {
        public: visibility === 'public',
        name: lobbyName
      }).catch(function (e) {
        setStatus('create failed: ' + (e.message || 'error'));
      });
    });

    /* JOIN ROOM (by code) */
    document.getElementById('mp-join').addEventListener('click', function () {
      joinRoom(document.getElementById('mp-code-input').value);
    });

    /* LEAVE ROOM */
    document.getElementById('mp-leave').addEventListener('click', function () {
      if (window.Net) Net.leave();
      if (window.MP) MP.clearAll();
      peerInfo = {};
      currentHostPid = null;
      var shareRow = document.getElementById('mp-share-map-row');
      if (shareRow) shareRow.style.display = 'none';
      showConnect();
      refreshServers();
      setStatus('left room');
      var b = document.getElementById('net-badge');
      if (b) b.classList.add('hidden');
      updateMpHud();
    });

    /* COPY ROOM CODE / INVITE LINK */
    var copyCodeBtn = document.getElementById('mp-copy-code');
    if (copyCodeBtn) {
      copyCodeBtn.addEventListener('click', function () {
        var room = (window.Net && Net.getRoom) ? Net.getRoom() : '';
        if (room) copyText(room, 'Room code copied');
      });
    }
    var copyInviteBtn = document.getElementById('mp-copy-invite');
    if (copyInviteBtn) {
      copyInviteBtn.addEventListener('click', function () {
        var url = inviteUrl();
        if (url) copyText(url, 'Invite link copied');
      });
    }

    /* Net event handlers */
    if (window.Net) {
      Net.on('created', handleRoom);
      Net.on('joined', handleRoom);

      Net.on('peer_join', function (msg) {
        if (msg.pid) peerInfo[msg.pid] = { nickname: msg.nickname || msg.pid };
        if (window.MP) MP.spawnRemote(msg.pid, msg.loadout, msg.nickname);
        renderPlayers();
        showToast((msg.nickname || 'Pilot') + ' joined', 'join');
        updateMpHud();
      });

      Net.on('peer_leave', function (msg) {
        var info = peerInfo[msg.pid];
        delete peerInfo[msg.pid];
        if (window.MP) MP.removeRemote(msg.pid);
        renderPlayers();
        showToast((info && info.nickname ? info.nickname : 'Pilot') + ' left', 'leave');
        updateMpHud();
      });

      Net.on('host_change', function (msg) {
        currentHostPid = msg.pid;
        refreshHostUi();
        var myPid = Net.getMyPid();
        if (msg.pid && msg.pid === myPid) {
          showToast('You are now the host', 'host');
        } else {
          var info = peerInfo[msg.pid];
          showToast(((info && info.nickname) || msg.nickname || 'Pilot') + ' is now the host', 'host');
        }
        updateMpHud();
      });

      Net.on('state', function (msg) {
        if (window.MP) MP.onState(msg);
      });

      Net.on('disconnected', function () {
        setStatus('Connection lost. Reconnecting...');
        var b = document.getElementById('net-badge');
        if (b) { b.className = 'net-badge reconnecting'; b.textContent = 'RECONNECTING...'; b.classList.remove('hidden'); }
        updateMpHud();
      });

      Net.on('reconnected', function () {
        var b = document.getElementById('net-badge');
        if (b) b.classList.add('hidden');
        setStatus('');
        showToast('Reconnected', 'good');
        updateMpHud();
      });

      Net.on('latency', updateMpHud);

      Net.on('error', function (msg) {
        if (msg && msg.msg) setStatus(msg.msg);
      });

      Net.on('room_lost', function () {
        if (window.MP) MP.clearAll();
        peerInfo = {};
        currentHostPid = null;
        var shareRow = document.getElementById('mp-share-map-row');
        if (shareRow) shareRow.style.display = 'none';
        showConnect();
        refreshServers();
        setStatus('Room closed. Disconnected.');
        var b = document.getElementById('net-badge');
        if (b) { b.className = 'net-badge'; b.textContent = 'ROOM LOST'; b.classList.remove('hidden'); }
        updateMpHud();
      });

      Net.on('map_change', function (msg) {
        if (msg.url) loadMapFromUrl(msg.url);
      });

      document.getElementById('mp-share-map').addEventListener('click', function () {
        document.getElementById('mp-map-file').click();
      });

      document.getElementById('mp-map-file').addEventListener('change', function (ev) {
        var file = ev.target.files[0];
        if (!file || !amHost()) return;
        var room = Net.getRoom();
        if (!room) return;
        setStatus('Uploading map...');
        Net.uploadMap(room, file).then(function() {
          setStatus('Map shared!');
          loadMapFromFile(file, false);
        }).catch(function(e) {
          console.error('Map upload failed:', e);
          setStatus('Upload failed');
        });
        ev.target.value = '';
      });
    }
  })();

  /* ============================ main loop ============================= */
  const PHYSICS_HZ = isMobile ? 120 : 240;
  const FIXED = 1 / PHYSICS_HZ;
  let accumulator = 0;

  function frame(now) {
    requestAnimationFrame(frame);

    if (fpsCap > 0) {
      const _el = now - lastTime;
      if (_el < (1000 / fpsCap) - 1.5) return;
    }

    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;

    const state = Input.update(dt);

    /* Freeze the live sim while a recording is being previewed; the
       replay drone is advanced by Replay.update() further down. */
    const previewWasActive = !!(window.Replay && Replay.isPreviewing());

    if (world.advanceFrame) world.advanceFrame();

    if (previewWasActive) {
      accumulator = 0;
    } else {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= FIXED && steps < 16) {
        drone.step(FIXED, state);
        accumulator -= FIXED;
        steps++;
      }
      if (steps >= 16) accumulator = 0;
    }

    if (!previewWasActive && drone.armed && !drone.crashed) flightTime += dt;
    /* Drills tick */
    if (!previewWasActive && window.Drills && Drills.isActive()) Drills.tick(drone, dt);

    /* Multiplayer — send our state at ~30 Hz (throttled inside Net),
       and advance remote drone interpolation. Zero cost when offline. */
    if (window.Net && Net.isConnected()) {
      Net.tick(dt);
      Net.sendState(drone);
    }
    if (window.MP) {
      MP.update(dt, camera);
      MP.updateLocal(drone, camera, cameraMode === 'FPV');
    }

    /* Replay: capture frames while recording, advance preview playback. */
    let replayPose = null;
    let replayStick = null;
    if (window.Replay) {
      Replay.record(drone, state, dt);
      if (Replay.isPreviewing()) Replay.update(dt);
      if (Replay.isPreviewing()) {
        replayPose = Replay.getPose();
        replayStick = Replay.getStickState();
      }
    }
    const replayActive = !!replayPose;

    /* Hide the live drone while previewing, restore normal visibility
       when preview ends. */
    if (replayActive !== replayVisualHidden) {
      replayVisualHidden = replayActive;
      chaseInit = false;
      if (window.DroneVisual && DroneVisual.setVisible) {
        DroneVisual.setVisible(replayActive ? false : (cameraMode !== 'FPV'));
      }
    }

    /* Camera/HUD/audio follow the replay drone while previewing. */
    const viewDrone = replayPose ? {
      position: replayPose.position,
      quat: replayPose.quat,
      velocity: { length: function () { return replayPose.speed; } },
      armed: true,
      crashed: false,
      voltage: drone.voltage,
      mahUsed: drone.mahUsed,
      _packDeadLatched: drone._packDeadLatched,
      _windTime: drone._windTime,
      throttleIn: replayPose.stick.throttle
    } : drone;

    /* Update drone visual to follow physics state */
    if (window.DroneVisual) DroneVisual.update(drone, state, dt);

    /* Camera — FPV / TOW / CHASE / ORBIT */
    if (cameraMode === 'FPV') {
      tmpV.copy(camOffsetLocal).applyQuaternion(viewDrone.quat);
      camera.position.copy(viewDrone.position).add(tmpV);
      camera.quaternion.copy(viewDrone.quat).multiply(camTilt);
    } else if (cameraMode === 'TOW') {
      /* Rigid stick-cam: 0.15 up / 0.35 back in drone local frame.
         Orientation = drone quaternion → rolls/pitches/yaws with drone,
         looks forward, drone appears in lower-center of view. */
      tmpV.set(0, 0.15, 0.35).applyQuaternion(viewDrone.quat);
      camera.position.copy(viewDrone.position).add(tmpV);
      camera.quaternion.copy(viewDrone.quat);
    } else if (cameraMode === 'CHASE') {
      /* Smoothed chase — position-only smoothing, dt-independent,
         always looks at the drone directly. */
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(viewDrone.quat);
      fwd.y = 0;
      if (fwd.lengthSq() < 0.01) fwd.set(0, 0, -1);
      fwd.normalize();
      const targetPos = new THREE.Vector3().copy(viewDrone.position)
        .addScaledVector(fwd, -chaseDist);
      targetPos.y += 0.4 + chaseDist * 0.15;
      if (!chaseInit) {
        chaseSmoothPos.copy(targetPos);
        chaseInit = true;
      } else {
        const k = 1 - Math.exp(-dt * 8);
        chaseSmoothPos.lerp(targetPos, k);
      }
      camera.position.copy(chaseSmoothPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(viewDrone.position);
    } else if (cameraMode === 'ORBIT') {
      const _t = performance.now() * 0.001;
      const _r = 1.6;
      const orbitPos = new THREE.Vector3(
        viewDrone.position.x + Math.cos(_t * 0.4) * _r,
        viewDrone.position.y + 0.6,
        viewDrone.position.z + Math.sin(_t * 0.4) * _r
      );
      const d = camera.position.distanceTo(orbitPos);
      const k = d > 5 ? 1.0 : (1 - Math.exp(-dt * 12));
      camera.position.lerp(orbitPos, k);
      camera.up.set(0, 1, 0);
      camera.lookAt(viewDrone.position);
    }

    /* Camera micro-shake — FPV + TOW only.
       Driven by drone._windTime phase through 3 summed sines per axis
       at motor-frequency (5.5–14 Hz). NO per-frame randomness — the
       previous Math.random() version was white noise, not vibration.
       Amplitude scales with throttle + speed; wind presets amplify.
       All three axes centred around zero, so no drift.
       TOW gets 0.7× because the camera stick damps the vibration. */
    if (!replayActive && (cameraMode === 'FPV' || cameraMode === 'TOW') && shakeAmt > 0) {
      const spd = drone.velocity.length();
      const thr = drone.throttleIn || 0;
      const modeMul = (cameraMode === 'TOW') ? 0.7 : 1.0;
      let shakeMag = shakeAmt * (0.5 + thr * 1.5 + spd * 0.02) * modeMul;
      if (settings.wind === 'GUSTY') shakeMag *= 1.6;
      else if (settings.wind === 'BREEZY') shakeMag *= 1.2;
      if (shakeMag > 0.00002) {
        const t = drone._windTime || 0;
        const motorHz = 5.5 + thr * 8.5;   // 5.5–14 Hz, safe at 60 fps
        const w = t * motorHz * Math.PI * 2;
        const px = Math.sin(w)                + Math.sin(w * 1.61 + 0.4) * 0.55;
        const py = Math.cos(w * 0.87 + 1.1)   + Math.sin(w * 1.37 + 2.3) * 0.50;
        const pz = Math.sin(w * 1.13 + 0.6)   * 0.6;
        _shakeE.set(px * shakeMag, py * shakeMag, pz * shakeMag);
        _shakeQ.setFromEuler(_shakeE);
        camera.quaternion.multiply(_shakeQ);
      }
    }

    if (world.sky) world.sky.position.copy(camera.position);
    if (world.ground) {
      const TILE = world.groundTile || 20;
      world.ground.position.x = Math.round(camera.position.x / TILE) * TILE;
      world.ground.position.z = Math.round(camera.position.z / TILE) * TILE;
    }

    const hudStick = replayStick || state;
    HUD.update(viewDrone, camera, flightTime, hudStick.throttle, hudStick);
    if (window.HUD && HUD.setStickOverride) HUD.setStickOverride(replayStick);

    /* Update ghost trail (only for the live drone) */
    if (!replayActive && window.GhostTrail) GhostTrail.update(drone);

    if (window.SimAudio && typeof SimAudio.update === 'function') {
      SimAudio.update(viewDrone, hudStick, camera);
    }

    /* Loadout preview — only when the settings panel is open and the
       LOADOUT tab is showing. initPreview() runs on first visit. */
    if (settingsPanelEl && !settingsPanelEl.classList.contains('hidden')
        && settings.tab === 'LOADOUT') {
      if (!previewRenderer) initPreview();
      if (previewRenderer) renderPreview(dt);
    }

    if (!replayActive && drone.crashed && !crashShown) {
      crashShown = true;
      if (window.SimAudio && SimAudio.crashSound) SimAudio.crashSound();
      HUD.showCrash(true);
      updateArmButton();
    }

    renderer.render(scene, camera);
    updateFPS(dt);
  }

  requestAnimationFrame(frame);

  } /* boot */

  startWhenReady();

})();
