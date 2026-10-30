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
  let lastAction = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  const listeners = {
    created: [],
    joined: [],
    peer_join: [],
    peer_leave: [],
    state: [],
    error: [],
    disconnected: [],
    room_lost: [],
    map_change: []
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
            reconnectDelay = 1000;
            lastAction = { action: action, opts: opts, lastRoom: msg.room };
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
        if (wasConnected) {
          emit('disconnected');
          scheduleReconnect();
        }
      };
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (!lastAction) return;
    reconnectTimer = setTimeout(function() {
      reconnectTimer = null;
      if (!connected && lastAction) {
        console.log('[Net] reconnect attempt...');
        var act = (lastAction.action === 'create' && lastAction.lastRoom) ? 'join' : lastAction.action;
        var opts = Object.assign({}, lastAction.opts);
        if (act === 'join' && lastAction.lastRoom) opts.room = lastAction.lastRoom;
        
        connect(act, opts).catch(function(e) {
          if (e.message === 'room not found' || e.message === 'room full') {
            console.log('[Net] room gone, stopping reconnect');
            lastAction = null;
            emit('room_lost');
            return;
          }
          reconnectDelay = Math.min(reconnectDelay * 2, 16000);
          scheduleReconnect();
        });
      }
    }, reconnectDelay);
  }

  function create(loadout, nickname) {
    return connect('create', { loadout: loadout || null, nickname: nickname || 'Pilot' });
  }
  function join(room, loadout, nickname) {
    return connect('join', { room: room, loadout: loadout || null, nickname: nickname || 'Pilot' });
  }
  function uploadMap(room, file) {
    return fetch('/upload-map?room=' + encodeURIComponent(room), {
      method: 'POST',
      body: file
    }).then(function(r) {
      if (!r.ok) throw new Error('Upload failed');
    });
  }
  function leave() {
    lastAction = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
    getRoom: function () { return roomId; },
    uploadMap: uploadMap
  };
})();
