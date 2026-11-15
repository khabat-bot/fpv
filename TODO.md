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

- [x] Crash severity drives the feed: a light tumble keeps the picture, a hard
      hit kills the link. `Drone.crash(impactSpeed)` records a 0-1 severity and
      `Drone.impact()` grades every collision path (see 3. Physics fidelity).

### 4. Physics fidelity

`js/physics.js` is rate-based (Betaflight-style): great feel, short step from complete.

- [x] Motor/ESC response lag and rotor inertia (rate ramps, not instant)
      Thrust is a first-order lag on the command (`CFG.esc.spinUp` 32 ms,
      `spinDown` 70 ms — props coast down slower than they spin up), and the
      rate target lags the stick by `CFG.esc.rateLag` (15 ms). Steady state is
      unchanged, so hover trim and the loadout T/W table still hold; only
      transients ramp.
- [x] Full 6-DOF option: torque + inertia tensor instead of rate targets, gyro drift
      SETTINGS → FLIGHT → Physics: RATE (default, the Betaflight feel that was
      already there) or 6-DOF. In 6-DOF the rate error becomes a motor torque
      (N·m, capped by `CFG.physics.maxTorque`), the torque acts on the body
      inertia tensor (yaw inertia is the largest, so yaw is the slowest axis),
      and a wandering gyro bias (`CFG.physics.gyroDrift`) makes the realised
      rate drift off the commanded one. Gains are calibrated to `torqueRef`, so
      the sticks feel the same in both modes.
- [x] Air density / temperature effects on thrust
      `Drone._airDensityRatio()` runs the ISA troposphere model from the drone's
      altitude, normalised to the 1.225 kg/m³ sea-level air the model is tuned
      for (`CFG.environment`: `tempC`, `seaLevelPressure`, `density`). Thin air
      at altitude costs thrust and drag; cold air adds punch. At the default
      15 °C, ground level is a ratio of 1.00, so the baseline is unchanged.
- [x] Damage model: impacts are graded. `Drone.impact()` damages the airframe
      above `CFG.crashSeverity.damageSpeed` and crashes above `CFG.crashSpeed`,
      with a 0-1 severity driving the video feed (prop-strike sound, DMG in the
      OSD)
- [x] Damage beyond one arm: multiple stages, asymmetric thrust, wobble that
      grows with damage
      `CFG.crashSeverity.stages` has four levels (clean + 3). Each hit above
      damageSpeed advances one stage, at most once per `damageCooldown` (0.35 s)
      so one ground scrape cannot shred the whole airframe at once. Every stage
      costs peak thrust and rotational authority, takes part of one motor's
      share away (`asymmetry` — the airframe also rolls/pitches toward the dead
      corner) and adds an attitude tremor plus thrust modulation (`wobble`).
      The OSD shows `ARMED · DMG`, then `ARMED · DMG 2`, `ARMED · DMG 3`; a
      respawn clears it.

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
