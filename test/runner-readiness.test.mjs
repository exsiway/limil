// The readiness lamp must answer the question it appears to answer.
//
// A signing envelope for this wallet is the smallest part of the truth, and
// "Orders available" must not be printed on that alone: an order also needs
// the wallet delegated to the contract on its own chain, and a session grant
// that covers it. Either can be missing while the envelope is perfect.
//
// So the lamp asks the chain, and these are the answers it must give.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encodeFunctionResult } from 'viem';

import { SESSION_VIEW_ABI } from '../src/shared/userop.js';

const SENDER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const SECRET = `0x${'11'.repeat(32)}`;
const CHAIN = 4663;
const ZERO = '0x0000000000000000000000000000000000000000';
/** FOMO's own account: what a fresh wallet runs before we ever touch it. */
const FOMO_DELEGATE = '0xe6cae83bde06e4c305530e199d7217f42808555b';

const order = (over = {}) => ({
  id: 'o1', status: 'watching', side: 'sell', sender: SENDER,
  inTokenId: `${TOKEN}:${CHAIN}`, amount: '10000',
  targetOut: '5000000', maxSlippageBps: 500, ...over,
});

const noSession = encodeFunctionResult({
  abi: SESSION_VIEW_ABI,
  functionName: 'getSession',
  result: {
    validUntil: 0n, maxOps: 0n, opsUsed: 0n, exists: false, maxValuePerCall: 0n, valueBudget: 0n,
    spentValue: 0n, feeBudget: 0n, spentFees: 0n, maxFeePerOp: 0n, guard: ZERO, guardToken: ZERO,
    guardHolder: ZERO, swapRouter: ZERO, swapSelector: '0x00000000',
  },
});

/** A worker world with the given storage and a node that answers `code`. */
function install({ store, code = null, dead = false }) {
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
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    alarms: { async create() {}, async clear() {} },
  };
  globalThis.fetch = async (url, init) => {
    if (dead) throw new Error('the node is silent');
    const body = JSON.parse(init.body);
    const result = body.method === 'eth_getCode' ? code : noSession;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}

const on = { settings: { ordersEnabled: true }, 'runner.secret': SECRET };

test('with limit orders switched off it says so and nothing else', async () => {
  install({ store: { settings: { ordersEnabled: false }, orders: [order()] } });
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'off');
});

test('no live orders is not a fault, there is simply nothing to execute', async () => {
  install({ store: { ...on, orders: [order({ status: 'cancelled' })] } });
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.ok, true);
  assert.equal(r.code, 'idle');
  assert.equal(r.reason, null);
});

test('a wallet still on FOMO\'s contract: NOT ready, and the lamp says why', async () => {
  // The exact case that showed green all evening.
  install({ store: { ...on, orders: [order()] }, code: `0xef0100${FOMO_DELEGATE.slice(2)}` });
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-delegated');
  assert.match(r.reason, /NOT execute/i);
  // And it names the cure, because "not connected" alone is not actionable.
  assert.match(r.reason, /without reloading/i);
});

test('an undelegated wallet is the same answer', async () => {
  install({ store: { ...on, orders: [order()] }, code: '0x' });
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.code, 'not-delegated');
});

test('delegated but ungranted: still NOT ready, and it says what is missing', async () => {
  const { delegateFor } = await import('../src/shared/chains.js');
  install({ store: { ...on, orders: [order()] }, code: `0xef0100${delegateFor(CHAIN).slice(2).toLowerCase()}` });
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-grant');
  assert.ok(r.reason.length > 0);
});

test('a silent node is reported as a silent node, never as "available"', async () => {
  install({ store: { ...on, orders: [order()] }, dead: true });
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'node');
});

test('orders on TWO chains: a chain nobody granted is not hidden by a good one', async () => {
  // The planner works on one chain at a time, the newest order's, so a
  // second chain can be dead while the first is perfect. A lamp that looked
  // at one chain would go green over exactly that, which is how "not
  // connected on BNB Chain" managed to be the whole report.
  const { delegateFor } = await import('../src/shared/chains.js');
  const BASE = 8453;
  const store = {
    ...on,
    orders: [
      order({ id: 'newest', inTokenId: `${TOKEN}:${CHAIN}` }),
      order({ id: 'older', inTokenId: `0x2222222222222222222222222222222222222222:${BASE}` }),
    ],
  };
  // Delegated on the newest order's chain, still on FOMO's contract elsewhere.
  globalThis.chrome = undefined;
  install({ store });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method !== 'eth_getCode') return { ok: true, json: async () => ({ result: noSession }) };
    const onOurChain = String(url).includes('robinhood');
    return {
      ok: true,
      json: async () => ({
        result: onOurChain
          ? `0xef0100${delegateFor(CHAIN).slice(2).toLowerCase()}`
          : `0xef0100${FOMO_DELEGATE.slice(2)}`,
      }),
    };
  };
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.ok, false);
  assert.match(r.reason, /Base/, 'the chain nobody granted must be named');
});

test('a Solana order alone needs no contract and does not turn the lamp red', async () => {
  install({ store: { ...on, orders: [order({ inTokenId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149' })] } });
  const { readiness } = await import('../src/background/runner.js');
  const r = await readiness();
  assert.equal(r.ok, true);
  assert.equal(r.code, 'solana');
});
