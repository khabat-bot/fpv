/* =========================================================================
   replay-store.js — local Replay library backed by IndexedDB.

   Metadata and frame data live in separate stores so browsing the list
   never has to load every recording's frames into memory.

   API:
     list()                 -> Promise<[{ id, name, createdAt, duration, ... }]>
     get(id)                -> Promise<{ id, name, data } | null>
     put({ id?, name, data }) -> Promise<meta>
     rename(id, name)       -> Promise<meta | null>
     remove(id)             -> Promise<boolean>
   ========================================================================= */
'use strict';
window.ReplayStore = (function () {
    var DB_NAME = 'fpv-sim-replays';
    var DB_VERSION = 1;
    var META_STORE = 'replays';
    var DATA_STORE = 'replayData';

    var _dbPromise = null;

    function openDb() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise(function (resolve, reject) {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB is not available'));
                return;
            }
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(META_STORE)) {
                    db.createObjectStore(META_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(DATA_STORE)) {
                    db.createObjectStore(DATA_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () {
                reject(req.error || new Error('Could not open replay storage'));
            };
        });
        return _dbPromise;
    }

    function generateId() {
        return 'rp_' + Date.now().toString(36) + '_' +
            Math.random().toString(36).slice(2, 8);
    }

    function list() {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(META_STORE, 'readonly');
                var req = tx.objectStore(META_STORE).getAll();
                req.onsuccess = function () {
                    var rows = (req.result || []).map(function (m) {
                        return {
                            id: m.id,
                            name: m.name,
                            createdAt: m.createdAt,
                            updatedAt: m.updatedAt,
                            duration: m.duration,
                            frameCount: m.frameCount,
                            hz: m.hz
                        };
                    });
                    rows.sort(function (a, b) {
                        return (b.createdAt || 0) - (a.createdAt || 0);
                    });
                    resolve(rows);
                };
                req.onerror = function () {
                    reject(req.error || new Error('Could not list replays'));
                };
            });
        });
    }

    function get(id) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction([META_STORE, DATA_STORE], 'readonly');
                var metaReq = tx.objectStore(META_STORE).get(id);
                var dataReq = tx.objectStore(DATA_STORE).get(id);
                tx.oncomplete = function () {
                    var meta = metaReq.result;
                    if (!meta) { resolve(null); return; }
                    resolve({
                        id: meta.id,
                        name: meta.name,
                        createdAt: meta.createdAt,
                        updatedAt: meta.updatedAt,
                        duration: meta.duration,
                        frameCount: meta.frameCount,
                        hz: meta.hz,
                        data: dataReq.result ? dataReq.result.data : null
                    });
                };
                tx.onerror = function () {
                    reject(tx.error || new Error('Could not read replay'));
                };
                tx.onabort = function () {
                    reject(tx.error || new Error('Replay read aborted'));
                };
            });
        });
    }

    function put(rec) {
        var now = Date.now();
        var id = rec.id || generateId();
        var data = rec.data || null;
        var meta = {
            id: id,
            name: String(rec.name || 'Untitled').slice(0, 80),
            createdAt: rec.createdAt || now,
            updatedAt: now,
            duration: Number(rec.duration) || 0,
            frameCount: (data && data.frames) ? data.frames.length : (rec.frameCount || 0),
            hz: (data && data.hz) ? data.hz : (rec.hz || 30)
        };

        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
                tx.objectStore(META_STORE).put(meta);
                tx.objectStore(DATA_STORE).put({ id: id, data: data });
                tx.oncomplete = function () { resolve(meta); };
                tx.onerror = function () {
                    reject(tx.error || new Error('Could not save replay'));
                };
                tx.onabort = function () {
                    reject(tx.error || new Error('Replay save aborted'));
                };
            });
        });
    }

    function rename(id, name) {
        var clean = String(name || '').trim().slice(0, 80);
        if (!clean) return Promise.resolve(null);

        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(META_STORE, 'readwrite');
                var store = tx.objectStore(META_STORE);
                var req = store.get(id);
                var updated = null;
                req.onsuccess = function () {
                    var meta = req.result;
                    if (!meta) return;
                    meta.name = clean;
                    meta.updatedAt = Date.now();
                    store.put(meta);
                    updated = meta;
                };
                tx.oncomplete = function () { resolve(updated); };
                tx.onerror = function () {
                    reject(tx.error || new Error('Could not rename replay'));
                };
                tx.onabort = function () {
                    reject(tx.error || new Error('Replay rename aborted'));
                };
            });
        });
    }

    function remove(id) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
                tx.objectStore(META_STORE).delete(id);
                tx.objectStore(DATA_STORE).delete(id);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () {
                    reject(tx.error || new Error('Could not delete replay'));
                };
                tx.onabort = function () {
                    reject(tx.error || new Error('Replay delete aborted'));
                };
            });
        });
    }

    return {
        list: list,
        get: get,
        put: put,
        rename: rename,
        remove: remove
    };
})();
