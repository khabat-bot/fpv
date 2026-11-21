/* js/parts.js — part catalogs and Loadout.apply(). The loadout writes into
   CFG in place, so these tests check both the composition math and that
   applying a loadout cannot push the flight model out of its safe range. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./helpers/harness.js');

const DEFAULT = {
  frame: 'freestyle_5',
  motors: 'default_2207',
  props: 'default_5140',
  battery: 'default_6s_1300'
};

function setup() {
  const ctx = loadSim(['js/config.js', 'js/parts.js']);
  return { ctx, CFG: ctx.CFG, PARTS: ctx.PARTS, Loadout: ctx.Loadout };
}

test('every catalog is populated and its ids match its keys', () => {
  const { PARTS } = setup();
  for (const [groupName, group] of Object.entries(PARTS)) {
    const ids = Object.keys(group);
    assert.ok(ids.length >= 8, groupName + ' should have at least 8 options');
    for (const [key, item] of Object.entries(group)) {
      assert.equal(item.id, key, groupName + '.' + key + ' id mismatch');
      assert.ok(typeof item.name === 'string' && item.name.length > 0);
    }
  }
});

test('frames, motors, props and batteries carry the fields the loadout reads', () => {
  const { PARTS } = setup();
  for (const f of Object.values(PARTS.FRAMES)) {
    for (const k of ['scale', 'massAdd', 'maxRatesMul', 'dragMul']) {
      assert.ok(Number.isFinite(f[k]), 'frame ' + f.id + '.' + k);
    }
    assert.ok(f.scale > 0);
  }
  for (const m of Object.values(PARTS.MOTORS)) {
    for (const k of ['kv', 'massAdd', 'maxRatesMul', 'currentMul', 'statorVol', 'peakTorque']) {
      assert.ok(Number.isFinite(m[k]), 'motor ' + m.id + '.' + k);
    }
    assert.ok(m.kv > 0 && m.peakTorque > 0);
  }
  for (const p of Object.values(PARTS.PROPS)) {
    for (const k of ['diameterIn', 'pitchIn', 'blades', 'massAdd']) {
      assert.ok(Number.isFinite(p[k]), 'prop ' + p.id + '.' + k);
    }
    assert.ok(p.blades >= 2);
  }
  for (const b of Object.values(PARTS.BATTERY)) {
    for (const k of ['cells', 'capacityMah', 'maxCurrent', 'massAdd', 'thrustMul']) {
      assert.ok(Number.isFinite(b[k]), 'battery ' + b.id + '.' + k);
    }
    assert.ok(b.cells >= 1 && b.capacityMah > 0);
  }
});

test('the baseline combo reproduces the stock flight model', () => {
  const { CFG, Loadout } = setup();
  const e = Loadout.buildEffective(DEFAULT);
  assert.ok(Math.abs(e.mass - CFG.mass) < 1e-9, 'mass ' + e.mass);
  assert.ok(Math.abs(e.thrustToWeight - CFG.thrustToWeight) < 0.05,
    'T/W ' + e.thrustToWeight + ' vs ' + CFG.thrustToWeight);
  assert.ok(Math.abs(e.maxRates.roll - CFG.maxRates.roll) < 1e-9);
  assert.ok(Math.abs(e.dragLinear - CFG.dragLinear) < 1e-9);
  assert.equal(e.groundY, CFG.groundY);
});

test('unknown part ids fall back to the baseline instead of breaking', () => {
  const { Loadout } = setup();
  const e = Loadout.buildEffective({ frame: 'nope', motors: 'nope', props: 'nope', battery: 'nope' });
  const base = Loadout.buildEffective(DEFAULT);
  assert.equal(e.mass, base.mass);
  assert.equal(e.thrustToWeight, base.thrustToWeight);
  assert.equal(e.sphereScale, base.sphereScale);
});

test('every possible combo stays inside the safe mass and T/W envelope', () => {
  const { PARTS, Loadout } = setup();
  const frames = Object.keys(PARTS.FRAMES);
  const motors = Object.keys(PARTS.MOTORS);
  const props = Object.keys(PARTS.PROPS);
  const batteries = Object.keys(PARTS.BATTERY);

  for (const frame of frames) {
    for (const motor of motors) {
      for (const prop of props) {
        for (const battery of batteries) {
          const e = Loadout.buildEffective({ frame, motors: motor, props: prop, battery });
          const label = frame + '/' + motor + '/' + prop + '/' + battery;
          assert.ok(Number.isFinite(e.mass) && e.mass >= 0.02, label + ' mass ' + e.mass);
          assert.ok(Number.isFinite(e.thrustToWeight), label + ' T/W not finite');
          assert.ok(e.thrustToWeight >= 1.5 && e.thrustToWeight <= 15, label + ' T/W ' + e.thrustToWeight);
          assert.ok(e.maxRates.roll > 0 && e.maxRates.pitch > 0 && e.maxRates.yaw > 0, label + ' rates');
          assert.ok(e.dragLinear >= 0 && e.dragQuadratic >= 0, label + ' drag');
          assert.ok(e.battery.cells >= 1 && e.battery.capacityMah > 0, label + ' battery');
          assert.ok(e.battery.maxCurrent > 0, label + ' battery current');
        }
      }
    }
  }
});

test('the prop loadout publishes its advance-ratio coefficients', () => {
  const { Loadout } = setup();
  const base = Loadout.buildEffective(DEFAULT).thrustInfo.aero;
  const low  = Loadout.buildEffective({ ...DEFAULT, props: 'low_pitch_5130' }).thrustInfo.aero;
  const high = Loadout.buildEffective({ ...DEFAULT, props: 'high_pitch_5152' }).thrustInfo.aero;

  assert.ok(Math.abs(base.diameterM - 5.1 * 0.0254) < 1e-9, 'diameter ' + base.diameterM);
  assert.ok(base.jZero > 1.0 && base.jZero < 2.0, 'default jZero ' + base.jZero);
  assert.ok(high.jZero > base.jZero, 'a steeper prop must pull to a higher advance ratio');
  assert.ok(low.jZero < base.jZero, 'a flatter prop must choke sooner');
  for (const a of [base, low, high]) {
    assert.ok(Number.isFinite(a.jZero) && a.jZero > 0, 'jZero ' + a.jZero);
    assert.ok(Number.isFinite(a.cqSlope) && a.cqSlope > 0, 'cqSlope ' + a.cqSlope);
    assert.ok(a.diameterM > 0, 'diameter ' + a.diameterM);
  }
});

test('a prop that is too large for a motor is flagged as torque-limited', () => {
  const { Loadout } = setup();
  const e = Loadout.buildEffective({
    frame: 'tinywhoop_2',
    motors: 'tiny_0802',
    props: 'race_7x35',
    battery: 'tiny_1s_450'
  });
  assert.equal(e.thrustInfo.limited, true);
  assert.ok(e.thrustInfo.rpm < e.thrustInfo.noLoadRpm);
});

test('apply() writes the composed loadout into CFG and recomputes maxThrust', () => {
  const { ctx, CFG, Loadout } = setup();
  const racing = {
    frame: 'racing_5',
    motors: 'race_2207_2750',
    props: 'race_5143_3',
    battery: 'light_4s_850'
  };
  const e = Loadout.apply(racing);
  assert.equal(CFG.mass, e.mass);
  assert.equal(CFG.thrustToWeight, e.thrustToWeight);
  assert.equal(CFG.battery.cells, 4);
  assert.equal(CFG.maxThrust, CFG.mass * CFG.gravity * CFG.thrustToWeight);
  assert.equal(ctx.__loadout.frame, 'racing_5');
  assert.equal(ctx.__loadout.effective.thrustInfo.rpm, e.thrustInfo.rpm);
});

test('applying the default loadout restores the pristine CFG values', () => {
  const { CFG, Loadout } = setup();
  const base = Loadout.BASE;
  Loadout.apply({ frame: 'longrange_7', motors: 'large_2806', props: 'race_7x35', battery: 'long_6s_2200' });
  assert.notEqual(CFG.mass, base.mass);

  Loadout.apply(DEFAULT);
  assert.equal(CFG.mass, base.mass);
  // The motor model composes thrust; the stock combo lands within the
  // documented "baseline" tolerance of the hand-tuned 5.2 T/W.
  assert.ok(Math.abs(CFG.thrustToWeight - base.thrustToWeight) < 0.05,
    'T/W ' + CFG.thrustToWeight + ' vs ' + base.thrustToWeight);
  assert.deepEqual(CFG.maxRates, base.maxRates);
  assert.deepEqual(CFG.battery, base.battery);
  assert.equal(CFG.groundY, base.groundY);
});

test('the loadout base snapshot is immutable', () => {
  const { Loadout } = setup();
  const before = JSON.stringify(Loadout.BASE);
  Loadout.apply({ frame: 'cinematic_3', motors: 'small_1404', props: 'cine_3x3', battery: 'micro_4s_650' });
  assert.equal(JSON.stringify(Loadout.BASE), before);
});

test('a smaller frame scales the collision envelope and crash speeds', () => {
  const { Loadout } = setup();
  const small = Loadout.buildEffective({ frame: 'tinywhoop_2', motors: 'tiny_0802', props: 'tiny_2x2', battery: 'tiny_1s_450' });
  const full = Loadout.buildEffective(DEFAULT);
  assert.ok(small.sphereScale < full.sphereScale);
  assert.ok(small.crashSpeed < full.crashSpeed);
  assert.ok(small.groundY < full.groundY);
});
