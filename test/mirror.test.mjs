import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { MIRRORED, mergeMirror, orderForDaemon } from '../src/shared/daemon-api.js';

const NOW = 1_800_000_000_000;
const up = (id, over = {}) => ({ id, status: 'watching', side: 'sell', inTokenId: 'a:56', outTokenId: 'c:1399811149', amount: '1', targetOut: '2', targetMarketCapUsd: 1e6, ...over });

test('orders the hub watches and this browser does not know are added as mirrored', () => {
  const { orders, added, cancelled, report } = mergeMirror([], [up('o1'), up('o2', { status: 'filled' })], { now: NOW });
  assert.equal(added, 1, 'a closed upstream order is not added');
  assert.equal(cancelled, 0);
  assert.deepEqual(report, []);
  assert.equal(orders[0].id, 'o1');
  assert.equal(orders[0][MIRRORED], true);
  assert.equal(orders[0].targetMarketCapUsd, 1e6, 'the watcher level travels with the order');
});

test('a mirrored order the hub dropped is cancelled here; own orders are untouched', () => {
  const local = [
    { id: 'o1', status: 'watching', [MIRRORED]: true },
    { id: 'mine', status: 'watching' },
  ];
  const { orders, cancelled, added } = mergeMirror(local, [], { now: NOW });
  assert.equal(cancelled, 1);
  assert.equal(added, 0);
  assert.equal(orders.find((o) => o.id === 'o1').status, 'cancelled');
  assert.equal(orders.find((o) => o.id === 'mine').status, 'watching', 'placed here, not the hub\'s business');
});

test('a mirrored order this browser closed is reported once per verdict', () => {
  const local = [
    { id: 'o1', status: 'filled', [MIRRORED]: true, closedAt: 'T', closedTx: '0xabc' },
    { id: 'o2', status: 'filled', [MIRRORED]: true, closedAt: 'T', reportedAt: 'T2', reportedStatus: 'filled' },
    { id: 'o3', status: 'cancelled', [MIRRORED]: true, cancelledAt: 'T', cancelReason: 'token sold' },
  ];
  const upstream = [up('o1'), up('o2'), up('o3')];
  const { report, orders } = mergeMirror(local, upstream, { now: NOW });
  assert.deepEqual(report.map((r) => r.id), ['o1', 'o3'], 'o2 was reported already');
  assert.equal(report[0].closedTx, '0xabc');
  assert.equal(report[1].reason, 'token sold');
  assert.equal(orders.length, 3, 'nothing re-added while the hub still lists them');
});

test('a sale confirmed after the send is reported again, and only once', () => {
  // The order left the watch list as `triggered` the moment the bundler took
  // the send, and the hub was told. The balance proved the sale a minute
  // later: the hub has to hear that too, or the owner reads "sent,
  // unconfirmed" about a position that is gone.
  const local = [{
    id: 'o1', status: 'filled', [MIRRORED]: true, closedAt: 'T', closedTx: '0xabc',
    reportedAt: 'T1', reportedStatus: 'triggered',
  }];
  const first = mergeMirror(local, [up('o1', { status: 'triggered' })], { now: NOW });
  assert.deepEqual(first.report.map((r) => r.status), ['filled'], 'the refined verdict goes up');

  // Once the hub has it, there is nothing left to say.
  const settled = [{ ...local[0], reportedStatus: 'filled' }];
  const second = mergeMirror(settled, [up('o1', { status: 'filled' })], { now: NOW });
  assert.deepEqual(second.report, [], 'no repeat once the hub agrees');

  // A hub that will not take the verdict is not asked every round either.
  const refused = mergeMirror(settled, [up('o1', { status: 'triggered' })], { now: NOW });
  assert.deepEqual(refused.report, [], 'one attempt per verdict, whatever the hub does with it');
});

test('a verdict is reported even though the hub no longer lists the order', () => {
  // The hub hands a runner only what it still watches, so an order closed here
  // is absent from that list. Absence is not agreement: without this the
  // confirmation of a sale had no way of ever reaching the owner.
  const local = [{
    id: 'o1', status: 'filled', [MIRRORED]: true, closedAt: 'T', closedTx: '0xabc',
    reportedAt: 'T1', reportedStatus: 'triggered',
  }];
  const { report, orders } = mergeMirror(local, [], { now: NOW });
  assert.deepEqual(report.map((r) => `${r.id}:${r.status}`), ['o1:filled']);
  assert.equal(orders[0].status, 'filled', 'a closed order is not re-cancelled');
});

test('an order the owner removed is not reported back at them', () => {
  const local = [{ id: 'o1', status: 'watching', [MIRRORED]: true }];
  const first = mergeMirror(local, [], { now: NOW });
  assert.equal(first.orders[0].status, 'cancelled');
  assert.deepEqual(first.report, [], 'the hub is where this came from');
  // And not on the round after, either.
  const second = mergeMirror(first.orders, [], { now: NOW });
  assert.deepEqual(second.report, []);
});

test('the wire order carries what the runner browser needs to draw and watch', () => {
  const w = orderForDaemon({ id: 'x', status: 'watching', side: 'sell', inTokenId: 'a:56', outTokenId: 'b:1', amount: 5n, targetOut: 7n, percent: 12, amountPercent: 50, marketCapUsd: 100, targetMarketCapUsd: 112, tokenAddress: '0xa' });
  assert.equal(w.amount, '5');
  assert.equal(w.targetMarketCapUsd, 112);
  assert.equal(w.amountPercent, 50);
  assert.equal(w.tokenAddress, '0xa');
});
