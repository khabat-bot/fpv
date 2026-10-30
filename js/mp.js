/* =========================================================================
   mp.js — Multiplayer remote drone manager.

   Renders remote players' drones with 100ms interpolation delay. Each
   remote drone has its own DroneVisual instance (already multi-instance
   capable) and its own short state buffer.

   Why 100ms delay? Network jitter is often 20-80ms even on LAN. Rendering
   at "now" would jitter visibly. Rendering 100ms behind gives us enough
   buffer to interpolate smoothly between the last two packets we got.

   Public API:
     MP.init(scene)
     MP.spawnRemote(pid, loadout)
     MP.removeRemote(pid)
     MP.onState(msg)     // fed by Net.on('state', ...)
     MP.update(dt)       // call every frame from the main loop
     MP.clearAll()
   ========================================================================= */
'use strict';

window.MP = (function () {
  var scene = null;
  var remotes = {};
  var INTERP_DELAY_MS = 100;
  var localLabel = null;
  var myNickname = 'YOU';

  function createNameLabel(text) {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);
    var texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(1.5, 0.375, 1);
    sprite.visible = false;
    return sprite;
  }

  // Reusable idle input state — remote drones don't have stick input, but
  // DroneVisual.update() reads pitch/roll/yaw to spin the props differentially.
  // Idle state → all props spin at base rate (matches a hovering quad).
  var IDLE_INPUT = { throttle: 0.4, pitch: 0, roll: 0, yaw: 0 };
  var AIRBORNE_INPUT = { throttle: 0.5, pitch: 0, roll: 0, yaw: 0 };

  function init(sc) { scene = sc; }

  function spawnRemote(pid, loadout, nickname) {
    if (!scene) { console.warn('[MP] spawn before init'); return; }
    if (remotes[pid]) {
      if (nickname && remotes[pid].nickname !== nickname) {
        remotes[pid].nickname = nickname;
        scene.remove(remotes[pid].label);
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
    if (loadout) v.setLoadout(loadout);
    
    var label = createNameLabel(nickname || pid);
    scene.add(label);
    
    remotes[pid] = {
      visual: v,
      buffer: [],
      lastSeen: performance.now(),
      label: label,
      nickname: nickname || pid
    };
  }

  function removeRemote(pid) {
    var r = remotes[pid];
    if (!r) return;
    if (r.visual && r.visual.dispose) {
      try { r.visual.dispose(); } catch (e) {}
    }
    if (r.label) {
      scene.remove(r.label);
      if (r.label.material.map) r.label.material.map.dispose();
      r.label.material.dispose();
    }
    delete remotes[pid];
  }

  function clearAll() {
    for (var pid in remotes) removeRemote(pid);
    if (localLabel) {
      scene.remove(localLabel);
      if (localLabel.material.map) localLabel.material.map.dispose();
      localLabel.material.dispose();
      localLabel = null;
    }
  }

  function setLocalNickname(nick) {
    myNickname = nick || 'YOU';
    if (localLabel) {
      scene.remove(localLabel);
      if (localLabel.material.map) localLabel.material.map.dispose();
      localLabel.material.dispose();
    }
    // No local label. You know who you are.
    if (localLabel) {
        scene.remove(localLabel);
        if (localLabel.material.map) localLabel.material.map.dispose();
        localLabel.material.dispose();
        localLabel = null;
    }
}

  function updateLocal(drone, camera, isFPV) {
    // Local nametag disabled.
    if (localLabel) localLabel.visible = false;
}

  function onState(msg) {
    if (!msg || !msg.pid) return;
    var r = remotes[msg.pid];
    if (!r) return;
    if (!msg.p || !msg.q) return;

    var now = performance.now();
    r.lastSeen = now;
    r.buffer.push({
      t: now,
      pos: new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]),
      quat: new THREE.Quaternion(msg.q[0], msg.q[1], msg.q[2], msg.q[3]),
      armed: !!msg.armed,
      crashed: !!msg.crashed
    });
    // Trim history older than 1.5s
    while (r.buffer.length > 2 && r.buffer[0].t < now - 1500) {
      r.buffer.shift();
    }
  }

  function update(dt, camera) {
    if (!camera) return;
    var renderAt = performance.now() - INTERP_DELAY_MS;
    for (var pid in remotes) {
      var r = remotes[pid];
      if (!r.buffer.length) continue;

      // Find the pair of samples surrounding renderAt
      var a = null, b = null;
      for (var i = 0; i < r.buffer.length - 1; i++) {
        if (r.buffer[i].t <= renderAt && r.buffer[i + 1].t >= renderAt) {
          a = r.buffer[i];
          b = r.buffer[i + 1];
          break;
        }
      }

      var pos, quat, armed, crashed;
      if (a && b) {
        var alpha = (renderAt - a.t) / Math.max(1, b.t - a.t);
        if (alpha < 0) alpha = 0; if (alpha > 1) alpha = 1;
        pos = a.pos.clone().lerp(b.pos, alpha);
        quat = a.quat.clone().slerp(b.quat, alpha);
        armed = a.armed;
        crashed = a.crashed;
      } else {
        // Not enough surrounding data — use the latest received sample
        var last = r.buffer[r.buffer.length - 1];
        pos = last.pos;
        quat = last.quat;
        armed = last.armed;
        crashed = last.crashed;
      }

      // DroneVisual.update expects an object with position/quat/armed/
      // crashed/velocity. Velocity is only read by the crash-flash LED
      // code path — remote drones don't need it.
      var fakeDrone = {
        position: pos,
        quat: quat,
        armed: armed,
        crashed: crashed,
        velocity: { x: 0, y: 0, z: 0, length: function () { return 0; } }
      };
      var input = armed ? AIRBORNE_INPUT : IDLE_INPUT;
      r.visual.update(fakeDrone, input, dt);

      if (r.label) {
        var labelPos = pos.clone().add(new THREE.Vector3(0, 0.35, 0));
        r.label.position.copy(labelPos);
        var dist = camera.position.distanceTo(labelPos);
        var dirToLabel = labelPos.clone().sub(camera.position).normalize();
        var camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        var dot = dirToLabel.dot(camDir);
        
        if (dist > 60 || dot < 0.1) {
          r.label.visible = false;
        } else {
          r.label.visible = true;
        }
      }
    }
  }

  function getRemoteStates() {
    var out = [];
    for (var pid in remotes) {
      var r = remotes[pid];
      if (r.buffer.length > 0) {
        var last = r.buffer[r.buffer.length - 1];
        out.push({ pid: pid, pos: last.pos, armed: last.armed });
      }
    }
    return out;
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
    getRemoteStates: getRemoteStates
  };
})();
