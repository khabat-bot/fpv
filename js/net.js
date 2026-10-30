/* =========================================================================
   net.js — WebSocket client for FPV Sim multiplayer.

   Public API:
     Net.on(event, fn)          // 'joined'|'peer_join'|'peer_leave'|
                                // 'state'|'error'|'disconnected'
     Net.create(loadout)        // Promise<{room, pid}>
     Net.join(room, loadout)    // Promise<{room, pid, others}>
     Net.leave()
     Net.sendState(drone)       // throttled to 30 Hz internally
     Net.tick(dt)               // call every frame; drives send throttle
     Net.isConnected()
     Net.getMyPid(), Net.getRoom()

   Throttling: sendState() is a no-op if <33ms since last send. tick()
   decrements the timer each frame. This gives ~30 Hz to the server with
   zero burst behavior.

   No dependencies beyond the browser WebSocket API.
   ========================================================================= */
'use strict';

window.Net = (function () {
  let ws = null;
  let connected = false;
  let myPid = null;
  let roomId = null;
  let sendTimer = 0;
  const SEND_PERIOD = 0.033;  // 30 Hz

  const listeners = {
    created: [],
    joined: [],
    peer_join: [],
    peer_leave: [],
    state: [],
    error: [],
    disconnected: []
  };

  function wsUrl() {
    var proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function on(ev, fn) {
    if (listeners[ev]) listeners[ev].push(fn);
  }
  function emit(ev, data) {
    var arr = listeners[ev] || [];
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](data); } catch (e) { /* swallow listener errors */ }
    }
  }

  function connect(action, opts) {
    return new Promise(function (resolve, reject) {
      try {
        ws = new WebSocket(wsUrl());
      } catch (e) {
        reject(e);
        return;
      }
      var settled = false;
      var timeout = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('connect timeout'));
      }, 5000);

      ws.onopen = function () {
        try {
          ws.send(JSON.stringify(Object.assign({ t: action }, opts || {})));
        } catch (e) {
          if (!settled) { settled = true; clearTimeout(timeout); reject(e); }
        }
      };

      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }

        if (msg.t === 'created' || msg.t === 'joined') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            myPid = msg.pid;
            roomId = msg.room;
            connected = true;
            resolve(msg);
          }
        } else if (msg.t === 'error') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch (e) {}
            reject(new Error(msg.msg || 'server error'));
          }
          emit('error', msg);
          return;
        }
        emit(msg.t, msg);
      };

      ws.onerror = function () {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('ws error'));
        }
      };

      ws.onclose = function () {
        var wasConnected = connected;
        connected = false;
        ws = null;
        myPid = null;
        roomId = null;
        if (wasConnected) emit('disconnected');
      };
    });
  }

  function create(loadout) {
    return connect('create', { loadout: loadout || null });
  }
  function join(room, loadout) {
    return connect('join', { room: room, loadout: loadout || null });
  }
  function leave() {
    if (ws) {
      try { ws.send(JSON.stringify({ t: 'leave' })); } catch (e) {}
      try { ws.close(); } catch (e) {}
    }
  }
  function tick(dt) {
    if (sendTimer > 0) sendTimer -= dt;
  }
  function sendState(drone) {
    if (!connected || !ws) return;
    if (sendTimer > 0) return;
    sendTimer = SEND_PERIOD;
    try {
      ws.send(JSON.stringify({
        t: 'state',
        p: [drone.position.x, drone.position.y, drone.position.z],
        q: [drone.quat.x, drone.quat.y, drone.quat.z, drone.quat.w],
        v: [drone.velocity.x, drone.velocity.y, drone.velocity.z],
        armed: !!drone.armed,
        crashed: !!drone.crashed
      }));
    } catch (e) { /* ignore */ }
  }

  return {
    on: on,
    create: create,
    join: join,
    leave: leave,
    sendState: sendState,
    tick: tick,
    isConnected: function () { return connected; },
    getMyPid: function () { return myPid; },
    getRoom: function () { return roomId; }
  };
})();
