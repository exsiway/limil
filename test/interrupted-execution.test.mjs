// A worker that dies mid-execution must not let the order fire again.
//
// The marker is written before the page is asked and removed only after the
// order's outcome is written, so the two failure windows the signing ticket
// left open are covered: the gap between clearing the ticket and closing the
// order, and Solana, where the ticket is never spent because Privy signs on
// the page.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { interruptedAttempt } from '../src/shared/runner.js';

const watching = (id) => ({ id, status: 'watching' });

test('a marker over a live order is an interrupted execution', () => {
  const attempt = { orderId: 'ord_1', at: Date.now() };
  assert.equal(interruptedAttempt({ attempt }, [watching('ord_1'), watching('ord_2')]), 'ord_1');
});

test('Solana counts, where the ticket is never spent', () => {
  // Privy signs on the page, so the ticket stays unused for the whole send.
  // Only the marker shows that anything was started.
  const attempt = { orderId: 'ord_sol', at: Date.now() };
  const ticket = { orderId: 'ord_sol', used: false };
  assert.equal(interruptedAttempt({ attempt, ticket }, [watching('ord_sol')]), 'ord_sol');
});

test('the window after the ticket is cleared counts too', () => {
  // The old signal is gone by then; the marker is not.
  assert.equal(interruptedAttempt({ attempt: { orderId: 'ord_1' }, ticket: null }, [watching('ord_1')]), 'ord_1');
});

test('a spent ticket without a marker still counts, for a browser upgraded mid-flight', () => {
  const ticket = { orderId: 'ord_1', used: true };
  assert.equal(interruptedAttempt({ ticket }, [watching('ord_1')]), 'ord_1');
});

test('an order that was already closed needs no recovery', () => {
  const attempt = { orderId: 'ord_1' };
  assert.equal(interruptedAttempt({ attempt }, [{ id: 'ord_1', status: 'filled' }]), null);
  assert.equal(interruptedAttempt({ attempt }, [{ id: 'ord_1', status: 'triggered' }]), null);
  assert.equal(interruptedAttempt({ attempt }, [{ id: 'ord_1', status: 'cancelled' }]), null);
});

test('nothing to recover from nothing', () => {
  assert.equal(interruptedAttempt({}, [watching('ord_1')]), null);
  assert.equal(interruptedAttempt({ attempt: null, ticket: { orderId: 'ord_1', used: false } }, [watching('ord_1')]), null);
  assert.equal(interruptedAttempt({ attempt: { orderId: 'ord_9' } }, [watching('ord_1')]), null);
  assert.equal(interruptedAttempt({ attempt: { orderId: 'ord_1' } }, []), null);
});
