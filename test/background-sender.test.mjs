// WHO is asking the service worker.
//
// One `chrome.runtime.onMessage` listener answers every context of the
// extension. The popup is one of them; so is the content script that shares a
// tab with fomo.family's own JavaScript. Answered alike, a synthetic
// content-script sender could read the server pairing token through
// `settings.get` and mint a grant intent through `intent.issue`, the intent
// that authorises replacing
// the wallet's code. No ordinary web page reaches this API (there is no
// `externally_connectable`, and the MAIN world speaks only through the ISO
// allow-list), so this is what a compromised content script could do, not a
// path from a hostile site. It is still the difference between one bug and
// one bug plus the server keys.
//
// These tests drive the REAL listener, the way the probe did.

import { strict as assert } from 'node:assert';
import { test, before } from 'node:test';

const bag = {
  settings: {
    ordersEnabled: false,
    uiLang: 'en',
    panelCollapsed: false,
    slippageBps: 100,
    daemon: { sessionKey: '0xdeadbeef', pairToken: 'SYNTHETIC-PAIR-TOKEN' },
    mirror: { url: 'https://example.invalid' },
  },
};

let receive;
before(async () => {
  const noop = () => {};
  const local = {
    async get(keys) {
      if (keys == null) return structuredClone(bag);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(bag[k])]));
    },
    async set(v) { Object.assign(bag, structuredClone(v)); },
    async remove(k) { delete bag[k]; },
    async setAccessLevel() {},
  };
  globalThis.chrome = {
    storage: { local, session: local, onChanged: { addListener: noop } },
    runtime: {
      id: 'synthetic-extension-id',
      onMessage: { addListener(fn) { receive = fn; } },
      getURL: (p) => `chrome-extension://synthetic-extension-id/${p}`,
      reload: noop,
      getManifest: () => ({ version: '0.2.0' }),
    },
    alarms: { onAlarm: { addListener: noop }, async create() {}, async get() { return null; } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    permissions: { onAdded: { addListener: noop }, async contains() { return false; } },
  };
  await import('../src/background/index.js');
});

const TAB = { id: 7, url: 'https://fomo.family/' };
const fromTab = { tab: TAB, url: 'https://fomo.family/', id: 'synthetic-extension-id' };
const fromPopup = { url: 'chrome-extension://synthetic-extension-id/popup.html', id: 'synthetic-extension-id' };

const ask = (type, payload, sender) => new Promise((resolve) => { receive({ type, payload }, sender, resolve); });

test('a page context cannot read the server keys or anything else it has no use for', async () => {
  const res = await ask('settings.get', {}, fromTab);
  assert.equal(res.error, undefined);
  assert.equal(res.result.daemon, undefined, 'the server session key and pairing token stay in the worker');
  assert.equal(res.result.mirror, undefined);
  // What the panel actually needs still arrives.
  assert.equal(res.result.uiLang, 'en');
  assert.equal(res.result.ordersEnabled, false);
  assert.equal(res.result.slippageBps, 100);
  // The popup, which the page cannot reach, sees everything.
  const popup = await ask('settings.get', {}, fromPopup);
  assert.equal(popup.result.daemon.pairToken, 'SYNTHETIC-PAIR-TOKEN');
});

test('a page context cannot mint an intent, the intents are what authorise a delegation', async () => {
  const res = await ask('intent.issue', { kind: 'grant', params: { arbitrary: true } }, fromTab);
  assert.equal(res.result, undefined);
  assert.match(res.error, /not available to a page context/);
  // The popup may, and that is the only surface the person controls.
  const popup = await ask('intent.issue', { kind: 'grant', params: { sender: '0x1', chainId: 4663 } }, fromPopup);
  assert.equal(typeof popup.result, 'string');
});

test('a page context cannot switch on limit orders, that switch is the consent to delegation', async () => {
  const res = await ask('settings.set', { settings: { ordersEnabled: true, daemon: { pairToken: 'STOLEN' } } }, fromTab);
  assert.equal(res.error, undefined, 'the write is accepted, narrowed to the panel\'s own state');
  const after = await ask('settings.get', {}, fromPopup);
  assert.equal(after.result.ordersEnabled, false, 'the consent switch did not move');
  assert.equal(after.result.daemon.pairToken, 'SYNTHETIC-PAIR-TOKEN', 'the pairing was not replaced');
  // Its own interface state does get through.
  await ask('settings.set', { settings: { panelCollapsed: true } }, fromTab);
  const state = await ask('settings.get', {}, fromPopup);
  assert.equal(state.result.panelCollapsed, true);
});

test('pairing a server and cancelling everything are the popup\'s alone', async () => {
  for (const type of ['daemon.pair', 'daemon.unpair', 'mirror.pair', 'orders.cancelAll', 'runner.status']) {
    const res = await ask(type, {}, fromTab);
    assert.match(res.error ?? '', /not available to a page context/, `${type} must be refused to a tab`);
  }
});

test('a message from a foreign extension or an unexpected tab is answered by nobody', async () => {
  const foreign = await ask('settings.get', {}, { id: 'another-extension', tab: TAB, url: 'https://fomo.family/' });
  assert.match(foreign.error, /not a context of this extension/);
  const elsewhere = await ask('settings.get', {}, { id: 'synthetic-extension-id', tab: { id: 9, url: 'https://evil.example/' }, url: 'https://evil.example/' });
  assert.match(elsewhere.error, /not a context of this extension/);
});

test('what the panel does need still works from a tab', async () => {
  const orders = await ask('orders.list', {}, fromTab);
  assert.ok(Array.isArray(orders.result));
  const info = await ask('runner.info', {}, fromTab);
  assert.equal(info.error, undefined);
});

test('a command that no longer exists is refused by name', async () => {
  const res = await ask('translate.run', { text: 'x' }, fromPopup);
  assert.match(res.error, /unknown command: translate\.run/);
});
