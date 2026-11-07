#!/usr/bin/env python3
"""
server.py — FPV Sim static server + WebSocket relay.

Pure Python stdlib (asyncio). No pip deps. Run with:
    python3 server.py
Then open http://localhost:8080

Endpoints:
    GET  /              static files under this directory
    GET  /mp-status     {"enabled": true, "version": 1, "rooms": N}
    GET  /servers       public lobby browser data
    WS   /ws            multiplayer relay

Protocol (JSON messages):
    Client -> Server:
        {"t":"create", "loadout":{...}, "public":bool, "name":"..."}
        {"t":"join",   "room":"ABC123", "loadout":{...}}
        {"t":"state",  "p":[x,y,z], "q":[x,y,z,w], "v":[x,y,z],
                       "armed":bool, "crashed":bool}
        {"t":"leave"}

    Server -> Client:
        {"t":"created","room":"ABC123","pid":"<id>",
                      "public":bool,"name":"..."}
        {"t":"joined","room":"ABC123","pid":"<id>",
                      "public":bool,"name":"...",
                      "others":[{"pid":"...","loadout":{...}}, ...]}
        {"t":"peer_join","pid":"<id>","loadout":{...}}
        {"t":"peer_leave","pid":"<id>"}
        {"t":"state","pid":"<id>","p":[...],"q":[...],"v":[...],
                     "armed":bool,"crashed":bool}
        {"t":"error","msg":"..."}
"""
import asyncio, os, sys, json, hashlib, base64, struct, random, string
import math, re, time
import mimetypes
from urllib.parse import parse_qs

PORT = int(os.environ.get('PORT', 8080))
HOST = os.environ.get('HOST', '0.0.0.0')
ROOT = os.path.dirname(os.path.abspath(__file__))

WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_MSG_BYTES = 4096
MAX_ROOM_SIZE = 8
MAX_ROOMS = 256
MAP_DIR = os.environ.get('FPV_MAP_DIR', '/tmp')

# A client that goes away without a close frame is dropped after this long
# with no frames. Clients ping every 15 s; 90 s tolerates background-tab
# timer throttling without leaving ghost pilots in the room forever.
IDLE_TIMEOUT = 90.0

# Guard against state floods from a modified client.
STATE_RATE_MAX = 60
STATE_RATE_WINDOW = 1.0

ROOM_CODE_RE = re.compile(r'^[A-Z0-9]{1,12}$')
MAP_FILE_RE = re.compile(r'^[A-Z0-9]{1,12}$')

# Rooms: { room_id: {'host': pid, 'public': bool, 'name': str,
#                     'players': {pid: {'ws': writer, 'loadout': obj}}} }
rooms = {}


def gen_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))


def gen_pid():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))


def clean_text(value, fallback='', limit=32):
    """Trim client-supplied text, coerce to str, and cap its length."""
    if value is None:
        value = ''
    elif not isinstance(value, str):
        value = str(value)
    return value.strip()[:limit] or fallback


def clean_vec(value, count, limit=100000.0):
    """Return a list of `count` finite floats, or None if the input is junk."""
    if not isinstance(value, (list, tuple)) or len(value) < count:
        return None
    out = []
    for i in range(count):
        x = value[i]
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            return None
        x = float(x)
        if not math.isfinite(x):
            return None
        out.append(max(-limit, min(limit, x)))
    return out


def map_path(room):
    return os.path.join(MAP_DIR, 'fpv-map-%s.glb' % room)


def delete_map(room):
    try:
        os.remove(map_path(room))
    except OSError:
        pass


async def broadcast_json(room, obj, skip_pid=None):
    """Send one JSON message to every player in a room."""
    payload = json.dumps(obj, separators=(',', ':')).encode('utf-8')
    for pid, p in list(room['players'].items()):
        if pid == skip_pid:
            continue
        try:
            await ws_send_frame(p['ws'], 1, payload)
        except Exception:
            pass


async def remove_player(room_id, pid):
    """Remove a player, close the room if empty, and migrate the host."""
    room = rooms.get(room_id)
    if not room or pid not in room['players']:
        return
    del room['players'][pid]

    if not room['players']:
        del rooms[room_id]
        delete_map(room_id)
        print('[room] closed %s' % room_id)
        return

    await broadcast_json(room, {'t': 'peer_leave', 'pid': pid})

    if room.get('host') == pid:
        new_host = next(iter(room['players']))
        room['host'] = new_host
        nickname = room['players'][new_host].get('nickname') or 'Pilot'
        await broadcast_json(room, {
            't': 'host_change', 'pid': new_host, 'nickname': nickname
        })
        print('[room] host %s -> %s in %s' % (pid, new_host, room_id))


# --- WebSocket helpers ---------------------------------------------------

def ws_accept_header(key):
    accept = base64.b64encode(
        hashlib.sha1((key + WS_MAGIC).encode('ascii')).digest()
    ).decode('ascii')
    return (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        'Sec-WebSocket-Accept: ' + accept + '\r\n'
        '\r\n'
    )


async def ws_read_frame(reader):
    """Read one WS frame. Returns (opcode, payload_bytes) or raises."""
    hdr = await reader.readexactly(2)
    b1, b2 = hdr[0], hdr[1]
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack('>H', await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack('>Q', await reader.readexactly(8))[0]
    if length > MAX_MSG_BYTES:
        raise ValueError('frame too large: %d' % length)
    mask = await reader.readexactly(4) if masked else b'\x00\x00\x00\x00'
    payload = bytearray(await reader.readexactly(length))
    if masked:
        for i in range(length):
            payload[i] ^= mask[i % 4]
    return opcode, bytes(payload)


async def ws_send_frame(writer, opcode, payload):
    length = len(payload)
    hdr = bytes([0x80 | opcode])
    if length < 126:
        hdr += bytes([length])
    elif length < 65536:
        hdr += bytes([126]) + struct.pack('>H', length)
    else:
        hdr += bytes([127]) + struct.pack('>Q', length)
    writer.write(hdr + payload)
    await writer.drain()


async def ws_send_json(writer, obj):
    await ws_send_frame(writer, 1, json.dumps(obj).encode('utf-8'))


def http_response(status, headers, body=b''):
    """Build a complete HTTP/1.1 response.

    This server handles exactly one request per TCP connection, so every
    response advertises `Connection: close`. Letting the client assume a
    persistent connection while the server closes the socket makes browsers
    (notably Safari) and the Cloudflare tunnel occasionally lose resources
    such as js/audio.js and js/physics.js, which then look like missing
    globals (`Audio` / `Drone`) in the page.
    """
    lines = ['HTTP/1.1 ' + status, 'Connection: close']
    lines.extend(name + ': ' + value for name, value in headers)
    lines.append('Content-Length: ' + str(len(body)))
    return ('\r\n'.join(lines) + '\r\n\r\n').encode('ascii') + body


# --- Request handling ----------------------------------------------------

async def handle_client(reader, writer):
    try:
        req = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), timeout=5.0)
    except Exception:
        try: writer.close()
        except Exception: pass
        return

    lines = req.decode('latin-1').split('\r\n')
    try:
        method, path, _ = lines[0].split(' ', 2)
    except ValueError:
        try: writer.close()
        except Exception: pass
        return

    headers = {}
    for line in lines[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            headers[k.strip().lower()] = v.strip()

    # WebSocket upgrade?
    if headers.get('upgrade', '').lower() == 'websocket':
        key = headers.get('sec-websocket-key', '')
        if not key:
            try: writer.close()
            except Exception: pass
            return
        try:
            writer.write(ws_accept_header(key).encode('ascii'))
            await writer.drain()
        except Exception:
            try: writer.close()
            except Exception: pass
            return
        await ws_session(reader, writer)
        return

    # /mp-status probe
    if path.endswith('mp-status'):
        body = json.dumps({
            'enabled': True, 'version': 1, 'rooms': len(rooms)
        }).encode('utf-8')
        writer.write(http_response('200 OK', [
            ('Content-Type', 'application/json'),
            ('Cache-Control', 'no-store'),
            ('Access-Control-Allow-Origin', '*'),
        ], body))
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return

    # /servers — public lobby browser
    if method == 'GET' and path.split('?', 1)[0].endswith('/servers'):
        public_rooms = []
        for code, room in rooms.items():
            if not room.get('public'):
                continue
            players = room['players']
            host = players.get(room.get('host'))
            public_rooms.append({
                'room': code,
                'name': room.get('name') or 'Lobby',
                'host': (host or {}).get('nickname') or 'Pilot',
                'players': len(players),
                'max': MAX_ROOM_SIZE,
                'full': len(players) >= MAX_ROOM_SIZE,
                'map': bool(room.get('map_url')),
            })
        public_rooms.sort(key=lambda r: (-r['players'], r['name'].lower(), r['room']))
        body = json.dumps({
            'enabled': True, 'rooms': public_rooms
        }).encode('utf-8')
        writer.write(http_response('200 OK', [
            ('Content-Type', 'application/json'),
            ('Cache-Control', 'no-store'),
            ('Access-Control-Allow-Origin', '*'),
        ], body))
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return

    # POST /upload-map?room=ABC123
    if method == 'POST' and path.startswith('/upload-map'):
        content_length = int(headers.get('content-length', 0))
        if content_length > 50 * 1024 * 1024:
            writer.write(http_response('413 Payload Too Large', []))
            try: await writer.drain()
            except Exception: pass
            try: writer.close()
            except Exception: pass
            return
        body = b''
        while len(body) < content_length:
            chunk = await asyncio.wait_for(reader.read(content_length - len(body)), timeout=30.0)
            if not chunk: break
            body += chunk
        params = parse_qs(path.split('?', 1)[1] if '?' in path else '')
        room = (params.get('room') or [''])[0].strip().upper()
        if ROOM_CODE_RE.match(room) and room in rooms:
            fs_path = map_path(room)
            with open(fs_path, 'wb') as f:
                f.write(body)
            version = int(time.time() * 1000)
            rooms[room]['map_url'] = f'/map/{room}.glb?v={version}'
            await broadcast_json(rooms[room], {
                't': 'map_change', 'url': rooms[room]['map_url']
            })
            writer.write(http_response('200 OK', []))
        else:
            writer.write(http_response('400 Bad Request', []))
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return

    # GET /map/<room>.glb
    if path.startswith('/map/'):
        room = path.split('/')[-1].split('?', 1)[0]
        if room.endswith('.glb'):
            room = room[:-4]
        fs_path = map_path(room) if MAP_FILE_RE.match(room) else None
        if fs_path and os.path.exists(fs_path):
            with open(fs_path, 'rb') as f:
                body = f.read()
            writer.write(http_response('200 OK', [
                ('Content-Type', 'model/gltf-binary'),
                ('Cache-Control', 'no-cache'),
            ], body))
        else:
            writer.write(http_response('404 Not Found', []))
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return

    # Static file serving
    rel = path.split('?', 1)[0].lstrip('/')
    if rel == '':
        rel = 'index.html'
    fs_path = os.path.normpath(os.path.join(ROOT, rel))
    try:
        inside_root = os.path.commonpath([ROOT, fs_path]) == ROOT
    except ValueError:
        inside_root = False
    if not inside_root:
        writer.write(http_response('403 Forbidden', []))
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return
    if os.path.isdir(fs_path):
        fs_path = os.path.join(fs_path, 'index.html')
    if not os.path.exists(fs_path) or not os.path.isfile(fs_path):
        writer.write(http_response('404 Not Found', []))
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return

    ctype = mimetypes.guess_type(fs_path)[0] or 'application/octet-stream'
    try:
        with open(fs_path, 'rb') as f:
            body = f.read()
    except Exception:
        writer.write(http_response('500 Internal Server Error', []))
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return

    writer.write(http_response('200 OK', [
        ('Content-Type', ctype),
        ('Cache-Control', 'no-store, no-cache, must-revalidate'),
        ('Pragma', 'no-cache'),
        ('Expires', '0'),
    ], body))
    try: await writer.drain()
    except Exception: pass
    try: writer.close()
    except Exception: pass


# --- WebSocket session ---------------------------------------------------

async def ws_session(reader, writer):
    pid = gen_pid()
    room_id = None
    state_window_start = time.monotonic()
    state_count = 0
    try:
        while True:
            opcode, payload = await asyncio.wait_for(ws_read_frame(reader), timeout=IDLE_TIMEOUT)
            if opcode == 8:  # close
                break
            if opcode == 9:  # ping
                await ws_send_frame(writer, 10, payload)
                continue
            if opcode not in (1, 2):
                continue
            try:
                msg = json.loads(payload.decode('utf-8'))
            except Exception:
                continue
            t = msg.get('t')

            # Application-level heartbeat (distinct from WS control pings,
            # which browsers cannot send directly).
            if t == 'ping':
                await ws_send_json(writer, {
                    't': 'pong',
                    'ts': msg.get('ts'),
                    'time': int(time.time() * 1000)
                })
                continue

            if t == 'create':
                if room_id:
                    await remove_player(room_id, pid)
                    room_id = None
                if len(rooms) >= MAX_ROOMS:
                    await ws_send_json(writer, {'t': 'error', 'msg': 'server full'})
                    continue
                code = gen_code()
                while code in rooms:
                    code = gen_code()
                nickname = clean_text(msg.get('nickname'), 'Pilot')
                name = clean_text(msg.get('name'), nickname + "'s lobby")
                public = bool(msg.get('public'))
                rooms[code] = {
                    'host': pid,
                    'players': {},
                    'map_url': None,
                    'public': public,
                    'name': name,
                }
                rooms[code]['players'][pid] = {'ws': writer, 'loadout': msg.get('loadout'), 'nickname': nickname}
                room_id = code
                await ws_send_json(writer, {
                    't': 'created', 'room': code, 'pid': pid, 'nickname': nickname,
                    'public': public, 'name': name, 'host': pid
                })
                print('[room] create %s "%s" (%s) by %s' % (code, name, 'public' if public else 'private', pid))

            elif t == 'join':
                code = clean_text(msg.get('room'), '', 12).upper()
                if not ROOM_CODE_RE.match(code) or code not in rooms:
                    await ws_send_json(writer, {'t': 'error', 'msg': 'room not found'})
                    continue
                if len(rooms[code]['players']) >= MAX_ROOM_SIZE and pid not in rooms[code]['players']:
                    await ws_send_json(writer, {'t': 'error', 'msg': 'room full'})
                    continue
                if room_id and room_id != code:
                    await remove_player(room_id, pid)
                    room_id = None
                room_id = code
                nickname = clean_text(msg.get('nickname'), 'Pilot')
                rooms[code]['players'][pid] = {'ws': writer, 'loadout': msg.get('loadout'), 'nickname': nickname}
                others = [
                    {'pid': op, 'loadout': rooms[code]['players'][op]['loadout'], 'nickname': rooms[code]['players'][op].get('nickname', 'Pilot')}
                    for op in rooms[code]['players'] if op != pid
                ]
                map_url = rooms[code].get('map_url')
                await ws_send_json(writer, {
                    't': 'joined', 'room': code, 'pid': pid, 'others': others,
                    'map_url': map_url,
                    'public': bool(rooms[code].get('public')),
                    'name': rooms[code].get('name') or 'Lobby',
                    'host': rooms[code].get('host')
                })
                for op, p in list(rooms[code]['players'].items()):
                    if op == pid:
                        continue
                    try:
                        await ws_send_json(p['ws'], {
                            't': 'peer_join', 'pid': pid, 'loadout': msg.get('loadout'), 'nickname': nickname
                        })
                    except Exception:
                        pass
                print('[room] join %s by %s (%d players)' % (code, pid, len(rooms[code]['players'])))

            elif t == 'state' and room_id and room_id in rooms:
                now = time.monotonic()
                if now - state_window_start > STATE_RATE_WINDOW:
                    state_window_start = now
                    state_count = 0
                state_count += 1
                if state_count > STATE_RATE_MAX:
                    continue

                p = clean_vec(msg.get('p'), 3, 10000.0)
                q = clean_vec(msg.get('q'), 4, 1.0)
                v = clean_vec(msg.get('v'), 3, 1000.0)
                if p is None or q is None:
                    continue

                out = {
                    't': 'state', 'pid': pid,
                    'p': p, 'q': q, 'v': v or [0.0, 0.0, 0.0],
                    'armed': bool(msg.get('armed')),
                    'crashed': bool(msg.get('crashed'))
                }
                n = msg.get('n')
                if isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 2 ** 31:
                    out['n'] = n

                # Serialize once, then fan the same bytes out to each peer.
                frame = json.dumps(out, separators=(',', ':')).encode('utf-8')
                for op, p in list(rooms[room_id]['players'].items()):
                    if op == pid:
                        continue
                    try:
                        await ws_send_frame(p['ws'], 1, frame)
                    except Exception:
                        pass

            elif t == 'leave':
                break

    except (asyncio.IncompleteReadError, ConnectionResetError, asyncio.TimeoutError):
        pass
    except Exception as e:
        print('[ws error]', repr(e))
    finally:
        if room_id and room_id in rooms:
            try:
                await remove_player(room_id, pid)
            except Exception as e:
                print('[ws cleanup error]', repr(e))
        try:
            writer.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle_client, HOST, PORT)
    print('FPV Sim server on http://%s:%d' % (HOST, PORT))
    print('  - static files from %s' % ROOT)
    print('  - /mp-status for MP probe')
    print('  - /ws for multiplayer relay')
    print('Press Ctrl+C to stop.')
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('\nserver stopped')
