/* =========================================================================
   visuals.js — RACING-QUAD v3 (multi-instance)

   API:
     DroneVisual.createInstance(scene) -> {
       group, update(drone,state,dt), setLoadout(loadout),
       setFPVMode(on), setVisible(v), dispose()
     }

   Backwards-compat module shims (used by main.js as before):
     DroneVisual.build(scene)          // creates the main instance
     DroneVisual.update(drone,state,dt)
     DroneVisual.setLoadout(loadout)
     DroneVisual.setFPVMode(on)
     DroneVisual.setVisible(v)

   setLoadout affects:
     - group.scale   (frame size class)
     - accentMat     (frame accent stripe color)
     - bellMat       (motor bell color coded by KV)
     - propTipMat    (prop tip color coded by prop type)
     - battMesh Z-scale (battery pack length coded by capacity)

   Both the in-game drone and the LOADOUT-tab preview use setLoadout(), so
   the visuals stay in lockstep.
   ========================================================================= */
'use strict';

window.DroneVisual = (function () {

  function createInstance(scene) {
    const group = new THREE.Group();
    group.name = 'drone-visual';

    const props = [];
    let _ledState = null;

    /* ---------- materials ---------- */
    const carbonMat   = new THREE.MeshLambertMaterial({ color: 0x121418 });
    const carbon2Mat  = new THREE.MeshLambertMaterial({ color: 0x1c2026 });
    const accentMat   = new THREE.MeshLambertMaterial({ color: 0xff7a1a });
    const motorMat    = new THREE.MeshLambertMaterial({ color: 0x2a2e34 });
    const bellMat     = new THREE.MeshLambertMaterial({ color: 0xff8a20 });
    const hubMat      = new THREE.MeshLambertMaterial({ color: 0x0a0c10 });
    const propMat     = new THREE.MeshLambertMaterial({ color: 0x181a20 });
    const propTipMat  = new THREE.MeshLambertMaterial({ color: 0xff7a1a });
    const lensMat     = new THREE.MeshLambertMaterial({ color: 0x0a1a2e });
    const camHouseMat = new THREE.MeshLambertMaterial({ color: 0x101216 });

    const ledFrontMat = new THREE.MeshBasicMaterial({ color: 0x0a1a0a });
    const ledRearMat  = new THREE.MeshBasicMaterial({ color: 0x1a0a0a });

    /* ---------- body: stacked carbon plates ---------- */
    const bottomPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.088, 0.006, 0.112), carbonMat);
    bottomPlate.position.y = 0.002;
    group.add(bottomPlate);

    const stack = new THREE.Mesh(
      new THREE.BoxGeometry(0.034, 0.018, 0.034), carbon2Mat);
    stack.position.set(0, 0.014, 0.005);
    group.add(stack);

    const topPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.076, 0.005, 0.098), carbonMat);
    topPlate.position.y = 0.026;
    group.add(topPlate);

    const topStripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.006, 0.090), accentMat);
    topStripe.position.set(0.020, 0.026, 0);
    group.add(topStripe);

    /* battery — Z-scale in setLoadout */
    const battMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.054, 0.024, 0.078), carbon2Mat);
    battMesh.position.set(0, 0.040, -0.004);
    group.add(battMesh);

    /* ---------- arms ---------- */
    const armReach = 0.105;
    const corners = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
    const motorPositions = [];

    for (let i = 0; i < 4; i++) {
      const sx = corners[i][0], sz = corners[i][1];
      const dx = sx * armReach * 0.75;
      const dz = sz * armReach * 0.75;
      const len = Math.hypot(dx, dz);

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.010, 0.006, len + 0.01), carbonMat);
      arm.position.set(dx / 2, 0.003, dz / 2);
      arm.rotation.y = Math.atan2(dx, dz);
      group.add(arm);

      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.0025, 0.007, len * 0.80), accentMat);
      stripe.position.set(dx / 2, 0.003, dz / 2);
      stripe.rotation.y = Math.atan2(dx, dz);
      group.add(stripe);

      motorPositions.push({ x: dx, z: dz, sx, sz });
    }

    /* ---------- motors + props ---------- */
    const motorR = 0.013;
    const motorH = 0.015;
    const propR  = 0.058;
    const bladeW = 0.008;
    const bladeH = 0.0008;

    for (let i = 0; i < motorPositions.length; i++) {
      const m = motorPositions[i];

      const motor = new THREE.Mesh(
        new THREE.CylinderGeometry(motorR, motorR, motorH, 14), motorMat);
      motor.position.set(m.x, motorH / 2 + 0.006, m.z);
      motor.userData.fpvPart = true;
      group.add(motor);

      const bell = new THREE.Mesh(
        new THREE.CylinderGeometry(motorR * 1.06, motorR * 1.06, 0.003, 14), bellMat);
      bell.position.set(m.x, motorH + 0.005, m.z);
      bell.userData.fpvPart = true;
      group.add(bell);

      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.005, 0.005, 0.006, 8), hubMat);
      hub.position.set(m.x, motorH + 0.010, m.z);
      hub.userData.fpvPart = true;
      group.add(hub);

      const propGroup = new THREE.Group();
      propGroup.position.set(m.x, motorH + 0.011, m.z);

      const blade0 = new THREE.Mesh(
        new THREE.BoxGeometry(propR, bladeH, bladeW), propMat);
      blade0.position.x = propR / 2 + 0.004;
      blade0.userData.fpvPart = true;
      propGroup.add(blade0);

      const tip0 = new THREE.Mesh(
        new THREE.BoxGeometry(propR * 0.18, bladeH + 0.0002, bladeW * 1.15), propTipMat);
      tip0.position.x = propR * 0.9 + 0.004;
      tip0.userData.fpvPart = true;
      propGroup.add(tip0);

      const blade1 = new THREE.Mesh(
        new THREE.BoxGeometry(propR, bladeH, bladeW), propMat);
      blade1.position.x = -(propR / 2 + 0.004);
      blade1.userData.fpvPart = true;
      propGroup.add(blade1);

      const tip1 = new THREE.Mesh(
        new THREE.BoxGeometry(propR * 0.18, bladeH + 0.0002, bladeW * 1.15), propTipMat);
      tip1.position.x = -(propR * 0.9 + 0.004);
      tip1.userData.fpvPart = true;
      propGroup.add(tip1);

      group.add(propGroup);

      const dir = ((m.sx * m.sz) > 0) ? 1 : -1;
      props.push({ group: propGroup, dir, sx: m.sx, sz: m.sz, phase: 0 });
    }

    /* ---------- FPV camera housing ---------- */
    const camHouse = new THREE.Mesh(
      new THREE.BoxGeometry(0.024, 0.024, 0.020), camHouseMat);
    camHouse.position.set(0, 0.012, 0.052);
    camHouse.rotation.x = -0.35;
    group.add(camHouse);

    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.010, 0.011, 0.008, 12), lensMat);
    lens.rotation.x = Math.PI / 2 - 0.35;
    lens.position.set(0, 0.017, 0.062);
    group.add(lens);

    /* ---------- antenna ---------- */
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0012, 0.0015, 0.042, 6), carbon2Mat);
    antenna.position.set(0, 0.046, -0.046);
    antenna.rotation.x = 0.30;
    group.add(antenna);

    const antennaTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.0035, 6, 4), accentMat);
    antennaTip.position.set(0, 0.064, -0.052);
    group.add(antennaTip);

    /* ---------- LEDs ---------- */
    const ledFront = new THREE.Mesh(
      new THREE.SphereGeometry(0.0045, 8, 6), ledFrontMat);
    ledFront.position.set(0, 0.005, 0.055);
    group.add(ledFront);

    const ledRear = new THREE.Mesh(
      new THREE.SphereGeometry(0.0045, 8, 6), ledRearMat);
    ledRear.position.set(0, 0.005, -0.055);
    group.add(ledRear);

    /* tag all (BVH skips /drone/i by name) */
    group.traverse(function (o) {
      if (o.isMesh) o.name = 'drone-visual-part';
    });

    /* ---------------- update ---------------- */
    function update(drone, state, dt) {
      if (!group) return;
      group.position.copy(drone.position);
      group.quaternion.copy(drone.quat);

      const t = Math.max(0, Math.min(1, (state && state.throttle) || 0));
      const armed = !!drone.armed;
      const pitchIn = (state && state.pitch) || 0;
      const rollIn  = (state && state.roll)  || 0;
      const yawIn   = (state && state.yaw)   || 0;

      if (armed) {
        const baseRate = t * 40 + 10;
        const DIFF = 20;
        for (let i = 0; i < props.length; i++) {
          const p = props[i];
          let delta = 0;
          delta += pitchIn * p.sz * DIFF;
          delta -= rollIn  * p.sx * DIFF;
          delta += yawIn   * p.sx * p.sz * DIFF * 0.5;
          const rate = Math.max(0, baseRate + delta);
          p.phase += rate * dt;
          if (p.phase > Math.PI * 2) p.phase -= Math.PI * 2;
          p.group.rotation.y = p.phase * p.dir;
        }
      }

      let ledState;
      if (drone.crashed) ledState = 'crash';
      else if (armed)    ledState = 'armed';
      else               ledState = 'off';

      if (ledState === 'crash') {
        const flash = Math.sin(performance.now() * 0.02) * 0.5 + 0.5;
        const c = 0.3 + flash * 0.7;
        ledFrontMat.color.setRGB(c, 0.05, 0.05);
        ledRearMat.color.setRGB(c, 0.05, 0.05);
      } else if (ledState !== _ledState) {
        if (ledState === 'off') {
          ledFrontMat.color.setHex(0x0a1a0a);
          ledRearMat.color.setHex(0x1a0a0a);
        } else {
          ledFrontMat.color.setHex(0x30ff60);
          ledRearMat.color.setHex(0xff2020);
        }
      }
      _ledState = ledState;
    }

    /* ---------------- setLoadout ---------------- */
    function setLoadout(loadout) {
      if (!window.PARTS || !loadout) return;
      const F = PARTS.FRAMES, M = PARTS.MOTORS, P = PARTS.PROPS, B = PARTS.BATTERY;
      const frame   = F[loadout.frame];
      const motor   = M[loadout.motors];
      const prop    = P[loadout.props];
      const battery = B[loadout.battery];

      /* Frame → scale + accent color */
      if (frame) {
        group.scale.setScalar(typeof frame.scale === 'number' ? frame.scale : 1.0);
        if (typeof frame.accent === 'number') accentMat.color.setHex(frame.accent);
      }

      /* Motor → bell color by KV */
      if (motor) {
        const kv = motor.kv || 1800;
        if      (kv >= 10000) bellMat.color.setHex(0xc060ff); /* micro 19000  - purple */
        else if (kv >= 3000)  bellMat.color.setHex(0xe0e0e0); /* micro 3800   - silver */
        else if (kv >= 2200)  bellMat.color.setHex(0xff2020); /* 2400-2750    - hot red */
        else if (kv >= 1500)  bellMat.color.setHex(0xff8a20); /* 1700-1800    - orange */
        else                  bellMat.color.setHex(0xd06010); /* 1300         - dark orange */
      }

      /* Prop → tip color by type */
      if (prop) {
        const pid = loadout.props;
        let tipCol = 0xff7a1a;
        if      (pid === 'race_5143_3')      tipCol = 0xff2020;  /* red */
        else if (pid === 'low_pitch_5130')   tipCol = 0x40ff60;  /* green */
        else if (pid === 'high_pitch_5152')  tipCol = 0xa040ff;  /* purple */
        else if (pid === 'biblade_5145_2')   tipCol = 0x40c0ff;  /* cyan */
        else if (pid === 'race_7x35')        tipCol = 0x80ff40;  /* lime */
        else if (pid === 'cine_3x3')         tipCol = 0xffffff;  /* white */
        else if (pid === 'tiny_2x2')         tipCol = 0xff60ff;  /* pink */
        propTipMat.color.setHex(tipCol);
      }

      /* Battery → pack length (Z) by capacity */
      if (battery && battMesh) {
        const cap = battery.capacityMah || 1300;
        const lenScale = Math.max(0.55, Math.min(1.55, cap / 1300));
        battMesh.scale.set(1.0, 1.0, lenScale);
      }
    }

    /* ---------------- setFPVMode ---------------- */
    function setFPVMode(on) {
      if (!group) return;
      group.visible = !on;
      if (!on) {
        group.traverse(function (o) {
          if (o.isMesh && o.name === 'drone-visual-part') o.visible = true;
        });
      }
    }

    /* ---------------- setVisible ---------------- */
    function setVisible(v) {
      if (group) group.visible = v;
    }

    /* ---------------- dispose ---------------- */
    function dispose() {
      scene.remove(group);
      group.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); });
          else o.material.dispose();
        }
      });
    }

    scene.add(group);
    return { group, update, setLoadout, setFPVMode, setVisible, dispose };
  }

  /* ---- module-scope singleton shim (backwards compat with main.js) ---- */
  let _main = null;

  function build(scene) {
    if (_main) return _main.group;
    _main = createInstance(scene);
    return _main.group;
  }
  function update(drone, state, dt) { if (_main) _main.update(drone, state, dt); }
  function setLoadout(loadout) { if (_main) _main.setLoadout(loadout); }
  function setFPVMode(on) { if (_main) _main.setFPVMode(on); }
  function setVisible(v) { if (_main) _main.setVisible(v); }

  return {
    createInstance: createInstance,
    build: build,
    update: update,
    setLoadout: setLoadout,
    setFPVMode: setFPVMode,
    setVisible: setVisible
  };
})();
