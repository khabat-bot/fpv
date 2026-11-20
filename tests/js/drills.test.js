/* js/drills.js — practice metrics. Pure logic over a drone-shaped object,
   so each drill can be exercised with a scripted flight path. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./helpers/harness.js');

function setup() {
  const ctx = loadSim(['js/drills.js']);
  return ctx.Drills;
}

function fakeDrone(x, y, z) {
  const d = {
    position: { x: x || 0, y: y || 0, z: z || 0 },
    velocity: { x: 0, y: 0, z: 0 },
    throttleIn: 0,
    _groundedTime: 0
  };
  d.velocity.length = function () {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  };
  return d;
}

test('no drill is active before start and end() is a no-op', () => {
  const Drills = setup();
  assert.equal(Drills.isActive(), false);
  assert.equal(Drills.getActiveName(), null);
  assert.equal(Drills.end(), null);
  assert.equal(Drills.tick(fakeDrone(), 0.1), undefined);
});

test('hover drill reports drift RMS, max drift and throttle steadiness', () => {
  const Drills = setup();
  const d = fakeDrone(0, 0, 0);
  d.throttleIn = 0.2;
  Drills.start('hover');
  Drills.tick(d, 0.5);                 // spawn point recorded at origin

  const offsets = [1, 3, 2, 2];
  for (const x of offsets) {
    d.position.x = x;
    Drills.tick(d, 0.5);
  }
  const m = Drills.end();
  assert.equal(m.name, 'HOVER');
  assert.ok(Math.abs(m.driftRMS - Math.sqrt((0 + 1 + 9 + 4 + 4) / 5)) < 1e-9, 'rms ' + m.driftRMS);
  assert.equal(m.maxDrift, 3);
  assert.equal(m.throttleStdDev, 0);
  assert.ok(m.duration > 2.4);
});

test('hover drill auto-completes at 30 seconds and calls back once', () => {
  const Drills = setup();
  let calls = 0;
  let metrics = null;
  Drills.start('hover', (m) => { calls++; metrics = m; });
  Drills.tick(fakeDrone(), 31);
  assert.equal(Drills.isActive(), false);
  assert.equal(calls, 1);
  assert.ok(metrics.duration >= 30);
});

test('hover throttle variation shows up as a standard deviation', () => {
  const Drills = setup();
  const d = fakeDrone();
  Drills.start('hover');
  d.throttleIn = 0.2; Drills.tick(d, 1);
  d.throttleIn = 0.4; Drills.tick(d, 1);
  const m = Drills.end();
  assert.ok(Math.abs(m.throttleStdDev - 0.1) < 1e-9, 'stddev ' + m.throttleStdDev);
});

test('land drill measures touchdown speeds and settle time', () => {
  const Drills = setup();
  const d = fakeDrone(0, 5, 0);
  Drills.start('land');

  Drills.tick(d, 0.1);                 // airborne, above 0.5 m
  d.position.y = 0.2;
  d._groundedTime = 0.15;
  d.velocity.y = -0.6;
  d.velocity.x = 0.3;
  Drills.tick(d, 0.2);                 // touchdown
  d.velocity.y = 0;
  d.velocity.x = 0.05;
  Drills.tick(d, 0.3);                 // settled

  assert.equal(Drills.isActive(), false);
  const m = Drills.end();              // end() after auto-complete is a no-op
  assert.equal(m, null);

  // Re-run and read metrics via callback, since touch-and-settle auto-ends.
  let out = null;
  Drills.start('land', (x) => { out = x; });
  const e = fakeDrone(0, 4, 0);
  Drills.tick(e, 0.1);
  e.position.y = 0.2; e._groundedTime = 0.15;
  e.velocity.y = -0.8; e.velocity.x = 0.6;
  Drills.tick(e, 0.2);
  e.velocity.y = 0; e.velocity.x = 0.02;
  Drills.tick(e, 0.25);
  assert.ok(out, 'land should complete');
  assert.ok(Math.abs(out.contactVSpeed - 0.8) < 1e-9, 'v speed ' + out.contactVSpeed);
  assert.ok(Math.abs(out.contactLSpeed - 0.6) < 1e-9, 'l speed ' + out.contactLSpeed);
  assert.ok(out.settleTime >= 0.2 && out.settleTime <= 0.3, 'settle ' + out.settleTime);
});

test('figure-eight drill counts crossings, path length and deviation', () => {
  const Drills = setup();
  const d = fakeDrone(0, 1, 0);
  Drills.start('eight');
  Drills.tick(d, 0.1);                 // centre

  d.position.x = 2;
  Drills.tick(d, 0.1);
  d.position.x = -2;
  Drills.tick(d, 0.1);
  d.position.x = 2;
  Drills.tick(d, 0.1);

  const m = Drills.end();
  assert.equal(m.name, 'EIGHT');
  assert.equal(m.crossings, 2);
  assert.equal(m.maxDeviation, 2);
  assert.ok(m.pathLength > 9.9, 'path length ' + m.pathLength);
});

test('orbit drill measures radius consistency and total angle', () => {
  const Drills = setup();
  const d = fakeDrone(0, 1, 0);
  Drills.start('orbit');
  Drills.tick(d, 0.1);                 // centre

  const points = [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 0]];
  for (const [x, z] of points) {
    d.position.x = x;
    d.position.z = z;
    Drills.tick(d, 0.25);
  }
  const m = Drills.end();
  assert.equal(m.name, 'ORBIT');
  assert.ok(Math.abs(m.radiusMean - 2) < 1e-9, 'radius mean ' + m.radiusMean);
  assert.ok(m.radiusStdDev < 1e-9, 'radius stddev ' + m.radiusStdDev);
  assert.ok(Math.abs(m.totalAngle - 2 * Math.PI) < 1e-6, 'total angle ' + m.totalAngle);
});

test('starting a new drill replaces the previous one', () => {
  const Drills = setup();
  Drills.start('hover');
  Drills.tick(fakeDrone(), 1);
  Drills.start('orbit');
  assert.equal(Drills.getActiveName(), 'orbit');
  assert.equal(Drills.getMetrics().name, 'ORBIT');
});

test('metrics are readable mid-drill', () => {
  const Drills = setup();
  const d = fakeDrone();
  Drills.start('hover');
  Drills.tick(d, 0.1);              // spawn point is recorded here
  d.position.x = 1.5;
  Drills.tick(d, 1);
  const live = Drills.getMetrics();
  assert.equal(live.name, 'HOVER');
  assert.equal(live.maxDrift, 1.5);
});
