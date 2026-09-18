// The order list is bounded, and the bound must not eat a live order.
//
// A plain `slice(0, 200)` dropped the OLDEST entries whatever their status.
// Closed orders are never pruned on their own, so a stop-loss placed long ago
// fell off the list under two hundred later placements, and a page that could
// reach `orders.add` could erase every live order by adding two hundred.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { MAX_ORDERS, trimOrders } from '../src/background/orders-store.js';

const closed = (i) => ({ id: `c${i}`, status: 'filled' });
const live = (i) => ({ id: `w${i}`, status: 'watching' });

test('a list within the bound is returned as it is', () => {
  const list = [live(1), closed(1)];
  assert.equal(trimOrders(list), list);
});

test('closed orders fall off first, oldest first, and the order of the rest is kept', () => {
  // Newest first, like storage: a live order sits at the very end.
  const list = [];
  for (let i = 0; i < MAX_ORDERS + 5; i += 1) list.push(i % 3 === 0 ? live(i) : closed(i));
  list.push(live('old'));
  const kept = trimOrders(list);
  assert.equal(kept.length, MAX_ORDERS);
  assert.ok(kept.some((o) => o.id === 'wold'), 'the oldest live order survives');
  const liveIn = list.filter((o) => o.status === 'watching').map((o) => o.id);
  const liveOut = kept.filter((o) => o.status === 'watching').map((o) => o.id);
  assert.deepEqual(liveOut, liveIn, 'no live order is lost');
  const ids = kept.map((o) => o.id);
  assert.deepEqual(ids, list.filter((o) => ids.includes(o.id)).map((o) => o.id), 'relative order preserved');
});

test('only when the whole list is live does a live order go', () => {
  const list = [];
  for (let i = 0; i < MAX_ORDERS + 1; i += 1) list.push(live(i));
  const kept = trimOrders(list);
  assert.equal(kept.length, MAX_ORDERS);
  assert.equal(kept[0].id, 'w0', 'the newest stays');
  assert.equal(kept.at(-1).id, `w${MAX_ORDERS - 1}`, 'the oldest one goes');
});
