// A browser on a server pairs itself from a Chromium managed policy.
//
// The worst step of the whole server setup was the one that could not be
// scripted: open a remote desktop, find the extension's popup in a browser
// you are driving over a video stream, and paste a token into it. Chromium
// has a channel for exactly this, settings an administrator provisions,
// read-only to the extension, and the extension reads it on start.
//
// The care is in what it REFUSES to do. A policy is written by whoever
// controls the machine, so it may hand over a hub address; it may not turn
// this extension autonomous, and it may not overrule a person who paired by
// hand or unpaired on purpose.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const PAIRING = 'http://daemon:8787#tokenfromthepolicy1234';

function install({ settings, managed, onPair = null }) {
  const store = { settings };
  const calls = [];
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
      managed: managed === null
        ? undefined
        : {
          // Like Chromium: one key gives that key alone, `null` gives the bag.
          // A fake that returned the whole bag whatever was asked would hide
          // a read of `acceptAutonomousRisk` from a `get('runnerPairing')`.
          async get(keys) {
            if (managed instanceof Error) throw managed;
            if (keys === null || keys === undefined) return managed;
            const out = {};
            for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in managed) out[k] = managed[k];
            return out;
          },
        },
      onChanged: { addListener() {} },
    },
    runtime: { getManifest: () => ({ version: '0.2.0' }) },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { onAlarm: { addListener() {} }, async create() {}, async get() { return null; } },
    permissions: { async contains() { return true; }, async request() { return true; } },
  };
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (onPair) onPair(url, init);
    return { ok: true, status: 200, text: async () => JSON.stringify({ protocol: 2, version: '0.2.0', orders: [] }) };
  };
  return { store, calls };
}

const autonomous = { autonomousEnabled: true, mirrorEnabled: false, mirror: null };

test('a policy on a fresh browser pairs it', async () => {
  const { store } = install({ settings: { ...autonomous }, managed: { runnerPairing: PAIRING } });
  const { pairFromPolicy } = await import('../src/background/mirror.js');
  const r = await pairFromPolicy();
  assert.equal(r.paired, true);
  assert.equal(store.settings.mirrorEnabled, true);
  assert.equal(store.settings.mirror.url, 'http://daemon:8787');
});

test('a policy does NOT overrule someone who paired by hand', async () => {
  // Nor someone who unpaired on purpose: `mirror` set is the mark of both.
  const { store } = install({
    settings: { ...autonomous, mirror: { url: 'http://elsewhere:8787', pairedAt: 1 } },
    managed: { runnerPairing: PAIRING },
  });
  const { pairFromPolicy } = await import('../src/background/mirror.js');
  const r = await pairFromPolicy();
  assert.equal(r.paired, false);
  assert.match(r.reason, /does not override a person/);
  assert.equal(store.settings.mirror.url, 'http://elsewhere:8787');
});

test('a pairing alone does not switch autonomous mode on', async () => {
  // The consent has to be given, not inferred from an address.
  const { store } = install({
    settings: { autonomousEnabled: false, mirrorEnabled: false, mirror: null },
    managed: { runnerPairing: PAIRING },
  });
  const { pairFromPolicy } = await import('../src/background/mirror.js');
  const r = await pairFromPolicy();
  assert.equal(r.paired, false);
  assert.match(r.reason, /acceptAutonomousRisk/);
  assert.equal(store.settings.mirrorEnabled, false);
  assert.notEqual(store.settings.autonomousEnabled, true);
});

test('a policy that gives the consent explicitly pairs a fresh browser', async () => {
  // Writing the policy IS the consent: whoever can put a file in Chromium's
  // managed-policy directory owns the box already. Demanding a click inside
  // the browser as well stops nobody and only forces the owner through a
  // remote desktop, which is the step this whole thing removes.
  const { store } = install({
    settings: { autonomousEnabled: false, mirrorEnabled: false, mirror: null },
    managed: { runnerPairing: PAIRING, acceptAutonomousRisk: true },
  });
  const { pairFromPolicy } = await import('../src/background/mirror.js');
  const r = await pairFromPolicy();
  assert.equal(r.paired, true);
  assert.equal(store.settings.autonomousEnabled, true);
  // A runner that pairs but leaves limit orders off polls and skips every
  // round; the consent in the policy covers the switch execution hangs on.
  assert.equal(store.settings.ordersEnabled, true);
  assert.equal(store.settings.autonomousAckBy, 'policy', 'where the consent came from is recorded');
  assert.equal(store.settings.mirrorEnabled, true);
});

test('even with the consent, a policy does not touch a browser paired by hand', async () => {
  const { store } = install({
    settings: { autonomousEnabled: true, mirror: { url: 'http://elsewhere:8787', pairedAt: 1 } },
    managed: { runnerPairing: PAIRING, acceptAutonomousRisk: true },
  });
  const { pairFromPolicy } = await import('../src/background/mirror.js');
  assert.equal((await pairFromPolicy()).paired, false);
  assert.equal(store.settings.mirror.url, 'http://elsewhere:8787');
});

test('a policy that arrives after the worker started is picked up from the managed-area change', async () => {
  // Chromium filters a third-party policy against the extension's schema only
  // once the extension has registered it, so the first read at start can be
  // empty and the values arrive as an onChanged event on the `managed` area.
  const managed = {};
  const { store } = install({ settings: { autonomousEnabled: false, mirrorEnabled: false, mirror: null }, managed });
  // A real hub answers over the network; a fetch that resolves in the same
  // microtask turn would make the long-poll loop starve the timers below.
  const instant = globalThis.fetch;
  globalThis.fetch = async (...args) => { await new Promise((r) => { setTimeout(r, 1); }); return instant(...args); };
  let listener = null;
  globalThis.chrome.storage.onChanged = { addListener(fn) { listener = fn; } };
  const { install: installMirror, pairFromPolicy } = await import('../src/background/mirror.js');
  assert.equal((await pairFromPolicy()).paired, false, 'empty at start');
  installMirror();
  assert.equal(typeof listener, 'function');
  Object.assign(managed, { runnerPairing: PAIRING, acceptAutonomousRisk: true });
  listener({ runnerPairing: { newValue: PAIRING } }, 'managed');
  await new Promise((r) => { setTimeout(r, 20); });
  const paired = store.settings.mirrorEnabled === true;
  const ack = store.settings.autonomousAckBy;
  // The pairing started the long-poll loop; switch autonomous mode off so the
  // loop ends and the test process can exit.
  store.settings.autonomousEnabled = false;
  await new Promise((r) => { setTimeout(r, 20); });
  assert.equal(paired, true, 'paired without waiting for the next worker start');
  assert.equal(ack, 'policy');
});

test('no policy at all is the ordinary case and not an error', async () => {
  const { pairFromPolicy } = await import('../src/background/mirror.js');
  install({ settings: { ...autonomous }, managed: null });
  assert.equal((await pairFromPolicy()).paired, false);
  install({ settings: { ...autonomous }, managed: {} });
  assert.equal((await pairFromPolicy()).paired, false);
  install({ settings: { ...autonomous }, managed: { runnerPairing: '   ' } });
  assert.equal((await pairFromPolicy()).paired, false);
  install({ settings: { ...autonomous }, managed: new Error('policy store unavailable') });
  assert.equal((await pairFromPolicy()).paired, false, 'a throwing policy store is not a crash');
});
