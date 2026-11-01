/* =========================================================================
   replay.js — manual flight recorder + preview playback + file transfer.

   States:
     idle       no recording loaded
     recording  capturing the live drone at REC_HZ
     ready      a recording exists and can be previewed/exported
     previewing the camera follows the recorded drone

   The recorder only runs between startRecording() and stopRecording();
   nothing is captured in the background. Preview playback can be started
   from the Replay panel and is driven by main.js calling update(dt).
   ========================================================================= */
'use strict';
window.Replay = (function () {
    var REC_HZ = 30;
    var REC_DT = 1 / REC_HZ;
    var MAX_FRAMES = REC_HZ * 60 * 10;   /* 10 minutes */

    var frames = [];

    var recording = false;
    var recAcc = 0;
    var recT = 0;

    var previewing = false;
    var playTime = 0;
    var playIndex = 0;

    var scene = null;
    var visual = null;
    var loadout = null;
    var fpvMode = false;
    var onChange = null;
    var _lastNotify = 0;

    /* Reusable playback pose / stick values. */
    var _pos = new THREE.Vector3();
    var _quat = new THREE.Quaternion();
    var _qa = new THREE.Quaternion();
    var _qb = new THREE.Quaternion();
    var _stick = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };
    var _speed = 0;
    var _pose = null;

    function init(sc) { scene = sc; }

    function setOnChange(fn) { onChange = fn; }
    function setLoadout(l) {
        loadout = l;
        if (visual && visual.setLoadout) visual.setLoadout(l);
    }
    function setFPVMode(on) {
        fpvMode = !!on;
        if (visual) visual.setFPVMode(fpvMode);
    }
    function setVisible(v) {
        if (visual && visual.group) visual.group.visible = v;
    }

    function notify() {
        _lastNotify = performance.now();
        if (onChange) onChange(getState());
    }

    function getState() {
        return {
            recording: recording,
            previewing: previewing,
            hasData: frames.length >= 2,
            frames: frames.length,
            duration: duration(),
            time: previewing ? playTime : 0
        };
    }

    function duration() {
        if (frames.length < 2) return 0;
        return Math.max(0, frames[frames.length - 1].t - frames[0].t);
    }

    function isRecording() { return recording; }
    function isPreviewing() { return previewing; }
    function isPlaying() { return previewing; }   /* backwards compat */
    function hasData() { return frames.length >= 2; }

    /* ------------------------------------------------------------------
       Recording
       ------------------------------------------------------------------ */

    function capture(drone, state, t) {
        var e = {
            t: t,
            px: drone.position.x,
            py: drone.position.y,
            pz: drone.position.z,
            qx: drone.quat.x,
            qy: drone.quat.y,
            qz: drone.quat.z,
            qw: drone.quat.w,
            throttle: state ? (state.throttle || 0) : 0,
            pitch:    state ? (state.pitch    || 0) : 0,
            roll:     state ? (state.roll     || 0) : 0,
            yaw:      state ? (state.yaw      || 0) : 0
        };
        if (frames.length) {
            var last = frames[frames.length - 1];
            if (e.t <= last.t) e.t = last.t + 0.001;
        }
        frames.push(e);
    }

    function startRecording() {
        if (recording) return false;
        if (previewing) stopPreview();
        frames = [];
        recording = true;
        recAcc = 0;
        recT = 0;
        notify();
        return true;
    }

    function stopRecording() {
        if (!recording) return false;
        recording = false;
        recAcc = 0;
        notify();
        return true;
    }

    function record(drone, state, dt) {
        if (!recording || !drone) return;

        /* Always capture the very first sample immediately. */
        if (frames.length === 0) {
            capture(drone, state, 0);
            recT = 0;
            recAcc = 0;
            notify();
            return;
        }

        recT += dt;
        recAcc += dt;
        if (recAcc < REC_DT) return;
        while (recAcc >= REC_DT) recAcc -= REC_DT;

        capture(drone, state, recT);

        if (frames.length >= MAX_FRAMES) {
            recording = false;
            recAcc = 0;
            notify();
            return;
        }

        var now = performance.now();
        if (now - _lastNotify > 200) notify();
    }

    /* ------------------------------------------------------------------
       Preview playback
       ------------------------------------------------------------------ */

    function ensureVisual() {
        if (visual) return;
        if (!window.DroneVisual || !DroneVisual.createInstance) return;
        visual = DroneVisual.createInstance(scene);
        if (loadout && visual.setLoadout) visual.setLoadout(loadout);
        if (visual.group) visual.group.visible = false;
    }

    function applyPlayback(dt) {
        var first = frames[0];
        var target = first.t + playTime;

        while (playIndex < frames.length - 2 && frames[playIndex + 1].t <= target) {
            playIndex++;
        }

        var a = frames[playIndex];
        var b = frames[Math.min(playIndex + 1, frames.length - 1)];
        var span = b.t - a.t;
        var f = span > 0.000001 ? (target - a.t) / span : 0;
        f = f < 0 ? 0 : (f > 1 ? 1 : f);

        _pos.set(
            a.px + (b.px - a.px) * f,
            a.py + (b.py - a.py) * f,
            a.pz + (b.pz - a.pz) * f
        );
        _qa.set(a.qx, a.qy, a.qz, a.qw);
        _qb.set(b.qx, b.qy, b.qz, b.qw);
        _quat.copy(_qa).slerp(_qb, f);

        _stick.throttle = a.throttle + (b.throttle - a.throttle) * f;
        _stick.pitch    = a.pitch    + (b.pitch    - a.pitch)    * f;
        _stick.roll     = a.roll     + (b.roll     - a.roll)     * f;
        _stick.yaw      = a.yaw      + (b.yaw      - a.yaw)      * f;

        if (span > 0.000001) {
            var vx = (b.px - a.px) / span;
            var vy = (b.py - a.py) / span;
            var vz = (b.pz - a.pz) / span;
            _speed = Math.hypot(vx, vy, vz);
        } else {
            _speed = 0;
        }

        if (visual && visual.group) {
            visual.group.position.copy(_pos);
            visual.group.quaternion.copy(_quat);
            var fd = {
                position: visual.group.position,
                quat: visual.group.quaternion,
                armed: true,
                crashed: false,
                throttleIn: _stick.throttle,
                velocity: { length: function () { return _speed; } }
            };
            visual.update(fd, _stick, dt);
        }

        _pose = { position: _pos, quat: _quat, speed: _speed, stick: _stick };
    }

    function startPreview() {
        if (recording) stopRecording();
        if (frames.length < 2) return false;
        ensureVisual();
        previewing = true;
        playTime = 0;
        playIndex = 0;
        applyPlayback(0);
        if (visual) {
            visual.setFPVMode(fpvMode);
            visual.group.visible = !fpvMode;
        }
        notify();
        return true;
    }

    function stopPreview() {
        if (!previewing) return false;
        previewing = false;
        playTime = 0;
        playIndex = 0;
        _pose = null;
        setVisible(false);
        notify();
        return true;
    }

    function update(dt) {
        if (!previewing) return;
        playTime += dt;
        var dur = duration();

        if (playTime >= dur) {
            playTime = dur;
            playIndex = Math.max(0, frames.length - 2);
            applyPlayback(0);
            previewing = false;
            _pose = null;
            setVisible(false);
            notify();
            return;
        }

        applyPlayback(dt);

        var now = performance.now();
        if (now - _lastNotify > 200) notify();
    }

    function getPose() {
        return (previewing && _pose) ? _pose : null;
    }

    function getStickState() {
        return (previewing && _pose) ? _pose.stick : null;
    }

    /* ------------------------------------------------------------------
       Clear / export / import
       ------------------------------------------------------------------ */

    function stopAll() {
        if (recording) stopRecording();
        if (previewing) stopPreview();
    }

    function clear() {
        stopAll();
        frames = [];
        _pose = null;
        notify();
    }

    /* Accept both our compact object frames and plain arrays:
       [t, px,py,pz, qx,qy,qz,qw, throttle,pitch,roll,yaw] */
    function normalizeFrame(raw, idx) {
        var t, p, q, s;
        if (Array.isArray(raw)) {
            if (raw.length < 12) return null;
            t = Number(raw[0]);
            p = raw.slice(1, 4);
            q = raw.slice(4, 8);
            s = raw.slice(8, 12);
        } else if (raw && typeof raw === 'object') {
            p = raw.p || raw.pos || raw.position;
            q = raw.q || raw.quat || raw.quaternion;
            s = raw.s || raw.stick || raw.state || [0, 0, 0, 0];
            t = raw.t != null ? raw.t : (raw.time != null ? raw.time : idx / REC_HZ);
        } else {
            return null;
        }
        if (!p || p.length < 3 || !q || q.length < 4) return null;
        var f = {
            t: Number(t),
            px: Number(p[0]), py: Number(p[1]), pz: Number(p[2]),
            qx: Number(q[0]), qy: Number(q[1]), qz: Number(q[2]), qw: Number(q[3]),
            throttle: s && s.length > 0 ? Number(s[0]) : 0,
            pitch:    s && s.length > 1 ? Number(s[1]) : 0,
            roll:     s && s.length > 2 ? Number(s[2]) : 0,
            yaw:      s && s.length > 3 ? Number(s[3]) : 0
        };
        if (!isFinite(f.t) || !isFinite(f.px) || !isFinite(f.py) || !isFinite(f.pz)
            || !isFinite(f.qx) || !isFinite(f.qy) || !isFinite(f.qz) || !isFinite(f.qw)) {
            return null;
        }
        return f;
    }

    function loadFrames(list) {
        if (!Array.isArray(list)) throw new Error('No frames found in replay file');
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var f = normalizeFrame(list[i], i);
            if (f) out.push(f);
        }
        if (out.length < 2) throw new Error('Replay needs at least 2 frames');

        /* Normalise time so playback always starts at zero and remains
           monotonic even if the file was hand-edited. */
        var base = out[0].t;
        for (var j = 0; j < out.length; j++) {
            out[j].t -= base;
            if (j > 0 && out[j].t <= out[j - 1].t) out[j].t = out[j - 1].t + 0.001;
        }

        stopAll();
        frames = out;
        _pose = null;
        notify();
    }

    function importFile(file) {
        return new Promise(function (resolve, reject) {
            if (!file) { reject(new Error('No file selected')); return; }
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    var data = JSON.parse(reader.result);
                    var list = Array.isArray(data) ? data : (data && data.frames);
                    loadFrames(list);
                    resolve(getState());
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = function () { reject(new Error('Could not read file')); };
            reader.readAsText(file);
        });
    }

    function exportFile() {
        if (frames.length < 2) return false;

        var data = {
            format: 'fpv-sim-replay',
            version: 1,
            hz: REC_HZ,
            duration: duration(),
            frames: frames.map(function (f) {
                return {
                    t: Math.round(f.t * 1000) / 1000,
                    p: [
                        Math.round(f.px * 10000) / 10000,
                        Math.round(f.py * 10000) / 10000,
                        Math.round(f.pz * 10000) / 10000
                    ],
                    q: [
                        Math.round(f.qx * 10000) / 10000,
                        Math.round(f.qy * 10000) / 10000,
                        Math.round(f.qz * 10000) / 10000,
                        Math.round(f.qw * 10000) / 10000
                    ],
                    s: [
                        Math.round(f.throttle * 1000) / 1000,
                        Math.round(f.pitch * 1000) / 1000,
                        Math.round(f.roll * 1000) / 1000,
                        Math.round(f.yaw * 1000) / 1000
                    ]
                };
            })
        };

        var stamp = new Date().toISOString()
            .replace(/[-:]/g, '')
            .replace(/\..+$/, '');
        var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'fpv-replay-' + stamp + '.json';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1000);
        return true;
    }

    /* Backwards-compatible names used by older main.js paths. */
    function start() { return startPreview(); }
    function stop() { return stopPreview(); }

    return {
        init: init,
        setOnChange: setOnChange,
        setLoadout: setLoadout,
        setFPVMode: setFPVMode,

        startRecording: startRecording,
        stopRecording: stopRecording,
        record: record,

        startPreview: startPreview,
        stopPreview: stopPreview,
        update: update,
        getPose: getPose,
        getStickState: getStickState,

        clear: clear,
        exportFile: exportFile,
        importFile: importFile,
        getState: getState,
        getDuration: duration,

        isRecording: isRecording,
        isPreviewing: isPreviewing,
        isPlaying: isPlaying,
        hasData: hasData,

        start: start,
        stop: stop
    };
})();
