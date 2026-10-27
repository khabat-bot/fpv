/* =========================================================================
   visuals.js — RACING-QUAD v2
   Visible quad model built from Three.js primitives.
   Follows physics drone.position / drone.quat every frame.
   API: build(scene), update(drone, throttle, dt), setVisible(v), setFPVMode(on)
   ========================================================================= */
'use strict';

window.DroneVisual = (function () {
  let group = null;
  const props = [];        // { group, disc, dir }
  let ledFrontMat = null;
  let ledRearMat = null;
  let _ledState = null;

  function build(scene) {
    if (group) return group;
    group = new THREE.Group();
    group.name = 'drone-visual';

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

    ledFrontMat = new THREE.MeshBasicMaterial({ color: 0x0a1a0a });
    ledRearMat  = new THREE.MeshBasicMaterial({ color: 0x1a0a0a });

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

    /* accent stripe on top plate */
    const topStripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.006, 0.090), accentMat);
    topStripe.position.set(0.020, 0.026, 0);
    group.add(topStripe);

    /* battery */
    const batt = new THREE.Mesh(
      new THREE.BoxGeometry(0.054, 0.024, 0.078), carbon2Mat);
    batt.position.set(0, 0.040, -0.004);
    group.add(batt);

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

    /* ---------- tag all (BVH skips /drone/i by name) ---------- */
    group.traverse(function (o) {
      if (o.isMesh) o.name = 'drone-visual-part';
    });

    scene.add(group);
    return group;
  }

  function update(drone, state, dt) {
    if (!group) return;
    group.position.copy(drone.position);
    group.quaternion.copy(drone.quat);

    const t = Math.max(0, Math.min(1, (state && state.throttle) || 0));
    const armed = !!drone.armed;
    const pitchIn = (state && state.pitch) || 0;
    const rollIn  = (state && state.roll)  || 0;
    const yawIn   = (state && state.yaw)   || 0;

    /* Per-motor RPM differential — visible spin asymmetry.
       Base rate ramps from idle (armed-at-zero still spins — real
       quads idle at ~10% with zero throttle). Stick inputs add a
       per-motor delta:
         pitch → nose-down: front slows, rear speeds up
         roll  → bank-right: right slows, left speeds up
         yaw   → diagonal pairs go opposite
       DIFF=6 keeps front/rear visibly different without stalling
       any motor at idle full stick (idle 10 - 6 = 4). */
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


    /* LED state: off / armed / crash-flash */
    let ledState;
    if (drone.crashed)  ledState = 'crash';
    else if (armed)     ledState = 'armed';
    else                ledState = 'off';

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

  function setVisible(v) {
    if (group) group.visible = v;
  }

  function setFPVMode(on) {
    if (!group) return;
    /* FPV: hide the entire drone group — clean view, no strobing blades. */
    group.visible = !on;
    if (!on) {
      group.traverse(function (o) {
        if (o.isMesh && o.name === 'drone-visual-part') o.visible = true;
      });
    }
  }

  return {
    build: build,
    update: update,
    setVisible: setVisible,
    setFPVMode: setFPVMode
  };
})();
