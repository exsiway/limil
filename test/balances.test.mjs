// Balance and token context extraction.
//
// The parser of /v2/users/{uuid}/balances is tolerant, which makes it all the
// more important that it never confuses a human-readable amount with minimal
// units: an error here is a 10^18 error in the amount that gets signed.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  extractTokenBalance,
  extractWallets,
  uuidFromPath,
  looksHumanAmount,
  normalizeBalance,
  toMinimalUnits,
  tokenFromLocation,
} from '../src/shared/balances.js';

const SHRUB = '0x1111111111111111111111111111111111111111';

test('the token address is extracted from any route shape', () => {
  assert.equal(tokenFromLocation(`https://fomo.family/token/${SHRUB}`), SHRUB);
  assert.equal(tokenFromLocation(`https://fomo.family/t/4663/${SHRUB}?tab=chart`), SHRUB);
  assert.equal(
    tokenFromLocation('https://fomo.family/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  );
  assert.equal(tokenFromLocation('https://fomo.family/'), null);
});

test('a position is found by address, including the "<address>:<chain>" form', () => {
  const balances = {
    balances: [
      { tokenAddress: '0x2222222222222222222222222222222222222222', amount: '5' },
      {
        tokenId: `${SHRUB}:4663`,
        symbol: 'SHRUB',
        decimals: 18,
        tokenAmountRemaining: '16700000000000000000000',
        networkId: 4663,
      },
    ],
  };
  const found = extractTokenBalance(balances, SHRUB);
  assert.equal(found.symbol, 'SHRUB');
  assert.equal(found.decimals, 18);
  assert.equal(found.networkId, 4663);
  assert.equal(found.tokenId, `${SHRUB}:4663`);
});

test('address case does not matter', () => {
  const balances = [{ address: SHRUB.toUpperCase().replace('0X', '0x'), amount: '1', decimals: 6 }];
  assert.ok(extractTokenBalance(balances, SHRUB));
});

test('another token is not substituted for the wanted one', () => {
  const balances = [{ tokenAddress: '0x9999999999999999999999999999999999999999', amount: '7' }];
  assert.equal(extractTokenBalance(balances, SHRUB), null);
  assert.equal(extractTokenBalance(balances, null), null);
});

test('a human-readable amount is told from minimal units by the decimal point', () => {
  assert.equal(looksHumanAmount('16700.5'), true);
  assert.equal(looksHumanAmount('16700'), false);
  assert.equal(looksHumanAmount(16700), false);
});

test('a human-readable amount converts to minimal units exactly', () => {
  assert.equal(toMinimalUnits('1', 18), 10n ** 18n);
  assert.equal(toMinimalUnits('0.5', 18), 5n * 10n ** 17n);
  assert.equal(toMinimalUnits('1.234567', 6), 1_234_567n);
  // Extra digits beyond the decimals are dropped, not rounded up.
  assert.equal(toMinimalUnits('1.9999999', 6), 1_999_999n);
  assert.throws(() => toMinimalUnits('lots', 18), /not an amount/);
});

test('normalisation leaves minimal units alone', () => {
  assert.equal(normalizeBalance({ amount: '16700', decimals: 18 }).amount, 16700n);
  assert.equal(normalizeBalance({ amount: '1.5', decimals: 18 }).amount, 15n * 10n ** 17n);
  assert.equal(normalizeBalance(null), null);
});

// ------------------------------------------------------ the live schema

/** Shape of a /v2/users/{uuid}/balances answer. */
const liveBalances = {
  success: true,
  responseObject: {
    balances: [
      {
        balance: {
          tokenAddress: '0x2222222222222222222222222222222222222222',
          balance: '9448028000000000000',
          shiftedBalance: '9.448028',
          tokenId: '0x2222222222222222222222222222222222222222:4663',
        },
        userToken: { symbol: 'OTHER', decimals: 18 },
        valuation: { includeInEquity: false },
      },
      {
        balance: {
          tokenAddress: SHRUB,
          balance: '2286017492486559845471',
          shiftedBalance: '2286.01749248656',
          tokenId: `${SHRUB}:4663`,
        },
        userToken: { symbol: 'SHRUB', decimals: 18 },
        valuation: { includeInEquity: true },
      },
    ],
  },
};

test('a position is read by the exact path, not by a tree walk', () => {
  const found = extractTokenBalance(liveBalances, SHRUB);
  assert.equal(found.symbol, 'SHRUB');
  assert.equal(found.decimals, 18);
  assert.equal(found.includeInEquity, true);
  // Minimal units are taken, not the human-readable number.
  assert.equal(found.human, false);
  assert.equal(normalizeBalance(found).amount, 2286017492486559845471n);
});

test('the dust filter is read from valuation.includeInEquity', () => {
  const dust = extractTokenBalance(liveBalances, '0x2222222222222222222222222222222222222222');
  assert.equal(dust.includeInEquity, false);
});

// A round human-readable number has no decimal point and cannot be told from
// minimal units by it. The human flag must come from the parser.
test('a round shiftedBalance is not taken for minimal units', () => {
  const entry = { amount: '9', decimals: 18, human: true };
  assert.equal(normalizeBalance(entry).amount, 9n * 10n ** 18n);
  assert.equal(normalizeBalance({ amount: '9', decimals: 18, human: false }).amount, 9n);
});

test('the uuid comes from the request path, /user returns Not Found', () => {
  assert.equal(
    uuidFromPath('/v2/users/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/balances'),
    '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
  );
  assert.equal(uuidFromPath('/v2/users/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/swaps'), '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f');
  assert.equal(uuidFromPath('/swaps/v2'), null);
  assert.equal(uuidFromPath(null), null);
});

// Two wallets: a sell leaves from the EVM address, a buy from Solana, because
// the cash lives there.
test('both wallet addresses come from the balances', () => {
  const wallets = extractWallets({
    responseObject: {
      balances: [
        { balance: { address: '0x1111111111111111111111111111111111111111', tokenAddress: SHRUB } },
        { balance: { address: 'HbWAeaaFfUjrNdGVdyZnENXgXUvNaaYb1KCDp4waFUXj', tokenAddress: 'EPjF' } },
      ],
    },
  });
  assert.equal(wallets.evm, '0x1111111111111111111111111111111111111111');
  assert.equal(wallets.solana, 'HbWAeaaFfUjrNdGVdyZnENXgXUvNaaYb1KCDp4waFUXj');
});

test('the wallet address is not confused with the token address', () => {
  // tokenAddress is a 0x address too, but not a wallet.
  const wallets = extractWallets({
    balances: [{ balance: { tokenAddress: SHRUB } }],
  });
  assert.equal(wallets.evm, null);
});

test('missing data gives an empty answer, not an invention', () => {
  assert.deepEqual(extractWallets(null), { evm: null, solana: null });
  assert.deepEqual(extractWallets({ responseObject: {} }), { evm: null, solana: null });
});

// ------------------------------------------------ wallet address != token

test('a lookup by the wallet address finds no position', () => {
  // In a balance row `address` is the WALLET, not the token. Matching on it
  // once returned a position with decimals=18 instead of USDC's six.
  const WALLET = '0x1111111111111111111111111111111111111111';
  const USDC = '0x2222222222222222222222222222222222222222';
  const balances = {
    responseObject: {
      balances: [{
        balance: {
          address: WALLET, tokenAddress: USDC, tokenId: `${USDC}:8453`,
          balance: '12260000', shiftedBalance: '12.26', networkId: 8453, symbol: 'USDC',
        },
        userToken: { userAddress: WALLET, tokenAddress: USDC, decimals: 6, symbol: 'USDC' },
      }],
    },
  };
  assert.equal(extractTokenBalance(balances, WALLET), null);

  const byToken = extractTokenBalance(balances, USDC);
  assert.equal(byToken.decimals, 6, 'decimals come from the response, not from a default');
  assert.equal(byToken.amount, '12260000');
});

test('a human-readable amount without decimals is not converted silently', () => {
  assert.throws(
    () => normalizeBalance({ amount: '12.26', human: true, decimals: null }),
    /decimals/,
  );
});

test('token id from the page URL: chain slug and address', async () => {
  const { tokenIdFromLocation } = await import('../src/shared/balances.js');
  assert.equal(tokenIdFromLocation('https://fomo.family/tokens/robinhood/0xb7eaecc89d3e2f9fd597d61726ae824900db8360'), '0xb7eaecc89d3e2f9fd597d61726ae824900db8360:4663');
  assert.equal(tokenIdFromLocation('https://fomo.family/tokens/solana/9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump?x=1'), '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump:1399811149');
  assert.equal(tokenIdFromLocation('https://fomo.family/profile/x'), null);
});

test('decimals are inferred from the balance/shiftedBalance pair when FOMO gives none (Solana)', async () => {
  const { extractTokenBalance, inferDecimals } = await import('../src/shared/balances.js');
  assert.equal(inferDecimals('8717158', 8.717158), 6);
  assert.equal(inferDecimals('1233156352871154924849', 1233.156352871154924849), 18);
  assert.equal(inferDecimals('0', 0), null, 'a zero balance says nothing');
  assert.equal(inferDecimals('123', 1.5), null, 'not a power of ten, no guess');
  const mint = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';
  const found = extractTokenBalance({ responseObject: { balances: [{
    balance: { tokenAddress: mint, balance: '8717158', shiftedBalance: 8.717158, tokenId: `${mint}:1399811149` },
    userToken: { tokenAddress: mint, networkId: 1399811149 },
  }] } }, mint);
  assert.equal(found.decimals, 6);
  assert.equal(found.amount, '8717158');
});
