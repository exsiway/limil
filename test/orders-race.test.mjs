// Two writers of the order list at once.
//
// The list is one array in extension storage and every change is a read, a
// change and a write. The service worker answers messages concurrently, so
// without a queue two writers read the same array and the later write erases
// the earlier one: an added order vanishes and is never executed, or a
// cancelled one comes back and is. Both failures are silent, which is what
// makes them worth a test.
//
// The panel is not the only writer. The runner closes a filled order, the
// daemon applies the hub's verdict, the mirror merges the hub's list, and
// for a while each of those read and wrote this array on its own, so the
// queue held only between panel messages and not against the three writers
// that matter most. They share one queue now, and the races below cross it.

import { strict as assert } from 'node:assert';
import { test, before } from 'node:test';

let receive;
before(async () => {
  const noop = () => {};
  const bag = { settings: {} };
  // A storage whose reads and writes take a turn of the event loop, as the
  // real one does. Without that delay the race cannot happen at all.
  const local = {
    async get(keys) {
      await new Promise((r) => { setTimeout(r, 2); });
      if (keys == null) return structuredClone(bag);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(bag[k])]));
    },
    async set(v) { await new Promise((r) => { setTimeout(r, 2); }); Object.assign(bag, structuredClone(v)); },
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
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '{}' });
  await import('../src/background/index.js');
});

const popup = { url: 'chrome-extension://synthetic-extension-id/popup.html', id: 'synthetic-extension-id' };
const ask = (type, payload) => new Promise((resolve) => { receive({ type, payload }, popup, resolve); });
const order = (id) => ({ id, status: 'watching', sender: '0x1', inTokenId: `0xabc:4663`, amount: '1' });

test('two orders added at the same moment both survive', async () => {
  await Promise.all([ask('orders.add', { order: order('a') }), ask('orders.add', { order: order('b') })]);
  const list = (await ask('orders.list', {})).result;
  assert.deepEqual(list.map((o) => o.id).sort(), ['a', 'b'], 'neither write erased the other');
});

test('a cancel racing an add does not resurrect the cancelled order', async () => {
  await ask('orders.add', { order: order('c') });
  await Promise.all([ask('orders.cancel', { id: 'c', reason: 'test' }), ask('orders.add', { order: order('d') })]);
  const live = (await ask('orders.list', {})).result.map((o) => o.id);
  assert.equal(live.includes('c'), false, 'the cancelled order stayed cancelled');
  assert.equal(live.includes('d'), true, 'and the new one was not lost');
});

test('cancelAll racing an add leaves no live order behind it', async () => {
  await Promise.all([ask('orders.add', { order: order('e') }), ask('orders.cancelAll', { reason: 'off' })]);
  // Whichever order the queue chose, the outcome is one of two consistent
  // states, never a half-written list.
  const live = (await ask('orders.list', {})).result.map((o) => o.id);
  assert.ok(live.length === 0 || (live.length === 1 && live[0] === 'e'), `unexpected state: ${live.join(',')}`);
});

test('a runner closing an order while the panel adds one: both survive', async () => {
  // If markDone in `runner.js` read and wrote the array itself, racing an
  // add, whichever finished second would erase the other: either the order
  // stays shown as watching after it has been filled, and is sold again on
  // the next round, or the new order is gone before its first tick.
  const { mutateOrders } = await import('../src/background/orders-store.js');
  await ask('orders.add', { order: order('f') });
  const markDone = (id) => mutateOrders((orders) => orders.map(
    (o) => (o.id === id ? { ...o, status: 'filled', closedAt: 'now' } : o),
  ));
  await Promise.all([markDone('f'), ask('orders.add', { order: order('g') })]);
  const all = await (await import('../src/background/orders-store.js')).loadOrders();
  const byId = Object.fromEntries(all.map((o) => [o.id, o]));
  assert.equal(byId.f.status, 'filled', 'the verdict was not erased by the add');
  assert.ok(byId.g, 'and the added order was not erased by the verdict');
});

test('a hub verdict racing a cancel does not revive the cancelled order', async () => {
  // daemon.pull applies remote verdicts; the array it applies them to must
  // not be read before the cancel and written after it.
  const { loadOrders, mutateOrders } = await import('../src/background/orders-store.js');
  await ask('orders.add', { order: order('h') });
  const verdict = () => mutateOrders((orders) => {
    let changed = false;
    const next = orders.map((o) => {
      if (o.id !== 'h' || o.status !== 'watching') return o;
      changed = true;
      return { ...o, status: 'filled', closedBy: 'daemon' };
    });
    return changed ? { orders: next } : {};
  });
  await Promise.all([ask('orders.cancel', { id: 'h', reason: 'test' }), verdict()]);
  const h = (await loadOrders()).find((o) => o.id === 'h');
  assert.notEqual(h.status, 'watching', `the order came back to life as ${h.status}`);
});

test('a round that changes nothing writes nothing', async () => {
  // The daemon polls on a timer. If every quiet round rewrote the array, each
  // one would be a chance to overwrite a change made in the meantime.
  const { loadOrders, mutateOrders } = await import('../src/background/orders-store.js');
  const before = await loadOrders();
  await mutateOrders(() => ({}));
  assert.deepEqual(await loadOrders(), before);
});

// ------------------------------------------------------- what gets added

test('orders.add refuses the shapeless and keeps one copy per id', async () => {
  // The panel runs in the page, so a page script can reach this handler; what
  // lands in the list has to be an order and has to be new.
  const { loadOrders } = await import('../src/background/orders-store.js');
  const before = (await loadOrders()).length;
  const bad = [
    null,
    'string',
    { status: 'watching', sender: '0x1', inTokenId: '0xabc:4663', amount: '1' },
    { id: 'x1', status: 'filled', sender: '0x1', inTokenId: '0xabc:4663', amount: '1' },
    { id: 'x2', status: 'watching', inTokenId: '0xabc:4663', amount: '1' },
    { id: 'x3', status: 'watching', sender: '0x1', amount: '1' },
    { id: 'x4', status: 'watching', sender: '0x1', inTokenId: '0xabc:4663', amount: '0' },
    { id: 'x5', status: 'watching', sender: '0x1', inTokenId: '0xabc:4663', amount: '1.5' },
  ];
  for (const o of bad) {
    const res = await ask('orders.add', { order: o });
    assert.ok(res?.error, `refused: ${JSON.stringify(o)}`);
  }
  assert.equal((await loadOrders()).length, before, 'nothing shapeless was added');

  const twice = order('dup');
  await ask('orders.add', { order: twice });
  const again = await ask('orders.add', { order: { ...twice, amount: '999' } });
  const copies = (await loadOrders()).filter((o) => o.id === 'dup');
  assert.equal(copies.length, 1, 'one copy');
  assert.equal(copies[0].amount, '1', 'the first one, unchanged');
  assert.equal(again?.result?.amount ?? again?.amount, '1', 'the existing order is what comes back');
});

test('orders.add refuses a buy on an EVM chain the buy route check does not cover', async () => {
  // Such a buy could never be signed: the runner checks the route through
  // Kyber and the v4 quoter before a buy, and neither is described for BNB
  // Chain. Accepted, it would be skipped every round for ever.
  const { loadOrders } = await import('../src/background/orders-store.js');
  const bnb = { ...order('bnb'), side: 'buy', outTokenId: '0xdef:56' };
  const res = await ask('orders.add', { order: bnb });
  assert.ok(res?.error, 'refused');
  assert.equal((await loadOrders()).some((o) => o.id === 'bnb'), false);
  const base = { ...order('base'), side: 'buy', outTokenId: '0xdef:8453' };
  const ok = await ask('orders.add', { order: base });
  assert.ok(!ok?.error, `a Base buy is fine: ${ok?.error}`);
  const sol = { ...order('sol'), side: 'buy', outTokenId: 'So11111111111111111111111111111111111111112:1399811149' };
  const okSol = await ask('orders.add', { order: sol });
  assert.ok(!okSol?.error, `a Solana buy is fine: ${okSol?.error}`);
});
