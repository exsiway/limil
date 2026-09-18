// One sale must not become two.
//
// After a send there are three kinds of answer: the chain showed a revert,
// the chain showed a fill, or nobody knows. Only the first leaves the order
// on watch. These are the exact report shapes the two executors produce.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { positionProvenIntact } from '../src/shared/runner.js';

test('a revert the chain showed is the only thing that keeps an order watching', () => {
  // src/main/swap-exec.js: a receipt that says so.
  assert.equal(positionProvenIntact({ sent: true, receipt: { success: false, status: 'reverted' } }), true);
  // src/main/solana-exec.js: landed and failed.
  assert.equal(positionProvenIntact({ sent: true, receipt: { success: false, status: 'failed on chain: instruction error' } }), true);
  // src/main/solana-exec.js: never included before the blockhash expired.
  assert.equal(positionProvenIntact({ sent: true, receipt: { success: false, status: 'dropped: not included before its blockhash expired' } }), true);
});

test('an outcome nobody knows does not keep an order watching', () => {
  // EVM: the bundler took it, no receipt came, the balance did not visibly move.
  assert.equal(
    positionProvenIntact({ sent: true, receipt: { success: null, status: 'no receipt and the balance did not move' } }),
    false,
    'the operation is with the bundler; watching it would risk a second sale',
  );
  // Solana relay: the origin transaction landed, the relay leg said nothing in time.
  assert.equal(
    positionProvenIntact({ sent: true, receipt: { success: null, status: 'no terminal status within 90s' } }),
    false,
    'the tokens left the wallet when the origin transaction landed',
  );
  // Solana relay: the leg failed or refunded, which is not the origin reverting.
  assert.equal(positionProvenIntact({ sent: true, receipt: { success: null, status: 'FAILED' } }), false);
  assert.equal(positionProvenIntact({ sent: true, receipt: { success: null, status: 'REFUND' } }), false);
  // dflow: sent, the chain has not shown it yet.
  assert.equal(positionProvenIntact({ sent: true, receipt: { success: null, status: 'sent, the chain has not shown it yet' } }), false);
  // No receipt field at all.
  assert.equal(positionProvenIntact({ sent: true }), false);
});

test('a fill is not a revert either', () => {
  assert.equal(positionProvenIntact({ sent: true, receipt: { success: true, status: 'confirmed by balance' } }), false);
});

test('nothing sent, nothing to judge', () => {
  assert.equal(positionProvenIntact({ sent: false, receipt: { success: false } }), false);
  assert.equal(positionProvenIntact(null), false);
  assert.equal(positionProvenIntact({}), false);
});

// --- the error side: what an execution that threw may already have done

test('EVM is decided by the signature', async () => {
  const { sendMayHaveHappened } = await import('../src/shared/runner.js');
  // Nothing reaches the bundler without the session key.
  assert.equal(sendMayHaveHappened({ signed: false, solanaSide: false, message: 'network error' }), false);
  assert.equal(sendMayHaveHappened({ signed: true, solanaSide: false, message: 'network error' }), true);
});

test('a Solana page that goes silent after marking the send is not a free retry', async () => {
  const { sendMayHaveHappened } = await import('../src/shared/runner.js');
  const lost = 'The message port closed before a response was received.';
  // The window the audit found: the page sent, then the channel died. No
  // spent ticket (Privy signs on the page) and no AFTER SEND prefix (the
  // failure is at the messaging boundary, not inside the page's fetch).
  assert.equal(
    sendMayHaveHappened({ signed: false, solanaSide: true, message: lost, attemptSent: true }),
    true,
    'the marker written before the send is what tells this from "never sent"',
  );
  // A closed tab, a timeout: the same class, and the marker answers all of them.
  assert.equal(sendMayHaveHappened({ solanaSide: true, message: 'the tab was closed', attemptSent: true }), true);
  assert.equal(sendMayHaveHappened({ solanaSide: true, message: 'timed out after 300000ms', attemptSent: true }), true);
});

test('a Solana failure before the send leaves the order watching', async () => {
  const { sendMayHaveHappened } = await import('../src/shared/runner.js');
  // Privy refused, the quote failed, the guard blocked: the page never got to
  // the send, so it never wrote the marker and the order can try again later.
  assert.equal(sendMayHaveHappened({ solanaSide: true, message: 'Privy refused: not loaded on this device', attemptSent: false }), false);
  assert.equal(sendMayHaveHappened({ solanaSide: true, message: 'quote failed', attemptSent: false }), false);
});

test('the page own marker still counts when it can speak', async () => {
  const { sendMayHaveHappened } = await import('../src/shared/runner.js');
  assert.equal(sendMayHaveHappened({ solanaSide: true, message: 'AFTER SEND: Jito timed out', attemptSent: false }), true);
});
