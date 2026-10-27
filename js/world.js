/* =========================================================================
   world.js — procedural default scenery.

   Much more like a real FPV sim than a flat track:
     • rolling terrain (analytic height function, flat only at spawn)
     • distant low-poly mountain ring, half-lost in the haze
     • clustered forest instead of a uniform ring
     • three bando-style ruined building shells to fly through
     • concrete race gates around a central pylon
     • warm afternoon sun, atmospheric fog, gradient sky

   The world returns a `heightAt(x, z)` function so the drone can land
   on hills — and so a loaded GLB map can override it transparently.
   ========================================================================= */
'use strict';

window.World = (function () {

  /* ------------------------------------------------------------------ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Analytic terrain: a sum of sine waves with a flattened disk at spawn. */
  function heightAt(x, z) {
    let h = 0;
    h += Math.sin(x * 0.0055) * Math.cos(z * 0.0062) * 12;
    h += Math.sin(x * 0.013 + 1.3) * Math.cos(z * 0.011 + 0.7) * 5;
    h += Math.sin(x * 0.028 + 2.1) * Math.cos(z * 0.025 + 1.9) * 2.0;
    /* flatten a ~30 m disk around spawn so the pad is always level */
    const d = Math.hypot(x, z);
    const flat = Math.min(1, Math.max(0, (d - 30) / 55));
    return h * flat;
  }

  /* ------------------------------------------------------------------ */
  function groundTexture() {
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');

    g.fillStyle = '#4a7a3e';
    g.fillRect(0, 0, S, S);

    /* mowing stripes */
    const stripes = 4, sh = S / stripes;
    for (let s = 0; s < stripes; s += 2) {
      g.fillStyle = 'rgba(30, 70, 30, 0.32)';
      g.fillRect(0, s * sh, S, sh);
    }

    /* speckle */
    for (let i = 0; i < 14000; i++) {
      const w = Math.random() < 0.5;
      g.fillStyle = w ? 'rgba(255,255,255,0.030)' : 'rgba(0,0,0,0.045)';
      g.fillRect(Math.random() * S, Math.random() * S,
                 Math.random() * 2 + 0.5, Math.random() * 2 + 0.5);
    }

    /* dry patches */
    for (let i = 0; i < 10; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      const r = 40 + Math.random() * 80;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0,   'rgba(110, 85, 55, 0.32)');
      grd.addColorStop(0.6, 'rgba(110, 85, 55, 0.12)');
      grd.addColorStop(1,   'rgba(110, 85, 55, 0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  /* ------------------------------------------------------------------ */
  function build(scene) {
    const root = new THREE.Group();
    scene.add(root);

    const colliders = [];
    const rng = mulberry32(0xC0FFEE);
    const rnd = (a, b) => a + (b - a) * rng();

    const addCyl = (x, z, r, h, yMin) =>
      colliders.push({ x, z, r, h, yMin: yMin || 0 });

    const addBox = (x, z, w, d, h, angle, yMin) => {
      const a = angle || 0;
      colliders.push({
        type: 'box', x, z, w, d, h, angle: a,
        cos: Math.cos(a), sin: Math.sin(a),
        yMin: yMin || 0
      });
    };

    /* ---------------- sky ---------------------------------------------- */
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x1e4d80) },
        uBot: { value: new THREE.Color(0xd4dce4) }
      },
      vertexShader: [
        'varying vec3 vPos;',
        'void main() {',
        '  vPos = position;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uTop;',
        'uniform vec3 uBot;',
        'varying vec3 vPos;',
        'void main() {',
        '  float h = normalize(vPos).y;',
        '  vec3 c = mix(uBot, uTop, smoothstep(-0.05, 0.80, h));',
        '  gl_FragColor = vec4(c, 1.0);',
        '}'
      ].join('\n')
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 24, 16), skyMat);
    sky.frustumCulled = false;
    scene.add(sky);

    /* ---------------- atmospheric fog --------------------------------- */
    scene.fog = new THREE.Fog(0xc8d8e6, 140, 580);

    /* ---------------- lighting ---------------------------------------- */
    const hemi = new THREE.HemisphereLight(0xdcefff, 0x3a5030, 0.90);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2d6, 1.05);
    sun.position.set(180, 260, 120);
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x9bb4cc, 0.28);
    fill.position.set(-150, 80, -180);
    scene.add(fill);

    /* ---------------- terrain ----------------------------------------- */
    const SEGS = 220;
    const SIZE = 2200;
    const tGeo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    tGeo.rotateX(-Math.PI / 2);

    const pos = tGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, heightAt(x, z));
    }
    pos.needsUpdate = true;
    tGeo.computeVertexNormals();

    const gtex = groundTexture();
    gtex.repeat.set(90, 90);

    const terrain = new THREE.Mesh(
      tGeo,
      new THREE.MeshLambertMaterial({ map: gtex })
    );
    terrain.frustumCulled = false;
    root.add(terrain);

    /* ---------------- distant mountains ------------------------------- */
    const mtnMat  = new THREE.MeshLambertMaterial({ color: 0x5b7085 });
    const snowMat = new THREE.MeshLambertMaterial({ color: 0xdfe8f0 });

    for (let i = 0; i < 30; i++) {
      const ang = (i / 30) * Math.PI * 2 + rnd(-0.08, 0.08);
      const rad = 720 + rnd(-80, 120);
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      const h = 90 + rnd(0, 130);
      const r = 60 + rnd(0, 80);

      const mtn = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, 6 + Math.floor(rng() * 4)),
        mtnMat
      );
      mtn.position.set(x, h / 2 - 25, z);
      root.add(mtn);

      const snow = new THREE.Mesh(
        new THREE.ConeGeometry(r * 0.32, h * 0.28, 6),
        snowMat
      );
      snow.position.set(x, h - 25 - h * 0.14, z);
      root.add(snow);
    }

    /* ---------------- spawn pad --------------------------------------- */
    const spawnY = heightAt(0, 0);

    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 28),
      new THREE.MeshLambertMaterial({ color: 0x27343f })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, spawnY + 0.03, 0);
    root.add(pad);

    const padRing = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.0, 28),
      new THREE.MeshLambertMaterial({
        color: 0x6ef2a0, emissive: 0x1d5a33, side: THREE.DoubleSide
      })
    );
    padRing.rotation.x = -Math.PI / 2;
    padRing.position.set(0, spawnY + 0.05, 0);
    root.add(padRing);

    /* ---------------- central pylon (race marker) --------------------- */
    (function makePylon() {
      const px = 5, pz = -75, R = 4.0, H = 14;
      const baseY = heightAt(px, pz);

      const tower = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R * 1.10, H, 20),
        new THREE.MeshLambertMaterial({ color: 0x8899aa })
      );
      tower.position.set(px, baseY + H / 2, pz);
      root.add(tower);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.14, R * 1.14, 0.4, 20),
        new THREE.MeshLambertMaterial({ color: 0x667788 })
      );
      cap.position.set(px, baseY + H + 0.2, pz);
      root.add(cap);

      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff2200 })
      );
      beacon.position.set(px, baseY + H + 1.2, pz);
      root.add(beacon);

      addCyl(px, pz, R + 0.1, H, 0);
    })();

    /* ---------------- race gates -------------------------------------- */
    const gateDefs = [
      /*  x     z     rotY   base colour */
      [  18,  -42,  0.35, 0xff6020 ],
      [  32,  -72,  0.75, 0x20a0ff ],
      [  18, -108,  1.40, 0xff6020 ],
      [ -12, -108,  2.20, 0x20a0ff ],
      [ -32,  -85,  2.90, 0xff6020 ],
      [ -22,  -50, -0.55, 0x20a0ff ]
    ];

    const GS = 3.0;
    const postGeo = new THREE.CylinderGeometry(0.10, 0.10, GS, 8);
    const barGeo  = new THREE.CylinderGeometry(0.10, 0.10, GS, 8);

    const gates = [];

    for (const def of gateDefs) {
      const gx = def[0], gz = def[1], ry = def[2], col = def[3];
      const baseY = heightAt(gx, gz);
      const gy = baseY + 3.0;

      const mat = new THREE.MeshLambertMaterial({
        color: col,
        emissive: new THREE.Color(col).multiplyScalar(0.18)
      });

      const grp = new THREE.Group();
      grp.position.set(gx, gy, gz);
      grp.rotation.y = ry;

      const half = GS / 2;
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, mat);
        post.position.set(s * half, half, 0);
        grp.add(post);
      }
      const bar = new THREE.Mesh(barGeo, mat);
      bar.position.set(0, GS, 0);
      bar.rotation.z = Math.PI / 2;
      grp.add(bar);

      root.add(grp);

      gates.push({ x: gx, y: baseY + 4.5, z: gz, ry, w: GS, h: GS });

      const cs = Math.cos(ry), sn = Math.sin(ry);
      for (const s of [-1, 1]) {
        const wx = gx + (s * half) * cs;
        const wz = gz - (s * half) * sn;
        addCyl(wx, wz, 0.15, gy + GS, gy);
      }
    }

    /* ---------------- bando ruins (building shells) ------------------- */
    function makeRuin(cx, cz, W, D, H, ry) {
      const baseY = heightAt(cx, cz);
      const wallMat = new THREE.MeshLambertMaterial({ color: 0x9b9c96 });

      const grp = new THREE.Group();
      grp.position.set(cx, baseY, cz);
      grp.rotation.y = ry;

      /* four walls, some "broken" to different heights */
      const walls = [
        { lx: 0,   lz: -D/2, w: W,  h: H },
        { lx: 0,   lz:  D/2, w: W,  h: H * 0.7 },
        { lx: -W/2, lz: 0,   w: D,  h: H * 0.9, rot: Math.PI / 2 },
        { lx:  W/2, lz: 0,   w: D,  h: H * 0.6, rot: Math.PI / 2 }
      ];

      for (const w of walls) {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(w.w, w.h, 0.35),
          wallMat
        );
        wall.position.set(w.lx, w.h / 2, w.lz);
        if (w.rot) wall.rotation.y = w.rot;
        grp.add(wall);
      }

      /* a floating fragment of the collapsed roof */
      const frag = new THREE.Mesh(
        new THREE.BoxGeometry(W * 0.35, 0.4, D * 0.5),
        new THREE.MeshLambertMaterial({ color: 0x8b8c86 })
      );
      frag.position.set(-W * 0.15, H * 0.75, D * 0.15);
      frag.rotation.set(0.35, 0.4, 0.2);
      grp.add(frag);

      root.add(grp);

      /* colliders: one box per wall + a flattish box for the roof fragment */
      const cs = Math.cos(ry), sn = Math.sin(ry);
      function worldFromLocal(lx, lz) {
        return { x: cx + lx * cs + lz * sn, z: cz - lx * sn + lz * cs };
      }

      for (const w of walls) {
        const wc = worldFromLocal(w.lx, w.lz);
        addBox(wc.x, wc.z, w.w, 0.35, baseY + w.h, ry + (w.rot || 0), baseY);
      }
      const fc = worldFromLocal(-W * 0.15, D * 0.15);
      const fragY = baseY + H * 0.75;
      addBox(fc.x, fc.z, W * 0.35, D * 0.5,
             fragY + 0.3, ry, fragY - 0.3);
    }

    makeRuin(-105, -95, 22, 16, 6.5,  0.22);
    makeRuin( 130, -55, 26, 20, 8.0, -0.35);
    makeRuin(  90, 130, 16, 12, 5.0,  0.65);

    /* ---------------- clustered forest -------------------------------- */
    const TREES = 360;
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 2.4, 5);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREES);

    const leafGeo = new THREE.ConeGeometry(1.8, 5.4, 6);
    const leafMat = new THREE.MeshLambertMaterial({ color: 0x2f7038 });
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, TREES);

    trunks.frustumCulled = false;
    leaves.frustumCulled = false;

    const dummy = new THREE.Object3D();
    let placed = 0;

    const CLUSTERS = [
      { cx: -180, cz:  -80, r: 55, n: 70 },
      { cx:  200, cz: -180, r: 60, n: 80 },
      { cx:  -60, cz:  200, r: 50, n: 60 },
      { cx:  120, cz:  120, r: 55, n: 70 },
      { cx: -240, cz:  140, r: 70, n: 80 }
    ];

    for (const cl of CLUSTERS) {
      for (let i = 0; i < cl.n && placed < TREES; i++) {
        const ang = rnd(0, Math.PI * 2);
        const rad = Math.sqrt(rng()) * cl.r;
        const x = cl.cx + Math.cos(ang) * rad;
        const z = cl.cz + Math.sin(ang) * rad;
        const s = rnd(0.75, 1.7);
        const gy = heightAt(x, z);

        dummy.position.set(x, gy + 1.2 * s, z);
        dummy.rotation.set(0, rnd(0, Math.PI * 2), 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        trunks.setMatrixAt(placed, dummy.matrix);

        dummy.position.set(x, gy + 5.0 * s, z);
        dummy.updateMatrix();
        leaves.setMatrixAt(placed, dummy.matrix);

        addCyl(x, z, 0.85 * s, gy + 7.6 * s, 0);
        placed++;
      }
    }
    trunks.count = placed;
    leaves.count = placed;
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    root.add(trunks);
    root.add(leaves);

    /* ---------------- dispose ---------------------------------------- */
    function dispose() {
      scene.remove(root);
      root.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); });
          else o.material.dispose();
        }
      });
      scene.remove(sky);
    }

    return {
      root: root,
      gates: gates,
      sky: sky,
      skyMat: skyMat,
      sun: sun,
      hemi: hemi,
      fill: fill,
      colliders: colliders,
      heightAt: heightAt,
      advanceFrame: function () {},   // procedural: nothing to advance
      spawn: new THREE.Vector3(0, 0, 0),
      dispose: dispose
    };
  }

  return { build: build };
})();
