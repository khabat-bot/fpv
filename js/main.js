/* =========================================================================
   main.js — bootstrap with quality toggle, IndexedDB persistence,
             racing wiring, and 120 Hz detection.
   ========================================================================= */
'use strict';

(function () {

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
  let world = World.build(scene);
  /* Environment-preset refs — cached here so applyEnv() stays valid
     even after loadMapFromFile() replaces `world`. The scene lights
     survive map loads (they're added to scene, not to world.root),
     so mutating these objects keeps the env preset authoritative. */
  let envSun    = world.sun    || null;
  let envHemi   = world.hemi   || null;
  let envFill   = world.fill   || null;
  let envSkyMat = (world.skyMat || (world.sky && world.sky.material)) || null;

  /* --------------------------- drone --------------------------------- */
  const drone = new Drone();
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

  /* Debug globals — accessible from Safari Web Inspector */
  window.__scene = scene;
  window.__drone = drone;
  window.__world = world;

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
    previewVisual = DroneVisual.createInstance(previewScene);
    if (window.Loadout) previewVisual.setLoadout(settings.loadout);
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
  const btnResume = document.getElementById('btn-resume');
  const btnForget = document.getElementById('btn-forget');
  const btnGfx = document.getElementById('btn-gfx');

  function updateArmButton() {
    btnArm.textContent = drone.armed ? 'DISARM' : 'ARM';
    btnArm.classList.toggle('on', drone.armed);
  }
  function toggleArm() {
    if (drone.crashed) return;
    Audio.resume();
    drone.toggleArm();
    Audio.armBeep(drone.armed);
    if (drone.armed) flightTime = 0;
    updateArmButton();
  }
  function respawn() {
    Audio.resume();
    drone.reset(world.spawn.x, world.spawn.z);
    flightTime = 0;
    crashShown = false;
    HUD.showCrash(false);
    updateArmButton();
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
    Audio.resume();
    const next = !Audio.isMuted();
    Audio.setMuted(next);
    btnSound.textContent = next ? 'SND: OFF' : 'SND: ON';
    btnSound.classList.toggle('off', next);
    btnSound.classList.toggle('on', !next);
  });
  btnSound.classList.add('on');


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

  /* -------------------- IndexedDB persistence ------------------- */
  const IDB_NAME = 'fpv-sim';
  const IDB_STORE = 'maps';
  const IDB_KEY = 'lastMap';

  function idbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function idbSave(file) {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put({
            name: file.name, size: file.size,
            savedAt: Date.now(), data: file
          }, IDB_KEY);
        } catch (e) { rej(e); return; }
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error || new Error('tx error'));
        tx.onabort = () => rej(tx.error || new Error('tx aborted'));
      });
    } catch (e) {
      console.warn('IDB save failed (silent):', e && e.message || e);
      return false;
    }
  }

  async function idbLoad() {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readonly');
          tx.objectStore(IDB_STORE).get(IDB_KEY).onsuccess = (ev) => res(ev.target.result || null);
        } catch (e) { rej(e); return; }
        tx.onerror = () => rej(tx.error || new Error('tx error'));
      });
    } catch (e) {
      return null;
    }
  }

  async function idbForget() {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        let tx;
        try {
          tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(IDB_KEY);
        } catch (e) { rej(e); return; }
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error || new Error('tx error'));
      });
    } catch (e) {
      return false;
    }
  }

  idbLoad().then(saved => {
    if (saved && saved.data) {
      btnResume.style.display = '';
      btnResume.textContent = 'RESUME: ' + saved.name.replace(/\.[^.]+$/, '').slice(0, 10);
      btnResume.onclick = () => {
        const file = new File([saved.data], saved.name, { type: 'model/gltf-binary' });
        loadMapFromFile(file, false);
      };
    }
  }).catch(err => {
    console.warn('IDB load failed (silent):', err && err.message || err);
  });

  /* -------------------- map loading ------------------- */
  function loadMapFromFile(file, saveToIDB) {
    btnMap.textContent = 'LOADING…';
    btnMap.classList.remove('off', 'on');
    btnResume.style.display = 'none';

    MAP.load(file).then(result => {
      if (world.dispose) world.dispose();

      scene.background = new THREE.Color(0x87a9c8);
      scene.fog = new THREE.Fog(0x87a9c8, 200, 900);
      scene.add(result.scene);

      world = {
        root: result.scene,
        sky: null,
        gates: result.gates || [],
        colliders: result.colliders,
        colliderIndex: result.colliderIndex,
        heightAt: result.heightAt,
        ground: null,
        spawn: new THREE.Vector3(0, 0, 0),
        dispose: null
      };
      setFloorFromWorld(world);
      window.__world = world;
      drone.colliders = result.colliders;
      drone.colliderIndex = result.colliderIndex;
      /* Re-apply env preset so it overrides the forced background/fog
         set above — the preset is the source of truth for sky+lighting. */
      applyEnv(settings.env || 'DAY');

      /* re-evaluate DPR based on merged mesh count */
      if (result.meshCount > 2000) setDPRCap(1.0);
      else if (result.meshCount > 800) setDPRCap(1.25);
      else setDPRCap(QUALITY[qualityName].dpr);

      drone.reset(0, 0);
      flightTime = 0;
      crashShown = false;
      HUD.showCrash(false);
      updateArmButton();

      const label = (file.name || 'MAP').replace(/\.[^.]+$/, '').slice(0, 10);
      btnMap.textContent = 'MAP: ' + label;
      btnMap.classList.add('on');

      if (saveToIDB) {
        idbSave(file).then(ok => {
          if (ok) {
            btnForget.style.display = '';
            btnResume.style.display = 'none';
          }
        }).catch(err => {
          console.warn('IDB save rejected (silent):', err && err.message || err);
        });
      } else {
        btnForget.style.display = '';
      }

      var _sp = document.getElementById('settings-panel');
      if (_sp) _sp.classList.add('hidden');
      console.log('DPR ' + renderer.getPixelRatio().toFixed(2) +
                  ', ' + result.meshCount + ' meshes, ' +
                  result.colliders.length + ' colliders');
    }).catch(err => {
      console.error('Map load failed:', err);
      btnMap.textContent = 'LOAD FAILED';
      setTimeout(() => {
        btnMap.textContent = 'LOAD MAP';
        btnMap.classList.remove('on');
      }, 2500);
    });
  }

  btnMap.addEventListener('click', () => mapInput.click());
  mapInput.addEventListener('change', ev => {
    const file = ev.target.files && ev.target.files[0];
    if (file) loadMapFromFile(file, true);
    mapInput.value = '';
  });

  btnForget.addEventListener('click', () => {
    idbForget().then(() => {
      btnForget.style.display = 'none';
      btnResume.style.display = 'none';
    }).catch(err => {
      console.warn('IDB forget failed (silent):', err && err.message || err);
    });
  });

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
    loadout: {
      frame:   'freestyle_5',
      motors:  'default_2207',
      props:   'default_5140',
      battery: 'default_6s_1300'
    },
    hud: {
      crosshair: true, mode: true, arm: true, batt: true,
      time: true, spd: true, alt: true, thr: true
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

  function applyCameraMode() {
    const prev = cameraMode;
    cameraMode = settings.cameraMode || 'FPV';
    if (prev !== cameraMode) chaseInit = false;
    if (window.DroneVisual && DroneVisual.setFPVMode) {
      DroneVisual.setFPVMode(cameraMode === 'FPV');
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

  function applyLoadout() {
    if (!window.Loadout) return;
    Loadout.apply(settings.loadout);
    if (previewVisual) previewVisual.setLoadout(settings.loadout);
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
    applyLoadout();
    applyHudVisibility();
    applyCameraMode();
    applyCamTilt();
    applyWind();
    applyShake();
    applyChaseDist();
    applyEnv(settings.env || 'DAY');
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
          if (typeof Audio !== 'undefined' && Audio.resume) Audio.resume();
        } else if (setting === 'shake') {
          settings.shake = val;
          applyShake();
        } else if (setting === 'chaseDist') {
          settings.chaseDist = val;
          applyChaseDist();
        } else if (setting === 'env') {
          settings.env = val;
          applyEnv(val);
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

    if (world.advanceFrame) world.advanceFrame();

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED && steps < 16) {
      drone.step(FIXED, state);
      accumulator -= FIXED;
      steps++;
    }
    if (steps >= 16) accumulator = 0;

    if (drone.armed && !drone.crashed) flightTime += dt;


    /* Update drone visual to follow physics state */
    if (window.DroneVisual) DroneVisual.update(drone, state, dt);

    /* Camera — FPV / TOW / CHASE / ORBIT */
    if (cameraMode === 'FPV') {
      tmpV.copy(camOffsetLocal).applyQuaternion(drone.quat);
      camera.position.copy(drone.position).add(tmpV);
      camera.quaternion.copy(drone.quat).multiply(camTilt);
    } else if (cameraMode === 'TOW') {
      /* Rigid stick-cam: 0.15 up / 0.35 back in drone local frame.
         Orientation = drone quaternion → rolls/pitches/yaws with drone,
         looks forward, drone appears in lower-center of view. */
      tmpV.set(0, 0.15, 0.35).applyQuaternion(drone.quat);
      camera.position.copy(drone.position).add(tmpV);
      camera.quaternion.copy(drone.quat);
    } else if (cameraMode === 'CHASE') {
      /* Smoothed chase — position-only smoothing, dt-independent,
         always looks at the drone directly. */
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(drone.quat);
      fwd.y = 0;
      if (fwd.lengthSq() < 0.01) fwd.set(0, 0, -1);
      fwd.normalize();
      const targetPos = new THREE.Vector3().copy(drone.position)
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
      camera.lookAt(drone.position);
    } else if (cameraMode === 'ORBIT') {
      const _t = performance.now() * 0.001;
      const _r = 1.6;
      const orbitPos = new THREE.Vector3(
        drone.position.x + Math.cos(_t * 0.4) * _r,
        drone.position.y + 0.6,
        drone.position.z + Math.sin(_t * 0.4) * _r
      );
      const d = camera.position.distanceTo(orbitPos);
      const k = d > 5 ? 1.0 : (1 - Math.exp(-dt * 12));
      camera.position.lerp(orbitPos, k);
      camera.up.set(0, 1, 0);
      camera.lookAt(drone.position);
    }

    /* Camera micro-shake — FPV + TOW only.
       Driven by drone._windTime phase through 3 summed sines per axis
       at motor-frequency (5.5–14 Hz). NO per-frame randomness — the
       previous Math.random() version was white noise, not vibration.
       Amplitude scales with throttle + speed; wind presets amplify.
       All three axes centred around zero, so no drift.
       TOW gets 0.7× because the camera stick damps the vibration. */
    if ((cameraMode === 'FPV' || cameraMode === 'TOW') && shakeAmt > 0) {
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

    HUD.update(drone, camera, flightTime, state.throttle);
    Audio.update(drone, state);

    /* Loadout preview — only when the settings panel is open and the
       LOADOUT tab is showing. initPreview() runs on first visit. */
    if (settingsPanelEl && !settingsPanelEl.classList.contains('hidden')
        && settings.tab === 'LOADOUT') {
      if (!previewRenderer) initPreview();
      if (previewRenderer) renderPreview(dt);
    }

    if (drone.crashed && !crashShown) {
      crashShown = true;
      Audio.crashSound();
      HUD.showCrash(true);
      updateArmButton();
    }

    renderer.render(scene, camera);
    updateFPS(dt);
  }

  requestAnimationFrame(frame);

})();
