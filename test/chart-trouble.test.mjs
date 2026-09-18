// Why there is no level on the chart should be readable somewhere.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { chartTrouble } from '../src/shared/orders.js';

test('the ordinary noise of a page loading is not reported', () => {
  const report = { drawn: 0, skipped: [
    'widget not captured, deferred until the chart is ready',
    'chart not ready, deferred: no widget yet',
    'ord_1: page token unknown, not drawing',
    'ord_1: order line unavailable (no such method), drawing a shape',
  ] };
  assert.deepEqual(chartTrouble(report), [], 'none of these is a problem a person can act on');
});

test('a level nobody could place is reported', () => {
  const report = { drawn: 0, skipped: [
    'ord_1: target 324430000000 is not in the scale of the axis (~2634)',
    'ord_2: no target market cap, nothing to draw',
    'ord_3: shape not placed (createShape threw)',
  ] };
  assert.equal(chartTrouble(report).length, 3);
});

test('noise and trouble together leave only the trouble', () => {
  const report = { skipped: [
    'chart not ready, deferred: no widget yet',
    'ord_9: no target market cap, nothing to draw',
  ] };
  assert.deepEqual(chartTrouble(report), ['ord_9: no target market cap, nothing to draw']);
});

test('a report with nothing in it is not trouble', () => {
  assert.deepEqual(chartTrouble({ drawn: 3, skipped: [] }), []);
  assert.deepEqual(chartTrouble({}), []);
  assert.deepEqual(chartTrouble(null), []);
});
