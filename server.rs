//! server.rs - FPV Sim static server + WebSocket relay.
//!
//! Single file, Rust standard library only (no Cargo, no crates).
//!
//! Build:  rustc -O server.rs -o fpv_server
//! Run:    ./fpv_server        then open http://localhost:8080
//!
//! Env vars: PORT (8080), HOST (0.0.0.0), FPV_MAP_DIR (/tmp),
//!           FPV_ROOT (directory to serve; defaults to the current directory)
//!
//! Endpoints:
//!   GET  /              static files under the root directory
//!   GET  /mp-status     {"enabled":true,"version":1,"rooms":N}
//!   GET  /servers       public lobby browser data
//!   POST /upload-map?room=ABC123
//!   GET  /map/<room>.glb
//!   WS   /ws            multiplayer relay (same JSON protocol as server.py)
//!
//! Needs Rust 1.70 or newer (uses std::sync::OnceLock).

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WS_MAGIC: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MSG_BYTES: u64 = 4096;
const MAX_ROOM_SIZE: usize = 8;
const MAX_ROOMS: usize = 256;

/// A client that goes away without a close frame is dropped after this long
/// with no frames. Clients ping every 15 s; 90 s tolerates background-tab
/// timer throttling.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Guard against state floods from a modified client.
const STATE_RATE_MAX: u32 = 60;
const STATE_RATE_WINDOW: Duration = Duration::from_secs(1);

// ---------------------------------------------------------------------------
// Config / globals
// ---------------------------------------------------------------------------

struct Config {
    root: PathBuf,
    map_dir: String,
}

static CFG: OnceLock<Config> = OnceLock::new();

fn cfg() -> &'static Config {
    CFG.get().expect("config not initialised")
}

type Writer = Arc<Mutex<TcpStream>>;

struct Player {
    w: Writer,
    loadout: Json,
    nickname: String,
}

struct Room {
    host: String,
    public: bool,
    name: String,
    map_url: Option<String>,
    /// Insertion-ordered (like a Python dict) so host migration is deterministic.
    players: Vec<(String, Player)>,
}

fn rooms() -> &'static Mutex<HashMap<String, Room>> {
    static R: OnceLock<Mutex<HashMap<String, Room>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lk<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Messages queued while the global lock is held, sent after it is released
/// so one slow client can never stall everyone else.
type Out = Vec<(Writer, Vec<u8>)>;

fn flush_out(out: Out) {
    for (w, payload) in out {
        let _ = send_frame(&w, 1, &payload);
    }
}

// ---------------------------------------------------------------------------
// Random helpers (std has no RNG; RandomState is seeded randomly per instance)
// ---------------------------------------------------------------------------

fn rand_u64() -> u64 {
    static CTR: AtomicU64 = AtomicU64::new(0);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(CTR.fetch_add(1, Ordering::Relaxed));
    h.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.finish()
}

fn rand_string(alphabet: &[u8], n: usize) -> String {
    (0..n)
        .map(|_| alphabet[(rand_u64() % alphabet.len() as u64) as usize] as char)
        .collect()
}

fn gen_code() -> String {
    rand_string(b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6)
}

fn gen_pid() -> String {
    rand_string(b"abcdefghijklmnopqrstuvwxyz0123456789", 8)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Minimal JSON (parser + serializer)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

fn s(x: &str) -> Json {
    Json::Str(x.to_string())
}

fn jobj(pairs: Vec<(&str, Json)>) -> Json {
    Json::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(v) => v.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn to_json(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Int(n) => out.push_str(&n.to_string()),
            Json::Float(f) => {
                if f.is_nan() {
                    out.push_str("NaN");
                } else if f.is_infinite() {
                    out.push_str(if *f > 0.0 { "Infinity" } else { "-Infinity" });
                } else {
                    out.push_str(&format!("{:?}", f));
                }
            }
            Json::Str(st) => write_json_str(st, out),
            Json::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            Json::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_str(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_json_str(st: &str, out: &mut String) {
    out.push('"');
    for c in st.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn lit(&mut self, word: &str, v: Json) -> Option<Json> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > 400 {
            return None;
        }
        self.ws();
        match self.peek()? {
            b'{' => {
                self.i += 1;
                let mut v: Vec<(String, Json)> = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Some(Json::Obj(v));
                }
                loop {
                    self.ws();
                    if self.peek() != Some(b'"') {
                        return None;
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.peek() != Some(b':') {
                        return None;
                    }
                    self.i += 1;
                    let val = self.value(depth + 1)?;
                    if let Some(e) = v.iter_mut().find(|(kk, _)| *kk == k) {
                        e.1 = val;
                    } else {
                        v.push((k, val));
                    }
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
                Some(Json::Obj(v))
            }
            b'[' => {
                self.i += 1;
                let mut v = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Some(Json::Arr(v));
                }
                loop {
                    v.push(self.value(depth + 1)?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
                Some(Json::Arr(v))
            }
            b'"' => Some(Json::Str(self.string()?)),
            b't' => self.lit("true", Json::Bool(true)),
            b'f' => self.lit("false", Json::Bool(false)),
            b'n' => self.lit("null", Json::Null),
            b'N' => self.lit("NaN", Json::Float(f64::NAN)),
            b'I' => self.lit("Infinity", Json::Float(f64::INFINITY)),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
            if self.peek() == Some(b'I') {
                return self.lit("Infinity", Json::Float(f64::NEG_INFINITY));
            }
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return None,
        }
        let mut float = false;
        if self.peek() == Some(b'.') && matches!(self.b.get(self.i + 1), Some(b'0'..=b'9')) {
            self.i += 1;
            self.digits();
            float = true;
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            let save = self.i;
            self.i += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                self.i = save;
            } else {
                float = true;
            }
        }
        let txt = std::str::from_utf8(&self.b[start..self.i]).ok()?;
        if float {
            Some(Json::Float(txt.parse().ok()?))
        } else {
            match txt.parse::<i64>() {
                Ok(n) => Some(Json::Int(n)),
                Err(_) => Some(Json::Float(txt.parse().ok()?)),
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        if self.i + 4 > self.b.len() {
            return None;
        }
        let t = std::str::from_utf8(&self.b[self.i..self.i + 4]).ok()?;
        if !t.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        self.i += 4;
        u32::from_str_radix(t, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1; // opening quote
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0c),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let cp = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&cp) {
                                if self.b[self.i..].starts_with(b"\\u") {
                                    let save = self.i;
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if (0xDC00..0xE000).contains(&lo) {
                                        char::from_u32(0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00))
                                            .unwrap_or('\u{FFFD}')
                                    } else {
                                        self.i = save;
                                        '\u{FFFD}'
                                    }
                                } else {
                                    '\u{FFFD}'
                                }
                            } else {
                                char::from_u32(cp).unwrap_or('\u{FFFD}')
                            };
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => return None,
                    }
                }
                0..=0x1f => return None,
                _ => out.push(c),
            }
        }
        String::from_utf8(out).ok()
    }
}

fn parse_json(b: &[u8]) -> Option<Json> {
    let mut p = Parser { b, i: 0 };
    let v = p.value(0)?;
    p.ws();
    if p.i != b.len() {
        None
    } else {
        Some(v)
    }
}

// --- Python-ish coercions, to match server.py's behaviour on odd input ----

fn truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Int(n) => *n != 0,
        Json::Float(f) => *f != 0.0,
        Json::Str(x) => !x.is_empty(),
        Json::Arr(a) => !a.is_empty(),
        Json::Obj(o) => !o.is_empty(),
    }
}

fn py_repr(v: &Json) -> String {
    match v {
        Json::Null => "None".into(),
        Json::Bool(true) => "True".into(),
        Json::Bool(false) => "False".into(),
        Json::Int(n) => n.to_string(),
        Json::Float(f) => {
            if f.is_nan() {
                "nan".into()
            } else if f.is_infinite() {
                if *f > 0.0 { "inf".into() } else { "-inf".into() }
            } else {
                format!("{:?}", f)
            }
        }
        Json::Str(x) => format!("'{}'", x.replace('\\', "\\\\").replace('\'', "\\'")),
        Json::Arr(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Json::Obj(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("'{}': {}", k, py_repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Trim client-supplied text, coerce to a string, and cap its length.
fn clean_text(value: Option<&Json>, fallback: &str, limit: usize) -> String {
    let raw = match value {
        None | Some(Json::Null) => String::new(),
        Some(Json::Str(x)) => x.clone(),
        Some(v) => py_repr(v),
    };
    let t: String = raw.trim().chars().take(limit).collect();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t
    }
}

/// Return `count` finite floats clamped to +/-limit, or None if the input is junk.
fn clean_vec(value: Option<&Json>, count: usize, limit: f64) -> Option<Vec<f64>> {
    let Some(Json::Arr(a)) = value else {
        return None;
    };
    if a.len() < count {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for item in a.iter().take(count) {
        let x = match item {
            Json::Int(n) => *n as f64,
            Json::Float(f) => *f,
            _ => return None,
        };
        if !x.is_finite() {
            return None;
        }
        out.push(x.max(-limit).min(limit));
    }
    Some(out)
}

fn floats(v: Vec<f64>) -> Json {
    Json::Arr(v.into_iter().map(Json::Float).collect())
}

// ---------------------------------------------------------------------------
// SHA-1 + Base64 (needed for the WebSocket handshake)
// ---------------------------------------------------------------------------

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bitlen = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | (*c.get(2).unwrap_or(&0) as u32);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn ws_accept_header(key: &str) -> String {
    let accept = base64(&sha1(format!("{}{}", key, WS_MAGIC).as_bytes()));
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        accept
    )
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// ^[A-Z0-9]{1,12}$
fn is_code(x: &str) -> bool {
    !x.is_empty() && x.len() <= 12 && x.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn map_path(room: &str) -> PathBuf {
    Path::new(&cfg().map_dir).join(format!("fpv-map-{}.glb", room))
}

fn delete_map(room: &str) {
    let _ = std::fs::remove_file(map_path(room));
}

fn percent_decode(x: &str) -> String {
    let b = x.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 + 0 || (b[i] == b'%' && i + 2 < b.len() + 1 && i + 2 <= b.len() - 1) => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(v) => {
                        out.push(v);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if percent_decode(k) == name {
                return Some(percent_decode(v));
            }
        }
    }
    None
}

fn guess_type(p: &Path) -> &'static str {
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "txt" => "text/plain",
        "xml" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/vnd.microsoft.icon",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/x-wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------

fn broadcast(room: &Room, msg: &Json, skip_pid: Option<&str>, out: &mut Out) {
    let payload = msg.to_json().into_bytes();
    for (pid, p) in &room.players {
        if Some(pid.as_str()) == skip_pid {
            continue;
        }
        out.push((p.w.clone(), payload.clone()));
    }
}

/// Remove a player, close the room if empty, and migrate the host.
/// Called with the rooms lock held; messages are queued into `out`.
fn remove_player_locked(rooms: &mut HashMap<String, Room>, room_id: &str, pid: &str, out: &mut Out) {
    let Some(room) = rooms.get_mut(room_id) else {
        return;
    };
    let Some(idx) = room.players.iter().position(|(p, _)| p == pid) else {
        return;
    };
    room.players.remove(idx);

    if room.players.is_empty() {
        rooms.remove(room_id);
        delete_map(room_id);
        println!("[room] closed {}", room_id);
        return;
    }

    broadcast(room, &jobj(vec![("t", s("peer_leave")), ("pid", s(pid))]), None, out);

    if room.host == pid {
        let new_host = room.players[0].0.clone();
        let nick = {
            let n = &room.players[0].1.nickname;
            if n.is_empty() { "Pilot".to_string() } else { n.clone() }
        };
        room.host = new_host.clone();
        broadcast(
            room,
            &jobj(vec![("t", s("host_change")), ("pid", s(&new_host)), ("nickname", s(&nick))]),
            None,
            out,
        );
        println!("[room] host {} -> {} in {}", pid, new_host, room_id);
    }
}

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

fn read_frame(r: &mut BufReader<TcpStream>) -> io::Result<(u8, Vec<u8>)> {
    let mut h = [0u8; 2];
    r.read_exact(&mut h)?;
    let opcode = h[0] & 0x0F;
    let masked = h[1] & 0x80 != 0;
    let mut len = (h[1] & 0x7F) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b)?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b)?;
        len = u64::from_be_bytes(b);
    }
    if len > MAX_MSG_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame too large: {}", len)));
    }
    let mut mask = [0u8; 4];
    if masked {
        r.read_exact(&mut mask)?;
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    Ok((opcode, payload))
}

fn send_frame(w: &Writer, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let len = payload.len();
    let mut buf = Vec::with_capacity(10 + len);
    buf.push(0x80 | opcode);
    if len < 126 {
        buf.push(len as u8);
    } else if len < 65536 {
        buf.push(126);
        buf.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        buf.push(127);
        buf.extend_from_slice(&(len as u64).to_be_bytes());
    }
    buf.extend_from_slice(payload);
    let mut st = lk(w);
    st.write_all(&buf)?;
    st.flush()
}

fn send_json(w: &Writer, v: &Json) -> io::Result<()> {
    send_frame(w, 1, v.to_json().as_bytes())
}

// ---------------------------------------------------------------------------
// WebSocket session
// ---------------------------------------------------------------------------

fn ws_session(mut reader: BufReader<TcpStream>, writer: Writer) {
    let _ = lk(&writer).set_read_timeout(Some(IDLE_TIMEOUT));
    let pid = gen_pid();
    let mut room_id: Option<String> = None;

    let res = ws_loop(&mut reader, &writer, &pid, &mut room_id);
    if let Err(e) = res {
        use io::ErrorKind::*;
        match e.kind() {
            TimedOut | WouldBlock | UnexpectedEof | ConnectionReset | ConnectionAborted | BrokenPipe => {}
            _ => println!("[ws error] {:?}", e),
        }
    }

    if let Some(rid) = room_id {
        let mut out: Out = Vec::new();
        {
            let mut g = lk(rooms());
            remove_player_locked(&mut g, &rid, &pid, &mut out);
        }
        flush_out(out);
    }
    let _ = lk(&writer).shutdown(Shutdown::Both);
}

fn ws_loop(
    reader: &mut BufReader<TcpStream>,
    writer: &Writer,
    pid: &str,
    room_id: &mut Option<String>,
) -> io::Result<()> {
    let mut win_start = Instant::now();
    let mut count: u32 = 0;

    loop {
        let (opcode, payload) = read_frame(reader)?;
        if opcode == 8 {
            break; // close
        }
        if opcode == 9 {
            send_frame(writer, 10, &payload)?; // ping -> pong
            continue;
        }
        if opcode != 1 && opcode != 2 {
            continue;
        }
        let text = match std::str::from_utf8(&payload) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let msg = match parse_json(text.as_bytes()) {
            Some(m) => m,
            None => continue,
        };
        if !matches!(msg, Json::Obj(_)) {
            println!("[ws error] message is not an object");
            break;
        }
        let t = match msg.get("t") {
            Some(Json::Str(x)) => x.as_str(),
            _ => "",
        };

        match t {
            // Application-level heartbeat.
            "ping" => {
                let ts = msg.get("ts").cloned().unwrap_or(Json::Null);
                send_json(
                    writer,
                    &jobj(vec![("t", s("pong")), ("ts", ts), ("time", Json::Int(now_ms() as i64))]),
                )?;
            }

            "create" => {
                let mut out: Out = Vec::new();
                let mut g = lk(rooms());
                if let Some(rid) = room_id.take() {
                    remove_player_locked(&mut g, &rid, pid, &mut out);
                }
                if g.len() >= MAX_ROOMS {
                    drop(g);
                    flush_out(out);
                    send_json(writer, &jobj(vec![("t", s("error")), ("msg", s("server full"))]))?;
                    continue;
                }
                let mut code = gen_code();
                while g.contains_key(&code) {
                    code = gen_code();
                }
                let nickname = clean_text(msg.get("nickname"), "Pilot", 32);
                let name = clean_text(msg.get("name"), &format!("{}'s lobby", nickname), 32);
                let public = msg.get("public").map(truthy).unwrap_or(false);
                g.insert(
                    code.clone(),
                    Room {
                        host: pid.to_string(),
                        public,
                        name: name.clone(),
                        map_url: None,
                        players: vec![(
                            pid.to_string(),
                            Player {
                                w: writer.clone(),
                                loadout: msg.get("loadout").cloned().unwrap_or(Json::Null),
                                nickname: nickname.clone(),
                            },
                        )],
                    },
                );
                drop(g);
                flush_out(out);
                *room_id = Some(code.clone());
                send_json(
                    writer,
                    &jobj(vec![
                        ("t", s("created")),
                        ("room", s(&code)),
                        ("pid", s(pid)),
                        ("nickname", s(&nickname)),
                        ("public", Json::Bool(public)),
                        ("name", s(&name)),
                        ("host", s(pid)),
                    ]),
                )?;
                println!(
                    "[room] create {} \"{}\" ({}) by {}",
                    code,
                    name,
                    if public { "public" } else { "private" },
                    pid
                );
            }

            "join" => {
                let code = clean_text(msg.get("room"), "", 12).to_uppercase();
                let mut out: Out = Vec::new();
                let mut g = lk(rooms());
                if !is_code(&code) || !g.contains_key(&code) {
                    drop(g);
                    send_json(writer, &jobj(vec![("t", s("error")), ("msg", s("room not found"))]))?;
                    continue;
                }
                let full = {
                    let r = &g[&code];
                    r.players.len() >= MAX_ROOM_SIZE && !r.players.iter().any(|(p, _)| p == pid)
                };
                if full {
                    drop(g);
                    send_json(writer, &jobj(vec![("t", s("error")), ("msg", s("room full"))]))?;
                    continue;
                }
                if let Some(rid) = room_id.clone() {
                    if rid != code {
                        remove_player_locked(&mut g, &rid, pid, &mut out);
                        *room_id = None;
                    }
                }
                *room_id = Some(code.clone());

                let nickname = clean_text(msg.get("nickname"), "Pilot", 32);
                let loadout = msg.get("loadout").cloned().unwrap_or(Json::Null);
                let room = g.get_mut(&code).unwrap();
                let player = Player {
                    w: writer.clone(),
                    loadout: loadout.clone(),
                    nickname: nickname.clone(),
                };
                if let Some(slot) = room.players.iter_mut().find(|(p, _)| p == pid) {
                    slot.1 = player;
                } else {
                    room.players.push((pid.to_string(), player));
                }

                let others = Json::Arr(
                    room.players
                        .iter()
                        .filter(|(p, _)| p != pid)
                        .map(|(p, pl)| {
                            jobj(vec![
                                ("pid", s(p)),
                                ("loadout", pl.loadout.clone()),
                                ("nickname", s(&pl.nickname)),
                            ])
                        })
                        .collect(),
                );
                let joined = jobj(vec![
                    ("t", s("joined")),
                    ("room", s(&code)),
                    ("pid", s(pid)),
                    ("others", others),
                    ("map_url", room.map_url.as_deref().map(s).unwrap_or(Json::Null)),
                    ("public", Json::Bool(room.public)),
                    (
                        "name",
                        s(if room.name.is_empty() { "Lobby" } else { &room.name }),
                    ),
                    ("host", s(&room.host)),
                ]);
                out.push((writer.clone(), joined.to_json().into_bytes()));

                let peer = jobj(vec![
                    ("t", s("peer_join")),
                    ("pid", s(pid)),
                    ("loadout", loadout),
                    ("nickname", s(&nickname)),
                ])
                .to_json()
                .into_bytes();
                for (p, pl) in &room.players {
                    if p != pid {
                        out.push((pl.w.clone(), peer.clone()));
                    }
                }
                let n = room.players.len();
                drop(g);
                flush_out(out);
                println!("[room] join {} by {} ({} players)", code, pid, n);
            }

            "state" => {
                let Some(rid) = room_id.clone() else {
                    continue;
                };
                let now = Instant::now();
                if now.duration_since(win_start) > STATE_RATE_WINDOW {
                    win_start = now;
                    count = 0;
                }
                count += 1;
                if count > STATE_RATE_MAX {
                    continue;
                }

                let p = clean_vec(msg.get("p"), 3, 10000.0);
                let q = clean_vec(msg.get("q"), 4, 1.0);
                let v = clean_vec(msg.get("v"), 3, 1000.0);
                let (Some(p), Some(q)) = (p, q) else {
                    continue;
                };

                let mut pairs = vec![
                    ("t", s("state")),
                    ("pid", s(pid)),
                    ("p", floats(p)),
                    ("q", floats(q)),
                    ("v", floats(v.unwrap_or_else(|| vec![0.0, 0.0, 0.0]))),
                    ("armed", Json::Bool(msg.get("armed").map(truthy).unwrap_or(false))),
                    ("crashed", Json::Bool(msg.get("crashed").map(truthy).unwrap_or(false))),
                ];
                if let Some(Json::Int(n)) = msg.get("n") {
                    if *n >= 0 && *n < (1i64 << 31) {
                        pairs.push(("n", Json::Int(*n)));
                    }
                }

                // Serialize once, fan the same bytes out to each peer
                // (outside the global lock).
                let frame = jobj(pairs).to_json().into_bytes();
                let peers: Vec<Writer> = {
                    let g = lk(rooms());
                    match g.get(&rid) {
                        Some(room) => room
                            .players
                            .iter()
                            .filter(|(op, _)| op != pid)
                            .map(|(_, pl)| pl.w.clone())
                            .collect(),
                        None => Vec::new(),
                    }
                };
                for w in peers {
                    let _ = send_frame(&w, 1, &frame);
                }
            }

            "leave" => break,

            _ => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// Build a complete HTTP/1.1 response. One request per TCP connection, so
/// every response advertises `Connection: close`.
fn http_response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut h = format!("HTTP/1.1 {}\r\nConnection: close\r\n", status);
    for (k, v) in headers {
        h.push_str(k);
        h.push_str(": ");
        h.push_str(v);
        h.push_str("\r\n");
    }
    h.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    let mut out = h.into_bytes();
    out.extend_from_slice(body);
    out
}

fn respond(st: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
    let _ = st.write_all(&http_response(status, headers, body));
    let _ = st.flush();
    let _ = st.shutdown(Shutdown::Write);
}

fn handle_client(mut stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let mut reader = match stream.try_clone() {
        Ok(c) => BufReader::new(c),
        Err(_) => return,
    };

    // Read the request head.
    let mut lines: Vec<String> = Vec::new();
    let mut total = 0usize;
    loop {
        let mut line = Vec::new();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                total += n;
                if total > 65536 {
                    return;
                }
            }
        }
        while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
            line.pop();
        }
        if line.is_empty() {
            break;
        }
        // latin-1 decode, like the original
        lines.push(line.iter().map(|&b| b as char).collect());
    }
    if lines.is_empty() {
        return;
    }
    let parts: Vec<&str> = lines[0].splitn(3, ' ').collect();
    if parts.len() < 3 {
        return;
    }
    let method = parts[0].to_string();
    let path = parts[1].to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    for line in &lines[1..] {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }

    // WebSocket upgrade?
    if headers
        .get("upgrade")
        .map(|u| u.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
    {
        let key = headers.get("sec-websocket-key").cloned().unwrap_or_default();
        if key.is_empty() {
            return;
        }
        if stream.write_all(ws_accept_header(&key).as_bytes()).is_err() || stream.flush().is_err() {
            return;
        }
        ws_session(reader, Arc::new(Mutex::new(stream)));
        return;
    }

    let no_store_json = [("Content-Type", "application/json"), ("Cache-Control", "no-store"), ("Access-Control-Allow-Origin", "*")];

    // /mp-status probe
    if path.ends_with("mp-status") {
        let n = lk(rooms()).len();
        let body = format!("{{\"enabled\":true,\"version\":1,\"rooms\":{}}}", n);
        respond(&mut stream, "200 OK", &no_store_json, body.as_bytes());
        return;
    }

    // /servers - public lobby browser
    if method == "GET" && path.split('?').next().unwrap_or("").ends_with("/servers") {
        struct Row {
            code: String,
            name: String,
            host: String,
            players: usize,
            map: bool,
        }
        let mut list: Vec<Row> = Vec::new();
        {
            let g = lk(rooms());
            for (code, room) in g.iter() {
                if !room.public {
                    continue;
                }
                let host_nick = room
                    .players
                    .iter()
                    .find(|(p, _)| *p == room.host)
                    .map(|(_, pl)| pl.nickname.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "Pilot".to_string());
                list.push(Row {
                    code: code.clone(),
                    name: if room.name.is_empty() { "Lobby".into() } else { room.name.clone() },
                    host: host_nick,
                    players: room.players.len(),
                    map: room.map_url.is_some(),
                });
            }
        }
        list.sort_by(|a, b| {
            b.players
                .cmp(&a.players)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then(a.code.cmp(&b.code))
        });
        let arr = Json::Arr(
            list.iter()
                .map(|r| {
                    jobj(vec![
                        ("room", s(&r.code)),
                        ("name", s(&r.name)),
                        ("host", s(&r.host)),
                        ("players", Json::Int(r.players as i64)),
                        ("max", Json::Int(MAX_ROOM_SIZE as i64)),
                        ("full", Json::Bool(r.players >= MAX_ROOM_SIZE)),
                        ("map", Json::Bool(r.map)),
                    ])
                })
                .collect(),
        );
        let body = jobj(vec![("enabled", Json::Bool(true)), ("rooms", arr)]).to_json();
        respond(&mut stream, "200 OK", &no_store_json, body.as_bytes());
        return;
    }

    // POST /upload-map?room=ABC123
    if method == "POST" && path.starts_with("/upload-map") {
        let cl: i64 = match headers.get("content-length") {
            Some(v) => match v.parse() {
                Ok(n) => n,
                Err(_) => return,
            },
            None => 0,
        };
        if cl > 50 * 1024 * 1024 {
            respond(&mut stream, "413 Payload Too Large", &[], b"");
            return;
        }
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let want = cl.max(0) as usize;
        let mut body: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 65536];
        while body.len() < want {
            let take = (want - body.len()).min(buf.len());
            match reader.read(&mut buf[..take]) {
                Ok(0) => break,
                Ok(n) => body.extend_from_slice(&buf[..n]),
                Err(_) => return,
            }
        }
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let room = query_param(query, "room")
            .unwrap_or_default()
            .trim()
            .to_uppercase();
        // Who uploaded — used to tag the broadcast and skip echoing
        // map_change back to the uploader (they already have it loaded).
        let pid = query_param(query, "pid").unwrap_or_default();
        let exists = is_code(&room) && lk(rooms()).contains_key(&room);
        if !exists {
            respond(&mut stream, "400 Bad Request", &[], b"");
            return;
        }
        if std::fs::write(map_path(&room), &body).is_err() {
            respond(&mut stream, "500 Internal Server Error", &[], b"");
            return;
        }
        let version = now_ms();
        let url = format!("/map/{}.glb?v={}", room, version);
        let mut out: Out = Vec::new();
        {
            let mut g = lk(rooms());
            if let Some(r) = g.get_mut(&room) {
                r.map_url = Some(url.clone());
                let skip = if pid.is_empty() { None } else { Some(pid.as_str()) };
                broadcast(
                    r,
                    &jobj(vec![
                        ("t", s("map_change")),
                        ("url", s(&url)),
                        ("by", s(&pid)),
                    ]),
                    skip,
                    &mut out,
                );
            }
        }
        flush_out(out);
        respond(&mut stream, "200 OK", &[], b"");
        return;
    }

    // GET /map/<room>.glb
    if path.starts_with("/map/") {
        let last = path.rsplit('/').next().unwrap_or("");
        let mut room = last.split('?').next().unwrap_or("").to_string();
        if let Some(stripped) = room.strip_suffix(".glb") {
            room = stripped.to_string();
        }
        let fs_path = if is_code(&room) { Some(map_path(&room)) } else { None };
        match fs_path.filter(|p| p.exists()).and_then(|p| std::fs::read(p).ok()) {
            Some(body) => respond(
                &mut stream,
                "200 OK",
                &[("Content-Type", "model/gltf-binary"), ("Cache-Control", "no-cache")],
                &body,
            ),
            None => respond(&mut stream, "404 Not Found", &[], b""),
        }
        return;
    }

    // Static file serving
    let rel_raw = path.split('?').next().unwrap_or("").trim_start_matches('/');
    let rel = if rel_raw.is_empty() { "index.html" } else { rel_raw };
    let mut comps: Vec<&str> = Vec::new();
    let mut outside = false;
    for c in rel.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                if comps.pop().is_none() {
                    outside = true;
                    break;
                }
            }
            x => comps.push(x),
        }
    }
    if outside {
        respond(&mut stream, "403 Forbidden", &[], b"");
        return;
    }
    let mut fs_path = cfg().root.clone();
    for c in &comps {
        fs_path.push(c);
    }
    if fs_path.is_dir() {
        fs_path.push("index.html");
    }
    if !fs_path.is_file() {
        respond(&mut stream, "404 Not Found", &[], b"");
        return;
    }
    let body = match std::fs::read(&fs_path) {
        Ok(b) => b,
        Err(_) => {
            respond(&mut stream, "500 Internal Server Error", &[], b"");
            return;
        }
    };
    respond(
        &mut stream,
        "200 OK",
        &[
            ("Content-Type", guess_type(&fs_path)),
            ("Cache-Control", "no-store, no-cache, must-revalidate"),
            ("Pragma", "no-cache"),
            ("Expires", "0"),
        ],
        &body,
    );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let root = std::env::var("FPV_ROOT")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    let map_dir = std::env::var("FPV_MAP_DIR").unwrap_or_else(|_| "/tmp".to_string());
    let _ = CFG.set(Config { root: root.clone(), map_dir });

    let listener = match TcpListener::bind((host.as_str(), port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot bind {}:{}: {}", host, port, e);
            std::process::exit(1);
        }
    };
    println!("FPV Sim server on http://{}:{}", host, port);
    println!("  - static files from {}", root.display());
    println!("  - /mp-status for MP probe");
    println!("  - /ws for multiplayer relay");
    println!("Press Ctrl+C to stop.");

    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let _ = std::thread::Builder::new().spawn(move || handle_client(stream));
            }
            Err(_) => continue,
        }
    }
}
