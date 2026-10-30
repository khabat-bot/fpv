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
  let _lastSoundLoadoutKey = null;
  let remoteAudioNodes = {};

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

  function update(drone, state, camera) {
    if (!ctx) return;

    const t = ctx.currentTime;
    const armed = drone.armed && !drone.crashed;
    /* Pack-dead — latched OR sagged below cutoff. Silences motor
       whine, prop wash, and any thrust-driven sound. */
    const _packDeadAudio = !!drone._packDeadLatched
      || (drone.voltage / CFG.battery.cells < 3.0);

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
    /* ---- Loadout-derived sound parameters ----
       Reads __loadout.effective.thrustInfo (populated by parts.js on
       every loadout change) to derive sound character from the actual
       motor RPM + prop geometry produced by computeMotorThrust().
       Falls back to hardcoded 5"-baseline values if the loadout system
       is missing or fails — audio always works. Every value that
       reaches Web Audio is still wrapped in safe() at the call site. */
    let _bpfIdle = 130, _bpfPeak = 800;         /* blade-pass range */
    let _osc2Ratio = 2.02;                       /* pole pairs / blades */
    let _motorFilterMax = 3900;                  /* lowpass ceiling */
    let _washBase = 250, _washPeak = 1800;       /* prop wash range */
    let _bladeCount = 3, _diameterIn = 5.1;
    let _elecPeak = 1600;                        /* electrical slot freq */
    if (window.__loadout && __loadout.effective && __loadout.effective.thrustInfo
        && window.PARTS && PARTS.PROPS) {
      try {
        const _ti = __loadout.effective.thrustInfo;
        const _prop = PARTS.PROPS[__loadout.props];
        if (_prop) {
          _bladeCount = _prop.blades     != null ? _prop.blades     : 3;
          _diameterIn = _prop.diameterIn != null ? _prop.diameterIn : 5.1;
        }
        /* Live voltage factor — as the pack drains, RPM drops and the
           blade-pass frequency audibly descends. Matches real quads,
           which you can HEAR getting tired near LVC. */
        const _vNowCell = (window.__drone && __drone.voltage)
          ? __drone.voltage / CFG.battery.cells : 4.20;
        const _packDead = _vNowCell < 3.0;
        const _vRatio = _packDead ? 0 : Math.min(1.0, _vNowCell / 4.20);
        const _rpmPeak = safe(_ti.rpm, 29880) * _vRatio;
        _bpfPeak        = (_rpmPeak / 60) * _bladeCount;
        _bpfIdle        = _bpfPeak * 0.10;
        _osc2Ratio      = 7 / _bladeCount;
        _elecPeak       = (_rpmPeak / 60) * 7;
        _motorFilterMax = Math.max(_bpfPeak, _elecPeak) * 1.3;
        const _dScale   = Math.pow(5.1 / _diameterIn, 0.7);
        _washBase       = 250  * _dScale;
        _washPeak       = 1800 * _dScale;
      } catch (e) { /* keep defaults */ }
    }

    /* Once-per-loadout-change diagnostic */
    if (window.__loadout) {
      const _sKey = (__loadout.frame || '?') + '/' + (__loadout.motors || '?')
                  + '/' + (__loadout.props || '?') + '/' + (__loadout.battery || '?');
      if (_sKey !== _lastSoundLoadoutKey) {
        _lastSoundLoadoutKey = _sKey;
        console.log('[Audio] loadout sound:', __loadout.frame + '/' + __loadout.props,
                    '-> BPF', Math.round(_bpfIdle) + '-' + Math.round(_bpfPeak) + ' Hz',
                    ', elec', Math.round(_elecPeak) + ' Hz',
                    ', wash', Math.round(_washBase) + '-' + Math.round(_washPeak) + ' Hz');
      }
    }

    const _bpfRange = Math.max(1, _bpfPeak - _bpfIdle);
    const baseFreq = armed
      ? Math.max(20, _bpfIdle + Math.pow(throttle, 0.85) * _bpfRange)
      : 65;

    const wobble = 1 + Math.sin(t * 7.3) * 0.006 + Math.sin(t * 3.1) * 0.010;

    const warpAmt = armed
      ? Math.min(0.06, (Math.abs(pitchIn) + Math.abs(rollIn)) * 0.035)
      : 0;
    const warpHz  = 16 + Math.abs(pitchIn) * 22 + Math.abs(rollIn) * 22;
    const warble  = 1 + Math.sin(t * warpHz * Math.PI * 2) * warpAmt;

    const finalFreq = safe(baseFreq * wobble * warble, 130);

    motorOsc1.frequency.setTargetAtTime(safe(finalFreq, 130), t, 0.06);
    /* osc2 = electrical slot frequency. Ratio relative to BPF equals
       pole pairs / blades, so it auto-tracks blade count: 7/3 = 2.33
       for 3-blade, 7/2 = 3.5 for bi-blade, 7/4 = 1.75 for 4-blade.
       Capped at 20 kHz to stay safely below Nyquist. */
    const _osc2Freq = Math.min(20000, finalFreq * _osc2Ratio);
    motorOsc2.frequency.setTargetAtTime(safe(_osc2Freq, 260), t, 0.06);

    /* Lowpass ceiling scales with the higher of BPF peak and electrical
       peak. Idle cutoff stays at 400 Hz so the (low) idle whine is not
       attenuated — that's the idle motor hum. */
    motorFilter.frequency.setTargetAtTime(
      safe(400 + throttle * (_motorFilterMax - 400), 400), t, 0.08);

    const motorLevel = safe((armed && !_packDeadAudio) ? (0.05 + throttle * 0.22) : 0, 0);
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
    const washLevel = safe((armed && !_packDeadAudio)
      ? Math.min(0.22, deltaThr * 0.90 + throttle * 0.03)
      : 0, 0);
    washGain.gain.setTargetAtTime(washLevel, t, 0.05);
    /* Prop-wash center freq scales inversely with prop diameter:
       bigger props → deeper thump, small props → sharper snap. The
       deltaThr multiplier scales so a full punch reaches _washPeak
       in one stroke for every diameter. */
    const _washScale = _washPeak / 1800;
    washFilter.frequency.setTargetAtTime(
      safe(_washBase + Math.min(_washPeak - _washBase, deltaThr * 4000 * _washScale),
           _washBase), t, 0.05);

    if (armed && t - _lowBattLast > 1.6) {
      const vPerCell = drone.voltage / CFG.battery.cells;
      if (vPerCell < CFG.battery.lowCellVoltage) {
        _lowBattLast = t;
        beep(1200, 0.07, 0.09);
        setTimeout(function () { beep(1200, 0.07, 0.09); }, 110);
      }
    }

    /* ---- Remote Drones Audio (Session 4) ---- */
    if (window.MP && window.MP.getRemoteStates && camera) {
      var remotes = window.MP.getRemoteStates();
      var activePids = {};
      for (var i = 0; i < remotes.length; i++) {
        var r = remotes[i];
        activePids[r.pid] = true;
        var dist = camera.position.distanceTo(r.pos);
        var vol = 0;
        if (dist < 60 && r.armed) {
          vol = Math.max(0, 1.0 - (dist - 5) / 55) * 0.15;
        }
        if (!remoteAudioNodes[r.pid]) {
          var osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = 150;
          var gain = ctx.createGain();
          gain.gain.value = 0;
          var filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 800;
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(master);
          osc.start();
          remoteAudioNodes[r.pid] = { osc: osc, gain: gain, filter: filter };
        }
        var nodes = remoteAudioNodes[r.pid];
        nodes.gain.gain.setTargetAtTime(safe(vol, 0), t, 0.1);
        nodes.osc.frequency.setTargetAtTime(safe(150 + vol * 400, 150), t, 0.1);
      }
      for (var pid in remoteAudioNodes) {
        if (!activePids[pid]) {
          var n = remoteAudioNodes[pid];
          try { n.osc.stop(); } catch(e){}
          try { n.osc.disconnect(); } catch(e){}
          try { n.gain.disconnect(); } catch(e){}
          try { n.filter.disconnect(); } catch(e){}
          delete remoteAudioNodes[pid];
        }
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
