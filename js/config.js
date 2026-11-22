/* =========================================================================
   config.js — every tunable number of the flight model lives here.
   ========================================================================= */
'use strict';

window.CFG = {

  /* ----------------------- airframe / flight model --------------------- */
  mass: 0.65,
  gravity: 9.81,
  thrustToWeight: 5.2,

  maxRates: { roll: 880, pitch: 880, yaw: 540 },

  rcRate: 1.0,
  expo: 0.35,

  angResponse: 0.060,
  angAccelMax: 420,

  /* ----------------------- motor / ESC response ------------------------
     A rate command is not a rate and a throttle command is not thrust:
     the motor has to spin the prop up first. Both lags are first-order.
       spinUp:   s for thrust to reach a new, higher demand (motor torque)
       spinDown: s for thrust to fall (props coast, slower than spin-up)
       rateLag:  s for a commanded body rate to reach the motors      */
  esc: {
    spinUp: 0.032,
    spinDown: 0.070,
    rateLag: 0.015
  },

  /* ------------------------- physics model ----------------------------
     model selects the plant (SETTINGS → FLIGHT → Physics):
       'ROTOR'  full rotor plant (default): four independent motor
                speeds drive per-prop thrust (∝ RPM²) and reaction
                torque; the rate error becomes a body torque demand that
                a mixer splits into motor commands; the rotor speeds spin
                up/down through the ESC and the resulting forces act on
                the rigid body's inertia tensor (with the gyroscopic
                ω × Iω term and rotor gyroscopic torque).
       '6DOF'   legacy middle ground: rate error → torque → inertia
                tensor, with an idealised torque source.
       'SIMPLE' the original Betaflight-style rate loop.
     sixDof is kept in sync by js/main.js for older settings stores.
       inertia:    kg·m² about each body axis. Yaw inertia is the largest
                   (the mass is spread out in the prop plane), which is
                   why a real quad yaws slower than it rolls.
       torqueRef:  inertia the rate gains are calibrated against, so RATE
                   and 6-DOF feel the same at the sticks
       maxTorque:  N·m per axis — motor torque limit
       gyroDrift:  rad/s the rate estimate can wander (gyro bias)
       rotor:      the rotor plant (model 'ROTOR'). arm is the motor
                   offset along body X and Z (X-frame); torqueLength is
                   Q/T = (Cq/Ct)·D per prop; rotorInertia is one prop's
                   spin inertia (gyroscopic torque); spinUp/spinDown are
                   the motor+prop speed time constants. maxRpm is only
                   the fallback used when no Loadout has published the
                   prop model's RPM (js/parts.js).                        */
  physics: {
    model: 'ROTOR',
    sixDof: false,
    inertia: { roll: 0.0042, pitch: 0.0056, yaw: 0.0085 },
    torqueRef: 0.0042,
    maxTorque: 0.9,
    gyroDrift: 0.02,
    rotor: {
      arm: 0.078,
      maxRpm: 28000,
      torqueLength: 0.0125,
      rotorInertia: 2.2e-5,
      /* Motor + prop speed time constants. Modern ESCs brake the prop
         actively (DShot bidirectional), so spin-down is not much slower
         than spin-up; the old 90 ms coast only applies to a free-wheeling
         prop with the motor de-energised. */
      spinUp: 0.045,
      spinDown: 0.045,

      /* ---- prop advance ratio (Ct(J), Cq(J)) ------------------------
         Real props lose thrust as air flows through the disc: T falls ~25 %
         at 20 m/s on a 5" prop, and the drag torque rises. The plant
         evaluates J = V_axial / (n·D) per prop from body velocity (so tilt
         and angle of attack are included) plus each arm's ω × r, then
         scales thrust by Ct(J)/Ct(0) and reaction torque by Cq(J)/Cq(0).
         J > 0 is climb/forward inflow; J < 0 is descent into the disc.
         js/parts.js derives diameterM, jZero and cqSlope per prop from its
         geometry and publishes them on the loadout; the values below are
         the 5.1×4.0×3 defaults and the fallback with no loadout.
           jZero:      J at which thrust reaches zero
           cqSlope:    relative rise of Cq per unit J (J > 0)
           cqRevSlope: relative rise of Cq per unit descent ratio (J < 0)
           ctRevGain:  reverse-inflow thrust gain per unit descent ratio
           ctRevMax:   cap on that gain (fast descent is not free thrust)
           vrsCenter / vrsWidth / vrsDepth:
                       the vortex-ring band (descent into the prop's own
                       wake) — centre and width in descent ratio, depth as
                       the fraction of thrust lost at its middle.
           cqMax:      cap on the Cq rise. */
      advance: {
        enabled: true,
        diameterM: 0.12954,
        jZero: 1.4,
        cqSlope: 0.65,
        cqRevSlope: 0.35,
        ctRevGain: 0.5,
        ctRevMax: 1.15,
        vrsCenter: 0.25,
        vrsWidth: 0.11,
        vrsDepth: 0.30,
        cqMax: 1.8
      },

      /* ---- rate PID (the loop a real flight controller runs) --------
         The output is an angular-acceleration demand; P is scaled so the
         sticks stay calibrated against `angResponse` (kp = 1.0 reproduces
         the old 1/angResponse gain), so these numbers read like a Betaflight
         tune rather than raw SI gains.
           kp:                 P multiplier on 1/angResponse
           ki:                 1/s² — I gain per (rad/s) of error held
           kd:                 s — D gain per (rad/s²) of gyro derivative
           ff:                 s — feedforward per (rad/s²) of setpoint slew
           dLpf / ffLpf:       s — low-pass on the gyro derivative and on
                               the setpoint derivative
           itermLimit:         fraction of angAccelMax the I-term may supply
                               (also the windup clamp)
           itermRelax:         0..1 — how much I accumulation is suppressed
                               while the setpoint is slewing
           itermRelaxCutoff:   rad/s² of setpoint slew where relax starts
           antiGravity:        collective added per unit of throttle change
           antiGravityDecay:   s — how fast that kick fades
           airmode:            keep the mixer's differential alive at low
                               collective by lifting the weakest motor to
                               airmodeIdle; airmodeIdle is that floor. */
      pid: {
        kp: 1.0,
        ki: 25,
        kd: 0.030,
        ff: 0.012,
        dLpf: 0.010,
        ffLpf: 0.020,
        itermLimit: 0.55,
        itermRelax: 0.75,
        itermRelaxCutoff: 90,
        antiGravity: 0.35,
        antiGravityDecay: 0.06,
        airmode: true,
        airmodeIdle: 0.03
      },

      /* ---- ground / wall / ceiling effect ---------------------------
         A rotor does not make the same thrust in free air and near a
         surface. The surface constrains the induced velocity, so a disc
         inside about one rotor diameter of the ground or of a wall makes
         MORE thrust, and one under a ceiling makes LESS (the inlet is
         starved). This is a thrust multiplier on each prop, not an
         acceleration fudge: it flows through the same mixer, torque
         balance and RPM/authority coupling as free-air thrust, and the
         ground factor is evaluated per prop from that prop's own height.
         A tilted airframe therefore gains more on its low side and tips
         off a pad or a curb the way a real quad does, and a prop near a
         wall leans the airframe away from it through the same thrust.
           enabled:     master switch for the whole proximity model
           ground:
             reach:       h/R at which the extra thrust has died out
                          (h = prop height, R = rotor radius)
             gainMax:     extra thrust fraction of one disc at the peak
             peakHeight:  h/R of the cushion peak. Below it the outflow
                          recirculates and the extra thrust falls back
                          toward `recircLoss` of the peak — the
                          cushion-then-suck-down transition felt when
                          settling onto the pad.
             recircLoss:  fraction of the peak gain lost at the pad
             discLoading: 0..1, how strongly low RPM (low disc loading)
                          scales the effect down. A slowly turning disc
                          has little induced velocity to constrain.
           wall:        reach in rotor diameters; gain is the extra thrust
                        on a disc pushing against the wall, push is the
                        fraction of the thrust reacted away from it
                        (the outwash has nowhere to go).
           ceiling:     reach in rotor diameters; loss is the thrust lost
                        with the disc hard against a ceiling, suck is the
                        fraction of thrust pulling the airframe into it.
           maxPush:     m/s² cap on the combined lateral/vertical push. */
      proximity: {
        enabled: true,
        ground: {
          reach: 2.0,
          gainMax: 0.28,
          peakHeight: 0.25,
          recircLoss: 0.45,
          discLoading: 0.5
        },
        wall: {
          reach: 1.25,
          gain: 0.06,
          push: 0.35
        },
        ceiling: {
          reach: 1.0,
          loss: 0.25,
          suck: 0.12
        },
        maxPush: 12
      }
    }
  },

  /* Body-axis drag multipliers. Drag is evaluated in the body frame, so a
     quad can be draggier edge-on (x) or in the prop disc (y) than
     lengthwise (z). 1.0 = the isotropic dragLinear/dragQuadratic above. */
  aero: {
    bodyDrag: { x: 1.0, y: 1.0, z: 1.0 }
  },

  /* Motor authority coupling: rate targets are scaled by throttle.
     Real quads lose rotational authority at low throttle because motor
     torque comes from prop RPM. rollPitch: 0.65 means 65% of stick rate
     available at 0 throttle, 100% at full. yaw: 0.45 means yaw is
     deliberately weaker at low throttle (physically correct — yaw comes
     from prop drag torque, which vanishes at low RPM). Set both to 1.0
     to fully disable coupling.
     Only the legacy plants (6-DOF, RATE) use this: in the rotor plant
     airmode gives the low-throttle authority and the rate PID holds the
     rate the sticks ask for, so discounting the target too would count
     the same effect twice. */
  feel: {
    motorAuthority: { rollPitch: 0.65, yaw: 0.45 }
  },

  dragLinear: 0.28,
  dragQuadratic: 0.018,

  /* air-brake coefficient applied below 15% throttle (0 = off).
     Higher = slow descent, lower = drops like a rock. */
  windmillBrake: 0.15,

  /* Wind presets — acceleration in m/s^2, applied to physics every step.
     Gust = oscillation amplitude on top of the base push.
     CALM disables entirely. Tune freely. */
  wind: {
    CALM:   { x: 0,   y: 0,   z: 0,   gust: 0   },
    BREEZY: { x: 1.2, y: 0,   z: 0.7, gust: 0.3 },
    GUSTY:  { x: 1.5, y: 0.2, z: 1.0, gust: 1.0 }
  },
  windPreset: 'CALM',

  propWashGain: 0.50,
  propWashFreq: 27,

  /* ----------------------------- battery ------------------------------- */
  battery: {
    cells: 6,
    capacityMah: 1300,
    maxCurrent: 62,
    lowCellVoltage: 3.50
  },

  /* Infinite battery mode — disables drain, voltage sag, and the low-
     battery beeper. Toggled from SETTINGS -> FLIGHT -> Battery. */
  infiniteBattery: false,

  /* ------------------------ external controllers ------------------------
     RC transmitter / gamepad input (js/controller.js), SETTINGS → INPUT.
       source:    'AUTO' = first connected gamepad (or a live CRSF port),
                  'PAD' = gamepad only, 'CRSF' = ELRS over USB serial only,
                  'OFF' = keyboard + virtual sticks only
       order:     transmitter channel order, AETR | TAER | RETA | ETAR
       stickMode: 'MODE2' (thr/yaw left) or 'MODE1' (pitch/yaw left) for
                  gamepads, 'RADIO' when the pad sends channels as axes
                  (EdgeTX/OpenTX USB joystick). CRSF always uses the
                  channel order and needs no stick mode.
       deadband:  stick deadband, fraction of full deflection
       travel:    fraction of the axis range the physical stick reaches
                  (0.8 = a stick that only moves 80% still reaches full)
       thrMode:   'ABS' absolute throttle position, 'HOLD' incremental
                  (for spring-centred gamepad sticks)
       holdRate:  full-travel-per-second rate for throttle HOLD mode
       failsafe:  true = centre the sticks and descend when the link drops,
                  false = hold the last commands (no failsafe)
       timeoutMs: link silence before it counts as lost
       dropSecs:  seconds of controlled descent before the motors cut
       failsafeThrottle: descent throttle; null = 80% of hover throttle
       crsf.baudRate:  ELRS TX modules / receivers use 420000 8N1
       crsf.timeoutMs: silence before a CRSF link counts as lost          */
  controller: {
    source: 'AUTO',
    order: 'AETR',
    stickMode: 'MODE2',
    deadband: 0.04,
    travel: 1.0,
    thrMode: 'ABS',
    holdRate: 1.0,
    failsafe: true,
    timeoutMs: 350,
    dropSecs: 3.0,
    failsafeThrottle: null,
    crsf: { baudRate: 420000, timeoutMs: 450 }
  },

  /* ------------------------------ camera ------------------------------- */
  camera: {
    fovH: 128,
    tiltDeg: 24
  },

  /* --------------------------- FPV video feed -------------------------- */
  /* Emulates the VTX/goggles link (js/fpv-feed.js).
     - latencyMs: how far behind the sim the picture runs
     - fullSignalRange / maxRange: metres for a clean / dead picture
     - obstructionAttenuation: how much solid geometry eats the link (0-1)
     - raycastHz: obstruction sampling rate (kept low to stay cheap)
     - signalSmoothMs: link quality smoothing time constant
     - lossThreshold / lossHoldMs: when the snow screen takes over */
  fpvFeed: {
    latencyMs: 50,
    fullSignalRange: 260,
    maxRange: 900,
    obstructionAttenuation: 0.8,
    raycastHz: 8,
    signalSmoothMs: 220,
    lossThreshold: 0.12,
    lossHoldMs: 350
  },

  /* ----------------------------- telemetry ------------------------------
     Flight data recorder + OSD attitude graph (js/telemetry.js).
       sampleHz:      blackbox samples per second (CSV rate)
       windowSec:     rolling log length — the CSV exports exactly this much
       graphWindowSec: time span shown by the live attitude graph
       graphRangeDeg:  half-scale of each graph lane, degrees of attitude */
  telemetry: {
    sampleHz: 50,
    windowSec: 60,
    graphWindowSec: 10,
    graphRangeDeg: 180
  },

  /* --------------------------- air density ----------------------------
     Thrust and drag scale with air density, and density falls with
     altitude and rises in cold air. ISA troposphere model, sea-level
     reference 1.225 kg/m³ (15 °C, 101325 Pa). At the default 15 °C the
     ratio at ground level is 1.00, so nothing below changes.
       tempC:        sea-level air temperature
       seaLevelPressure: Pa
       density:      set false to use constant sea-level density   */
  environment: {
    tempC: 15,
    seaLevelPressure: 101325,
    density: true
  },

  /* -------------------------- environment ------------------------------ */
  /* Sky / fog / lighting presets. DAY reproduces the procedural-world
     defaults exactly (byte-identical look). On imported maps, the DAY
     preset overrides the legacy hardcoded (0x87a9c8 / 200-900) values —
     the preset is the source of truth after map load. All colors are
     hex ints. */
  env: {
    DAY: {
      background: 0xc8d8e6,
      fogColor: 0xc8d8e6, fogNear: 140, fogFar: 580,
      sunColor: 0xfff2d6, sunIntensity: 1.05,
      hemiSkyColor: 0xdcefff, hemiGroundColor: 0x3a5030, hemiIntensity: 0.90,
      fillColor: 0x9bb4cc, fillIntensity: 0.28,
      skyTop: 0x1e4d80, skyBot: 0xd4dce4
    },
    GOLDEN_HOUR: {
      background: 0xe8b888,
      fogColor: 0xe8b888, fogNear: 100, fogFar: 500,
      sunColor: 0xffb060, sunIntensity: 1.40,
      hemiSkyColor: 0xffd4a0, hemiGroundColor: 0x3a2a20, hemiIntensity: 0.75,
      fillColor: 0x9b8494, fillIntensity: 0.35,
      skyTop: 0x2a1530, skyBot: 0xffb070
    },
    OVERCAST: {
      background: 0xc0c4c8,
      fogColor: 0xc0c4c8, fogNear: 120, fogFar: 700,
      sunColor: 0xdcdcdc, sunIntensity: 0.35,
      hemiSkyColor: 0xe0e4e8, hemiGroundColor: 0x50544e, hemiIntensity: 1.10,
      fillColor: 0x9098a0, fillIntensity: 0.30,
      skyTop: 0x9aa0a8, skyBot: 0xd4d8dc
    },
    DUSK: {
      background: 0x2a3a54,
      fogColor: 0x2a3a54, fogNear: 80, fogFar: 450,
      sunColor: 0xff9060, sunIntensity: 0.60,
      hemiSkyColor: 0x4a5878, hemiGroundColor: 0x2a1e28, hemiIntensity: 0.55,
      fillColor: 0x5060a0, fillIntensity: 0.25,
      skyTop: 0x101428, skyBot: 0xd06040
    }
  },

  /* --------------------------- world / rules --------------------------- */
  groundY: 0.16,
  crashSpeed: 7.0,
  hitSpeed: 6.0,
  depthCrash: 1.5,

  /* -------------------------- crash severity --------------------------- */
  /* Impacts are graded instead of being a single flag.
     - damageSpeed: impact (m/s) that damages the airframe — the flight
       continues, but with reduced thrust and rotational authority
     - fatalSpeed:  impact (m/s) at or above which the VTX is treated as dead
       (the video feed goes to NO SIGNAL). Between crashSpeed and this the
       crash still ends the flight, but the picture survives
     - damageCooldown: s between two damaging hits, so grinding along the
       ground for three frames cannot shred the whole airframe at once
     - stages: one entry per damage level, 0 = clean. Each hit above
       damageSpeed advances one stage (up to the last).
         thrustScale    peak thrust left
         authorityScale rotational authority left
         asymmetry      share of one motor's thrust that is gone (0-1). The
                        airframe also rolls/pitches toward the dead corner
         wobble         tremor amplitude multiplier (attitude + thrust) */
  crashSeverity: {
    damageSpeed: 4.5,
    fatalSpeed: 15.0,
    damageCooldown: 0.35,
    asymGain: 12,        /* rad/s^2 of attitude bias per unit asymmetry */
    wobbleFreq: 7,       /* Hz */
    wobbleAccel: 8,      /* rad/s^2 at wobble = 1 */
    wobbleThrust: 0.05,  /* thrust modulation at wobble = 1 */
    stages: [
      { thrustScale: 1.00, authorityScale: 1.00, asymmetry: 0.00, wobble: 0.0 },
      { thrustScale: 0.80, authorityScale: 0.88, asymmetry: 0.30, wobble: 0.5 },
      { thrustScale: 0.58, authorityScale: 0.72, asymmetry: 0.55, wobble: 1.0 },
      { thrustScale: 0.36, authorityScale: 0.55, asymmetry: 0.70, wobble: 1.5 }
    ]
  },

  /* --------------------------- easy mode ------------------------------ */
  /* Self-leveling "angle mode" for casual flying.
     - maxAngleDeg: maximum tilt commanded by full stick deflection
     - levelGain:  P gain for leveling (rad/s per rad of attitude error).
                    Lower = smoother/sluggish, higher = snappier.
     - maxRatesScale: cap leveling rate as a fraction of acro max roll/pitch
     - yawRatesScale: yaw rate as a fraction of acro max yaw */
  easyMode: {
    /* Shared stability gains — NOT per-preset. These keep the controller
       stable; changing them per preset would make one preset feel wrong. */
    levelGain: 5.0,
    altGain: 3.0,

    /* Presets — user-selectable in SETTINGS -> INPUT -> Flight Mode. */
    presets: {
      SLOW:  { maxAngleDeg: 35, maxRatesScale: 0.55, yawRatesScale: 0.65, maxClimbRate: 4.0,  maxDescendRate: 6.0  },
      SPORT: { maxAngleDeg: 48, maxRatesScale: 0.75, yawRatesScale: 0.90, maxClimbRate: 6.0,  maxDescendRate: 8.0  },
      FAST:  { maxAngleDeg: 60, maxRatesScale: 1.00, yawRatesScale: 1.00, maxClimbRate: 8.0,  maxDescendRate: 10.0 }
    }
  }
};

CFG.maxThrust = CFG.mass * CFG.gravity * CFG.thrustToWeight;
