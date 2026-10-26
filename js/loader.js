/* =========================================================================
   loader.js — GLB/GLTF importer with adaptive merge strategy.

   < 2000 meshes  → global merge (fewest draw calls; whole map fits)
   ≥ 2000 meshes  → chunked merge in 60 m tiles (better frustum culling)
   ========================================================================= */
'use strict';

window.MAP = (function () {

  const EMPTY = Object.freeze([]);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
  const MAX_TEX_DIM = isMobile ? 1024 : 2048;
  const CHUNK_SIZE = 60;

  function load(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const loader = new THREE.GLTFLoader();

      loader.load(url, function (gltf) {
        URL.revokeObjectURL(url);
        const gltfScene = gltf.scene;

        stripLights(gltfScene);
        autoScaleCentre(gltfScene);

        const meshes = [];
        gltfScene.updateMatrixWorld(true);
        gltfScene.traverse(function (o) { if (o.isMesh) meshes.push(o); });
        const meshCountBefore = meshes.length;

        /* materials + textures */
        const matCache = new Map();
        for (const m of meshes) {
          if (Array.isArray(m.material)) {
            m.material = m.material.map(mm => simplifyMaterial(mm, matCache));
          } else {
            m.material = simplifyMaterial(m.material, matCache);
          }
        }
        const seenTex = new Set();
        for (const m of meshes) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            if (!mat) continue;
            for (const slot of ['map', 'emissiveMap', 'normalMap', 'aoMap']) {
              if (mat[slot] && !seenTex.has(mat[slot])) {
                seenTex.add(mat[slot]);
                downscaleTexture(mat[slot], MAX_TEX_DIM);
              }
            }
          }
        }

        const rawColliders = buildColliders(meshes);
        const colliderIndex = buildSpatialHash(rawColliders, 10);

        const t0 = performance.now();
        const merged = meshes.length > 2000
          ? mergeChunked(meshes)
          : mergeGlobal(meshes);
        const mergeMs = performance.now() - t0;

        const heightAt = makeHeightSampler(merged.meshes, 4);

        console.log(
          'MAP loaded: ' + meshCountBefore + ' → ' + merged.meshes.length +
          ' meshes (' + (meshes.length > 2000 ? 'chunked' : 'global') +
          ', ' + mergeMs.toFixed(0) + 'ms), ' + rawColliders.length + ' colliders');

        resolve({
          scene: merged.scene,
          gates: [],
          colliders: rawColliders,
          colliderIndex: colliderIndex,
          heightAt: heightAt,
          meshCount: merged.meshes.length,
          meshCountOriginal: meshCountBefore
        });
      }, undefined, reject);
    });
  }

  /* -------------------------------- helpers ---------------------------- */
  function stripLights(scene) {
    const arr = [];
    scene.traverse(o => { if (o.isLight) arr.push(o); });
    for (const l of arr) if (l.parent) l.parent.remove(l);
  }

  function autoScaleCentre(scene) {
    scene.scale.setScalar(1);
    scene.position.set(0, 0, 0);
    scene.updateMatrixWorld(true);

    let box = new THREE.Box3().setFromObject(scene);
    let sz = box.getSize(new THREE.Vector3());
    const md = Math.max(sz.x, sz.z);
    if (md > 900 || md < 40) {
      scene.scale.setScalar(400 / md);
      scene.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(scene);
    }
    const c = box.getCenter(new THREE.Vector3());
    scene.position.x = -c.x;
    scene.position.z = -c.z;
    scene.position.y = -box.min.y;
    scene.updateMatrixWorld(true);
  }

  function simplifyMaterial(mat, cache) {
    if (!mat) return mat;
    if (!mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial) return mat;
    const hit = cache.get(mat.uuid);
    if (hit) return hit;
    const lm = new THREE.MeshLambertMaterial({
      color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
      map: mat.map || null,
      emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0),
      emissiveMap: mat.emissiveMap || null,
      emissiveIntensity: mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1,
      transparent: mat.transparent,
      opacity: mat.opacity,
      side: (mat.side === THREE.DoubleSide && !mat.transparent) ? THREE.FrontSide : mat.side,
      alphaTest: mat.alphaTest,
      depthWrite: mat.depthWrite,
      vertexColors: mat.vertexColors
    });
    lm.name = mat.name || '';
    cache.set(mat.uuid, lm);
    mat.dispose();
    return lm;
  }

  function downscaleTexture(tex, maxDim) {
    if (!tex) return;
    tex.anisotropy = 1;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const img = tex.image;
    if (!img) return;
    const w = img.width, h = img.height;
    if (!w || !h || (w <= maxDim && h <= maxDim)) return;
    const s = maxDim / Math.max(w, h);
    const nw = Math.round(w * s), nh = Math.round(h * s);
    try {
      const c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      c.getContext('2d').drawImage(img, 0, 0, nw, nh);
      tex.image = c;
      tex.needsUpdate = true;
    } catch (e) {}
  }

  /* ------------------------------------------------------------------
     COLLIDER GENERATION

     Two modes per mesh:
       (a) SOLID — one AABB. Used for small / dense meshes (crates,
           rocks, individual chairs). Cheap and accurate.
       (b) SUBDIVIDED — the mesh's triangles are bucketed into a
           uniform voxel grid; only cells containing triangles become
           colliders. Used for LARGE meshes (bridges, buildings, walls)
           so that the empty space under a deck or between walls has
           no collider.

     Subdivision triggers when:
         triCount >= 20  AND  ( maxDim >= 6  OR  density < 1.5 )

     Where density = triangles / AABB volume (tris per m^3).
     Solid crates typically have density 3-100.
     Bridges / building shells typically have density 0.1-1.5.
     Large solid blocks (density > 1.5, maxDim < 6) stay as AABBs.

     The fallback (whole AABB) is used if a subdivided mesh would need
     more than 800 cells — usually means the mesh is more solid than the
     heuristic guessed, so AABB is correct anyway.
     ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------
     COLLIDER GENERATION (v3 — aggressive)

     Every mesh with 2+ triangles and any dimension >= 3m, OR any
     non-trivial rotation, is subdivided into voxel cells. Only cells
     that actually contain triangles become colliders — so the empty
     space between planks of a bridge deck, under a walkway, or inside
     a rotated railing has ZERO colliders.

     Solid boxes that are small and un-rotated (crates, chairs, rocks)
     stay as single AABBs — cheaper and equally correct.

     Cell size adapts: if a mesh would generate more than 1200 cells,
     cell size grows until it fits. This ensures large structures
     (bridges spanning 30m, buildings 20m tall) still subdivide cleanly.
     ------------------------------------------------------------------ */
  function buildColliders(meshes) {
    const out = [];
    const aabb = new THREE.Box3();
    const sz = new THREE.Vector3();
    const ctr = new THREE.Vector3();
    const q = new THREE.Quaternion();

    let subdivMeshes = 0, subdivCells = 0, solidMeshes = 0;
    let skipNamed = 0, skipHuge = 0, skipTiny = 0, subdivFailed = 0;
    let totalTris = 0;

    for (const m of meshes) {
      if (/^no_collide_/i.test(m.name || '')) { skipNamed++; continue; }
      if (m.visible === false) { skipTiny++; continue; }
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        let any = false;
        for (const mat of mats) {
          if (mat && mat.visible !== false && mat.opacity > 0.05) { any = true; break; }
        }
        if (!any) { skipTiny++; continue; }
      }

      aabb.setFromObject(m);
      aabb.getSize(sz);
      if (sz.x > 300 || sz.z > 300) { skipHuge++; continue; }
      if (sz.x < 0.08 || sz.z < 0.08 || sz.y < 0.05) { skipTiny++; continue; }

      const geo = m.geometry;
      const idx = geo.index;
      const pos = geo.attributes.position;
      if (!pos || pos.count < 3) continue;
      const triCount = idx ? idx.count / 3 : pos.count / 3;
      totalTris += triCount;

      const maxDim = Math.max(sz.x, sz.y, sz.z);

      /* Rotation check: any world-space rotation > ~6° triggers
         subdivision, because a rotated AABB is much larger than the
         mesh it contains.                                                   */
      m.updateWorldMatrix(true, false);
      let rotated = false;
      try {
        m.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
        const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
        rotated = ang > 0.1;
      } catch (e) { /* ignore */ }

      /* Decision — much more aggressive than v2 */
      const shouldSubdivide =
        triCount >= 2 && (maxDim >= 3 || rotated);

      if (shouldSubdivide) {
        const before = out.length;
        const ok = subdivideMesh(m, aabb, sz, out);
        if (ok) {
          subdivMeshes++;
          subdivCells += (out.length - before);
        } else {
          subdivFailed++;
          aabb.getCenter(ctr);
          let yMax = aabb.max.y, yMin = aabb.min.y;
          if (yMax - yMin < 0.1) {
            const mid = (yMax + yMin) * 0.5;
            yMin = mid - 0.05; yMax = mid + 0.05;
          }
          out.push({
            type: 'box',
            x: ctr.x, z: ctr.z, w: sz.x, d: sz.z,
            h: yMax, yMin: yMin, angle: 0, cos: 1, sin: 0,
            meshName: m.name || 'unnamed'
          });
          solidMeshes++;
        }
      } else {
        aabb.getCenter(ctr);
        let yMax = aabb.max.y, yMin = aabb.min.y;
        if (yMax - yMin < 0.1) {
          const mid = (yMax + yMin) * 0.5;
          yMin = mid - 0.05; yMax = mid + 0.05;
        }
        out.push({
          type: 'box',
          x: ctr.x, z: ctr.z, w: sz.x, d: sz.z,
          h: yMax, yMin: yMin, angle: 0, cos: 1, sin: 0,
          meshName: m.name || 'unnamed'
        });
        solidMeshes++;
      }
    }

    if (out.length > 40000) {
      out.sort((a, b) => (b.w * b.d * (b.h - (b.yMin || 0))) -
                         (a.w * a.d * (a.h - (a.yMin || 0))));
      out.length = 40000;
      console.warn('MAP: capped colliders at 40000 (largest kept)');
    }

    console.log(
      'Colliders: ' + out.length +
      ' | ' + solidMeshes + ' solid' +
      ' | ' + subdivMeshes + ' subdivided → ' + subdivCells + ' cells' +
      ' | subdiv-fallback: ' + subdivFailed +
      ' | skipped: ' + skipNamed + ' named, ' +
      skipHuge + ' huge, ' + skipTiny + ' tiny' +
      ' | ' + Math.round(totalTris) + ' tris total'
    );

    /* ------------------ debug helpers ------------------ */
    window.__colliderInfo = () => ({
      total: out.length,
      solidMeshes, subdivMeshes, subdivCells,
      subdivFailed, skipNamed, skipHuge, skipTiny,
      totalTris: Math.round(totalTris)
    });

    window.__colliderDebug = function (x, z, radius) {
      radius = radius || 10;
      const list = [];
      for (const c of out) {
        const dx = x - c.x;
        const dz = z - c.z;
        const reach = radius + Math.max(c.w, c.d) * 0.5;
        if (Math.hypot(dx, dz) > reach) continue;
        list.push({
          meshName: c.meshName || '?',
          x: +c.x.toFixed(2), z: +c.z.toFixed(2),
          w: +c.w.toFixed(2), d: +c.d.toFixed(2),
          yMin: +(c.yMin || 0).toFixed(2), h: +c.h.toFixed(2),
          dist: +Math.hypot(dx, dz).toFixed(2)
        });
      }
      list.sort((a, b) => a.dist - b.dist);
      return list.slice(0, 40);
    };

    window.__colliderWireframe = function (scene, filter) {
      if (!scene) scene = window.__scene;
      if (!scene) {
        console.warn('Pass scene explicitly or ensure __scene exists.');
        return;
      }
      const existing = scene.getObjectByName('__collider_wireframes');
      if (existing) scene.remove(existing);

      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff2266, wireframe: true,
        transparent: true, opacity: 0.40, depthTest: false
      });
      const group = new THREE.Group();
      group.name = '__collider_wireframes';
      for (const c of out) {
        if (filter && !filter(c)) continue;
        const bm = new THREE.Mesh(geo, mat);
        bm.position.set(c.x, (c.yMin + c.h) * 0.5, c.z);
        bm.scale.set(c.w, Math.max(0.05, c.h - (c.yMin || 0)), c.d);
        if (c.angle) bm.rotation.y = c.angle;
        bm.renderOrder = 999;
        group.add(bm);
      }
      scene.add(group);
      console.log('Wireframe: ' + group.children.length + ' colliders drawn.');
      return group;
    };

    window.__colliderWireframeNear = function (radius) {
      if (!window.__drone) {
        console.warn('__drone not available'); return;
      }
      const p = window.__drone.position;
      radius = radius || 15;
      return window.__colliderWireframe(window.__scene, c =>
        Math.hypot(c.x - p.x, c.z - p.z) < radius + Math.max(c.w, c.d));
    };

    return out;
  }

  /* ------------------------------------------------------------------
     Voxelise a mesh: bucket triangles into cells, emit one box collider
     per non-empty cell. Adaptive cell sizing: if the naive 2.5m grid
     would produce more than 1200 cells, cell size grows until it fits.
     Returns false if the mesh can't be subdivided (caller uses AABB).
     ------------------------------------------------------------------ */
  function subdivideMesh(mesh, aabb, size, out) {
    const geo = mesh.geometry;
    const idx = geo.index;
    const pos = geo.attributes.position;
    const matrix = mesh.matrixWorld;

    /* --- adaptive cell size ---------------------------------------- */
    const maxCellsPerMesh = 1200;
    let cellSize = 2.5;
    const naiveCells =
      Math.ceil(size.x / cellSize) *
      Math.ceil(size.y / cellSize) *
      Math.ceil(size.z / cellSize);
    if (naiveCells > maxCellsPerMesh) {
      const scale = Math.cbrt(naiveCells / maxCellsPerMesh);
      cellSize *= scale;
    }

    const Nx = Math.max(1, Math.ceil(size.x / cellSize));
    const Ny = Math.max(1, Math.ceil(size.y / cellSize));
    const Nz = Math.max(1, Math.ceil(size.z / cellSize));
    const cx = size.x / Nx, cy = size.y / Ny, cz = size.z / Nz;

    const cells = new Map();
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();

    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const ia = idx ? idx.getX(t * 3)     : t * 3;
      const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      va.fromBufferAttribute(pos, ia).applyMatrix4(matrix);
      vb.fromBufferAttribute(pos, ib).applyMatrix4(matrix);
      vc.fromBufferAttribute(pos, ic).applyMatrix4(matrix);

      const tMinX = Math.min(va.x, vb.x, vc.x);
      const tMaxX = Math.max(va.x, vb.x, vc.x);
      const tMinY = Math.min(va.y, vb.y, vc.y);
      const tMaxY = Math.max(va.y, vb.y, vc.y);
      const tMinZ = Math.min(va.z, vb.z, vc.z);
      const tMaxZ = Math.max(va.z, vb.z, vc.z);

      const i0 = Math.max(0,      Math.floor((tMinX - aabb.min.x) / cx));
      const i1 = Math.min(Nx - 1, Math.floor((tMaxX - aabb.min.x) / cx));
      const j0 = Math.max(0,      Math.floor((tMinY - aabb.min.y) / cy));
      const j1 = Math.min(Ny - 1, Math.floor((tMaxY - aabb.min.y) / cy));
      const k0 = Math.max(0,      Math.floor((tMinZ - aabb.min.z) / cz));
      const k1 = Math.min(Nz - 1, Math.floor((tMaxZ - aabb.min.z) / cz));

      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            const key = i + ',' + j + ',' + k;
            let c = cells.get(key);
            if (!c) {
              c = { minX: tMinX, maxX: tMaxX,
                    minY: tMinY, maxY: tMaxY,
                    minZ: tMinZ, maxZ: tMaxZ };
              cells.set(key, c);
            } else {
              if (tMinX < c.minX) c.minX = tMinX;
              if (tMaxX > c.maxX) c.maxX = tMaxX;
              if (tMinY < c.minY) c.minY = tMinY;
              if (tMaxY > c.maxY) c.maxY = tMaxY;
              if (tMinZ < c.minZ) c.minZ = tMinZ;
              if (tMaxZ > c.maxZ) c.maxZ = tMaxZ;
            }
          }
        }
      }
    }

    if (cells.size === 0) return false;

    let placed = 0;
    const name = mesh.name || 'unnamed';
    cells.forEach(c => {
      const w = c.maxX - c.minX;
      const d = c.maxZ - c.minZ;
      const h = c.maxY - c.minY;
      if (w < 0.10 || d < 0.10) return;
      let yMin = c.minY, yMax = c.maxY;
      if (h < 0.08) {
        const mid = (yMin + yMax) * 0.5;
        yMin = mid - 0.04; yMax = mid + 0.04;
      }
      out.push({
        type: 'box',
        x: (c.minX + c.maxX) * 0.5,
        z: (c.minZ + c.maxZ) * 0.5,
        w: w, d: d, h: yMax, yMin: yMin,
        angle: 0, cos: 1, sin: 0,
        meshName: name
      });
      placed++;
    });
    return placed > 0;
  }

  function buildSpatialHash(colliders, cellSize) {
    const map = new Map();
    for (const c of colliders) {
      const hw = c.w * 0.5 + 0.5, hd = c.d * 0.5 + 0.5;
      const x0 = Math.floor((c.x - hw) / cellSize);
      const x1 = Math.floor((c.x + hw) / cellSize);
      const z0 = Math.floor((c.z - hd) / cellSize);
      const z1 = Math.floor((c.z + hd) / cellSize);
      for (let i = x0; i <= x1; i++) {
        for (let j = z0; j <= z1; j++) {
          const k = i * 100000 + j;
          let b = map.get(k);
          if (!b) { b = []; map.set(k, b); }
          b.push(c);
        }
      }
    }
    return {
      query(x, z) {
        const k = Math.floor(x / cellSize) * 100000 + Math.floor(z / cellSize);
        return map.get(k) || EMPTY;
      }
    };
  }

  /* -- prepare a geometry for merging ------------------------------- */
  function prepGeometry(m) {
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    const names = Object.keys(g.attributes);
    for (const name of names) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') {
        g.deleteAttribute(name);
      }
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      const cnt = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cnt * 2), 2));
    }
    return g;
  }

  function mergeGroup(meshes, material) {
    if (!THREE.BufferGeometryUtils) return null;
    const geoms = [];
    for (const m of meshes) {
      try { geoms.push(prepGeometry(m)); }
      catch (e) { /* skip */ }
    }
    if (geoms.length === 0) return null;
    let merged = null;
    try { merged = THREE.BufferGeometryUtils.mergeBufferGeometries(geoms, false); }
    catch (e) { merged = null; }
    geoms.forEach(g => g.dispose());
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, material);
    mesh.frustumCulled = true;
    return mesh;
  }

  /* -- global merge ------------------------------------------------- */
  function mergeGlobal(meshes) {
    if (!THREE.BufferGeometryUtils) {
      return { scene: wrapScene(meshes), meshes: meshes };
    }
    const groups = new Map();
    const keep = [];
    for (const m of meshes) {
      if (Array.isArray(m.material)) { keep.push(m); continue; }
      if (m.isSkinnedMesh || m.isInstancedMesh) { keep.push(m); continue; }
      if (m.geometry.morphAttributes &&
          Object.keys(m.geometry.morphAttributes).length > 0) {
        keep.push(m); continue;
      }
      const k = m.material.uuid;
      let g = groups.get(k);
      if (!g) { g = { material: m.material, meshes: [] }; groups.set(k, g); }
      g.meshes.push(m);
    }

    const out = new THREE.Group();
    groups.forEach(g => {
      if (g.meshes.length < 2) { g.meshes.forEach(m => out.attach(m)); return; }
      const merged = mergeGroup(g.meshes, g.material);
      if (merged) out.add(merged);
      else g.meshes.forEach(m => out.attach(m));
    });
    keep.forEach(m => { try { out.attach(m); } catch (e) {} });

    const final = [];
    out.traverse(o => { if (o.isMesh) final.push(o); });
    return { scene: out, meshes: final };
  }

  /* -- chunked merge ------------------------------------------------ */
  function mergeChunked(meshes) {
    if (!THREE.BufferGeometryUtils) {
      return { scene: wrapScene(meshes), meshes: meshes };
    }

    const chunks = new Map();
    const keep = [];
    const aabb = new THREE.Box3();
    const ctr = new THREE.Vector3();

    for (const m of meshes) {
      if (Array.isArray(m.material)) { keep.push(m); continue; }
      if (m.isSkinnedMesh || m.isInstancedMesh) { keep.push(m); continue; }
      if (m.geometry.morphAttributes &&
          Object.keys(m.geometry.morphAttributes).length > 0) {
        keep.push(m); continue;
      }
      aabb.setFromObject(m);
      aabb.getCenter(ctr);
      const ci = Math.floor(ctr.x / CHUNK_SIZE);
      const cj = Math.floor(ctr.z / CHUNK_SIZE);
      const key = ci + ':' + cj;
      let list = chunks.get(key);
      if (!list) { list = []; chunks.set(key, list); }
      list.push(m);
    }

    const out = new THREE.Group();
    chunks.forEach(list => {
      const groups = new Map();
      for (const m of list) {
        const k = m.material.uuid;
        let g = groups.get(k);
        if (!g) { g = { material: m.material, meshes: [] }; groups.set(k, g); }
        g.meshes.push(m);
      }
      groups.forEach(g => {
        if (g.meshes.length < 2) { g.meshes.forEach(m => out.attach(m)); return; }
        const merged = mergeGroup(g.meshes, g.material);
        if (merged) out.add(merged);
        else g.meshes.forEach(m => out.attach(m));
      });
    });
    keep.forEach(m => { try { out.attach(m); } catch (e) {} });

    const final = [];
    out.traverse(o => { if (o.isMesh) final.push(o); });
    return { scene: out, meshes: final };
  }

  function wrapScene(meshes) {
    const g = new THREE.Group();
    meshes.forEach(m => { try { g.attach(m); } catch (e) {} });
    return g;
  }

  /* -- height sampler ---------------------------------------------- */
  /* ------------------------------------------------------------------
     Drone-Y aware floor sampler.

     For each XZ cell we cache the FULL list of surface heights below it
     (not just the topmost one). At query time we pick the highest
     surface that is at or below the drone (+0.5 m tolerance). That
     means:
       • drone above a roof  → floor = roof top
       • drone under a roof  → floor = ground
       • drone on the ground → floor = ground
     Pass droneY = undefined for spawn queries (highest surface wins).
     ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------
     Floor sampler with face-normal filtering.

     Only upward-facing surfaces (world-space face normal .y > 0.35)
     count as a "floor". Bridge deck UNDERSIDES, ceilings, and walls
     are discarded — this is what prevents the drone from being pulled
     up when flying under a bridge.

     Velocity-aware pick margin:
       descending (vy < -0.5)  → +0.15 m  (real landings snap)
       level      (|vy| < 0.5) → +0.05 m
       ascending  (vy > +0.5)  → 0.00 m   (pass through anything above)

     Fallback: if NO upward-facing hits exist in a cell (inverted or
     weird geometry), we use the raw hit list so the drone can't fall
     into the void.
     ------------------------------------------------------------------ */
  function makeHeightSampler(meshes, cellSize) {
    const ray = new THREE.Raycaster();
    ray.far = 2000;
    const DOWN = new THREE.Vector3(0, -1, 0);
    const ORIGIN = new THREE.Vector3();
    const cache = new Map();

    const _normalMatrix = new THREE.Matrix3();
    const _faceNormal = new THREE.Vector3();

    function cast(x, z) {
      ORIGIN.set(x, 1000, z);
      ray.ray.origin.copy(ORIGIN);
      ray.ray.direction.copy(DOWN);
      const hits = ray.intersectObjects(meshes, false);
      const ysUp = [];
      const ysAll = [];
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        ysAll.push(hit.point.y);
        if (!hit.face) { ysUp.push(hit.point.y); continue; }
        _normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        _faceNormal
          .copy(hit.face.normal)
          .applyMatrix3(_normalMatrix)
          .normalize();
        if (_faceNormal.y > 0.35) ysUp.push(hit.point.y);
      }
      return ysUp.length > 0 ? ysUp : ysAll;
    }

    function cell(i, j) {
      const k = i * 100000 + j;
      const v = cache.get(k);
      if (v !== undefined) return v;
      const ys = cast((i + 0.5) * cellSize, (j + 0.5) * cellSize);
      cache.set(k, ys);
      return ys;
    }

    function pick(ys, droneY, vy) {
      if (!ys || ys.length === 0) return -Infinity;
      if (droneY === undefined || droneY === null) return ys[0];

      let margin = 0.05;
      if (vy !== undefined && vy !== null) {
        if (vy < -0.5)      margin = 0.15;
        else if (vy > 0.5)  margin = 0.0;
        else                margin = 0.05;
      }
      for (let i = 0; i < ys.length; i++) {
        if (ys[i] <= droneY + margin) return ys[i];
      }
      return -Infinity;
    }

    return function heightAt(x, z, droneY, vy) {
      const fx = x / cellSize - 0.5;
      const fz = z / cellSize - 0.5;
      const x0 = Math.floor(fx), z0 = Math.floor(fz);
      const tx = fx - x0, tz = fz - z0;

      let h00 = pick(cell(x0,     z0),     droneY, vy);
      let h10 = pick(cell(x0 + 1, z0),     droneY, vy);
      let h01 = pick(cell(x0,     z0 + 1), droneY, vy);
      let h11 = pick(cell(x0 + 1, z0 + 1), droneY, vy);

      if (!isFinite(h00)) h00 = h10;
      if (!isFinite(h01)) h01 = h11;
      if (!isFinite(h10)) h10 = h00;
      if (!isFinite(h11)) h11 = h01;
      if (!isFinite(h00)) return -Infinity;

      const h0 = h00 * (1 - tx) + h10 * tx;
      const h1 = h01 * (1 - tx) + h11 * tx;
      return h0 * (1 - tz) + h1 * tz;
    };
  }

  return { load: load };
})();
