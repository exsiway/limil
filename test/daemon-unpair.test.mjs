// Leaving the server is two halves, and only one of them is local.
//
// The remote half stands the SERVER down: unpairing makes the hub drop its
// order list, and the runner browser cancels its mirrored copies on the next
// poll. The local half lets THIS browser execute again. So a remote half that
// quietly failed would leave two executors on one position, the single thing
// the whole arrangement exists to prevent, while the interface said "local
// mode, done".

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

function install({ settings, fetchImpl }) {
  const store = { settings };
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
    alarms: { onAlarm: { addListener() {} }, async create() {}, async get() { return null; } },
    permissions: { async contains() { return true; } },
  };
  globalThis.fetch = fetchImpl;
  return store;
}

const paired = {
  autonomousEnabled: true,
  daemonEnabled: true,
  daemon: { url: 'https://box.example', sessionKey: '0x1', token: 'tok', secret: `0x${'11'.repeat(32)}` },
};

test('the hub answers: the server was told to stop, and the settings are cleared', async () => {
  const store = install({ settings: { ...paired }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }) });
  const { unpair } = await import('../src/background/daemon.js');
  const out = await unpair();
  assert.equal(out.paired, false);
  assert.equal(out.standDown, true, 'the hub dropped the orders, so the runner will cancel its copies');
  assert.equal(store.settings.daemonEnabled, false);
  assert.equal(store.settings.daemon, null);
});

test('the hub is unreachable: it is REPORTED, and the switch still goes off', async () => {
  const store = install({
    settings: { ...paired },
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  const { unpair } = await import('../src/background/daemon.js');
  const out = await unpair();
  assert.equal(out.standDown, false, 'silence here means two executors on one position');
  assert.match(out.error, /ECONNREFUSED/);
  // A server one cannot reach must still be leavable, so the local half runs.
  assert.equal(store.settings.daemonEnabled, false);
  assert.equal(store.settings.daemon, null);
});

test('nothing was paired: leaving is trivially complete', async () => {
  install({ settings: { autonomousEnabled: true, daemonEnabled: false, daemon: null }, fetchImpl: async () => { throw new Error('no'); } });
  const { unpair } = await import('../src/background/daemon.js');
  const out = await unpair();
  assert.equal(out.standDown, true);
  assert.equal(out.error, null);
});
