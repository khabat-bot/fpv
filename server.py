#!/usr/bin/env python3
"""
server.py — FPV Sim static server + WebSocket relay.

Pure Python stdlib (asyncio). No pip deps. Run with:
    python3 server.py
Then open http://localhost:8080

Endpoints:
    GET  /              static files under this directory
    GET  /mp-status     {"enabled": true, "version": 1, "rooms": N}
    WS   /ws            multiplayer relay

Protocol (JSON messages):
    Client -> Server:
        {"t":"create", "loadout":{...}}
        {"t":"join",   "room":"ABC123", "loadout":{...}}
        {"t":"state",  "p":[x,y,z], "q":[x,y,z,w], "v":[x,y,z],
                       "armed":bool, "crashed":bool}
        {"t":"leave"}

    Server -> Client:
        {"t":"created","room":"ABC123","pid":"<id>"}
        {"t":"joined","room":"ABC123","pid":"<id>",
                      "others":[{"pid":"...","loadout":{...}}, ...]}
        {"t":"peer_join","pid":"<id>","loadout":{...}}
        {"t":"peer_leave","pid":"<id>"}
        {"t":"state","pid":"<id>","p":[...],"q":[...],"v":[...],
                     "armed":bool,"crashed":bool}
        {"t":"error","msg":"..."}
"""
import asyncio, os, sys, json, hashlib, base64, struct, random, string
import mimetypes

PORT = int(os.environ.get('PORT', 8080))
HOST = os.environ.get('HOST', '0.0.0.0')
ROOT = os.path.dirname(os.path.abspath(__file__))

WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_MSG_BYTES = 4096
MAX_ROOM_SIZE = 8

# Rooms: { room_id: {'host': pid, 'players': {pid: {'ws': writer, 'loadout': obj}}} }
rooms = {}


def gen_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))


def gen_pid():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))


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
        writer.write(
            b'HTTP/1.1 200 OK\r\n'
            b'Content-Type: application/json\r\n'
            b'Cache-Control: no-store\r\n'
            b'Access-Control-Allow-Origin: *\r\n'
            b'Content-Length: ' + str(len(body)).encode('ascii') + b'\r\n'
            b'\r\n' + body
        )
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
    if not fs_path.startswith(ROOT):
        writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return
    if os.path.isdir(fs_path):
        fs_path = os.path.join(fs_path, 'index.html')
    if not os.path.exists(fs_path) or not os.path.isfile(fs_path):
        writer.write(b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
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
        writer.write(b'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n')
        try: await writer.drain()
        except Exception: pass
        try: writer.close()
        except Exception: pass
        return

    writer.write(
        ('HTTP/1.1 200 OK\r\n'
         'Content-Type: ' + ctype + '\r\n'
         'Cache-Control: no-cache\r\n'
         'Content-Length: ' + str(len(body)) + '\r\n'
         '\r\n').encode('ascii') + body
    )
    try: await writer.drain()
    except Exception: pass
    try: writer.close()
    except Exception: pass


# --- WebSocket session ---------------------------------------------------

async def ws_session(reader, writer):
    pid = gen_pid()
    room_id = None
    try:
        while True:
            opcode, payload = await ws_read_frame(reader)
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

            if t == 'create':
                code = gen_code()
                while code in rooms:
                    code = gen_code()
                rooms[code] = {'host': pid, 'players': {}}
                rooms[code]['players'][pid] = {'ws': writer, 'loadout': msg.get('loadout')}
                room_id = code
                await ws_send_json(writer, {'t': 'created', 'room': code, 'pid': pid})
                print('[room] create %s by %s' % (code, pid))

            elif t == 'join':
                code = (msg.get('room') or '').strip().upper()
                if code not in rooms:
                    await ws_send_json(writer, {'t': 'error', 'msg': 'room not found'})
                    continue
                if len(rooms[code]['players']) >= MAX_ROOM_SIZE:
                    await ws_send_json(writer, {'t': 'error', 'msg': 'room full'})
                    continue
                room_id = code
                rooms[code]['players'][pid] = {'ws': writer, 'loadout': msg.get('loadout')}
                others = [
                    {'pid': op, 'loadout': rooms[code]['players'][op]['loadout']}
                    for op in rooms[code]['players'] if op != pid
                ]
                await ws_send_json(writer, {
                    't': 'joined', 'room': code, 'pid': pid, 'others': others
                })
                for op, p in list(rooms[code]['players'].items()):
                    if op == pid:
                        continue
                    try:
                        await ws_send_json(p['ws'], {
                            't': 'peer_join', 'pid': pid, 'loadout': msg.get('loadout')
                        })
                    except Exception:
                        pass
                print('[room] join %s by %s (%d players)' % (code, pid, len(rooms[code]['players'])))

            elif t == 'state' and room_id and room_id in rooms:
                out = {
                    't': 'state', 'pid': pid,
                    'p': msg.get('p'), 'q': msg.get('q'), 'v': msg.get('v'),
                    'armed': bool(msg.get('armed')),
                    'crashed': bool(msg.get('crashed'))
                }
                for op, p in list(rooms[room_id]['players'].items()):
                    if op == pid:
                        continue
                    try:
                        await ws_send_json(p['ws'], out)
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
            rooms[room_id]['players'].pop(pid, None)
            if not rooms[room_id]['players']:
                del rooms[room_id]
                print('[room] closed %s' % room_id)
            else:
                for op, p in list(rooms[room_id]['players'].items()):
                    try:
                        await ws_send_json(p['ws'], {'t': 'peer_leave', 'pid': pid})
                    except Exception:
                        pass
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
