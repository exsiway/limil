// Tests of the native execution path: the slippage tolerance decides whether
// a trade is signed, and the call order in executeBatch decides what runs.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ROUTES,
  apiError,
  buildSwapCalls,
  canExecuteRoute,
  describeRoute,
  checkSlippageScaled,
  parseDecimal,
  parseSwapQuote,
  shortfallBpsAgainstScaled,
  decimalString,
} from '../src/shared/swaps.js';
import { guardCalls } from '../src/shared/output-guard.js';

const TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const CURVE = '0x4bdc187487e24d099981ab648ad2761223e33fde';

/** Shape of a /swaps/v2 answer as observed in live traffic. */
const evmQuote = {
  responseObject: {
    v2Swap: {
      relaySwapId: 'rs_123',
      feeTierBps: 50,
      usdFees: { relay: 0.02, app: 0.05 },
      expectedOutHumanAmount: '1000.5',
      tradeInfo: { slippageBps: 732 },
      originChainId: 4663,
      destinationChainId: 4663,
      relayTransaction: {
        type: 'EVM',
        approvalTransaction: { to: TOKEN, data: '0x095ea7b3aaaa', value: '0', chainId: 4663 },
        depositTransaction: { to: CURVE, data: '0xf9e4bab4bbbb', value: '0', chainId: 4663 },
      },
    },
  },
};

// --------------------------------------------------------------- arithmetic

test('decimal strings parse without losing digits', () => {
  assert.equal(parseDecimal('1'), 10n ** 18n);
  assert.equal(parseDecimal('0.5'), 5n * 10n ** 17n);
  assert.equal(parseDecimal('1000.5'), 1000n * 10n ** 18n + 5n * 10n ** 17n);
  assert.throws(() => parseDecimal('not a number'), /not a decimal/);
  assert.throws(() => parseDecimal('-1'), /not a decimal/);
});

// The stored target is already an integer in QUOTE_SCALE; only the quote is
// a human-readable string.
const scaled = (human) => BigInt(human) * 10n ** 18n;

test('the shortfall is in basis points, a surplus is negative', () => {
  // Target 1000, offered 990 -> 1% worse
  assert.equal(shortfallBpsAgainstScaled('990', scaled(1000)), 100);
  assert.equal(shortfallBpsAgainstScaled('1000', scaled(1000)), 0);
  assert.ok(shortfallBpsAgainstScaled('1010', scaled(1000)) < 0);
  assert.throws(() => shortfallBpsAgainstScaled('1', 0n), /cannot be zero/);
});

// ---------------------------------------------------------- slippage check

test('a quote within the tolerance is signed', () => {
  const verdict = checkSlippageScaled({ expectedOut: '995', targetOutScaled: scaled(1000), maxSlippageBps: 100 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.shortfallBps, 50);
});

test('a quote worse than the tolerance is NOT signed', () => {
  const verdict = checkSlippageScaled({ expectedOut: '900', targetOutScaled: scaled(1000), maxSlippageBps: 100 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not signing/);
});

test('a wide relay slippage alone does not block a trade, only a shortfall does', () => {
  const verdict = checkSlippageScaled({
    expectedOut: '1001', targetOutScaled: scaled(1000), maxSlippageBps: 100, relaySlippageBps: 732,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.relaySlippageBps, 732);
});

test('a negative tolerance is a configuration error, not a silent refusal', () => {
  assert.throws(
    () => checkSlippageScaled({ expectedOut: '1', targetOutScaled: scaled(1), maxSlippageBps: -1 }),
    /non-negative/,
  );
});

// ---------------------------------------------------------- answer parsing

test('an EVM quote is parsed in full', () => {
  const quote = parseSwapQuote(evmQuote);
  assert.equal(quote.kind, 'EVM');
  assert.equal(quote.chainId, 4663);
  assert.equal(quote.relaySwapId, 'rs_123');
  assert.equal(quote.expectedOut, '1000.5');
  assert.equal(quote.slippageBps, 732);
  assert.equal(quote.deposit.to, CURVE);
});

test('a Solana quote is marked separately, there is no executeBatch there', () => {
  const quote = parseSwapQuote({
    v2Swap: {
      relaySwapId: 'rs_sol',
      expectedOutHumanAmount: '5',
      relayTransaction: {
        type: 'SOLANA', tx: 'base64…', feePayerSignature: 'sig', feePayerAddress: 'Agm…',
      },
    },
  });
  assert.equal(quote.kind, 'SOLANA');
  assert.equal(quote.feePayerAddress, 'Agm…');
  assert.throws(() => buildSwapCalls(quote), /does not apply to SOLANA/);
});

test('a quote without depositTransaction is refused', () => {
  assert.throws(
    () => parseSwapQuote({ v2Swap: { relayTransaction: { type: 'EVM' } } }),
    /no depositTransaction/,
  );
  assert.throws(() => parseSwapQuote({}), /no v2Swap/);
  assert.throws(() => parseSwapQuote({ v2Swap: {} }), /no v2Swap/);
});

// ----------------------------------------------------------- batch assembly

test('the batch repeats their calls byte for byte, otherwise the trade stops being a swap', () => {
  const calls = buildSwapCalls(parseSwapQuote(evmQuote));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].data, '0x095ea7b3aaaa');
  assert.equal(calls[1].data, '0xf9e4bab4bbbb');
  // The allowance the swap did not consume is set back to zero in the same
  // batch: approve(spender, 0) on the same token, the spender being the
  // router (deposit target when the approval calldata is not a full approve).
  assert.equal(calls[2].target, calls[0].target);
  assert.equal(calls[2].data, `0x095ea7b3${calls[1].target.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}`);
  assert.equal(calls[2].value, 0n);
});

test('the allowance reset names the spender the approval named', () => {
  const quote = parseSwapQuote(evmQuote);
  const spender = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
  quote.approval = { ...quote.approval, data: `0x095ea7b3${spender.slice(2).padStart(64, '0')}${(1234n).toString(16).padStart(64, '0')}` };
  const calls = buildSwapCalls(quote);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].data, `0x095ea7b3${spender.slice(2).padStart(64, '0')}${'0'.repeat(64)}`);
  // Opt-out for a caller that manages the allowance itself.
  assert.equal(buildSwapCalls(quote, null, { resetAllowance: false }).length, 2);
});

test('without approvalTransaction the batch is a single swap when the token is unknown', () => {
  const quote = parseSwapQuote(evmQuote);
  quote.approval = null;
  const calls = buildSwapCalls(quote);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data, '0xf9e4bab4bbbb');
});

test('a standing allowance is zeroed too, the case relay sends no approval for', () => {
  // Relay omits approvalTransaction exactly when an allowance already stands,
  // left by an earlier trade or by the FOMO app. That standing allowance is
  // what a leaked session key can spend through the router WITHOUT any
  // approve in its batch, and the contract charges no approve budget for a
  // batch that contains none. Resetting only after our own approve would leave
  // that case alone. So the reset is unconditional as
  // long as the caller says which token was traded.
  const quote = parseSwapQuote(evmQuote);
  quote.approval = null;
  const token = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const calls = buildSwapCalls(quote, null, { token });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].data, '0xf9e4bab4bbbb', 'the swap is still first');
  assert.equal(String(calls[1].target).toLowerCase(), token, 'normalizeAddress checksums it');
  // approve(<the swap target, i.e. the router>, 0)
  assert.equal(calls[1].data, `0x095ea7b3${String(quote.deposit.to).slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}`);
  assert.equal(calls[1].value, 0n);
  // And a caller that manages the allowance itself can still opt out.
  assert.equal(buildSwapCalls(quote, null, { token, resetAllowance: false }).length, 1);
});

test('the guard brackets the batch: snapshot first, check last', () => {
  const guard = guardCalls({ chainId: 4663, minGain: 95_000_000n });
  const calls = buildSwapCalls(parseSwapQuote(evmQuote), guard);
  assert.equal(calls.length, 5);
  assert.equal(calls[0], guard.before);
  assert.equal(calls[1].data, '0x095ea7b3aaaa');
  assert.equal(calls[2].data, '0xf9e4bab4bbbb');
  assert.match(calls[3].data, /^0x095ea7b3.{64}0{64}$/);
  assert.equal(calls[4], guard.after);
});

// -------------------------------------------- three routes from live traces

test('the EVM envelope is recognised as a route we execute', () => {
  const q = parseSwapQuote(evmQuote);
  assert.equal(q.route, ROUTES.EVM_USEROP);
  assert.equal(q.canExecute, true);
});

// A buy is Solana -> EVM: the cash lives on Solana. Same v2Swap envelope, but
// a different relayTransaction, and no executeBatch at all.
test('a buy (Solana -> EVM) is recognised and executable', () => {
  const q = parseSwapQuote({
    responseObject: {
      v2Swap: {
        relaySwapId: 'rs_buy',
        originChainId: 792703809,
        destinationChainId: 4663,
        expectedOutHumanAmount: '1462.727762580628',
        tradeInfo: { slippageBps: 1000 },
        relayTransaction: {
          type: 'SOLANA',
          tx: 'base64…',
          feePayerSignature: 'sig',
          feePayerAddress: 'Agm…',
        },
      },
    },
  });
  assert.equal(q.route, ROUTES.SOLANA_RELAY);
  assert.equal(q.canExecute, true);
  assert.equal(q.slippageBps, 1000);
  assert.throws(() => buildSwapCalls(q), /does not apply/);
});

// The third envelope has DIFFERENT names for almost every field.
test('the Solana-native v1Swap envelope is parsed with its own field names', () => {
  const q = parseSwapQuote({
    responseObject: {
      v1Swap: {
        swapTransaction: 'base64tx…',
        feePayerSignature: 'sig88',
        feePayerAddress: 'addr44',
        dynamicSlippageBps: 4500,
        expectedOutHumanAmount: 4.811858,
        priorityFeeLamports: 391784,
        lastValidBlockHeight: 421102960,
        flatFee: 0.1,
        feeTierBps: 0,
        platform: 'dflow',
      },
    },
  });
  assert.equal(q.route, ROUTES.SOLANA_DFLOW);
  assert.equal(q.canExecute, true);
  assert.equal(q.platform, 'dflow');
  // The tolerance is NOT in tradeInfo.
  assert.equal(q.slippageBps, 4500);
  assert.equal(q.lastValidBlockHeight, 421102960);
});

test('all three routes are executable', () => {
  assert.equal(canExecuteRoute(ROUTES.EVM_USEROP), true);
  assert.equal(canExecuteRoute(ROUTES.SOLANA_RELAY), true);
  assert.equal(canExecuteRoute(ROUTES.SOLANA_DFLOW), true);
  assert.match(describeRoute(ROUTES.SOLANA_RELAY), /signMessage/);
});

// ------------------------------------- fourth envelope: a business error

test('a business error of the API is recognised and carries their text', () => {
  const response = {
    success: false,
    message: 'Trade value is too small to cover the fees',
    responseObject: { errorCode: 'TRADE_TOO_SMALL' },
  };
  const error = apiError(response);
  assert.equal(error.code, 'TRADE_TOO_SMALL');
  assert.throws(() => parseSwapQuote(response), /too small|TRADE_TOO_SMALL/i);
  // An ordinary quote is not an error.
  assert.equal(apiError(evmQuote), null);
});

test('the minimum-size error explains what to do', () => {
  const error = apiError({
    success: false,
    message: 'Swap value $0.35 is below minimum $2.00',
    responseObject: {
      errorCode: 'ERR_SWAP_BELOW_MINIMUM',
      errorMsg: 'Swap value $0.35 is below minimum $2.00',
    },
    errorCode: 'ERR_SWAP_BELOW_MINIMUM',
  });
  assert.equal(error.code, 'ERR_SWAP_BELOW_MINIMUM');
  assert.match(error.message, /below minimum \$2\.00/);
  assert.match(error.message, /Increase the balance share/);
});

test('a top-level errorCode is recognised too', () => {
  assert.equal(apiError({ errorCode: 'ERR_X', message: 'bad' }).code, 'ERR_X');
});

// ---------------------------------------------- the quote arrives as a number

test('decimal notation of a number does not slip into exponent form', () => {
  assert.equal(decimalString(3.813872), '3.813872');
  assert.equal(decimalString(1e-8), '0.00000001');
  assert.equal(decimalString('12.5'), '12.5');
  assert.equal(parseDecimal(1e-8), 10n ** 10n);
  assert.equal(parseDecimal(3.5), 3500000000000000000n);
});

test('a sale without a bundler receipt is judged by the chain: the input balance moving, or not', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/main/swap-exec.js', import.meta.url), 'utf8');
  assert.match(src, /const isAddress = \(v\) => /, 'the helper the balance check uses exists in this module');
  assert.match(src, /balanceBefore = BigInt\(await callBackground\('rpc\.tokenBalance'/, 'the balance is read before the send');
  assert.match(src, /const moved = await balanceMoved\(/, 'and watched after a missing receipt');
  assert.match(src, /if \(now < before\) \{/, 'a decrease is the sale');
  const bundler = readFileSync(new URL('../src/main/bundler.js', import.meta.url), 'utf8');
  assert.match(bundler, /try \{\s*const receipt = await getReceipt\(\{ chainId, userOpHash \}\);\s*if \(receipt\) return receipt;\s*\} catch \(err\) \{/, 'one failed poll does not end the wait');
  const senders = readFileSync(new URL('../src/background/senders.js', import.meta.url), 'utf8');
  assert.match(senders, /'rpc\.tokenBalance',/);
});
