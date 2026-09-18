// Pairing reads the hub back before it returns.
//
// The hub's answer says whether a runner browser is paired there. Two
// decisions hang on it: the grant planner adds that browser's key, and the
// laptop's own runner stands down only while there is one (runnerExecutes).
//
// Pairing that pushed the orders up and stopped would leave the runner field
// null until the next pull.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { runnerExecutes } from '../src/shared/autonomy.js';

function fakeChrome(store) {
  return {
    storage: {
      local: {
        async get(keys) {
          const list = keys === null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(k) { delete store[k]; },
      },
    },
    runtime: { getManifest: () => ({ version: '0.2.0' }) },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { onAlarm: { addListener() {} }, async create() {}, async get() { return null; } },
    permissions: { async contains() { return true; }, async request() { return true; } },
  };
}

const hubAnswer = (over) => ({
  ok: true, status: 200, text: async () => JSON.stringify({ protocol: 2, version: '0.2.0', orders: [], ...over }),
});

test('after pairing, the hub has been read and the runner is known', async () => {
  const store = { settings: { autonomousEnabled: true } };
  const seen = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = keys === null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(k) { delete store[k]; },
      },
    },
    runtime: { getManifest: () => ({ version: '0.2.0' }) },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { onAlarm: { addListener() {} }, async create() {}, async get() { return null; } },
    permissions: { async contains() { return true; }, async request() { return true; } },
  };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    const body = path === '/v1/state'
      ? { protocol: 2, version: '0.2.0', orders: [], sessionKey: '0xkey', runner: { key: '0xrunner' } }
      : { protocol: 2, version: '0.2.0', sessionKey: '0xkey', orders: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const { pair } = await import('../src/background/daemon.js');
  await pair({ pairing: 'http://127.0.0.1:8787#tokenfromthepairing12345' });
  assert.ok(seen.includes('/v1/state'), 'the hub was read back, not only written to');
  assert.equal(store.settings.daemon.runner?.key, '0xrunner',
    'so the planner knows a runner browser executes and picks the right guard');
});

test('a runner that appears later is noticed even though the key never changes', async () => {
  // The live case: the runner browser paired with the hub BEFORE the laptop
  // did, so the hub already reported the runner's key as the session key and
  // it never changed again. The old code saved the runner only alongside a
  // key change, so the laptop went on believing it executed alone.
  const store = {
    settings: {
      autonomousEnabled: true,
      daemonEnabled: true,
      daemon: { url: 'http://127.0.0.1:8787', sessionKey: '0xkey', runner: null, token: 't', secret: `0x${'11'.repeat(32)}` },
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = keys === null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(k) { delete store[k]; },
      },
    },
    runtime: { getManifest: () => ({ version: '0.2.0' }) },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { onAlarm: { addListener() {} }, async create() {}, async get() { return null; } },
    permissions: { async contains() { return true; } },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ protocol: 2, version: '0.2.0', orders: [], sessionKey: '0xkey', runner: { key: '0xrunner' } }),
  });
  const { pull } = await import('../src/background/daemon.js');
  await pull();
  assert.equal(store.settings.daemon.runner?.key, '0xrunner');
});

test('a hub with no runner browser reports no key, and the laptop keeps executing', async () => {
  // A hub that minted a key of its own and reported it would make the laptop
  // grant a key nobody signs with and stand down for a server that cannot
  // execute. The key is the runner browser's or nothing.
  const store = { settings: { autonomousEnabled: true } };
  globalThis.chrome = fakeChrome(store);
  globalThis.fetch = async () => hubAnswer({ sessionKey: null, runner: null });
  const { pair, pull } = await import('../src/background/daemon.js');
  await pair({ pairing: 'http://127.0.0.1:8787#tokenfromthepairing12345' });
  assert.equal(store.settings.daemon.url, 'http://127.0.0.1:8787');
  assert.equal(store.settings.daemon.sessionKey, null);
  assert.equal(runnerExecutes(store.settings), false, 'nothing on the server executes: this browser does');
  assert.equal(await (await import('../src/background/daemon.js')).daemonActive(store.settings), true,
    'yet the hub IS paired and receives the orders, so a runner that pairs later finds them');

  // The runner pairs: its key arrives, the laptop stands down.
  globalThis.fetch = async () => hubAnswer({ sessionKey: '0xrunner', runner: { key: '0xrunner' } });
  await pull();
  assert.equal(store.settings.daemon.sessionKey, '0xrunner');
  assert.equal(runnerExecutes(store.settings), true);

  // The runner unpairs: the key goes with it, the laptop resumes.
  globalThis.fetch = async () => hubAnswer({ sessionKey: null, runner: null });
  await pull();
  assert.equal(store.settings.daemon.sessionKey, null);
  assert.equal(runnerExecutes(store.settings), false);
});

test('a cancel on the server closes the laptop\'s copy instead of leaving it live and unwatched', async () => {
  // The runner browser cancelled its copies (its orders switch went off); the
  // hub keeps such an order closed for good. Ignoring that verdict here left a
  // stop-loss shown as live that no browser was watching.
  const store = {
    settings: {
      autonomousEnabled: true,
      daemonEnabled: true,
      daemon: { url: 'http://127.0.0.1:8787', sessionKey: '0xrunner', runner: { key: '0xrunner' }, token: 't', secret: `0x${'11'.repeat(32)}` },
    },
    orders: [
      { id: 'a', status: 'watching' },
      { id: 'b', status: 'watching' },
      { id: 'c', status: 'cancelled', closedAt: 'earlier' },
    ],
  };
  globalThis.chrome = fakeChrome(store);
  globalThis.fetch = async () => hubAnswer({
    sessionKey: '0xrunner',
    runner: { key: '0xrunner' },
    orders: [
      { id: 'a', status: 'cancelled', closedAt: 'now', cancelReason: 'runner switched off' },
      { id: 'b', status: 'filled', closedAt: 'now', closedTx: '0xtx' },
      { id: 'c', status: 'cancelled', closedAt: 'now' },
    ],
  });
  const { pull } = await import('../src/background/daemon.js');
  await pull();
  const byId = Object.fromEntries(store.orders.map((o) => [o.id, o]));
  assert.equal(byId.a.status, 'cancelled');
  assert.equal(byId.a.closedBy, 'daemon');
  assert.equal(byId.a.cancelReason, 'runner switched off');
  assert.equal(byId.b.status, 'filled');
  assert.equal(byId.b.closedTx, '0xtx');
  assert.equal(byId.c.closedAt, 'earlier', 'an order already closed here is left as it was');
});

test('after a key rotation the hub is told by the old key, once, before anything else is sent', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const oldSecret = `0x${'11'.repeat(32)}`;
  const newSecret = `0x${'22'.repeat(32)}`;
  const next = privateKeyToAccount(newSecret).address;
  const store = {
    settings: {
      autonomousEnabled: true, daemonEnabled: true,
      daemon: { url: 'http://127.0.0.1:8787', sessionKey: null, runner: null, token: 't', secret: oldSecret },
    },
    'runner.secret': newSecret,
    'runner.secret.prev': oldSecret,
    runner: { sessionKeyAddress: next, armed: true, armedUntil: Date.now() + 3600_000, log: [], attempts: {}, samples: {} },
  };
  globalThis.chrome = fakeChrome(store);
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const signer = String(init?.headers?.authorization ?? '').split(' ')[1]?.split(':')[0]?.toLowerCase();
    seen.push({ path, signer, body: init?.body ? JSON.parse(init.body) : null });
    return hubAnswer({ sessionKey: null, runner: null, ok: true });
  };
  const { pull } = await import('../src/background/daemon.js');
  await pull();
  const rotate = seen.find((s) => s.path === '/v1/owner/rotate');
  assert.ok(rotate, 'the hub was told');
  assert.equal(rotate.signer, privateKeyToAccount(oldSecret).address.toLowerCase(), 'signed by the OLD key, the one the hub knows');
  assert.equal(rotate.body.next.toLowerCase(), next.toLowerCase());
  assert.equal(seen.indexOf(rotate), 0, 'before the read');
  assert.equal(seen[1].signer, next.toLowerCase(), 'and the read is signed by the new key');
  assert.equal(store['runner.secret.prev'], undefined, 'the old secret is gone once the hub knows');
  await pull();
  assert.equal(seen.filter((s) => s.path === '/v1/owner/rotate').length, 1, 'told once');
});
