# TODO

## How to read this file

An unchecked box is *not* automatically a bug: sections 5 and 6 are planned
features and hardening, not defects. "Fix the bugs in the TODO" means lines
that describe something demonstrably broken; anything else is new work. A
fixed defect is ticked with a note naming the code path and the test that
covers it, so that a stale claim is visible instead of silently misdirecting
the next change.

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

Previously open in this area (both done):

- [x] Physics rate is sized from the real display refresh rate instead of a
      fixed 120 Hz on mobile (a 60 Hz iPhone serves twice as many substeps
      as it can draw).
      `displayHz` (seeded from the `update-frequency` media feature where
      supported, then refined by measuring rAF over 1.5 s windows in
      `frame()`) drives `PHYSICS_HZ`/`FIXED` in `js/main.js`: mobile runs
      one substep per drawn frame (60 Hz iPhone → 60 Hz, clamped [60, 120]),
      desktop two per frame (120 Hz panel → 240 Hz, clamped [120, 240]). A
      60 Hz desktop now runs 120 instead of 4x-oversampled 240. The CCD
      substep cap in `js/physics.js` doubles (6 → 12) on 60 Hz steps so the
      per-substep anti-tunnelling resolution is unchanged.
- [x] Render DPR cap resolves against the actual backing-store ratio rather
      than `devicePixelRatio` (iPhone 3x renders 2x on HIGH; cheap phones
      warm up).
      Quality presets are now fractions of the ratio the canvas backing
      store actually reaches at native resolution (`measureNativeRatio()`
      sets the renderer to the reported DPR, sizes the canvas, and reads
      back `canvas.width / clientWidth`, which catches browsers/GPUs that
      clamp the backing below the reported DPR). LOW/MED/HIGH = 50/75/100%
      of native, so a 3x iPhone's HIGH renders at a true 3x, a 1.5x phone's
      MED at 1.125x, and a 2x phone reproduces the old absolute 1.0/1.5/2.0
      caps exactly. Absolute caps (auto-degrade, heavy maps) still resolve
      via `min(cap, nativeRatio)`; the preset ratio is re-resolved only
      when the measured backing ratio itself changes.

### 2. Real RC controller support — done

`js/controller.js` (`window.Controller`) turns two transports into the same
four axes the flight model already understands: throttle 0-1 and yaw / pitch /
roll -1..1. `js/input.js` asks it first every frame and mirrors the values onto
the virtual sticks, so while a controller is live it owns all four axes and a
stray screen tap or key cannot fight it. Settings live in `CFG.controller` and
are edited in SETTINGS -> INPUT; the sim itself is untouched.

- [x] ELRS/CRSF over USB serial (Web Serial)
      SETTINGS -> INPUT -> CONNECT opens an ELRS TX module / receiver
      CDC-ACM port at 420000 baud (420K / 400K / 115K selectable) and decodes
      CRSF RC_CHANNELS_PACKED (0x16): sixteen 11-bit channels at 172...1812 us,
      CRC8/DVB-S2 checked, frame sync re-found across chunked reads and garbage
      bytes, and a frame that fails its CRC never moves the sticks. A
      module that enumerates as HID is just a gamepad and arrives through the
      PAD path below; CRSF lives on serial, not WebHID. Chromium-only (Web
      Serial) and the port picker needs the CONNECT click.
- [x] Bluetooth gamepad fallback
      Gamepad API, which covers Bluetooth pads, USB pads and a radio in
      EdgeTX/OpenTX USB-joystick mode. MODE 1 / MODE 2 stick layout for
      gamepads, RADIO layout for a transmitter that sends its channels as
      axes (CH1 -> X, CH2 -> Y, CH3 -> Z, CH4 -> Rx), and pad buttons A/B arm
      and reset. A pad only shows up after it sends an event
      and the page has been clicked, so SETTINGS -> INPUT shows a live
      "press a button on the pad" state and a RESCAN button.
- [x] Channel order, stick travel, deadband settings
      AETR / TAER / RETA / ETAR channel order (CRSF), deadband 0/2/4/8 %,
      stick travel 80/90/100 % (a stick that only reaches 80 % still reaches
      full output), throttle ABS or HOLD (HOLD integrates the stick so a
      spring-centred gamepad can hold a throttle). ALL tunables in
      `CFG.controller`; the panel only writes settings.controller.
- [x] Failsafe behavior on dropped link (controlled drop-out, not instant crash)
      A live link that goes quiet for `CFG.controller.timeoutMs` (350 ms pad,
      450 ms CRSF) centres the sticks and ramps the throttle to 80 % of hover
      throttle over ~1 s, so the quad descends instead of freezing or cutting.
      After `dropSecs` (3 s) the motors cut (Betaflight stage 2) and a link
      that never returns releases the sticks back to keyboard/touch 2 s later,
      so a dead radio cannot lock the simulator out. FAILSAFE OFF holds the
      last commands instead. Link loss / restore / failsafe are announced
      on screen (`#ctl-toast`).

Limits worth knowing: the descent is sticks-centred, not self-levelling --
in ACRO a centred stick holds the current attitude, and only an angle flight
mode levels it. Real hardware was not available here, so both transports were
verified with a fake gamepad and a fake serial stream in the browser, plus the
frame parser and axis maths in a Node harness.

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

### 7. Telemetry & analysis — done

Implemented in `js/telemetry.js` (SETTINGS → TELEM). A sampling loop in
`frame()` reads the published sim state into a rolling 60 s buffer at 50 Hz
(`CFG.telemetry`); the buffer is written only while the quad is armed (the
crash frame that disarms it is kept) and is cleared on every arm, so one
log is one flight and disarmed bench time never pushes the flight out.

- [x] Live attitude graph (pitch/roll/yaw over time)
      `#attitude-graph` is an OSD canvas with three lanes — roll, pitch and
      yaw — redrawn at 20 Hz from the same buffer, scrolling over the last
      10 s at ±180° full scale. Yaw is wrapped into ±180° for the trace, so
      a multi-turn flight stays on the lane. Toggle it under SETTINGS →
      TELEM.
      Attitude comes from the quaternion: pitch/roll from a YXZ
      decomposition (pitch + = nose up, roll + = bank right) and heading
      from swing-twist, unwrapped so it grows past ±180° through turns —
      the decomposition the angle controller already documents as the only
      correct way to recover yaw from a tilted airframe.
- [x] Blackbox-style CSV export of per-axis data (replay export exists,
      but as a recording file, not structured data)
      EXPORT CSV writes `fpv-blackbox-<timestamp>.csv`: one header row and
      one row per sample with `time_ms`, throttle, stick commands, realised
      gyro rates, rate setpoints, attitude, altitude, vertical/ground speed,
      thrust, pack voltage/current/mAh and damage stage. Body axes are
      mapped to roll/pitch/yaw names (X = pitch, Y = yaw, Z = roll in this
      flight model) so the columns read like a real blackbox.

### 8. Engineering

- [x] Unit tests + CI: physics, net protocol, loadout math
      `tests/` is a dependency-free suite (`node --test` + `python3 -m
      unittest`, no installs): physics, CRSF/gamepad input, racing, loadout,
      net client, replay storage, plus the server's HTTP endpoints and WS
      relay. `./tests/run.sh` runs both halves; `.github/workflows/tests.yml`
      runs it on every push and pull request, and compiles `server.rs`.
- [x] Server protocol parity tests between `server.py` and `server.rs`
      Two layers. `test_server.py::ParityTest` pins the mirrored constants,
      endpoints and message names as source text. `test_server_parity.py`
      runs the same scenarios against both real servers on private ports —
      static/HTTP endpoints, room lifecycle and host migration, room limits,
      state relay and sanitising, state rate limiting, map upload/fetch/
      cleanup and the oversized-frame drop — and compares only normalised
      client-visible observations, so a clamp, an error string or a missing
      broadcast that drifts between the ports fails the suite. It compiles
      `server.rs` with `rustc`; without a toolchain it skips locally and
      fails under CI.
- [ ] Protocol spec doc derived from the server.py docstring, kept in sync
      with both servers

- [x] Net state relay: reject non-finite `p`/`q`/`v` when framing.
      `clean_vec` (server.py) already checks `math.isfinite` on input and
      returns None, so this was not a live bug. Defence in depth against a
      future writer that skips clean_vec is now in both servers: `frame_json`
      (server.py) serializes with `allow_nan=False` and returns None for a
      message that would emit `NaN`/`Infinity`, so the state path drops it and
      `broadcast_json` skips it; `json_is_finite` (server.rs) guards the state
      frame the same way, and the Rust JSON writer emits `null` instead of a
      non-finite literal. Covered by `test_frame_json_refuses_non_finite_numbers`
      and `test_state_with_non_finite_vector_is_dropped`.
- [x] External controller: the INPUT-tab status poller never stops.
      `startCtlStatusPoller()` (`js/main.js`) now starts the 250 ms interval
      when the settings panel opens, and `stopCtlStatusPoller()` clears it on
      the close button and the backdrop click; the tick also stops itself if
      the panel is hidden, so no interval survives the panel.
