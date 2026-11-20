/* Guards the two documented "you must update this too" lists:
   index.html script order (the module dependency graph) and main.js's
   DEPENDENCIES boot guard. Adding a js/ file without touching both used
   to fail intermittently in the browser only; now it fails here. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadSim } = require('./helpers/harness.js');

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');

const scriptSrcs = Array.from(indexHtml.matchAll(/<script\s+src="([^"]+)"/g)).map((m) => m[1]);
const jsScripts = scriptSrcs.filter((s) => s.startsWith('js/'));

const EXPECTED_ORDER = [
  'js/config.js',
  'js/audio.js',
  'js/world.js',
  'js/physics.js',
  'js/controller.js',
  'js/input.js',
  'js/hud.js',
  'js/ghost-trail.js',
  'js/visuals.js',
  'js/racing.js',
  'js/loader.js',
  'js/net.js',
  'js/mp.js',
  'js/fpv-feed.js',
  'js/parts.js',
  'js/drills.js',
  'js/replay-store.js',
  'js/replay.js',
  'js/telemetry.js',
  'js/lifecycle.js',
  'js/main.js'
];

test('every js/ module on disk is loaded by index.html exactly once', () => {
  const onDisk = fs.readdirSync(path.join(ROOT, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => 'js/' + f)
    .sort();
  assert.deepEqual(jsScripts.slice().sort(), onDisk);
  assert.equal(new Set(jsScripts).size, jsScripts.length, 'duplicate <script> tag');
});

test('index.html loads the modules in the documented dependency order', () => {
  assert.deepEqual(jsScripts, EXPECTED_ORDER);
});

test('every script src in index.html exists', () => {
  for (const src of scriptSrcs) {
    assert.ok(fs.existsSync(path.join(ROOT, src)), 'missing file for script tag: ' + src);
  }
});

test('main.js DEPENDENCIES are all declared before main.js', () => {
  const deps = Array.from(
    mainJs.matchAll(/\{\s*name:\s*'[^']+',\s*src:\s*'([^']+)'/g)
  ).map((m) => m[1]);
  assert.ok(deps.length >= 8, 'expected the critical dependency list');
  for (const src of deps) {
    const at = scriptSrcs.indexOf(src);
    assert.ok(at >= 0, 'DEPENDENCIES entry not in index.html: ' + src);
    assert.ok(at < scriptSrcs.indexOf('js/main.js'), src + ' must load before main.js');
  }
});

test('stylesheet and vendor files referenced by index.html exist', () => {
  assert.match(indexHtml, /css\/style\.css/);
  assert.ok(fs.existsSync(path.join(ROOT, 'css/style.css')));
  for (const v of ['vendor/three.min.js', 'vendor/three-mesh-bvh.umd.js', 'vendor/GLTFLoader.js', 'vendor/BufferGeometryUtils.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, v)), 'missing ' + v);
  }
});

test('core modules load cleanly in dependency order and expose their globals', () => {
  const ctx = loadSim([
    'js/config.js',
    'js/physics.js',
    'js/controller.js',
    'js/parts.js',
    'js/drills.js',
    'js/racing.js',
    'js/net.js',
    'js/replay-store.js'
  ]);
  assert.equal(typeof ctx.THREE, 'object');
  assert.equal(typeof ctx.CFG, 'object');
  assert.equal(typeof ctx.Drone, 'function');
  assert.equal(typeof ctx.Controller.update, 'function');
  assert.equal(typeof ctx.PARTS, 'object');
  assert.equal(typeof ctx.Loadout.apply, 'function');
  assert.equal(typeof ctx.Drills.start, 'function');
  assert.equal(typeof ctx.Racing.update, 'function');
  assert.equal(typeof ctx.Net.join, 'function');
  assert.equal(typeof ctx.ReplayStore.put, 'function');
});

test('the sound module is named SimAudio, not Audio', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/audio.js'), 'utf8');
  assert.match(src, /window\.SimAudio\s*=/);
  assert.doesNotMatch(src, /window\.Audio\s*=/);
});
