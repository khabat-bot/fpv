#!/usr/bin/env python3
"""Tests for server.py — the static + WebSocket relay.

Stdlib only, matching the server. Run with:
    python3 -m unittest discover -s tests/python -p 'test_*.py' -v

Unit tests cover the protocol primitives; integration tests start the real
asyncio server on an ephemeral port and speak HTTP/WebSocket over sockets.
"""

import asyncio
import base64
import hashlib
import json
import os
import re
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import server  # noqa: E402


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

class LiveServer:
    """Run server.handle_client on a private event loop in a thread."""

    def __init__(self):
        self.loop = None
        self.thread = None
        self.server = None
        self.port = None

    def start(self):
        self.loop = asyncio.new_event_loop()
        ready = threading.Event()

        def run():
            asyncio.set_event_loop(self.loop)
            self.server = self.loop.run_until_complete(
                asyncio.start_server(server.handle_client, '127.0.0.1', 0)
            )
            self.port = self.server.sockets[0].getsockname()[1]
            ready.set()
            self.loop.run_forever()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        if not ready.wait(5):
            raise RuntimeError('test server did not start')

    def stop(self):
        if not self.loop:
            return

        def shutdown():
            self.server.close()
            for task in asyncio.all_tasks(self.loop):
                task.cancel()
            self.loop.stop()

        self.loop.call_soon_threadsafe(shutdown)
        self.thread.join(5)
        self.thread = None


def client_frame(payload, opcode=1, masked=True):
    """Build a client-to-server WebSocket frame."""
    mask = b'\x01\x02\x03\x04' if masked else b''
    n = len(payload)
    head = bytes([0x80 | opcode])
    bit = 0x80 if masked else 0
    if n < 126:
        head += bytes([bit | n])
    elif n < 65536:
        head += bytes([bit | 126]) + struct.pack('>H', n)
    else:
        head += bytes([bit | 127]) + struct.pack('>Q', n)
    if masked:
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return head + mask + body
    return head + payload


class WSClient:
    """Minimal RFC6455 client: masked writes, unmasked reads."""

    def __init__(self, port):
        self.port = port
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=5)
        self.buf = b''
        key = base64.b64encode(os.urandom(16)).decode('ascii')
        self.key = key
        request = (
            'GET /ws HTTP/1.1\r\n'
            'Host: 127.0.0.1:%d\r\n'
            'Upgrade: websocket\r\n'
            'Connection: Upgrade\r\n'
            'Sec-WebSocket-Key: %s\r\n'
            'Sec-WebSocket-Version: 13\r\n'
            '\r\n' % (port, key)
        )
        self.sock.sendall(request.encode('ascii'))
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise AssertionError('handshake closed: %r' % data)
            data += chunk
        head, self.buf = data.split(b'\r\n\r\n', 1)
        self.handshake = head.decode('latin-1')

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError('socket closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_bytes(self, payload, opcode=1):
        self.sock.sendall(client_frame(payload, opcode=opcode))

    def send(self, obj):
        self.send_bytes(json.dumps(obj).encode('utf-8'))

    def recv_frame(self, timeout=3.0):
        self.sock.settimeout(timeout)
        b1, b2 = self._read(2)
        opcode = b1 & 0x0F
        masked = (b2 & 0x80) != 0
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack('>H', self._read(2))[0]
        elif length == 127:
            length = struct.unpack('>Q', self._read(8))[0]
        mask = self._read(4) if masked else None
        payload = bytearray(self._read(length))
        if mask:
            for i in range(length):
                payload[i] ^= mask[i % 4]
        return opcode, bytes(payload)

    def recv_json(self, timeout=3.0):
        while True:
            opcode, payload = self.recv_frame(timeout)
            if opcode == 1:
                return json.loads(payload.decode('utf-8'))
            if opcode == 8:
                raise EOFError('server sent close')
            # control frames (pong) are skipped

    def expect_silence(self, timeout=0.35):
        try:
            opcode, payload = self.recv_frame(timeout)
        except (socket.timeout, TimeoutError):
            return
        raise AssertionError('unexpected frame: opcode=%r payload=%r' % (opcode, payload))

    def close(self):
        try:
            self.send_bytes(b'', opcode=8)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def http_request(port, path, method='GET', body=b'', headers=None):
    conn = HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        hdrs = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, hdrs, data
    finally:
        conn.close()


def raw_http(port, payload, timeout=3.0):
    s = socket.create_connection(('127.0.0.1', port), timeout=timeout)
    try:
        s.sendall(payload)
        data = b''
        while True:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
        return data
    finally:
        s.close()


class ServerTestCase(unittest.TestCase):
    """Starts one server for the class and isolates rooms per test."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.orig_map_dir = server.MAP_DIR
        server.MAP_DIR = cls.tmp.name
        cls.live = LiveServer()
        cls.live.start()

    @classmethod
    def tearDownClass(cls):
        cls.live.stop()
        server.MAP_DIR = cls.orig_map_dir
        cls.tmp.cleanup()

    def setUp(self):
        server.rooms.clear()
        for name in os.listdir(server.MAP_DIR):
            os.remove(os.path.join(server.MAP_DIR, name))
        self.clients = []

    def tearDown(self):
        for c in self.clients:
            c.close()
        server.rooms.clear()
        time.sleep(0.02)

    def ws(self):
        c = WSClient(self.live.port)
        self.clients.append(c)
        return c

    def get(self, path):
        return http_request(self.live.port, path)

    def create_room(self, public=False, nickname='Alice', name='Test lobby'):
        c = self.ws()
        c.send({'t': 'create', 'public': public, 'nickname': nickname, 'name': name,
                'loadout': {'frame': 'freestyle_5'}})
        msg = c.recv_json()
        self.assertEqual(msg['t'], 'created')
        return c, msg

    def join_room(self, code, nickname='Bob'):
        c = self.ws()
        c.send({'t': 'join', 'room': code, 'nickname': nickname, 'loadout': None})
        msg = c.recv_json()
        self.assertEqual(msg['t'], 'joined')
        return c, msg


# --------------------------------------------------------------------------
# unit tests — helpers and framing
# --------------------------------------------------------------------------

class HelpersTest(unittest.TestCase):
    def test_clean_text(self):
        self.assertEqual(server.clean_text(None, 'Pilot'), 'Pilot')
        self.assertEqual(server.clean_text('', 'Pilot'), 'Pilot')
        self.assertEqual(server.clean_text('  Alice  '), 'Alice')
        self.assertEqual(server.clean_text(123), '123')
        self.assertEqual(server.clean_text('x' * 100, '', 32), 'x' * 32)

    def test_clean_vec(self):
        self.assertIsNone(server.clean_vec(None, 3))
        self.assertIsNone(server.clean_vec([1, 2], 3))
        self.assertIsNone(server.clean_vec(['1', 2, 3], 3))
        self.assertIsNone(server.clean_vec([True, 2, 3], 3))
        self.assertIsNone(server.clean_vec([float('nan'), 0, 0], 3))
        self.assertIsNone(server.clean_vec([float('inf'), 0, 0], 3))
        self.assertEqual(server.clean_vec([1, 2, 3], 3), [1.0, 2.0, 3.0])
        self.assertEqual(server.clean_vec([1e9, -1e9, 0], 3, 10.0), [10.0, -10.0, 0.0])
        self.assertEqual(server.clean_vec((1, 2, 3, 4), 3), [1.0, 2.0, 3.0])

    def test_generated_ids_have_the_expected_shape(self):
        for _ in range(50):
            self.assertRegex(server.gen_code(), r'^[A-Z0-9]{6}$')
            self.assertRegex(server.gen_pid(), r'^[a-z0-9]{8}$')

    def test_room_code_regex(self):
        for good in ['A', 'ABC123', 'Z' * 12]:
            self.assertTrue(server.ROOM_CODE_RE.match(good), good)
        for bad in ['', 'abc', 'ABC-1', 'A' * 13, 'ABC DEF']:
            self.assertFalse(server.ROOM_CODE_RE.match(bad), bad)

    def test_map_paths_stay_in_map_dir(self):
        self.assertEqual(server.map_path('ABC123'),
                         os.path.join(server.MAP_DIR, 'fpv-map-ABC123.glb'))

    def test_http_response_shape(self):
        resp = server.http_response('200 OK', [('Content-Type', 'text/plain')], 'hé'.encode('utf-8'))
        head, body = resp.split(b'\r\n\r\n', 1)
        self.assertTrue(head.startswith(b'HTTP/1.1 200 OK'))
        self.assertIn(b'Connection: close', head)
        self.assertIn(b'Content-Length: 3', head)   # bytes, not characters
        self.assertEqual(body, 'hé'.encode('utf-8'))

    def test_ws_accept_header_matches_rfc6455(self):
        header = server.ws_accept_header('dGhlIHNhbXBsZSBub25jZQ==')
        self.assertIn('HTTP/1.1 101 Switching Protocols', header)
        self.assertIn('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=', header)
        self.assertTrue(header.endswith('\r\n\r\n'))


class FrameTest(unittest.IsolatedAsyncioTestCase):
    async def test_masked_client_frame_decodes(self):
        payload = b'{"t":"ping"}'
        reader = asyncio.StreamReader()
        reader.feed_data(client_frame(payload))
        reader.feed_eof()
        opcode, data = await server.ws_read_frame(reader)
        self.assertEqual(opcode, 1)
        self.assertEqual(data, payload)

    async def test_unmasked_frame_decodes(self):
        reader = asyncio.StreamReader()
        reader.feed_data(client_frame(b'hi', masked=False))
        reader.feed_eof()
        opcode, data = await server.ws_read_frame(reader)
        self.assertEqual((opcode, data), (1, b'hi'))

    async def test_oversized_frame_is_rejected(self):
        reader = asyncio.StreamReader()
        reader.feed_data(bytes([0x81, 0xFE]) + struct.pack('>H', server.MAX_MSG_BYTES + 1))
        reader.feed_eof()
        with self.assertRaises(ValueError):
            await server.ws_read_frame(reader)

    async def test_send_frame_length_encodings(self):
        class Dummy:
            def __init__(self):
                self.data = b''

            def write(self, b):
                self.data += b

            async def drain(self):
                pass

        for size, expected in [
            (5, bytes([0x81, 5])),
            (125, bytes([0x81, 125])),
            (126, bytes([0x81, 126]) + struct.pack('>H', 126)),
            (65535, bytes([0x81, 126]) + struct.pack('>H', 65535)),
            (65536, bytes([0x81, 127]) + struct.pack('>Q', 65536)),
        ]:
            w = Dummy()
            await server.ws_send_frame(w, 1, b'x' * size)
            self.assertEqual(w.data[:len(expected)], expected, 'length ' + str(size))
            self.assertEqual(len(w.data), len(expected) + size)


class ParityTest(unittest.TestCase):
    """server.py and server.rs are ports of the same protocol."""

    @classmethod
    def setUpClass(cls):
        cls.rust = (ROOT / 'server.rs').read_text(encoding='utf-8')

    def test_ws_magic_matches(self):
        self.assertIn('const WS_MAGIC: &str = "%s";' % server.WS_MAGIC, self.rust)

    def test_limits_match(self):
        expected = {
            'MAX_MSG_BYTES': ('u64', server.MAX_MSG_BYTES),
            'MAX_ROOM_SIZE': ('usize', server.MAX_ROOM_SIZE),
            'MAX_ROOMS': ('usize', server.MAX_ROOMS),
            'STATE_RATE_MAX': ('u32', server.STATE_RATE_MAX),
        }
        for name, (kind, value) in expected.items():
            pattern = r'const %s:\s*%s\s*=\s*%s\s*;' % (name, kind, value)
            self.assertRegex(self.rust, pattern, name + ' drifted between the two servers')

    def test_timeouts_match(self):
        self.assertIn('IDLE_TIMEOUT: Duration = Duration::from_secs(%d)' % int(server.IDLE_TIMEOUT),
                      self.rust)
        self.assertIn('STATE_RATE_WINDOW: Duration = Duration::from_secs(%d)'
                      % int(server.STATE_RATE_WINDOW), self.rust)

    def test_both_servers_expose_the_same_endpoints(self):
        for endpoint in ['/mp-status', '/servers', '/upload-map', '/map/', '/ws']:
            self.assertIn(endpoint, self.rust, 'Rust server is missing ' + endpoint)

    def test_both_servers_emit_the_same_message_types(self):
        for msg_type in ['created', 'joined', 'peer_join', 'peer_leave',
                         'host_change', 'map_change', 'state', 'error']:
            self.assertIn('"%s"' % msg_type, self.rust, 'Rust server is missing ' + msg_type)


# --------------------------------------------------------------------------
# integration — HTTP
# --------------------------------------------------------------------------

class HttpTest(ServerTestCase):
    def test_root_serves_index_html_with_no_store(self):
        status, headers, body = self.get('/')
        self.assertEqual(status, 200)
        self.assertEqual(body, (ROOT / 'index.html').read_bytes())
        self.assertIn('text/html', headers['content-type'])
        self.assertIn('no-store', headers['cache-control'])
        self.assertEqual(headers['connection'], 'close')
        self.assertEqual(int(headers['content-length']), len(body))

    def test_static_files_are_served_verbatim(self):
        status, headers, body = self.get('/js/config.js')
        self.assertEqual(status, 200)
        self.assertEqual(body, (ROOT / 'js/config.js').read_bytes())
        self.assertIn('javascript', headers['content-type'])

    def test_missing_files_404(self):
        status, _, _ = self.get('/definitely-not-here.txt')
        self.assertEqual(status, 404)

    def test_path_traversal_is_forbidden(self):
        status, _, _ = self.get('/../AGENTS.md')
        self.assertEqual(status, 403)
        status, _, _ = self.get('/js/../../server.py')
        self.assertEqual(status, 403)

    def test_mp_status_reports_room_count(self):
        status, headers, body = self.get('/mp-status')
        self.assertEqual(status, 200)
        self.assertIn('application/json', headers['content-type'])
        data = json.loads(body)
        self.assertEqual(data, {'enabled': True, 'version': 1, 'rooms': 0})

        self.create_room()
        self.assertEqual(json.loads(self.get('/mp-status')[2])['rooms'], 1)

    def test_servers_lists_only_public_rooms(self):
        public, created = self.create_room(public=True, nickname='Host', name='Public lobby')
        self.create_room(public=False, nickname='Private', name='Secret')

        status, headers, body = self.get('/servers')
        self.assertEqual(status, 200)
        self.assertIn('application/json', headers['content-type'])
        data = json.loads(body)
        self.assertEqual(len(data['rooms']), 1)
        room = data['rooms'][0]
        self.assertEqual(room['room'], created['room'])
        self.assertEqual(room['name'], 'Public lobby')
        self.assertEqual(room['host'], 'Host')
        self.assertEqual(room['players'], 1)
        self.assertEqual(room['max'], server.MAX_ROOM_SIZE)
        self.assertFalse(room['full'])
        self.assertFalse(room['map'])
        self.assertEqual(public, self.clients[0])

    def test_servers_reports_player_count_and_full_state(self):
        host, created = self.create_room(public=True)
        for _ in range(server.MAX_ROOM_SIZE - 1):
            self.join_room(created['room'])
        room = json.loads(self.get('/servers')[2])['rooms'][0]
        self.assertEqual(room['players'], server.MAX_ROOM_SIZE)
        self.assertTrue(room['full'])
        self.assertTrue(host)


class MapUploadTest(ServerTestCase):
    def test_upload_then_fetch_map(self):
        host, created = self.create_room()
        guest, _ = self.join_room(created['room'])
        host.recv_json()                       # peer_join

        code = created['room']
        status, _, body = http_request(
            self.live.port,
            '/upload-map?room=%s&pid=%s' % (code, created['pid']),
            method='POST',
            body=b'GLB-DATA',
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')

        change = guest.recv_json()
        self.assertEqual(change['t'], 'map_change')
        self.assertEqual(change['by'], created['pid'])
        self.assertTrue(change['url'].startswith('/map/%s.glb?v=' % code))
        host.expect_silence()                  # uploader is skipped

        self.assertTrue(os.path.exists(server.map_path(code)))
        with open(server.map_path(code), 'rb') as f:
            self.assertEqual(f.read(), b'GLB-DATA')

        status, headers, body = self.get('/map/%s.glb' % code)
        self.assertEqual(status, 200)
        self.assertEqual(body, b'GLB-DATA')
        self.assertEqual(headers['content-type'], 'model/gltf-binary')

        listed = json.loads(self.get('/servers')[2])['rooms']
        self.assertEqual(listed, [])           # room is private, so not listed

    def test_upload_to_unknown_or_invalid_room_is_rejected(self):
        for room in ['NOPE', 'abc-123', '']:
            status, _, _ = http_request(
                self.live.port, '/upload-map?room=' + room, method='POST', body=b'x')
            self.assertEqual(status, 400, room)

    def test_upload_without_pid_echoes_map_change_to_everyone(self):
        host, created = self.create_room()
        guest, _ = self.join_room(created['room'])
        host.recv_json()
        status, _, _ = http_request(
            self.live.port, '/upload-map?room=' + created['room'], method='POST', body=b'x')
        self.assertEqual(status, 200)
        self.assertEqual(host.recv_json()['t'], 'map_change')
        self.assertEqual(guest.recv_json()['t'], 'map_change')

    def test_oversized_upload_is_rejected_before_reading_the_body(self):
        response = raw_http(
            self.live.port,
            b'POST /upload-map?room=ABC123 HTTP/1.1\r\n'
            b'Host: 127.0.0.1\r\n'
            b'Content-Length: 60000000\r\n\r\n'
        )
        self.assertTrue(response.startswith(b'HTTP/1.1 413'), response[:80])

    def test_unknown_map_404s(self):
        self.assertEqual(self.get('/map/ABC123.glb')[0], 404)
        self.assertEqual(self.get('/map/../server.py')[0], 404)

    def test_leaving_the_last_player_removes_the_room_and_map(self):
        host, created = self.create_room()
        code = created['room']
        with open(server.map_path(code), 'wb') as f:
            f.write(b'map')
        host.send({'t': 'leave'})
        host.close()
        deadline = time.time() + 3
        while code in server.rooms and time.time() < deadline:
            time.sleep(0.02)
        self.assertNotIn(code, server.rooms)
        self.assertFalse(os.path.exists(server.map_path(code)))


# --------------------------------------------------------------------------
# integration — WebSocket protocol
# --------------------------------------------------------------------------

class WebSocketProtocolTest(ServerTestCase):
    def test_handshake_returns_a_valid_accept_key(self):
        c = self.ws()
        self.assertIn('101 Switching Protocols', c.handshake)
        self.assertIn('Upgrade: websocket', c.handshake)
        expected = base64.b64encode(
            hashlib.sha1((c.key + server.WS_MAGIC).encode('ascii')).digest()
        ).decode('ascii')
        self.assertIn('Sec-WebSocket-Accept: ' + expected, c.handshake)

    def test_create_returns_room_pid_and_host(self):
        c, msg = self.create_room(nickname='  Alice  ')
        self.assertRegex(msg['room'], r'^[A-Z0-9]{6}$')
        self.assertRegex(msg['pid'], r'^[a-z0-9]{8}$')
        self.assertEqual(msg['nickname'], 'Alice')
        self.assertEqual(msg['host'], msg['pid'])
        self.assertFalse(msg['public'])
        self.assertEqual(server.rooms[msg['room']]['host'], msg['pid'])

    def test_create_defaults_and_truncates_client_text(self):
        c = self.ws()
        c.send({'t': 'create', 'name': 'x' * 100})
        msg = c.recv_json()
        self.assertEqual(msg['nickname'], 'Pilot')
        self.assertEqual(len(msg['name']), 32)

    def test_join_unknown_room_errors(self):
        c = self.ws()
        c.send({'t': 'join', 'room': 'ZZZZZZ'})
        msg = c.recv_json()
        self.assertEqual(msg['t'], 'error')
        self.assertEqual(msg['msg'], 'room not found')

    def test_join_with_bad_code_errors(self):
        c = self.ws()
        c.send({'t': 'join', 'room': 'bad!'})
        self.assertEqual(c.recv_json()['msg'], 'room not found')

    def test_join_returns_existing_peers_and_notifies_them(self):
        host, created = self.create_room(nickname='Host')
        guest, joined = self.join_room(created['room'], nickname='Guest')

        self.assertEqual(joined['room'], created['room'])
        self.assertEqual(joined['host'], created['pid'])
        self.assertEqual(joined['others'], [{
            'pid': created['pid'],
            'loadout': {'frame': 'freestyle_5'},
            'nickname': 'Host',
        }])

        peer = host.recv_json()
        self.assertEqual(peer['t'], 'peer_join')
        self.assertEqual(peer['pid'], joined['pid'])
        self.assertEqual(peer['nickname'], 'Guest')

    def test_room_full_rejects_the_ninth_player(self):
        host, created = self.create_room()
        for i in range(server.MAX_ROOM_SIZE - 1):
            self.join_room(created['room'], nickname='P%d' % i)
        extra = self.ws()
        extra.send({'t': 'join', 'room': created['room']})
        msg = extra.recv_json()
        self.assertEqual(msg, {'t': 'error', 'msg': 'room full'})
        self.assertEqual(len(server.rooms[created['room']]['players']), server.MAX_ROOM_SIZE)

    def test_state_is_relayed_and_sanitised(self):
        host, created = self.create_room()
        guest, joined = self.join_room(created['room'])
        host.recv_json()                       # peer_join

        guest.send({
            't': 'state',
            'p': [1, 2, 3],
            'q': [0, 0, 1, 5],                 # w clamped to 1
            'v': [0, 0, 0],
            'armed': 1,
            'crashed': 0,
            'n': 7,
        })
        out = host.recv_json()
        self.assertEqual(out['t'], 'state')
        self.assertEqual(out['pid'], joined['pid'])
        self.assertEqual(out['p'], [1.0, 2.0, 3.0])
        self.assertEqual(out['q'], [0.0, 0.0, 1.0, 1.0])
        self.assertEqual(out['v'], [0.0, 0.0, 0.0])
        self.assertIs(out['armed'], True)
        self.assertIs(out['crashed'], False)
        self.assertEqual(out['n'], 7)

    def test_malformed_state_is_dropped(self):
        host, created = self.create_room()
        guest, _ = self.join_room(created['room'])
        host.recv_json()

        guest.send({'t': 'state', 'p': ['x', 0, 0], 'q': [0, 0, 0, 1]})
        guest.send({'t': 'state', 'p': [0, 0, 0]})                 # no quaternion
        host.expect_silence()

        guest.send({'t': 'ping', 'ts': 5})
        self.assertEqual(guest.recv_json()['t'], 'pong')

    def test_state_flood_is_rate_limited(self):
        host, created = self.create_room()
        guest, _ = self.join_room(created['room'])
        host.recv_json()

        for i in range(200):
            guest.send({'t': 'state', 'p': [i, 0, 0], 'q': [0, 0, 0, 1], 'v': [0, 0, 0]})

        received = 0
        deadline = time.time() + 2
        while time.time() < deadline:
            try:
                host.recv_json(timeout=0.3)
                received += 1
            except (socket.timeout, TimeoutError):
                break
        self.assertGreater(received, 0)
        self.assertLessEqual(received, server.STATE_RATE_MAX + 1)

    def test_state_outside_a_room_is_ignored(self):
        c = self.ws()
        c.send({'t': 'state', 'p': [0, 0, 0], 'q': [0, 0, 0, 1]})
        c.expect_silence()
        c.send({'t': 'ping', 'ts': 1})
        self.assertEqual(c.recv_json()['t'], 'pong')

    def test_ping_pong_echoes_timestamp(self):
        c = self.ws()
        before = int(time.time() * 1000)
        c.send({'t': 'ping', 'ts': 12345})
        msg = c.recv_json()
        self.assertEqual(msg['t'], 'pong')
        self.assertEqual(msg['ts'], 12345)
        self.assertGreaterEqual(msg['time'], before)
        self.assertIsInstance(msg['time'], int)

    def test_invalid_json_is_ignored_and_the_link_survives(self):
        c = self.ws()
        c.send_bytes(b'{not json')
        c.send({'t': 'ping', 'ts': 9})
        self.assertEqual(c.recv_json()['ts'], 9)

    def test_pong_control_frames_are_answered(self):
        c = self.ws()
        c.send_bytes(b'hello', opcode=9)
        opcode, payload = c.recv_frame()
        self.assertEqual(opcode, 10)
        self.assertEqual(payload, b'hello')

    def test_host_migrates_to_the_next_player(self):
        host, created = self.create_room(nickname='Host')
        guest, joined = self.join_room(created['room'], nickname='Guest')
        host.recv_json()                       # peer_join
        host.send({'t': 'leave'})
        host.close()

        leave = guest.recv_json()
        self.assertEqual(leave, {'t': 'peer_leave', 'pid': created['pid']})
        change = guest.recv_json()
        self.assertEqual(change['t'], 'host_change')
        self.assertEqual(change['pid'], joined['pid'])
        self.assertEqual(change['nickname'], 'Guest')
        self.assertEqual(server.rooms[created['room']]['host'], joined['pid'])

    def test_pid_cannot_be_forged_to_hijack_a_room(self):
        host, created = self.create_room()
        guest, joined = self.join_room(created['room'])
        host.recv_json()
        # The server always uses its own connection pid, never a client field.
        guest.send({'t': 'state', 'pid': created['pid'], 'p': [0, 0, 0], 'q': [0, 0, 0, 1]})
        out = host.recv_json()
        self.assertEqual(out['pid'], joined['pid'])

    def test_leaving_a_room_mid_session(self):
        host, created = self.create_room()
        guest, joined = self.join_room(created['room'])
        host.recv_json()
        guest.send({'t': 'leave'})
        self.assertEqual(host.recv_json(), {'t': 'peer_leave', 'pid': joined['pid']})
        self.assertNotIn(joined['pid'], server.rooms[created['room']]['players'])

    def test_oversized_frame_closes_the_connection(self):
        c = self.ws()
        c.sock.sendall(bytes([0x82, 0x80 | 126]) + struct.pack('>H', server.MAX_MSG_BYTES + 1))
        with self.assertRaises((EOFError, ConnectionError, socket.timeout)):
            c.recv_frame(timeout=2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
