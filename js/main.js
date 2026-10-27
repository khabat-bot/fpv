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
  const camera = new THREE.PerspectiveCamera(100, 1, 0.06, 2000);

  /* --------------------------- world --------------------------------- */
  let world = World.build(scene);

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

  /* Debug globals — accessible from Safari Web Inspector */
  window.__scene = scene;
  window.__drone = drone;
  window.__world = world;

  /* --------------------------- input / hud / racing ------------------ */
  Input.init();
  HUD.init();

  /* --------------------------- camera rig ---------------------------- */
  const camTilt = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0), CFG.camera.tiltDeg * Math.PI / 180);
  const camOffsetLocal = new THREE.Vector3(0, 0.05, -0.06);
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
  }
  function applyFpsCap() { fpsCap = settings.fpsCap; }
  function applyFpsCounter() {
    fpsEl.style.display = settings.fpsCounter ? '' : 'none';
  }
  function applyAllSettings() {
    applyQuality(settings.quality);
    applyFpsCap();
    applyFpsCounter();
    applyHudVisibility();
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
          btn.classList.toggle('active', active);
        });
      });
      panel.querySelectorAll('.sp-row[data-toggle]').forEach(function (row) {
        var key = row.getAttribute('data-toggle');
        row.classList.toggle('sp-on', !!settings.hud[key]);
      });
    }

    refreshSegmented();

    var btnSettings = document.getElementById('btn-settings');
    if (btnSettings) {
      btnSettings.addEventListener('click', function () {
        refreshSegmented();
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


    tmpV.copy(camOffsetLocal).applyQuaternion(drone.quat);
    camera.position.copy(drone.position).add(tmpV);
    camera.quaternion.copy(drone.quat).multiply(camTilt);

    if (world.sky) world.sky.position.copy(camera.position);
    if (world.ground) {
      const TILE = world.groundTile || 20;
      world.ground.position.x = Math.round(camera.position.x / TILE) * TILE;
      world.ground.position.z = Math.round(camera.position.z / TILE) * TILE;
    }

    HUD.update(drone, camera, flightTime, state.throttle);
    Audio.update(drone, state.throttle);

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
