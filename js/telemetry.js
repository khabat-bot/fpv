/* =========================================================================
   telemetry.js — flight data recorder ("blackbox") + live attitude graph.

   Every flight state is sampled at a fixed rate into a rolling buffer,
   independent of the render rate, while the quad is armed (the log survives
   the crash that disarms it, so the impact frame is kept). Arming starts a
   fresh log; the buffer is never written while disarmed.

   The buffer feeds two things:

     1. the live attitude graph in the OSD (roll / pitch / yaw lanes)
     2. a blackbox-style CSV export of per-axis data — stick commands,
        realised gyro rates, rate setpoints, attitude, altitude/speed,
        thrust, pack and damage state

   Tunables live in CFG.telemetry. SETTINGS → TELEM toggles the graph and
   runs the export.

   Sign conventions match the flight model (see physics.js):
     att_pitch  + nose up        cmd_pitch  + stick = nose down
     att_roll   + bank right     cmd_roll   + stick = bank right
     att_yaw    heading, unwrapped (grows past ±180 over several turns)
   Body axes in this sim are X = pitch, Y = yaw, Z = roll; the CSV columns
   are already mapped to roll/pitch/yaw names so they read like a real
   blackbox rather than like raw gyro axes.
   ========================================================================= */
'use strict';

window.Telemetry = (function () {
  var DEG = 180 / Math.PI;

  /* Overwritten from CFG.telemetry in applyConfig(). */
  var SAMPLE_HZ = 50;
  var WINDOW_SEC = 60;
  var GRAPH_WINDOW_SEC = 10;
  var GRAPH_RANGE_DEG = 180;
  var maxSamples = WINDOW_SEC * SAMPLE_HZ + 1;

  /* Sample layout — one flat array per sample, indexed by these. */
  var COL_TIME = 0,  COL_THR  = 1,  COL_CR = 2,  COL_CP = 3,  COL_CY = 4,
      COL_GR   = 5,  COL_GP   = 6,  COL_GY = 7,  COL_SR = 8,  COL_SP = 9,
      COL_SY   = 10, COL_AP   = 11, COL_AR = 12, COL_AY = 13, COL_ALT = 14,
      COL_VS   = 15, COL_GS   = 16, COL_TH = 17, COL_VB = 18, COL_CA = 19,
      COL_MAH  = 20, COL_DMG  = 21;

  var buf = [];
  var t = 0;              /* sample clock, seconds since the log started */
  var acc = 0;            /* time not yet emitted as a sample           */
  var wasArmed = false;

  var canvas = null;
  var ctx = null;
  var visible = false;
  var lastDraw = 0;

  /* Attitude extraction scratch — allocated on first use. */
  var _eul = null;
  var _prevHeading = null;
  var _yawTurn = 0;
  var _att = { pitch: 0, roll: 0, yaw: 0 };
  var _zero = { x: 0, y: 0, z: 0 };

  var HEADER = [
    'time_ms', 'thr',
    'cmd_roll', 'cmd_pitch', 'cmd_yaw',
    'gyro_roll_dps', 'gyro_pitch_dps', 'gyro_yaw_dps',
    'setp_roll_dps', 'setp_pitch_dps', 'setp_yaw_dps',
    'att_pitch_deg', 'att_roll_deg', 'att_yaw_deg',
    'alt_m', 'vspeed_ms', 'gspeed_ms', 'thrust_n',
    'vbat_v', 'curr_a', 'mah', 'dmg'
  ];

  function applyConfig() {
    var c = (window.CFG && CFG.telemetry) || {};
    if (c.sampleHz > 0) SAMPLE_HZ = c.sampleHz;
    if (c.windowSec > 0) WINDOW_SEC = c.windowSec;
    if (c.graphWindowSec > 0) GRAPH_WINDOW_SEC = c.graphWindowSec;
    if (c.graphRangeDeg > 0) GRAPH_RANGE_DEG = c.graphRangeDeg;
    maxSamples = Math.round(WINDOW_SEC * SAMPLE_HZ) + 1;
  }

  /* ---------------------------- attitude -------------------------------- */

  /* YXZ decomposition gives pitch/roll without the swing-twist problem the
     angle controller documents; heading is taken from the swing-twist form
     so a tilted airframe still reports its real heading, then unwrapped so
     the graph and the CSV show continuous yaw through multiple rotations. */
  function attitude(q, out) {
    if (!q) { out.pitch = 0; out.roll = 0; out.yaw = 0; return out; }
    if (!_eul) _eul = new THREE.Euler();
    _eul.setFromQuaternion(q, 'YXZ');
    out.pitch = _eul.x * DEG;      /* + nose up  */
    out.roll = -_eul.z * DEG;      /* + bank right */

    var twist = Math.sqrt(q.y * q.y + q.w * q.w);
    /* Degenerate (inverted) frames reuse the last heading — the same
       fallback the angle controller uses. */
    var heading = (twist < 1e-3)
      ? (_prevHeading || 0)
      : 2 * Math.atan2(q.y, q.w);
    if (_prevHeading !== null) {
      var d = heading - _prevHeading;
      if (d > Math.PI) _yawTurn -= Math.PI * 2;
      else if (d < -Math.PI) _yawTurn += Math.PI * 2;
    }
    _prevHeading = heading;
    out.yaw = (_yawTurn + heading) * DEG;
    return out;
  }

  /* ----------------------------- sampling -------------------------------- */

  function push(drone, state) {
    var s = state || {};
    var a = attitude(drone.quat, _att);
    var ang = drone.angVel || _zero;
    var setp = drone._rateTarget || _zero;
    var pos = drone.position;
    var vel = drone.velocity;

    buf.push([
      Math.round(t * 1000),
      s.throttle || 0,
      s.roll || 0,
      s.pitch || 0,
      s.yaw || 0,
      -ang.z * DEG,       /* realised roll rate, + = bank right  */
      ang.x * DEG,        /* realised pitch rate, + = nose up    */
      ang.y * DEG,        /* realised yaw rate                   */
      -setp.z * DEG,      /* roll rate setpoint                  */
      setp.x * DEG,
      setp.y * DEG,
      a.pitch, a.roll, a.yaw,
      pos ? pos.y : 0,
      vel ? vel.y : 0,
      vel ? vel.length() : 0,
      drone._thrustState || 0,
      drone.voltage || 0,
      drone._smoothCurrent || 0,
      drone.mahUsed || 0,
      (drone.damage && drone.damage.stage) || 0
    ]);
  }

  /* Called once per rendered frame from the main loop. */
  function sample(drone, state, dt) {
    if (!drone) return;

    var flying = !!drone.armed || !!drone.crashed;

    /* Arming starts a new log. Nothing is recorded on the bench. */
    if (flying && !wasArmed) {
      reset();
      wasArmed = true;
    } else if (!flying && wasArmed) {
      wasArmed = false;
      if (visible) draw();
    }
    if (!flying) return;

    if (!buf.length) {
      push(drone, state);
      return;
    }

    var step = 1 / SAMPLE_HZ;
    acc += (dt > 0 ? dt : 0);

    /* A hitched frame (dt is clamped to 0.1 s by the main loop) must not
       burst-fill the buffer: bound how many samples one frame can emit. */
    var guard = 0;
    while (acc >= step && guard < 8) {
      acc -= step;
      t += step;
      push(drone, state);
      guard++;
    }
    if (acc > step * 4) acc = 0;

    if (buf.length > maxSamples) buf.splice(0, buf.length - maxSamples);

    var now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    if (visible && now - lastDraw >= 50) {
      lastDraw = now;
      draw();
    }
  }

  /* ------------------------------ graph ---------------------------------- */

  function init(el) {
    applyConfig();
    canvas = el || document.getElementById('attitude-graph');
    if (canvas) {
      ctx = canvas.getContext('2d');
      resize();
    }
    setGraphVisible(visible);
  }

  function resize() {
    if (!canvas || !ctx) return;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (visible) draw();
  }

  function draw() {
    if (!ctx || !canvas) return;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return;

    ctx.clearRect(0, 0, w, h);
    if (buf.length < 2) return;

    var span = GRAPH_WINDOW_SEC * 1000;
    var tEnd = buf[buf.length - 1][COL_TIME];
    var tStart = tEnd - span;

    var lanes = [
      { col: COL_AR, color: '#5ec8ff', label: 'R' },
      { col: COL_AP, color: '#8dffb0', label: 'P' },
      { col: COL_AY, color: '#ffd479', label: 'Y' }
    ];
    var laneH = h / lanes.length;

    ctx.font = '8px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'top';

    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li];
      var y0 = li * laneH;
      var mid = y0 + laneH / 2;
      var half = (laneH / 2) - 3;

      ctx.fillStyle = 'rgba(8, 18, 30, 0.45)';
      ctx.fillRect(0, y0 + 0.5, w, laneH - 1);

      ctx.strokeStyle = 'rgba(140, 200, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(mid) + 0.5);
      ctx.lineTo(w, Math.round(mid) + 0.5);
      ctx.stroke();

      ctx.strokeStyle = lane.color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < buf.length; i++) {
        var s = buf[i];
        var st = s[COL_TIME];
        if (st < tStart) continue;
        var v = s[lane.col];
        if (lane.col === COL_AY) {
          /* Wrap heading into ±180 for the trace so a multi-turn flight
             stays on the lane instead of sliding off during the turns. */
          v = ((v + 180) % 360 + 360) % 360 - 180;
        }
        var x = (st - tStart) / span * w;
        var norm = Math.max(-1, Math.min(1, v / GRAPH_RANGE_DEG));
        var y = mid - norm * half;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = lane.color;
      ctx.fillText(lane.label, 2, y0 + 1);
    }

    ctx.strokeStyle = 'rgba(140, 200, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  function setGraphVisible(v) {
    visible = !!v;
    if (!canvas) return;
    canvas.classList.toggle('hidden', !visible);
    if (visible) {
      resize();
      draw();
    }
  }

  function isGraphVisible() { return visible; }

  /* ------------------------------ export --------------------------------- */

  function round(x, dp) {
    var m = Math.pow(10, dp);
    return Math.round(x * m) / m;
  }

  function buildCSV() {
    if (!buf.length) return null;
    var rows = [HEADER.join(',')];
    for (var i = 0; i < buf.length; i++) {
      var s = buf[i];
      var out = [];
      for (var c = 0; c < HEADER.length; c++) {
        var v = s[c];
        if (typeof v !== 'number' || !isFinite(v)) v = 0;
        else v = (c === COL_TIME) ? Math.round(v) : round(v, 3);
        out.push(v);
      }
      rows.push(out.join(','));
    }
    return rows.join('\n') + '\n';
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function exportCSV() {
    var data = buildCSV();
    if (!data) return false;

    var blob = new Blob([data], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'fpv-blackbox-' + stamp() + '.csv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
    return true;
  }

  /* ------------------------------- state --------------------------------- */

  function reset() {
    applyConfig();
    buf.length = 0;
    t = 0;
    acc = 0;
    _prevHeading = null;
    _yawTurn = 0;
    lastDraw = 0;
    if (visible) draw();
  }

  function hasData() { return buf.length >= 2; }

  function sampleCount() { return buf.length; }

  function duration() {
    if (buf.length < 2) return 0;
    return Math.max(0, buf[buf.length - 1][COL_TIME] - buf[0][COL_TIME]);
  }

  return {
    init: init,
    resize: resize,
    sample: sample,
    reset: reset,
    clear: reset,
    draw: draw,
    setGraphVisible: setGraphVisible,
    isGraphVisible: isGraphVisible,
    hasData: hasData,
    sampleCount: sampleCount,
    duration: duration,
    exportCSV: exportCSV
  };
})();
