/* =========================================================================
   audio.js — fully procedural sound (Web Audio API, no files to load).
   ========================================================================= */
'use strict';

window.Audio = (function () {

  let ctx = null;
  let master = null;

  let motorOsc1, motorOsc2, motorFilter, motorGain;
  let windGain, windFilter;
  let washGain, washFilter;

  let muted = false;
  let _prevThrottle = 0;
  let _lowBattLast = -10;

  /* safe() — returns fallback if v is not a finite number.
     Web Audio's setTargetAtTime throws "the provided value is non
     finite" on NaN/Infinity. This wrapper catches every path. */
  function safe(v, fallback) {
    var n = (typeof v === 'number') ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function init() {
    if (ctx) return true;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      ctx = new Ctor();
    } catch (e) {
      return false;
    }

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.28;
    master.connect(ctx.destination);

    motorOsc1 = ctx.createOscillator();
    motorOsc1.type = 'sawtooth';
    motorOsc1.frequency.value = 70;

    motorOsc2 = ctx.createOscillator();
    motorOsc2.type = 'sine';
    motorOsc2.frequency.value = 140;

    motorFilter = ctx.createBiquadFilter();
    motorFilter.type = 'lowpass';
    motorFilter.frequency.value = 600;
    motorFilter.Q.value = 2.0;

    motorGain = ctx.createGain();
    motorGain.gain.value = 0;

    motorOsc1.connect(motorFilter);
    motorOsc2.connect(motorFilter);
    motorFilter.connect(motorGain);
    motorGain.connect(master);
    motorOsc1.start();
    motorOsc2.start();

    const bufLen = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;

    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 700;
    windFilter.Q.value = 0.5;

    windGain = ctx.createGain();
    windGain.gain.value = 0;

    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);
    windSrc.start();

    const washSrc = ctx.createBufferSource();
    washSrc.buffer = buf;
    washSrc.loop = true;

    washFilter = ctx.createBiquadFilter();
    washFilter.type = 'bandpass';
    washFilter.frequency.value = 250;
    washFilter.Q.value = 1.6;

    washGain = ctx.createGain();
    washGain.gain.value = 0;

    washSrc.connect(washFilter);
    washFilter.connect(washGain);
    washGain.connect(master);
    washSrc.start();

    return true;
  }

  function resume() {
    if (!ctx) init();
    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (e) { /* ignore */ }
    }
  }

  function update(drone, state) {
    if (!ctx) return;

    const t = ctx.currentTime;
    const armed = drone.armed && !drone.crashed;

    /* State may be the legacy throttle number OR the new state object.
       Handle both so callers don't need to change in lockstep.
       EVERY value clamped / safe()'d — negative throttle would make
       Math.pow(throttle, 0.85) return NaN and throw in Web Audio. */
    let throttle = 0, pitchIn = 0, rollIn = 0, yawIn = 0;
    if (typeof state === 'number') {
      throttle = safe(state, 0);
    } else if (state) {
      throttle = safe(state.throttle, 0);
      pitchIn  = safe(state.pitch,    0);
      rollIn   = safe(state.roll,     0);
      yawIn    = safe(state.yaw,      0);
    }
    throttle = Math.max(0, Math.min(1, throttle));
    pitchIn  = Math.max(-1, Math.min(1, pitchIn));
    rollIn   = Math.max(-1, Math.min(1, rollIn));
    yawIn    = Math.max(-1, Math.min(1, yawIn));

    /* ---- Motor whine ----
       Wider + exponential: idle ~130 Hz, full ~800 Hz. Real 5" quad
       blade-passing freq is roughly 166-1000 Hz, this range gives the
       characteristic rising scream without being piercing. Warble from
       stick input mimics per-motor RPM differential — pushing pitch/roll
       makes 2 motors speed up and 2 slow down, beating audibly. */
    /* throttle is now guaranteed in [0,1], so Math.pow is safe.
       All setTargetAtTime args additionally wrapped in safe() as a
       final defence — no path can hand NaN to Web Audio. */
    const baseFreq = armed
      ? 130 + Math.pow(throttle, 0.85) * 670
      : 65;

    const wobble = 1 + Math.sin(t * 7.3) * 0.006 + Math.sin(t * 3.1) * 0.010;

    const warpAmt = armed
      ? Math.min(0.06, (Math.abs(pitchIn) + Math.abs(rollIn)) * 0.035)
      : 0;
    const warpHz  = 16 + Math.abs(pitchIn) * 22 + Math.abs(rollIn) * 22;
    const warble  = 1 + Math.sin(t * warpHz * Math.PI * 2) * warpAmt;

    const finalFreq = safe(baseFreq * wobble * warble, 130);

    motorOsc1.frequency.setTargetAtTime(safe(finalFreq,        130), t, 0.06);
    motorOsc2.frequency.setTargetAtTime(safe(finalFreq * 2.02, 260), t, 0.06);

    motorFilter.frequency.setTargetAtTime(safe(400 + throttle * 3500, 400), t, 0.08);

    const motorLevel = safe(armed ? (0.05 + throttle * 0.22) : 0, 0);
    motorGain.gain.setTargetAtTime(motorLevel, t, 0.08);

    /* ---- Wind ----
       Two layers:
         1. Ambient base — always present, scaled by preset. Standing in
            a BREEZY field you hear wind even when still; GUSTY has
            sinusoidal swells synced to drone._windTime (matches physics
            wind acceleration and visual camera shake).
         2. Velocity-driven — added on top, louder at speed.
       Mix: 0.012 (CALM) / 0.05 (BREEZY) / 0.10 + gust (GUSTY). */
    const spd = safe(drone.velocity && drone.velocity.length(), 0);
    const windPreset = (typeof CFG !== 'undefined' && CFG.windPreset) || 'CALM';
    const baseWind = windPreset === 'GUSTY'  ? 0.10
                   : windPreset === 'BREEZY' ? 0.05
                   : 0.012;

    let gustMod = 0;
    if (windPreset === 'GUSTY') {
      const wt = safe(drone._windTime, t);
      gustMod = (Math.sin(wt * 0.7) * 0.5 + Math.sin(wt * 1.9) * 0.3) * 0.06;
    }

    const spdWind = Math.min(0.28, spd * 0.013);
    const windLevel = safe(baseWind + gustMod + spdWind, baseWind);
    windGain.gain.setTargetAtTime(windLevel, t, 0.15);
    windFilter.frequency.setTargetAtTime(safe(500 + spd * 42, 500), t, 0.15);

    /* ---- Prop wash + crackle ----
       Wash bandpass rises with deltaThr: gentle whoosh at small throttle
       changes, sharper "snap/crackle" on hard punches (250 Hz → 1800 Hz).
       Matches the motor desync kicks in physics. */
    const deltaThr = safe(Math.abs(throttle - _prevThrottle), 0);
    _prevThrottle = throttle;
    const washLevel = safe(armed
      ? Math.min(0.22, deltaThr * 0.90 + throttle * 0.03)
      : 0, 0);
    washGain.gain.setTargetAtTime(washLevel, t, 0.05);
    washFilter.frequency.setTargetAtTime(
      safe(250 + Math.min(1550, deltaThr * 4000), 250), t, 0.05);

    if (armed && t - _lowBattLast > 1.6) {
      const vPerCell = drone.voltage / CFG.battery.cells;
      if (vPerCell < CFG.battery.lowCellVoltage) {
        _lowBattLast = t;
        beep(1200, 0.07, 0.09);
        setTimeout(function () { beep(1200, 0.07, 0.09); }, 110);
      }
    }
  }

  function beep(freq, dur, vol) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function armBeep(armed) {
    if (!ctx) return;
    if (armed) {
      beep(880,  0.10, 0.16);
      setTimeout(function () { beep(1320, 0.09, 0.13); }, 130);
    } else {
      beep(440, 0.15, 0.15);
    }
  }

  function crashSound() {
    if (!ctx || muted) return;
    const len = Math.floor(ctx.sampleRate * 0.55);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / (len * 0.12));
      d[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;

    const g = ctx.createGain();
    g.gain.value = 0.55;

    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start();
  }

  function setMuted(m) {
    muted = !!m;
    if (ctx && master) {
      master.gain.setTargetAtTime(muted ? 0 : 0.28, ctx.currentTime, 0.03);
    }
  }

  function isMuted() { return muted; }

  return {
    init: init,
    resume: resume,
    update: update,
    armBeep: armBeep,
    crashSound: crashSound,
    setMuted: setMuted,
    isMuted: isMuted
  };
})();
