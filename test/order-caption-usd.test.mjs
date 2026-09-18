// The order line says what it comes to in money.
//
// "Sell 2.15 $PONS at $770.6M MC" is precise and answers a question nobody
// asked. What a person wants to know before pressing Place is how many
// dollars that is. The figure is appended wherever the caption ends up, at a
// market-cap level, at market, or as a percentage against it.
//
// And it is appended only when it is known. A number about money that the
// code guessed would be worse than no number at all.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { describeOrder } from '../src/shared/orders.js';

const base = {
  side: 'sell', amount: 2_150000000000000000n, decimals: 18, symbol: 'PONS', percent: 20,
};

test('with a value, the caption carries it', () => {
  const out = describeOrder({ ...base, targetMarketCapUsd: 770_600_000, valueUsd: 4.62 });
  assert.match(out, /\$PONS/);
  assert.match(out, /770\.6M MC/);
  assert.match(out, /4\.62/);
});

test('without a value, nothing about dollars is invented', () => {
  const out = describeOrder({ ...base, targetMarketCapUsd: 770_600_000 });
  assert.match(out, /770\.6M MC/);
  assert.doesNotMatch(out, /≈/);
});

test('a nonsense value is treated as no value', () => {
  for (const bad of [0, -5, Number.NaN, null, undefined, Number.POSITIVE_INFINITY]) {
    assert.doesNotMatch(describeOrder({ ...base, targetMarketCapUsd: 1e6, valueUsd: bad }), /≈/, String(bad));
  }
});

test('big numbers lose the cents, small ones keep them', () => {
  assert.match(describeOrder({ ...base, targetMarketCapUsd: 1e6, valueUsd: 4231.7 }), /4232/);
  assert.match(describeOrder({ ...base, targetMarketCapUsd: 1e6, valueUsd: 4.6 }), /4\.60/);
});

test('it rides along on the other two captions as well', () => {
  const atMarket = describeOrder({ ...base, percent: 0, valueUsd: 9.5 });
  assert.match(atMarket, /9\.50/);
  const vsMarket = describeOrder({ ...base, percent: 20, valueUsd: 9.5 });
  assert.match(vsMarket, /9\.50/);
  assert.match(vsMarket, /20/);
});
