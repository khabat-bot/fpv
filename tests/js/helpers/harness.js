/* =========================================================================
   harness.js — load the sim's plain <script> modules in a Node VM.

   The game has no module system: every file is an IIFE that attaches a
   global to `window`. To test it without a browser or jsdom, each module
   is executed in a fresh VM context whose `window` is the context itself.
   Three.js is loaded from vendor/ exactly like index.html does, so the
   flight model runs against the same build the page uses.

   Dependency-free on purpose — matches the project's stdlib-only rule.
   ========================================================================= */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

/* Deterministic Math.random so the flight model (which adds prop-wash
   noise) produces repeatable results. mulberry32. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A virtual clock with the timer API the modules use. Timers only fire
   when a test advances the clock, so nothing races and nothing leaks. */
function createTimers(startAt) {
  let now = startAt || 0;
  let seq = 0;
  const jobs = new Map();

  function schedule(fn, ms, every) {
    const delay = Number(ms);
    const id = ++seq;
    jobs.set(id, {
      fn: fn,
      at: now + (isFinite(delay) && delay > 0 ? delay : 0),
      every: every ? Math.max(1, isFinite(delay) ? delay : 1) : 0
    });
    return id;
  }

  function cancel(id) {
    jobs.delete(id);
  }

  return {
    now: () => now,
    performance: { now: () => now },
    setTimeout: (fn, ms) => schedule(fn, ms, false),
    clearTimeout: cancel,
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearInterval: cancel,
    pending: () => jobs.size,
    /* Run every callback due within `ms`, in chronological order. */
    advance: function (ms) {
      const target = now + (Number(ms) || 0);
      let guard = 0;
      for (;;) {
        let pick = null;
        for (const entry of jobs) {
          if (entry[1].at <= target && (!pick || entry[1].at < pick[1].at)) pick = entry;
        }
        if (!pick) break;
        if (++guard > 20000) throw new Error('timer storm — check interval periods');
        const id = pick[0];
        const job = pick[1];
        now = job.at;
        if (job.every) job.at = now + job.every;
        else jobs.delete(id);
        job.fn();
      }
      now = target;
    }
  };
}

function makeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {
      setProperty: function () {},
      getPropertyValue: function () { return ''; },
      removeProperty: function () {}
    },
    classList: {
      add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; }
    },
    dataset: {},
    children: [],
    width: 300,
    height: 150,
    clientWidth: 300,
    clientHeight: 150,
    appendChild: function (child) { this.children.push(child); return child; },
    removeChild: function (child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k] === undefined ? null : this[k]; },
    getContext: function () { return null; },
    getBoundingClientRect: function () {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    },
    focus: function () {},
    blur: function () {},
    click: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  };
  return el;
}

function makeDocument() {
  const body = makeElement('body');
  return {
    body: body,
    head: makeElement('head'),
    documentElement: makeElement('html'),
    hidden: false,
    visibilityState: 'visible',
    fullscreenElement: null,
    createElement: function (tag) { return makeElement(tag); },
    createElementNS: function (ns, tag) { return makeElement(tag); },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    removeEventListener: function () {},
    exitFullscreen: function () { return Promise.resolve(); }
  };
}

function createContext(opts) {
  opts = opts || {};
  const timers = opts.timers || createTimers(opts.startTime || 0);
  const logs = [];
  const math = Object.create(Math);
  math.random = mulberry32(opts.seed === undefined ? 12345 : opts.seed);

  const silent = { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} };
  const capture = {
    log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
    warn: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
    error: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
    info: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
    debug: function () { logs.push(Array.prototype.join.call(arguments, ' ')); }
  };

  const sandbox = {
    console: opts.captureLogs ? capture : silent,
    Math: math,
    performance: timers.performance,
    timers: undefined,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    document: opts.document || makeDocument(),
    navigator: opts.navigator || { getGamepads: function () { return []; } },
    location: opts.location || { protocol: 'http:', host: 'localhost:8080', href: 'http://localhost:8080/' },
    fetch: opts.fetch || function () { return Promise.reject(new Error('fetch not stubbed')); },
    WebSocket: opts.WebSocket,
    indexedDB: opts.indexedDB,
    requestAnimationFrame: function () { return 0; },
    cancelAnimationFrame: function () {},
    __logs: logs
  };

  /* window === global, like a browser. Also makes `self` work. */
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__timers = timers;
  sandbox.__seed = function (seed) { math.random = mulberry32(seed); };

  vm.createContext(sandbox);
  return sandbox;
}

function loadScript(ctx, rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error('missing script: ' + rel);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: rel });
}

/* Load vendor/three.min.js plus the named game scripts, in order. */
function loadSim(scripts, opts) {
  const ctx = createContext(opts);
  loadScript(ctx, 'vendor/three.min.js');
  (scripts || []).forEach(function (s) { loadScript(ctx, s); });
  return ctx;
}

function input(overrides) {
  return Object.assign({ throttle: 0, roll: 0, pitch: 0, yaw: 0 }, overrides || {});
}

/* Run the flight model for `seconds` at a fixed step. */
function fly(drone, seconds, step, stick) {
  const dt = step || 1 / 240;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) drone.step(dt, stick || input());
  return drone;
}

module.exports = {
  ROOT: ROOT,
  createTimers: createTimers,
  createContext: createContext,
  loadScript: loadScript,
  loadSim: loadSim,
  input: input,
  fly: fly,
  mulberry32: mulberry32
};
