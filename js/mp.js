/* =========================================================================
   mp.js — Multiplayer remote drone manager.

   Renders remote players' drones with a small adaptive interpolation delay.
   Each remote drone has its own DroneVisual instance (already multi-instance
   capable) and its own short state buffer.

   Smoothing strategy:
     * A baseline 90 ms render delay grows with observed packet jitter (up
       to 260 ms), giving lossy links more room to interpolate smoothly.
     * If the render time runs past the newest sample, velocity is used to
       extrapolate for up to 180 ms instead of freezing.
     * Large position jumps (respawn / teleport) reset the buffer so a drone
       never streaks across the map.
     * A remote that stops sending is hidden after a short grace period
       rather than frozen in mid-air forever. The server also removes dead
       peers via its heartbeat.

   Public API:
     MP.init(scene)
     MP.spawnRemote(pid, loadout, nickname)
     MP.removeRemote(pid)
     MP.onState(msg)     // fed by Net.on('state', ...)
     MP.update(dt)       // call every frame from the main loop
     MP.clearAll()
     MP.getRemoteCount(), MP.getPlayerCount()
   ========================================================================= */
'use strict';

window.MP = (function () {
  var scene = null;
  var remotes = {};
  var BASE_INTERP_MS = 90;
  var MAX_INTERP_MS = 260;
  var MAX_EXTRAPOLATE_MS = 180;
  var STALE_HIDE_MS = 2500;
  var localLabel = null;
  var myNickname = 'YOU';

  // Reused per-frame to avoid allocating vectors for every remote.
  var fakeDrone = {
    position: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    armed: false,
    crashed: false,
    velocity: new THREE.Vector3()
  };
  var tmpLabelPos = new THREE.Vector3();
  var tmpDir = new THREE.Vector3();
  var tmpCamDir = new THREE.Vector3();

  var IDLE_INPUT = { throttle: 0.4, pitch: 0, roll: 0, yaw: 0 };
  var AIRBORNE_INPUT = { throttle: 0.5, pitch: 0, roll: 0, yaw: 0 };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var suffix = '…';
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + suffix).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + suffix;
  }

  function createNameLabel(text) {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, String(text || ''), 232), 128, 32);
    var texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true
    }));
    sprite.scale.set(1.5, 0.375, 1);
    sprite.visible = false;
    return sprite;
  }

  function init(sc) { scene = sc; }

  function spawnRemote(pid, loadout, nickname) {
    if (!scene) { console.warn('[MP] spawn before init'); return; }
    if (remotes[pid]) {
      if (nickname && remotes[pid].nickname !== nickname) {
        remotes[pid].nickname = nickname;
        scene.remove(remotes[pid].label);
        disposeLabel(remotes[pid].label);
        remotes[pid].label = createNameLabel(nickname);
        scene.add(remotes[pid].label);
      }
      return;
    }
    if (!window.DroneVisual || !DroneVisual.createInstance) {
      console.warn('[MP] DroneVisual not available'); return;
    }
    var v = DroneVisual.createInstance(scene);
    v.setFPVMode(false);
    v.setVisible(false);   // stay hidden until the first state packet arrives
    if (loadout) v.setLoadout(loadout);

    var label = createNameLabel(nickname || pid);
    scene.add(label);

    remotes[pid] = {
      visual: v,
      buffer: [],
      lastSeen: performance.now(),
      lastArrival: 0,
      jitter: 0,
      interpDelay: BASE_INTERP_MS,
      label: label,
      nickname: nickname || pid,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      armed: false,
      crashed: false,
      stale: false
    };
  }

  function disposeLabel(label) {
    if (!label) return;
    if (label.material) {
      if (label.material.map) label.material.map.dispose();
      label.material.dispose();
    }
  }

  function removeRemote(pid) {
    var r = remotes[pid];
    if (!r) return;
    if (r.visual && r.visual.dispose) {
      try { r.visual.dispose(); } catch (e) {}
    }
    if (r.label) {
      if (scene) scene.remove(r.label);
      disposeLabel(r.label);
    }
    delete remotes[pid];
  }

  function clearAll() {
    for (var pid in remotes) removeRemote(pid);
    if (localLabel) {
      if (scene) scene.remove(localLabel);
      disposeLabel(localLabel);
      localLabel = null;
    }
  }

  function setLocalNickname(nick) {
    myNickname = nick || 'YOU';
    // Local nametag is intentionally disabled — you know who you are.
    if (localLabel) {
      if (scene) scene.remove(localLabel);
      disposeLabel(localLabel);
      localLabel = null;
    }
  }

  function updateLocal(drone, camera, isFPV) {
    if (localLabel) localLabel.visible = false;
  }

  function onState(msg) {
    if (!msg || !msg.pid) return;
    var r = remotes[msg.pid];
    if (!r) return;
    if (!msg.p || !msg.q) return;

    var now = performance.now();
    var pos = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
    var quat = new THREE.Quaternion(msg.q[0], msg.q[1], msg.q[2], msg.q[3]);
    var vel = msg.v ? new THREE.Vector3(msg.v[0], msg.v[1], msg.v[2]) : new THREE.Vector3();

    // Adapt the jitter buffer to the observed arrival cadence. At a clean
    // 30 Hz this settles near the base delay; choppy links get more slack.
    if (r.lastArrival) {
      var gap = now - r.lastArrival;
      if (gap > 0 && gap < 1000) {
        r.jitter = r.jitter * 0.85 + Math.max(0, gap - 33) * 0.15;
        r.interpDelay = clamp(BASE_INTERP_MS + r.jitter * 1.6, BASE_INTERP_MS, MAX_INTERP_MS);
      }
    }
    r.lastArrival = now;
    r.lastSeen = now;
    r.stale = false;

    var newest = r.buffer.length ? r.buffer[r.buffer.length - 1] : null;
    if (newest) {
      var elapsed = (now - newest.t) / 1000;
      // 200 m/s is well above any flyable quad; treat faster as a teleport.
      if (elapsed > 0.01 && newest.pos.distanceTo(pos) / elapsed > 200) {
        r.buffer.length = 0;
      }
    }

    r.buffer.push({
      t: now,
      pos: pos,
      quat: quat,
      vel: vel,
      armed: !!msg.armed,
      crashed: !!msg.crashed
    });

    // Keep at most ~2 s of history (or 120 samples) per remote.
    while (r.buffer.length > 2 && (r.buffer.length > 120 || r.buffer[0].t < now - 2000)) {
      r.buffer.shift();
    }
  }

  function sampleRemote(r, renderAt) {
    var buf = r.buffer;
    var a = null, b = null;
    for (var i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].t <= renderAt) {
        a = buf[i - 1];
        b = buf[i];
        break;
      }
    }

    if (a && b) {
      var span = Math.max(1, b.t - a.t);
      var alpha = clamp((renderAt - a.t) / span, 0, 1);
      r.pos.copy(a.pos).lerp(b.pos, alpha);
      r.quat.copy(a.quat).slerp(b.quat, alpha);
      r.velocity.copy(a.vel).lerp(b.vel, alpha);
      r.armed = a.armed;
      r.crashed = a.crashed;
      return;
    }

    var last = buf[buf.length - 1];
    r.pos.copy(last.pos);
    r.quat.copy(last.quat);
    r.velocity.copy(last.vel);
    r.armed = last.armed;
    r.crashed = last.crashed;

    // Past the newest sample: coast on velocity for a short while so a
    // single dropped packet reads as motion instead of a freeze-frame.
    if (!last.crashed && renderAt > last.t) {
      var extra = Math.min(renderAt - last.t, MAX_EXTRAPOLATE_MS) / 1000;
      r.pos.addScaledVector(last.vel, extra);
    }
  }

  function update(dt, camera) {
    if (!camera) return;
    var now = performance.now();

    for (var pid in remotes) {
      var r = remotes[pid];
      if (!r.buffer.length) continue;

      var stale = (now - r.lastSeen) > STALE_HIDE_MS;
      r.stale = stale;

      if (stale) {
        r.visual.setVisible(false);
        if (r.label) r.label.visible = false;
        continue;
      }
      r.visual.setVisible(true);

      sampleRemote(r, now - r.interpDelay);

      fakeDrone.position = r.pos;
      fakeDrone.quat = r.quat;
      fakeDrone.armed = r.armed;
      fakeDrone.crashed = r.crashed;
      fakeDrone.velocity = r.velocity;

      var input = r.armed ? AIRBORNE_INPUT : IDLE_INPUT;
      r.visual.update(fakeDrone, input, dt);

      if (r.label) {
        tmpLabelPos.copy(r.pos);
        tmpLabelPos.y += 0.5;
        r.label.position.copy(tmpLabelPos);

        var dist = camera.position.distanceTo(tmpLabelPos);
        tmpDir.copy(tmpLabelPos).sub(camera.position).normalize();
        tmpCamDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
        var dot = tmpDir.dot(tmpCamDir);

        // Scale with distance so callsigns stay legible but don't fill the
        // screen when a pilot flies right past you.
        var s = clamp(dist * 0.05, 0.7, 3.5);
        r.label.scale.set(s, s * 0.25, 1);
        r.label.visible = dist < 90 && dot > 0.1;
      }
    }
  }

  function getRemoteStates() {
    var out = [];
    for (var pid in remotes) {
      var r = remotes[pid];
      if (r.buffer.length > 0) {
        out.push({
          pid: pid,
          pos: r.pos,
          velocity: r.velocity,
          armed: r.armed,
          crashed: r.crashed,
          nickname: r.nickname,
          stale: r.stale
        });
      }
    }
    return out;
  }

  function getRemoteCount() {
    return Object.keys(remotes).length;
  }

  return {
    init: init,
    spawnRemote: spawnRemote,
    removeRemote: removeRemote,
    clearAll: clearAll,
    setLocalNickname: setLocalNickname,
    updateLocal: updateLocal,
    onState: onState,
    update: update,
    getRemoteStates: getRemoteStates,
    getRemoteCount: getRemoteCount,
    getPlayerCount: function () { return getRemoteCount() + 1; }
  };
})();
