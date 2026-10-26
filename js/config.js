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

  dragLinear: 0.35,
  dragQuadratic: 0.018,

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
  depthCrash: 1.5
};

CFG.maxThrust = CFG.mass * CFG.gravity * CFG.thrustToWeight;
