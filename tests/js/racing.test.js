/* js/racing.js — gate crossing and lap timing. The module is time-based,
   so the harness clock drives performance.now() deterministically. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, createTimers } = require('./helpers/harness.js');

function setup(gates) {
  const timers = createTimers(0);
  const ctx = loadSim(['js/racing.js'], { timers });
  const scene = {
    added: [],
    add(obj) { this.added.push(obj); },
    remove(obj) {
      const i = this.added.indexOf(obj);
      if (i >= 0) this.added.splice(i, 1);
    }
  };
  ctx.Racing.init({ gates: gates || null }, scene);
  return { ctx, Racing: ctx.Racing, timers, scene, THREE: ctx.THREE };
}

function droneAt(THREE, x, y, z) {
  return {
    position: new THREE.Vector3(x, y, z),
    crashed: false
  };
}

const GATES = [
  { x: 0, y: 1, z: 5, ry: 0, w: 2, h: 2 },
  { x: 0, y: 1, z: 15, ry: 0, w: 2, h: 2 }
];

test('racing stays inactive on worlds without gates', () => {
  const { Racing } = setup(null);
  assert.equal(Racing.getState().active, false);
  const d = { position: { x: 0, y: 1, z: 0 }, crashed: false };
  assert.doesNotThrow(() => Racing.update(0.016, d));
});

test('init reports gate count and adds a ghost mesh', () => {
  const { Racing, scene } = setup(GATES);
  const s = Racing.getState();
  assert.equal(s.active, true);
  assert.equal(s.totalGates, 2);
  assert.equal(scene.added.length, 1, 'ghost marker should be in the scene');
});

test('passing gate 0 starts a lap; passing the last gate completes it', () => {
  const { Racing, timers, THREE } = setup(GATES);
  const d = droneAt(THREE, 0, 1, 4);

  Racing.update(0.016, d);             // establish prevPos behind gate 0
  d.position.set(0, 1, 6);
  Racing.update(0.016, d);
  let s = Racing.getState();
  assert.equal(s.started, true, 'lap should start on gate 0');
  assert.equal(s.currentGate, 1);
  assert.equal(s.gatesThisLap, 1);

  timers.advance(2000);
  Racing.update(0.016, d);             // refresh lapMs
  d.position.set(0, 1, 16);
  Racing.update(0.016, d);
  s = Racing.getState();
  assert.equal(s.lapCount, 1);
  assert.equal(s.started, false, 'crossing the final gate ends the lap');
  assert.equal(s.currentGate, 0);
  assert.ok(Math.abs(s.lastLapMs - 2000) < 20, 'lap time ' + s.lastLapMs);
  assert.ok(Math.abs(s.bestMs - s.lastLapMs) < 1e-9);
  assert.ok(s.lapCompleteAt > 0);
});

test('a crossing outside the gate opening is ignored', () => {
  const { Racing, THREE } = setup(GATES);
  const d = droneAt(THREE, 0, 1, 4);
  Racing.update(0.016, d);
  d.position.set(5, 1, 6);             // x = 5, gate half-width 1
  Racing.update(0.016, d);
  assert.equal(Racing.getState().started, false);
});

test('a crossing at the wrong height is ignored', () => {
  const { Racing, THREE } = setup(GATES);
  const d = droneAt(THREE, 0, 1, 4);
  Racing.update(0.016, d);
  d.position.set(0, 9, 6);             // far above the gate
  Racing.update(0.016, d);
  assert.equal(Racing.getState().started, false);
});

test('gates only count in order', () => {
  const { Racing, timers, THREE } = setup(GATES);
  const d = droneAt(THREE, 0, 1, 4);
  Racing.update(0.016, d);

  d.position.set(0, 1, 6);
  Racing.update(0.016, d);             // start, next gate is #2
  timers.advance(100);

  d.position.set(0, 1, 16);
  Racing.update(0.016, d);             // gate #1 -> lap completes
  timers.advance(100);
  // Crossing the *second* gate again while looking for gate #0 must not count.
  d.position.set(0, 1, 16);
  Racing.update(0.016, d);
  assert.equal(Racing.getState().currentGate, 0);
});

test('a crashed drone does not start or advance a lap', () => {
  const { Racing, THREE } = setup(GATES);
  const d = droneAt(THREE, 0, 1, 4);
  Racing.update(0.016, d);

  d.crashed = true;
  d.position.set(0, 1, 6);
  Racing.update(0.016, d);
  assert.equal(Racing.getState().started, false, 'crash teleport must not start a lap');
});

test('a faster second lap replaces the best/ghost time', () => {
  const { Racing, timers, THREE } = setup(GATES);
  const d = droneAt(THREE, 0, 1, 4);

  function lap(ms, first) {
    if (!first) {
      /* Return to the start without counting a gate: the crashed branch
         syncs prevPos to the new position. */
      d.crashed = true;
      d.position.set(0, 1, 4);
      Racing.update(0.016, d);
      d.crashed = false;
    }
    Racing.update(0.016, d);
    d.position.set(0, 1, 6);
    Racing.update(0.016, d);
    timers.advance(ms);
    Racing.update(0.016, d);
    d.position.set(0, 1, 16);
    Racing.update(0.016, d);
  }

  lap(3000, true);
  assert.ok(Math.abs(Racing.getState().bestMs - 3000) < 40);
  lap(2000);
  const s = Racing.getState();
  assert.equal(s.lapCount, 2);
  assert.ok(s.bestMs < 2100, 'best lap should be the faster one: ' + s.bestMs);

  timers.advance(5000);
  lap(2500);
  assert.ok(Racing.getState().bestMs < 2100, 'a slower lap must not replace the best');
});

test('reset clears the timer and lap state but keeps racing active', () => {
  const { Racing, THREE } = setup(GATES);
  const d = droneAt(THREE, 0, 1, 4);
  Racing.update(0.016, d);
  d.position.set(0, 1, 6);
  Racing.update(0.016, d);
  assert.equal(Racing.getState().started, true);

  Racing.reset();
  const s = Racing.getState();
  assert.equal(s.started, false);
  assert.equal(s.currentGate, 0);
  assert.equal(s.active, true);
});
