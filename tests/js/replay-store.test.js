/* js/replay-store.js — IndexedDB replay library. A tiny in-memory
   IndexedDB stands in for the browser so metadata/data separation, sorting
   and deletes can be verified hermetically. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./helpers/harness.js');

function makeFakeIndexedDB() {
  const databases = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  function makeStore() {
    return { keyPath: 'id', data: new Map() };
  }

  function makeDb() {
    const stores = new Map();
    return {
      objectStoreNames: { contains: (n) => stores.has(n) },
      createObjectStore: (name) => {
        const s = makeStore();
        stores.set(name, s);
        return s;
      },
      transaction: (names) => {
        const list = Array.isArray(names) ? names : [names];
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        const ops = [];
        const request = (fn) => {
          const req = { result: undefined, error: null, onsuccess: null, onerror: null };
          ops.push(() => {
            req.result = fn();
            if (req.onsuccess) req.onsuccess();
          });
          return req;
        };
        tx.objectStore = (name) => {
          const store = stores.get(name);
          if (!store) throw new Error('unknown store ' + name);
          return {
            get: (key) => request(() => clone(store.data.get(key))),
            getAll: () => request(() => Array.from(store.data.values()).map(clone)),
            put: (value) => request(() => {
              store.data.set(value[store.keyPath], clone(value));
              return value[store.keyPath];
            }),
            delete: (key) => request(() => { store.data.delete(key); return undefined; })
          };
        };
        tx._stores = list;
        queueMicrotask(() => {
          for (const op of ops) op();
          if (tx.oncomplete) tx.oncomplete();
        });
        return tx;
      },
      close: () => {}
    };
  }

  return {
    open(name) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = makeDb();
          databases.set(name, db);
          req.result = db;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
}

function setup(withDb) {
  const indexedDB = makeFakeIndexedDB();
  const ctx = loadSim(['js/replay-store.js'], { indexedDB: withDb === false ? undefined : indexedDB });
  return { ctx, Store: ctx.ReplayStore, indexedDB };
}

const sample = (name, overrides) => Object.assign({
  name: name,
  duration: 12.5,
  data: { hz: 30, frames: [{ t: 0 }, { t: 0.03 }, { t: 0.06 }] }
}, overrides || {});

test('an empty library lists nothing', async () => {
  const { Store } = setup();
  assert.deepEqual(await Store.list(), []);
});

test('put() splits metadata from frame data and returns the metadata', async () => {
  const { Store } = setup();
  const meta = await Store.put(sample('First flight'));
  assert.match(meta.id, /^rp_[a-z0-9]+_[a-z0-9]+$/);
  assert.equal(meta.name, 'First flight');
  assert.equal(meta.frameCount, 3);
  assert.equal(meta.hz, 30);
  assert.ok(meta.createdAt > 0);
  assert.ok(meta.updatedAt > 0);

  const rows = await Store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, meta.id);
  assert.equal(rows[0].frameCount, 3);
  assert.equal(rows[0].data, undefined, 'list() must not load frame data');

  const full = await Store.get(meta.id);
  assert.equal(full.name, 'First flight');
  assert.deepEqual(full.data.frames.map((f) => f.t), [0, 0.03, 0.06]);
});

test('list() is newest-first by createdAt', async () => {
  const { Store } = setup();
  const older = await Store.put(sample('Older', { createdAt: 1000 }));
  const newer = await Store.put(sample('Newer', { createdAt: 2000 }));
  const middle = await Store.put(sample('Middle', { createdAt: 1500 }));
  assert.deepEqual((await Store.list()).map((r) => r.id), [newer.id, middle.id, older.id]);
});

test('put() with an existing id updates in place', async () => {
  const { Store } = setup();
  const first = await Store.put(sample('Draft'));
  const second = await Store.put(sample('Final', { id: first.id }));
  assert.equal(second.id, first.id);
  const rows = await Store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Final');
  assert.equal((await Store.get(first.id)).name, 'Final');
});

test('get() returns null for a missing id', async () => {
  const { Store } = setup();
  assert.equal(await Store.get('nope'), null);
});

test('rename() updates the name and rejects blank names', async () => {
  const { Store } = setup();
  const meta = await Store.put(sample('Old name'));
  const renamed = await Store.rename(meta.id, '  New name  ');
  assert.equal(renamed.name, 'New name');
  assert.ok(renamed.updatedAt >= meta.updatedAt);
  assert.equal((await Store.get(meta.id)).name, 'New name');

  assert.equal(await Store.rename(meta.id, '   '), null);
  assert.equal((await Store.get(meta.id)).name, 'New name');
  assert.equal(await Store.rename('missing', 'x'), null);
});

test('remove() deletes both metadata and frames', async () => {
  const { Store } = setup();
  const meta = await Store.put(sample('Delete me'));
  assert.equal(await Store.remove(meta.id), true);
  assert.equal(await Store.get(meta.id), null);
  assert.deepEqual(await Store.list(), []);
  assert.equal(await Store.remove(meta.id), true, 'deleting a missing replay is not an error');
});

test('names are capped at 80 characters and unknown metadata is normalised', async () => {
  const { Store } = setup();
  const long = 'x'.repeat(200);
  const meta = await Store.put({ name: long, frameCount: 7, hz: 12 });
  assert.equal(meta.name.length, 80);
  assert.equal(meta.frameCount, 7);
  assert.equal(meta.hz, 12);
  assert.equal(meta.duration, 0);

  const unnamed = await Store.put({});
  assert.equal(unnamed.name, 'Untitled');
});

test('without IndexedDB the API rejects with a clear error', async () => {
  const { Store } = setup(false);
  await assert.rejects(Store.list(), /IndexedDB is not available/);
  await assert.rejects(Store.put(sample('x')), /IndexedDB is not available/);
});
