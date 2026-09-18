// A Solana send for an order goes out only after the worker has written the
// marker that makes a lost page an unknown outcome instead of a free retry.
//
// The property under test is a precondition: `requireSendMark` throws, and the
// throw is awaited three lines above the POST, so a failure to mark means no
// POST. Every way of not knowing has to count as a failure, which is the part
// worth pinning down.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { requireSendMark } from '../src/main/solana-exec.js';

const ok = async () => ({ ok: true });

test('a confirmed mark lets the send proceed', async () => {
  const seen = [];
  await requireSendMark({
    callBackground: async (type, payload) => { seen.push([type, payload]); return { ok: true }; },
    orderId: 'ord_1',
    txHash: 'sig123',
  });
  assert.deepEqual(seen, [['runner.sending', { orderId: 'ord_1', txHash: 'sig123' }]]);
});

test('a worker that refuses stops the send', async () => {
  // The marker belongs to another order, or there is no attempt at all.
  await assert.rejects(
    requireSendMark({ callBackground: async () => ({ ok: false }), orderId: 'ord_1' }),
    /NOTHING WAS SENT/,
  );
});

test('an answer that is not an answer stops the send', async () => {
  for (const answer of [null, undefined, {}, 'yes', 0]) {
    await assert.rejects(
      requireSendMark({ callBackground: async () => answer, orderId: 'ord_1' }),
      /NOTHING WAS SENT/,
    );
  }
});

test('a storage or messaging failure stops the send', async () => {
  await assert.rejects(
    requireSendMark({
      callBackground: async () => { throw new Error('storage write failed'); },
      orderId: 'ord_1',
    }),
    /storage write failed[\s\S]*NOTHING WAS SENT/,
  );
});

test('a worker that never answers stops the send', async () => {
  await assert.rejects(
    requireSendMark({
      callBackground: () => new Promise(() => { /* never settles */ }),
      orderId: 'ord_1',
      timeoutMs: 30,
    }),
    /no answer in 30ms[\s\S]*NOTHING WAS SENT/,
  );
});

test('a trade made by hand needs no marker and asks for none', async () => {
  let asked = false;
  await requireSendMark({ callBackground: async () => { asked = true; return ok(); }, orderId: null });
  assert.equal(asked, false, 'nobody retries a trade a person makes, so there is nothing to protect');
});
