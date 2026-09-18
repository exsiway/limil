// The sell button next to the two buy buttons: a share of the holding, from
// the popup, sold at market through FOMO by the same path as a quick buy.
// The pure part is tested as such; the sell path is checked statically,
// the way the buy path is, because the buttons live in the page's DOM.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_QUICK_SELL_PERCENT, formatPercent, normalizeSellPercent } from '../src/shared/quick-buy.js';
import { PAGE_SETTINGS_FIELDS, PAGE_SETTINGS_KEYS } from '../src/background/senders.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buySrc = readFileSync(join(root, 'src/isolated/feed-buy.js'), 'utf8');
const popupSrc = readFileSync(join(root, 'src/popup/popup.js'), 'utf8');

test('the share: a number above 0 and up to 100, one decimal, else the default', () => {
  assert.equal(normalizeSellPercent(50), 50);
  assert.equal(normalizeSellPercent('25'), 25);
  assert.equal(normalizeSellPercent(' 33.33 % '), 33.3);
  assert.equal(normalizeSellPercent(100), 100);
  assert.equal(normalizeSellPercent(0), DEFAULT_QUICK_SELL_PERCENT);
  assert.equal(normalizeSellPercent(-5), DEFAULT_QUICK_SELL_PERCENT);
  assert.equal(normalizeSellPercent(101), DEFAULT_QUICK_SELL_PERCENT);
  assert.equal(normalizeSellPercent('all'), DEFAULT_QUICK_SELL_PERCENT);
  assert.equal(normalizeSellPercent(null), DEFAULT_QUICK_SELL_PERCENT);
  assert.equal(formatPercent(50), '50%');
  assert.equal(formatPercent(33.3), '33.3%');
});

test('the page may read the share but not write it', () => {
  assert.ok(PAGE_SETTINGS_FIELDS.includes('quickSellPercent'));
  assert.equal(PAGE_SETTINGS_KEYS.includes('quickSellPercent'), false);
});

test('a sell is a share of the holding, token to cash, signed and sent by the same path as a buy', () => {
  const sell = buySrc.slice(buySrc.indexOf('async function sell('), buySrc.indexOf('// ------------------------------------------------------------------ control'));
  assert.match(sell, /const amount = amountFromPercent\(held, pct\);/);
  assert.match(sell, /side: 'sell',\s*solanaAddress: wallets\.solana \?\? null,\s*chainId: chainFromTokenId\(tokenId\),\s*inTokenId: tokenId,\s*outTokenId: CASH_TOKEN_ID,\s*amount: amount\.toString\(\),/);
  assert.match(sell, /sign: true,\s*send: true,/);
  assert.match(sell, /if \(canSign && canSign\.ok === false\) throw new Error\(offlineText\(canSign\)\);/);
  assert.match(sell, /if \(held === null \|\| held <= 0n\) throw new Error/, 'nothing to sell is a refusal, not a zero-amount trade');
  // The chain is asked for a Solana holding only when FOMO's balances carry no decimals.
  assert.match(sell, /if \(held === null && isSolanaMint && wallets\.solana && callBackground\)/);
});

test('every card that names a token gets the three buttons, sell cards included, and the press dispatches by kind', () => {
  assert.match(buySrc, /const wanted = badge === 'Buy' \|\| badge === 'Sell' \|\| badge === 'Thesis';/);
  assert.match(buySrc, /\.\.\.state\.amounts\.map\(\(usd\) => \(\{ kind: 'buy', usd \}\)\),\s*\{ kind: 'sell', pct: state\.sellPercent \},/);
  assert.match(buySrc, /const run = m\.kind === 'sell' \? sell\(m\) : buy\(m\);/);
  assert.equal([...buySrc.matchAll(/meta\.set\(/g)].length, 1);
});

test('the popup saves the share with the amounts and tells the tab', () => {
  assert.match(popupSrc, /const quickSellPercent = normalizeSellPercent\(\$\('quickSellPercent'\)\.value\);/);
  assert.match(popupSrc, /settings: \{ quickBuyEnabled, quickBuyAmounts, quickSellPercent, quickBuyConfirm \}/);
  assert.match(popupSrc, /tab\('quick\.update', \{ quickBuyEnabled, quickBuyAmounts, quickSellPercent, quickBuyConfirm \}\)/);
});
