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
      `Drone.impact()` grades every collision path (see 4. Physics fidelity).

### 4. Physics fidelity

`js/physics.js` now runs a rotor plant by default; the old rate loop is still
selectable. SETTINGS → FLIGHT → Physics picks the plant (`CFG.physics.model`):
REAL (`'ROTOR'`, default), 6-DOF or RATE (`'SIMPLE'`). Old `sixDof` settings
are migrated by `applyPhysicsModel()` in `js/main.js`.

- [x] Full rotor plant: four motor speeds instead of one thrust command
      (REAL). Each frame the rate PID produces a body torque demand, a
      geometric mixer splits it across the four motors (X-frame, motor order
      FR, FL, RR, RL), and each motor's RPM state is driven toward its command
      through `CFG.physics.rotor.spinUp` / `spinDown` (45 ms both — modern
      DShot ESCs brake the prop actively, so spin-down is not the old 90 ms
      free-wheel coast). Thrust is ∝ RPM² (`_collectiveThrust`), so current
      draw, thrust and control authority all move together instead of being
      independent fudges. Yaw comes from prop reaction torque (τy = −qLen·Σ
      spin·T), not from a torque cap. The result acts on the body inertia
      tensor with the ω × Iω gyroscopic term and per-rotor gyroscopic torque,
      and a per-axis rate PID (`rotor.pid`, see below) damps the motor-lag
      overshoot the way a real rate PID does. The RPM ceiling is
      the loadout's prop model (`thrustInfo.rpm` from `js/parts.js`);
      `rotor.maxRpm` is only a fallback.
- [x] Motor/ESC response lag and rotor inertia (rate ramps, not instant)
      Still applies to the legacy plants: thrust is a first-order lag on the
      command (`CFG.esc.spinUp` 32 ms, `spinDown` 70 ms), and the rate target
      lags the stick by `CFG.esc.rateLag` (15 ms). Hover trim and the loadout
      T/W table hold in every model; only transients differ.
- [x] Full 6-DOF option: torque + inertia tensor instead of rate targets, gyro drift
      6-DOF is the middle ground: the rate error becomes a motor torque
      (N·m, capped by `CFG.physics.maxTorque`), the torque acts on the body
      inertia tensor (yaw inertia is the largest, so yaw is the slowest axis),
      and a wandering gyro bias (`CFG.physics.gyroDrift`) makes the realised
      rate drift off the commanded one. Gains are calibrated to `torqueRef`, so
      the sticks feel the same as the other modes.
- [x] Asymmetric damage in the rotor plant
      Damage takes thrust away per motor rather than as a global fudge, so a
      hit pulls the airframe toward the dead corner through the same mixer that
      flies it, and `rotorRpm` telemetry shows the uneven props. The artificial
      wobble / desync / ground-effect disturbances are skipped in REAL because
      the rotor dynamics produce those transients themselves.
- [x] Body-frame drag and thrust-derived current
      Drag is evaluated per body axis (`CFG.aero.bodyDrag`), so a quad can be
      draggier edge-on or in the prop disc than lengthwise; battery current
      follows the rotor thrust instead of throttle, so punch-outs sag the LiPo
      the way a real pack does.
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

#### Realism backlog (rotor plant, in order)

The rotor plant is a real rigid body now, but several layers a physical quad
has are still missing or scripted. These are ordered by how much they change
what the sticks feel like; each one lands on its own with tests.

- [x] Real rate PID: P/I/D + feedforward instead of the first-order rate lag
      `_stepRotors()` runs a per-axis PID on the gyro rate, in
      angular-acceleration units so the sticks stay calibrated against
      `CFG.angResponse` (`rotor.pid`): P + I + FF − D, where D differentiates
      the measured rate (not the error) and is low-passed (`dLpf`), FF feeds
      the low-passed setpoint slew forward, and the I-term is clamped to a
      share of `angAccelMax` (`itermLimit`) so it can never wind up torque the
      props cannot deliver. `itermRelax` suppresses integration while the
      setpoint is slewing, and conditional integration (`itermSatRelax`) stops
      it while the mixer is clipped, which is the protection a real FC gets
      from running its loop far faster than the motors. Because the PID now
      shapes the approach, the 15 ms `esc.rateLag` is skipped in REAL (the
      legacy plants still use it).
      The I-term is what trims: with a motor down the loop holds zero rate and
      the three good corners carry the dead one, where P alone flies with a
      permanent rate offset.
- [x] Airmode behind the mixer
      The mixer computes the differential first, then airmode lifts the
      collective so the weakest motor stays at `airmodeIdle` instead of being
      clipped to zero. Without it a zero-throttle roll has two dead motors and
      almost no thrust; with it the quad keeps both. Anti-gravity
      (`antiGravity`, `antiGravityDecay`) adds a short collective kick on a
      throttle jab so a punch-out does not sag while the I-term winds up.
      In REAL the throttle/`motorAuthority` and damage `authorityScale`
      discounts on the rate target are gone as well: airmode supplies the
      low-throttle authority and the per-motor thrust loss supplies the damage
      authority, so scaling the target on top would count both twice. The
      legacy plants keep both.
- [x] Prop thrust and torque vs advance ratio (airspeed), not just RPM²
      The rotor plant scales each prop by `Ct(J)` / `Cq(J)`, where the advance
      ratio is `J = V_axial / (n·D)`. The axial inflow is the body-frame
      velocity projected on the thrust axis (so tilt and angle of attack are
      already in it) plus each arm's own `ω × r`. `js/parts.js` derives the
      per-prop coefficients from the selected prop — `jZero` (advance ratio
      at zero thrust, higher for a steeper prop) and `cqSlope` — and the
      loadout publishes them on `thrustInfo.aero`; `CFG.physics.rotor.advance`
      holds the shared curve shape and the 5" fallback.
      Thrust now falls roughly linearly with J (about −25 % at 20 m/s, zero at
      `jZero`), which gives the quad a real top-speed wall and makes a dive
      cost thrust instead of being free. Prop drag torque rises with inflow
      (`Q` is taken from the static thrust reference times `Cq(J)`), so yaw
      reaction and the load on the motors grow with airspeed. On descent the
      prop windmills into clean air for a small gain, then enters the
      vortex-ring band around `J ≈ -0.25` (the prop sits in its own wake) and
      loses ~30 % until the descent is fast enough to leave the ring. That
      replaces the legacy `CFG.propWashGain` wobble as the REAL plant's VRS.
- [x] Ground and wall effect in the rotor plant
      `_stepRotors()` now scales each prop by a proximity multiplier instead
      of the legacy random wobble (`!_rotorMode` still guards that fudge, so
      REAL no longer skips the effect):
      `CFG.physics.rotor.proximity` holds `ground`, `wall` and `ceiling`.
      The ground height under the airframe is sampled once per step (it is
      a BVH raycast on a GLB map) and each prop uses its own height above
      that plane (arm offset rotated into the world), shaped like the
      source-sink model — extra thrust rising as the disc closes on the
      surface, rolling back inside `peakHeight` as the outflow recirculates.
      That roll-over is the cushion-then-suck-down transition on landing and
      takeoff, and because the heights differ once the airframe is tilted,
      the low-side props gain more: a real torque that tips a quad off a pad
      or a curb. Disc loading (`discLoading`, scaled by RPM²) blends the
      effect down for a slowly turning disc. Walls and ceilings are found
      from the same colliders the model already collides with
      (`_surfaceProximity()`) and are gated by their own `reach`, so
      `ground.reach = 0` leaves them running; they add a small thrust
      gain/loss and push the
      airframe through `_proxAccel` — outwash with nowhere to go shoves away
      from a wall, a starved inlet under a ceiling pulls the airframe up.
      Covered by `tests/js/physics.test.js` (ground effect on the pad, the
      cushion peak above the pad, asymmetric tip on a banked quad, wall push
      and ceiling thrust loss).
- [ ] Angle-of-attack aerodynamics (lift, pitch-up, prop-disc moment)
      Drag is three fixed multipliers (`CFG.aero.bodyDrag`) on body velocity:
      no AoA dependence, no lift from the frame, no prop-disc moment. A real
      quad pitches up as speed rises and needs forward stick to hold level
      flight.
- [ ] Motor/ESC limits: torque and current limit, heat, desync, idle throttle
      RPM follows `sqrt(cmd)·maxRpm` through a first-order lag with no torque
      or current ceiling, no motor heating, no desync at high RPM and no idle
      throttle. An over-propped loadout gets slower instead of bogging or
      desyncing.
- [ ] Gyro noise, quantisation and filter group delay
      The gyro is `angVel + slow sine bias`. No white noise, no quantisation,
      no 1 kHz+ sampling, no filter delay, and the controller runs at the
      physics rate (120-240 Hz) rather than 8k/8k. Gyro noise and filter delay
      are what make high D feel nervous and a bad tune oscillate.
- [ ] Turbulence model and wind moments
      `CFG.wind` presets are a few sinusoids applied at the CG. Real
      turbulence is Dryden/von Kármán filtered noise with a scale length, a
      wind gradient with altitude, and a moment arm so gusts roll and pitch
      the airframe instead of only pushing it.
- [ ] Real mass properties: CG offset, off-diagonal inertia
      The inertia tensor is diagonal with the CG at the geometric centre, and
      `_collideBVHOnce()` uses a scalar `I = 0.003` for every impact. Battery
      placement on a real quad moves the CG (that is how you trim one), and an
      off-centre hit rotates about the true tensor.
- [ ] Geometric crash damage instead of scripted stages
      `CFG.crashSeverity.stages` are thrust/wobble scales. Real damage is per
      part: a prop-tip strike bends or breaks that prop (thrust + balance), a
      motor-bell strike kills that motor, a cracked arm flexes. Feeds the
      rotor plant's per-motor thrust and needs turtle mode to recover.
- [ ] Finer integration and RC/link realism
      Semi-implicit Euler at the physics rate is fine for feel but not for
      fast tumbles (an inner 500-1000 Hz loop, or RK4, removes that error).
      Input has deadband/travel but no frame jitter, packet loss or a true
      Betaflight "actual rates" mapping, so a real quad's rates/PID numbers do
      not drop in.

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
