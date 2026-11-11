/* =========================================================================
   net.js — WebSocket client for FPV Sim multiplayer.

   Public API:
     Net.on(event, fn)          // 'joined'|'peer_join'|'peer_leave'|
                                 // 'state'|'error'|'disconnected'|
                                 // 'reconnected'|'room_lost'|'map_change'|
                                 // 'latency'
     Net.create(loadout, nickname, options) // options: {public, name}
     Net.join(room, loadout, nickname)      // Promise<{room, pid, others}>
     Net.leave()
     Net.listServers()          // Promise<[{room, name, host, players, max, full}]>
     Net.sendState(drone)       // throttled to 30 Hz internally
     Net.tick(dt)               // call every frame; drives send throttle
     Net.isConnected()
     Net.getMyPid(), Net.getRoom(), Net.getLatency(), Net.getPlayerCount()

   Reliability:
     * Application-level ping/pong every 15 s keeps tunnels/proxies from
       closing an otherwise idle game socket and detects half-open links.
     * Reconnect uses exponential backoff with jitter and preserves the
       room code, loadout and nickname from the original join/create.
     * Leaving a room is explicit: it suppresses the "disconnected" event
       and the reconnect loop so the UI can return cleanly to the lobby.
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
  let reconnecting = false;
  let leaving = false;
  let latency = 0;

  const PING_PERIOD_MS = 15000;
  const PONG_TIMEOUT_MS = 12000;
  let pingTimer = null;
  let pingPendingAt = 0;
  let sawPong = false;

  let stateSeq = 0;
  const peers = new Set();

  const listeners = {
    created: [],
    joined: [],
    peer_join: [],
    peer_leave: [],
    state: [],
    error: [],
    disconnected: [],
    reconnected: [],
    room_lost: [],
    map_change: [],
    latency: []
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

  function startPing() {
    stopPing();
    pingPendingAt = 0;
    sawPong = false;
    pingTimer = setInterval(pingLoop, PING_PERIOD_MS);
    pingLoop();
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    pingPendingAt = 0;
    sawPong = false;
  }

  function pingLoop() {
    if (!connected || !ws) return;

    var now = Date.now();
    if (pingPendingAt) {
      if (now - pingPendingAt > PONG_TIMEOUT_MS) {
        // Once the server has proven it understands ping/pong, a missing
        // reply means the link is half-open. Close it and let the normal
        // reconnect path take over. Against an older server we stay quiet.
        if (sawPong) {
          try { ws.close(); } catch (e) {}
        }
        pingPendingAt = 0;
      }
      return;
    }

    pingPendingAt = now;
    try {
      ws.send(JSON.stringify({ t: 'ping', ts: now }));
    } catch (e) {
      pingPendingAt = 0;
    }
  }

  function resetPeers(others) {
    peers.clear();
    (others || []).forEach(function (o) {
      if (o && o.pid) peers.add(o.pid);
    });
  }

  function connect(action, opts) {
    return new Promise(function (resolve, reject) {
      var sock;
      try {
        sock = new WebSocket(wsUrl());
      } catch (e) {
        reject(e);
        return;
      }
      ws = sock;
      leaving = false;

      var settled = false;
      var timeout = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch (e) {}
        reject(new Error('connect timeout'));
      }, 5000);

      sock.onopen = function () {
        if (ws !== sock) return;
        try {
          sock.send(JSON.stringify(Object.assign({ t: action }, opts || {})));
        } catch (e) {
          if (!settled) { settled = true; clearTimeout(timeout); reject(e); }
        }
      };

      sock.onmessage = function (ev) {
        if (ws !== sock) return;
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }

        if (msg.t === 'pong') {
          if (pingPendingAt) {
            var rtt = Math.max(0, Date.now() - pingPendingAt);
            latency = latency ? (latency * 0.7 + rtt * 0.3) : rtt;
            pingPendingAt = 0;
            sawPong = true;
            emit('latency', { rtt: latency });
          }
          return;
        }

        if (msg.t === 'created' || msg.t === 'joined') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            myPid = msg.pid;
            roomId = msg.room;
            connected = true;
            reconnectDelay = 1000;
            lastAction = { action: action, opts: opts, lastRoom: msg.room };
            resetPeers(msg.others || []);
            startPing();
            resolve(msg);
          }
          emit(msg.t, msg);
          if (reconnecting) {
            reconnecting = false;
            emit('reconnected', msg);
          }
          return;
        }

        if (msg.t === 'peer_join') {
          if (msg.pid) peers.add(msg.pid);
        } else if (msg.t === 'peer_leave') {
          peers.delete(msg.pid);
        }

        if (msg.t === 'error') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            try { sock.close(); } catch (e) {}
            reject(new Error(msg.msg || 'server error'));
          }
          emit('error', msg);
          return;
        }
        emit(msg.t, msg);
      };

      sock.onerror = function () {
        if (ws !== sock) return;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('ws error'));
        }
      };

      sock.onclose = function () {
        if (ws !== sock) return;
        var wasConnected = connected;
        connected = false;
        stopPing();
        ws = null;
        myPid = null;
        roomId = null;
        latency = 0;
        peers.clear();

        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('connection closed'));
          return;
        }

        // Explicit leave: do not show a reconnect error or schedule a retry.
        if (leaving) {
          leaving = false;
          reconnectDelay = 1000;
          return;
        }

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
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (connected || !lastAction) return;

      console.log('[Net] reconnect attempt...');
      reconnecting = true;
      var act = (lastAction.action === 'create' && lastAction.lastRoom) ? 'join' : lastAction.action;
      var opts = Object.assign({}, lastAction.opts);
      if (act === 'join' && lastAction.lastRoom) opts.room = lastAction.lastRoom;

      connect(act, opts).catch(function (e) {
        reconnecting = false;
        if (e.message === 'room not found' || e.message === 'room full') {
          console.log('[Net] room gone, stopping reconnect');
          lastAction = null;
          emit('room_lost');
          return;
        }
        reconnectDelay = Math.min(Math.round(reconnectDelay * 2 * (0.8 + Math.random() * 0.4)), 16000);
        scheduleReconnect();
      });
    }, reconnectDelay);
  }

  function create(loadout, nickname, options) {
    options = options || {};
    return connect('create', {
      loadout: loadout || null,
      nickname: nickname || 'Pilot',
      public: !!options.public,
      name: options.name || ''
    });
  }
  function join(room, loadout, nickname) {
    return connect('join', { room: room, loadout: loadout || null, nickname: nickname || 'Pilot' });
  }
  function listServers() {
    return fetch('./servers', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('server list unavailable');
      return r.json();
    }).then(function (j) {
      return (j && j.rooms) || [];
    });
  }
  function uploadMap(room, file, pid) {
    var url = '/upload-map?room=' + encodeURIComponent(room);
    if (pid) url += '&pid=' + encodeURIComponent(pid);
    return fetch(url, {
      method: 'POST',
      body: file
    }).then(function (r) {
      if (!r.ok) throw new Error('Upload failed');
    });
  }
  function leave() {
    lastAction = null;
    reconnecting = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    leaving = true;

    if (ws) {
      try { ws.send(JSON.stringify({ t: 'leave' })); } catch (e) {}
      try { ws.close(); } catch (e) {}
    } else {
      leaving = false;
    }

    stopPing();
    connected = false;
    myPid = null;
    roomId = null;
    latency = 0;
    peers.clear();
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
        n: ++stateSeq,
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
    listServers: listServers,
    sendState: sendState,
    tick: tick,
    isConnected: function () { return connected; },
    getMyPid: function () { return myPid; },
    getRoom: function () { return roomId; },
    getLatency: function () { return latency; },
    getPlayerCount: function () { return connected ? peers.size + 1 : 0; },
    uploadMap: uploadMap
  };
})();
