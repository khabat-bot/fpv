# Tests

Dependency-free suite for a dependency-free project: `node --test` for the
browser modules and `python3 -m unittest` for `server.py`. No npm install,
no pip install, no build step.

```sh
./tests/run.sh          # everything
./tests/run.sh js       # browser modules
./tests/run.sh py       # server
```

The suite is also runnable directly:

```sh
node --test tests/js
python3 -m unittest discover -s tests/python -p 'test_*.py' -v
```

## How the browser modules are loaded

`js/*.js` are plain IIFEs that attach globals to `window`, and `index.html`
script order is the dependency graph. `tests/js/helpers/harness.js` builds a
Node VM context whose `window` is the context itself, loads `vendor/three.min.js`
from disk, then loads the requested game scripts in the same order the page
does. `performance.now`, timers and `Math.random` are virtual/deterministic, so
flight and timing tests are reproducible and a test never sleeps.

```js
const { loadSim, input, fly } = require('./helpers/harness.js');

const ctx = loadSim(['js/config.js', 'js/physics.js']);
const drone = new ctx.Drone();
drone.position.y = 20;
drone.armed = true;
fly(drone, 1, 1 / 240, input({ throttle: 0.5 }));
```

`ctx.__timers.advance(ms)` drives `performance.now` and any `setTimeout` /
`setInterval` callbacks registered by a module.

## What is covered

| File | Covers |
| --- | --- |
| `js/structure.test.js` | every `js/` file is in `index.html` in the documented order; `main.js` `DEPENDENCIES` stay in sync; all core globals load |
| `js/config.test.js` | `CFG` shape and ranges; `maxThrust` derivation; presets and crash stages |
| `js/physics.test.js` | thrust/gravity/hover, rate sign conventions, battery sag + cutoff, air density, crash grading, damage, easy mode, reset |
| `js/controller.test.js` | CRSF CRC/parsing/resync, channel orders, gamepad shaping, HOLD throttle, failsafe |
| `js/drills.test.js` | hover/land/figure-eight/orbit metrics |
| `js/racing.test.js` | gate crossing, lap ordering, best lap, reset |
| `js/loadout.test.js` | part catalogs, baseline composition, every part combo stays flyable, `CFG` restore |
| `js/net.test.js` | connect/join/errors, 30 Hz state throttle, ping/pong, reconnect, leave |
| `js/replay-store.test.js` | IndexedDB metadata/data separation, sorting, rename, delete |
| `python/test_server.py` | helper/frame units, HTTP endpoints, map upload, WS relay, room limits, host migration, protocol parity with `server.rs` |

## Adding a module test

1. Write `tests/js/<module>.test.js` using `node:test`.
2. Load only the scripts the module needs (`loadSim([...])`); do not load
   `main.js`, which starts the game loop.
3. If you add a new `js/` file, `structure.test.js` will fail until it is in
   `index.html` (and in `main.js` `DEPENDENCIES` if the boot guard needs it) —
   that is the point.

The server tests start a real server on an ephemeral port and use a temporary
`FPV_MAP_DIR`; they never touch `/tmp` or the network outside localhost.
