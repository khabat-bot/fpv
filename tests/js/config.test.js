/* CFG is the single source of truth for the flight model, so its shape and
   ranges are part of the contract: a typo here silently changes the feel
   of every flight. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./helpers/harness.js');

const ctx = loadSim(['js/config.js']);
const CFG = ctx.CFG;

function walkNumbers(value, path, visit) {
  if (typeof value === 'number') { visit(value, path); return; }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkNumbers(v, path + '[' + i + ']', visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) walkNumbers(value[k], path ? path + '.' + k : k, visit);
  }
}

test('every numeric tunable is finite', () => {
  walkNumbers(CFG, '', (n, p) => {
    assert.ok(Number.isFinite(n), 'non-finite CFG value at ' + p);
  });
});

test('airframe and flight-model values are in sane ranges', () => {
  assert.ok(CFG.mass > 0, 'mass');
  assert.ok(CFG.gravity > 0, 'gravity');
  assert.ok(CFG.thrustToWeight >= 1.5 && CFG.thrustToWeight <= 15, 'T/W');
  assert.ok(CFG.maxRates.roll > 0 && CFG.maxRates.pitch > 0 && CFG.maxRates.yaw > 0);
  assert.ok(CFG.rcRate > 0);
  assert.ok(CFG.expo >= 0 && CFG.expo < 1, 'expo must be in [0,1)');
  assert.ok(CFG.angResponse > 0);
  assert.ok(CFG.angAccelMax > 0);
  assert.ok(CFG.dragLinear >= 0 && CFG.dragQuadratic >= 0);
});

test('maxThrust is derived from mass, gravity and T/W', () => {
  assert.ok(Number.isFinite(CFG.maxThrust));
  assert.equal(CFG.maxThrust, CFG.mass * CFG.gravity * CFG.thrustToWeight);
});

test('motor authority coupling is a fraction', () => {
  const m = CFG.feel.motorAuthority;
  for (const k of ['rollPitch', 'yaw']) {
    assert.ok(m[k] >= 0 && m[k] <= 1, k);
  }
  assert.ok(m.rollPitch >= m.yaw, 'yaw should have no more authority than roll/pitch');
});

test('ESC lags are positive and spin-down is slower than spin-up', () => {
  assert.ok(CFG.esc.spinUp > 0);
  assert.ok(CFG.esc.spinDown > 0);
  assert.ok(CFG.esc.rateLag > 0);
  assert.ok(CFG.esc.spinDown > CFG.esc.spinUp, 'props coast slower than they spin up');
});

test('battery model has usable values', () => {
  assert.ok(CFG.battery.cells >= 1 && CFG.battery.cells <= 12);
  assert.ok(CFG.battery.capacityMah > 0);
  assert.ok(CFG.battery.maxCurrent > 0);
  assert.ok(CFG.battery.lowCellVoltage > 2.5 && CFG.battery.lowCellVoltage < 4.2);
});

test('wind presets are complete, CALM is still, GUSTY is gustier than BREEZY', () => {
  for (const [name, p] of Object.entries(CFG.wind)) {
    for (const k of ['x', 'y', 'z', 'gust']) assert.ok(Number.isFinite(p[k]), name + '.' + k);
  }
  assert.equal(CFG.wind.CALM.x + CFG.wind.CALM.y + CFG.wind.CALM.z, 0);
  assert.equal(CFG.wind.CALM.gust, 0);
  assert.ok(CFG.wind.GUSTY.gust > CFG.wind.BREEZY.gust);
  assert.ok(CFG.wind[CFG.windPreset], 'windPreset points at a preset');
});

test('easy-mode presets are complete and ordered by capability', () => {
  const presets = CFG.easyMode.presets;
  const names = ['SLOW', 'SPORT', 'FAST'];
  for (const name of names) {
    const p = presets[name];
    assert.ok(p, 'missing preset ' + name);
    assert.ok(p.maxAngleDeg > 0 && p.maxAngleDeg <= 90);
    assert.ok(p.maxRatesScale > 0 && p.maxRatesScale <= 1.5);
    assert.ok(p.yawRatesScale > 0 && p.yawRatesScale <= 1.5);
    assert.ok(p.maxClimbRate > 0 && p.maxDescendRate > 0);
  }
  assert.ok(presets.SLOW.maxAngleDeg < presets.SPORT.maxAngleDeg);
  assert.ok(presets.SPORT.maxAngleDeg < presets.FAST.maxAngleDeg);
  assert.ok(presets.SLOW.maxClimbRate < presets.FAST.maxClimbRate);
  assert.ok(CFG.easyMode.levelGain > 0 && CFG.easyMode.altGain > 0);
});

test('crash severity stages degrade monotonically', () => {
  const sev = CFG.crashSeverity;
  assert.ok(sev.damageSpeed > 0 && sev.damageSpeed < CFG.crashSpeed);
  assert.ok(sev.fatalSpeed > CFG.crashSpeed);
  assert.ok(sev.damageCooldown > 0);
  assert.ok(sev.stages.length >= 2);
  assert.equal(sev.stages[0].thrustScale, 1);
  assert.equal(sev.stages[0].authorityScale, 1);
  assert.equal(sev.stages[0].asymmetry, 0);
  for (let i = 1; i < sev.stages.length; i++) {
    assert.ok(sev.stages[i].thrustScale < sev.stages[i - 1].thrustScale, 'thrust stage ' + i);
    assert.ok(sev.stages[i].authorityScale < sev.stages[i - 1].authorityScale, 'authority stage ' + i);
    assert.ok(sev.stages[i].asymmetry >= 0 && sev.stages[i].asymmetry <= 1);
  }
});

test('environment and telemetry settings are coherent', () => {
  assert.ok(CFG.environment.seaLevelPressure > 0);
  assert.ok(CFG.environment.tempC > -80 && CFG.environment.tempC < 80);
  assert.equal(typeof CFG.environment.density, 'boolean');
  assert.ok(CFG.telemetry.sampleHz > 0);
  assert.ok(CFG.telemetry.windowSec > 0);
  assert.ok(CFG.telemetry.graphWindowSec > 0);
  assert.ok(CFG.telemetry.graphRangeDeg > 0);
});

test('every environment preset defines the full lighting/colour set', () => {
  const required = [
    'background', 'fogColor', 'fogNear', 'fogFar',
    'sunColor', 'sunIntensity', 'hemiSkyColor', 'hemiGroundColor',
    'hemiIntensity', 'fillColor', 'fillIntensity', 'skyTop', 'skyBot'
  ];
  for (const [name, preset] of Object.entries(CFG.env)) {
    for (const k of required) assert.ok(preset[k] !== undefined, name + ' missing ' + k);
    assert.ok(preset.fogNear < preset.fogFar, name + ' fog range');
  }
});

test('controller defaults use a known channel order and stick mode', () => {
  const c = CFG.controller;
  assert.ok(['AETR', 'TAER', 'RETA', 'ETAR'].includes(c.order));
  assert.ok(['MODE1', 'MODE2', 'RADIO'].includes(c.stickMode));
  assert.ok(['AUTO', 'PAD', 'CRSF', 'OFF'].includes(c.source));
  assert.ok(c.deadband >= 0 && c.deadband < 0.5);
  assert.ok(c.travel > 0.3 && c.travel <= 1);
  assert.ok(c.timeoutMs > 0);
  assert.ok(c.dropSecs >= 0);
  assert.ok(c.crsf.baudRate > 0);
  assert.ok(c.crsf.timeoutMs > 0);
});
