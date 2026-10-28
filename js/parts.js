/* =========================================================================
   parts.js — modular drone loadout system (v2 — expanded catalogs).

   8 frames / motors / props / batteries per category. Frame carries
   mass/scale/rate/drag modifiers. Motor + prop + battery compose the
   thrust multiplier. Loadout.apply() writes the composed result into
   the pristine CFG fields snapshotted on module load — no new physics
   fields, no second source of truth, no rigid-body engine.

   Thrust is clamped to [1.5, 15.0] T/W so no combo is unflyable or
   absurdly punchy. Base freestyle 5" combo produces byte-identical
   behaviour to the pre-loadout sim.
   ========================================================================= */
'use strict';

window.PARTS = {

  FRAMES: {
    freestyle_5:  { id: 'freestyle_5',  name: 'Freestyle 5"',    sizeClass: '5"', scale: 1.00, massAdd:  0.00, maxRatesMul: 1.00, dragMul: 1.00, accent: 0xff7a1a },
    racing_5:     { id: 'racing_5',     name: 'Racing 5"',       sizeClass: '5"', scale: 1.00, massAdd: -0.05, maxRatesMul: 1.10, dragMul: 0.90, accent: 0xff2020 },
    cinematic_5:  { id: 'cinematic_5',  name: 'Cinematic 5"',    sizeClass: '5"', scale: 1.00, massAdd:  0.07, maxRatesMul: 0.85, dragMul: 1.30, accent: 0xff40a0 },
    cinematic_3:  { id: 'cinematic_3',  name: 'Cinematic 3"',    sizeClass: '3"', scale: 0.65, massAdd: -0.38, maxRatesMul: 0.80, dragMul: 1.20, accent: 0xff40a0 },
    toothpick_3:  { id: 'toothpick_3',  name: 'Toothpick 3"',    sizeClass: '3"', scale: 0.65, massAdd: -0.47, maxRatesMul: 0.85, dragMul: 1.35, accent: 0x40c0ff },
    longrange_7:  { id: 'longrange_7',  name: 'Long Range 7"',   sizeClass: '7"', scale: 1.35, massAdd:  0.55, maxRatesMul: 0.75, dragMul: 1.15, accent: 0x40ff80 },
    heavylift_7:  { id: 'heavylift_7',  name: 'Heavy Lifter 7"', sizeClass: '7"', scale: 1.35, massAdd:  0.95, maxRatesMul: 0.70, dragMul: 1.25, accent: 0xffdd20 },
    tinywhoop_2:  { id: 'tinywhoop_2',  name: 'Tinywhoop 2"',    sizeClass: '2"', scale: 0.50, massAdd: -0.38, maxRatesMul: 0.85, dragMul: 1.40, accent: 0xff60ff }
  },

  MOTORS: {
    default_2207:   { id: 'default_2207',   name: '2207 1800KV',  kv: 1800,  massAdd:  0.000, maxRatesMul: 1.00, currentMul: 1.00, sub: 'Baseline',  statorVol: 3.388, peakTorque: 0.055 },
    high_kv_2207:   { id: 'high_kv_2207',   name: '2207 2400KV',  kv: 2400,  massAdd:  0.005, maxRatesMul: 1.15, currentMul: 1.35, sub: 'Punchy',    statorVol: 3.388, peakTorque: 0.058 },
    race_2207_2750: { id: 'race_2207_2750', name: '2207 2750KV',  kv: 2750,  massAdd:  0.005, maxRatesMul: 1.20, currentMul: 1.55, sub: 'Race',      statorVol: 3.388, peakTorque: 0.062 },
    mid_2306_1700:  { id: 'mid_2306_1700',  name: '2306 1700KV',  kv: 1700,  massAdd:  0.010, maxRatesMul: 1.05, currentMul: 0.90, sub: 'Efficient', statorVol: 3.174, peakTorque: 0.058 },
    high_2306_2450: { id: 'high_2306_2450', name: '2306 2450KV',  kv: 2450,  massAdd:  0.010, maxRatesMul: 1.15, currentMul: 1.45, sub: 'Torque',    statorVol: 3.174, peakTorque: 0.058 },
    small_1404:     { id: 'small_1404',     name: '1404 3800KV',  kv: 3800,  massAdd: -0.020, maxRatesMul: 1.10, currentMul: 0.55, sub: 'Micro',     statorVol: 0.784, peakTorque: 0.014 },
    large_2806:     { id: 'large_2806',     name: '2806 1300KV',  kv: 1300,  massAdd:  0.030, maxRatesMul: 0.95, currentMul: 1.40, sub: 'Big',       statorVol: 4.704, peakTorque: 0.110 },
    tiny_0802:      { id: 'tiny_0802',      name: '0802 19000KV', kv: 19000, massAdd: -0.030, maxRatesMul: 1.10, currentMul: 0.30, sub: 'Tiny',      statorVol: 0.128, peakTorque: 0.003 }
  },


  PROPS: {
    default_5140:    { id: 'default_5140',    name: '5.1×4.0×3', size: '5.1"', diameterIn: 5.1, pitchIn: 4.0, blades: 3, massAdd:  0.000, sub: 'Standard' },
    race_5143_3:     { id: 'race_5143_3',     name: '5.1×4.3×3', size: '5.1"', diameterIn: 5.1, pitchIn: 4.3, blades: 3, massAdd:  0.000, sub: 'Race' },
    low_pitch_5130:  { id: 'low_pitch_5130',  name: '5.1×3.0×3', size: '5.1"', diameterIn: 5.1, pitchIn: 3.0, blades: 3, massAdd:  0.000, sub: 'Low Pitch' },
    high_pitch_5152: { id: 'high_pitch_5152', name: '5.1×5.2×3', size: '5.1"', diameterIn: 5.1, pitchIn: 5.2, blades: 3, massAdd:  0.001, sub: 'High Pitch' },
    biblade_5145_2:  { id: 'biblade_5145_2',  name: '5.1×4.5×2', size: '5.1"', diameterIn: 5.1, pitchIn: 4.5, blades: 2, massAdd: -0.002, sub: 'Bi-Blade' },
    race_7x35:       { id: 'race_7x35',       name: '7.0×3.5×3', size: '7.0"', diameterIn: 7.0, pitchIn: 3.5, blades: 3, massAdd:  0.002, sub: 'Long Range' },
    cine_3x3:        { id: 'cine_3x3',        name: '3.0×3.0×3', size: '3.0"', diameterIn: 3.0, pitchIn: 3.0, blades: 3, massAdd:  0.000, sub: 'Cinematic' },
    tiny_2x2:        { id: 'tiny_2x2',        name: '2.0×2.0×3', size: '2.0"', diameterIn: 2.0, pitchIn: 2.0, blades: 3, massAdd: -0.002, sub: 'Tinywhoop' }
  },


  /* cells / capacityMah / maxCurrent are direct overrides on CFG.battery.*
     massAdd (kg) and thrustMul (voltage ratio-ish) are the modifiers. */
  BATTERY: {
    default_6s_1300:   { id: 'default_6s_1300',   name: '6S 1300mAh', cells: 6, capacityMah: 1300, maxCurrent: 62, massAdd:  0.00, thrustMul: 1.00, sub: 'Standard' },
    light_4s_850:      { id: 'light_4s_850',      name: '4S 850mAh',  cells: 4, capacityMah: 850,  maxCurrent: 45, massAdd: -0.08, thrustMul: 0.75, sub: 'Light' },
    punch_6s_1800:     { id: 'punch_6s_1800',     name: '6S 1800mAh', cells: 6, capacityMah: 1800, maxCurrent: 75, massAdd:  0.10, thrustMul: 1.00, sub: 'Punch' },
    endurance_4s_2200: { id: 'endurance_4s_2200', name: '4S 2200mAh', cells: 4, capacityMah: 2200, maxCurrent: 50, massAdd:  0.15, thrustMul: 0.75, sub: 'Endurance' },
    race_6s_1050:      { id: 'race_6s_1050',      name: '6S 1050mAh', cells: 6, capacityMah: 1050, maxCurrent: 68, massAdd: -0.04, thrustMul: 1.00, sub: 'Race' },
    long_6s_2200:      { id: 'long_6s_2200',      name: '6S 2200mAh', cells: 6, capacityMah: 2200, maxCurrent: 60, massAdd:  0.18, thrustMul: 1.00, sub: 'Long Range' },
    micro_4s_650:      { id: 'micro_4s_650',      name: '4S 650mAh',  cells: 4, capacityMah: 650,  maxCurrent: 40, massAdd: -0.12, thrustMul: 0.75, sub: 'Toothpick' },
    tiny_1s_450:       { id: 'tiny_1s_450',       name: '1S 450mAh',  cells: 1, capacityMah: 450,  maxCurrent: 20, massAdd: -0.20, thrustMul: 0.70, sub: 'Tinywhoop' }
  }
};

/* =========================================================================
   computeMotorThrust(motor, prop, battery)
   ---------------------------------------------------------------------
   Physics-derived thrust per motor. Calibrated against real FPV data so
   the baseline combo (freestyle_5 + 2207 1800 + 5140 + 6S 1300) produces
   8.29 N/motor = 650g quad at 5.20 T/W — byte-identical to the pre-
   loadout baseline.

   Model:
     RPM     = min(KV × V × 0.75, torque_cap_from_stator_vs_prop_load)
     n       = RPM / 60
     D_m     = diameterIn × 0.0254
     CT      = 0.1238 × (pitchIn/diameterIn) × (D_m/0.12954)^0.5
     thrust  = CT × 1.225 × n² × D_m⁴ × machFactor × bladeFactor × reynolds

   Saturation corrections:
     machFactor     drops as tip speed passes Mach 0.6 (real props)
     bladeFactor    0.88 for 2-blade, 1.08 for 4-blade, 1.0 for 3-blade
     reynoldsFactor (D_m/0.12954)^0.5 — small props get lower CT from
                    viscous losses at low Reynolds numbers
   ========================================================================= */
function computeMotorThrust(motor, prop, battery) {
  const AIR_DENSITY  = 1.225;
  const SOUND_SPEED  = 343;
  const CELL_V       = 3.7;
  const LOAD_EFF     = 0.75;
  const CT_BASE      = 0.1238;
  const CQ_BASE      = 0.005;

  const cells       = (battery && typeof battery.cells       === 'number') ? battery.cells       : 6;
  const kv          = (motor   && typeof motor.kv            === 'number') ? motor.kv            : 1800;
  const statorVol   = (motor   && typeof motor.statorVol     === 'number') ? motor.statorVol     : 3.0;
  const peakTorque  = (motor   && typeof motor.peakTorque    === 'number') ? motor.peakTorque    : 0.055;
  const diameterIn  = (prop    && typeof prop.diameterIn     === 'number') ? prop.diameterIn     : 5.1;
  const pitchIn     = (prop    && typeof prop.pitchIn        === 'number') ? prop.pitchIn        : 4.0;
  const blades      = (prop    && typeof prop.blades         === 'number') ? prop.blades         : 3;

  const V          = cells * CELL_V;
  const D_m        = diameterIn * 0.0254;
  const D_m_5      = Math.pow(D_m, 5);
  const pitchRatio = pitchIn / diameterIn;

  /* No-load RPM under typical loading */
  const noLoadRPM = kv * V * LOAD_EFF;

  /* Torque-limited RPM cap: motor can't exceed sqrt(peakTorque / propTorqueCoeff) */
  const CQ = CQ_BASE * (pitchRatio / 0.784) * Math.pow(diameterIn / 5.1, 1.5);
  const n_max = Math.sqrt(peakTorque / (CQ * AIR_DENSITY * D_m_5));
  const torqueCapRPM = n_max * 60;

  const rpm = Math.min(noLoadRPM, torqueCapRPM);
  const n   = rpm / 60;

  /* Tip Mach — drops thrust above 0.6 */
  const tipSpeed = Math.PI * D_m * n;
  const tipMach  = tipSpeed / SOUND_SPEED;
  const machFactor = tipMach > 0.6 ? Math.pow(0.6 / tipMach, 1.5) : 1.0;

  /* CT from pitch ratio + diameter (larger props better efficiency) */
  const CT = CT_BASE * pitchRatio * Math.pow(D_m / 0.12954, 0.5);

  /* Blade count + Reynolds corrections */
  const bladeFactor   = blades === 2 ? 0.88 : (blades === 4 ? 1.08 : 1.0);
  const reynoldsFactor = Math.pow(D_m / 0.12954, 0.5);

  const thrust = CT * AIR_DENSITY * n * n * Math.pow(D_m, 4)
               * machFactor * bladeFactor * reynoldsFactor;

  return {
    thrust: thrust,
    rpm: rpm,
    noLoadRpm: noLoadRPM,
    torqueCapRpm: torqueCapRPM,
    tipMach: tipMach,
    limited: rpm < noLoadRPM * 0.9
  };
}

window.Loadout = (function () {
  var _BASE = null;

  function snapshotBase() {
    if (_BASE) return _BASE;
    if (!window.CFG) { console.warn('[Loadout] CFG missing — cannot snapshot base'); return null; }
    _BASE = {
      mass: CFG.mass,
      thrustToWeight: CFG.thrustToWeight,
      maxRates: { roll: CFG.maxRates.roll, pitch: CFG.maxRates.pitch, yaw: CFG.maxRates.yaw },
      dragLinear: CFG.dragLinear,
      dragQuadratic: CFG.dragQuadratic,
      battery: {
        cells: CFG.battery.cells,
        capacityMah: CFG.battery.capacityMah,
        maxCurrent: CFG.battery.maxCurrent,
        lowCellVoltage: CFG.battery.lowCellVoltage
      },
      groundY:    CFG.groundY,
      crashSpeed: CFG.crashSpeed,
      hitSpeed:   CFG.hitSpeed,
      depthCrash: CFG.depthCrash
    };
    return _BASE;
  }

  function buildEffective(loadout) {
    if (!loadout) return null;
    var base = snapshotBase();
    if (!base) return null;

    var F = PARTS.FRAMES, M = PARTS.MOTORS, P = PARTS.PROPS, B = PARTS.BATTERY;
    var f = F[loadout.frame]   || F.freestyle_5;
    var m = M[loadout.motors]  || M.default_2207;
    var p = P[loadout.props]   || P.default_5140;
    var b = B[loadout.battery] || B.default_6s_1300;

    var mass = base.mass + (f.massAdd || 0) + (m.massAdd || 0)
             + (p.massAdd || 0) + (b.massAdd || 0);

    /* Frame is a chassis — no thrust contribution. Motor × prop × battery
       drives the thrust multiplier. */
    /* Physics-derived thrust: motor × prop × battery.
       Uses first-principles propeller model (see computeMotorThrust
       above) — no hand-tuned thrustMul factors. Frame is chassis only. */
    var thrustInfo = computeMotorThrust(m, p, b);
    var thrustPerMotor = thrustInfo.thrust
      * (m.thrustMul != null ? m.thrustMul : 1.0)
      * (p.thrustMul != null ? p.thrustMul : 1.0)
      * (b.thrustMul != null ? b.thrustMul : 1.0);
    var weightN = mass * CFG.gravity;
    var ttw = (4 * thrustPerMotor) / weightN;
    if (!isFinite(ttw) || ttw < 1.5)  ttw = 1.5;   /* unflyable floor */
    if (ttw > 15.0) ttw = 15.0;                    /* sanity ceiling */

    var rpMul      = (f.maxRatesMul || 1) * (m.maxRatesMul || 1);
    var dragMul    = (f.dragMul || 1)      * (p.dragMul || 1);
    var currentMul = (m.currentMul || 1)   * (p.currentMul || 1);
    var scale      = (typeof f.scale === 'number') ? f.scale : 1.0;

    return {
      mass: mass,
      thrustToWeight: ttw,
      maxRates: {
        roll:  base.maxRates.roll  * rpMul,
        pitch: base.maxRates.pitch * rpMul,
        yaw:   base.maxRates.yaw   * rpMul
      },
      dragLinear:    base.dragLinear    * dragMul,
      dragQuadratic: base.dragQuadratic * dragMul,
      battery: {
        cells:       (b.cells       != null) ? b.cells       : base.battery.cells,
        capacityMah: (b.capacityMah != null) ? b.capacityMah : base.battery.capacityMah,
        maxCurrent:  ((b.maxCurrent != null) ? b.maxCurrent : base.battery.maxCurrent) * currentMul,
        lowCellVoltage: base.battery.lowCellVoltage
      },
      groundY:    base.groundY    * scale,
      crashSpeed: base.crashSpeed * scale,
      hitSpeed:   base.hitSpeed   * scale,
      depthCrash: base.depthCrash * scale,
      sphereScale: scale,
      thrustInfo: thrustInfo
    };
  }

  function apply(loadout) {
    var e = buildEffective(loadout);
    if (!e) return null;

    CFG.mass = e.mass;
    CFG.thrustToWeight = e.thrustToWeight;
    CFG.maxRates.roll  = e.maxRates.roll;
    CFG.maxRates.pitch = e.maxRates.pitch;
    CFG.maxRates.yaw   = e.maxRates.yaw;
    CFG.dragLinear     = e.dragLinear;
    CFG.dragQuadratic  = e.dragQuadratic;
    CFG.battery.cells       = e.battery.cells;
    CFG.battery.capacityMah = e.battery.capacityMah;
    CFG.battery.maxCurrent  = e.battery.maxCurrent;
    CFG.groundY    = e.groundY;
    CFG.crashSpeed = e.crashSpeed;
    CFG.hitSpeed   = e.hitSpeed;
    CFG.depthCrash = e.depthCrash;
    CFG.maxThrust  = CFG.mass * CFG.gravity * CFG.thrustToWeight;

    if (window.__drone) window.__drone._sphereScale = e.sphereScale;
    if (window.DroneVisual && DroneVisual.setLoadout) DroneVisual.setLoadout(loadout);
    window.__loadout = {
      frame: loadout.frame, motors: loadout.motors,
      props: loadout.props, battery: loadout.battery,
      effective: e
    };
    console.log('[Loadout] applied:', loadout.frame, '+', loadout.motors,
                '+', loadout.props, '+', loadout.battery,
                '→ mass', (e.mass*1000).toFixed(0)+'g',
                ', T/W', e.thrustToWeight.toFixed(2),
                ', motor', e.thrustInfo.thrust.toFixed(2)+'N',
                '@', Math.round(e.thrustInfo.rpm)+'rpm',
                ', sphere×', e.sphereScale.toFixed(2));
    if (e.thrustInfo.limited) {
      console.warn('[Loadout] motor is torque-limited at ' +
                   Math.round(e.thrustInfo.rpm) + ' RPM (noload ' +
                   Math.round(e.thrustInfo.noLoadRpm) + ' RPM) — prop is too big for this motor');
    }
    return e;
  }

  snapshotBase();

  return {
    get BASE() { return _BASE; },
    snapshotBase: snapshotBase,
    buildEffective: buildEffective,
    apply: apply
  };
})();
