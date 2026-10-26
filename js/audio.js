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

  function update(drone, throttle) {
    if (!ctx) return;

    const t = ctx.currentTime;
    const armed = drone.armed && !drone.crashed;

    const baseFreq = 62 + throttle * 215 + (armed ? 18 : 0);
    const wobble = 1 + Math.sin(t * 7.3) * 0.006 + Math.sin(t * 3.1) * 0.010;

    motorOsc1.frequency.setTargetAtTime(baseFreq * wobble,        t, 0.06);
    motorOsc2.frequency.setTargetAtTime(baseFreq * 2.02 * wobble, t, 0.06);

    motorFilter.frequency.setTargetAtTime(300 + throttle * 2200, t, 0.08);

    const motorLevel = armed ? (0.05 + throttle * 0.20) : 0;
    motorGain.gain.setTargetAtTime(motorLevel, t, 0.08);

    const spd = drone.velocity.length();
    const windLevel = armed ? Math.min(0.30, spd * 0.014) : 0;
    windGain.gain.setTargetAtTime(windLevel, t, 0.15);
    windFilter.frequency.setTargetAtTime(500 + spd * 42, t, 0.15);

    const deltaThr = Math.abs(throttle - _prevThrottle);
    _prevThrottle = throttle;
    const washLevel = armed
      ? Math.min(0.20, deltaThr * 0.85 + throttle * 0.03)
      : 0;
    washGain.gain.setTargetAtTime(washLevel, t, 0.05);

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
