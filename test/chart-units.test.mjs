// A level is stored as a market cap. The chart is not always drawn in caps.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { levelForAxis } from '../src/main/chart-bridge.js';

// ETH as the app reports it, and the level the panel showed when this broke.
const ETH = { marketCapUsd: 317.9e9, tokenPriceUsd: 2634.58 };
const LEVEL = 324.43e9;

test('an axis drawn in prices gets the level in prices', () => {
  const drawn = levelForAxis({ level: LEVEL, ...ETH, reference: 2634.58 });
  assert.ok(drawn > 2600 && drawn < 2800, `expected a price-scale level, got ${drawn}`);
  // The same proportion above the market as the cap level is above the cap.
  assert.ok(Math.abs((drawn / 2634.58) - (LEVEL / 317.9e9)) < 1e-9);
});

test('the middle of the axis works as the reference when no tick has arrived', () => {
  // The visible window was 2,300 to 2,900 in the report that started this.
  const drawn = levelForAxis({ level: LEVEL, ...ETH, reference: (2300 + 2900) / 2 });
  assert.ok(drawn > 2600 && drawn < 2800, `got ${drawn}`);
});

test('an axis drawn in caps leaves the level alone', () => {
  const drawn = levelForAxis({ level: LEVEL, ...ETH, reference: 318.2e9 });
  assert.equal(drawn, LEVEL);
});

test('a memecoin, where cap and price are far apart the other way', () => {
  const coin = { marketCapUsd: 4_010_000, tokenPriceUsd: 0.00401 };
  // The chart plots the cap: the level is a cap and stays one.
  assert.equal(levelForAxis({ level: 4_250_000, ...coin, reference: 4_000_000 }), 4_250_000);
  // The chart plots the price: the same level becomes 0.00425.
  const asPrice = levelForAxis({ level: 4_250_000, ...coin, reference: 0.004 });
  assert.ok(Math.abs(asPrice - 0.00425) < 1e-9, `got ${asPrice}`);
});

test('without a price, a cap or a reference the level is returned untouched', () => {
  assert.equal(levelForAxis({ level: LEVEL, marketCapUsd: 317.9e9, reference: 2634 }), LEVEL);
  assert.equal(levelForAxis({ level: LEVEL, tokenPriceUsd: 2634, reference: 2634 }), LEVEL);
  assert.equal(levelForAxis({ level: LEVEL, ...ETH, reference: null }), LEVEL);
  assert.equal(levelForAxis({ level: LEVEL, ...ETH, reference: 0 }), LEVEL);
});

test('a level that is not a number is not a level', () => {
  assert.equal(levelForAxis({ level: 0, ...ETH, reference: 2634 }), null);
  assert.equal(levelForAxis({ level: NaN, ...ETH, reference: 2634 }), null);
  assert.equal(levelForAxis({}), null);
});
