// One-time intents: the worker's consent to one privileged operation.

import { strict as assert } from 'node:assert';
import { test, beforeEach } from 'node:test';

import { INTENT_TTL_MS, canonical, consumeIntent, issueIntent } from '../src/background/intent.js';

function fakeChrome() {
  const bag = {};
  return {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(bag[key]) }; },
        async set(obj) { Object.assign(bag, structuredClone(obj)); },
      },
    },
  };
}

beforeEach(() => { globalThis.chrome = fakeChrome(); });

const GRANT = {
  sender: '0xAaAa000000000000000000000000000000000001',
  chainId: 4663,
  key: '0x1111111111111111111111111111111111111111',
  limits: { validUntil: 1, maxOps: 12, maxApprovePerOp: '5', approveBudget: '10' },
  targets: ['0xToken', '0xRouter'],
  selectors: ['0x095ea7b3', '0xf9e4bab4'],
  feeRecipients: [],
};

test('canonical form ignores key order and address case, and spells BigInt as a string', () => {
  const a = canonical({ b: 1, a: [{ y: 2n, x: '0xABC' }], c: undefined });
  const b = canonical({ a: [{ x: '0xabc', y: '2' }], b: 1 });
  assert.equal(a, b);
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});

test('an intent is spent by the exact parameters it was issued for, once', async () => {
  const id = await issueIntent({ kind: 'grant', params: GRANT });
  assert.match(id, /^[0-9a-f]{32}$/);
  // Same operation, keys shuffled and addresses lower-cased: still the same.
  const same = { ...GRANT, sender: GRANT.sender.toLowerCase(), feeRecipients: [] };
  assert.equal(await consumeIntent({ id, kind: 'grant', params: same }), true);
  await assert.rejects(consumeIntent({ id, kind: 'grant', params: same }), /no intent/);
});

test('changed parameters, another kind or an unknown id are refused', async () => {
  const id = await issueIntent({ kind: 'grant', params: GRANT });
  await assert.rejects(consumeIntent({ id, kind: 'grant', params: { ...GRANT, key: '0x2222222222222222222222222222222222222222' } }), /parameters differ/);
  await assert.rejects(consumeIntent({ id, kind: 'grant', params: { ...GRANT, limits: { ...GRANT.limits, approveBudget: '999' } } }), /parameters differ/);
  await assert.rejects(consumeIntent({ id, kind: 'delegate', params: GRANT }), /is for grant, not delegate/);
  await assert.rejects(consumeIntent({ id: 'deadbeef', kind: 'grant', params: GRANT }), /no intent/);
  await assert.rejects(consumeIntent({ id: undefined, kind: 'grant', params: GRANT }), /no intent/);
  // A refused attempt does not spend the intent.
  assert.equal(await consumeIntent({ id, kind: 'grant', params: GRANT }), true);
});

test('an intent expires', async () => {
  const now = 1_800_000_000_000;
  const id = await issueIntent({ kind: 'delegate', params: { sender: '0x1', chainId: 1, delegate: '0x2' }, now });
  await assert.rejects(
    consumeIntent({ id, kind: 'delegate', params: { sender: '0x1', chainId: 1, delegate: '0x2' }, now: now + INTENT_TTL_MS + 1 }),
    /expired|no intent/,
  );
});

test('only the three known kinds are issued', async () => {
  await assert.rejects(issueIntent({ kind: 'swap', params: {} }), /unknown intent kind/);
});

test('chrome.storage.session is preferred when present', async () => {
  const session = fakeChrome().storage.local;
  globalThis.chrome = { storage: { local: { async get() { throw new Error('local must not be used'); }, async set() { throw new Error('local must not be used'); } }, session } };
  const id = await issueIntent({ kind: 'disconnect', params: { sender: '0x1', chainId: 4663, key: null } });
  assert.equal(await consumeIntent({ id, kind: 'disconnect', params: { sender: '0x1', chainId: 4663, key: null } }), true);
});

test('two concurrent consumes of one intent: exactly one succeeds', async () => {
  const id = await issueIntent({ kind: 'grant', params: GRANT });
  const results = await Promise.allSettled([
    consumeIntent({ id, kind: 'grant', params: GRANT }),
    consumeIntent({ id, kind: 'grant', params: GRANT }),
    consumeIntent({ id, kind: 'grant', params: GRANT }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'a one-time intent is spent once');
  assert.equal(results.filter((r) => r.status === 'rejected').length, 2);
  // Issuing concurrently with consuming loses nothing either.
  const [a, b] = await Promise.all([issueIntent({ kind: 'grant', params: GRANT }), issueIntent({ kind: 'grant', params: { ...GRANT, chainId: 8453 } })]);
  assert.notEqual(a, b);
  assert.equal(await consumeIntent({ id: a, kind: 'grant', params: GRANT }), true);
  assert.equal(await consumeIntent({ id: b, kind: 'grant', params: { ...GRANT, chainId: 8453 } }), true);
});
