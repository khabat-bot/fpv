# AGENTS.md — FPV Sim

Browser-based FPV drone acro trainer (vanilla JS + Three.js). No build system, no
bundler, no tests. A single static site plus a small static+WebSocket server for
multiplayer and map sharing. Everything runs from a plain HTTP server on port 8080.

## Commands

```sh
python3 server.py                 # dev server (Python stdlib only, no pip deps)
# OR the Rust port (no Cargo, single file, Rust 1.70+ needed for OnceLock):
rustc -O server.rs -o rust-server
./rust-server
```

Then open `http://localhost:8080`. There is no build step, no test runner, no
linter — verification is manual in a browser.

- Env vars: `PORT` (8080), `HOST` (0.0.0.0), `FPV_MAP_DIR` (/tmp, where shared
  GLB maps are stored). Rust-only: `FPV_ROOT` (directory to serve; defaults to cwd).
- For external access (multiplayer demo): `cloudflared tunnel --protocol http2
  --url http://localhost:8080 --no-autoupdate` (see README.md).
- The `rust-server` binary is gitignored; it is never committed.

## Architecture

### There is no module system

Every file in `js/` is a plain IIFE with `'use strict'` that attaches a global to
`window`. The `<script>` tag order in `index.html` IS the dependency graph and
must be preserved:

```
vendor/three.min.js, three-mesh-bvh.umd.js, GLTFLoader.js, BufferGeometryUtils.js
js/config.js → CFG           (every flight-model tunable lives here)
js/audio.js  → SimAudio      (procedural Web Audio, no sound files)
js/world.js  → World         (procedural scenery; returns heightAt(x,z) for collision)
js/physics.js→ Drone         (rate-based acro quad + LiPo model)
js/input.js  → Input         (multi-touch virtual sticks + keyboard)
js/hud.js    → HUD           (OSD: artificial horizon + telemetry)
js/ghost-trail.js → GhostTrail
js/visuals.js→ DroneVisual   (multi-instance drone mesh; build() is a main-instance shim)
js/racing.js → Racing        (gates/laps; active ONLY when the world exports `gates`)
js/loader.js → MAP           (GLB importer; <2000 meshes = global merge, else 60m tile chunks)
js/net.js    → Net           (WebSocket client)
js/mp.js     → MP            (remote drone rendering w/ adaptive interpolation)
js/parts.js  → PARTS, Loadout
js/drills.js → Drills
js/replay-store.js → ReplayStore  (IndexedDB library)
js/replay.js → Replay        (recorder + preview playback)
js/telemetry.js → Telemetry  (blackbox recorder + live attitude graph)
js/lifecycle.js → IOS        (tab pause/resume, wake lock, --vh, fullscreen, portrait flag)
js/main.js   (bootstrap + game loop; loads LAST)
```

If you add a JS file you must (a) add a `<script>` tag in index.html in the right
position and (b) add it to the `DEPENDENCIES` array in main.js (see gotchas).

### Game loop (main.js)

`frame()` via requestAnimationFrame, at ~line 2349:

- FPS cap is a 1.5 ms early-return; `fpsCap: 0` means uncapped.
- Fixed-timestep physics: rate derived from the measured display refresh
  (`displayHz`, rAF-measured with an `update-frequency` seed): one substep per
  drawn frame on mobile clamped [60, 120] Hz, two per frame on desktop clamped
  [120, 240] Hz; accumulator pattern, `dt` clamped to 0.1 s, max 16
  substeps/frame.
- Per-frame flow: `Input.update(dt)` → state → `drone.step(FIXED, state)` →
  render + `HUD` → `Net.sendState` (~30 Hz) + `MP.update` → `Replay.record`/
  `Replay.update`.
- Camera modes: `FPV`, `TOW`, `CHASE`, `ORBIT` (settings panel, persisted).
- Settings are persisted to **both** localStorage and IndexedDB (main.js);
  nickname is in localStorage under `fpv-nickname`.

### Server (two interchangeable implementations)

`server.py` and `server.rs` are ports of the same thing: static file server +
dumb WebSocket relay (not an authoritative sim). **Any protocol change must be
made in both files to keep them in sync.**

- Endpoints: `GET /` (static), `GET /mp-status`, `GET /servers` (lobby list),
  `POST /upload-map?room=CODE`, `GET /map/<code>.glb`, `WS /ws`.
- WS protocol is JSON, `{"t": "create"|"join"|"state"|"leave"|...}`; see the
  docstring at the top of server.py for the full message list.
- Room/map codes are `[A-Z0-9]{1,12}`; max 8 players, 256 rooms, 4096-byte
  frames, state rate-limited to 60/s, 90 s idle timeout (clients ping every 15 s).
- Room player list is insertion-ordered in both implementations so host
  migration is deterministic.
- Map sharing: host uploads a GLB to `FPV_MAP_DIR` (default /tmp); other room
  members fetch it via `/map/<code>.glb` and a `map_change` WS message triggers
  reload.

## Gotchas

- **Boot guard in main.js**: plain `<script>` loads can silently drop (a
  keep-alive socket reset in an older dev server truncated responses), leaving
  main.js running without its dependencies and producing a blank page. main.js
  checks the `DEPENDENCIES` list and re-injects missing scripts with cache
  busting, up to 5 retries. New files/renames must be reflected in this list, or
  the page breaks intermittently and *only under dropped requests* — hard to
  notice in normal testing.
- **Never name a global `Audio`**: `window.Audio` is the browser's built-in
  media constructor. That's why the sound module is `SimAudio` and input.js
  guards `window.Audio` references before calling.
- **Backgrounding / screen sleep**: `js/lifecycle.js` owns this. `frame()`
  returns early while hidden (loop stays armed via its top-of-function
  `requestAnimationFrame`), so do not add work before that guard. The screen
  wake lock is always on, no setting; it can only work where
  `navigator.wakeLock` exists (Android/desktop Chrome/Edge), never in an iOS
  Safari tab, so on iPhone the user must set Settings > Display >
  Auto-Lock > Never. Do not call `AudioContext.resume()` from the visibility
  handler: iOS rejects it outside a user gesture, so audio resumes on the next
  stick/key touch (`resumeAudio()` in input.js).
- **`body.portrait`** is set by `lifecycle.js` only for touch devices narrower
  than 600 CSS px. It drives the rotate overlay (`#rotate-hint`), which is
  `pointer-events: none` so it can never eat a stick press. Landscape lock
  cannot be forced inside a Safari tab.
- **`css/tokens.css` is orphaned** — it is not referenced from index.html or
  style.css (style.css has its own `:root`). Editing it changes nothing.
- **Racing only works on the procedural world**: `racing.js` activates only when
  the current world exports `gates`. GLB maps have no gates, so on them the HUD
  shows FREE FLIGHT and lap timing is gone.
- **Loadout mutates CFG in place**: `Loadout.apply()` writes composed values
  into pristine `CFG` fields snapshotted at module load (thrust clamped to
  [1.5, 15.0] T/W). Don't add a parallel source of truth for flight model.
- **Replay preview freezes the live sim**: while `Replay.isPreviewing()` the
  accumulator is zeroed and the live drone is hidden; the replay drone drives
  pose/stick values. Any new per-frame sim work in `frame()` must respect the
  `previewWasActive` branch like the existing code does.
- **Vendor files are committed** (`vendor/three.min.js` etc., UMD builds that
  attach to `window.THREE`). They're loaded from `file://` too — keep it plain
  script tags, no ES modules.
- **Quality presets are fractions of the measured backing ratio**: LOW/MED/HIGH
  = 50/75/100% of the ratio the canvas backing store actually reaches at native
  resolution (`measureNativeRatio()` in main.js reads `canvas.width /
  clientWidth` after sizing at the reported DPR, catching GPUs that clamp
  below `devicePixelRatio`). Absolute caps (auto-degrade, heavy maps) resolve
  as `min(cap, nativeRatio)`. Default is MED on mobile, HIGH on desktop
  (mobile detected via user-agent).
- The two servers differ slightly: the Rust one honors `FPV_ROOT`; Python always
  serves from its own directory. Python previously had a TCP bug that dropped
  static responses mid-stream (that's what the boot guard protects against).

## Conventions

- Vanilla JS, no ES modules, no TypeScript; globals are the API. Match the
  existing IIFE + `window.X = (function () { ... return API; })()` shape for new
  modules (some older files use `var`; don't "fix" unrelated files to match).
- All flight-model numbers live in `js/config.js` (`window.CFG`); tunable
  behavior changes should go there, not inline.
- Server code is stdlib-only by design (no pip, no crates) — keep it that way.
- Server constants are deliberately mirrored between `server.py` and `server.rs`
  (WS_MAGIC, limits, timeouts) — change both.
