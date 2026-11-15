# TODO

## Done

- FIXED: two errors sometimes happen when first opening the page:
  1. `TypeError: Audio.update is not a function` (`Audio.update(viewDrone, hudStick, camera)`, `Audio.update` is undefined)
  2. `ReferenceError: Can't find variable: Drone` (`js/main.js:69`)
  Fixed by the boot guard in `js/main.js` (DEPENDENCIES check + cache-busted re-inject).

## Roadmap — path to a complete sim

Mobile-first: iOS Safari is the primary target. Priorities 1-4 below are what a
player on an iPhone feels in the first session; do them before the content work.

### 1. iOS touch-first playability (felt immediately)

The page loads, but there is no game shell around the canvas on iOS. Nothing in
`js/` or `css/` handles any of the following (`grep` for fullscreen / WakeLock /
visibilitychange / pointerrawupdate finds nothing):

- [ ] Fullscreen + landscape lock (Screen Orientation API / Fullscreen API,
      with a fallback rotate-your-phone overlay in portrait) — otherwise the
      attempt-to-scroll address bar eats vertical space and taps can zoom
- [ ] Screen Wake Lock (`navigator.wakeLock`) so the display doesn't dim mid-flight
- [ ] Disable double-tap zoom / pinch on the stick area — current guard in
      `Input.installIOSGuards()` kills the *second* `touchend` within 350 ms,
      which also eats fast touch-release-again stick input (`js/input.js:47`)
- [ ] Pause + resume audio and freeze the sim on `visibilitychange`
      (currently a lock-screen/background tab keeps the game loop running,
      and `SimAudio` may be suspended without anything noticing)
- [ ] Replace 120/240 Hz tuning with `maxTouchPoints`/device-class detection and
      avoid the iPhone 60 Hz display oversampling the physics loop
- [ ] Cap `devicePixelRatio` for render resolution — HIGH dpr = 2.0 is the
      default on desktop, MED on mobile, but there is no cap for iPhone 3x
      screens (the main cause of iOS heat/throttle)
- [ ] `-webkit-fill-available` + `100dvh` for the viewport so the canvas doesn't
      jump when the Safari toolbar collapses (CSS currently uses safe-area
      insets only)
- [ ] WebAudio unlock on the first user gesture already exists in `input.js`,
      but `SimAudio` never resumes after the iOS silent switch or a call — add
      vendor interruption handling (`AudioContext.onstatechange`)

### 2. Real RC controller support

No gamepad/Bluetooth/USB input exists yet; only keyboard + virtual sticks.

- [ ] ELRS/CRSF over USB (WebHID) or serial bridge
- [ ] Bluetooth gamepad fallback
- [ ] Channel order, stick travel, deadband settings
- [ ] Failsafe behavior on dropped link (controlled drop-out, not instant crash)

### 2. FPV video feed realism

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

### 3. Physics fidelity

`js/physics.js` is rate-based (Betaflight-style): great feel, short step from complete.

- [ ] Motor/ESC response lag and rotor inertia (rate ramps, not instant)
- [ ] Full 6-DOF option: torque + inertia tensor instead of rate targets, gyro drift
- [ ] Air density / temperature effects on thrust
- [ ] Damage model: `Drone.crash()` is binary (js/physics.js:102) — broken arm,
      reduced thrust, prop-strike sounds before the crash

### 4. Content library

Only one procedural world ships; the GLB importer (`js/loader.js`) is ready.

- [ ] Map/gate pack + browser catalog
- [ ] User-submitted maps reusing the existing `/upload-map` flow
- [ ] Time attack with splits (racing.js has laps, no splits yet)
- [ ] Persistent best times / leaderboard

### 5. Multiplayer hardening

The server is a dumb non-authoritative relay.

- [ ] Server-computed lap times/splits (clients can't be trusted with timing)
- [ ] Anti-cheat sanity checks on state deltas (rate limit exists,
      plausibility checks don't)

### 6. Telemetry & analysis

- [ ] Live attitude graph (pitch/roll/yaw over time)
- [ ] Blackbox-style CSV export of per-axis data (replay export exists,
      but as a recording file, not structured data)

### 7. Engineering

- [ ] Unit tests + CI: physics, net protocol, loadout math
      (no tests exist at all)
- [ ] Server protocol parity tests between `server.py` and `server.rs`
- [ ] Protocol spec doc derived from the server.py docstring, kept in sync
      with both servers
