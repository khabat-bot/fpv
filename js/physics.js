/* =========================================================================
   physics.js — rate-based acro quad, with v5 physics polish:
     • realistic LiPo discharge curve + current-based sag with smoothing
     • motor desync kicks on rapid throttle changes at high throttle
     • windmill braking at low throttle / high speed
     • ground-effect wobble when close to terrain
   ========================================================================= */
'use strict';

window.Drone = (function () {

  const DEG = Math.PI / 180;

  function curve(x, expo) {
    const c = x < -1 ? -1 : (x > 1 ? 1 : x);
    return (1 - expo) * c + expo * c * c * c;
  }

  function Drone() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.quat     = new THREE.Quaternion();
    this.angVel   = new THREE.Vector3();

    this.armed   = false;
    this.crashed = false;
    this.easyMode = false;
    this.flightMode = 'ACRO';
    this._easyHeading = 0;
    this.colliders = [];

    this.mahUsed = 0;
    this.voltage = CFG.battery.cells * 4.2;
    this.throttleIn = 0;
    this._smoothCurrent = 0;

    this._target = new THREE.Vector3();
    this._accel  = new THREE.Vector3();
    this._tmpV   = new THREE.Vector3();
    this._tmpQ   = new THREE.Quaternion();
    this._up     = new THREE.Vector3();

    this._wobAmp = 0;
    this._wobPhase = 0;
    this._prevThrottle = 0;
    this._grounded = false;
    this._groundedTime = 0;
    this._sphereScale = 1.0;   /* collision-envelope multiplier — set by Loadout.apply() */
    this._packDeadLatched = false;  /* latches on first cutoff, cleared by reset() */

    this.reset(0, 0);
  }

  Drone.prototype.getFloorY = function () { return CFG.groundY; };

  /* Return the active preset for the current flightMode.
     Fallback chain: this.flightMode preset → SPORT → empty. */
  Drone.prototype._easyPreset = function () {
    const em = CFG.easyMode || {};
    const presets = em.presets || {};
    return presets[this.flightMode] || presets.SPORT || {};
  };

  Drone.prototype.reset = function (x, z) {
    const px = x || 0, pz = z || 0;
    const fy = this.getFloorY(px, pz, true);   // spawn: find highest surface

    this.position.set(px, fy, pz);
    this.velocity.set(0, 0, 0);
    this.quat.identity();
    this.angVel.set(0, 0, 0);

    this.armed = false;
    this.crashed = false;
    this.mahUsed = 0;
    this.voltage = CFG.battery.cells * 4.2;
    this.throttleIn = 0;
    this._smoothCurrent = 0;

    this._wobAmp = 0;
    this._wobPhase = 0;
    this._prevThrottle = 0;
    this._windTime = 0;
    this._grounded = false;
    this._groundedTime = 0;
    this._packDeadLatched = false;

    /* Reset CCD tracking so the first post-respawn collision doesn't
       see a huge "sweep" from the old position. */
    if (this._lastResolvedPos) {
      this._lastResolvedPos.copy(this.position);
      this._lastResolvedQuat.copy(this.quat);
    }
  };

  Drone.prototype.toggleArm = function () {
    if (this.crashed) return;
    this.armed = !this.armed;
    if (!this.armed) this.angVel.set(0, 0, 0);
  };

  Drone.prototype.crash = function () {
    if (this.crashed) return;
    this.crashed = true;
    this.armed = false;
  };

  Drone.prototype.step = function (dt, input) {

    const thr = this.armed ? Math.max(0, Math.min(1, input.throttle)) : 0;
    this.throttleIn = thr;
    this._windTime = (this._windTime || 0) + dt;
    this._groundedTime = Math.max(0, (this._groundedTime || 0) - dt);

    /* ---- ground authority gate -------------------------------------
       Props grinding on the ground produce severe friction torque. The
       primary mechanism for "stuck on the pad" is to scale the TARGET
       rate by tilt — otherwise the damping at end-of-step fights a huge
       target and the drone just grinds upright in a couple of seconds.
       Tilt ramp: up.y >= 0.35 → full groundAuth 0.15 (scootch normally).
                  0.15 <= up.y < 0.35 → ramps 0.15 down to 0.
                  up.y < 0.15 → 0 (fully locked, must respawn).
       Airborne → 1.0 (no restriction). Uses PREVIOUS frame's _up and
       _groundedTime — 1-frame lag is invisible for a boolean gate. */
    var _wasGrounded = (this._groundedTime || 0) > 0;
    var _groundAuth = 1.0;
    if (_wasGrounded) {
      if (this._up.y >= 0.35) {
        _groundAuth = 0.15;
      } else if (this._up.y >= 0.15) {
        _groundAuth = ((this._up.y - 0.15) / 0.20) * 0.15;
      } else {
        _groundAuth = 0;
      }
    }

    /* Voltage-dependent peak thrust. Real props scale thrust with
       RPM^2, and RPM scales with pack voltage. At full charge
       (4.20 V/cell) this is 1.0 = today's baseline feel. As the pack
       drains toward LVC, available peak thrust drops quadratically.
       Applied ONLY as a cap on peak thrust, so hover at mid-stick
       still works fine even on a nearly-dead pack — only high-thrust
       maneuvers lose punch. Matches real 5" quads, which sag under
       load and lose their top-end as SOC drops. */
    const _vPerCell = this.voltage / CFG.battery.cells;
    /* Pack dead: below 3.0 V/cell sagged voltage, real ESCs cut off.
       The drone loses thrust entirely, falls, crashes. Realistic LiPo
       behaviour — you land at 3.5 V/cell (warning) or the ESC cuts at
       3.0. No limp-home-forever. */
    /* Pack-dead latch: once voltage drops below 3.0 V/cell (sagged or
       rest), real ESCs cut off. Latched so brief voltage recovery from
       load removal does not restart motors. Cleared only by reset(). */
    if (!this._packDeadLatched && _vPerCell < 3.0) {
      this._packDeadLatched = true;
    }
    const _packDead = this._packDeadLatched && !CFG.infiniteBattery;
    const _vFactor = _packDead ? 0 : Math.min(1.0, Math.pow(_vPerCell / 4.20, 2));
    const _maxThrustNow = CFG.maxThrust * _vFactor;
    /* Rotation authority scales with pack voltage — real motors produce
       no torque when dead. Zero at cutoff, tapers below 4.0 V/cell. */
    const _authVolt = _vFactor;
    /* Motor authority coupling — real quads lose rotational authority
       at low throttle. Applied to ACRO only (easy mode's alt-hold keeps
       motors spinning at ~50% RPM regardless of stick input, so
       coupling to stick throttle would be wrong). See
       CFG.feel.motorAuthority for tunables. */
    const _mA = (CFG.feel && CFG.feel.motorAuthority) || { rollPitch: 1.0, yaw: 1.0 };
    const _authRP  = _mA.rollPitch + (1 - _mA.rollPitch) * thr;
    const _authYaw = _mA.yaw       + (1 - _mA.yaw)       * thr;

    const e = CFG.expo;
    const easyActive = !!(this.easyMode && this.armed);

    if (easyActive) {
      /* ===== EASY MODE — self-leveling (angle mode) ==================
         Stick commands a target tilt angle, not a rotation rate.
         Centered sticks → error → leveling rate → drone auto-levels.
         Yaw stays rate-based (with reduced max rate).
         Sign conventions match acro:
           +stick pitch → nose down  (negative ω_x)
           +stick roll  → bank right (negative ω_z)
           +stick yaw   → same as acro
         ============================================================== */
      const em = this._easyPreset();
      const maxAngle = (em.maxAngleDeg     != null ? em.maxAngleDeg     : 35)  * DEG;
      const gain     = (CFG.easyMode.levelGain != null ? CFG.easyMode.levelGain : 5.0);
      const rpScale  = (em.maxRatesScale   != null ? em.maxRatesScale   : 0.75);
      const yawScale = (em.yawRatesScale   != null ? em.yawRatesScale   : 0.9);

      // Extract heading via SWING-TWIST decomposition around world Y.
      // This is the mathematically correct way to recover "yaw" from a
      // tilted quaternion. YXZ Euler decomposition (used previously) mixes
      // pitch and roll into the yaw value once the drone is tilted — e.g.
      // a drone at pitch=30deg, yaw=45deg extracts as yaw=49deg with a
      // spurious roll of 22deg, so the controller builds a target at a
      // totally different attitude and blows up. Fixed by swing-twist.
      //
      //   twist_len = sqrt(q.y^2 + q.w^2)
      //   heading   = 2 * atan2(q.y, q.w)
      let heading;
      const twistLen = Math.sqrt(this.quat.y * this.quat.y + this.quat.w * this.quat.w);
      if (twistLen < 1e-3) {
        // Degenerate: quaternion is (nearly) 180deg around some axis in
        // the XZ plane — the drone is inverted, heading is undefined.
        // Reuse last known heading so recovery isn't disorienting.
        heading = this._easyHeading || 0;
      } else {
        heading = 2 * Math.atan2(this.quat.y, this.quat.w);
        this._easyHeading = heading;
      }

      // Target attitude: heading preserved, pitch/roll from stick.
      const targetEul = new THREE.Euler(
        -curve(input.pitch, e) * maxAngle * _groundAuth * _authVolt,
        heading,
        -curve(input.roll,  e) * maxAngle * _groundAuth * _authVolt,
        'YXZ'
      );
      const targetQ = new THREE.Quaternion().setFromEuler(targetEul);

      // Body-frame error quaternion: q_current^-1 * q_target
      const qErr = this._tmpQ.copy(this.quat).invert().multiply(targetQ);

      // Always take the SHORTEST path. Without this, when the error exceeds
      // 180deg-equivalent (e.g. an inverted recovery), qErr.w < 0 and the
      // controller spins the drone the long way around — the "freaks out
      // spinning" symptom. Negating the quaternion flips to the short arc.
      if (qErr.w < 0) {
        qErr.x = -qErr.x;
        qErr.y = -qErr.y;
        qErr.z = -qErr.z;
        qErr.w = -qErr.w;
      }

      // Body-frame axis-angle → proportional rate toward target.
      // Ignore qErr.y (yaw error) — heading is preserved by construction.
      let corrX = 0, corrZ = 0;
      const halfAngle = Math.acos(Math.max(-1, Math.min(1, qErr.w)));
      const sinHalf   = Math.sin(halfAngle);
      if (sinHalf > 1e-3) {
        const scale = gain * 2 * halfAngle / sinHalf;
        corrX = qErr.x * scale;
        corrZ = qErr.z * scale;
      } else if (halfAngle > 1e-3) {
        // Near 180° error (inverted recovery) — degenerate axis, fall back.
        corrX = gain * Math.PI * (qErr.x >= 0 ?  0.5 : -0.5);
        corrZ = gain * Math.PI * (qErr.z >= 0 ?  0.5 : -0.5);
      }

      // Clamp leveling rate.
      const maxR = CFG.maxRates.roll * DEG * rpScale;
      const mag  = Math.sqrt(corrX * corrX + corrZ * corrZ);
      if (mag > maxR && mag > 1e-6) {
        const s = maxR / mag;
        corrX *= s;
        corrZ *= s;
      }
      // Ground gate: same authority scaling as stick targets. Grounded
      // and deeply tilted → 0 → leveling controller can't right the drone.
      corrX *= _groundAuth * _authVolt;
      corrZ *= _groundAuth * _authVolt;

      // Yaw: rate-based, reduced.
      const yawRate = curve(input.yaw, e) * CFG.maxRates.yaw * DEG * CFG.rcRate * yawScale * _groundAuth * _authVolt;

      this._target.set(corrX, -yawRate, corrZ);
    } else {
      /* ===== ACRO MODE (existing behaviour, disarm gating preserved) ===== */
      const rRate = (this.armed ? curve(input.roll,  e) * CFG.maxRates.roll  * DEG * CFG.rcRate * _groundAuth * _authVolt * _authRP  : 0);
      const pRate = (this.armed ? curve(input.pitch, e) * CFG.maxRates.pitch * DEG * CFG.rcRate * _groundAuth * _authVolt * _authRP  : 0);
      const yRate = (this.armed ? curve(input.yaw,   e) * CFG.maxRates.yaw   * DEG * CFG.rcRate * _groundAuth * _authVolt * _authYaw : 0);

      this._target.set(-pRate, -yRate, -rRate);
    }

    const a = this._accel
      .copy(this._target)
      .sub(this.angVel)
      .multiplyScalar(1 / CFG.angResponse);

    const aLen = a.length();
    if (aLen > CFG.angAccelMax) a.multiplyScalar(CFG.angAccelMax / aLen);

    const dThr = thr - this._prevThrottle;
    this._prevThrottle = thr;

    this._wobAmp += Math.abs(dThr) * CFG.propWashGain;
    this._wobAmp *= Math.exp(-dt * 7.0);
    this._wobPhase += dt * Math.PI * 2 * CFG.propWashFreq;

    if (thr > 0.03 && !_wasGrounded && !_packDead) {
      const wobScale = easyActive ? 0.4 : 1.0;
      const w = Math.sin(this._wobPhase) * this._wobAmp * thr;
      a.x += w * 400 * wobScale;
      a.z += Math.sin(this._wobPhase * 0.73 + 1.7) * this._wobAmp * thr * 320 * wobScale;
      a.x += Math.sin(this._wobPhase * 2.31) * 2.5 * thr * wobScale;
      a.z += Math.cos(this._wobPhase * 1.87) * 2.0 * thr * wobScale;
    }

    /* ---- motor desync: rapid throttle changes → brief yaw kicks ----
       Skipped in easy mode — the yaw kicks fight the leveling controller. */
    if (!easyActive && !_wasGrounded && !_packDead && Math.abs(dThr) > 0.2 && thr > 0.3) {
      a.y += (Math.random() - 0.5) * Math.min(1.5, Math.abs(dThr) * 2.0) * 6.0;
    }

    /* ---- ground effect: wobble near terrain ---- */
    const floorHere = this.getFloorY(this.position.x, this.position.z);
    const agl = this.position.y - floorHere;
    if (agl > 0.2 && agl < 2.5 && this.armed && !_packDead) {
      const eff = (1 - agl / 2.5) * 0.5 * (easyActive ? 0.3 : 1.0);
      a.x += (Math.random() - 0.5) * eff * 80;
      a.z += (Math.random() - 0.5) * eff * 80;
    }

    this.angVel.addScaledVector(a, dt);

    const wLen = this.angVel.length();
    if (wLen > 1e-6) {
      this._tmpQ.setFromAxisAngle(
        this._tmpV.copy(this.angVel).multiplyScalar(1 / wLen),
        wLen * dt);
      this.quat.multiply(this._tmpQ);
      this.quat.normalize();
    }

    this._up.set(0, 1, 0).applyQuaternion(this.quat);

    const acc = this._accel;
    if (easyActive) {
      /* ===== EASY MODE — altitude hold =============================
         Throttle = climb-rate command:
           0.5  → hold altitude
           1.0  → climb at maxClimbRate
           0.0  → descend at maxDescendRate (downward)
         P controller on vertical-velocity error → required thrust.
         Thrust is scaled by 1/up.y to cancel the cos(tilt) loss, so
         tilting forward does not change vertical speed. This is what
         makes "push forward = go forward" instead of "push forward =
         climb," which is the DJI-style behaviour.
         ============================================================ */
      const em = this._easyPreset();
      const maxClimb   = em.maxClimbRate   != null ? em.maxClimbRate   : 6.0;
      const maxDescend = em.maxDescendRate != null ? em.maxDescendRate : 8.0;
      const altGain    = (CFG.easyMode.altGain != null ? CFG.easyMode.altGain : 3.0);

      const tAbove = Math.max(0, thr - 0.5);
      const tBelow = Math.max(0, 0.5 - thr);
      const vzCmd  = tAbove * 2 * maxClimb - tBelow * 2 * maxDescend;

      const vzErr = vzCmd - this.velocity.y;
      const azCmd = altGain * vzErr;

      // Thrust needed so that (thrust * up.y / mass) - gravity = azCmd.
      // up.y is clamped to avoid blow-up if momentarily inverted.
      const upY = Math.max(0.3, this._up.y);
      const thrustNeeded = (azCmd + CFG.gravity) / upY * CFG.mass;
      /* Motor stall: props jammed against ground when inverted. Real ESCs
         detect stall (high current, zero RPM) and cut the motor. Without
         this, the drone "pushes into" the ground and the collision silently
         cancels the movement — the props appear to keep working. */
      const _stalledEasy = (this._up.y < 0.35) && ((this._groundedTime || 0) > 0);
      /* Voltage-aware cap: hover needs ~20% of peak thrust, so it still
         works even on a nearly-dead pack. Fast climbs / steep dives
         lose their extra punch. */
      const effThrust = _stalledEasy ? 0 : Math.max(0, Math.min(_maxThrustNow, thrustNeeded));

      acc.copy(this._up).multiplyScalar(effThrust / CFG.mass);
      acc.y -= CFG.gravity;
    } else {
      /* ===== ACRO MODE ================================================ */
      /* Motor stall: props jammed against ground when inverted. */
      const _stalledAcro = (this._up.y < 0.35) && ((this._groundedTime || 0) > 0);
      const _effThr = _stalledAcro ? 0 : thr;
      /* Full stick on a drained pack produces less thrust than full
         stick on a fresh pack — matches real sag behaviour. */
      acc.copy(this._up).multiplyScalar(_effThr * _maxThrustNow / CFG.mass);
      acc.y -= CFG.gravity;
    }

    /* ===== wind ====================================================
       Applied uniformly in both flight modes. Horizontal push makes
       the drone drift and forces a lean to hold position; gusty adds
       oscillation on top. Drag (below) damps the resulting velocity.
       Suppressed while grounded — a landed quad doesn't slide across
       the pad in a breeze. Only affects BREEZY/GUSTY (CALM is 0 anyway). */
    if ((this._groundedTime || 0) <= 0 && CFG.wind && CFG.windPreset) {
      const wp = CFG.wind[CFG.windPreset];
      if (wp) {
        let wx = wp.x || 0, wy = wp.y || 0, wz = wp.z || 0;
        const gust = wp.gust || 0;
        if (gust > 0) {
          const t = this._windTime;
          wx += Math.sin(t * 0.7) * gust * 1.2 + Math.sin(t * 1.9) * gust * 0.4;
          wy += Math.sin(t * 1.3) * gust * 0.35;
          wz += Math.cos(t * 0.9) * gust * 1.0 + Math.sin(t * 2.3) * gust * 0.35;
        }
        acc.x += wx;
        acc.y += wy;
        acc.z += wz;
      }
    }

    const speed = this.velocity.length();
    if (speed > 1e-5) {
      const k = CFG.dragLinear + CFG.dragQuadratic * speed;
      acc.addScaledVector(this.velocity, -k);
    }

    /* ---- windmill / air-brake drag at low throttle ---- */
    /* Windmill brake — acro only. In easy mode, the alt-hold controller
       already manages vertical velocity; adding drag here would cause it
       to fight the controller and slow commanded descents. */
    if (!easyActive && thr < 0.15 && speed > 3) {
      const wmCoeff = CFG.windmillBrake != null ? CFG.windmillBrake : 0.15;
      const windmill = (1 - thr / 0.15) * wmCoeff;
      acc.addScaledVector(this.velocity, -windmill);
    }

    this.velocity.addScaledVector(acc, dt);
    this.position.addScaledVector(this.velocity, dt);

    this._collide();

    /* ---- ground rotation safety net -------------------------------
       Primary authority control is in _groundAuth (top of step). This
       block is the belt-and-suspenders safety net that runs AFTER quat
       integration, so on the exact landing frame even a huge incoming
       angVel gets killed. Deeply tilted (up.y < 0.15) → angVel zeroed,
       drone stays put until RESPAWN. Upright-ish → strong exp damping. */
    if ((this._groundedTime || 0) > 0) {
      /* Softer damping than before (exp -10 vs -15, cap 5 vs 2.5) so
         contacts can push the drone past the tipping point. Motor stall
         (thrust=0 when inverted + grounded) is what keeps it stuck on
         its back, not this damping. */
      this.angVel.multiplyScalar(Math.exp(-dt * 10));
      const _lenUp = this.angVel.length();
      if (_lenUp > 5.0) this.angVel.multiplyScalar(5.0 / _lenUp);
    }

    /* ---- battery: LiPo curve + current sag w/ RC smoothing ---- */
    if (CFG.infiniteBattery) {
      /* Infinite mode: no drain, no sag, voltage pinned at full charge.
         Low-batt beeper never fires (vPerCell stays at 4.20 > threshold). */
      this.mahUsed = 0;
      this._smoothCurrent = 0;
      this.voltage = CFG.battery.cells * 4.20;
      this._packDeadLatched = false;
    } else {
      const current = _packDead ? 0 : Math.pow(thr, 1.4) * CFG.battery.maxCurrent;
      /* Cap mahUsed at capacity — OSD never shows > pack rating. Real
         pack drains fully at mahUsed == capacityMah. */
      this.mahUsed = Math.min(CFG.battery.capacityMah,
                              this.mahUsed + current * dt / 3.6);

      const soc = Math.max(0, 1 - this.mahUsed / CFG.battery.capacityMah);
      let restCell;
      if (soc > 0.5)      restCell = 3.85 + (soc - 0.5) * 0.70;
      else if (soc > 0.1) restCell = 3.70 + (soc - 0.1) * 0.375;
      else                restCell = 2.80 + soc * 9.00;  /* drops to 2.8V at 0% SOC */

      this._smoothCurrent = this._smoothCurrent * 0.85 + current * 0.15;
      /* Internal resistance scales INVERSELY with C rating — higher-C
         packs sag LESS under the same load. Previously maxCurrent was
         used as a direct multiplier on sag, giving the sign backwards
         (higher-C packs appeared to sag MORE). New formula:
         IR_perCell = 0.2 / C_rating (ohm), C = maxCurrent / (capacityAh).
         A mid-grade 6S 1300mAh 47C pack ≈ 4.2 mΩ/cell. A top-tier 100C
         pack ≈ 2.0 mΩ/cell. Real 6S LiPo behaviour. */
      const _C_rating = Math.max(1, CFG.battery.maxCurrent / (CFG.battery.capacityMah / 1000));
      const _IR_perCell = 0.2 / Math.max(_C_rating, 5);
      const Rpack = _IR_perCell * CFG.battery.cells;
      /* Floor at 2.5 V/cell — safety only. Allows load sag below the
         3.0 V/cell cutoff so the ESC can actually fire it. */
      if (_packDead) {
        /* Dead pack: voltage relaxes to rest, capped at 3.0 V/cell.
           OSD shows clear cutoff reading — no ambiguity. */
        this.voltage = Math.min(CFG.battery.cells * 3.0,
                                CFG.battery.cells * restCell);
      } else {
        this.voltage = Math.max(
          2.5 * CFG.battery.cells,
          CFG.battery.cells * restCell - this._smoothCurrent * Rpack);
      }
    }
  };

  Drone.prototype._disposeBVH = function() {
  if (this.collisionGeom) {
    if (typeof this.collisionGeom.disposeBoundsTree === 'function') {
      this.collisionGeom.disposeBoundsTree();
    }
    this.collisionGeom.dispose();
  }
  this.collisionGeom = null;
  this.collisionBVH = null;
  this._bvhColliderCount = 0;
  this._bvhLogCount = 0;
  if (typeof window !== 'undefined') window.__bvh = null;
};

Drone.prototype._ensureBVH = function() {
  if (this._bvhFailed) return;
  if (this._bvhBuilding) return;
  if (typeof THREE === 'undefined') return;

  var hasExt = (typeof THREE.BufferGeometry.prototype.computeBoundsTree === 'function');
  var hasLib = (typeof window !== 'undefined'
                && window.MeshBVHLib
                && typeof window.MeshBVHLib.MeshBVH === 'function');

  if (!hasExt && !hasLib) {
    if (typeof window !== 'undefined' && !window.__bvhScriptRequested) {
      window.__bvhScriptRequested = true;
      var s = document.createElement('script');
      s.src = 'js/three-mesh-bvh.umd.js';
      s.onload = function() {
        console.log('[BVH] three-mesh-bvh.umd.js loaded dynamically');
        if (window.__drone) window.__drone._bvhFailed = false;
      };
      s.onerror = function() {
        console.warn('[BVH] failed to load three-mesh-bvh.umd.js');
        if (window.__drone) window.__drone._bvhFailed = true;
      };
      document.head.appendChild(s);
      console.log('[BVH] injected three-mesh-bvh.umd.js (dynamic)');
    }
    return;
  }

  if (!hasExt && hasLib) {
    var lib = window.MeshBVHLib;
    if (typeof lib.computeBoundsTree === 'function') {
      THREE.BufferGeometry.prototype.computeBoundsTree = lib.computeBoundsTree;
      if (typeof lib.disposeBoundsTree === 'function') {
        THREE.BufferGeometry.prototype.disposeBoundsTree = lib.disposeBoundsTree;
      }
    } else {
      this._bvhFailed = true;
      console.warn('[BVH] library loaded but computeBoundsTree not exported');
      return;
    }
  }

  var cols = this.colliders || (window.__world && window.__world.colliders) || null;
  if (!cols || cols.length === 0) {
    // If we had a BVH from a previously-loaded map, dispose it — otherwise
    // _collide() keeps using stale triangles against a world that no
    // longer has any colliders.
    if (this.collisionBVH) {
      console.log('[BVH] no colliders — disposing stale BVH');
      this._disposeBVH();
    }
    return;
  }

  // Only imported maps get a BVH. Procedural world keeps its accurate
  // cylinder/box colliders + getFloorY snap in the original AABB path.
  var BVH_MIN_COLLIDERS = 500;
  if (cols.length < BVH_MIN_COLLIDERS) {
    // Procedural world — falls through to the AABB path in _collide().
    // Critically, we must dispose any BVH left over from a previously
    // loaded map, otherwise _collide() sees collisionBVH truthy and
    // uses stale triangles against the procedural world.
    if (this.collisionBVH) {
      console.log('[BVH] colliders dropped below ' + BVH_MIN_COLLIDERS +
                  ' (now ' + cols.length + ') — disposing stale BVH, ' +
                  'using AABB path');
      this._disposeBVH();
    }
    return;
  }

  var colSrc = (this.colliders === cols) ? 'drone' : 'world';

  // Already built with the current collider count → nothing to do
  if (this.collisionBVH && this._bvhColliderCount === cols.length) return;

  // Colliders changed since last build (map imported) → dispose + rebuild
  if (this.collisionBVH) {
    console.log('[BVH] colliders changed:', this._bvhColliderCount, '->', cols.length, '- rebuilding');
    this._disposeBVH();
  }

  var scene = (window.__scene) || this.scene || null;
  if (!scene) { console.warn('[BVH] no scene reference'); return; }

  this._bvhBuilding = true;
  try {
    var meshes = [];
    scene.traverse(function(obj) {
      if (!obj.isMesh || !obj.geometry) return;
      if (!obj.geometry.attributes || !obj.geometry.attributes.position) return;
      var name = obj.name || '';
      if (/drone|sky|camera|helper|marker|trigger|spawn/i.test(name)) return;
      if (obj.geometry.boundingBox === null) obj.geometry.computeBoundingBox();
      var bb = obj.geometry.boundingBox;
      if (!bb) return;
      var sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
      if (sx > 2000 || sy > 2000 || sz > 2000) return;
      meshes.push(obj);
    });

    if (meshes.length === 0) {
      console.warn('[BVH] no candidate meshes');
      return;
    }

    var totalVerts = 0, totalIndices = 0;
    for (var mi = 0; mi < meshes.length; mi++) {
      var g = meshes[mi].geometry;
      totalVerts += g.attributes.position.count;
      totalIndices += g.index ? g.index.count : g.attributes.position.count;
    }

    var positions = new Float32Array(totalVerts * 3);
    var indices = new Uint32Array(totalIndices);
    var vOff = 0, iOff = 0;
    var tmp = new THREE.Vector3();

    for (var mj = 0; mj < meshes.length; mj++) {
      var mesh = meshes[mj];
      mesh.updateWorldMatrix(true, false);
      var mtx = mesh.matrixWorld;
      var pos = mesh.geometry.attributes.position;
      for (var i = 0; i < pos.count; i++) {
        tmp.fromBufferAttribute(pos, i).applyMatrix4(mtx);
        positions[(vOff + i) * 3]     = tmp.x;
        positions[(vOff + i) * 3 + 1] = tmp.y;
        positions[(vOff + i) * 3 + 2] = tmp.z;
      }
      var idx = mesh.geometry.index;
      if (idx) {
        for (var k = 0; k < idx.count; k++) indices[iOff + k] = idx.getX(k) + vOff;
        iOff += idx.count;
      } else {
        for (var k2 = 0; k2 < pos.count; k2++) indices[iOff + k2] = vOff + k2;
        iOff += pos.count;
      }
      vOff += pos.count;
    }

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    var t0 = performance.now();
    geom.computeBoundsTree();
    var dt = (performance.now() - t0).toFixed(0);

    geom.computeBoundingBox();
    var _bb = geom.boundingBox;

    this.collisionGeom = geom;
    this.collisionBVH = geom.boundsTree;
    this._bvhColliderCount = cols.length;
    window.__bvh = this.collisionBVH;

    console.log('[BVH] built:', meshes.length, 'meshes,', (totalIndices / 3 | 0), 'tris in', dt + 'ms');
    console.log('[BVH] colliders:', cols.length, 'from', colSrc);
    if (_bb) {
      console.log('[BVH] bounds:',
        _bb.min.x.toFixed(1), _bb.min.y.toFixed(1), _bb.min.z.toFixed(1), '..',
        _bb.max.x.toFixed(1), _bb.max.y.toFixed(1), _bb.max.z.toFixed(1));
    }
    console.log('[BVH] drone local:',
      this.position.x.toFixed(1), this.position.y.toFixed(1), this.position.z.toFixed(1));
    if (typeof this.getWorldPosition === 'function') {
      var _wp = new THREE.Vector3();
      this.getWorldPosition(_wp);
      console.log('[BVH] drone world:', _wp.x.toFixed(1), _wp.y.toFixed(1), _wp.z.toFixed(1));
    }
  } catch (e) {
    this._bvhFailed = true;
    console.warn('[BVH] build failed:', e && e.message);
  } finally {
    this._bvhBuilding = false;
  }
};

Drone.prototype._collideBVH = function() {
  var bvh = this.collisionBVH;
  if (!bvh) return;

  if (!this._lastResolvedPos) {
    this._lastResolvedPos = new THREE.Vector3().copy(this.position);
    this._lastResolvedQuat = new THREE.Quaternion().copy(this.quat);
  }

  var dx = this.position.x - this._lastResolvedPos.x;
  var dy = this.position.y - this._lastResolvedPos.y;
  var dz = this.position.z - this._lastResolvedPos.z;
  var sweepDist = Math.sqrt(dx*dx + dy*dy + dz*dz);

  /* CCD: if the sweep is more than ~1.5x the smallest sphere radius,
     sub-step. Threshold 0.03 matches the motor sphere radius; cap at 6
     substeps to bound cost (~54 shapecasts at worst case). */
  var substeps = 1;
  /* CCD only fires when actually sweeping fast. Below ~5 m/s the
     per-step displacement is smaller than the smallest sphere radius,
     so single-shot collision is sufficient. This also stops CCD from
     firing every frame when the drone is resting against a wall —
     which was the source of the "stuck" and "camera in wall" bugs. */
  var speedNow = this.velocity.length();
  var _ssCCD = this._sphereScale || 1.0;
  var _ccdGate = 0.03 * _ssCCD;
  if (sweepDist > _ccdGate && speedNow > 5.0) {
    substeps = Math.min(6, Math.ceil(sweepDist / _ccdGate));
  }

  if (substeps === 1) {
    this._collideBVHOnce();
  } else {
    var targetX = this.position.x, targetY = this.position.y, targetZ = this.position.z;
    var targetQx = this.quat.x, targetQy = this.quat.y, targetQz = this.quat.z, targetQw = this.quat.w;

    this.position.copy(this._lastResolvedPos);
    this.quat.copy(this._lastResolvedQuat);

    var stepDX = (targetX - this.position.x) / substeps;
    var stepDY = (targetY - this.position.y) / substeps;
    var stepDZ = (targetZ - this.position.z) / substeps;

    var qa = this._lastResolvedQuat;
    var qb = this._tmpTargetQuat || (this._tmpTargetQuat = new THREE.Quaternion());
    qb.set(targetQx, targetQy, targetQz, targetQw);

    for (var s = 1; s <= substeps; s++) {
      this.position.x += stepDX;
      this.position.y += stepDY;
      this.position.z += stepDZ;
      this.quat.copy(qa).slerp(qb, s / substeps);
      this._collideBVHOnce();
      /* Stop sweeping on the first contact. Continuing to add stepDX
         after a push-out drives the drone back into the surface — the
         source of the "drone eats the wall" camera clip. */
      if (this._hadContactThisStep) break;
    }
  }

  this._lastResolvedPos.copy(this.position);
  this._lastResolvedQuat.copy(this.quat);
};

Drone.prototype._collideBVHOnce = function() {
  this._hadContactThisStep = false;
  var bvh = this.collisionBVH;
  if (!bvh) return;

  if (!this._bvhSphere) {
    this._bvhSphere   = new THREE.Sphere();
    this._bvhClosest  = new THREE.Vector3();
    this._bvhNormal   = new THREE.Vector3();
    this._bvhWorldPos = new THREE.Vector3();
    this._bvhOffset   = new THREE.Vector3();
    this._bvhContacts = [];
    this._bvhLogCount = 0;
  }
  var sphere    = this._bvhSphere;
  var closest   = this._bvhClosest;
  var worldPos  = this._bvhWorldPos;
  var offset    = this._bvhOffset;
  var contacts  = this._bvhContacts;
  contacts.length = 0;

  if (typeof this.getWorldPosition === 'function') {
    this.getWorldPosition(worldPos);
  } else {
    worldPos.copy(this.position);
  }

  /* 9-sphere compound. Positions in drone-body frame (metres).
     - body:   covers central stack + battery
     - motors: covers motor bell + prop mount, slight +Y for prop stack
     - tips:   catches prop-tip / outer-corner strikes; the diagonal
               sphere covers the swept prop envelope at each corner */
  var SPHERES = [
    { x:  0.000, y: 0.000, z:  0.000, r: 0.058 },
    { x:  0.078, y: 0.012, z: -0.078, r: 0.030 },
    { x: -0.078, y: 0.012, z: -0.078, r: 0.030 },
    { x:  0.078, y: 0.012, z:  0.078, r: 0.030 },
    { x: -0.078, y: 0.012, z:  0.078, r: 0.030 },
    { x:  0.120, y: 0.012, z: -0.120, r: 0.020 },
    { x: -0.120, y: 0.012, z: -0.120, r: 0.020 },
    { x:  0.120, y: 0.012, z:  0.120, r: 0.020 },
    { x: -0.120, y: 0.012, z:  0.120, r: 0.020 }
  ];

  /* ---- Pass 1: detect contacts (shapecast per sphere) ---- */
  var _ss = this._sphereScale || 1.0;
  for (var si = 0; si < SPHERES.length; si++) {
    var sp = SPHERES[si];
    offset.set(sp.x * _ss, sp.y * _ss, sp.z * _ss).applyQuaternion(this.quat);
    sphere.center.copy(worldPos).add(offset);
    sphere.radius = sp.r * _ss;

    var hitPoint = null;
    var hitNormal = null;
    (function(sphere, closest, state) {
      bvh.shapecast({
        intersectsBounds: function(box) {
          var cx = Math.max(box.min.x, Math.min(sphere.center.x, box.max.x));
          var cy = Math.max(box.min.y, Math.min(sphere.center.y, box.max.y));
          var cz = Math.max(box.min.z, Math.min(sphere.center.z, box.max.z));
          var dx = cx - sphere.center.x, dy = cy - sphere.center.y, dz = cz - sphere.center.z;
          return (dx*dx + dy*dy + dz*dz) <= sphere.radius * sphere.radius;
        },
        intersectsTriangle: function(tri) {
          tri.closestPointToPoint(sphere.center, closest);
          var dx = closest.x - sphere.center.x;
          var dy = closest.y - sphere.center.y;
          var dz = closest.z - sphere.center.z;
          var d2 = dx*dx + dy*dy + dz*dz;
          if (d2 < sphere.radius * sphere.radius) {
            state.point = { x: closest.x, y: closest.y, z: closest.z };
            var ndx = -dx, ndy = -dy, ndz = -dz;
            var nl = Math.sqrt(ndx*ndx + ndy*ndy + ndz*ndz) || 1e-5;
            state.normal = { x: ndx/nl, y: ndy/nl, z: ndz/nl };
            state.dist = nl;
            return true;
          }
          return false;
        }
      });
    })(sphere, closest, { get point() { return hitPoint; }, set point(v) { hitPoint = v; },
                          get normal() { return hitNormal; }, set normal(v) { hitNormal = v; },
                          dist: sp.r });

    if (hitPoint && hitNormal) {
      var dx = sphere.center.x - hitPoint.x;
      var dy = sphere.center.y - hitPoint.y;
      var dz = sphere.center.z - hitPoint.z;
      var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      contacts.push({
        r: {
          x: hitPoint.x - worldPos.x,
          y: hitPoint.y - worldPos.y,
          z: hitPoint.z - worldPos.z
        },
        n: hitNormal,
        depth: Math.max(0, sp.r - dist)
      });
    }
  }

  if (contacts.length === 0) return;
  this._hadContactThisStep = true;

  /* ---- Crash check uses PRE-impulse contact velocities ---- */
  var maxApproach = 0;
  var anyUpwardNormal = false;
  for (var ci = 0; ci < contacts.length; ci++) {
    var c = contacts[ci];
    var rx = c.r.x, ry = c.r.y, rz = c.r.z;
    var vcx = this.velocity.x + (this.angVel.y * rz - this.angVel.z * ry);
    var vcy = this.velocity.y + (this.angVel.z * rx - this.angVel.x * rz);
    var vcz = this.velocity.z + (this.angVel.x * ry - this.angVel.y * rx);
    var vn = vcx * c.n.x + vcy * c.n.y + vcz * c.n.z;
    if (-vn > maxApproach) maxApproach = -vn;
    if (c.n.y > 0.6) anyUpwardNormal = true;
  }

  /* ---- Pass 2: iterative impulse solve (2 Gauss-Seidel passes) ----
     Scalar inertia approximation I ≈ 0.003 kg·m² for a 5" quad. Good
     enough for a tumble feel that scales with lever arm; exact tensor
     would matter more on an aircraft with asymmetric mass distribution. */
  var m = CFG.mass;
  var invM = 1 / m;
  var I = 0.003;
  var invI = 1 / I;
  var restitutionBase = 0.30;
  var frictionMu = 0.30;

  for (var iter = 0; iter < 2; iter++) {
    for (var ci2 = 0; ci2 < contacts.length; ci2++) {
      var cc = contacts[ci2];
      var rx2 = cc.r.x, ry2 = cc.r.y, rz2 = cc.r.z;
      var nx = cc.n.x, ny = cc.n.y, nz = cc.n.z;

      /* Contact-point velocity (v + ω × r) */
      var vcx2 = this.velocity.x + (this.angVel.y * rz2 - this.angVel.z * ry2);
      var vcy2 = this.velocity.y + (this.angVel.z * rx2 - this.angVel.x * rz2);
      var vcz2 = this.velocity.z + (this.angVel.x * ry2 - this.angVel.y * rx2);
      var vn2 = vcx2 * nx + vcy2 * ny + vcz2 * nz;
      if (vn2 >= 0) continue;

      /* Effective mass: 1/m + (r×n)·I⁻¹·(r×n) — scalar I simplifies
         to |r×n|²/I. This is the whole reason far hits tumble harder:
         the (r×n)² term grows with lever length. */
      var rxn_x = ry2 * nz - rz2 * ny;
      var rxn_y = rz2 * nx - rx2 * nz;
      var rxn_z = rx2 * ny - ry2 * nx;
      var rxn2 = rxn_x*rxn_x + rxn_y*rxn_y + rxn_z*rxn_z;
      var effMassInv = invM + rxn2 * invI;
      if (effMassInv < 1e-6) effMassInv = invM;

      /* Velocity-dependent restitution — real bounce only above
         ~1 m/s approach. Below that: dead (no resting jitter). */
      var e = (-vn2 > 1.0) ? restitutionBase : 0;
      var J = -(1 + e) * vn2 / effMassInv;

      /* Apply normal impulse */
      this.velocity.x += J * invM * nx;
      this.velocity.y += J * invM * ny;
      this.velocity.z += J * invM * nz;

      var ti_x = ry2 * (J * nz) - rz2 * (J * ny);
      var ti_y = rz2 * (J * nx) - rx2 * (J * nz);
      var ti_z = rx2 * (J * ny) - ry2 * (J * nx);
      this.angVel.x += invI * ti_x;
      this.angVel.y += invI * ti_y;
      this.angVel.z += invI * ti_z;

      /* ---- Coulomb friction ----
         Tangential velocity AFTER the normal impulse. Slide direction
         is v_t / |v_t|; friction opposes it, clamped to μ·J. */
      var vcx3 = this.velocity.x + (this.angVel.y * rz2 - this.angVel.z * ry2);
      var vcy3 = this.velocity.y + (this.angVel.z * rx2 - this.angVel.x * rz2);
      var vcz3 = this.velocity.z + (this.angVel.x * ry2 - this.angVel.y * rx2);
      var vn3 = vcx3 * nx + vcy3 * ny + vcz3 * nz;
      var vtx = vcx3 - vn3 * nx;
      var vty = vcy3 - vn3 * ny;
      var vtz = vcz3 - vn3 * nz;
      var vt_len = Math.sqrt(vtx*vtx + vty*vty + vtz*vtz);

      if (vt_len > 1e-4) {
        var tx = vtx / vt_len, ty = vty / vt_len, tz = vtz / vt_len;

        var rxt_x = ry2 * tz - rz2 * ty;
        var rxt_y = rz2 * tx - rx2 * tz;
        var rxt_z = rx2 * ty - ry2 * tx;
        var rxt2 = rxt_x*rxt_x + rxt_y*rxt_y + rxt_z*rxt_z;
        var effMassInvT = invM + rxt2 * invI;

        var Jt = -vt_len / effMassInvT;
        var Jt_max = frictionMu * J;
        if (-Jt > Jt_max) Jt = -Jt_max;

        this.velocity.x += Jt * invM * tx;
        this.velocity.y += Jt * invM * ty;
        this.velocity.z += Jt * invM * tz;

        var tit_x = ry2 * (Jt * tz) - rz2 * (Jt * ty);
        var tit_y = rz2 * (Jt * tx) - rx2 * (Jt * tz);
        var tit_z = rx2 * (Jt * ty) - ry2 * (Jt * tx);
        this.angVel.x += invI * tit_x;
        this.angVel.y += invI * tit_y;
        this.angVel.z += invI * tit_z;
      }
    }
  }

  /* ---- Push out: iterate ALL contacts, two passes. Deepest-only
       push-out pinned the drone in corners (deepest normal fixed one
       wall, other wall's penetration persisted). Two passes reduce
       residual on multi-contact frames. ---- */
  for (var po = 0; po < 2; po++) {
    for (var pi = 0; pi < contacts.length; pi++) {
      var pc = contacts[pi];
      if (pc.depth > 0.0001) {
        this.position.x += pc.n.x * pc.depth;
        this.position.y += pc.n.y * pc.depth;
        this.position.z += pc.n.z * pc.depth;
        pc.depth *= 0.4;   /* second pass gets the residual */
      }
    }
  }
  /* Epsilon along averaged normal to ensure clear of surface */
  if (contacts.length > 0) {
    var ax = 0, ay = 0, az = 0;
    for (var ni = 0; ni < contacts.length; ni++) {
      ax += contacts[ni].n.x; ay += contacts[ni].n.y; az += contacts[ni].n.z;
    }
    var alen = Math.sqrt(ax*ax + ay*ay + az*az);
    if (alen > 1e-6) {
      this.position.x += (ax / alen) * 0.001;
      this.position.y += (ay / alen) * 0.001;
      this.position.z += (az / alen) * 0.001;
    }
  }

  /* ---- Ground detection ----
     ONLY upward-facing contacts count as floor. The old `contactY <
     worldPos.y - 0.1` catch also fired on diving wall impacts, making
     the drone think it was grounded and reducing angular authority
     (the "stuck against wall" symptom). Lateral damping is now further
     gated on a near-vertical normal so wall slides aren't braked. */
  var anyFloor = false;
  var anyStrongUpNormal = false;
  for (var gi = 0; gi < contacts.length; gi++) {
    var gc = contacts[gi];
    if (gc.n.y > 0.4) anyFloor = true;
    if (gc.n.y > 0.6) anyStrongUpNormal = true;
  }
  if (anyFloor) {
    this._grounded = true;
    this._groundedTime = 0.15;
    if (anyStrongUpNormal && this.velocity) {
      this.velocity.x *= 0.85;
      this.velocity.z *= 0.85;
    }
  }

  /* ---- Crash check (pre-impulse approach speed) ---- */
  if (this.armed) {
    var cfg = (window.CFG) || (typeof CFG !== 'undefined' ? CFG : {}) || {};
    var crashSpd = cfg.crashSpeed || 7.0;
    var hitSpd   = cfg.hitSpeed   || 6.0;
    if ((anyUpwardNormal && maxApproach > crashSpd) || maxApproach > hitSpd) {
      if (typeof this.crash === 'function') this.crash();
    }
  }

  /* ---- Safety cap: prevent runaway spin from extreme contacts ---- */
  var avLen = this.angVel.length();
  if (avLen > 25) this.angVel.multiplyScalar(25 / avLen);

  /* ---- Debug (first 3 collisions only) ---- */
  if (this._bvhLogCount < 3) {
    console.log('[BVH collide]', contacts.length, 'contacts,',
      'maxApproach', maxApproach.toFixed(2),
      'world', worldPos.x.toFixed(2), worldPos.y.toFixed(2), worldPos.z.toFixed(2));
    this._bvhLogCount++;
  }
};

Drone.prototype._collide = function() {
  this._grounded = false;
  this._ensureBVH();
  if (this.collisionBVH) {
    // Respawn if far below world
    if (this.position.y < -50 && this.armed) {
      if (typeof this._respawn === 'function') this._respawn();
      else if (typeof this.respawn === 'function') this.respawn();
      else if (typeof this.reset === 'function') this.reset();
      return;
    }
    // BVH triangles are the sole source of truth (mesh ground included)
    this._collideBVH();
    return;
  }

    const floor = this.getFloorY(this.position.x, this.position.z);

    if (this.position.y < floor) {
      const vyImpact = -this.velocity.y;
      const depth = floor - this.position.y;

      this.position.y = floor;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.velocity.x *= 0.82;
      this.velocity.z *= 0.82;
      this._grounded = true;
      this._groundedTime = 0.15;

      if (this.armed && (vyImpact > CFG.crashSpeed || depth > (CFG.depthCrash || 1.5))) {
        this.crash();
      }
    }

    const cols = this.colliderIndex
      ? this.colliderIndex.query(this.position.x, this.position.z)
      : this.colliders;
    const py = this.position.y;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.type === 'box') this._collideBox(c);
      else {
        if (py > c.h) continue;
        if (c.yMin !== undefined && py < c.yMin) continue;
        this._collideCyl(c);
      }
    }
  };

  Drone.prototype._collideCyl = function (c) {
    const dx = this.position.x - c.x;
    const dz = this.position.z - c.z;
    const rr = c.r + 0.06;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return;

    const d = Math.sqrt(d2) || 1e-4;
    const nx = dx / d, nz = dz / d;
    this.position.x = c.x + nx * rr;
    this.position.z = c.z + nz * rr;

    const vn = this.velocity.x * nx + this.velocity.z * nz;
    if (vn < 0) {
      const _tvx = this.velocity.x - nx * vn;
      const _tvz = this.velocity.z - nz * vn;
      const _tangSpeed = Math.sqrt(_tvx*_tvx + _tvz*_tvz);
      this.velocity.x -= vn * nx * 1.35;
      this.velocity.z -= vn * nz * 1.35;
      // Yaw tumble from a glancing hit on a vertical cylinder.
      if (this.angVel && _tangSpeed > 0.5) {
        const _ay = nz * _tvx - nx * _tvz;
        if (Math.abs(_ay) > 1e-4) {
          this.angVel.y += Math.sign(_ay) * Math.min(6.0, _tangSpeed * 0.5);
        }
      }
      if (this.armed && -vn > CFG.hitSpeed) this.crash();
    }
  };

  Drone.prototype._collideBox = function (c) {
    const cs = c.cos, sn = c.sin;
    const dx = this.position.x - c.x;
    const dz = this.position.z - c.z;
    const lx = dx * cs - dz * sn;
    const lz = dx * sn + dz * cs;
    const hw = c.w * 0.5 + 0.06;
    const hd = c.d * 0.5 + 0.06;

    if (lx < -hw || lx > hw || lz < -hd || lz > hd) return;

    if (this.position.y >= c.h) {
      if (this.position.y < c.h + CFG.groundY && this.velocity.y < 0) {
        this.position.y = c.h + CFG.groundY;
        if (this.velocity.y < 0) {
          const impact = -this.velocity.y;
          this.velocity.y = 0;
          this.velocity.x *= 0.85;
          this.velocity.z *= 0.85;
          this._grounded = true;
          this._groundedTime = 0.15;
          if (this.armed && impact > CFG.crashSpeed) this.crash();
        }
      }
      return;
    }

    if (this.position.y < (c.yMin || 0)) return;

    const penX = hw - Math.abs(lx);
    const penZ = hd - Math.abs(lz);
    let nLx = 0, nLz = 0, push;
    if (penX < penZ) { nLx = lx >= 0 ? 1 : -1; push = penX; }
    else             { nLz = lz >= 0 ? 1 : -1; push = penZ; }

    const nx =  nLx * cs + nLz * sn;
    const nz = -nLx * sn + nLz * cs;
    this.position.x += nx * (push + 0.01);
    this.position.z += nz * (push + 0.01);

    const vn = this.velocity.x * nx + this.velocity.z * nz;
    if (vn < 0) {
      const _tvx = this.velocity.x - nx * vn;
      const _tvz = this.velocity.z - nz * vn;
      const _tangSpeed = Math.sqrt(_tvx*_tvx + _tvz*_tvz);
      this.velocity.x -= vn * nx * 1.35;
      this.velocity.z -= vn * nz * 1.35;
      // Yaw tumble from a glancing hit on a box side.
      if (this.angVel && _tangSpeed > 0.5) {
        const _ay = nz * _tvx - nx * _tvz;
        if (Math.abs(_ay) > 1e-4) {
          this.angVel.y += Math.sign(_ay) * Math.min(6.0, _tangSpeed * 0.5);
        }
      }
      if (this.armed && -vn > CFG.hitSpeed) this.crash();
    }
  };

  return Drone;
})();
