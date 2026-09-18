// A runner browser goes quiet when nobody is asking it to execute.
//
// With autonomous mode switched off on the owner's side the hub has no owner
// and no orders, and the browser on the server has nothing to do, yet it
// went on holding a twenty-second long poll open, round after round, for an
// empty list. The hub says whether an owner is paired at all, and the runner
// drops to a heartbeat until one is, picking the loop back up by itself.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

function install({ answer }) {
  const store = {
    settings: {
      autonomousEnabled: true,
      mirrorEnabled: true,
      mirror: { url: 'https://box.example', token: 'tok', secret: `0x${'11'.repeat(32)}` },
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
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer) });
  return store;
}

test('no owner paired: the round says so, and it is not an error', async () => {
  install({ answer: { ownerPaired: false, orders: [], version: 3, protocol: 2 } });
  const { pull } = await import('../src/background/mirror.js');
  const round = await pull({ wait: 0 });
  assert.equal(round.ok, true, 'a hub with no owner is answering perfectly well');
  assert.equal(round.ownerPaired, false);
  assert.equal(round.watching, 0);
});

test('an owner is paired: the loop stays fast', async () => {
  install({ answer: { ownerPaired: true, orders: [], version: 4, protocol: 2 } });
  const { pull } = await import('../src/background/mirror.js');
  assert.equal((await pull({ wait: 0 })).ownerPaired, true);
});

test('an older hub says nothing, and is treated as paired', async () => {
  // Falling silent against a server that simply predates the field would be
  // a runner that stops executing for no reason the owner can see.
  install({ answer: { orders: [], version: 5, protocol: 2 } });
  const { pull } = await import('../src/background/mirror.js');
  assert.equal((await pull({ wait: 0 })).ownerPaired, true);
});

test('the heartbeat is minutes, not seconds', async () => {
  const { IDLE_POLL_MS } = await import('../src/background/mirror.js');
  assert.ok(IDLE_POLL_MS >= 60_000, 'a "quiet" poll faster than a minute is not quiet');
});
