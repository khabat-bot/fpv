/* =========================================================================
   physics.js — rate-based acro quad, with v5 physics polish:
     • realistic LiPo discharge curve + current-based sag with smoothing
     • motor desync kicks on rapid throttle changes at high throttle
     • windmill braking at low throttle / high speed
     • ground-effect wobble when close to terrain
     • motor/ESC lag + rotor inertia (thrust and rate commands ramp)
     • optional 6-DOF plant: rate error → motor torque → inertia tensor,
       with gyro drift on the rate estimate (CFG.physics.sixDof)
     • full rotor plant (default, CFG.physics.model 'ROTOR'): four motor
       speeds → per-prop thrust (Ct(J), ∝ RPM² below the static point) and
       reaction torque (Cq(J)) → rigid-body inertia, with the ESC
       spin-up/down lag, advance-ratio loss with airspeed, a geometric
       mixer, mixer saturation, gyroscopic coupling and thrust-based
       current draw
     • ground / wall / ceiling effect in the rotor plant: a per-prop thrust
       multiplier from that prop's height above the surface under it
       (cushion then recirculation at the pad) plus an airframe-level wall
       and ceiling push
     • progressive damage: staged thrust/authority loss, asymmetric thrust
       from a dead corner, and a tremor that grows with the damage
   ========================================================================= */
'use strict';

window.Drone = (function () {

  const DEG = Math.PI / 180;

  function curve(x, expo) {
    const c = x < -1 ? -1 : (x > 1 ? 1 : x);
    return (1 - expo) * c + expo * c * c * c;
  }

  /* Prop coefficients relative to the static point, as a function of the
     advance ratio J = V_axial / (n·D). J > 0 is inflow along the thrust
     axis — a climb, or forward flight once the airframe is tilted — and
     Ct falls toward zero at jZero while the drag torque rises. J < 0 is
     descent into the disc: a slow descent gains a little thrust because
     the prop is windmilling into clean air, but around J ≈ -0.25 the prop
     sits in its own wake (vortex-ring state), where it loses ~30 % until
     the descent is fast enough to leave the ring. */
  function propCtFactor(J, a) {
    if (J >= 0) return Math.max(0, 1 - J / a.jZero);
    const u = -J;
    const dip = Math.exp(-0.5 * Math.pow((u - a.vrsCenter) / a.vrsWidth, 2));
    return Math.min(a.ctRevMax, (1 + a.ctRevGain * u) * (1 - a.vrsDepth * dip));
  }

  function propCqFactor(J, a) {
    const f = (J >= 0) ? (1 + a.cqSlope * J) : (1 + a.cqRevSlope * -J);
    return Math.min(a.cqMax, f);
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
    this._bodyVel = new THREE.Vector3();   /* world velocity in body axes */
    this._qInv    = new THREE.Quaternion();

    this._wobAmp = 0;
    this._wobPhase = 0;
    this._prevThrottle = 0;
    this._grounded = false;
    this._groundedTime = 0;
    this._sphereScale = 1.0;   /* collision-envelope multiplier — set by Loadout.apply() */
    this._packDeadLatched = false;  /* latches on first cutoff, cleared by reset() */

    /* Motor / ESC state — the rotor does not change speed instantly. */
    this._thrustState = 0;                     /* N actually produced   */

    /* Rotor plant (CFG.physics.model 'ROTOR'): four motor speeds as a
       fraction of full RPM, the real RPM for telemetry, and the body
       angular momentum they carry. Motor order is FR, FL, RR, RL. */
    this._rotorState = [0, 0, 0, 0];
    this.rotorRpm = [0, 0, 0, 0];
    this._ratePrev = new THREE.Vector3();   /* filtered gyro derivative */
    this._rateDeriv = new THREE.Vector3();
    this._tgtDeriv = new THREE.Vector3();   /* filtered setpoint derivative */
    this._pidTgtPrev = new THREE.Vector3(); /* setpoint of the last step */
    this._pidI = new THREE.Vector3();       /* integrated rate error (rad) */
    this._pidFf = new THREE.Vector3();      /* feedforward demand (rad/s²) */
    this._collPrev = 0;                     /* last collective - anti-gravity */
    this._agBoost = 0;                      /* anti-gravity collective kick */
    this._mixerSat = 0;                     /* mixer clipped last step      */
    this._proxAccel = new THREE.Vector3();  /* ground/wall/ceiling push      */
    this._rateTarget  = new THREE.Vector3();   /* lagged rate command   */
    this._gyroBias    = new THREE.Vector3();   /* rad/s — 6-DOF drift   */
    this._gyroMeas    = new THREE.Vector3();   /* angVel + gyro bias    */
    this._gyroPhase   = Math.random() * 100;   /* drift re-seeded on reset */

    /* Graded damage — the airframe survives the flight, cleared by reset().
       stage 0 = clean, 1..N = CFG.crashSeverity.stages; `corner` is the arm
       whose motor is down (0..3) and drives the asymmetric thrust. */
    this.damage = { stage: 0, arm: false, corner: 0 };
    this._dmgCooldown = 0;
    this.crashSeverity = 0;    /* 0..1, set by crash(impactSpeed) */
    this.onDamage = null;      /* main.js hooks a sound/flash onto this */

    this.reset(0, 0);
  }

  Drone.prototype.getFloorY = function () { return CFG.groundY; };

  /* Air density ratio vs the sea-level standard the model is tuned for.
     ISA troposphere: p = p0 (1 - 2.25577e-5 h)^5.25588, T = T0 - 0.0065 h,
     rho = p / (R T). Cold, low air is dense (more thrust); hot, high air is
     thin (the quad feels gutless, drag drops too). */
  Drone.prototype._airDensityRatio = function (altitude) {
    const env = CFG.environment || {};
    if (env.density === false) return 1.0;
    const h  = (typeof altitude === 'number' && isFinite(altitude)) ? Math.max(0, altitude) : 0;
    const p0 = (env.seaLevelPressure != null) ? env.seaLevelPressure : 101325;
    const tC = (env.tempC != null) ? env.tempC : 15;
    const t0 = tC + 273.15;
    const lapse = 1 - 2.25577e-5 * h;
    if (lapse <= 0) return 0;   /* above the troposphere — no air */
    const p = p0 * Math.pow(lapse, 5.25588);
    const t = Math.max(180, t0 - 0.0065 * h);
    const rho = p / (287.05 * t);
    return Math.max(0, rho / 1.225);
  };

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
    this.damage.stage = 0;
    this.damage.arm = false;
    this.damage.corner = 0;
    this.crashSeverity = 0;
    this._dmgCooldown = 0;

    this._thrustState = 0;
    this._rotorState[0] = this._rotorState[1] = 0;
    this._rotorState[2] = this._rotorState[3] = 0;
    this.rotorRpm[0] = this.rotorRpm[1] = 0;
    this.rotorRpm[2] = this.rotorRpm[3] = 0;
    this._ratePrev.set(0, 0, 0);
    this._rateDeriv.set(0, 0, 0);
    this._tgtDeriv.set(0, 0, 0);
    this._pidTgtPrev.set(0, 0, 0);
    this._pidI.set(0, 0, 0);
    this._pidFf.set(0, 0, 0);
    this._collPrev = 0;
    this._agBoost = 0;
    this._mixerSat = 0;
    this._rateTarget.set(0, 0, 0);
    this._gyroBias.set(0, 0, 0);
    this._gyroMeas.set(0, 0, 0);
    this._gyroPhase = Math.random() * 100;

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

  /* Grade the hit so the rest of the sim can react to how hard it was.
     Between crashSpeed and fatalSpeed the airframe is wrecked but the VTX
     is assumed to survive; at/above fatalSpeed the video feed dies with it. */
  Drone.prototype.crash = function (impactSpeed) {
    if (this.crashed) return;
    this.crashed = true;
    this.armed = false;

    var sev = (window.CFG && CFG.crashSeverity) || {};
    var base = (CFG.crashSpeed != null) ? CFG.crashSpeed : 7.0;
    var fatal = (sev.fatalSpeed != null) ? sev.fatalSpeed : 15.0;
    var s = 0;
    if (typeof impactSpeed === 'number' && isFinite(impactSpeed) && impactSpeed > base) {
      s = (impactSpeed - base) / Math.max(0.1, fatal - base);
    }
    this.crashSeverity = Math.max(0, Math.min(1, s));
  };

  /* Single entry point for every collision path: nothing, a broken arm
     (keep flying), or a crash. Speeds are pre-impulse approach speeds in
     m/s, so the thresholds mean what they say. */
  Drone.prototype.impact = function (speed, depth) {
    var sev = (window.CFG && CFG.crashSeverity) || {};
    var spd = (typeof speed === 'number' && isFinite(speed)) ? speed : 0;
    var pen = (typeof depth === 'number' && isFinite(depth)) ? depth : 0;
    var crashSpd = (CFG.crashSpeed != null) ? CFG.crashSpeed : 7.0;
    var dmgSpd = (sev.damageSpeed != null) ? sev.damageSpeed : 4.5;

    if (spd > crashSpd || pen > (CFG.depthCrash || 1.5)) {
      this.crash(spd);
      return 'crash';
    }
    if (spd < dmgSpd) return 'none';

    /* Escalate one stage per hit. Hits inside the cooldown still register
       as damage but do not stack — otherwise one ground scrape (many
       contact frames in a row) would total the airframe instantly. */
    var stages = sev.stages || [];
    var maxStage = (stages.length > 1) ? stages.length - 1 : 1;
    var stage = this.damage.stage || 0;
    if (stage < 1 && this.damage.arm) stage = 1;   /* legacy flag */
    if ((this._dmgCooldown > 0) || stage >= maxStage) return 'none';

    this.damage.stage = stage + 1;
    this.damage.arm = true;
    this.damage.corner = Math.floor(Math.random() * 4);
    this._dmgCooldown = (sev.damageCooldown != null) ? sev.damageCooldown : 0.35;
    if (typeof this.onDamage === 'function') {
      try { this.onDamage(spd, this.damage.stage); } catch (e) {}
    }
    return 'damage';
  };

  /* Full-throttle rotor speed. js/parts.js publishes the loadout's prop
     model (KV, cell count, prop geometry, motor torque limit), so the
     rotor plant follows the selected parts; CFG.physics.rotor.maxRpm is
     only the fallback when no loadout has been applied. */
  Drone.prototype._rotorMaxRpm = function () {
    const l = (typeof window !== 'undefined') ? window.__loadout : null;
    const info = l && l.effective && l.effective.thrustInfo;
    if (info && isFinite(info.rpm) && info.rpm > 0) return info.rpm;
    const r = (CFG.physics && CFG.physics.rotor) || {};
    return (r.maxRpm != null) ? r.maxRpm : 28000;
  };

  /* Advance-ratio model for the rotor plant. js/parts.js derives the
     per-prop shape (diameter, zero-thrust advance ratio, Cq slope) from
     the selected prop and publishes it on the loadout's thrustInfo, so a
     smaller or higher-pitch prop behaves differently at speed. The values
     here are the 5.1×4.0×3 defaults and the fallback when no loadout has
     been applied; the shared curve shape (reverse-inflow gain, VRS band)
     is in CFG.physics.rotor.advance. */
  Drone.prototype._rotorAdvance = function () {
    const r = (CFG.physics && CFG.physics.rotor) || {};
    const adv = r.advance || {};
    const out = {
      enabled:   adv.enabled !== false,
      diameterM: (adv.diameterM  != null) ? adv.diameterM  : 0.12954,
      jZero:     (adv.jZero      != null) ? adv.jZero      : 1.4,
      cqSlope:   (adv.cqSlope    != null) ? adv.cqSlope    : 0.65,
      ctRevGain: (adv.ctRevGain  != null) ? adv.ctRevGain  : 0.5,
      ctRevMax:  (adv.ctRevMax   != null) ? adv.ctRevMax   : 1.15,
      vrsCenter: (adv.vrsCenter  != null) ? adv.vrsCenter  : 0.25,
      vrsWidth:  (adv.vrsWidth   != null) ? adv.vrsWidth   : 0.11,
      vrsDepth:  (adv.vrsDepth   != null) ? adv.vrsDepth   : 0.30,
      cqRevSlope:(adv.cqRevSlope != null) ? adv.cqRevSlope : 0.35,
      cqMax:     (adv.cqMax      != null) ? adv.cqMax      : 1.8
    };
    const l = (typeof window !== 'undefined') ? window.__loadout : null;
    const info = l && l.effective && l.effective.thrustInfo;
    const aero = info && info.aero;
    if (aero) {
      if (aero.diameterM > 0)    out.diameterM = aero.diameterM;
      if (aero.jZero > 0)        out.jZero     = aero.jZero;
      if (aero.cqSlope != null)  out.cqSlope   = aero.cqSlope;
    }
    return out;
  };

  /* Relative Ct and Cq at an advance ratio. Exposed for tests/telemetry. */
  Drone.prototype._propAxialFactors = function (J) {
    const a = this._rotorAdvance();
    return { ct: propCtFactor(J, a), cq: propCqFactor(J, a), jZero: a.jZero };
  };

  /* Ground / wall / ceiling tunables with fallbacks. */
  Drone.prototype._proximityCfg = function () {
    const r = (CFG.physics && CFG.physics.rotor) || {};
    const p = r.proximity || {};
    const g = p.ground || {}, w = p.wall || {}, c = p.ceiling || {};
    return {
      enabled: (p.enabled !== false),
      ground: {
        reach:      (g.reach      != null) ? g.reach      : 2.0,
        gainMax:    (g.gainMax    != null) ? g.gainMax    : 0.28,
        peakHeight: (g.peakHeight != null) ? g.peakHeight : 0.25,
        recircLoss: (g.recircLoss != null) ? g.recircLoss : 0.45,
        discLoading:(g.discLoading!= null) ? g.discLoading: 0.5
      },
      wall: {
        reach: (w.reach != null) ? w.reach : 1.25,
        gain:  (w.gain  != null) ? w.gain  : 0.06,
        push:  (w.push  != null) ? w.push  : 0.35
      },
      ceiling: {
        reach: (c.reach != null) ? c.reach : 1.0,
        loss:  (c.loss  != null) ? c.loss  : 0.25,
        suck:  (c.suck  != null) ? c.suck  : 0.12
      },
      maxPush: (p.maxPush != null) ? p.maxPush : 12
    };
  };

  /* Extra thrust fraction for a disc `hRatio` rotor radii above a surface
     (ground or wall). Zero at `reach`, rising as the surface gets closer
     (~(1 - h/reach)², the shape of the source-sink ground-effect model).
     Inside `peakHeight` the outflow has nowhere to go and recirculates, so
     the gain rolls back toward the pad — the cushion-then-suck-down
     transition. A slowly turning disc carries little induced velocity to
     constrain, so `discLoading` blends the whole effect out at low RPM.
     Exposed for tests/telemetry. */
  Drone.prototype._groundEffectGain = function (hRatio, loadFrac, ground) {
    const g = ground || this._proximityCfg().ground;
    if (!(hRatio >= 0) || !(g.reach > 0)) return 0;
    if (hRatio >= g.reach) return 0;
    const close = 1 - hRatio / g.reach;
    let extra = g.gainMax * close * close;
    const peak = Math.max(1e-3, g.peakHeight);
    if (hRatio < peak) {
      /* Recirculation eats part of the cushion again at the pad. */
      extra *= 1 - g.recircLoss * (1 - hRatio / peak);
    }
    const dl = Math.max(0, Math.min(1, g.discLoading));
    const load = (loadFrac != null) ? Math.max(0, Math.min(1, loadFrac)) : 1;
    return extra * ((1 - dl) + dl * load);
  };

  /* Nearest vertical surface (wall) and overhead surface (ceiling) within
     `reach` of the airframe, from the same colliders the flight model
     already collides with. Walls are the vertical faces of a box or the
     side of a cylinder; the normal points away from the surface. Boxes
     carry a rotation (cos/sin) and a vertical span `yMin..h`, and only
     their underside is a ceiling. */
  Drone.prototype._surfaceProximity = function (reach) {
    const out = { wallDist: Infinity, wallNx: 0, wallNz: 0, ceilGap: Infinity };
    const cols = this.colliders ||
      ((typeof window !== 'undefined' && window.__world && window.__world.colliders) || null);
    if (!cols || !cols.length) return out;
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    /* Only nearby colliders matter; the spatial index makes that cheap. */
    const list = (this.colliderIndex && typeof this.colliderIndex.query === 'function')
      ? this.colliderIndex.query(px, pz)
      : cols;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c) continue;
      const top = (c.h != null) ? c.h : Infinity;
      const bot = (c.yMin != null) ? c.yMin : 0;
      if (c.type === 'box') {
        const cs = c.cos || 0, sn = c.sin || 0;
        const dx = px - c.x, dz = pz - c.z;
        const lx = dx * cs - dz * sn;
        const lz = dx * sn + dz * cs;
        const hw = (c.w || 0) * 0.5, hd = (c.d || 0) * 0.5;
        const insideXZ = Math.abs(lx) <= hw && Math.abs(lz) <= hd;
        /* Wall: outside the footprint, inside the vertical span. */
        if (!insideXZ && py <= top + reach && py >= bot - reach) {
          const ex = Math.max(Math.abs(lx) - hw, 0);
          const ez = Math.max(Math.abs(lz) - hd, 0);
          const d = Math.sqrt(ex * ex + ez * ez);
          if (d <= reach && d < out.wallDist) {
            let nlx = 0, nlz = 0;
            if (ex >= ez) nlx = (lx >= 0) ? 1 : -1;
            else          nlz = (lz >= 0) ? 1 : -1;
            out.wallDist = d;
            out.wallNx =  nlx * cs + nlz * sn;
            out.wallNz = -nlx * sn + nlz * cs;
          }
        }
        /* Ceiling: under the box's underside. */
        const gap = bot - py;
        if (gap > 0.01 && gap <= reach &&
            Math.abs(lx) <= hw + reach && Math.abs(lz) <= hd + reach) {
          if (gap < out.ceilGap) out.ceilGap = gap;
        }
      } else {
        const dx = px - c.x, dz = pz - c.z;
        const rad = Math.sqrt(dx * dx + dz * dz);
        const d = rad - (c.r || 0);
        if (d > 0 && d <= reach && py <= top + reach && py >= bot - reach) {
          if (d < out.wallDist) {
            out.wallDist = d;
            out.wallNx = dx / Math.max(1e-4, rad);
            out.wallNz = dz / Math.max(1e-4, rad);
          }
        }
      }
    }
    return out;
  };

  /* Thrust the motors are being asked for (N). Shared by every plant, so
     easy-mode altitude hold and acro collective are identical in all
     three physics models. */
  Drone.prototype._collectiveThrust = function (thr, easyActive, maxThrustNow, packDead) {
    if (packDead) return 0;
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

      /* Thrust needed so that (thrust * up.y / mass) - gravity = azCmd.
         up.y is clamped to avoid blow-up if momentarily inverted. */
      const upY = Math.max(0.3, this._up.y);
      const thrustNeeded = (azCmd + CFG.gravity) / upY * CFG.mass;
      /* Motor stall: props jammed against ground when inverted. Real ESCs
         detect stall (high current, zero RPM) and cut the motor. */
      const stalled = (this._up.y < 0.35) && ((this._groundedTime || 0) > 0);
      return stalled ? 0 : Math.max(0, Math.min(maxThrustNow, thrustNeeded));
    }
    /* ===== ACRO MODE ================================================ */
    /* Motor stall: props jammed against ground when inverted. */
    const stalled = (this._up.y < 0.35) && ((this._groundedTime || 0) > 0);
    return (stalled ? 0 : thr) * maxThrustNow;
  };

  /* ===== rotor plant (CFG.physics.model 'ROTOR') =====================
     One step of a physical quadcopter: rate error → body torque demand →
     motor mixer → per-motor RPM through the ESC/motor lag → per-prop
     thrust (∝ RPM²) and reaction torque → rigid-body angular
     acceleration. Roll/pitch/yaw authority, saturation at low
     collective, yaw lag and the inertia asymmetry all fall out of the
     geometry instead of being tuned in. */
  Drone.prototype._stepRotors = function (dt, collectiveThrust, maxThrustNow) {
    const pc = CFG.physics || {};
    const rc = pc.rotor || {};
    const pid = rc.pid || {};
    const arm      = (rc.arm      != null) ? rc.arm      : 0.078;
    const qLen     = (rc.torqueLength != null) ? rc.torqueLength : 0.0125;
    const spinUp   = (rc.spinUp   != null) ? rc.spinUp   : 0.045;
    const spinDown = (rc.spinDown != null) ? rc.spinDown : 0.090;
    const Jrot     = (rc.rotorInertia != null) ? rc.rotorInertia : 2.2e-5;
    const rpmMax   = this._rotorMaxRpm();

    /* Axial inflow is measured in the body frame, so angle of attack is
       already in it: a tilted quad at speed sees air along its disc axes
       the way its props do. */
    const adv = this._rotorAdvance();
    const advOn = adv.enabled && adv.diameterM > 0;
    this._qInv.copy(this.quat).invert();
    this._bodyVel.copy(this.velocity).applyQuaternion(this._qInv);

    /* Ground / wall / ceiling proximity. Ground effect is per prop (its own
       height above the surface below it), so a tilted airframe gains more
       thrust on its low side. Walls and ceilings are evaluated for the
       airframe, then applied to every disc plus a body push: a disc near a
       wall has nowhere to throw its outwash, so the reaction shoves the
       airframe away, and a disc under a ceiling loses thrust to its
       starved inlet while the low pressure pulls the airframe up. */
    const prox = this._proximityCfg();
    const proxOn = prox.enabled;
    const Rrot = Math.max(0.01, adv.diameterM * 0.5);
    let wallGain = 1, wallPush = 0, wallNx = 0, wallNz = 0;
    let ceilFactor = 1, ceilSuck = 0;
    if (proxOn && prox.ground.reach > 0) {
      const reach = Math.max(Rrot * prox.ground.reach +
                            this._sphereScale * Rrot,
                            prox.wall.reach * adv.diameterM,
                            prox.ceiling.reach * adv.diameterM);
      const sp = this._surfaceProximity(reach);
      const wr = prox.wall.reach * adv.diameterM;
      if (wr > 1e-6 && isFinite(sp.wallDist) && sp.wallDist < wr) {
        const k = 1 - sp.wallDist / wr;
        wallGain = 1 + prox.wall.gain * k * k;
        wallPush = prox.wall.push * k * k;
        wallNx = sp.wallNx;
        wallNz = sp.wallNz;
      }
      const cr = prox.ceiling.reach * adv.diameterM;
      if (cr > 1e-6 && isFinite(sp.ceilGap) && sp.ceilGap < cr) {
        const k = 1 - sp.ceilGap / cr;
        ceilFactor = Math.max(0, 1 - prox.ceiling.loss * k * k);
        ceilSuck = prox.ceiling.suck * k * k;
      }
    }

    /* Body axes: X = pitch, Y = yaw, Z = roll. CFG.physics.inertia is
       documented per airframe axis, so map it onto the sim's axes. */
    const I = pc.inertia || {};
    const Ipitch = (I.pitch != null) ? I.pitch : 0.0056;
    const Iyaw   = (I.yaw   != null) ? I.yaw   : 0.0085;
    const Iroll  = (I.roll  != null) ? I.roll  : 0.0042;

    const maxT = Math.max(1e-6, maxThrustNow);
    /* Disarmed: the ESC cuts the motors, so no mixer output reaches them
       (a real FC also stops driving them, even against gyro bias). */
    const collective = this.armed
      ? Math.max(0, Math.min(1, collectiveThrust / maxT))
      : 0;

    /* Anti-gravity: a throttle jab adds a short collective kick so the
       quad starts climbing before the I-term has wound up. Without it a
       PID that is stable in a hover sags through every punch-out, which
       is exactly why Betaflight has the feature. The kick decays in a
       few tens of ms and never lifts an idle, un-asked-for throttle. */
    const agGain  = (pid.antiGravity != null) ? Math.max(0, pid.antiGravity) : 0.35;
    const agDecay = Math.max(1e-3, (pid.antiGravityDecay != null) ? pid.antiGravityDecay : 0.06);
    if (agGain > 0 && dt > 1e-9) {
      const dCol = collective - this._collPrev;
      if (dCol > 0) {
        this._agBoost = Math.min(0.25, (this._agBoost || 0) + dCol * agGain);
      }
    }
    this._collPrev = collective;
    if (!this.armed) this._agBoost = 0;
    if (this._agBoost) {
      this._agBoost *= Math.exp(-dt / agDecay);
      if (this._agBoost < 1e-4) this._agBoost = 0;
    }

    /* Gyro bias: the FC reads a slowly wandering offset, exactly as in
       the 6-DOF plant. */
    const gd = (pc.gyroDrift != null) ? pc.gyroDrift : 0;
    if (gd > 0) {
      const gt = (this._windTime || 0) + (this._gyroPhase || 0);
      this._gyroBias.set(
        Math.sin(gt * 0.31) * gd,
        Math.sin(gt * 0.23 + 2.1) * gd * 0.8,
        Math.sin(gt * 0.19 + 4.2) * gd * 0.6
      );
    } else {
      this._gyroBias.set(0, 0, 0);
    }
    const meas = this._gyroMeas.copy(this.angVel).add(this._gyroBias);

    /* ===== rate PID ==================================================
       A real FC does not turn a rate error into a torque. It runs a
       per-axis PID on the gyro rate:
         P   proportional to the error, the workhorse
         I   trims out anything steady — a CG offset, a bent or damaged
             prop, a steady wind. Without it a quad flies with a permanent
             attitude/rate offset no matter how well P is tuned.
         D   damps the approach to the target. It differentiates the
             MEASURED rate, not the error, so a stick step does not kick
             it, and the result is low-pass filtered because differentiating
             a gyro is differentiating noise.
         FF  feeds the setpoint's own rate of change forward, so a stick
             step starts the motors before the error has built up.
       The output stays an angular-acceleration demand, so the sticks are
       still calibrated against CFG.angResponse and the inertia tensor
       below turns the demand into a torque. */
    const kpGain = ((pid.kp != null) ? pid.kp : 1) / CFG.angResponse;
    const kiGain = (pid.ki != null) ? Math.max(0, pid.ki) : 25;
    const kdGain = (pid.kd != null) ? Math.max(0, pid.kd) : 0.030;
    const ffGain = (pid.ff != null) ? Math.max(0, pid.ff) : 0.012;
    const dLpf   = Math.max(1e-4, (pid.dLpf != null) ? pid.dLpf : 0.010);
    const ffLpf  = Math.max(1e-4, (pid.ffLpf != null) ? pid.ffLpf : 0.020);
    const itLimit = (pid.itermLimit != null) ? Math.max(0, pid.itermLimit) : 0.55;
    const itRelax = (pid.itermRelax != null) ? Math.max(0, Math.min(1, pid.itermRelax)) : 0.75;
    const itCut   = Math.max(1e-3, (pid.itermRelaxCutoff != null) ? pid.itermRelaxCutoff : 90);
    const itSatRelax = (pid.itermSatRelax != null) ? Math.max(0, Math.min(1, pid.itermSatRelax)) : 1;

    const ex = this._rateTarget.x - meas.x;
    const ey = this._rateTarget.y - meas.y;
    const ez = this._rateTarget.z - meas.z;

    /* Both derivatives are first-order low-passed: the setpoint one for
       feedforward, the gyro one for the D-term. */
    const dTgt  = this._tgtDeriv;
    const dGyro = this._rateDeriv;
    if (dt > 1e-9) {
      const fD  = 1 - Math.exp(-dt / dLpf);
      const fFf = 1 - Math.exp(-dt / ffLpf);
      dTgt.x  += ((this._target.x - this._pidTgtPrev.x) / dt - dTgt.x)  * fFf;
      dTgt.y  += ((this._target.y - this._pidTgtPrev.y) / dt - dTgt.y)  * fFf;
      dTgt.z  += ((this._target.z - this._pidTgtPrev.z) / dt - dTgt.z)  * fFf;
      dGyro.x += ((meas.x - this._ratePrev.x) / dt - dGyro.x) * fD;
      dGyro.y += ((meas.y - this._ratePrev.y) / dt - dGyro.y) * fD;
      dGyro.z += ((meas.z - this._ratePrev.z) / dt - dGyro.z) * fD;
    }
    this._pidTgtPrev.copy(this._target);
    this._ratePrev.copy(meas);

    /* I-term with iterm relax: while the setpoint is slewing fast the
       integral is suppressed, so a stick step does not leave a wound-up
       I-term to unwind after the quad has already got there (that unwind
       is the overshoot real FCs tune out with iterm_relax). The integral
       is clamped in torque-authority terms, not in error-seconds, so at
       saturation it can never grow past `itermLimit` of the available
       angular acceleration. */
    const it = this._pidI;
    const satScale = 1 - itSatRelax * this._mixerSat;
    if (this.armed && dt > 1e-9 && satScale > 0) {
      const rx = Math.abs(dTgt.x), ry = Math.abs(dTgt.y), rz = Math.abs(dTgt.z);
      const sx = satScale * ((rx <= itCut) ? 1 : Math.max(0, 1 - itRelax * Math.min(1, (rx - itCut) / itCut)));
      const sy = satScale * ((ry <= itCut) ? 1 : Math.max(0, 1 - itRelax * Math.min(1, (ry - itCut) / itCut)));
      const sz = satScale * ((rz <= itCut) ? 1 : Math.max(0, 1 - itRelax * Math.min(1, (rz - itCut) / itCut)));
      it.x += ex * dt * sx;
      it.y += ey * dt * sy;
      it.z += ez * dt * sz;
      if (kiGain > 1e-9) {
        const maxI = (CFG.angAccelMax * itLimit) / kiGain;
        it.x = Math.max(-maxI, Math.min(maxI, it.x));
        it.y = Math.max(-maxI, Math.min(maxI, it.y));
        it.z = Math.max(-maxI, Math.min(maxI, it.z));
      } else {
        it.set(0, 0, 0);
      }
    } else if (!this.armed) {
      it.set(0, 0, 0);
    }

    /* P + I + FF − D, per axis, in angular-acceleration units. */
    const ff = this._pidFf.set(ffGain * dTgt.x, ffGain * dTgt.y, ffGain * dTgt.z);
    let ax = kpGain * ex + kiGain * it.x - kdGain * dGyro.x + ff.x;
    let ay = kpGain * ey + kiGain * it.y - kdGain * dGyro.y + ff.y;
    let az = kpGain * ez + kiGain * it.z - kdGain * dGyro.z + ff.z;
    const aLen = Math.sqrt(ax * ax + ay * ay + az * az);
    if (aLen > CFG.angAccelMax && aLen > 1e-9) {
      const s = CFG.angAccelMax / aLen;
      ax *= s; ay *= s; az *= s;
    }
    const tqx = ax * Ipitch;
    const tqy = ay * Iyaw;
    const tqz = az * Iroll;

    /* Mixer. With motors at (±arm, ±arm), a roll differential δ gives
       τz = -maxT·arm·δ, a pitch differential τx = -maxT·arm·δ, and yaw
       comes from the prop reaction torque τy = -qLen·Σ spin·T. */
    /* X-frame motor layout: FR, FL, RR, RL. */
    const MX   = [ arm, -arm,  arm, -arm];
    const MZ   = [-arm, -arm,  arm,  arm];
    const SPIN = [1, -1, -1, 1];   /* diagonal pairs counter-rotate */

    let dRoll  = this.armed ? -tqz / (maxT * arm) : 0;
    let dPitch = this.armed ? -tqx / (maxT * arm) : 0;
    const dYawDemand = this.armed ? -tqy / (qLen * maxT) : 0;

    /* Damage: the dead corner's prop makes only (1 - asymmetry) of its
       thrust, so the airframe rolls/pitches toward that corner for real
       instead of through a scripted torque. */
    const sev = (CFG.crashSeverity) || {};
    const stages = sev.stages || [];
    let stage = (this.damage && typeof this.damage.stage === 'number') ? this.damage.stage : 0;
    if (stages.length && stage > stages.length - 1) stage = stages.length - 1;
    const st = stages[stage] || {};
    const asym = (stage > 0 && st.asymmetry != null) ? st.asymmetry : 0;
    const corner = (this.damage && typeof this.damage.corner === 'number') ? this.damage.corner : 0;
    const dmg = [1, 1, 1, 1];
    if (asym > 0 && corner >= 0 && corner < 4) dmg[corner] = 1 - asym;

    const airmode = (pid.airmode !== false);
    const airIdle = (pid.airmodeIdle != null) ? pid.airmodeIdle : 0.03;

    /* Mixer allocation. The three axes share one band of motor travel, and
       each motor command is the SUM of their demands. Clipping every motor
       on its own distorts the torque vector: a saturated yaw demand (yaw
       has by far the least authority, since it is only prop drag torque)
       turns into a diagonal thrust differential, which is a big roll/pitch
       torque nobody asked for. That is the airframe slowly rolling away
       after a yaw + roll/pitch input. So the mixer allocates instead of
       clipping:
         - roll/pitch take the band first, scaled together if they alone do
           not fit, so their direction is unchanged;
         - yaw gets only the band left over — the same priority a real
           mixer gives the strong axes. */
    const rp = [0, 0, 0, 0];
    let rpMin = Infinity, rpMax = -Infinity;
    for (let i = 0; i < 4; i++) {
      rp[i] = dRoll * (-MX[i] / arm) + dPitch * (MZ[i] / arm);
      if (rp[i] < rpMin) rpMin = rp[i];
      if (rp[i] > rpMax) rpMax = rp[i];
    }
    let allocSat = 0;
    if (rpMax - rpMin > 1) {
      const k = 1 / (rpMax - rpMin);
      dRoll *= k;
      dPitch *= k;
      rpMin = Infinity; rpMax = -Infinity;
      for (let i = 0; i < 4; i++) {
        rp[i] = dRoll * (-MX[i] / arm) + dPitch * (MZ[i] / arm);
        if (rp[i] < rpMin) rpMin = rp[i];
        if (rp[i] > rpMax) rpMax = rp[i];
      }
      allocSat = 1;
    }
    /* Airmode can lift the collective so the weakest motor still turns;
       that lift is what the band left for yaw is measured against. */
    const yawRoom = Math.max(0, (1 - airIdle - (rpMax - rpMin)) * 0.5);
    let dYaw = dYawDemand;
    if (Math.abs(dYaw) > yawRoom) {
      dYaw = (dYaw < 0) ? -yawRoom : yawRoom;
      allocSat = 1;
    }

    /* Airmode: a differential demand larger than the collective would
       drive a motor below zero and the mixer would clip it, so the quad
       loses that corner's torque — that is why a quad without airmode
       has no roll authority at zero throttle. Airmode holds the weakest
       motor at idle and lifts the collective to pay for the difference,
       so the differential survives the clamp. It sits behind the mixer:
       the mixer decides what the differential needs, airmode pays for it. */
    const diff = [0, 0, 0, 0];
    let minDiff = 0;
    for (let i = 0; i < 4; i++) {
      diff[i] = rp[i] + dYaw * SPIN[i];
      if (diff[i] < minDiff) minDiff = diff[i];
    }
    let collectiveOut = collective + (this._agBoost || 0);
    if (this.armed && airmode && minDiff < 0) {
      collectiveOut = Math.max(collectiveOut, airIdle - minDiff);
    }
    collectiveOut = Math.min(1, collectiveOut);

    let totalThrust = 0, sumX = 0, sumZ = 0, sumSpinT = 0, sumSpinOmega = 0;
    let clipped = 0;
    for (let i = 0; i < 4; i++) {
      const raw = collectiveOut + diff[i];
      let cmd = Math.max(0, Math.min(1, raw));
      if (cmd !== raw) clipped = 1;

      /* Motor + prop speed: first-order toward the commanded RPM. A
         modern ESC brakes the prop, so spin-down is no slower than
         spin-up (CFG.physics.rotor.spinUp / spinDown). */
      const target = Math.sqrt(cmd);
      const tau = (target > this._rotorState[i]) ? spinUp : spinDown;
      const k = (tau > 0) ? (1 - Math.exp(-dt / tau)) : 1;
      this._rotorState[i] += (target - this._rotorState[i]) * k;

      const n = this._rotorState[i];
      this.rotorRpm[i] = n * rpmMax;

      /* Static thrust reference for this motor. The advance-ratio factors
         scale it: Ct(J) decides how much of that thrust the disc actually
         makes, Cq(J) the drag torque it reacts against the airframe. The
         reaction torque uses the static reference, so it rises with inflow
         even while thrust falls, exactly as a real prop does. Below a few
         percent RPM the advance ratio is meaningless (J → ∞), so the disc
         keeps its static coefficients there. */
      const T0 = (maxT / 4) * n * n * dmg[i];
      let ctF = 1, cqF = 1;
      if (advOn && n > 0.01) {
        const nRev = n * rpmMax / 60;
        /* Air through the disc: body velocity plus the arm's own motion
           from body rotation (ω × r). */
        const vAx = this._bodyVel.y + this.angVel.z * MX[i] - this.angVel.x * MZ[i];
        const J = vAx / (nRev * adv.diameterM);
        ctF = propCtFactor(J, adv);
        cqF = propCqFactor(J, adv);
      }

      /* Ground effect for THIS prop: its height above whatever surface is
         under it, from the arm offset rotated into the world. The low-side
         props gain more when the airframe is tilted, which is a real torque
         on the body, not a scripted wobble. */
      let geF = 0;
      if (proxOn) {
        const off = this._tmpV.set(MX[i], 0, MZ[i]).applyQuaternion(this.quat);
        const hAbove = Math.max(0, (this.position.y + off.y) -
          this.getFloorY(this.position.x + off.x, this.position.z + off.z));
        geF = this._groundEffectGain(hAbove / Rrot, n * n, prox.ground);
      }

      const T = T0 * ctF * (1 + geF) * wallGain * ceilFactor;
      totalThrust += T;
      sumX += MX[i] * T;
      sumZ += MZ[i] * T;
      sumSpinT += SPIN[i] * T0 * cqF;
      sumSpinOmega += SPIN[i] * (this.rotorRpm[i] * Math.PI * 2 / 60);
    }

    /* Proximity push: the outwash a wall blocks reacts on the airframe, and
       a starved inlet under a ceiling pulls it in. Both scale with the
       thrust the discs are actually making, so an idle quad is not shoved
       around and a punch-out near a wall is. Capped in acceleration so a
       degenerate collider cannot fling the airframe. */
    const proxAcc = this._proxAccel;
    proxAcc.set(0, 0, 0);
    if (proxOn && this.armed && maxT > 1e-6) {
      const fPerMass = totalThrust / Math.max(1e-6, CFG.mass);
      if (wallPush > 0) {
        proxAcc.x += wallNx * fPerMass * wallPush;
        proxAcc.z += wallNz * fPerMass * wallPush;
      }
      proxAcc.y += fPerMass * ceilSuck;
      const pl = proxAcc.length();
      if (pl > prox.maxPush && pl > 1e-9) {
        proxAcc.multiplyScalar(prox.maxPush / pl);
      }
    }

    /* Rigid-body torques: motor moments, prop reaction, rotor gyroscopic
       coupling, then the body's own ω × Iω term. */
    let tx = -sumZ;
    let ty = -qLen * sumSpinT;
    let tz =  sumX;
    if (Jrot > 0) {
      const hy = Jrot * sumSpinOmega;          /* rotor momentum, body Y */
      tx += -this.angVel.z * hy;
      tz +=  this.angVel.x * hy;
    }
    tx -= this.angVel.y * Iroll * this.angVel.z - this.angVel.z * Iyaw * this.angVel.y;
    ty -= this.angVel.z * Ipitch * this.angVel.x - this.angVel.x * Iroll * this.angVel.z;
    tz -= this.angVel.x * Iyaw * this.angVel.y - this.angVel.y * Ipitch * this.angVel.x;

    let axx = tx / Ipitch;
    let ayy = ty / Iyaw;
    let azz = tz / Iroll;
    const aOut = Math.sqrt(axx * axx + ayy * ayy + azz * azz);
    if (aOut > CFG.angAccelMax && aOut > 1e-9) {
      const s2 = CFG.angAccelMax / aOut;
      axx *= s2; ayy *= s2; azz *= s2;
    }
    this.angVel.x += axx * dt;
    this.angVel.y += ayy * dt;
    this.angVel.z += azz * dt;

    this._thrustState = totalThrust;
    /* Remembered for the next step: conditional integration. An integrator
       that keeps adding error while the mixer is clipped only winds up
       torque the quad cannot deliver, and pays it back as overshoot. A
       real FC gets the same protection from running its loop far faster
       than the motors; this is the explicit version. */
    this._mixerSat = clipped || allocSat;
  };

  Drone.prototype.step = function (dt, input) {

    const thr = this.armed ? Math.max(0, Math.min(1, input.throttle)) : 0;
    this.throttleIn = thr;
    this._stepDt = dt;
    /* Plant selection. 'ROTOR' is the physical four-motor model; '6DOF'
       and 'SIMPLE' are the older plants kept for settings compatibility. */
    const _model = (CFG.physics && CFG.physics.model) ||
                   ((CFG.physics && CFG.physics.sixDof) ? '6DOF' : 'SIMPLE');
    const _rotorMode = (_model === 'ROTOR');
    this._windTime = (this._windTime || 0) + dt;
    this._groundedTime = Math.max(0, (this._groundedTime || 0) - dt);
    this._dmgCooldown = Math.max(0, (this._dmgCooldown || 0) - dt);

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
    /* Air density: thin air at altitude (and hot air) makes less thrust,
       and drag falls with it too. ISA troposphere, normalised to the
       sea-level reference the whole flight model is tuned for. */
    const _rhoRatio = this._airDensityRatio(this.position.y - CFG.groundY);
    /* ---- progressive damage -----------------------------------------
       Each stage costs peak thrust and rotational authority, kills part
       of one motor's share (asymmetry) and adds a tremor. Stage 1 is the
       old "one broken arm" behaviour. */
    const _dmgCfg = (CFG.crashSeverity) || {};
    const _stages = _dmgCfg.stages || [];
    let _stage = (this.damage && typeof this.damage.stage === 'number') ? this.damage.stage : 0;
    if (_stage < 1 && this.damage && this.damage.arm) _stage = 1;   /* legacy flag */
    if (_stage < 0) _stage = 0;
    if (_stages.length && _stage > _stages.length - 1) _stage = _stages.length - 1;
    const _st = _stages[_stage] || {};
    const _armThrust = (_st.thrustScale != null) ? _st.thrustScale : 1.0;
    const _armAuth   = (_st.authorityScale != null) ? _st.authorityScale : 1.0;
    const _asym      = (_stage > 0 && _st.asymmetry != null) ? _st.asymmetry : 0;
    /* A dead motor only carries its own corner's share of the thrust:
       3 of 4 motors still running costs a quarter of that share. */
    /* In the rotor plant a dead corner is a real per-motor thrust loss
       inside _stepRotors (with its own torque moment), so the collective
       cap must not discount it a second time here. */
    const _maxThrustNow = CFG.maxThrust * _vFactor * _rhoRatio
                        * _armThrust * (_rotorMode ? 1 : (1 - _asym * 0.25));
    /* Rotation authority scales with pack voltage — real motors produce
       no torque when dead. Zero at cutoff, tapers below 4.0 V/cell. */
    const _authVolt = _vFactor;
    /* Motor authority coupling — real quads lose rotational authority
       at low throttle. Applied to ACRO only (easy mode's alt-hold keeps
       motors spinning at ~50% RPM regardless of stick input, so
       coupling to stick throttle would be wrong) and to the legacy
       plants only. See CFG.feel.motorAuthority for tunables. */
    const _mA = (CFG.feel && CFG.feel.motorAuthority) || { rollPitch: 1.0, yaw: 1.0 };
    /* The rotor plant gets its low-throttle authority from airmode and its
       damage authority from the per-motor thrust loss, so scaling the rate
       target by throttle and by damage stage on top of that would count the
       same effect twice. The legacy plants still need both. */
    const _authRP  = _rotorMode ? 1 : (_mA.rollPitch + (1 - _mA.rollPitch) * thr) * _armAuth;
    const _authYaw = _rotorMode ? 1 : (_mA.yaw       + (1 - _mA.yaw)       * thr) * _armAuth;

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

    /* ---- rotor inertia on the rate loop -----------------------------
       A commanded rate is not a rate: the motors need tens of ms to change
       RPM, so the body rate ramps into the target instead of jumping.
       Only the legacy plants need this lag injected: the rotor plant has a
       real rate PID (_stepRotors) whose P/D/FF terms shape the approach,
       so lagging the setpoint first would be a second, artificial lag. */
    const _rateLag = (!_rotorMode && CFG.esc && CFG.esc.rateLag > 0) ? CFG.esc.rateLag : 0;
    if (_rateLag > 0) {
      this._rateTarget.lerp(this._target, 1 - Math.exp(-dt / _rateLag));
    } else {
      this._rateTarget.copy(this._target);
    }

    /* ---- rate loop: rate targets (RATE) or torque + inertia (6-DOF) ---
       RATE is the Betaflight-style model: the error against the rate target
       becomes angular acceleration directly. 6-DOF goes one level down the
       stack: the same error becomes a MOTOR TORQUE (N·m), which is applied
       to the body inertia tensor, and a gyro bias drifts the realised rate
       away from the commanded one. Same stick feel, real rotors under it. */
    const _six = !!(CFG.physics && CFG.physics.sixDof) && !_rotorMode;
    const a = this._accel;
    if (_rotorMode) {
      /* Physical plant: collective + rate targets → motors → forces →
         inertia. See _stepRotors(); it also advances angVel. */
      this._stepRotors(dt,
        this._collectiveThrust(thr, easyActive, _maxThrustNow, _packDead),
        _maxThrustNow);
    } else if (_six) {
      const _pc = CFG.physics || {};
      const _I  = _pc.inertia || {};
      const _Ix = (_I.roll  != null) ? _I.roll  : 0.0042;   /* body X (roll)  */
      const _Iy = (_I.pitch != null) ? _I.pitch : 0.0056;   /* body Y (pitch) */
      const _Iz = (_I.yaw   != null) ? _I.yaw   : 0.0085;   /* body Z (yaw)   */
      /* Gyro bias: the FC reads a slowly wandering offset, so it stops
         correcting while the airframe is still rotating. Slow wander
         (20-30 s periods) rather than noise — the drift is something you
         fly against, and its phase is re-seeded on every respawn. */
      const _gd = (_pc.gyroDrift != null) ? _pc.gyroDrift : 0;
      if (_gd > 0) {
        const _gt = (this._windTime || 0) + (this._gyroPhase || 0);
        this._gyroBias.set(
          Math.sin(_gt * 0.31) * _gd,
          Math.sin(_gt * 0.23 + 2.1) * _gd * 0.8,
          Math.sin(_gt * 0.19 + 4.2) * _gd * 0.6
        );
      } else {
        this._gyroBias.set(0, 0, 0);
      }
      const _meas = this._gyroMeas.copy(this.angVel).add(this._gyroBias);
      const _ex = this._rateTarget.x - _meas.x;
      const _ey = this._rateTarget.y - _meas.y;
      const _ez = this._rateTarget.z - _meas.z;
      /* Torque for that error, calibrated against the reference inertia so
         the sticks feel the same as RATE; the real tensor then decides how
         fast each axis actually spins (yaw is slowest). */
      const _Iref = (_pc.torqueRef != null) ? _pc.torqueRef : _Ix;
      const _kt = _Iref / Math.max(1e-4, CFG.angResponse);
      let _tx = _ex * _kt, _ty = _ey * _kt, _tz = _ez * _kt;
      const _tMax = (_pc.maxTorque != null) ? _pc.maxTorque : 0.9;
      const _tLen = Math.sqrt(_tx * _tx + _ty * _ty + _tz * _tz);
      if (_tLen > _tMax && _tLen > 1e-9) {
        const _ts = _tMax / _tLen;
        _tx *= _ts; _ty *= _ts; _tz *= _ts;
      }
      a.set(_tx / _Ix, _ty / _Iy, _tz / _Iz);
      const _aLenSix = a.length();
      if (_aLenSix > CFG.angAccelMax && _aLenSix > 1e-9) {
        a.multiplyScalar(CFG.angAccelMax / _aLenSix);
      }
    } else {
      a.copy(this._rateTarget)
        .sub(this.angVel)
        .multiplyScalar(1 / CFG.angResponse);
      const aLen = a.length();
      if (aLen > CFG.angAccelMax) a.multiplyScalar(CFG.angAccelMax / aLen);
    }

    const dThr = thr - this._prevThrottle;
    this._prevThrottle = thr;

    this._wobAmp += Math.abs(dThr) * CFG.propWashGain;
    this._wobAmp *= Math.exp(-dt * 7.0);
    this._wobPhase += dt * Math.PI * 2 * CFG.propWashFreq;

    if (!_rotorMode && thr > 0.03 && !_wasGrounded && !_packDead) {
      const wobScale = easyActive ? 0.4 : 1.0;
      const w = Math.sin(this._wobPhase) * this._wobAmp * thr;
      a.x += w * 400 * wobScale;
      a.z += Math.sin(this._wobPhase * 0.73 + 1.7) * this._wobAmp * thr * 320 * wobScale;
      a.x += Math.sin(this._wobPhase * 2.31) * 2.5 * thr * wobScale;
      a.z += Math.cos(this._wobPhase * 1.87) * 2.0 * thr * wobScale;
    }

    /* ---- motor desync: rapid throttle changes → brief yaw kicks ----
       Skipped in easy mode — the yaw kicks fight the leveling controller. */
    if (!_rotorMode && !easyActive && !_wasGrounded && !_packDead && Math.abs(dThr) > 0.2 && thr > 0.3) {
      a.y += (Math.random() - 0.5) * Math.min(1.5, Math.abs(dThr) * 2.0) * 6.0;
    }

    /* ---- ground effect: wobble near terrain ---- */
    const floorHere = this.getFloorY(this.position.x, this.position.z);
    const agl = this.position.y - floorHere;
    if (!_rotorMode && agl > 0.2 && agl < 2.5 && this.armed && !_packDead) {
      const eff = (1 - agl / 2.5) * 0.5 * (easyActive ? 0.3 : 1.0);
      a.x += (Math.random() - 0.5) * eff * 80;
      a.z += (Math.random() - 0.5) * eff * 80;
    }

    /* ---- damage: lopsided thrust + airframe tremor -------------------
       With a motor down, the opposite corner still pulls: the airframe
       rolls/pitches toward the dead arm, and the controller can only hold
       an offset against it. The tremor grows with the damage stage. */
    if (!_rotorMode && _stage > 0 && !_wasGrounded && !_packDead) {
      if (_asym > 0) {
        const _corner = (this.damage && typeof this.damage.corner === 'number')
          ? this.damage.corner : 0;
        const _sx = (_corner === 0 || _corner === 2) ? 1 : -1;   /* body X */
        const _sz = (_corner < 2) ? 1 : -1;                      /* body Z */
        const _bg = (_dmgCfg.asymGain != null) ? _dmgCfg.asymGain : 20;
        a.x += -_sz * _asym * _bg;
        a.z +=  _sx * _asym * _bg;
      }
      const _wob = (_st.wobble != null) ? _st.wobble : 0;
      if (_wob > 0) {
        const _wf = (_dmgCfg.wobbleFreq != null) ? _dmgCfg.wobbleFreq : 9;
        const _wa = ((_dmgCfg.wobbleAccel != null) ? _dmgCfg.wobbleAccel : 14) * _wob;
        const _wt = this._windTime * Math.PI * 2 * _wf;
        a.x += Math.sin(_wt) * _wa;
        a.z += Math.sin(_wt * 1.37 + 1.1) * _wa * 0.8;
      }
    }

    if (!_rotorMode) this.angVel.addScaledVector(a, dt);

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
    const thrustCmd = this._collectiveThrust(thr, easyActive, _maxThrustNow, _packDead);

    /* ===== ESC + rotor inertia ======================================
       Thrust follows the command with a first-order lag: the rotor has to
       spin up (motor torque) and spins down slower (props windmilling).
       This is why a punch-out ramps instead of teleporting, and why a hard
       throttle chop still carries you up for a moment. Steady state is
       unchanged, so hover trim is unaffected. The rotor plant already has
       this lag inside its motor states, so it is skipped there. */
    let _thrustOut = this._thrustState;
    if (!_rotorMode) {
      const _escCfg = CFG.esc || {};
      const _tgtThrust = _packDead ? 0 : thrustCmd;
      const _tauEsc = (_tgtThrust > this._thrustState)
        ? (_escCfg.spinUp != null ? _escCfg.spinUp : 0.032)
        : (_escCfg.spinDown != null ? _escCfg.spinDown : 0.070);
      if (_tauEsc > 0) {
        this._thrustState += (_tgtThrust - this._thrustState) * (1 - Math.exp(-dt / _tauEsc));
      } else {
        this._thrustState = _tgtThrust;
      }
      _thrustOut = this._thrustState;
      /* A damaged airframe shakes under its own thrust. */
      const _wobThr = (_st.wobble != null) ? _st.wobble : 0;
      if (_stage > 0 && _wobThr > 0 && !_wasGrounded) {
        const _tf = (_dmgCfg.wobbleFreq != null) ? _dmgCfg.wobbleFreq : 9;
        const _ta = ((_dmgCfg.wobbleThrust != null) ? _dmgCfg.wobbleThrust : 0.05) * _wobThr;
        _thrustOut *= 1 + Math.sin(this._windTime * Math.PI * 2 * _tf * 1.7) * _ta;
      }
    }
    acc.copy(this._up).multiplyScalar(_thrustOut / CFG.mass);
    acc.y -= CFG.gravity;
    /* Wall / ceiling reaction from the rotor plant (zero in the legacy
       plants and while disarmed). */
    if (_rotorMode) acc.add(this._proxAccel);

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
      const k = (CFG.dragLinear + CFG.dragQuadratic * speed) * _rhoRatio;
      const _bd = (CFG.aero && CFG.aero.bodyDrag) || null;
      if (_bd && (_bd.x !== 1 || _bd.y !== 1 || _bd.z !== 1)) {
        /* Drag is a body-frame force: each axis can have its own frontal
           area (a quad is draggier in the prop disc than edge-on). */
        const _vb = this._tmpV.copy(this.velocity)
          .applyQuaternion(this._tmpQ.copy(this.quat).invert());
        _vb.x *= _bd.x; _vb.y *= _bd.y; _vb.z *= _bd.z;
        _vb.applyQuaternion(this.quat);
        acc.addScaledVector(_vb, -k);
      } else {
        acc.addScaledVector(this.velocity, -k);
      }
    }

    /* ---- windmill / air-brake drag at low throttle ---- */
    /* Windmill brake — acro only. In easy mode, the alt-hold controller
       already manages vertical velocity; adding drag here would cause it
       to fight the controller and slow commanded descents. */
    if (!easyActive && thr < 0.15 && speed > 3) {
      const wmCoeff = CFG.windmillBrake != null ? CFG.windmillBrake : 0.15;
      const windmill = (1 - thr / 0.15) * wmCoeff * _rhoRatio;
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
      /* Electric current follows prop power, not stick position: in the
         rotor plant it comes from the thrust actually produced, so a
         damaged, sagging or partially-saturated quad draws less than a
         healthy one at the same stick. */
      const _load = _rotorMode
        ? Math.min(1, (this._thrustState || 0) / Math.max(1e-6, CFG.maxThrust))
        : thr;
      const current = _packDead
        ? 0
        : Math.pow(_load, _rotorMode ? 1.15 : 1.4) * CFG.battery.maxCurrent;
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
    // three-mesh-bvh.umd.js is loaded via static <script> in index.html.
    // If we get here without the lib, the static tag is missing or out of order.
    this._bvhFailed = true;
    console.warn('[BVH] three-mesh-bvh.umd.js not loaded — check static <script> order in index.html');
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
     sub-step. Threshold 0.03 matches the motor sphere radius; the cap
     (below) bounds cost: 6 substeps at 120 Hz steps, 12 at 60 Hz. */
  var substeps = 1;
  /* CCD only fires when actually sweeping fast. Below ~5 m/s the
     per-step displacement is smaller than the smallest sphere radius,
     so single-shot collision is sufficient. This also stops CCD from
     firing every frame when the drone is resting against a wall —
     which was the source of the "stuck" and "camera in wall" bugs. */
  var speedNow = this.velocity.length();
  var _ssCCD = this._sphereScale || 1.0;
  var _ccdGate = 0.03 * _ssCCD;
  /* Cap scales with the physics step size: at a 60 Hz step (mobile
     panels) each substep covers 2x the distance of a 120 Hz one, so
     double the cap to keep the per-substep resolution (and thus the
     anti-tunnelling margin) the same. */
  var _ccdCap = (this._stepDt || 1 / 240) > 1 / 120 + 1e-6 ? 12 : 6;
  if (sweepDist > _ccdGate && speedNow > 5.0) {
    substeps = Math.min(_ccdCap, Math.ceil(sweepDist / _ccdGate));
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
  if (this.armed && typeof this.impact === 'function') {
    this.impact(maxApproach);
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

      if (this.armed) this.impact(vyImpact, depth);
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
      if (this.armed) this.impact(-vn);
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
          if (this.armed) this.impact(impact);
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
      if (this.armed) this.impact(-vn);
    }
  };

  return Drone;
})();
