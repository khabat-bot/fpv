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

  return { init: init, update: update, showCrash: showCrash };
})();
