// Market cap lookup in FOMO answers.
//
// The schema is not ours, so the lookup is tolerant, which makes it all the
// more important that it never grabs ANOTHER token's cap: one answer carries
// several tokens side by side, and an order caption with a foreign level
// would lie convincingly.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { findTokenInfo } from '../src/shared/marketcap.js';

/** The cap alone, the way the order caption reads it. */
const cap = (root, address) => findTokenInfo(root, address).marketCapUsd;

const BEAR = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

test('the cap is taken from the node of the wanted token', () => {
  const json = {
    responseObject: {
      token: { address: BEAR, symbol: 'BEAR', marketCap: 2_000_000 },
    },
  };
  assert.equal(cap(json, BEAR), 2_000_000);
});

test('a foreign cap is not substituted for ours', () => {
  const json = {
    tokens: [
      { address: OTHER, marketCap: 999_000_000 },
      { address: BEAR, marketCap: 2_000_000 },
    ],
  };
  assert.equal(cap(json, BEAR), 2_000_000);
  assert.equal(cap(json, '0x3333333333333333333333333333333333333333'), null);
});

test('a tokenId of the form "<address>:<chain>" is recognised too', () => {
  assert.equal(cap({ t: { tokenId: `${BEAR}:4663`, mcap: 5_000 } }, BEAR), 5_000);
});

test('a cap not tied to an address is ignored', () => {
  // A bare number could refer to anything; it must not be taken.
  assert.equal(cap({ marketCap: 123_456 }, BEAR), null);
});

test('garbage and empty values are not a cap', () => {
  assert.equal(cap({ t: { address: BEAR, marketCap: 0 } }, BEAR), null);
  assert.equal(cap({ t: { address: BEAR, marketCap: 'none' } }, BEAR), null);
  assert.equal(cap(null, BEAR), null);
  assert.equal(cap({ t: { address: BEAR } }, null), null);
});

// The ticker and the cap may arrive in DIFFERENT answers. Stopping at the
// first match would lose half the information and leave a bare address in the
// order line instead of a ticker.
test('the ticker and the cap are assembled piece by piece', () => {
  const info = findTokenInfo({
    responseObject: {
      balances: [
        { balance: { tokenAddress: BEAR }, userToken: { symbol: 'BEAR', decimals: 18 } },
      ],
    },
  }, BEAR);
  assert.equal(info.symbol, 'BEAR');
  assert.equal(info.decimals, 18);
  assert.equal(info.marketCapUsd, null, 'this answer has no cap, and none may be invented');
});

test('data from a nested object next to the address is seen too', () => {
  // Exactly the balance record shape: the address in one node, the ticker in
  // the neighbour.
  const info = findTokenInfo({
    balances: [{ balance: { tokenAddress: BEAR, marketCap: 2_000_000 }, userToken: { symbol: 'BEAR' } }],
  }, BEAR);
  assert.equal(info.symbol, 'BEAR');
  assert.equal(info.marketCapUsd, 2_000_000);
});

test('a foreign ticker is not substituted', () => {
  const info = findTokenInfo({
    tokens: [
      { address: OTHER, symbol: 'OTHER', marketCap: 999 },
      { address: BEAR, symbol: 'BEAR', marketCap: 111 },
    ],
  }, BEAR);
  assert.equal(info.symbol, 'BEAR');
  assert.equal(info.marketCapUsd, 111);
});
