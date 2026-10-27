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

  /* ------------------------------ camera ------------------------------- */
  camera: {
    fovH: 128,
    tiltDeg: 24
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
