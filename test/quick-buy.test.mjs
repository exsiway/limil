// Quick buy: amounts and reading the token out of a card. The DOM is not
// here; what decides how much money moves on a press is.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_QUICK_BUY_AMOUNTS, MAX_QUICK_BUY_USD,
  formatUsd, normalizeAmounts, tokenIdFromLogo, usdToCashUnits,
} from '../src/shared/quick-buy.js';

test('amounts: a list or a string, two at most, sorted, no duplicates', () => {
  assert.deepEqual(normalizeAmounts([200, 50]), [50, 200]);
  assert.deepEqual(normalizeAmounts('50, 200'), [50, 200]);
  assert.deepEqual(normalizeAmounts('$25 $25 $100'), [25, 100]);
  assert.deepEqual(normalizeAmounts([10, 20, 30]), [10, 20]);
  assert.deepEqual(normalizeAmounts([12.345]), [12.35]);
});

test('amounts: garbage and zero fall back to the defaults, a typo does not become a position', () => {
  assert.deepEqual(normalizeAmounts(''), DEFAULT_QUICK_BUY_AMOUNTS);
  assert.deepEqual(normalizeAmounts(['lots', -5, 0]), DEFAULT_QUICK_BUY_AMOUNTS);
  assert.deepEqual(normalizeAmounts([MAX_QUICK_BUY_USD + 1, 50]), [50]);
  assert.deepEqual(normalizeAmounts(null), DEFAULT_QUICK_BUY_AMOUNTS);
});

test('USD converts to USDC minimal units exactly', () => {
  assert.equal(usdToCashUnits(50), 50_000_000n);
  assert.equal(usdToCashUnits(12.5), 12_500_000n);
  assert.equal(usdToCashUnits('0.01'), 10_000n);
  assert.throws(() => usdToCashUnits(0), /above zero/);
  assert.throws(() => usdToCashUnits('x'), /above zero/);
});

test('the button label reads like a price', () => {
  assert.equal(formatUsd(50), '$50');
  assert.equal(formatUsd(12.5), '$12.5');
  assert.equal(formatUsd(12.25), '$12.25');
});

test('the token id is read out of the logo URL, chain and address', () => {
  assert.equal(
    tokenIdFromLogo('https://token-media.defined.fi/8453_0xb2000000000000000000004c27f6523082f41d01_small_868bb01d4fe7.png'),
    '0xb2000000000000000000004c27f6523082f41d01:8453',
  );
  assert.equal(
    tokenIdFromLogo('https://token-media.defined.fi/1399811149_9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump_small_x.png'),
    '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump:1399811149',
  );
  assert.equal(tokenIdFromLogo('https://token-media.defined.fi/999999_0xb2000000000000000000004c27f6523082f41d01_small.png'), null, 'a chain FOMO does not trade on');
  assert.equal(tokenIdFromLogo('https://prod-fomo-profile-pics.s3.amazonaws.com/abc_small.jpg'), null, 'a profile picture is not a token');
  assert.equal(tokenIdFromLogo(null), null);
});
