// The signing ticket is spent once, whatever arrives together.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

function fakeChrome() {
  const bag = {};
  return {
    storage: {
      local: {
        async get(key) {
          // A real storage read is asynchronous; the tick here is what let two
          // readers see the same unspent ticket before either wrote.
          await new Promise((r) => { setTimeout(r, 2); });
          return key === null ? structuredClone(bag) : { [key]: structuredClone(bag[key]) };
        },
        async set(obj) { await new Promise((r) => { setTimeout(r, 2); }); Object.assign(bag, structuredClone(obj)); },
        async remove(key) { delete bag[key]; },
      },
      onChanged: { addListener() {} },
    },
    alarms: { async create() {}, async get() { return null; }, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: { async query() { return []; } },
    bag,
  };
}

test('three signature requests racing for one ticket: one is signed, two are refused', async () => {
  globalThis.chrome = fakeChrome();
  const { spendTicket } = await import('../src/background/runner.js');
  const now = 1_800_000_000_000;
  await chrome.storage.local.set({ 'runner.ticket': { orderId: 'o1', at: now, used: false } });
  const results = await Promise.allSettled([
    spendTicket({ orderId: 'o1', now }),
    spendTicket({ orderId: 'o1', now }),
    spendTicket({ orderId: 'o1', now }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((r) => r.status === 'rejected')) assert.match(String(r.reason.message), /already used/);
  assert.equal(chrome.bag['runner.ticket'].used, true);
  // The wrong order never spends it.
  await chrome.storage.local.set({ 'runner.ticket': { orderId: 'o2', at: now, used: false } });
  await assert.rejects(spendTicket({ orderId: 'o1', now }), /another order/);
  assert.equal(chrome.bag['runner.ticket'].used, false, 'a refusal leaves the ticket for its own order');
});
