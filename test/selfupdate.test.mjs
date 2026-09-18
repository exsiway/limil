// Self-reload on a new build: which tabs are reloaded, and when the
// extension itself may reload. Runs against a fake chrome.* and fetch.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const MINE = '2026-09-05 10:00:00';
globalThis.__LIMIL_BUILD__ = MINE;

const { diskStamp, ownStamp, reloadStaleTabs } = await import('../src/background/selfupdate.js');

/** Fake tabs: each answers the build stamp it runs, or throws when orphaned. */
function installChrome({ tabs, disk = MINE }) {
  const reloaded = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://x/${p}` },
    tabs: {
      async query() { return tabs.map((t) => ({ id: t.id })); },
      async sendMessage(id, msg) {
        const tab = tabs.find((t) => t.id === id);
        assert.equal(msg.type, 'ui.build');
        if (tab.orphaned) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { result: tab.stamp };
      },
      async reload(id) {
        reloaded.push(id);
        // A reloaded tab comes back running this build: that is the whole
        // point of the reload, and the worker now asks it to make sure.
        const tab = tabs.find((t) => t.id === id);
        if (tab) { tab.stamp = MINE; tab.orphaned = false; }
      },
    },
    storage: { local: { async set() {}, async get() { return {}; } } },
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ stamp: disk }) });
  return reloaded;
}

test('the stamp compiled into the worker is the one every bundle carries', () => {
  assert.equal(ownStamp(), MINE);
});

test('a tab running this build is left alone; a stale or orphaned one is reloaded', async () => {
  const reloaded = installChrome({
    tabs: [
      { id: 1, stamp: MINE },
      { id: 2, stamp: '2026-09-04 09:00:00' },
      { id: 3, orphaned: true },
    ],
  });
  assert.equal(await reloadStaleTabs(), 2);
  assert.deepEqual(reloaded, [2, 3], 'the tab with the same stamp must NOT be reloaded on every worker start');
});

test('no FOMO tabs, nothing to reload', async () => {
  const reloaded = installChrome({ tabs: [] });
  assert.equal(await reloadStaleTabs(), 0);
  assert.deepEqual(reloaded, []);
});

test('the stamp on disk is read from dist/build.json; unreadable means null', async () => {
  installChrome({ tabs: [], disk: '2026-09-06 00:00:00' });
  assert.equal(await diskStamp(), '2026-09-06 00:00:00');
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await diskStamp(), null);
  globalThis.fetch = async () => ({ ok: false });
  assert.equal(await diskStamp(), null);
});

test('install keeps an existing alarm: re-creating it on every worker start would restart its period and it would never fire', async () => {
  const { install } = await import('../src/background/selfupdate.js');
  const created = [];
  let stored = { name: 'limil-selfupdate' };
  const reloaded = installChrome({ tabs: [] });
  globalThis.chrome.alarms = {
    async get() { return stored; },
    async create(name, opts) { created.push({ name, ...opts }); },
    onAlarm: { addListener() {} },
  };
  install();
  await new Promise((r) => { setTimeout(r, 20); });
  assert.deepEqual(created, [], 'an existing alarm is left alone');
  stored = null;
  install();
  await new Promise((r) => { setTimeout(r, 20); });
  assert.deepEqual(created, [{ name: 'limil-selfupdate', periodInMinutes: 2 }], 'created once when absent');
  assert.deepEqual(reloaded, [], 'nothing to reload without tabs');
});

test('a worker start with a newer build on disk reloads the extension, not the tabs', async () => {
  const { install } = await import('../src/background/selfupdate.js');
  const reloaded = installChrome({ tabs: [{ id: 1, stamp: MINE }], disk: '2026-09-06 00:00:00' });
  let runtimeReloads = 0;
  globalThis.chrome.runtime.reload = () => { runtimeReloads += 1; };
  globalThis.chrome.alarms = { async get() { return { name: 'limil-selfupdate' }; }, async create() {}, onAlarm: { addListener() {} } };
  install();
  await new Promise((r) => { setTimeout(r, 30); });
  assert.equal(runtimeReloads, 1);
  assert.deepEqual(reloaded, [], 'the tabs are for the new worker to handle');
});
