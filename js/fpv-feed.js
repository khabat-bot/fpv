/* =========================================================================
   fpv-feed.js — FPV video feed realism (VTX link emulation).

   The clean 3D render is what the pilot "sees" through the goggles, so this
   module sits between the camera and the canvas:

     * Feed latency — every camera pose is pushed into a short ring buffer
       and the renderer samples it `latencyMs` in the past, interpolating
       between the two bracketing poses (same trick mp.js uses for remote
       drones). Sim input, physics and HUD all stay current; only the
       picture lags, exactly like a real analogue link.
     * Signal model — link quality falls off with distance from the ground
       station (the spawn pad) and with obstructions. Obstruction tests use
       the drone's BVH on imported maps (one ray per sample interval), and
       the procedural world's analytic cylinder/box colliders otherwise.
     * Video artefacts — a full-screen composite pass adds barrel lens
       distortion, chromatic fringing, scanlines, sensor grain, analogue
       noise that grows as the link weakens, horizontal tearing bursts and
       a full static replacement when the link is lost.

   Public API:
     FPVFeed.init(renderer)
     FPVFeed.configure({ enabled, latencyMs, link, lens })
     FPVFeed.frame(dt, now, camera, mode, drone, world)
     FPVFeed.render(renderer, scene, camera)
     FPVFeed.wantsPost()
     FPVFeed.resize()
     FPVFeed.reset()
   ========================================================================= */
'use strict';

window.FPVFeed = (function () {

  var cfg = (window.CFG && CFG.fpvFeed) ? CFG.fpvFeed
    : {
        latencyMs: 50,
        fullSignalRange: 260,
        maxRange: 900,
        obstructionAttenuation: 0.8,
        raycastHz: 8,
        signalSmoothMs: 220,
        lossThreshold: 0.12,
        lossHoldMs: 350
      };

  /* ------------------------------ state ------------------------------- */
  var enabled = true;
  var latencyMs = cfg.latencyMs;
  var linkSim = true;
  var lensOn = true;

  var postActive = false;
  var signal = 1;
  var targetSignal = 1;
  var blocked = 0;          // smoothed 0..1 obstruction amount
  var blockedTarget = 0;
  var lastRayAt = 0;
  var lastSignalAt = 0;
  var artifact = 0;         // 0..1 tearing burst strength
  var staticAmt = 0;        // 0..1 full-loss static
  var lossSince = 0;
  var lossShown = false;

  var poseBuf = [];
  var MAX_POSE_MS = 600;

  var rendererRef = null;
  var rt = null, rtW = 0, rtH = 0;
  var quadScene = null, quadCam = null, quadMat = null;
  var lossEl = null;

  /* reused temporaries — no per-frame allocation in the hot paths */
  var _ray = null;
  var _dir = new THREE.Vector3();
  var _rx = new THREE.Vector3();
  var _tv = new THREE.Vector3();

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* --------------------------- post-process --------------------------- */
  var VERT = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform float uNoise;',
    'uniform float uStatic;',
    'uniform float uArtifact;',
    'uniform float uLens;',
    'varying vec2 vUv;',
    '',
    'float hash(vec2 p) {',
    '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
    '}',
    '',
    'void main() {',
    '  vec2 c = vUv - 0.5;',
    '  float r2 = dot(c, c);',
    '  vec2 uv = vUv;',
    '',
    '  /* barrel lens distortion (CMOS lens) */',
    '  float k = 0.20 * uLens;',
    '  uv = 0.5 + c * (1.0 + k * r2) * (1.0 - k * 0.30);',
    '',
    '  /* horizontal tearing / sync slips on a weak link */',
    '  float bandRow = floor(uv.y * 110.0);',
    '  float band = step(0.994 - uArtifact * 0.05, hash(vec2(bandRow, floor(uTime * 18.0))));',
    '  uv.x += band * (hash(vec2(bandRow, 7.3)) - 0.5) * 0.07 * uArtifact;',
    '',
    '  /* chromatic fringing grows toward the edges */',
    '  float ca = (0.0010 + 0.0035 * r2) * (1.0 + uArtifact * 2.5 + uNoise * 1.2);',
    '  vec3 col;',
    '  col.r = texture2D(tDiffuse, uv + vec2(ca, 0.0)).r;',
    '  col.g = texture2D(tDiffuse, uv).g;',
    '  col.b = texture2D(tDiffuse, uv - vec2(ca, 0.0)).b;',
    '',
    '  /* outside the lens circle the sensor sees black */',
    '  vec2 edge = step(vec2(0.0), uv) * step(uv, vec2(1.0));',
    '  col *= edge.x * edge.y;',
    '',
    '  /* scanlines */',
    '  float sl = 0.90 + 0.10 * sin(vUv.y * uRes.y * 1.6);',
    '  col *= sl;',
    '',
    '  /* camera colour grade: slight desaturation + contrast */',
    '  float lum = dot(col, vec3(0.299, 0.587, 0.114));',
    '  col = mix(vec3(lum), col, 0.88);',
    '  col = clamp((col - 0.5) * 1.06 + 0.5, 0.0, 1.0);',
    '',
    '  /* sensor grain */',
    '  float g = hash(vUv * uRes + vec2(uTime * 137.0, uTime * 61.0));',
    '  col += (g - 0.5) * 0.022;',
    '',
    '  /* analogue noise: coloured blotches that thicken as the link drops */',
    '  vec2 np = floor(uv * uRes * 0.6) + vec2(uTime * 83.0, uTime * 47.0);',
    '  float n1 = hash(np);',
    '  float n2 = hash(np.yx + 19.7);',
    '  col += vec3(n1, n2, n1) * uNoise * 0.42;',
    '',
    '  /* rolling interference bar */',
    '  float roll = fract(vUv.y * 0.7 - uTime * 0.55);',
    '  col *= 1.0 - smoothstep(0.045, 0.0, roll) * uNoise * 0.35;',
    '',
    '  /* full signal loss: snow replacement */',
    '  float s = hash(floor(vUv * uRes * 0.4) + vec2(floor(uTime * 72.0) * 3.7,',
    '                                                 floor(uTime * 43.0) * 1.9));',
    '  vec3 snow = vec3(s) * 0.85 + vec3(0.06, 0.07, 0.08);',
    '  col = mix(col, snow, clamp(uStatic, 0.0, 1.0));',
    '',
    '  /* goggles vignette */',
    '  col *= 1.0 - 0.38 * smoothstep(0.22, 0.95, r2 * 1.45);',
    '',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function init(renderer) {
    if (!renderer || quadScene) return;
    rendererRef = renderer;

    quadScene = new THREE.Scene();
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:  { value: null },
        uRes:      { value: new THREE.Vector2(1, 1) },
        uTime:     { value: 0 },
        uNoise:    { value: 0 },
        uStatic:   { value: 0 },
        uArtifact: { value: 0 },
        uLens:     { value: 1 }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false
    });
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
    quad.frustumCulled = false;
    quadScene.add(quad);

    if (!_ray && THREE.Raycaster) _ray = new THREE.Raycaster();
    lossEl = document.getElementById('fpv-no-signal');
  }

  function ensureRenderTarget(renderer) {
    var el = renderer.domElement;
    var w = Math.max(2, el.width | 0);
    var h = Math.max(2, el.height | 0);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        depthBuffer: true,
        stencilBuffer: false
      });
      rtW = w; rtH = h;
      return;
    }
    if (w !== rtW || h !== rtH) {
      rt.setSize(w, h);
      rtW = w; rtH = h;
    }
  }

  function wantsPost() { return postActive; }

  function render(renderer, scene, camera) {
    if (!quadScene) { renderer.render(scene, camera); return; }
    if (!rendererRef) rendererRef = renderer;
    ensureRenderTarget(renderer);

    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    var now = performance.now() / 1000;
    var u = quadMat.uniforms;
    u.tDiffuse.value = rt.texture;
    u.uRes.value.set(rtW, rtH);
    u.uTime.value = now;
    u.uNoise.value = clamp(1 - signal, 0, 1) * 0.9;
    u.uStatic.value = staticAmt;
    u.uArtifact.value = artifact;
    u.uLens.value = lensOn ? 1 : 0;

    renderer.render(quadScene, quadCam);
  }

  /* --------------------------- pose buffer ---------------------------- */
  function pushPose(now, camera) {
    poseBuf.push({
      t: now,
      p: camera.position.clone(),
      q: camera.quaternion.clone()
    });
    while (poseBuf.length > 2 && poseBuf[0].t < now - MAX_POSE_MS) poseBuf.shift();
  }

  function applyDelayedPose(now, camera) {
    var n = poseBuf.length;
    if (!n) return;
    var t = now - latencyMs;

    if (t <= poseBuf[0].t || n === 1) {
      camera.position.copy(poseBuf[0].p);
      camera.quaternion.copy(poseBuf[0].q);
      return;
    }
    var last = poseBuf[n - 1];
    if (t >= last.t) {
      camera.position.copy(last.p);
      camera.quaternion.copy(last.q);
      return;
    }
    for (var i = n - 1; i > 0; i--) {
      var a = poseBuf[i - 1], b = poseBuf[i];
      if (a.t <= t && t <= b.t) {
        var alpha = (t - a.t) / Math.max(1, b.t - a.t);
        camera.position.copy(a.p).lerp(b.p, alpha);
        camera.quaternion.copy(a.q).slerp(b.q, alpha);
        return;
      }
    }
  }

  /* --------------------------- signal model --------------------------- */
  function receiverPos(world) {
    var spawn = (world && world.spawn) ? world.spawn : { x: 0, z: 0 };
    var y = 0;
    if (world && typeof world.heightAt === 'function') {
      var h = world.heightAt(spawn.x, spawn.z);
      if (isFinite(h)) y = h;
    }
    _rx.set(spawn.x, y + 1.2, spawn.z);
    return _rx;
  }

  /* Segment (a→b) vs the procedural world's analytic colliders. */
  function segmentBlockedByColliders(a, b, colliders) {
    if (!colliders || !colliders.length) return false;
    for (var i = 0; i < colliders.length; i++) {
      var col = colliders[i];
      var yMin = col.yMin || 0;
      var yMax = col.h;
      if (!(yMax > yMin)) continue;

      if (col.type === 'box') {
        /* rotate the segment into box space, then a plain AABB slab test */
        var cos = col.cos, sin = col.sin;
        var ax = a.x - col.x, az = a.z - col.z;
        var bx = b.x - col.x, bz = b.z - col.z;
        var lax = ax * cos - az * sin, laz = ax * sin + az * cos;
        var lbx = bx * cos - bz * sin, lbz = bx * sin + bz * cos;
        var hw = col.w * 0.5, hd = col.d * 0.5;
        if (segAABB(lax, a.y, laz, lbx, b.y, lbz,
                    -hw, yMin, -hd, hw, yMax, hd)) return true;
      } else {
        /* vertical cylinder: 2D quadratic in XZ, then a Y range check */
        var dx = b.x - a.x, dz = b.z - a.z;
        var fx = a.x - col.x, fz = a.z - col.z;
        var A = dx * dx + dz * dz;
        var B = 2 * (fx * dx + fz * dz);
        var C = fx * fx + fz * fz - col.r * col.r;
        var tHit = -1;
        if (A < 1e-8) {
          if (C <= 0) tHit = 0;
        } else {
          var disc = B * B - 4 * A * C;
          if (disc >= 0) {
            var sq = Math.sqrt(disc);
            var t0 = (-B - sq) / (2 * A);
            var t1 = (-B + sq) / (2 * A);
            if (t0 >= 0 && t0 <= 1) tHit = t0;
            else if (t1 >= 0 && t1 <= 1) tHit = t1;
            else if (t0 < 0 && t1 > 1) tHit = 0;
          }
        }
        if (tHit >= 0) {
          var y = a.y + (b.y - a.y) * tHit;
          if (y >= yMin && y <= yMax) return true;
        }
      }
    }
    return false;
  }

  function segAABB(ax, ay, az, bx, by, bz,
                   minx, miny, minz, maxx, maxy, maxz) {
    var t0 = 0, t1 = 1;
    var d = [bx - ax, by - ay, bz - az];
    var o = [ax, ay, az];
    var mn = [minx, miny, minz];
    var mx = [maxx, maxy, maxz];
    for (var i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-8) {
        if (o[i] < mn[i] || o[i] > mx[i]) return false;
      } else {
        var inv = 1 / d[i];
        var ta = (mn[i] - o[i]) * inv;
        var tb = (mx[i] - o[i]) * inv;
        if (ta > tb) { var sw = ta; ta = tb; tb = sw; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return false;
      }
    }
    return true;
  }

  function isBlocked(a, b, drone, world) {
    var bvh = drone && drone.collisionBVH;
    if (bvh && _ray) {
      try {
        _dir.copy(b).sub(a);
        var len = _dir.length();
        if (len < 0.5) return false;
        _dir.multiplyScalar(1 / len);
        _ray.set(a, _dir);
        _ray.near = 0.3;
        _ray.far = len - 0.3;
        var hits = bvh.raycast(_ray.ray, THREE.DoubleSide);
        return !!(hits && hits.length);
      } catch (e) {
        /* fall through to the analytic path */
      }
    }
    if (world && world.colliders) {
      return segmentBlockedByColliders(a, b, world.colliders);
    }
    return false;
  }

  function setLossOverlay(on) {
    if (on === lossShown) return;
    lossShown = on;
    if (!lossEl) lossEl = document.getElementById('fpv-no-signal');
    if (!lossEl) return;
    lossEl.classList.toggle('hidden', !on);
  }

  function updateSignal(dt, now, camera, drone, world) {
    if (!linkSim) {
      targetSignal = 1;
      blockedTarget = 0;
    } else {
      var rx = receiverPos(world);
      var d = camera.position.distanceTo(rx);
      var full = cfg.fullSignalRange;
      var max = cfg.maxRange;
      var free = 1 - smoothstep(full, max, d);

      if (now - lastRayAt > (1000 / Math.max(1, cfg.raycastHz))) {
        lastRayAt = now;
        _tv.copy(camera.position);
        blockedTarget = isBlocked(rx, _tv, drone, world) ? 1 : 0;
      }
      blocked += (blockedTarget - blocked) * clamp(dt * 6, 0, 1);
      targetSignal = free * (1 - cfg.obstructionAttenuation * blocked);
    }

    var k = 1 - Math.exp(-dt * (1000 / Math.max(1, cfg.signalSmoothMs)));
    signal += (targetSignal - signal) * k;
    signal = clamp(signal, 0, 1);

    /* random tearing bursts — frequent on a marginal link, rare when clean */
    var weakness = 1 - signal;
    if (weakness > 0.12 && Math.random() < weakness * dt * 9) artifact = 1;
    artifact = Math.max(0, artifact - dt * 3.2);

    /* full loss latches after a short hold so a single bad frame is not one */
    if (signal < cfg.lossThreshold) {
      if (!lossSince) lossSince = now;
      if (now - lossSince > cfg.lossHoldMs) {
        staticAmt = Math.min(1, staticAmt + dt * 6);
      }
    } else {
      lossSince = 0;
      staticAmt = Math.max(0, staticAmt - dt * 4);
    }
    setLossOverlay(staticAmt > 0.55);
  }

  /* ------------------------------ frame ------------------------------- */
  function frame(dt, now, camera, mode, drone, world) {
    postActive = false;
    if (!enabled) {
      poseBuf.length = 0;
      if (staticAmt !== 0) { staticAmt = 0; setLossOverlay(false); }
      return;
    }
    if (mode !== 'FPV') {
      poseBuf.length = 0;
      signal = 1;
      targetSignal = 1;
      blocked = 0;
      artifact = 0;
      if (staticAmt !== 0) { staticAmt = 0; setLossOverlay(false); }
      return;
    }

    if (!lastSignalAt) lastSignalAt = now;
    var sdt = Math.min(0.1, dt || (now - lastSignalAt) / 1000);
    lastSignalAt = now;
    if (sdt > 0) updateSignal(sdt, now, camera, drone, world);

    pushPose(now, camera);
    if (latencyMs > 0) applyDelayedPose(now, camera);

    postActive = true;
  }

  function configure(opts) {
    if (!opts) return;
    if (typeof opts.enabled === 'boolean') enabled = opts.enabled;
    if (typeof opts.latencyMs === 'number') latencyMs = clamp(opts.latencyMs, 0, 300);
    if (typeof opts.link === 'boolean') linkSim = opts.link;
    if (typeof opts.lens === 'boolean') lensOn = opts.lens;
    if (!enabled) reset();
  }

  function reset() {
    poseBuf.length = 0;
    signal = 1;
    targetSignal = 1;
    blocked = 0;
    blockedTarget = 0;
    artifact = 0;
    staticAmt = 0;
    lossSince = 0;
    lastSignalAt = 0;
    postActive = false;
    setLossOverlay(false);
  }

  function resize() {
    if (rt && rendererRef) {
      var el = rendererRef.domElement;
      var w = Math.max(2, el.width | 0);
      var h = Math.max(2, el.height | 0);
      if (w !== rtW || h !== rtH) {
        rt.setSize(w, h);
        rtW = w; rtH = h;
      }
    }
  }

  return {
    init: init,
    frame: frame,
    render: render,
    wantsPost: wantsPost,
    configure: configure,
    resize: resize,
    reset: reset,
    /* exposed for the HUD / debugging */
    getSignal: function () { return signal; },
    isEnabled: function () { return enabled; },
    getLatency: function () { return latencyMs; }
  };
})();
