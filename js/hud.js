/* =========================================================================
   hud.js — FPV OSD: artificial horizon + telemetry.

   The horizon line is drawn at the mathematical (pitch=0) horizon. Because
   the ground now extends effectively to the fog line in every direction,
   the green line coincides with the real visible horizon at all normal
   altitudes. For extreme pitch angles the line is faded out as it drifts
   toward the top/bottom of the screen so it can never float over empty sky.
   ========================================================================= */
'use strict';

window.HUD = (function () {
let stickCanvas = null;
let stickCtx = null;
let stickVisible = true;

function initStickHUD() {
    stickCanvas = document.getElementById('stick-hud-canvas');
    if (!stickCanvas) return;
    stickCtx = stickCanvas.getContext('2d');
    resizeStickHUD();
}

function resizeStickHUD() {
    if (!stickCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = stickCanvas.clientWidth;
    const h = stickCanvas.clientHeight;
    stickCanvas.width = w * dpr;
    stickCanvas.height = h * dpr;
    stickCtx.scale(dpr, dpr);
}

function drawStickHUD(state) {
    if (!stickCtx || !stickVisible) return;
    const w = stickCanvas.clientWidth;
    const h = stickCanvas.clientHeight;
    stickCtx.clearRect(0, 0, w, h);
    if (!state) return;
    const r = Math.min(w * 0.15, h * 0.8);
    const cy = h - r - 8;
    const lx = w * 0.15;
    stickCtx.strokeStyle = 'rgba(140, 200, 255, 0.25)';
    stickCtx.lineWidth = 1;
    stickCtx.beginPath();
    stickCtx.arc(lx, cy, r, 0, Math.PI * 2);
    stickCtx.stroke();
    const rollX = lx + state.roll * r;
    const pitchY = cy - state.pitch * r;
    stickCtx.fillStyle = 'rgba(110, 242, 160, 0.7)';
    stickCtx.beginPath();
    stickCtx.arc(rollX, pitchY, 4, 0, Math.PI * 2);
    stickCtx.fill();
    const barX = lx + r + 12;
    const barH = r * 2;
    const barW = 5;
    stickCtx.fillStyle = 'rgba(140, 200, 255, 0.15)';
    stickCtx.fillRect(barX - barW/2, cy - barH/2, barW, barH);
    const thrH = state.throttle * barH;
    stickCtx.fillStyle = 'rgba(110, 242, 160, 0.6)';
    stickCtx.fillRect(barX - barW/2, cy + barH/2 - thrH, barW, thrH);
    const rx = w * 0.85;
    stickCtx.strokeStyle = 'rgba(140, 200, 255, 0.25)';
    stickCtx.beginPath();
    stickCtx.arc(rx, cy, r, 0, Math.PI * 2);
    stickCtx.stroke();
    const yawX = rx + state.yaw * r;
    const thrY = cy - (state.throttle * 2 - 1) * r;
    stickCtx.fillStyle = 'rgba(110, 242, 160, 0.7)';
    stickCtx.beginPath();
    stickCtx.arc(yawX, thrY, 4, 0, Math.PI * 2);
    stickCtx.fill();
}

function setStickVisible(v) {
    stickVisible = v;
    if (stickCanvas) stickCanvas.style.display = v ? '' : 'none';
}

  let el = {};
  let _lowBatt = false;

  function fmtTime(sec) {
    let s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function init() {
    el.arm     = document.getElementById('osd-arm');
    el.volt    = document.getElementById('osd-volt');
    el.mah     = document.getElementById('osd-mah');
    el.timer   = document.getElementById('osd-timer');
    el.speed   = document.getElementById('osd-speed');
    el.alt     = document.getElementById('osd-alt');
    el.thr     = document.getElementById('osd-thr');
    el.thrFill = document.getElementById('thr-fill');
    el.crash   = document.getElementById('crash');
  }

  function update(drone, camera, flightTime, stickThrottle) {

    /* ---------------------- telemetry ---------------------- */
    el.arm.textContent = drone.armed ? 'ARMED' : 'DISARMED';
    el.arm.style.color = drone.armed ? '#8dffb0' : '#ff9d9d';

    el.volt.textContent = drone.voltage.toFixed(1) + 'V';
    el.mah.textContent  = Math.round(drone.mahUsed) + 'mAh';
    el.timer.textContent = fmtTime(flightTime);

    el.speed.textContent = (drone.velocity.length() * 3.6).toFixed(0) + ' km/h';
    el.alt.textContent   = Math.max(0, drone.position.y).toFixed(1) + ' m';

    const pct = Math.round(stickThrottle * 100);
    el.thr.textContent = 'THR ' + pct + '%';
    el.thrFill.style.width = pct + '%';

    const vPerCell = drone.voltage / CFG.battery.cells;
    const low = drone.armed && vPerCell < CFG.battery.lowCellVoltage;
    if (low !== _lowBatt) {
      _lowBatt = low;
      el.volt.classList.toggle('volt-low', low);
    }
  }

  function showCrash(show) {
    el.crash.classList.toggle('hidden', !show);
  }

  return { init: init, update: update, showCrash: showCrash, resizeStickHUD: resizeStickHUD, setStickVisible: setStickVisible };
})();
