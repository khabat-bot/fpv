#!/usr/bin/env python3
"""Behavioural parity tests: `server.py` and `server.rs` must agree.

`test_server.py::ParityTest` compares the two implementations as *source text*
(constants, endpoint strings, message names). That catches a renamed constant
but not a behavioural drift: a different clamp, a missing `map_change`, a rate
limit applied in the wrong order. This module starts both servers on their own
ephemeral ports and runs the same scenario against each, comparing only what a
client can observe.

Each scenario returns a plain dict. Anything volatile (room codes, pids,
timestamps, map version stamps) is normalised away before the comparison, so a
failure means the two servers really do behave differently.

Requires `rustc` (or `FPV_RUST_SERVER=/path/to/binary`). Locally the whole
module skips when Rust is missing; under `CI` it fails instead, because a
silently skipped parity check is worse than none.
"""

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from test_server import WSClient, http_request, raw_http  # noqa: E402

BUILD_TIMEOUT = 300
READY_TIMEOUT = 15.0

_binary_cache = {}


# ---------------------------------------------------------------------------
# harness
# ---------------------------------------------------------------------------

def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def rust_binary():
    """Compile server.rs once per test process; None when rustc is missing."""
    if 'path' in _binary_cache:
        return _binary_cache['path']

    override = os.environ.get('FPV_RUST_SERVER')
    if override:
        _binary_cache['path'] = override
        return override

    rustc = shutil.which('rustc')
    if not rustc:
        local = Path.home() / '.cargo' / 'bin' / 'rustc'
        rustc = str(local) if local.exists() else None
    if not rustc:
        _binary_cache['path'] = None
        return None

    source = ROOT / 'server.rs'
    out = Path(tempfile.gettempdir()) / 'fpv-parity-rust-server'
    fresh = out.exists() and out.stat().st_mtime >= source.stat().st_mtime
    if not fresh:
        subprocess.run([rustc, '-O', str(source), '-o', str(out)],
                       check=True, capture_output=True, timeout=BUILD_TIMEOUT)
    _binary_cache['path'] = str(out)
    return str(out)


class Target:
    """One server under test, on a private port and map directory."""

    def __init__(self, kind, binary=None):
        self.kind = kind
        self.binary = binary
        self.proc = None
        self.clients = []
        self.tmp = None
        self.log = None
        self.port = None
        self.map_dir = None

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fpv-parity-')
        self.map_dir = self.tmp.name
        self.port = free_port()
        env = dict(os.environ)
        env.update({
            'PORT': str(self.port),
            'HOST': '127.0.0.1',
            'FPV_MAP_DIR': self.map_dir,
            'FPV_ROOT': str(ROOT),
        })
        if self.kind == 'py':
            cmd = [sys.executable, str(ROOT / 'server.py')]
        else:
            cmd = [self.binary]
        self.log = open(os.path.join(self.map_dir, 'server.log'), 'w+', encoding='utf-8')
        self.proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env,
                                     stdout=self.log, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL)
        self._wait_ready()
        return self

    def __exit__(self, *exc_info):
        for client in self.clients:
            try:
                client.close()
            except Exception:
                pass
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        if self.log:
            self.log.close()
        if self.tmp:
            self.tmp.cleanup()

    def output(self):
        if not self.log:
            return ''
        try:
            self.log.flush()
            with open(self.log.name, 'r', encoding='utf-8', errors='replace') as f:
                return f.read()
        except OSError:
            return ''

    def _wait_ready(self):
        deadline = time.time() + READY_TIMEOUT
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise AssertionError('%s exited during startup:\n%s'
                                     % (self.kind, self.output()))
            try:
                if http_request(self.port, '/mp-status')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.02)
        raise AssertionError('%s never became ready:\n%s' % (self.kind, self.output()))

    # -- client helpers ---------------------------------------------------

    def ws(self):
        client = WSClient(self.port)
        self.clients.append(client)
        return client

    def get(self, path):
        return http_request(self.port, path)

    def post_map(self, room, body, pid=None):
        query = '/upload-map?room=' + room
        if pid:
            query += '&pid=' + pid
        return http_request(self.port, query, method='POST', body=body)

    def rooms(self):
        return json.loads(self.get('/mp-status')[2])['rooms']

    def wait_rooms(self, count, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.rooms() == count:
                    return
            except OSError:
                pass
            time.sleep(0.02)
        raise AssertionError('%s: rooms never reached %d (now %r)\n%s'
                             % (self.kind, count, self.rooms(), self.output()))

    def map_file(self, code):
        path = Path(self.map_dir) / ('fpv-map-%s.glb' % code)
        return path if path.exists() else None

    def create_room(self, public=False, nickname='Host', name='Lobby A',
                    loadout=None):
        host = self.ws()
        host.send({'t': 'create', 'public': public, 'nickname': nickname,
                   'name': name, 'loadout': loadout})
        return host, host.recv_json()

    def join_room(self, code, nickname='Guest', loadout=None):
        guest = self.ws()
        guest.send({'t': 'join', 'room': code, 'nickname': nickname,
                    'loadout': loadout})
        return guest, guest.recv_json()


def scrub(value, subs):
    """Replace volatile identifiers so two runs can be compared."""
    if isinstance(value, dict):
        return {k: scrub(v, subs) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, subs) for v in value]
    if isinstance(value, str):
        if value in subs:
            return subs[value]
        if value.startswith('/map/') and '.glb?v=' in value:
            return '<map-url>'
    return value


# ---------------------------------------------------------------------------
# scenarios — each returns an observation dict
# ---------------------------------------------------------------------------

def scenario_http_endpoints(t):
    root = t.get('/')
    js = t.get('/js/config.js')
    status = t.get('/mp-status')
    return {
        'root': {
            'status': root[0],
            'type': root[1].get('content-type'),
            'cache': root[1].get('cache-control'),
            'connection': root[1].get('connection'),
            'bytes': len(root[2]),
        },
        'js': {
            'status': js[0],
            'type': js[1].get('content-type'),
            'bytes': len(js[2]),
        },
        'missing': t.get('/definitely-not-here.txt')[0],
        'traversal': t.get('/../AGENTS.md')[0],
        'nested_traversal': t.get('/js/../../server.py')[0],
        'mp_status': {'status': status[0], 'body': json.loads(status[2])},
        'servers_empty': json.loads(t.get('/servers')[2]),
    }


def scenario_room_lifecycle(t):
    host, created = t.create_room(public=True, nickname='  Host  ',
                                  name='Lobby A', loadout={'frame': 'freestyle_5'})
    subs = {created['pid']: '<host>', created['room']: '<room>'}

    guest, joined = t.join_room(created['room'], nickname='Guest')
    subs[joined['pid']] = '<guest>'
    peer_join = host.recv_json()
    listing = json.loads(t.get('/servers')[2])

    host.send({'t': 'leave'})
    host.close()
    peer_leave = guest.recv_json()
    host_change = guest.recv_json()
    t.wait_rooms(1)
    after_leave = json.loads(t.get('/servers')[2])

    return {
        'created': scrub(created, subs),
        'joined': scrub(joined, subs),
        'peer_join': scrub(peer_join, subs),
        'listing': scrub(listing, subs),
        'peer_leave': scrub(peer_leave, subs),
        'host_change': scrub(host_change, subs),
        'after_leave': scrub(after_leave, subs),
    }


def scenario_room_limits(t):
    host, created = t.create_room(nickname='Pilot')
    subs = {created['pid']: '<host>', created['room']: '<room>'}

    # Tolerate a rejected join: if the ports disagree on capacity, the diff
    # should show "joined" next to an error rather than crashing the scenario.
    joins = []
    for i in range(server.MAX_ROOM_SIZE - 1):
        _, joined = t.join_room(created['room'], nickname='P%d' % i)
        if joined.get('t') == 'joined':
            subs[joined['pid']] = '<p%d>' % i
            joins.append('joined')
        else:
            joins.append(scrub(joined, subs))

    listing = json.loads(t.get('/servers')[2])

    extra = t.ws()
    extra.send({'t': 'join', 'room': created['room']})
    full = extra.recv_json()

    unknown = t.ws()
    unknown.send({'t': 'join', 'room': 'ZZZZZZ'})
    not_found = unknown.recv_json()

    bad_code = t.ws()
    bad_code.send({'t': 'join', 'room': 'bad!'})
    bad_code_msg = bad_code.recv_json()

    return {
        'created': scrub(created, subs),
        'joins': joins,
        'servers': scrub(listing, subs),
        'room_full': full,
        'unknown_room': not_found,
        'bad_code': bad_code_msg,
    }


def scenario_state_relay(t):
    host, created = t.create_room()
    guest, joined = t.join_room(created['room'])
    subs = {created['pid']: '<host>', joined['pid']: '<guest>',
            created['room']: '<room>'}
    host.recv_json()                                  # peer_join

    guest.send({'t': 'state', 'p': [1, 2, 3], 'q': [0, 0, 1, 5],
                'v': [0, 0, 0], 'armed': True, 'crashed': False, 'n': 7})
    relayed = host.recv_json()

    # Junk and non-finite vectors must be dropped without killing the link.
    guest.send({'t': 'state', 'p': ['x', 0, 0], 'q': [0, 0, 0, 1]})
    guest.send({'t': 'state', 'p': [0, 0, 0]})        # no quaternion
    guest.send({'t': 'state', 'p': [float('nan'), 0, 0], 'q': [0, 0, 0, 1]})
    guest.send({'t': 'state', 'p': [0, float('inf'), 0], 'q': [0, 0, 0, 1]})
    guest.send({'t': 'state', 'p': [0, 0, 0], 'q': [0, 0, 0, float('-inf')]})
    host.expect_silence()

    guest.send({'t': 'ping', 'ts': 5})
    pong = guest.recv_json()
    pong.pop('time', None)

    return {
        'relayed': scrub(relayed, subs),
        'pong': pong,
        'dropped_non_finite': True,
    }


def scenario_state_rate_limit(t):
    host, created = t.create_room()
    guest, _ = t.join_room(created['room'])
    host.recv_json()

    for i in range(300):
        guest.send({'t': 'state', 'p': [i, 0, 0], 'q': [0, 0, 0, 1],
                    'v': [0, 0, 0]})

    received = 0
    deadline = time.time() + 2
    while time.time() < deadline:
        try:
            host.recv_json(timeout=0.3)
        except (socket.timeout, TimeoutError):
            break
        received += 1

    # Exact counts straddle the 1 s window boundary, so compare the property
    # that matters: a flood is clamped, not passed through.
    return {
        'relayed_something': received > 0,
        'rate_limited': received <= server.STATE_RATE_MAX + 1,
    }


def scenario_map_sharing(t):
    host, created = t.create_room()
    code = created['room']
    guest, _ = t.join_room(code)
    host.recv_json()                                  # peer_join

    upload = t.post_map(code, b'GLB-DATA', pid=created['pid'])
    change = guest.recv_json()
    host.expect_silence()                             # uploader is skipped

    fetched = t.get('/map/%s.glb' % code)
    stored = t.map_file(code)
    stored_bytes = stored.read_bytes() if stored else None

    unknown = t.post_map('NOPE', b'x')
    invalid = t.post_map('abc-123', b'x')
    oversize = raw_http(
        t.port,
        b'POST /upload-map?room=ABC123 HTTP/1.1\r\n'
        b'Host: 127.0.0.1\r\n'
        b'Content-Length: 60000000\r\n\r\n',
    ).split(b'\r\n', 1)[0].decode('latin-1', 'replace')

    subs = {code: '<room>', created['pid']: '<host>'}
    return {
        'upload_status': upload[0],
        'map_change': scrub(change, subs),
        'fetch': {'status': fetched[0],
                  'type': fetched[1].get('content-type'),
                  'body': fetched[2].decode('latin-1')},
        'stored': stored_bytes.decode('latin-1') if stored_bytes else None,
        'unknown_room': unknown[0],
        'invalid_room': invalid[0],
        'oversize': oversize,
    }


def scenario_map_cleanup(t):
    host, created = t.create_room()
    code = created['room']
    guest, _ = t.join_room(code)
    host.recv_json()

    t.post_map(code, b'GLB-DATA')
    host.recv_json()                                  # map_change (no pid)
    guest.recv_json()

    host.send({'t': 'leave'})
    guest.send({'t': 'leave'})
    host.close()
    guest.close()
    t.wait_rooms(0)

    return {
        'map_file_removed': t.map_file(code) is None,
        'fetch_after_delete': t.get('/map/%s.glb' % code)[0],
    }


def scenario_frame_cap(t):
    c = t.ws()
    c.sock.sendall(bytes([0x82, 0x80 | 126])
                   + struct.pack('>H', server.MAX_MSG_BYTES + 1))
    try:
        c.recv_frame(timeout=2)
        outcome = 'frame'
    except (socket.timeout, TimeoutError):
        outcome = 'open'
    except (EOFError, ConnectionError, OSError):
        outcome = 'closed'
    return {'oversized_frame': outcome}


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

class BehaviourParityTest(unittest.TestCase):
    """Runs every scenario against both servers and diffs the observations."""

    def same(self, scenario):
        binary = rust_binary()
        if binary is None:
            if os.environ.get('CI'):
                self.fail('rustc is required in CI: the parity suite would '
                          'otherwise pass without exercising server.rs')
            self.skipTest('rustc not found (set FPV_RUST_SERVER to skip the build)')

        with Target('py') as py:
            expected = scenario(py)
        with Target('rs', binary) as rs:
            actual = scenario(rs)

        self.assertEqual(
            expected, actual,
            '\nserver.py and server.rs disagree in %s\n'
            '--- server.py ---\n%s\n--- server.rs ---\n%s'
            % (scenario.__name__,
               json.dumps(expected, indent=2, sort_keys=True, default=str),
               json.dumps(actual, indent=2, sort_keys=True, default=str)))

    def test_http_endpoints_match(self):
        self.same(scenario_http_endpoints)

    def test_room_lifecycle_matches(self):
        self.same(scenario_room_lifecycle)

    def test_room_limits_match(self):
        self.same(scenario_room_limits)

    def test_state_relay_matches(self):
        self.same(scenario_state_relay)

    def test_state_rate_limit_matches(self):
        self.same(scenario_state_rate_limit)

    def test_map_sharing_matches(self):
        self.same(scenario_map_sharing)

    def test_map_cleanup_matches(self):
        self.same(scenario_map_cleanup)

    def test_oversized_frame_matches(self):
        self.same(scenario_frame_cap)


if __name__ == '__main__':
    unittest.main(verbosity=2)
