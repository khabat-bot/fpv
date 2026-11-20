/* =========================================================================
   controller.js — external RC transmitter / gamepad input.

   Two transports, one normalized output:

     PAD   — the Web Gamepad API. Covers every HID the OS enumerates: USB
             gamepads, Bluetooth gamepads, and a radio in EdgeTX/OpenTX
             "USB joystick (HID)" mode. No permission prompt — but a pad
             only appears after it sends an event and after the page has
             had a click, so "press a button on the pad" is the hint in
             SETTINGS → INPUT.
     CRSF  — ELRS/CRSF channel frames over USB serial (Web Serial). A TX
             module or receiver on a USB CDC-ACM port streams
             RC_CHANNELS_PACKED frames (0x16) with 11-bit channels at
             172…1812 µs. Chromium only, and opening a port needs a user
             gesture, so it is only ever opened from the panel button.

   Both transports produce the same thing: throttle 0…1 and yaw/pitch/roll
   -1…1. js/input.js hands those to the flight model instead of the
   virtual sticks while a controller is live. This module never touches
   the drone, so the flight model stays the single source of truth.

   Settings live in CFG.controller (js/config.js), edited in
   SETTINGS → INPUT: source, channel order, stick mode, throttle mode,
   deadband, stick travel, failsafe.

   Failsafe: when a live link goes quiet for CFG.controller.timeoutMs the
   sticks centre and the throttle ramps to a gentle descent instead of
   freezing at the last command; after CFG.controller.dropSecs the motors
   cut (Betaflight stage 2). With failsafe OFF the last commands are
   held instead. A link that never comes back hands the sticks back to
   the keyboard/touch controls after the cut.

   Test hooks: Controller._feedSerial(bytes) pushes raw bytes through the
   CRSF parser and Controller._reset() clears link state, so both
   transports can be exercised without hardware.
   ========================================================================= */
'use strict';

window.Controller = (function () {

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function cfgNow() {
    return (window.CFG && CFG.controller) ? CFG.controller : {};
  }

  /* --------------------------- channel order --------------------------
     A = aileron (roll), E = elevator (pitch), T = throttle,
     R = rudder (yaw). Values are the first four channel indices. */
  var ORDERS = {
    AETR: { roll: 0, pitch: 1, throttle: 2, yaw: 3 },
    TAER: { throttle: 0, roll: 1, pitch: 2, yaw: 3 },
    RETA: { yaw: 0, pitch: 1, throttle: 2, roll: 3 },
    ETAR: { pitch: 0, throttle: 1, roll: 2, yaw: 3 }
  };

  function channelMap(order) {
    return ORDERS[String(order || 'AETR').toUpperCase()] || ORDERS.AETR;
  }

  /* ---------------------------- stick shaping ------------------------
     deadband: fraction of full deflection ignored around centre.
     travel:   how much of the axis range the physical stick actually
               reaches (0.8 = a stick that only travels 80% still reaches
               full output). 1.0 leaves the axis as it is. */
  function axisTravel(cfg) {
    var t = Number(cfg.travel);
    return (isFinite(t) && t >= 0.3) ? Math.min(t, 1) : 1;
  }

  function axisDeadband(cfg) {
    var d = Number(cfg.deadband);
    return (isFinite(d) && d > 0) ? Math.min(d, 0.5) : 0;
  }

  /* The deadband is skipped and what is left is stretched so that the
     physical end of travel — not the axis end — is full output. That is
     what a radio's "stick travel" calibration does. */
  function span(dz, travel) {
    var s = travel - dz;
    return s > 0.05 ? s : 0.05;
  }

  /* Signed axis, already oriented so +1 is up/right/nose-up. */
  function shapeSigned(v, dz, travel) {
    var a = Math.abs(v);
    if (a <= dz) return 0;
    var t = (a - dz) / span(dz, travel);
    if (t > 1) t = 1;
    return v < 0 ? -t : t;
  }

  /* Unipolar 0…1 axis (throttle) — no centre, so only the bottom deadbands. */
  function shapeUni(v, dz, travel) {
    if (v <= dz) return 0;
    var t = (v - dz) / span(dz, travel);
    return t > 1 ? 1 : t;
  }

  /* Spring-centred pads cannot hold a throttle, so HOLD turns the stick
     into a rate control: deflection changes throttle over time. */
  var holdThrottle = 0;
  function holdStep(v, dt, dz) {
    var rate = Number((window.CFG && CFG.controller && CFG.controller.holdRate));
    if (!isFinite(rate) || rate <= 0) rate = 1.0;
    var d = (v - 0.5) * 2;
    if (Math.abs(d) <= dz) return holdThrottle;
    holdThrottle = clamp(holdThrottle + d * rate * dt, 0, 1);
    return holdThrottle;
  }

  function hoverThrottle() {
    if (!window.CFG) return 0.2;
    var mt = CFG.maxThrust;
    if (!mt || mt <= 0) mt = CFG.mass * CFG.gravity * CFG.thrustToWeight;
    if (!mt || mt <= 0) return 0.2;
    return clamp((CFG.mass * CFG.gravity) / mt, 0, 1);
  }

  /* ------------------------------- events ----------------------------- */
  var eventCb = null;
  function emit(type, data) {
    if (typeof eventCb !== 'function') return;
    try { eventCb(type, data || null); } catch (err) { /* never break input */ }
  }
  function onEvent(cb) { eventCb = (typeof cb === 'function') ? cb : null; }

  /* ------------------------------ gamepads ---------------------------- */
  var padButtons = [];

  function pollGamepad() {
    if (!navigator.getGamepads) return null;
    var pads;
    try { pads = navigator.getGamepads(); } catch (err) { return null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) {
      var p = pads[i];
      if (p && p.connected) return p;
    }
    return null;
  }

  function readPadButtons(pad) {
    var bs = pad.buttons || [];
    var i, b, down;
    for (i = 0; i < bs.length && i < 32; i++) {
      b = bs[i];
      down = !!(b && (b.pressed || b.value > 0.5));
      if (down && !padButtons[i]) {
        /* First two buttons are the usual A/B: arm and reset, so the
           pilot never has to reach for the keyboard mid-flight. */
        if (i === 0) emit('arm');
        else if (i === 1) emit('reset');
      }
      padButtons[i] = down;
    }
  }

  function readPad(pad, dt, cfg) {
    var axes = pad.axes || [];
    function ax(i) {
      var v = axes[i];
      return (typeof v === 'number' && isFinite(v)) ? clamp(v, -1, 1) : 0;
    }

    var dz = axisDeadband(cfg);
    var travel = axisTravel(cfg);
    var thrRaw, yawRaw, pitchRaw, rollRaw;
    var layout = String(cfg.stickMode).toUpperCase();

    if (layout === 'RADIO') {
      /* A radio in EdgeTX/OpenTX USB-joystick (HID) mode sends its channels
         as axes, not as two sticks: CH1 -> X, CH2 -> Y, CH3 -> Z,
         CH4 -> Rx. Radio polarity: throttle low is -1, elevator up is +1. */
      var map = channelMap(cfg.order);
      thrRaw = (ax(map.throttle) + 1) * 0.5;
      rollRaw = ax(map.roll);
      pitchRaw = ax(map.pitch);
      yawRaw = ax(map.yaw);
    } else if (layout === 'MODE1') {
      /* MODE 1 — left stick pitch/yaw, right stick throttle/roll. */
      pitchRaw = -ax(1);
      yawRaw = ax(0);
      thrRaw = (1 - ax(3)) * 0.5;
      rollRaw = ax(2);
    } else {
      /* MODE 2 (default) — left stick throttle/yaw, right stick pitch/roll. */
      thrRaw = (1 - ax(1)) * 0.5;
      yawRaw = ax(0);
      pitchRaw = -ax(3);
      rollRaw = ax(2);
    }

    readPadButtons(pad);

    var hold = String(cfg.thrMode).toUpperCase() === 'HOLD';
    return {
      throttle: hold ? holdStep(thrRaw, dt, dz) : shapeUni(thrRaw, dz, travel),
      yaw: shapeSigned(yawRaw, dz, travel),
      pitch: shapeSigned(pitchRaw, dz, travel),
      roll: shapeSigned(rollRaw, dz, travel)
    };
  }

  /* ------------------------- CRSF over serial -------------------------
     Frame: 0xC8 | len | type | payload… | crc8
     len counts type + payload + crc, crc is CRC8/DVB-S2 (poly 0xD5, init
     0) over type + payload. RC_CHANNELS_PACKED (0x16) is 22 payload bytes
     holding sixteen 11-bit little-endian channels. */

  var CRC8_TABLE = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var crc = i;
      for (var b = 0; b < 8; b++) {
        crc = (crc & 0x80) ? (((crc << 1) ^ 0xD5) & 0xFF) : ((crc << 1) & 0xFF);
      }
      t[i] = crc;
    }
    return t;
  })();

  function crc8(bytes, start, end) {
    var crc = 0;
    for (var i = start; i < end; i++) crc = CRC8_TABLE[crc ^ bytes[i]];
    return crc;
  }

  function unpackChannels(payload) {
    var ch = [];
    var bits = 0;
    var acc = 0;
    for (var i = 0; i < payload.length && ch.length < 16; i++) {
      acc |= payload[i] << bits;
      bits += 8;
      while (bits >= 11 && ch.length < 16) {
        ch.push(acc & 0x7FF);
        acc >>>= 11;
        bits -= 11;
      }
    }
    return ch;
  }

  var serial = {
    port: null,
    reader: null,
    running: false,
    opening: false,
    error: '',
    channels: null,
    lastFrame: 0,
    frames: 0,
    rateHz: 0,
    rateMark: 0,
    rateCount: 0
  };

  var rxBuf = new Uint8Array(0);

  function handleFrame(type, payload) {
    if (type !== 0x16 || payload.length < 22) return;
    var ch = unpackChannels(payload);
    if (ch.length < 4) return;

    serial.channels = ch;
    serial.lastFrame = nowMs();
    serial.frames++;

    var now = nowMs();
    if (!serial.rateMark) { serial.rateMark = now; serial.rateCount = 0; }
    serial.rateCount++;
    if (now - serial.rateMark >= 500) {
      serial.rateHz = Math.round(serial.rateCount * 1000 / (now - serial.rateMark));
      serial.rateMark = now;
      serial.rateCount = 0;
    }
  }

  function feed(bytes) {
    if (!bytes || !bytes.length) return;
    var merged = new Uint8Array(rxBuf.length + bytes.length);
    merged.set(rxBuf, 0);
    merged.set(bytes, rxBuf.length);
    rxBuf = merged;

    var i = 0;
    while (true) {
      while (i < rxBuf.length && rxBuf[i] !== 0xC8) i++;
      if (rxBuf.length - i < 3) break;
      var len = rxBuf[i + 1];
      if (len < 2 || len > 62) { i++; continue; }
      var total = len + 2;
      if (rxBuf.length - i < total) break;
      if (crc8(rxBuf, i + 2, i + 1 + len) !== rxBuf[i + 1 + len]) { i++; continue; }
      handleFrame(rxBuf[i + 2], rxBuf.subarray(i + 3, i + 1 + len));
      i += total;
    }
    rxBuf = rxBuf.slice(i);
    /* A mis-bauded port can stream noise forever — never let the buffer
       grow without bound, and keep the newest bytes. */
    if (rxBuf.length > 2048) rxBuf = rxBuf.slice(rxBuf.length - 1024);
  }

  async function readLoop() {
    var port = serial.port;
    if (!port || !port.readable) { serial.running = false; return; }
    var reader;
    try {
      reader = port.readable.getReader();
    } catch (err) {
      serial.error = (err && err.message) ? err.message : 'serial read failed';
      serial.running = false;
      emit('serialError', { message: serial.error });
      return;
    }
    serial.reader = reader;
    try {
      while (serial.running) {
        var res = await reader.read();
        if (res.done) break;
        if (res.value) feed(res.value);
      }
    } catch (err) {
      serial.error = (err && err.message) ? err.message : 'serial read failed';
    } finally {
      serial.reader = null;
      try { reader.releaseLock(); } catch (err) { /* already released */ }
    }
    if (serial.running) {
      serial.running = false;
      emit('serialClosed');
    }
  }

  function serialSupported() {
    return !!(navigator.serial && navigator.serial.requestPort);
  }

  /* Must be called from a click: requestPort() needs a user gesture. */
  async function connectSerial() {
    if (!serialSupported()) {
      throw new Error('Web Serial is not available here — use Chrome or Edge on a desktop');
    }
    if (serial.opening) return false;
    serial.opening = true;
    try {
      if (serial.running || serial.port) await disconnectSerial();
      var port = await navigator.serial.requestPort();
      var baud = Number(cfgNow().crsf && cfgNow().crsf.baudRate) || 420000;
      await port.open({ baudRate: baud, bufferSize: 4096 });
      serial.port = port;
      serial.running = true;
      serial.error = '';
      serial.channels = null;
      serial.rateMark = 0;
      serial.rateCount = 0;
      serial.opening = false;
      emit('serialOpen');
      readLoop();
      return true;
    } catch (err) {
      serial.opening = false;
      serial.error = (err && err.message) ? err.message : 'serial open failed';
      serial.running = false;
      emit('serialError', { message: serial.error });
      throw err;
    }
  }

  async function disconnectSerial() {
    serial.running = false;
    var reader = serial.reader;
    var port = serial.port;
    serial.port = null;
    serial.channels = null;
    rxBuf = new Uint8Array(0);
    if (reader) {
      try { await reader.cancel(); } catch (err) { /* stream already gone */ }
    }
    if (port) {
      try { await port.close(); } catch (err) { /* port already closed */ }
    }
    emit('serialClosed');
  }

  /* --------------------------- link / failsafe ------------------------ */
  var engaged = false;        /* the controller owns the four axes */
  var linkLost = false;
  var linkLostAt = 0;
  var lastGoodAt = 0;
  var failSafe = false;
  var failThrottle = 0;
  var liveSource = '';
  var liveLabel = '';
  var last = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  var out = { throttle: 0, yaw: 0, pitch: 0, roll: 0, failsafe: false, source: '', label: '' };

  function resetLink() {
    engaged = false;
    linkLost = false;
    linkLostAt = 0;
    failSafe = false;
    failThrottle = 0;
    liveSource = '';
    liveLabel = '';
    holdThrottle = 0;
    padButtons = [];
    last.throttle = 0; last.yaw = 0; last.pitch = 0; last.roll = 0;
  }

  function serialLive(cfg, now) {
    if (!serial.channels) return false;
    var to = Number(cfg.crsf && cfg.crsf.timeoutMs) || 450;
    return (now - serial.lastFrame) <= to;
  }

  function crsfSigned(raw) {
    return clamp(((Number(raw) || 992) - 992) / 820, -1, 1);
  }

  function crsfThrottle(raw) {
    return clamp(((Number(raw) || 172) - 172) / 1640, 0, 1);
  }

  function readCrsf(cfg, dt) {
    var ch = serial.channels;
    var map = channelMap(cfg.order);
    var dz = axisDeadband(cfg);
    var travel = axisTravel(cfg);
    var thrRaw = crsfThrottle(ch[map.throttle]);
    var hold = String(cfg.thrMode).toUpperCase() === 'HOLD';
    return {
      throttle: hold ? holdStep(thrRaw, dt, dz) : shapeUni(thrRaw, dz, travel),
      yaw: shapeSigned(crsfSigned(ch[map.yaw]), dz, travel),
      pitch: shapeSigned(crsfSigned(ch[map.pitch]), dz, travel),
      roll: shapeSigned(crsfSigned(ch[map.roll]), dz, travel)
    };
  }

  function failsafeStep(dt, cfg, now) {
    var elapsed = (now - linkLostAt) / 1000;
    var timeout = (Number(cfg.timeoutMs) || 350) / 1000;
    var drop = Number(cfg.dropSecs);
    if (!isFinite(drop) || drop < 0) drop = 3;

    if (!failSafe) {
      failSafe = true;
      failThrottle = last.throttle;
      emit('failsafe');
    }

    if (cfg.failsafe === false) {
      /* No failsafe: keep the last commands, exactly like a receiver that
         was never told what to do on link loss. */
      out.throttle = last.throttle;
      out.yaw = last.yaw;
      out.pitch = last.pitch;
      out.roll = last.roll;
    } else {
      var target = (typeof cfg.failsafeThrottle === 'number' && isFinite(cfg.failsafeThrottle))
        ? clamp(cfg.failsafeThrottle, 0, 1)
        : hoverThrottle() * 0.8;
      failThrottle += (target - failThrottle) * (1 - Math.exp(-dt * 2.5));
      var cut = elapsed >= drop;
      out.throttle = cut ? 0 : clamp(failThrottle, 0, 1);
      out.yaw = 0;
      out.pitch = 0;
      out.roll = 0;
    }
    out.failsafe = true;
    out.source = liveSource || 'PAD';
    out.label = liveLabel;

    /* A link that never returns must not lock the keyboard out forever:
       give the sticks back once the cut has had time to land. */
    if (elapsed > timeout + drop + 2) {
      resetLink();
      emit('failsafeEnd');
      return null;
    }
    return out;
  }

  function update(dt) {
    dt = (typeof dt === 'number' && dt > 0) ? Math.min(dt, 0.1) : 0.016;
    var cfg = cfgNow();
    var now = nowMs();
    var src = String(cfg.source || 'AUTO').toUpperCase();

    if (src === 'OFF') {
      if (engaged || linkLost) resetLink();
      return null;
    }

    var fresh = null;
    if (src === 'AUTO' || src === 'PAD') {
      var pad = pollGamepad();
      if (pad) {
        fresh = readPad(pad, dt, cfg);
        liveLabel = pad.id || 'Gamepad';
        liveSource = 'PAD';
      }
    }
    if (!fresh && (src === 'AUTO' || src === 'CRSF') && serialLive(cfg, now)) {
      fresh = readCrsf(cfg, dt);
      liveLabel = 'CRSF';
      liveSource = 'CRSF';
    }

    if (fresh) {
      engaged = true;
      lastGoodAt = now;
      if (linkLost) {
        linkLost = false;
        failSafe = false;
        emit('linkRestored');
      }
      last.throttle = fresh.throttle;
      last.yaw = fresh.yaw;
      last.pitch = fresh.pitch;
      last.roll = fresh.roll;

      out.throttle = fresh.throttle;
      out.yaw = fresh.yaw;
      out.pitch = fresh.pitch;
      out.roll = fresh.roll;
      out.failsafe = false;
      out.source = liveSource;
      out.label = liveLabel;
      return out;
    }

    if (!engaged) return null;

    var timeoutMs = Number(cfg.timeoutMs) || 350;
    if (!linkLost && (now - lastGoodAt) > timeoutMs) {
      linkLost = true;
      linkLostAt = now;
      emit('linkLost');
    }
    if (linkLost) return failsafeStep(dt, cfg, now);

    /* Short gap (a frame or two, or a pad that just went quiet for a
       moment): hold the last values so the quad does not twitch. */
    out.throttle = last.throttle;
    out.yaw = last.yaw;
    out.pitch = last.pitch;
    out.roll = last.roll;
    out.failsafe = false;
    out.source = liveSource;
    out.label = liveLabel;
    return out;
  }

  function status() {
    var cfg = cfgNow();
    var now = nowMs();
    var src = String(cfg.source || 'AUTO').toUpperCase();
    var s = {
      source: src,
      connected: false,
      kind: 'NONE',
      label: '',
      failsafe: failSafe,
      rateHz: 0,
      serial: {
        supported: serialSupported(),
        open: !!serial.running,
        error: serial.error || '',
        rateHz: serial.rateHz || 0
      }
    };
    if (src === 'OFF') { s.label = 'OFF'; return s; }

    if (src === 'AUTO' || src === 'PAD') {
      var pad = pollGamepad();
      if (pad) {
        s.connected = true;
        s.kind = 'PAD';
        s.label = pad.id || 'Gamepad';
        return s;
      }
    }
    if ((src === 'AUTO' || src === 'CRSF') && serialLive(cfg, now)) {
      s.connected = true;
      s.kind = 'CRSF';
      s.label = 'CRSF';
      s.rateHz = serial.rateHz || 0;
    }
    return s;
  }

  function configure(opts) {
    if (!window.CFG) return null;
    if (!CFG.controller) CFG.controller = {};
    if (opts && typeof opts === 'object') {
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) CFG.controller[k] = opts[k];
      }
    }
    resetLink();
    return CFG.controller;
  }

  function init() {
    window.addEventListener('gamepadconnected', function (e) {
      emit('padConnected', { id: (e && e.gamepad && e.gamepad.id) || 'Gamepad' });
    });
    window.addEventListener('gamepaddisconnected', function (e) {
      padButtons = [];
      emit('padDisconnected', { id: (e && e.gamepad && e.gamepad.id) || 'Gamepad' });
    });
  }

  return {
    init: init,
    configure: configure,
    update: update,
    status: status,
    onEvent: onEvent,
    connectSerial: connectSerial,
    disconnectSerial: disconnectSerial,
    serialSupported: serialSupported,
    /* test hooks */
    _feedSerial: feed,
    _reset: resetLink,
    _unpackChannels: unpackChannels,
    _crc8: crc8
  };
})();
