/* =========================================================================
   racing.js — gate detection, lap timer, best lap, ghost replay.

   Active only when the current world exports `gates` (procedural world).
   Loaded GLB maps have no gates, so racing stays off and the HUD shows
   "FREE FLIGHT".
   ========================================================================= */
'use strict';

window.Racing = (function () {

  let gates = [];
  let active = false;
  let scene = null;

  let started = false;
  let currentGate = 0;
  let gatesThisLap = 0;
  let lapStartMs = 0;
  let lapMs = 0;
  let bestMs = Infinity;
  let lastLapMs = 0;
  let lapCount = 0;
  let lapCompleteAt = 0;

  let recording = [];
  let ghostData = null;
  let recordTimer = 0;
  const RECORD_HZ = 30;

  let ghostMesh = null;
  const prevPos = new THREE.Vector3();

  /* ------------------------------------------------------------------ */
  function init(world, sceneRef) {
    scene = sceneRef;
    gates = (world && world.gates) || [];
    active = gates.length > 0;

    started = false;
    currentGate = 0;
    gatesThisLap = 0;
    lapMs = 0;
    bestMs = Infinity;
    lastLapMs = 0;
    lapCount = 0;
    lapCompleteAt = 0;
    recording = [];
    ghostData = null;
    recordTimer = 0;

    if (ghostMesh && scene) {
      scene.remove(ghostMesh);
      ghostMesh.geometry.dispose();
      ghostMesh.material.dispose();
      ghostMesh = null;
    }

    if (active && scene) {
      const geo = new THREE.SphereGeometry(0.35, 12, 8);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xb080ff,
        transparent: true,
        opacity: 0.75,
        depthWrite: false
      });
      ghostMesh = new THREE.Mesh(geo, mat);
      ghostMesh.visible = false;
      ghostMesh.frustumCulled = false;
      ghostMesh.renderOrder = 999;
      scene.add(ghostMesh);
    }
  }

  function reset() {
    started = false;
    currentGate = 0;
    gatesThisLap = 0;
    lapMs = 0;
    recording = [];
    recordTimer = 0;
    if (ghostMesh) ghostMesh.visible = false;
  }

  /* ------------------------------------------------------------------ */
  function update(dt, drone) {
    if (!active) return;
    if (drone.crashed) {
      if (ghostMesh) ghostMesh.visible = false;
      return;
    }

    const now = performance.now();

    const nextGate = gates[currentGate];
    if (nextGate && crossedGate(prevPos, drone.position, nextGate)) {
      onGateCrossed(drone, now);
    }
    prevPos.copy(drone.position);

    if (started) lapMs = now - lapStartMs;

    if (started && recording.length < 10000) {
      recordTimer += dt;
      if (recordTimer >= 1 / RECORD_HZ) {
        recordTimer = 0;
        recording.push({
          t: lapMs / 1000,
          x: drone.position.x,
          y: drone.position.y,
          z: drone.position.z
        });
      }
    }

    if (ghostMesh) {
      if (started && ghostData && ghostData.length > 1) {
        updateGhost(lapMs / 1000, drone);
      } else {
        ghostMesh.visible = false;
      }
    }
  }

  function onGateCrossed(drone, now) {
    if (currentGate === 0) {
      started = true;
      lapStartMs = now;
      lapMs = 0;
      gatesThisLap = 1;
      currentGate = 1;
      recording = [{
        t: 0,
        x: drone.position.x,
        y: drone.position.y,
        z: drone.position.z
      }];
      recordTimer = 0;
    } else {
      currentGate++;
      gatesThisLap++;
      if (currentGate >= gates.length) {
        lastLapMs = lapMs;
        lapCount++;
        lapCompleteAt = now;
        if (lapMs < bestMs) {
          bestMs = lapMs;
          ghostData = recording.slice();
        }
        currentGate = 0;
        gatesThisLap = 0;
        started = false;
        recording = [];
      }
    }
  }

  function crossedGate(prev, curr, gate) {
    const nx = Math.sin(gate.ry);
    const nz = Math.cos(gate.ry);

    const dPrev = (prev.x - gate.x) * nx + (prev.z - gate.z) * nz;
    const dCurr = (curr.x - gate.x) * nx + (curr.z - gate.z) * nz;

    if (dPrev * dCurr > 0) return false;
    if (dPrev === dCurr) return false;

    const t = dPrev / (dPrev - dCurr);
    const cx = prev.x + (curr.x - prev.x) * t;
    const cy = prev.y + (curr.y - prev.y) * t;
    const cz = prev.z + (curr.z - prev.z) * t;

    const rx = Math.cos(gate.ry), rz = -Math.sin(gate.ry);
    const lx = (cx - gate.x) * rx + (cz - gate.z) * rz;
    const ly = cy - gate.y;

    if (Math.abs(lx) > gate.w / 2) return false;
    if (Math.abs(ly) > gate.h / 2) return false;
    return true;
  }

  function updateGhost(t, drone) {
    const data = ghostData;
    if (!data || data.length < 2) { ghostMesh.visible = false; return; }
    if (t < data[0].t || t > data[data.length - 1].t) {
      ghostMesh.visible = false;
      return;
    }

    let lo = 0, hi = data.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (data[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = data[lo], b = data[hi];
    const span = b.t - a.t;
    const f = span > 0 ? (t - a.t) / span : 0;

    ghostMesh.position.set(
      a.x + (b.x - a.x) * f,
      a.y + (b.y - a.y) * f,
      a.z + (b.z - a.z) * f
    );
    ghostMesh.visible = true;
    ghostMesh.material.opacity = 0.6 + 0.25 * Math.sin(performance.now() * 0.006);
  }

  function getState() {
    return {
      active, started, currentGate, gatesThisLap,
      totalGates: gates.length,
      lapMs, bestMs, lastLapMs, lapCount, lapCompleteAt
    };
  }

  return { init, reset, update, getState };
})();
