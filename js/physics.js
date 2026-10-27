/* =========================================================================
   physics.js — rate-based acro quad, with v5 physics polish:
     • realistic LiPo discharge curve + current-based sag with smoothing
     • motor desync kicks on rapid throttle changes at high throttle
     • windmill braking at low throttle / high speed
     • ground-effect wobble when close to terrain
   ========================================================================= */
'use strict';

window.Drone = (function () {

  const DEG = Math.PI / 180;

  function curve(x, expo) {
    const c = x < -1 ? -1 : (x > 1 ? 1 : x);
    return (1 - expo) * c + expo * c * c * c;
  }

  function Drone() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.quat     = new THREE.Quaternion();
    this.angVel   = new THREE.Vector3();

    this.armed   = false;
    this.crashed = false;
    this.easyMode = false;
    this.flightMode = 'ACRO';
    this._easyHeading = 0;
    this.colliders = [];

    this.mahUsed = 0;
    this.voltage = CFG.battery.cells * 4.2;
    this.throttleIn = 0;
    this._smoothCurrent = 0;

    this._target = new THREE.Vector3();
    this._accel  = new THREE.Vector3();
    this._tmpV   = new THREE.Vector3();
    this._tmpQ   = new THREE.Quaternion();
    this._up     = new THREE.Vector3();

    this._wobAmp = 0;
    this._wobPhase = 0;
    this._prevThrottle = 0;
    this._grounded = false;
    this._groundedTime = 0;

    this.reset(0, 0);
  }

  Drone.prototype.getFloorY = function () { return CFG.groundY; };

  /* Return the active preset for the current flightMode.
     Fallback chain: this.flightMode preset → SPORT → empty. */
  Drone.prototype._easyPreset = function () {
    const em = CFG.easyMode || {};
    const presets = em.presets || {};
    return presets[this.flightMode] || presets.SPORT || {};
  };

  Drone.prototype.reset = function (x, z) {
    const px = x || 0, pz = z || 0;
    const fy = this.getFloorY(px, pz, true);   // spawn: find highest surface

    this.position.set(px, fy, pz);
    this.velocity.set(0, 0, 0);
    this.quat.identity();
    this.angVel.set(0, 0, 0);

    this.armed = false;
    this.crashed = false;
    this.mahUsed = 0;
    this.voltage = CFG.battery.cells * 4.2;
    this.throttleIn = 0;
    this._smoothCurrent = 0;

    this._wobAmp = 0;
    this._wobPhase = 0;
    this._prevThrottle = 0;
    this._windTime = 0;
    this._grounded = false;
    this._groundedTime = 0;
  };

  Drone.prototype.toggleArm = function () {
    if (this.crashed) return;
    this.armed = !this.armed;
    if (!this.armed) this.angVel.set(0, 0, 0);
  };

  Drone.prototype.crash = function () {
    if (this.crashed) return;
    this.crashed = true;
    this.armed = false;
  };

  Drone.prototype.step = function (dt, input) {

    const thr = this.armed ? Math.max(0, Math.min(1, input.throttle)) : 0;
    this.throttleIn = thr;
    this._windTime = (this._windTime || 0) + dt;
    this._groundedTime = Math.max(0, (this._groundedTime || 0) - dt);

    const e = CFG.expo;
    const easyActive = !!(this.easyMode && this.armed);

    if (easyActive) {
      /* ===== EASY MODE — self-leveling (angle mode) ==================
         Stick commands a target tilt angle, not a rotation rate.
         Centered sticks → error → leveling rate → drone auto-levels.
         Yaw stays rate-based (with reduced max rate).
         Sign conventions match acro:
           +stick pitch → nose down  (negative ω_x)
           +stick roll  → bank right (negative ω_z)
           +stick yaw   → same as acro
         ============================================================== */
      const em = this._easyPreset();
      const maxAngle = (em.maxAngleDeg     != null ? em.maxAngleDeg     : 35)  * DEG;
      const gain     = (CFG.easyMode.levelGain != null ? CFG.easyMode.levelGain : 5.0);
      const rpScale  = (em.maxRatesScale   != null ? em.maxRatesScale   : 0.75);
      const yawScale = (em.yawRatesScale   != null ? em.yawRatesScale   : 0.9);

      // Extract heading via SWING-TWIST decomposition around world Y.
      // This is the mathematically correct way to recover "yaw" from a
      // tilted quaternion. YXZ Euler decomposition (used previously) mixes
      // pitch and roll into the yaw value once the drone is tilted — e.g.
      // a drone at pitch=30deg, yaw=45deg extracts as yaw=49deg with a
      // spurious roll of 22deg, so the controller builds a target at a
      // totally different attitude and blows up. Fixed by swing-twist.
      //
      //   twist_len = sqrt(q.y^2 + q.w^2)
      //   heading   = 2 * atan2(q.y, q.w)
      let heading;
      const twistLen = Math.sqrt(this.quat.y * this.quat.y + this.quat.w * this.quat.w);
      if (twistLen < 1e-3) {
        // Degenerate: quaternion is (nearly) 180deg around some axis in
        // the XZ plane — the drone is inverted, heading is undefined.
        // Reuse last known heading so recovery isn't disorienting.
        heading = this._easyHeading || 0;
      } else {
        heading = 2 * Math.atan2(this.quat.y, this.quat.w);
        this._easyHeading = heading;
      }

      // Target attitude: heading preserved, pitch/roll from stick.
      const targetEul = new THREE.Euler(
        -curve(input.pitch, e) * maxAngle,
        heading,
        -curve(input.roll,  e) * maxAngle,
        'YXZ'
      );
      const targetQ = new THREE.Quaternion().setFromEuler(targetEul);

      // Body-frame error quaternion: q_current^-1 * q_target
      const qErr = this._tmpQ.copy(this.quat).invert().multiply(targetQ);

      // Always take the SHORTEST path. Without this, when the error exceeds
      // 180deg-equivalent (e.g. an inverted recovery), qErr.w < 0 and the
      // controller spins the drone the long way around — the "freaks out
      // spinning" symptom. Negating the quaternion flips to the short arc.
      if (qErr.w < 0) {
        qErr.x = -qErr.x;
        qErr.y = -qErr.y;
        qErr.z = -qErr.z;
        qErr.w = -qErr.w;
      }

      // Body-frame axis-angle → proportional rate toward target.
      // Ignore qErr.y (yaw error) — heading is preserved by construction.
      let corrX = 0, corrZ = 0;
      const halfAngle = Math.acos(Math.max(-1, Math.min(1, qErr.w)));
      const sinHalf   = Math.sin(halfAngle);
      if (sinHalf > 1e-3) {
        const scale = gain * 2 * halfAngle / sinHalf;
        corrX = qErr.x * scale;
        corrZ = qErr.z * scale;
      } else if (halfAngle > 1e-3) {
        // Near 180° error (inverted recovery) — degenerate axis, fall back.
        corrX = gain * Math.PI * (qErr.x >= 0 ?  0.5 : -0.5);
        corrZ = gain * Math.PI * (qErr.z >= 0 ?  0.5 : -0.5);
      }

      // Clamp leveling rate.
      const maxR = CFG.maxRates.roll * DEG * rpScale;
      const mag  = Math.sqrt(corrX * corrX + corrZ * corrZ);
      if (mag > maxR && mag > 1e-6) {
        const s = maxR / mag;
        corrX *= s;
        corrZ *= s;
      }

      // Yaw: rate-based, reduced.
      const yawRate = curve(input.yaw, e) * CFG.maxRates.yaw * DEG * CFG.rcRate * yawScale;

      this._target.set(corrX, -yawRate, corrZ);
    } else {
      /* ===== ACRO MODE (existing behaviour, disarm gating preserved) ===== */
      const rRate = (this.armed ? curve(input.roll,  e) * CFG.maxRates.roll  * DEG * CFG.rcRate : 0);
      const pRate = (this.armed ? curve(input.pitch, e) * CFG.maxRates.pitch * DEG * CFG.rcRate : 0);
      const yRate = (this.armed ? curve(input.yaw,   e) * CFG.maxRates.yaw   * DEG * CFG.rcRate : 0);

      this._target.set(-pRate, -yRate, -rRate);
    }

    const a = this._accel
      .copy(this._target)
      .sub(this.angVel)
      .multiplyScalar(1 / CFG.angResponse);

    const aLen = a.length();
    if (aLen > CFG.angAccelMax) a.multiplyScalar(CFG.angAccelMax / aLen);

    const dThr = thr - this._prevThrottle;
    this._prevThrottle = thr;

    this._wobAmp += Math.abs(dThr) * CFG.propWashGain;
    this._wobAmp *= Math.exp(-dt * 7.0);
    this._wobPhase += dt * Math.PI * 2 * CFG.propWashFreq;

    if (thr > 0.03) {
      const wobScale = easyActive ? 0.4 : 1.0;
      const w = Math.sin(this._wobPhase) * this._wobAmp * thr;
      a.x += w * 400 * wobScale;
      a.z += Math.sin(this._wobPhase * 0.73 + 1.7) * this._wobAmp * thr * 320 * wobScale;
      a.x += Math.sin(this._wobPhase * 2.31) * 2.5 * thr * wobScale;
      a.z += Math.cos(this._wobPhase * 1.87) * 2.0 * thr * wobScale;
    }

    /* ---- motor desync: rapid throttle changes → brief yaw kicks ----
       Skipped in easy mode — the yaw kicks fight the leveling controller. */
    if (!easyActive && Math.abs(dThr) > 0.2 && thr > 0.3) {
      a.y += (Math.random() - 0.5) * Math.min(1.5, Math.abs(dThr) * 2.0) * 6.0;
    }

    /* ---- ground effect: wobble near terrain ---- */
    const floorHere = this.getFloorY(this.position.x, this.position.z);
    const agl = this.position.y - floorHere;
    if (agl > 0.2 && agl < 2.5 && this.armed) {
      const eff = (1 - agl / 2.5) * 0.5 * (easyActive ? 0.3 : 1.0);
      a.x += (Math.random() - 0.5) * eff * 80;
      a.z += (Math.random() - 0.5) * eff * 80;
    }

    this.angVel.addScaledVector(a, dt);

    const wLen = this.angVel.length();
    if (wLen > 1e-6) {
      this._tmpQ.setFromAxisAngle(
        this._tmpV.copy(this.angVel).multiplyScalar(1 / wLen),
        wLen * dt);
      this.quat.multiply(this._tmpQ);
      this.quat.normalize();
    }

    this._up.set(0, 1, 0).applyQuaternion(this.quat);

    const acc = this._accel;
    if (easyActive) {
      /* ===== EASY MODE — altitude hold =============================
         Throttle = climb-rate command:
           0.5  → hold altitude
           1.0  → climb at maxClimbRate
           0.0  → descend at maxDescendRate (downward)
         P controller on vertical-velocity error → required thrust.
         Thrust is scaled by 1/up.y to cancel the cos(tilt) loss, so
         tilting forward does not change vertical speed. This is what
         makes "push forward = go forward" instead of "push forward =
         climb," which is the DJI-style behaviour.
         ============================================================ */
      const em = this._easyPreset();
      const maxClimb   = em.maxClimbRate   != null ? em.maxClimbRate   : 6.0;
      const maxDescend = em.maxDescendRate != null ? em.maxDescendRate : 8.0;
      const altGain    = (CFG.easyMode.altGain != null ? CFG.easyMode.altGain : 3.0);

      const tAbove = Math.max(0, thr - 0.5);
      const tBelow = Math.max(0, 0.5 - thr);
      const vzCmd  = tAbove * 2 * maxClimb - tBelow * 2 * maxDescend;

      const vzErr = vzCmd - this.velocity.y;
      const azCmd = altGain * vzErr;

      // Thrust needed so that (thrust * up.y / mass) - gravity = azCmd.
      // up.y is clamped to avoid blow-up if momentarily inverted.
      const upY = Math.max(0.3, this._up.y);
      const thrustNeeded = (azCmd + CFG.gravity) / upY * CFG.mass;
      const effThrust = Math.max(0, Math.min(CFG.maxThrust, thrustNeeded));

      acc.copy(this._up).multiplyScalar(effThrust / CFG.mass);
      acc.y -= CFG.gravity;
    } else {
      /* ===== ACRO MODE (unchanged) ==================================== */
      acc.copy(this._up).multiplyScalar(thr * CFG.maxThrust / CFG.mass);
      acc.y -= CFG.gravity;
    }

    /* ===== wind ====================================================
       Applied uniformly in both flight modes. Horizontal push makes
       the drone drift and forces a lean to hold position; gusty adds
       oscillation on top. Drag (below) damps the resulting velocity.
       Suppressed while grounded — a landed quad doesn't slide across
       the pad in a breeze. Only affects BREEZY/GUSTY (CALM is 0 anyway). */
    if ((this._groundedTime || 0) <= 0 && CFG.wind && CFG.windPreset) {
      const wp = CFG.wind[CFG.windPreset];
      if (wp) {
        let wx = wp.x || 0, wy = wp.y || 0, wz = wp.z || 0;
        const gust = wp.gust || 0;
        if (gust > 0) {
          const t = this._windTime;
          wx += Math.sin(t * 0.7) * gust * 1.2 + Math.sin(t * 1.9) * gust * 0.4;
          wy += Math.sin(t * 1.3) * gust * 0.35;
          wz += Math.cos(t * 0.9) * gust * 1.0 + Math.sin(t * 2.3) * gust * 0.35;
        }
        acc.x += wx;
        acc.y += wy;
        acc.z += wz;
      }
    }

    const speed = this.velocity.length();
    if (speed > 1e-5) {
      const k = CFG.dragLinear + CFG.dragQuadratic * speed;
      acc.addScaledVector(this.velocity, -k);
    }

    /* ---- windmill / air-brake drag at low throttle ---- */
    /* Windmill brake — acro only. In easy mode, the alt-hold controller
       already manages vertical velocity; adding drag here would cause it
       to fight the controller and slow commanded descents. */
    if (!easyActive && thr < 0.15 && speed > 3) {
      const wmCoeff = CFG.windmillBrake != null ? CFG.windmillBrake : 0.15;
      const windmill = (1 - thr / 0.15) * wmCoeff;
      acc.addScaledVector(this.velocity, -windmill);
    }

    this.velocity.addScaledVector(acc, dt);
    this.position.addScaledVector(this.velocity, dt);

    this._collide();

    /* ---- battery: LiPo curve + current sag w/ RC smoothing ---- */
    const current = Math.pow(thr, 1.4) * CFG.battery.maxCurrent;
    this.mahUsed += current * dt / 3.6;

    const soc = Math.max(0, 1 - this.mahUsed / CFG.battery.capacityMah);
    let restCell;
    if (soc > 0.5)      restCell = 3.85 + (soc - 0.5) * 0.70;
    else if (soc > 0.1) restCell = 3.70 + (soc - 0.1) * 0.375;
    else                restCell = 3.00 + soc * 7.00;

    this._smoothCurrent = this._smoothCurrent * 0.85 + current * 0.15;
    const Rpack = 0.008 * CFG.battery.cells;
    this.voltage = Math.max(
      3.0 * CFG.battery.cells,
      CFG.battery.cells * restCell - this._smoothCurrent * Rpack);
  };

  Drone.prototype._disposeBVH = function() {
  if (this.collisionGeom) {
    if (typeof this.collisionGeom.disposeBoundsTree === 'function') {
      this.collisionGeom.disposeBoundsTree();
    }
    this.collisionGeom.dispose();
  }
  this.collisionGeom = null;
  this.collisionBVH = null;
  this._bvhColliderCount = 0;
  this._bvhLogCount = 0;
  if (typeof window !== 'undefined') window.__bvh = null;
};

Drone.prototype._ensureBVH = function() {
  if (this._bvhFailed) return;
  if (this._bvhBuilding) return;
  if (typeof THREE === 'undefined') return;

  var hasExt = (typeof THREE.BufferGeometry.prototype.computeBoundsTree === 'function');
  var hasLib = (typeof window !== 'undefined'
                && window.MeshBVHLib
                && typeof window.MeshBVHLib.MeshBVH === 'function');

  if (!hasExt && !hasLib) {
    if (typeof window !== 'undefined' && !window.__bvhScriptRequested) {
      window.__bvhScriptRequested = true;
      var s = document.createElement('script');
      s.src = 'js/three-mesh-bvh.umd.js';
      s.onload = function() {
        console.log('[BVH] three-mesh-bvh.umd.js loaded dynamically');
        if (window.__drone) window.__drone._bvhFailed = false;
      };
      s.onerror = function() {
        console.warn('[BVH] failed to load three-mesh-bvh.umd.js');
        if (window.__drone) window.__drone._bvhFailed = true;
      };
      document.head.appendChild(s);
      console.log('[BVH] injected three-mesh-bvh.umd.js (dynamic)');
    }
    return;
  }

  if (!hasExt && hasLib) {
    var lib = window.MeshBVHLib;
    if (typeof lib.computeBoundsTree === 'function') {
      THREE.BufferGeometry.prototype.computeBoundsTree = lib.computeBoundsTree;
      if (typeof lib.disposeBoundsTree === 'function') {
        THREE.BufferGeometry.prototype.disposeBoundsTree = lib.disposeBoundsTree;
      }
    } else {
      this._bvhFailed = true;
      console.warn('[BVH] library loaded but computeBoundsTree not exported');
      return;
    }
  }

  var cols = this.colliders || (window.__world && window.__world.colliders) || null;
  if (!cols || cols.length === 0) {
    // If we had a BVH from a previously-loaded map, dispose it — otherwise
    // _collide() keeps using stale triangles against a world that no
    // longer has any colliders.
    if (this.collisionBVH) {
      console.log('[BVH] no colliders — disposing stale BVH');
      this._disposeBVH();
    }
    return;
  }

  // Only imported maps get a BVH. Procedural world keeps its accurate
  // cylinder/box colliders + getFloorY snap in the original AABB path.
  var BVH_MIN_COLLIDERS = 500;
  if (cols.length < BVH_MIN_COLLIDERS) {
    // Procedural world — falls through to the AABB path in _collide().
    // Critically, we must dispose any BVH left over from a previously
    // loaded map, otherwise _collide() sees collisionBVH truthy and
    // uses stale triangles against the procedural world.
    if (this.collisionBVH) {
      console.log('[BVH] colliders dropped below ' + BVH_MIN_COLLIDERS +
                  ' (now ' + cols.length + ') — disposing stale BVH, ' +
                  'using AABB path');
      this._disposeBVH();
    }
    return;
  }

  var colSrc = (this.colliders === cols) ? 'drone' : 'world';

  // Already built with the current collider count → nothing to do
  if (this.collisionBVH && this._bvhColliderCount === cols.length) return;

  // Colliders changed since last build (map imported) → dispose + rebuild
  if (this.collisionBVH) {
    console.log('[BVH] colliders changed:', this._bvhColliderCount, '->', cols.length, '- rebuilding');
    this._disposeBVH();
  }

  var scene = (window.__scene) || this.scene || null;
  if (!scene) { console.warn('[BVH] no scene reference'); return; }

  this._bvhBuilding = true;
  try {
    var meshes = [];
    scene.traverse(function(obj) {
      if (!obj.isMesh || !obj.geometry) return;
      if (!obj.geometry.attributes || !obj.geometry.attributes.position) return;
      var name = obj.name || '';
      if (/drone|sky|camera|helper|marker|trigger|spawn/i.test(name)) return;
      if (obj.geometry.boundingBox === null) obj.geometry.computeBoundingBox();
      var bb = obj.geometry.boundingBox;
      if (!bb) return;
      var sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
      if (sx > 2000 || sy > 2000 || sz > 2000) return;
      meshes.push(obj);
    });

    if (meshes.length === 0) {
      console.warn('[BVH] no candidate meshes');
      return;
    }

    var totalVerts = 0, totalIndices = 0;
    for (var mi = 0; mi < meshes.length; mi++) {
      var g = meshes[mi].geometry;
      totalVerts += g.attributes.position.count;
      totalIndices += g.index ? g.index.count : g.attributes.position.count;
    }

    var positions = new Float32Array(totalVerts * 3);
    var indices = new Uint32Array(totalIndices);
    var vOff = 0, iOff = 0;
    var tmp = new THREE.Vector3();

    for (var mj = 0; mj < meshes.length; mj++) {
      var mesh = meshes[mj];
      mesh.updateWorldMatrix(true, false);
      var mtx = mesh.matrixWorld;
      var pos = mesh.geometry.attributes.position;
      for (var i = 0; i < pos.count; i++) {
        tmp.fromBufferAttribute(pos, i).applyMatrix4(mtx);
        positions[(vOff + i) * 3]     = tmp.x;
        positions[(vOff + i) * 3 + 1] = tmp.y;
        positions[(vOff + i) * 3 + 2] = tmp.z;
      }
      var idx = mesh.geometry.index;
      if (idx) {
        for (var k = 0; k < idx.count; k++) indices[iOff + k] = idx.getX(k) + vOff;
        iOff += idx.count;
      } else {
        for (var k2 = 0; k2 < pos.count; k2++) indices[iOff + k2] = vOff + k2;
        iOff += pos.count;
      }
      vOff += pos.count;
    }

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    var t0 = performance.now();
    geom.computeBoundsTree();
    var dt = (performance.now() - t0).toFixed(0);

    geom.computeBoundingBox();
    var _bb = geom.boundingBox;

    this.collisionGeom = geom;
    this.collisionBVH = geom.boundsTree;
    this._bvhColliderCount = cols.length;
    window.__bvh = this.collisionBVH;

    console.log('[BVH] built:', meshes.length, 'meshes,', (totalIndices / 3 | 0), 'tris in', dt + 'ms');
    console.log('[BVH] colliders:', cols.length, 'from', colSrc);
    if (_bb) {
      console.log('[BVH] bounds:',
        _bb.min.x.toFixed(1), _bb.min.y.toFixed(1), _bb.min.z.toFixed(1), '..',
        _bb.max.x.toFixed(1), _bb.max.y.toFixed(1), _bb.max.z.toFixed(1));
    }
    console.log('[BVH] drone local:',
      this.position.x.toFixed(1), this.position.y.toFixed(1), this.position.z.toFixed(1));
    if (typeof this.getWorldPosition === 'function') {
      var _wp = new THREE.Vector3();
      this.getWorldPosition(_wp);
      console.log('[BVH] drone world:', _wp.x.toFixed(1), _wp.y.toFixed(1), _wp.z.toFixed(1));
    }
  } catch (e) {
    this._bvhFailed = true;
    console.warn('[BVH] build failed:', e && e.message);
  } finally {
    this._bvhBuilding = false;
  }
};

Drone.prototype._collideBVH = function() {
  var bvh = this.collisionBVH;
  if (!bvh) return;

  if (!this._bvhSphere) {
    this._bvhSphere   = new THREE.Sphere();
    this._bvhClosest  = new THREE.Vector3();
    this._bvhNormal   = new THREE.Vector3();
    this._bvhWorldPos = new THREE.Vector3();
    this._bvhLogCount = 0;
  }
  var sphere   = this._bvhSphere;
  var closest  = this._bvhClosest;
  var normal   = this._bvhNormal;
  var worldPos = this._bvhWorldPos;

  // Query in WORLD space to match the baked BVH geometry.
  if (typeof this.getWorldPosition === 'function') {
    this.getWorldPosition(worldPos);
  } else {
    worldPos.copy(this.position);
  }

  sphere.center.copy(worldPos);
  sphere.radius = 0.22;

  var hit = false;

  bvh.shapecast({
    intersectsBounds: function(box) {
      var cx = Math.max(box.min.x, Math.min(sphere.center.x, box.max.x));
      var cy = Math.max(box.min.y, Math.min(sphere.center.y, box.max.y));
      var cz = Math.max(box.min.z, Math.min(sphere.center.z, box.max.z));
      var dx = cx - sphere.center.x, dy = cy - sphere.center.y, dz = cz - sphere.center.z;
      return (dx*dx + dy*dy + dz*dz) <= sphere.radius * sphere.radius;
    },
    intersectsTriangle: function(tri) {
      if (typeof tri.closestPointToPoint === 'function') {
        tri.closestPointToPoint(sphere.center, closest);
        var d2 = closest.distanceToSquared(sphere.center);
        if (d2 < sphere.radius * sphere.radius) {
          hit = true;
          return true;
        }
      }
      return false;
    }
  });

  if (this._bvhLogCount < 3) {
    console.log('[BVH collide]', hit ? 'HIT' : 'miss',
      'world:', worldPos.x.toFixed(2), worldPos.y.toFixed(2), worldPos.z.toFixed(2),
      'local:', this.position.x.toFixed(2), this.position.y.toFixed(2), this.position.z.toFixed(2),
      hit ? ('closest: ' + closest.x.toFixed(2) + ',' + closest.y.toFixed(2) + ',' + closest.z.toFixed(2)) : '');
    this._bvhLogCount++;
  }

  if (!hit) return;

  // Depenetrate: closest lies on the overlapping triangle surface.
  normal.copy(sphere.center).sub(closest);
  var dist = normal.length();
  if (dist < 1e-5) {
    normal.set(0, 1, 0);
    dist = 0.001;
  } else {
    normal.divideScalar(dist);
  }
  var depth = sphere.radius - dist;

  // Ground contact for wind gating. Two independent signals:
  //  1. Surface normal points up (flat floor, bridge deck, roof).
  //  2. Closest contact point is well below the sphere center — catches
  //     edges/corners where the winning triangle might be tilted and
  //     normal.y is unreliable (intersectsTriangle stops at first hit,
  //     so `closest` may be on a ramp rather than the flat floor).
  // Both refresh this._groundedTime to 0.15s. The wind gate in step()
  // reads that timer — without the window, tiny penetration gaps between
  // BVH collision frames let wind apply on the "in-between" frames and
  // the drone creeps across the surface (the actual reported symptom).
  var _isFloor = (normal.y > 0.4) ||
                 (closest.y < sphere.center.y - 0.1);
  if (_isFloor) {
    this._grounded = true;
    this._groundedTime = 0.15;
    // Friction: kill horizontal velocity accumulated during penetration
    // gaps (and any gust spikes that made it through). Mirrors the
    // AABB floor-snap damping of 0.82/0.85.
    if (this.velocity) {
      this.velocity.x *= 0.85;
      this.velocity.z *= 0.85;
    }
  }

  // Push out (in world delta, applied to local position — safe if parent
  // has no rotation/scale, which is the standard drone-in-scene setup).
  this.position.addScaledVector(normal, depth + 0.001);

  var vel = this.velocity || this.vel;
  if (vel) {
    var vn = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
    if (vn < 0) {
      vel.x -= normal.x * vn;
      vel.y -= normal.y * vn;
      vel.z -= normal.z * vn;
      if (this.armed) {
        var impact = -vn;
        var cfg = (window.CONFIG) || (typeof CONFIG !== 'undefined' ? CONFIG : {}) || {};
        var crashSpd = cfg.crashSpeed || 7.0;
        var hitSpd   = cfg.hitSpeed   || 6.0;
        if ((normal.y > 0.6 && impact > crashSpd) || impact > hitSpd) {
          if (typeof this._crash === 'function') this._crash();
          else if (typeof this.crash === 'function') this.crash();
        }
      }
    }
  }
};

Drone.prototype._collide = function() {
  this._grounded = false;
  this._ensureBVH();
  if (this.collisionBVH) {
    // Respawn if far below world
    if (this.position.y < -50 && this.armed) {
      if (typeof this._respawn === 'function') this._respawn();
      else if (typeof this.respawn === 'function') this.respawn();
      else if (typeof this.reset === 'function') this.reset();
      return;
    }
    // BVH triangles are the sole source of truth (mesh ground included)
    this._collideBVH();
    return;
  }

    const floor = this.getFloorY(this.position.x, this.position.z);

    if (this.position.y < floor) {
      const vyImpact = -this.velocity.y;
      const depth = floor - this.position.y;

      this.position.y = floor;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.velocity.x *= 0.82;
      this.velocity.z *= 0.82;
      this._grounded = true;
      this._groundedTime = 0.15;

      if (this.armed && (vyImpact > CFG.crashSpeed || depth > (CFG.depthCrash || 1.5))) {
        this.crash();
      }
    }

    const cols = this.colliderIndex
      ? this.colliderIndex.query(this.position.x, this.position.z)
      : this.colliders;
    const py = this.position.y;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.type === 'box') this._collideBox(c);
      else {
        if (py > c.h) continue;
        if (c.yMin !== undefined && py < c.yMin) continue;
        this._collideCyl(c);
      }
    }
  };

  Drone.prototype._collideCyl = function (c) {
    const dx = this.position.x - c.x;
    const dz = this.position.z - c.z;
    const rr = c.r + 0.18;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return;

    const d = Math.sqrt(d2) || 1e-4;
    const nx = dx / d, nz = dz / d;
    this.position.x = c.x + nx * rr;
    this.position.z = c.z + nz * rr;

    const vn = this.velocity.x * nx + this.velocity.z * nz;
    if (vn < 0) {
      this.velocity.x -= vn * nx * 1.35;
      this.velocity.z -= vn * nz * 1.35;
      if (this.armed && -vn > CFG.hitSpeed) this.crash();
    }
  };

  Drone.prototype._collideBox = function (c) {
    const cs = c.cos, sn = c.sin;
    const dx = this.position.x - c.x;
    const dz = this.position.z - c.z;
    const lx = dx * cs - dz * sn;
    const lz = dx * sn + dz * cs;
    const hw = c.w * 0.5 + 0.18;
    const hd = c.d * 0.5 + 0.18;

    if (lx < -hw || lx > hw || lz < -hd || lz > hd) return;

    if (this.position.y >= c.h) {
      if (this.position.y < c.h + CFG.groundY && this.velocity.y < 0) {
        this.position.y = c.h + CFG.groundY;
        if (this.velocity.y < 0) {
          const impact = -this.velocity.y;
          this.velocity.y = 0;
          this.velocity.x *= 0.85;
          this.velocity.z *= 0.85;
          this._grounded = true;
          this._groundedTime = 0.15;
          if (this.armed && impact > CFG.crashSpeed) this.crash();
        }
      }
      return;
    }

    if (this.position.y < (c.yMin || 0)) return;

    const penX = hw - Math.abs(lx);
    const penZ = hd - Math.abs(lz);
    let nLx = 0, nLz = 0, push;
    if (penX < penZ) { nLx = lx >= 0 ? 1 : -1; push = penX; }
    else             { nLz = lz >= 0 ? 1 : -1; push = penZ; }

    const nx =  nLx * cs + nLz * sn;
    const nz = -nLx * sn + nLz * cs;
    this.position.x += nx * (push + 0.01);
    this.position.z += nz * (push + 0.01);

    const vn = this.velocity.x * nx + this.velocity.z * nz;
    if (vn < 0) {
      this.velocity.x -= vn * nx * 1.35;
      this.velocity.z -= vn * nz * 1.35;
      if (this.armed && -vn > CFG.hitSpeed) this.crash();
    }
  };

  return Drone;
})();
