# TODO

## Done

- FIXED: two errors sometimes happen when first opening the page:
  1. `TypeError: Audio.update is not a function` (`Audio.update(viewDrone, hudStick, camera)`, `Audio.update` is undefined)
  2. `ReferenceError: Can't find variable: Drone` (`js/main.js:69`)
  Fixed by the boot guard in `js/main.js` (DEPENDENCIES check + cache-busted re-inject).

## Roadmap — path to a complete sim

Mobile-first: iOS Safari is the primary target. Priorities 1-4 below are what a
player on an iPhone feels in the first session; do them before the content work.

### 1. iOS touch-first playability (felt immediately) — done

The page loads, but the game shell around the canvas on iOS was incomplete.
All of the shell helpers now live in `js/lifecycle.js` as `window.IOS` and
are wired from `js/main.js`.

- [x] Keep screen awake, always on, no setting. Wake lock is requested on
      load and re-requested on every return to the tab, released only while
      hidden. iOS Safari has no `navigator.wakeLock`; there the user must set
      Settings > Display > Auto-Lock > Never. Android and desktop Chrome/Edge
      hold the lock automatically. An earlier SETTINGS "KEEP AWAKE" toggle
      was removed.
- [x] Pause on background. The loop keeps its rAF handle armed but `frame()`
      returns early while paused, before physics, input, net, replay, audio,
      and render. On return `dt` is recomputed from that frame, so the quad
      never jumps or teleports.
- [x] Audio suspension on hide (`SimAudio.suspend()`), restoring on return.
      No `AudioContext.resume()` is attempted from the handler because iOS
      rejects it outside a gesture; the next stick/key touch does it via
      `resumeAudio()` in `js/input.js`.
- [x] Stick-area double-tap guard is stick-aware: the 350 ms second-`touchend`
      cancel in `Input.installIOSGuards()` is skipped when the tap lands on
      `#stick-left`/`#stick-right`, so a quick release-and-regrip no longer
      kills the stick. Double-tap zoom is still cancelled everywhere else.
- [x] Rotate hint: `#rotate-hint` is shown via `body.portrait` only for
      portrait, touch devices (not iPad landscape, not a narrow desktop
      window). It is purely visual (`pointer-events: none`) and disappears in
      landscape.
- [x] Viewport height (`--vh`) is driven from `visualViewport`, so the
      floating Safari toolbar does not leave a black strip or jump the
      canvas.
- [x] Fullscreen is manual only: a SETTINGS > GENERAL > Display button using
      the standard plus webkit-prefixed APIs (Android / desktop). It never
      fires automatically on load. iOS Safari tabs have no element
      fullscreen, so the button is labelled FULLSCREEN N/A there. Landscape
      lock cannot be forced in a Safari tab; the rotate hint is the
      substitute.

Still open in this area:

- [ ] Physics rate is sized from the real display refresh rate instead of a
      fixed 120 Hz on mobile (a 60 Hz iPhone serves twice as many substeps
      as it can draw).
- [ ] Render DPR cap resolves against the actual backing-store ratio rather
      than `devicePixelRatio` (iPhone 3x renders 2x on HIGH; cheap phones
      warm up).

### 2. Real RC controller support

No gamepad/Bluetooth/USB input exists yet; only keyboard + virtual sticks.

- [ ] ELRS/CRSF over USB (WebHID) or serial bridge
- [ ] Bluetooth gamepad fallback
- [ ] Channel order, stick travel, deadband settings
- [ ] Failsafe behavior on dropped link (controlled drop-out, not instant crash)

### 3. FPV video feed realism

Camera is a clean 3D render + shake; needs to emulate the VTX link.

- [x] Configurable feed latency (50-100 ms) with a buffered pose buffer
      (same interpolation trick as `js/mp.js` uses for remote drones)
- [x] Noise/static on weak signal, artifact bursts
- [x] Signal-loss screen tied to distance/obstructions (BVH raycast to map)
- [x] Optional lens distortion / color-grade pass

Implemented in `js/fpv-feed.js` (SETTINGS → CAMERA: Video Feed, Feed Lag,
Link Sim, Lens). Tunables live in `CFG.fpvFeed`.

- [ ] Crash severity drives the feed: a light tumble keeps the picture, a hard
      hit kills the link. Blocked on `Drone.crash()` becoming graded instead of
      binary (see 3. Physics fidelity — damage model); today every crash shows
      NO SIGNAL until respawn.

### 4. Physics fidelity

`js/physics.js` is rate-based (Betaflight-style): great feel, short step from complete.

- [ ] Motor/ESC response lag and rotor inertia (rate ramps, not instant)
- [ ] Full 6-DOF option: torque + inertia tensor instead of rate targets, gyro drift
- [ ] Air density / temperature effects on thrust
- [ ] Damage model: `Drone.crash()` is binary (js/physics.js:102) — broken arm,
      reduced thrust, prop-strike sounds before the crash

### 5. Content library

Only one procedural world ships; the GLB importer (`js/loader.js`) is ready.

- [ ] Map/gate pack + browser catalog
- [ ] User-submitted maps reusing the existing `/upload-map` flow
- [ ] Time attack with splits (racing.js has laps, no splits yet)
- [ ] Persistent best times / leaderboard

### 6. Multiplayer hardening

The server is a dumb non-authoritative relay.

- [ ] Server-computed lap times/splits (clients can't be trusted with timing)
- [ ] Anti-cheat sanity checks on state deltas (rate limit exists,
      plausibility checks don't)

### 7. Telemetry & analysis

- [ ] Live attitude graph (pitch/roll/yaw over time)
- [ ] Blackbox-style CSV export of per-axis data (replay export exists,
      but as a recording file, not structured data)

### 8. Engineering

- [ ] Unit tests + CI: physics, net protocol, loadout math
      (no tests exist at all)
- [ ] Server protocol parity tests between `server.py` and `server.rs`
- [ ] Protocol spec doc derived from the server.py docstring, kept in sync
      with both servers
