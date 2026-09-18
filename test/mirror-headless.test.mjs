// A runner browser learns from its poll that the hub's owner is a program.
//
// grantPlan reads settings, not the mirror module, so the flag has to land
// in settings.mirror; and an old hub that does not send the field must leave
// the runner exactly as it was.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

function install({ answer }) {
  const store = {
    settings: {
      autonomousEnabled: true,
      mirrorEnabled: true,
      mirror: { url: 'https://box.example', token: 'tok', secret: `0x${'11'.repeat(32)}` },
    },
    orders: [],
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
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer) });
  return store;
}

test('the hub says the owner is headless: the runner remembers it where grantPlan looks', async () => {
  const store = install({ answer: { protocol: 2, version: '0.2.0', orders: [], ownerPaired: true, ownerHeadless: true } });
  const { pull } = await import('../src/background/mirror.js');
  const round = await pull();
  assert.equal(round.ownerHeadless, true);
  assert.equal(store.settings.mirror.ownerHeadless, true);
  assert.equal(store.settings.mirror.url, 'https://box.example', 'the rest of the pairing is untouched');
});

test('a hub that does not send the field leaves the runner as it was; a laptop owner clears it', async () => {
  const store = install({ answer: { protocol: 2, version: '0.2.0', orders: [], ownerPaired: true } });
  const { pull } = await import('../src/background/mirror.js');
  await pull();
  assert.equal(store.settings.mirror.ownerHeadless, undefined, 'an old hub: nothing written');
  store.settings.mirror.ownerHeadless = true;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ protocol: 2, version: '0.2.0', orders: [], ownerPaired: true, ownerHeadless: false }) });
  await pull();
  assert.equal(store.settings.mirror.ownerHeadless, false, 'a browser owner took the hub back: this browser grants nothing again');
});
