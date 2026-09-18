// What the hub does with a verdict when it already holds one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHub } from '../daemon/hub.mjs';
import { refinesVerdict } from '../src/shared/daemon-api.js';

function hubWith(orders) {
  const state = {
    data: { orders, version: 1, notes: [] },
    note(n) { this.data.notes.push(n); },
    save() {},
  };
  return { hub: createHub({ state, log: () => {} }), state };
}

const order = (over = {}) => ({ id: 'o1', status: 'watching', side: 'sell', ...over });

test('a send accepted and then confirmed: the hub ends up saying filled', () => {
  const { hub, state } = hubWith([order()]);
  hub.applyRunnerReport({ orders: [{ id: 'o1', status: 'triggered', closedTx: '0xabc' }] });
  assert.equal(state.data.orders[0].status, 'triggered');
  const { applied } = hub.applyRunnerReport({ orders: [{ id: 'o1', status: 'filled', closedTx: '0xabc' }] });
  assert.equal(applied, 1, 'the second answer is taken');
  assert.equal(state.data.orders[0].status, 'filled');
});

test('what the owner closed is not reopened by a late runner verdict', () => {
  const { hub, state } = hubWith([order({ status: 'cancelled', closedBy: 'owner' })]);
  const { applied } = hub.applyRunnerReport({ orders: [{ id: 'o1', status: 'filled', closedTx: '0xabc' }] });
  assert.equal(applied, 0);
  assert.equal(state.data.orders[0].status, 'cancelled');
  assert.deepEqual(state.data.notes.map((n) => n.kind), ['late-verdict'], 'the sale is written down, not applied');
});

test('a filled order is not turned back into anything else', () => {
  const { hub, state } = hubWith([order({ status: 'filled', closedBy: 'runner' })]);
  hub.applyRunnerReport({ orders: [{ id: 'o1', status: 'failed' }] });
  assert.equal(state.data.orders[0].status, 'filled');
});

test('the rule itself: only triggered is refined, and only into an answer', () => {
  assert.equal(refinesVerdict('triggered', 'filled'), true);
  assert.equal(refinesVerdict('triggered', 'failed'), true);
  assert.equal(refinesVerdict('triggered', 'cancelled'), false);
  assert.equal(refinesVerdict('triggered', 'watching'), false);
  assert.equal(refinesVerdict('filled', 'failed'), false);
  assert.equal(refinesVerdict('cancelled', 'filled'), false);
  assert.equal(refinesVerdict('watching', 'filled'), false);
});
