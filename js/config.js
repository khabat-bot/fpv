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

  dragLinear: 0.28,
  dragQuadratic: 0.018,

  /* air-brake coefficient applied below 15% throttle (0 = off).
     Higher = slow descent, lower = drops like a rock. */
  windmillBrake: 0.15,

  propWashGain: 0.50,
  propWashFreq: 27,

  /* ----------------------------- battery ------------------------------- */
  battery: {
    cells: 6,
    capacityMah: 1300,
    maxCurrent: 62,
    lowCellVoltage: 3.50
  },

  /* ------------------------------ camera ------------------------------- */
  camera: {
    fovH: 128,
    tiltDeg: 24
  },

  /* --------------------------- world / rules --------------------------- */
  groundY: 0.16,
  crashSpeed: 7.0,
  hitSpeed: 6.0,
  depthCrash: 1.5,

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
