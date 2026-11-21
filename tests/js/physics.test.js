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

test('low throttle has less rotational authority than full throttle', () => {
  const { Drone } = setup();
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
