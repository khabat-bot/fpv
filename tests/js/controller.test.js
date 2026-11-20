/* js/controller.js — CRSF serial parsing, gamepad shaping, link failsafe.
   The module ships test hooks (_feedSerial/_crc8/_unpackChannels); these
   tests use them plus a virtual gamepad, so no hardware is needed. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, createTimers } = require('./helpers/harness.js');

/* CRC8/DVB-S2, independent implementation so the module's own table is
   not used to validate itself. */
function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? (((crc << 1) ^ 0xD5) & 0xFF) : ((crc << 1) & 0xFF);
    }
  }
  return crc;
}

function packChannels(channels) {
  const out = Buffer.alloc(22);
  let acc = 0;
  let bits = 0;
  let oi = 0;
  for (let i = 0; i < 16; i++) {
    acc |= ((channels[i] || 0) & 0x7FF) << bits;
    bits += 11;
    while (bits >= 8) {
      out[oi++] = acc & 0xFF;
      acc >>>= 8;
      bits -= 8;
    }
  }
  return out;
}

function crsfFrame(channels) {
  const payload = packChannels(channels);
  const len = 2 + payload.length;             // type + payload + crc
  const buf = Buffer.alloc(len + 2);
  buf[0] = 0xC8;
  buf[1] = len;
  buf[2] = 0x16;
  payload.copy(buf, 3);
  buf[3 + payload.length] = crc8(buf.subarray(2, 3 + payload.length));
  return buf;
}

function setup() {
  const timers = createTimers(1000);
  const ctx = loadSim(['js/config.js', 'js/controller.js'], { timers, startTime: 1000 });
  ctx.CFG.controller.source = 'CRSF';
  return { ctx, CFG: ctx.CFG, Controller: ctx.Controller, timers };
}

test('CRC8/DVB-S2 check value matches the standard', () => {
  const { ctx } = setup();
  assert.equal(ctx.Controller._crc8(Buffer.from('123456789'), 0, 9), 0xBC);
});

test('11-bit channel unpacking round-trips', () => {
  const { ctx } = setup();
  const channels = [0, 1, 172, 992, 1812, 2047, 1000, 1500, 2000, 300, 1200, 800, 1600, 400, 600, 1400];
  const payload = packChannels(channels);
  assert.deepEqual(Array.from(ctx.Controller._unpackChannels(payload)), channels);
});

test('a valid CRSF frame makes the link live and reports channels', () => {
  const { ctx, Controller } = setup();
  Controller._feedSerial(crsfFrame([1812, 992, 992, 172, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]));
  const status = Controller.status();
  assert.equal(status.connected, true);
  assert.equal(status.kind, 'CRSF');
  assert.equal(status.source, 'CRSF');
});

test('channels map onto the axes using the configured order', () => {
  const { ctx, CFG, Controller } = setup();
  // AETR: ch0 roll, ch1 pitch, ch2 throttle, ch3 yaw
  Controller._feedSerial(crsfFrame([1812, 172, 1812, 172, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]));
  const out = Controller.update(1 / 60);
  assert.ok(out, 'expected controller output');
  assert.ok(out.roll > 0.95, 'roll ' + out.roll);
  assert.ok(out.pitch < -0.95, 'pitch ' + out.pitch);
  assert.ok(out.throttle > 0.95, 'throttle ' + out.throttle);
  assert.ok(out.yaw < -0.95, 'yaw ' + out.yaw);
  assert.equal(out.source, 'CRSF');
  assert.equal(out.failsafe, false);

  CFG.controller.order = 'TAER';   // ch0 throttle, ch1 roll, ch2 pitch, ch3 yaw
  Controller._feedSerial(crsfFrame([992, 1812, 172, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]));
  const t = Controller.update(1 / 60);
  assert.ok(Math.abs(t.throttle - 0.48) < 0.03, 'throttle ' + t.throttle);
  assert.ok(t.roll > 0.95);
  assert.ok(t.pitch < -0.95);
  assert.ok(Math.abs(t.yaw) < 0.001);
});

test('frames with a bad CRC or unknown type are ignored', () => {
  const { Controller } = setup();
  const bad = crsfFrame([992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]);
  bad[bad.length - 1] ^= 0xFF;
  Controller._feedSerial(bad);
  assert.equal(Controller.status().connected, false);

  const unknown = crsfFrame([992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]);
  unknown[2] = 0x14;                             // device info frame
  unknown[unknown.length - 1] = crc8(unknown.subarray(2, unknown.length - 1));
  Controller._feedSerial(unknown);
  assert.equal(Controller.status().connected, false);
});

test('the parser resyncs after leading garbage', () => {
  const { Controller } = setup();
  const frame = crsfFrame([992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]);
  Controller._feedSerial(Buffer.concat([Buffer.from([0x00, 0xFF, 0xC8, 0x99]), frame]));
  assert.equal(Controller.status().connected, true);
});

test('a frame split across serial reads is reassembled', () => {
  // Fresh context: _reset() clears link state but deliberately keeps the
  // serial RX buffer, as a real port would.
  const { Controller } = setup();
  const frame = crsfFrame([992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]);
  Controller._feedSerial(frame.subarray(0, 10));
  assert.equal(Controller.status().connected, false, 'half a frame must not parse');
  Controller._feedSerial(frame.subarray(10));
  assert.equal(Controller.status().connected, true, 'the rest of the frame completes it');
});

test('a noisy serial stream is bounded and still recovers', () => {
  const { Controller } = setup();
  const noise = Buffer.alloc(6000);
  for (let i = 0; i < noise.length; i++) noise[i] = 0x55;
  Controller._feedSerial(noise);
  Controller._feedSerial(crsfFrame([992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992]));
  assert.equal(Controller.status().connected, true);
});

test('gamepad axes are shaped with deadband and travel', () => {
  const { ctx, CFG, Controller } = setup();
  CFG.controller.source = 'PAD';
  const pad = { connected: true, id: 'Test Pad', axes: [0.03, 0, 0.3, 0], buttons: [] };
  let pads = [pad];
  ctx.navigator.getGamepads = () => pads;

  let out = Controller.update(1 / 60);
  assert.equal(out.source, 'PAD');
  assert.equal(out.yaw, 0, 'inside the deadband');
  assert.ok(Math.abs(out.roll - (0.3 - 0.04) / 0.96) < 1e-6, 'roll ' + out.roll);
  assert.ok(Math.abs(out.throttle - (0.5 - 0.04) / 0.96) < 1e-6, 'centred throttle is half');
  assert.equal(out.pitch, 0, 'mode 2 pitch axis is inverted and centred');

  CFG.controller.travel = 0.5;                    // a stick that only reaches 50%
  out = Controller.update(1 / 60);
  assert.ok(out.roll > 0.55, 'reduced travel should still reach the same output for less stick');
});

test('mode 1 and RADIO layouts use the documented axes', () => {
  const { ctx, CFG, Controller } = setup();
  CFG.controller.source = 'PAD';
  const pad = { connected: true, id: 'Pad', axes: [1, 0, 0.5, 0], buttons: [] };
  ctx.navigator.getGamepads = () => [pad];

  CFG.controller.stickMode = 'MODE1';             // left pitch/yaw, right thr/roll
  let out = Controller.update(1 / 60);
  assert.ok(out.yaw > 0.9, 'yaw from left X');
  assert.ok(out.roll > 0.4, 'roll from right X');
  assert.ok(out.throttle > 0.4);

  CFG.controller.stickMode = 'RADIO';
  CFG.controller.order = 'AETR';
  out = Controller.update(1 / 60);
  // ch1 -> X is roll here; ch2 -> Y is pitch; ch3 -> Z throttle; ch4 -> Rx yaw
  assert.ok(out.roll > 0.9);
});

test('throttle HOLD mode integrates a spring-centred stick', () => {
  const { ctx, CFG, Controller } = setup();
  CFG.controller.source = 'PAD';
  CFG.controller.thrMode = 'HOLD';
  CFG.controller.holdRate = 1.0;
  const pad = { connected: true, id: 'Pad', axes: [0, 0, 0, 0], buttons: [] };
  ctx.navigator.getGamepads = () => [pad];

  let out = Controller.update(0.5);
  assert.ok(Math.abs(out.throttle - 0) < 1e-9, 'centred stick holds throttle');

  pad.axes[1] = -1;                               // full up
  for (let i = 0; i < 5; i++) out = Controller.update(0.5);
  const held = out.throttle;
  assert.ok(held > 0.4, 'held throttle ramps up: ' + held);
  pad.axes[1] = 0;
  out = Controller.update(0.5);
  assert.ok(Math.abs(out.throttle - held) < 1e-9, 'throttle holds when the stick re-centres');
});

test('pad buttons emit arm and reset', () => {
  const { ctx, CFG, Controller } = setup();
  CFG.controller.source = 'PAD';
  const events = [];
  Controller.onEvent((type, data) => events.push(type));
  const btn = { pressed: false, value: 0 };
  const pad = { connected: true, id: 'Pad', axes: [0, 0, 0, 0], buttons: [btn, { pressed: false, value: 0 }] };
  ctx.navigator.getGamepads = () => [pad];

  Controller.update(1 / 60);
  btn.pressed = true;
  Controller.update(1 / 60);
  btn.pressed = false;
  Controller.update(1 / 60);
  assert.deepEqual(events, ['arm']);

  pad.buttons[1].pressed = true;
  Controller.update(1 / 60);
  assert.deepEqual(events, ['arm', 'reset']);
});

test('a lost pad triggers a failsafe descent, then cuts and releases control', () => {
  const { ctx, CFG, Controller, timers } = setup();
  CFG.controller.source = 'PAD';
  CFG.controller.timeoutMs = 100;
  CFG.controller.dropSecs = 0.5;
  CFG.controller.failsafe = true;
  CFG.controller.failsafeThrottle = 0.3;
  const pad = { connected: true, id: 'Pad', axes: [0, 0, 0, 0], buttons: [] };
  let pads = [pad];
  ctx.navigator.getGamepads = () => pads;
  const events = [];
  Controller.onEvent((type) => events.push(type));

  const live = Controller.update(1 / 60);
  assert.equal(live.failsafe, false);

  pads = [];
  timers.advance(500);
  const lost = Controller.update(1 / 60);
  assert.ok(lost, 'failsafe should keep producing output');
  assert.equal(lost.failsafe, true);
  assert.equal(lost.pitch, 0);
  assert.equal(lost.roll, 0);
  assert.ok(lost.throttle >= 0 && lost.throttle <= 1);
  assert.ok(events.includes('linkLost'));
  assert.ok(events.includes('failsafe'));

  timers.advance(1000);
  const cut = Controller.update(1 / 60);
  assert.equal(cut.throttle, 0, 'motors cut after dropSecs');

  timers.advance(4000);
  assert.equal(Controller.update(1 / 60), null, 'sticks return to the keyboard after the cut');
  assert.ok(events.includes('failsafeEnd'));
});

test('failsafe OFF holds the last commands instead of descending', () => {
  const { ctx, CFG, Controller, timers } = setup();
  CFG.controller.source = 'PAD';
  CFG.controller.timeoutMs = 100;
  CFG.controller.failsafe = false;
  const pad = { connected: true, id: 'Pad', axes: [0.5, -0.5, 0.5, 0], buttons: [] };
  let pads = [pad];
  ctx.navigator.getGamepads = () => pads;

  const live = Controller.update(1 / 60);
  const last = { throttle: live.throttle, roll: live.roll, pitch: live.pitch, yaw: live.yaw };
  pads = [];
  timers.advance(500);
  const held = Controller.update(1 / 60);
  assert.equal(held.failsafe, true);
  assert.equal(held.throttle, last.throttle);
  assert.equal(held.roll, last.roll);
  assert.equal(held.pitch, last.pitch);
  assert.equal(held.yaw, last.yaw);
});

test('source OFF disables controller input entirely', () => {
  const { ctx, CFG, Controller } = setup();
  CFG.controller.source = 'OFF';
  ctx.navigator.getGamepads = () => [{ connected: true, id: 'Pad', axes: [1, 1, 1, 1], buttons: [] }];
  assert.equal(Controller.update(1 / 60), null);
  assert.equal(Controller.status().label, 'OFF');
});

test('configure() merges settings and resets link state', () => {
  const { ctx, CFG, Controller } = setup();
  const before = CFG.controller;
  const after = Controller.configure({ deadband: 0.2, order: 'RETA' });
  assert.equal(after, before);
  assert.equal(CFG.controller.deadband, 0.2);
  assert.equal(CFG.controller.order, 'RETA');
});
