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

    this.reset(0, 0);
  }

  Drone.prototype.getFloorY = function () { return CFG.groundY; };

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

    const e = CFG.expo;
    const rRate = curve(input.roll,  e) * CFG.maxRates.roll  * DEG * CFG.rcRate;
    const pRate = curve(input.pitch, e) * CFG.maxRates.pitch * DEG * CFG.rcRate;
    const yRate = curve(input.yaw,   e) * CFG.maxRates.yaw   * DEG * CFG.rcRate;

    this._target.set(-pRate, -yRate, -rRate);

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
      const w = Math.sin(this._wobPhase) * this._wobAmp * thr;
      a.x += w * 400;
      a.z += Math.sin(this._wobPhase * 0.73 + 1.7) * this._wobAmp * thr * 320;
      a.x += Math.sin(this._wobPhase * 2.31) * 2.5 * thr;
      a.z += Math.cos(this._wobPhase * 1.87) * 2.0 * thr;
    }

    /* ---- motor desync: rapid throttle changes → brief yaw kicks ---- */
    if (Math.abs(dThr) > 0.2 && thr > 0.3) {
      a.y += (Math.random() - 0.5) * Math.min(1.5, Math.abs(dThr) * 2.0) * 6.0;
    }

    /* ---- ground effect: wobble near terrain ---- */
    const floorHere = this.getFloorY(this.position.x, this.position.z);
    const agl = this.position.y - floorHere;
    if (agl > 0.2 && agl < 2.5 && this.armed) {
      const eff = (1 - agl / 2.5) * 0.5;
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
    acc.copy(this._up).multiplyScalar(thr * CFG.maxThrust / CFG.mass);
    acc.y -= CFG.gravity;

    const speed = this.velocity.length();
    if (speed > 1e-5) {
      const k = CFG.dragLinear + CFG.dragQuadratic * speed;
      acc.addScaledVector(this.velocity, -k);
    }

    /* ---- windmill / air-brake drag at low throttle ---- */
    if (thr < 0.15 && speed > 3) {
      const windmill = (1 - thr / 0.15) * 0.35;
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

  Drone.prototype._collide = function () {
    const floor = this.getFloorY(this.position.x, this.position.z);

    if (this.position.y < floor) {
      const vyImpact = -this.velocity.y;
      const depth = floor - this.position.y;

      this.position.y = floor;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.velocity.x *= 0.82;
      this.velocity.z *= 0.82;

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
