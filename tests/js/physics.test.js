/* Flight-model behaviour. These cover the things that break silently:
   thrust/battery coupling, crash grading, damage, easy-mode levelling,
   and the sign conventions between stick input and body rates. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, input, fly } = require('./helpers/harness.js');

function setup() {
  const ctx = loadSim(['js/config.js', 'js/physics.js']);
  return { ctx, CFG: ctx.CFG, Drone: ctx.Drone };
}

function airborne(Drone, y) {
  const d = new Drone();
  d.position.y = y === undefined ? 20 : y;
  d.armed = true;
  return d;
}

const hoverStick = () => input({ throttle: 1 / 5.2 });

test('a fresh drone spawns on the pad, disarmed and at rest', () => {
  const { CFG, Drone } = setup();
  const d = new Drone();
  assert.equal(d.position.y, CFG.groundY);
  assert.equal(d.velocity.length(), 0);
  assert.equal(d.armed, false);
  assert.equal(d.crashed, false);
  assert.equal(d.voltage, CFG.battery.cells * 4.2);
  assert.equal(d.mahUsed, 0);
});

test('an unarmed drone falls under gravity', () => {
  const { Drone } = setup();
  const d = new Drone();
  d.position.y = 30;
  d.armed = false;
  fly(d, 1);
  assert.ok(d.velocity.y < -5, 'expected a downward velocity, got ' + d.velocity.y);
  assert.ok(d.position.y < 30);
});

test('arming toggles; disarming zeroes rotation; a crash blocks arming', () => {
  const { Drone } = setup();
  const d = new Drone();
  d.position.y = 20;
  d.toggleArm();
  assert.equal(d.armed, true);
  d.angVel.set(1, 2, 3);
  d.toggleArm();
  assert.equal(d.armed, false);
  assert.equal(d.angVel.length(), 0);

  d.armed = true;
  d.crash(10);
  d.toggleArm();
  assert.equal(d.armed, false, 'cannot re-arm a crashed drone');
});

test('hover throttle roughly holds altitude', () => {
  const { Drone } = setup();
  const d = airborne(Drone);
  const start = d.position.y;
  fly(d, 2, 1 / 240, hoverStick());
  assert.ok(Math.abs(d.position.y - start) < 2.0,
    'hover drifted ' + (d.position.y - start).toFixed(2) + ' m in 2 s');
});

test('more throttle climbs, less throttle sinks', () => {
  const { Drone } = setup();
  const up = airborne(Drone);
  fly(up, 0.6, 1 / 240, input({ throttle: 0.7 }));
  assert.ok(up.velocity.y > 1, 'climb velocity ' + up.velocity.y);

  const down = airborne(Drone);
  fly(down, 0.6, 1 / 240, input({ throttle: 0.05 }));
  assert.ok(down.velocity.y < -1, 'descent velocity ' + down.velocity.y);
});

test('roll input produces the documented rate sign', () => {
  const { Drone } = setup();
  const d = airborne(Drone);
  fly(d, 0.25, 1 / 240, input({ throttle: 0.5, roll: 1 }));
  assert.ok(d.angVel.z < -0.5, 'expected negative Z rate for right roll, got ' + d.angVel.z);
});

test('legacy plants: low throttle has less rotational authority than full throttle', () => {
  const { ctx, Drone } = setup();
  /* The rate target is scaled by throttle in the legacy plants. The rotor
     plant gets that coupling from the physics (and airmode removes it). */
  ctx.CFG.physics.model = 'SIMPLE';
  const low = airborne(Drone);
  const high = airborne(Drone);
  fly(low, 0.3, 1 / 240, input({ throttle: 0.05, roll: 1 }));
  fly(high, 0.3, 1 / 240, input({ throttle: 1.0, roll: 1 }));
  assert.ok(Math.abs(high.angVel.z) > Math.abs(low.angVel.z) * 1.2,
    'roll rate should scale with throttle: low=' + low.angVel.z + ' high=' + high.angVel.z);
});

test('the battery drains, voltage sags, and mahUsed never exceeds capacity', () => {
  const { CFG, Drone } = setup();
  const d = airborne(Drone);
  fly(d, 8, 1 / 240, input({ throttle: 0.9 }));
  assert.ok(d.mahUsed > 0, 'expected current draw');
  assert.ok(d.voltage < CFG.battery.cells * 4.2, 'expected sag');
  assert.ok(d.mahUsed <= CFG.battery.capacityMah, 'mahUsed above pack capacity');
});

test('infinite battery pins voltage and never drains', () => {
  const { ctx, CFG, Drone } = setup();
  CFG.infiniteBattery = true;
  const d = airborne(Drone);
  fly(d, 5, 1 / 240, input({ throttle: 1 }));
  assert.equal(d.mahUsed, 0);
  assert.equal(d.voltage, CFG.battery.cells * 4.2);
  assert.equal(d._packDeadLatched, false);
  assert.ok(ctx);
});

test('a dead pack latches and cuts thrust', () => {
  const { CFG, Drone } = setup();
  const d = airborne(Drone);
  fly(d, 0.4, 1 / 240, input({ throttle: 1 }));
  const before = d._thrustState;
  assert.ok(before > 1);

  d.voltage = 2.9 * CFG.battery.cells;
  fly(d, 0.3, 1 / 240, input({ throttle: 1 }));
  assert.equal(d._packDeadLatched, true, 'cutoff should latch');
  assert.ok(d._thrustState < before * 0.5, 'thrust should collapse after cutoff');
  assert.equal(d.voltage <= CFG.battery.cells * 3.0, true);
});

test('air density is 1 at sea level, thinner high up and in hot air', () => {
  const { CFG, Drone } = setup();
  const d = new Drone();
  assert.ok(Math.abs(d._airDensityRatio(0) - 1) < 0.01);
  assert.ok(d._airDensityRatio(5000) < 0.7);
  assert.ok(d._airDensityRatio(9000) < 0.5);

  CFG.environment.tempC = 40;
  const hot = d._airDensityRatio(0);
  CFG.environment.tempC = -20;
  const cold = d._airDensityRatio(0);
  assert.ok(hot < 1, 'hot air should be less dense');
  assert.ok(cold > 1, 'cold air should be denser');

  CFG.environment.density = false;
  assert.equal(d._airDensityRatio(5000), 1);
});

test('crash severity grades between crashSpeed and fatalSpeed', () => {
  const { CFG, Drone } = setup();
  const slow = new Drone();
  slow.crash(CFG.crashSpeed);
  assert.equal(slow.crashSeverity, 0);

  const fatal = new Drone();
  fatal.crash(CFG.crashSpeed + (CFG.crashSeverity.fatalSpeed - CFG.crashSpeed) / 2);
  assert.ok(fatal.crashSeverity > 0.4 && fatal.crashSeverity < 0.6);

  const beyond = new Drone();
  beyond.crash(CFG.crashSeverity.fatalSpeed * 2);
  assert.equal(beyond.crashSeverity, 1);
});

test('impact(): none below damage speed, damage in the band, crash above it', () => {
  const { CFG, Drone } = setup();
  assert.equal(new Drone().impact(CFG.crashSeverity.damageSpeed - 0.5), 'none');

  const d = new Drone();
  assert.equal(d.impact(CFG.crashSeverity.damageSpeed + 0.5), 'damage');
  assert.equal(d.damage.stage, 1);
  assert.equal(d.damage.arm, true);
  assert.equal(d.impact(CFG.crashSeverity.damageSpeed + 0.5), 'none', 'cooldown must block stacking');

  const hit = new Drone();
  hit._dmgCooldown = 0;
  assert.equal(hit.impact(CFG.crashSpeed + 1), 'crash');
  assert.equal(hit.crashed, true);
  assert.equal(hit.armed, false);
});

test('damage stages cap and are cleared by reset()', () => {
  const { CFG, Drone } = setup();
  const maxStage = CFG.crashSeverity.stages.length - 1;
  const d = new Drone();
  for (let i = 0; i < maxStage + 4; i++) {
    d._dmgCooldown = 0;
    d.impact(CFG.crashSeverity.damageSpeed + 0.4);
  }
  assert.equal(d.damage.stage, maxStage);
  d.mahUsed = 200;
  d.reset(0, 0);
  assert.equal(d.damage.stage, 0);
  assert.equal(d.mahUsed, 0);
  assert.equal(d.crashed, false);
});

test('damage costs peak thrust', () => {
  const { CFG, Drone } = setup();
  const clean = airborne(Drone);
  const wreck = airborne(Drone);
  wreck.damage.stage = CFG.crashSeverity.stages.length - 1;
  fly(clean, 1, 1 / 240, input({ throttle: 1 }));
  fly(wreck, 1, 1 / 240, input({ throttle: 1 }));
  assert.ok(wreck._thrustState < clean._thrustState * 0.75,
    'damaged thrust ' + wreck._thrustState + ' vs clean ' + clean._thrustState);
});

test('easy mode levels a tilted drone back to upright', () => {
  const { ctx, Drone } = setup();
  const d = airborne(Drone, 30);
  d.easyMode = true;
  d.quat.setFromEuler(new ctx.THREE.Euler(0.6, 0, 0.4, 'YXZ'));
  fly(d, 3, 1 / 240, input({ throttle: 0.5 }));
  const upY = new ctx.THREE.Vector3(0, 1, 0).applyQuaternion(d.quat).y;
  assert.ok(upY > 0.9, 'expected level flight, up.y=' + upY.toFixed(3));
});

test('easy mode holds altitude with a centred throttle stick', () => {
  const { Drone } = setup();
  const d = airborne(Drone, 40);
  d.easyMode = true;
  const start = d.position.y;
  fly(d, 2, 1 / 240, input({ throttle: 0.5 }));
  assert.ok(Math.abs(d.position.y - start) < 2.5,
    'alt-hold drifted ' + (d.position.y - start).toFixed(2) + ' m');
});

test('touching the ground while armed sets a grounded state', () => {
  const { Drone } = setup();
  const d = new Drone();
  d.position.y = 2;
  d.armed = true;
  fly(d, 1.5, 1 / 240, input({ throttle: 0 }));
  assert.ok(d._groundedTime > 0, 'expected a grounded contact');
  assert.ok(d.position.y >= d.getFloorY(0, 0) - 1e-6);
});

/* ---- ROTOR plant (CFG.physics.model 'ROTOR', the default) ---------- */

test('rotor plant: four props hold hover thrust at hover collective', () => {
  const { CFG, Drone } = setup();
  const d = airborne(Drone, 30);
  fly(d, 1, 1 / 240, hoverStick());
  const weight = CFG.mass * CFG.gravity;
  assert.ok(Math.abs(d._thrustState - weight) < weight * 0.05,
    'hover thrust ' + d._thrustState.toFixed(2) + ' N vs weight ' + weight.toFixed(2) + ' N');
  assert.ok(d.rotorRpm.every(function (rpm) { return rpm > 0; }), 'all four motors should run');
});

test('rotor plant: spinning up is limited by the props, and disarming stops them', () => {
  const { Drone } = setup();
  const d = airborne(Drone);
  fly(d, 0.2, 1 / 240, input({ throttle: 1 }));
  const spun = d.rotorRpm.slice();
  assert.ok(spun.every(function (rpm) { return rpm > 1000; }), 'motors should reach flight RPM');

  d.toggleArm();
  fly(d, 1, 1 / 240, input({ throttle: 1 }));
  assert.ok(d.rotorRpm.every(function (rpm) { return rpm < 1; }), 'disarmed props must spool down');
});

test('rotor plant: motor commands stay inside their physical range', () => {
  const { CFG, Drone } = setup();
  const d = airborne(Drone, 30);
  fly(d, 0.4, 1 / 240, input({ throttle: 1, roll: 1, pitch: 1, yaw: 1 }));
  assert.ok(d._rotorState.every(function (s) { return s >= 0 && s <= 1 + 1e-9; }),
    'motor commands out of range: ' + d._rotorState.join(','));
  assert.ok(d._thrustState <= CFG.maxThrust * 1.01,
    'thrust above the thrust the props can make: ' + d._thrustState);
});

test('rotor plant: the rate loop settles on the commanded rate', () => {
  const { Drone } = setup();
  const d = airborne(Drone, 30);
  fly(d, 0.6, 1 / 240, input({ throttle: 0.75, roll: 1 }));
  assert.ok(Math.abs(d.angVel.z - d._rateTarget.z) < 0.6,
    'realised rate ' + d.angVel.z.toFixed(2) + ' vs target ' + d._rateTarget.z.toFixed(2));
});

test('rotor plant: the rate PID trims a damaged airframe', () => {
  const { CFG, Drone } = setup();
  const pid = CFG.physics.rotor.pid;
  function flyDamaged(ki) {
    pid.ki = ki;
    const d = airborne(Drone, 30);
    d.damage.stage = 1;
    d.damage.corner = 0;
    d.damage.arm = true;
    fly(d, 3, 1 / 240, input({ throttle: 0.7 }));
    return d;
  }
  const withI = flyDamaged(pid.ki);
  const noI = flyDamaged(0);
  pid.ki = 25;
  const residual = Math.max(Math.abs(withI.angVel.x), Math.abs(withI.angVel.z));
  assert.ok(residual < 0.15,
    'I-term should hold the rate at zero under damage: ' + residual.toFixed(2) + ' rad/s');
  assert.ok(Math.abs(noI.angVel.z) > 1.0,
    'P alone leaves a steady rate under damage: ' + noI.angVel.z.toFixed(2));
  assert.ok(Math.max.apply(null, withI.rotorRpm) - Math.min.apply(null, withI.rotorRpm) > 1000,
    'the three good corners must carry the dead one');
});

test('rotor plant: the I-term cannot wind up past its share of the authority', () => {
  const { CFG, Drone } = setup();
  const pid = CFG.physics.rotor.pid;
  const d = airborne(Drone, 30);
  d.damage.stage = 3;
  d.damage.corner = 1;
  d.damage.arm = true;
  /* Full sticks on every axis, with a motor down: the error is far larger
     than the props can answer, so the integral must stop at its clamp. */
  fly(d, 2, 1 / 240, input({ throttle: 0.75, roll: 1, pitch: 1, yaw: 1 }));
  const maxI = CFG.angAccelMax * pid.itermLimit / pid.ki;
  ['x', 'y', 'z'].forEach(function (axis) {
    assert.ok(Math.abs(d._pidI[axis]) <= maxI + 1e-9,
      'integral ' + axis + ' = ' + d._pidI[axis].toFixed(2) + ' beyond clamp ' + maxI.toFixed(2));
  });
});

test('rotor plant: feedforward acts on the setpoint, not on the error', () => {
  const { CFG, Drone } = setup();
  const pid = CFG.physics.rotor.pid;
  function kick(ff) {
    pid.ff = ff;
    const d = airborne(Drone, 30);
    fly(d, 0.3, 1 / 240, input({ throttle: 0.7 }));
    fly(d, 3 / 240, 1 / 240, input({ throttle: 0.7, roll: 0.3 }));
    return d._pidFf.z;
  }
  const on = kick(pid.ff);
  const off = kick(0);
  pid.ff = 0.012;
  assert.ok(Math.abs(off) < 1e-9,
    'with no feedforward gain there is no feedforward term, got ' + off);
  assert.ok(Math.abs(on) > 0.5,
    'feedforward should lead the stick step, got ' + on.toFixed(2) + ' rad/s²');
});

test('rotor plant: airmode keeps the weakest motor off the stop', () => {
  const { CFG, Drone } = setup();
  const pid = CFG.physics.rotor.pid;
  function roll(airmode) {
    pid.airmode = airmode;
    const d = airborne(Drone, 30);
    fly(d, 0.35, 1 / 240, input({ throttle: 0, roll: 1 }));
    return { thrust: d._thrustState, idle: Math.min.apply(null, d._rotorState) };
  }
  const on = roll(true);
  const off = roll(false);
  pid.airmode = true;
  assert.ok(on.idle > 0.1, 'airmode should hold every motor off the stop: ' + on.idle.toFixed(2));
  assert.equal(off.idle, 0, 'without airmode the mixer clips a motor to zero');
  assert.ok(on.thrust > off.thrust * 3,
    'airmode should keep thrust under a zero-throttle roll: '
    + on.thrust.toFixed(2) + ' N vs ' + off.thrust.toFixed(2) + ' N');
});

test('rotor plant: a saturated yaw demand does not roll or pitch the airframe', () => {
  const { Drone } = setup();
  const d = airborne(Drone, 30);
  /* Yaw authority comes only from prop drag torque, so the yaw demand is
     the first to saturate. Clipping each motor on its own used to turn
     the excess into a diagonal thrust differential — a big roll/pitch
     torque the pilot never asked for. */
  fly(d, 0.6, 1 / 240, input({ throttle: 0.55, yaw: 1 }));
  const cross = Math.max(Math.abs(d.angVel.x), Math.abs(d.angVel.z));
  assert.ok(cross < 0.4,
    'pure yaw should stay pure: ' + cross.toFixed(2) + ' rad/s of roll/pitch');
  assert.ok(Math.abs(d.angVel.y) > 2,
    'yaw still has to work: ' + d.angVel.y.toFixed(2) + ' rad/s');
});

test('rotor plant: centring the sticks stops a combined roll/pitch/yaw manoeuvre', () => {
  const { Drone } = setup();
  const d = airborne(Drone, 30);
  /* The mixer used to clip the saturated yaw differential into a roll
     torque, which then fed back through the rate loop and left the quad
     rolling away on its own long after the sticks were centred. */
  fly(d, 0.8, 1 / 240, input({ throttle: 0.7, roll: 1, pitch: 1, yaw: 1 }));
  fly(d, 0.6, 1 / 240, input({ throttle: 0.55 }));
  const rate = d.angVel.length();
  assert.ok(rate < 0.5,
    'the rate loop should have stopped the rotation, got ' + rate.toFixed(2) + ' rad/s');
});

test('rotor plant: anti-gravity adds collective on a throttle jab', () => {
  const { CFG, Drone } = setup();
  const pid = CFG.physics.rotor.pid;
  function jab(gain) {
    pid.antiGravity = gain;
    const d = airborne(Drone, 30);
    fly(d, 0.8, 1 / 240, hoverStick());
    fly(d, 0.08, 1 / 240, input({ throttle: 0.55 }));
    return d._thrustState;
  }
  const on = jab(pid.antiGravity);
  const off = jab(0);
  pid.antiGravity = 0.35;
  assert.ok(on > off * 1.03,
    'anti-gravity should lead the spool-up: ' + on.toFixed(2) + ' N vs ' + off.toFixed(2) + ' N');
});

test('rotor plant: throttle does not discount the rate target', () => {
  const { CFG, Drone } = setup();
  const low = airborne(Drone, 30);
  fly(low, 0.2, 1 / 240, input({ throttle: 0.05, roll: 1 }));
  /* Full stick is full rate at any throttle; only pack sag (the voltage
     factor) may take a little off it, never the motorAuthority coupling. */
  const expected = CFG.maxRates.roll * Math.PI / 180 * CFG.rcRate;
  assert.ok(Math.abs(low._rateTarget.z) > expected * 0.98,
    'zero-ish throttle should still command full rate: '
    + Math.abs(low._rateTarget.z).toFixed(2) + ' vs ' + expected.toFixed(2) + ' rad/s');
});

test('the rate setpoint lag applies to the legacy plants only', () => {
  const { CFG, Drone } = setup();
  const d = airborne(Drone, 30);
  fly(d, 1 / 240, 1 / 240, input({ throttle: 0.75, roll: 1 }));
  assert.ok(Math.abs(d._rateTarget.z - d._target.z) < 1e-9,
    'the rotor plant feeds its PID the stick target directly');

  ['6DOF', 'SIMPLE'].forEach(function (model) {
    CFG.physics.model = model;
    CFG.physics.sixDof = (model === '6DOF');
    const old = airborne(Drone, 30);
    fly(old, 1 / 240, 1 / 240, input({ throttle: 0.75, roll: 1 }));
    assert.ok(Math.abs(old._target.z - old._rateTarget.z) > 1.0,
      model + ' should still lag the rate target: target '
      + old._target.z.toFixed(2) + ', lagged ' + old._rateTarget.z.toFixed(2));
  });
  CFG.physics.model = 'ROTOR';
  CFG.physics.sixDof = false;
});

test('rotor plant: props lose thrust and gain drag torque with airspeed', () => {
  const { Drone } = setup();
  const d = airborne(Drone, 30);
  const still = d._propAxialFactors(0);
  assert.equal(still.ct, 1, 'static thrust must be the calibrated point');
  assert.equal(still.cq, 1, 'static drag torque must be the calibrated point');

  /* 20 m/s on a 5" prop at hover RPM is J ≈ 0.35: real props lose
     about a quarter of their static thrust there. */
  const cruise = d._propAxialFactors(0.35);
  assert.ok(cruise.ct > 0.70 && cruise.ct < 0.80,
    'expected ~20-30 % thrust loss at J=0.35, got ' + cruise.ct.toFixed(2));
  assert.ok(cruise.cq > 1.15,
    'drag torque should rise with inflow, got ' + cruise.cq.toFixed(2));
  assert.equal(d._propAxialFactors(still.jZero).ct, 0,
    'no thrust at the zero-thrust advance ratio');
});

test('rotor plant: the vortex-ring band costs thrust on a slow descent', () => {
  const { Drone } = setup();
  const d = airborne(Drone, 30);
  const slow = d._propAxialFactors(-0.05).ct;
  const vrs  = d._propAxialFactors(-0.25).ct;
  const fast = d._propAxialFactors(-0.8).ct;
  assert.ok(vrs < 0.85, 'VRS should cost ~30 % of thrust, got ' + vrs.toFixed(2));
  assert.ok(vrs < slow, 'descending into the wake is worse than a gentle descent');
  assert.ok(fast > vrs, 'a fast descent leaves the ring');
  assert.ok(fast <= 1.15 + 1e-9, 'reverse inflow must not be free thrust: ' + fast.toFixed(2));
});

test('rotor plant: climbing at speed costs real thrust', () => {
  const { Drone } = setup();
  function thrustAt(vy) {
    const d = airborne(Drone, 30);
    fly(d, 0.5, 1 / 240, input({ throttle: 0.5 }));
    d.velocity.y = vy;
    fly(d, 0.02, 1 / 240, input({ throttle: 0.5 }));
    return d._thrustState;
  }
  const hover = thrustAt(0);
  const climb = thrustAt(12);
  const ratio = climb / hover;
  assert.ok(ratio > 0.74 && ratio < 0.86,
    'climbing at 12 m/s should cost ~20 % thrust, got ' + (ratio * 100).toFixed(0) + '%');
});

test('reset() restores spawn state after a crash', () => {
  const { CFG, Drone } = setup();
  const d = airborne(Drone);
  d.crash(20);
  d.mahUsed = 500;
  d.reset(3, 4);
  assert.equal(d.position.x, 3);
  assert.equal(d.position.z, 4);
  assert.equal(d.position.y, CFG.groundY);
  assert.equal(d.armed, false);
  assert.equal(d.crashed, false);
  assert.equal(d.crashSeverity, 0);
  assert.equal(d.voltage, CFG.battery.cells * 4.2);
});

/* ---- ground and wall effect (rotor plant) ------------------------------ */

test('rotor plant: ground effect adds thrust on the pad', () => {
  const { CFG, Drone } = setup();
  /* Hold the airframe at the height being measured: a real quad would climb
     out of the effect zone, and the point here is the thrust at that height. */
  function hoverAt(y) {
    const d = airborne(Drone, y);
    for (let i = 0; i < 480; i++) {
      d.position.y = y;
      d.velocity.set(0, 0, 0);
      d.step(1 / 240, hoverStick());
    }
    return d._thrustState;
  }
  const pad = hoverAt(CFG.groundY + 0.02);
  const free = hoverAt(8);
  assert.ok(pad > free * 1.04,
    'a disc close to the ground makes more thrust: '
    + pad.toFixed(2) + ' N on the pad vs ' + free.toFixed(2) + ' N in free air');
});

test('rotor plant: ground effect peaks just above the pad (cushion then suck-down)', () => {
  const { Drone } = setup();
  const d = new Drone();
  const peak = d._groundEffectGain(0.25, 1);
  const pad  = d._groundEffectGain(0.02, 1);
  const far  = d._groundEffectGain(3.0, 1);
  assert.ok(peak > pad,
    'the cushion peaks before the pad, then recirculation eats it: '
    + peak.toFixed(3) + ' vs ' + pad.toFixed(3));
  assert.ok(peak > far * 10, 'and it must vanish in free air, got ' + far.toFixed(4));
});

test('rotor plant: a banked quad on the pad is tipped by the low-side ground effect', () => {
  const { ctx, Drone } = setup();
  function kick(tilt) {
    const d = airborne(Drone, 0.2);
    d.quat.setFromEuler(new ctx.THREE.Euler(0, 0, tilt));
    /* Spin the motors up and hold the airframe still, then look at the
       torque of one clean step from rest. */
    for (let i = 0; i < 60; i++) {
      d.position.y = 0.2;
      d.velocity.set(0, 0, 0);
      d._stepRotors(1 / 240, 10, 12);
    }
    d.angVel.set(0, 0, 0);
    d._stepRotors(1 / 240, 10, 12);
    return d;
  }
  /* Rolled 15°, the props on one side sit closer to the ground and gain
     more thrust, which is a roll torque the airframe did not ask for. */
  const tilted = kick(15 * Math.PI / 180);
  const level  = kick(0);
  assert.ok(Math.abs(tilted.angVel.z) > Math.abs(level.angVel.z) + 1e-3,
    'the low-side discs should roll the airframe: ' + tilted.angVel.z.toFixed(4)
    + ' vs ' + level.angVel.z.toFixed(4) + ' rad/s');
});

test('rotor plant: a wall pushes the airframe away from it', () => {
  const { CFG, Drone } = setup();
  /* Widen the wall reach so the test does not have to sit the props
     against the surface (the real reach is ~1 prop diameter). */
  CFG.physics.rotor.proximity.wall.reach = 4;
  function hover(wall) {
    const d = airborne(Drone, 2);
    d.colliders = wall
      ? [{ type: 'box', x: 0.35, z: 0, w: 0.2, d: 6, h: 4, yMin: 0, cos: 1, sin: 0 }]
      : [];
    fly(d, 0.4, 1 / 240, hoverStick());
    return d;
  }
  const near = hover(true);
  const free = hover(false);
  assert.ok(near._proxAccel.x < -0.2,
    'the blocked outwash should push away from the wall, got '
    + near._proxAccel.x.toFixed(2) + ' m/s²');
  assert.ok(near.velocity.x < free.velocity.x - 0.02,
    'and the push should show up in the velocity: '
    + near.velocity.x.toFixed(3) + ' vs ' + free.velocity.x.toFixed(3) + ' m/s');
  assert.ok(Math.abs(free._proxAccel.x) < 1e-6, 'no wall, no push');
});

test('rotor plant: a ceiling starves the props and pulls the airframe up', () => {
  const { Drone } = setup();
  function hover(ceiling) {
    const d = airborne(Drone, 2);
    d.colliders = ceiling
      ? [{ type: 'box', x: 0, z: 0, w: 6, d: 6, h: 2.4, yMin: 2.06, cos: 1, sin: 0 }]
      : [];
    /* Hold the airframe under the surface: the starved disc would sink out
       of the ceiling's reach otherwise. */
    for (let i = 0; i < 240; i++) {
      d.position.y = 2;
      d.velocity.set(0, 0, 0);
      d.step(1 / 240, hoverStick());
    }
    return d;
  }
  const under = hover(true);
  const free = hover(false);
  assert.ok(under._thrustState < free._thrustState * 0.98,
    'the inlet has nowhere to breathe: ' + under._thrustState.toFixed(2)
    + ' N vs ' + free._thrustState.toFixed(2) + ' N');
  assert.ok(under._proxAccel.y > 0.05,
    'and the low pressure should pull it toward the ceiling, got '
    + under._proxAccel.y.toFixed(3) + ' m/s²');
});

test('rotor plant: ground height is sampled once per step, at the airframe', () => {
  const { Drone } = setup();
  const d = airborne(Drone, 0.2);
  const calls = [];
  const orig = d.getFloorY.bind(d);
  d.getFloorY = function (x, z) {
    calls.push([x, z]);
    return orig(x, z);
  };
  const steps = 10;
  for (let i = 0; i < steps; i++) {
    d.position.set(0.3, 0.2, -0.4);
    d.velocity.set(0, 0, 0);
    d._stepRotors(1 / 240, 10, 12);
  }
  /* A GLB map answers getFloorY with a raycast, so it must be one sample
     per step (plus none for the four props). */
  assert.equal(calls.length, steps,
    'expected one ground sample per step, got ' + calls.length + ' for '
    + steps + ' steps');
  assert.ok(calls.every((p) => p[0] === 0.3 && p[1] === -0.4),
    'the sample must be the airframe centre, got ' + JSON.stringify(calls[0]));
});

test('rotor plant: ground.reach = 0 turns off only the ground effect', () => {
  const { CFG, Drone } = setup();
  CFG.physics.rotor.proximity.ground.reach = 0;
  CFG.physics.rotor.proximity.wall.reach = 4;

  /* Wall: still shoved away from it. */
  const wall = airborne(Drone, 2);
  wall.colliders = [{ type: 'box', x: 0.35, z: 0, w: 0.2, d: 6, h: 4, yMin: 0, cos: 1, sin: 0 }];
  fly(wall, 0.4, 1 / 240, hoverStick());
  assert.ok(wall._proxAccel.x < -0.2,
    'wall push must not depend on ground.reach, got '
    + wall._proxAccel.x.toFixed(2) + ' m/s²');

  /* Ceiling: still starves the inlets and pulls the airframe up. */
  const ceil = airborne(Drone, 2);
  ceil.colliders = [{ type: 'box', x: 0, z: 0, w: 6, d: 6, h: 2.4, yMin: 2.06, cos: 1, sin: 0 }];
  for (let i = 0; i < 240; i++) {
    ceil.position.y = 2;
    ceil.velocity.set(0, 0, 0);
    ceil.step(1 / 240, hoverStick());
  }
  assert.ok(ceil._proxAccel.y > 0.05,
    'ceiling suck must not depend on ground.reach, got '
    + ceil._proxAccel.y.toFixed(3) + ' m/s²');
});
