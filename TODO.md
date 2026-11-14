# TODO

## Done

- FIXED: two errors sometimes happen when first opening the page:
  1. `TypeError: Audio.update is not a function` (`Audio.update(viewDrone, hudStick, camera)`, `Audio.update` is undefined)
  2. `ReferenceError: Can't find variable: Drone` (`js/main.js:69`)
  Fixed by the boot guard in `js/main.js` (DEPENDENCIES check + cache-busted re-inject).

## Roadmap — path to a complete sim

### 1. Real RC controller support (highest priority)

No gamepad/Bluetooth/USB input exists yet; only keyboard + virtual sticks.

- [ ] ELRS/CRSF over USB (WebHID) or serial bridge
- [ ] Bluetooth gamepad fallback
- [ ] Channel order, stick travel, deadband settings
- [ ] Failsafe behavior on dropped link (controlled drop-out, not instant crash)

### 2. FPV video feed realism

Camera is a clean 3D render + shake; needs to emulate the VTX link.

- [ ] Configurable feed latency (50-100 ms) with a buffered pose buffer
      (same interpolation trick as `js/mp.js` uses for remote drones)
- [ ] Noise/static on weak signal, artifact bursts
- [ ] Signal-loss screen tied to distance/obstructions (BVH raycast to map)
- [ ] Optional lens distortion / color-grade pass

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
