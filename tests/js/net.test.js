/* js/net.js — WebSocket client. Uses a fake WebSocket plus the harness's
   virtual timers so connect, throttle, ping and reconnect paths can be
   exercised without a server or real waiting. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, createTimers } = require('./helpers/harness.js');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  static reset() { FakeWebSocket.instances = []; }
  static get last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }

  send(data) {
    if (this.readyState === 3) throw new Error('socket closed');
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }
  receive(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
  messages(type) {
    return this.sent.filter((m) => m.t === type);
  }
}

function setup(opts) {
  FakeWebSocket.reset();
  const timers = createTimers(0);
  const fetchCalls = [];
  const ctx = loadSim(['js/net.js'], Object.assign({
    timers,
    WebSocket: FakeWebSocket,
    fetch: function (url, init) {
      fetchCalls.push({ url: url, init: init });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ rooms: [{ room: 'ABC123', players: 2 }] }) });
    }
  }, opts || {}));
  return { ctx, Net: ctx.Net, timers, fetchCalls };
}

async function connected(Net, action, opts, response) {
  const promise = action === 'create'
    ? Net.create({ frame: 'freestyle_5' }, 'Nick', opts)
    : Net.join('ABC123', { frame: 'freestyle_5' }, 'Nick');
  const sock = FakeWebSocket.last;
  sock.open();
  sock.receive(response || {
    t: action === 'create' ? 'created' : 'joined',
    room: 'ABC123',
    pid: 'p1',
    others: []
  });
  return { msg: await promise, sock };
}

const droneStub = () => ({
  position: { x: 1, y: 2, z: 3 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  velocity: { x: 0, y: 0, z: 0 },
  armed: true,
  crashed: false
});

test('create() opens /ws and sends the create payload', async (t) => {
  const { Net, timers } = setup();
  t.after(() => Net.leave());
  const promise = Net.create({ frame: 'freestyle_5' }, 'Nick', { public: true, name: 'My Lobby' });
  const sock = FakeWebSocket.last;
  assert.equal(sock.url, 'ws://localhost:8080/ws');
  sock.open();
  const sent = sock.sent[0];
  assert.equal(sent.t, 'create');
  assert.equal(sent.nickname, 'Nick');
  assert.equal(sent.public, true);
  assert.equal(sent.name, 'My Lobby');
  assert.deepEqual(sent.loadout, { frame: 'freestyle_5' });

  sock.receive({ t: 'created', room: 'XYZ789', pid: 'abc', others: [] });
  const msg = await promise;
  assert.equal(msg.room, 'XYZ789');
  assert.equal(Net.isConnected(), true);
  assert.equal(Net.getRoom(), 'XYZ789');
  assert.equal(Net.getMyPid(), 'abc');
  assert.equal(Net.getPlayerCount(), 1);
  assert.ok(timers.pending() >= 1, 'ping interval should be armed');
});

test('join() resolves with the room and tracks existing peers', async (t) => {
  const { Net } = setup();
  t.after(() => Net.leave());
  const { msg, sock } = await connected(Net, 'join', undefined, {
    t: 'joined', room: 'ABC123', pid: 'p2', others: [{ pid: 'p1' }, { pid: 'p3' }]
  });
  assert.equal(msg.pid, 'p2');
  assert.equal(Net.getPlayerCount(), 3, 'self plus two peers');

  sock.receive({ t: 'peer_join', pid: 'p9' });
  assert.equal(Net.getPlayerCount(), 4);
  sock.receive({ t: 'peer_leave', pid: 'p1' });
  assert.equal(Net.getPlayerCount(), 3);
});

test('a server error rejects the connect promise and emits error', async (t) => {
  const { Net } = setup();
  t.after(() => Net.leave());
  const errors = [];
  Net.on('error', (e) => errors.push(e));
  const promise = Net.join('NOPE', null, 'Nick');
  const sock = FakeWebSocket.last;
  sock.open();
  sock.receive({ t: 'error', msg: 'room not found' });
  await assert.rejects(promise, /room not found/);
  assert.equal(errors.length, 1);
  assert.equal(Net.isConnected(), false);
});

test('a connect that never answers times out after 5 s', async () => {
  const { Net, timers } = setup();
  const promise = Net.join('ABC123', null, 'Nick');
  const sock = FakeWebSocket.last;
  sock.open();
  timers.advance(5000);
  await assert.rejects(promise, /connect timeout/);
  assert.equal(sock.readyState, 3, 'the socket should be closed');
});

test('state is throttled to 30 Hz and carries the drone pose', async (t) => {
  const { Net } = setup();
  t.after(() => Net.leave());
  const { sock } = await connected(Net, 'join');
  sock.sent.length = 0;

  Net.sendState(droneStub());
  Net.sendState(droneStub());
  assert.equal(sock.messages('state').length, 1, 'second call inside the window is dropped');

  Net.tick(0.04);
  Net.sendState(droneStub());
  const states = sock.messages('state');
  assert.equal(states.length, 2);
  assert.deepEqual(states[0].p, [1, 2, 3]);
  assert.deepEqual(states[0].q, [0, 0, 0, 1]);
  assert.equal(states[0].armed, true);
  assert.equal(states[0].n, 1);
  assert.equal(states[1].n, 2, 'sequence number increments');

  Net.leave();
  sock.sent.length = 0;
  Net.sendState(droneStub());
  assert.equal(sock.sent.length, 0, 'no state after leaving');
});

test('leave() sends leave, closes, and suppresses reconnect', async (t) => {
  const { Net, timers } = setup();
  const { sock } = await connected(Net, 'join');
  const events = [];
  Net.on('disconnected', () => events.push('disconnected'));
  sock.sent.length = 0;

  Net.leave();
  assert.equal(sock.messages('leave').length, 1);
  assert.equal(sock.readyState, 3);
  assert.equal(Net.isConnected(), false);
  assert.equal(Net.getRoom(), null);
  assert.equal(timers.pending(), 0, 'timers must be cleared');
  timers.advance(30000);
  assert.deepEqual(events, []);
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect socket');
});

test('an unexpected close emits disconnected and reconnects by joining the room', async (t) => {
  const { Net, timers } = setup();
  t.after(() => Net.leave());
  const events = [];
  Net.on('disconnected', () => events.push('disconnected'));
  Net.on('reconnected', () => events.push('reconnected'));

  const { sock } = await connected(Net, 'create', { public: true, name: 'Lobby' });
  sock.close();
  assert.deepEqual(events, ['disconnected']);
  assert.equal(Net.isConnected(), false);

  timers.advance(1000);
  assert.equal(FakeWebSocket.instances.length, 2, 'a reconnect socket should be created');
  const retry = FakeWebSocket.last;
  retry.open();
  const sent = retry.sent[0];
  assert.equal(sent.t, 'join', 'a created room is re-joined, not re-created');
  assert.equal(sent.room, 'ABC123');
  assert.equal(sent.nickname, 'Nick');

  retry.receive({ t: 'joined', room: 'ABC123', pid: 'p1b', others: [] });
  assert.equal(Net.isConnected(), true);
  assert.deepEqual(events, ['disconnected', 'reconnected']);
});

test('a room that is gone stops the reconnect loop with room_lost', async (t) => {
  const { Net, timers } = setup();
  t.after(() => Net.leave());
  const events = [];
  Net.on('room_lost', () => events.push('room_lost'));

  const { sock } = await connected(Net, 'join', undefined, {
    t: 'joined', room: 'ABC123', pid: 'p1', others: []
  });
  sock.close();
  timers.advance(1000);
  const retry = FakeWebSocket.last;
  retry.open();
  retry.receive({ t: 'error', msg: 'room not found' });
  return Promise.resolve().then(() => {
    assert.deepEqual(events, ['room_lost']);
    assert.equal(Net.isConnected(), false);
    timers.advance(60000);
    assert.equal(FakeWebSocket.instances.length, 2, 'no further retries');
  });
});

test('ping/pong tracks latency and ignores malformed frames', async (t) => {
  const { Net } = setup();
  t.after(() => Net.leave());
  const { sock } = await connected(Net, 'join');
  const pings = sock.sent.filter((m) => m.t === 'ping');
  assert.ok(pings.length >= 1, 'an initial ping should be sent');

  const latencies = [];
  Net.on('latency', (l) => latencies.push(l));
  sock.receive({ t: 'pong', ts: pings[0].ts });
  assert.equal(latencies.length, 1);
  assert.ok(Net.getLatency() >= 0);

  assert.doesNotThrow(() => (sock.onmessage({ data: 'not json' })));
  assert.doesNotThrow(() => sock.receive({ t: 'state', pid: 'p2' }));
});

test('listServers() returns the lobby array and rejects on HTTP errors', async () => {
  const { Net } = setup();
  const rooms = await Net.listServers();
  assert.deepEqual(rooms, [{ room: 'ABC123', players: 2 }]);

  const failing = setup({
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
  });
  await assert.rejects(failing.Net.listServers(), /server list unavailable/);
});

test('uploadMap() posts the file and includes the uploader pid', async () => {
  const { Net, fetchCalls } = setup();
  await Net.uploadMap('ABC123', 'GLB', 'p1');
  assert.equal(fetchCalls[0].url, '/upload-map?room=ABC123&pid=p1');
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.equal(fetchCalls[0].init.body, 'GLB');

  const failing = setup({
    fetch: () => Promise.resolve({ ok: false })
  });
  await assert.rejects(failing.Net.uploadMap('ABC123', 'GLB'), /Upload failed/);
});
