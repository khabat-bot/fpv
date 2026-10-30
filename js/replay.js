/* =========================================================================
replay.js — 30 Hz ring buffer of last 60s, manual playback as ghost.
========================================================================= */
'use strict';
window.Replay = (function () {
    var MAX = 1800;
    var HZ = 30;
    var DT = 1 / HZ;

    var entries = [];
    for (var i = 0; i < MAX; i++) {
        entries.push({
            t: 0,
            px: 0, py: 0, pz: 0,
            qx: 0, qy: 0, qz: 0, qw: 1,
            roll: 0, pitch: 0, yaw: 0, throttle: 0
        });
    }

    var head = 0;
    var count = 0;
    var acc = 0;

    var playing = false;
    var playIdx = 0;
    var playElapsed = 0;

    var scene = null;
    var visual = null;

    function init(sc) { scene = sc; }

    function record(drone, state, dt) {
        if (playing) return;
        acc += dt;
        if (acc < DT) return;
        while (acc >= DT) acc -= DT;

        var e = entries[head];
        e.t = performance.now();
        e.px = drone.position.x;
        e.py = drone.position.y;
        e.pz = drone.position.z;
        e.qx = drone.quat.x;
        e.qy = drone.quat.y;
        e.qz = drone.quat.z;
        e.qw = drone.quat.w;
        e.roll = state ? (state.roll || 0) : 0;
        e.pitch = state ? (state.pitch || 0) : 0;
        e.yaw = state ? (state.yaw || 0) : 0;
        e.throttle = state ? (state.throttle || 0) : 0;

        head = (head + 1) % MAX;
        if (count < MAX) count++;
    }

    function oldestIndex() {
        return (head - count + MAX) % MAX;
    }

    function ensureVisual() {
        if (visual) return;
        if (!window.DroneVisual || !DroneVisual.createInstance) return;
        visual = DroneVisual.createInstance(scene);
        if (visual.setFPVMode) visual.setFPVMode(false);
        if (visual.group) {
            visual.group.traverse(function (o) {
                if (o.isMesh && o.material) {
                    var mats = Array.isArray(o.material) ? o.material : [o.material];
                    for (var m = 0; m < mats.length; m++) {
                        mats[m].transparent = true;
                        mats[m].opacity = 0.35;
                        mats[m].depthWrite = false;
                    }
                }
            });
            visual.group.visible = false;
        }
    }

    function start() {
        if (count < 2) return false;
        playing = true;
        playIdx = 0;
        playElapsed = 0;
        ensureVisual();
        if (visual && visual.group) visual.group.visible = true;
        return true;
    }

    function stop() {
        playing = false;
        if (visual && visual.group) visual.group.visible = false;
    }

    function update(dt) {
        if (!playing || count < 2) return;
        playElapsed += dt;

        var startI = oldestIndex();
        var startT = entries[startI].t;
        var targetT = startT + playElapsed * 1000;

        var found = -1;
        for (var i = 0; i < count; i++) {
            var idx = (startI + i) % MAX;
            if (entries[idx].t <= targetT) found = i;
            else break;
        }

        if (found < 0 || found >= count - 1) {
            stop();
            return;
        }

        var ei = (startI + found) % MAX;
        var e = entries[ei];

        if (visual && visual.group) {
            visual.group.position.set(e.px, e.py, e.pz);
            visual.group.quaternion.set(e.qx, e.qy, e.qz, e.qw);
            var fs = { throttle: e.throttle, pitch: e.pitch, roll: e.roll, yaw: e.yaw };
            var fd = {
                position: visual.group.position,
                quat: visual.group.quaternion,
                armed: true, crashed: false,
                velocity: { length: function () { return 0; } }
            };
            visual.update(fd, fs, dt);
        }
    }

    function getStickState() {
        if (!playing || count < 2) return null;
        var startI = oldestIndex();
        var startT = entries[startI].t;
        var targetT = startT + playElapsed * 1000;
        var found = -1;
        for (var i = 0; i < count; i++) {
            var idx = (startI + i) % MAX;
            if (entries[idx].t <= targetT) found = idx;
            else break;
        }
        if (found < 0) return null;
        var e = entries[found];
        return { throttle: e.throttle, pitch: e.pitch, roll: e.roll, yaw: e.yaw };
    }

    function isPlaying() { return playing; }
    function hasData() { return count >= 2; }

    return {
        init: init,
        record: record,
        start: start,
        stop: stop,
        update: update,
        getStickState: getStickState,
        isPlaying: isPlaying,
        hasData: hasData
    };
})();
