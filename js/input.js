/* =========================================================================
   input.js — multi-touch virtual joysticks + keyboard fallback + iOS guards.
   ========================================================================= */
'use strict';

window.Input = (function () {

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function installIOSGuards() {
    let lastTapEnd = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - lastTapEnd < 350) e.preventDefault();
      lastTapEnd = now;
    }, { passive: false });

    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (evt) {
      document.addEventListener(evt, function (e) { e.preventDefault(); },
        { passive: false });
    });

    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('selectstart', function (e) { e.preventDefault(); });

    document.addEventListener('touchmove', function (e) {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchstart', function () { Audio.resume(); },
      { passive: true });
    document.addEventListener('click', function () { Audio.resume(); });
  }

  function Joystick(el, opts) {
    this.el = el;
    this.knob = el.querySelector('.knob');

    this.springX = opts.springX !== false;
    this.springY = opts.springY !== false;
    this.deadzone = opts.deadzone || 0.09;

    this.x = 0;
    this.y = 0;
    this.active = false;
    this.holdY = false;
    this.pointerId = null;

    this._cx = 0;
    this._cy = 0;
    this._radius = 1;
    this._travel = 40;

    this._bind();
    this.measure();
    this.render();
  }

  Joystick.prototype._bind = function () {
    const self = this;
    const el = this.el;

    function onDown(e) {
      if (self.pointerId !== null) return;
      Audio.resume();
      self.pointerId = e.pointerId;
      self.active = true;
      self.measure();
      self._apply(e);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    }

    function onMove(e) {
      if (e.pointerId !== self.pointerId) return;
      self._apply(e);
      e.preventDefault();
    }

    function onUp(e) {
      if (e.pointerId !== self.pointerId) return;
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      self.pointerId = null;
      self.active = false;
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
  };

  Joystick.prototype.measure = function () {
    const r = this.el.getBoundingClientRect();
    this._cx = r.left + r.width * 0.5;
    this._cy = r.top + r.height * 0.5;
    this._radius = Math.max(1, r.width * 0.5);
    this._travel = r.width * 0.30;
  };

  Joystick.prototype._apply = function (e) {
    let dx = (e.clientX - this._cx) / this._radius;
    let dy = (e.clientY - this._cy) / this._radius;

    // Square gate — matches a real radio gimbal. Per-axis clamp so the
    // corner is a full-deflection point on BOTH axes at once (magnitude
    // sqrt(2)). A circular Math.hypot normalize forbids this.
    dx = clamp(dx, -1, 1);
    dy = clamp(dy, -1, 1);

    const m = Math.hypot(dx, dy);
    const dz = this.deadzone;
    if (m <= dz) {
      this.x = 0;
      this.y = 0;
    } else {
      // Radial deadzone with rescale. Inside the inscribed circle this
      // is identical to the old circular-clamp feel. Past it, scale can
      // exceed 1 by ~3% at the corners — per-axis re-clamp absorbs it,
      // so the output is always in [-1, 1].
      const scale = (m - dz) / ((1 - dz) * m);
      this.x = clamp(dx * scale, -1, 1);
      this.y = clamp(dy * scale, -1, 1);
    }
    this.render();
  };

  Joystick.prototype.update = function (dt) {
    if (!this.active) {
      const k = 1 - Math.exp(-dt * 20);
      if (this.springX) {
        this.x += (0 - this.x) * k;
        if (Math.abs(this.x) < 0.003) this.x = 0;
      }
      if (this.springY && !this.holdY) {
        this.y += (0 - this.y) * k;
        if (Math.abs(this.y) < 0.003) this.y = 0;
      }
    }
    this.holdY = false;
    this.render();
  };

  Joystick.prototype.render = function () {
    const t = this._travel;
    this.knob.style.transform =
      'translate(' + (this.x * t).toFixed(1) + 'px,' + (this.y * t).toFixed(1) + 'px)';
  };

  const Input = {
    left: null,
    right: null,
    keys: Object.create(null),
    throttleSpring: false,
    onArmToggle: null,
    onReset: null,

    _state: { throttle: 0, yaw: 0, pitch: 0, roll: 0 },

    init: function () {
      const self = this;

      installIOSGuards();

      this.left = new Joystick(document.getElementById('stick-left'), {
        springX: true,
        springY: false,
        deadzone: 0.10
      });

      this.right = new Joystick(document.getElementById('stick-right'), {
        springX: true,
        springY: true,
        deadzone: 0.10
      });

      window.addEventListener('keydown', function (e) {
        Audio.resume();
        if (e.repeat) return;
        self.keys[e.code] = true;

        if (e.code === 'Space') {
          e.preventDefault();
          if (self.onArmToggle) self.onArmToggle();
        }
        if (e.code === 'KeyR') {
          e.preventDefault();
          if (self.onReset) self.onReset();
        }
        if (e.code.indexOf('Arrow') === 0) e.preventDefault();
      });

      window.addEventListener('keyup', function (e) {
        self.keys[e.code] = false;
      });

      window.addEventListener('blur', function () {
        self.keys = Object.create(null);
      });

      window.addEventListener('resize', function () { self.resize(); });
      window.addEventListener('orientationchange', function () {
        setTimeout(function () { self.resize(); }, 250);
      });

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', function () {
          self.resize();
        });
        window.visualViewport.addEventListener('scroll', function () {
          self.resize();
        });
      }
    },

    resize: function () {
      if (!this.left) return;
      this.left.measure();
      this.right.measure();
      this.left.render();
      this.right.render();
    },

    update: function (dt) {
      const k = this.keys;

      if (!this.left.active) {
        let d = 0;
        if (k['KeyW']) d += 1;
        if (k['KeyS']) d -= 1;
        if (d !== 0) {
          const thr = clamp((1 - this.left.y) * 0.5 + d * 1.5 * dt, 0, 1);
          this.left.y = 1 - thr * 2;
          this.left.holdY = true;
        }
      }

      this.left.update(dt);
      this.right.update(dt);

      const throttle = clamp((1 - this.left.y) * 0.5, 0, 1);

      let yaw = this.left.x;
      if (!this.left.active) {
        if (k['KeyA']) yaw = -1;
        else if (k['KeyD']) yaw = 1;
      }

      let pitch = -this.right.y;
      let roll  =  this.right.x;

      if (!this.right.active) {
        if (k['ArrowUp'])         pitch =  1;
        else if (k['ArrowDown'])  pitch = -1;
        if (k['ArrowRight'])      roll  =  1;
        else if (k['ArrowLeft'])  roll  = -1;
      }

      this._state.throttle = throttle;
      this._state.yaw   = clamp(yaw,   -1, 1);
      this._state.pitch = clamp(pitch, -1, 1);
      this._state.roll  = clamp(roll,  -1, 1);

      return this._state;
    }
  };

  return Input;
})();
