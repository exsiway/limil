// Price impact: relay quote parsing, the cap decision, waiting for the pool.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_MAX_IMPACT_BPS, impactVerdict, parseRelayImpact, relayQuoteBody,
} from '../src/shared/impact.js';
import { waitForImpact } from '../src/background/impact.js';
import { createOrder, validateOrder } from '../src/shared/orders.js';

/** A relay answer for a $400 sell of a thin token. */
const RELAY = {
  details: {
    currencyIn: { amountUsd: '402.745000' },
    currencyOut: { amount: '403625389', amountUsd: '403.625389' },
    totalImpact: { usd: '0.880389', percent: '0.22' },
    swapImpact: { usd: '1.906851', percent: '0.47' },
  },
};

test('a relay quote is parsed into basis points', () => {
  const r = parseRelayImpact(RELAY);
  assert.equal(r.swapBps, 47);
  assert.equal(r.totalBps, 22);
  assert.equal(r.out, '403625389');
  assert.throws(() => parseRelayImpact({ message: 'No routes' }), /No routes/);
  assert.throws(() => parseRelayImpact({ details: {} }), /swapImpact/);
  // A negative percent (relay signs the impact), same magnitude.
  assert.equal(parseRelayImpact({ details: { swapImpact: { percent: '-3.5' } } }).swapBps, 350);
});

test('the request body is a sell into USDC on Solana', () => {
  const b = relayQuoteBody({ sender: '0xabc', chainId: 4663, token: '0xtok', amount: 5n });
  assert.equal(b.originChainId, 4663);
  assert.equal(b.destinationChainId, 792703809);
  assert.equal(b.amount, '5');
  assert.equal(b.tradeType, 'EXACT_INPUT');
});

test('verdict: within the cap go, above it wait, without a cap always go', () => {
  assert.equal(impactVerdict(47, 500).ok, true);
  const no = impactVerdict(1200, 500);
  assert.equal(no.ok, false);
  assert.match(no.reason, /12\.00% is above the cap 5\.00%/);
  assert.equal(impactVerdict(9999, null).ok, true);
  assert.throws(() => impactVerdict(1, 'x'), /not a number/);
});

test('an order gets the default cap and validates it', () => {
  const base = { side: 'sell', inTokenId: '0x1:4663', outTokenId: 'cash', amount: '10', targetOut: '5' };
  assert.equal(createOrder(base).maxImpactBps, DEFAULT_MAX_IMPACT_BPS);
  assert.equal(createOrder({ ...base, maxImpactBps: null }).maxImpactBps, null);
  assert.match(validateOrder({ ...base, maxImpactBps: 20000 }).join(), /impact/);
});

test('waiting: the pool settles, go; not within the allowance, refuse', async () => {
  let t = 0;
  const readings = [1200, 900, 400];
  const measure = async () => ({ swapBps: readings.shift() ?? 400 });
  const res = await waitForImpact({
    capBps: 500, measure, sleep: async () => { t += 2000; }, now: () => t, maxWaitMs: 60_000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.impactBps, 400);
  assert.equal(res.waitedMs, 4000);

  t = 0;
  const stuck = await waitForImpact({
    capBps: 500, measure: async () => ({ swapBps: 1500 }), sleep: async () => { t += 2000; }, now: () => t, maxWaitMs: 10_000,
  });
  assert.equal(stuck.ok, false);
  assert.match(stuck.reason, /waiting/);
  assert.ok(stuck.waitedMs >= 8000);
});

test('relay silent twice, the trade is not held, but marked', async () => {
  let t = 0;
  const res = await waitForImpact({
    capBps: 500, measure: async () => { throw new Error('no network'); }, sleep: async () => { t += 2000; }, now: () => t,
  });
  assert.equal(res.ok, true);
  assert.equal(res.measured, false);
  assert.match(res.reason, /not measured/);
});

test('without a cap there is no waiting at all', async () => {
  const res = await waitForImpact({ capBps: null, measure: async () => { throw new Error('must not be called'); } });
  assert.equal(res.ok, true);
  assert.equal(res.measured, false);
});

test("someone else's impact: output below target by more than the tolerance, wait, back, go", async () => {
  const { poolVerdict, relayOutToScaled } = await import('../src/shared/impact.js');
  // Target 100 USDC in the 1e18 scale; relay returns USDC in 6 decimals.
  const target = 100n * 10n ** 18n;
  assert.equal(relayOutToScaled('100000000'), target);
  const bad = poolVerdict({ impactBps: 10, capBps: 500, outScaled: relayOutToScaled('50000000'), targetOutScaled: target, maxSlippageBps: 500 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /50\.00% below target/);
  assert.equal(poolVerdict({ impactBps: 10, capBps: 500, outScaled: relayOutToScaled('96000000'), targetOutScaled: target, maxSlippageBps: 500 }).ok, true);
  // Better than the target, always fine; without a tolerance, not checked.
  assert.equal(poolVerdict({ impactBps: 10, capBps: 500, outScaled: relayOutToScaled('150000000'), targetOutScaled: target, maxSlippageBps: 500 }).ok, true);
  assert.equal(poolVerdict({ impactBps: 10, capBps: 500, outScaled: relayOutToScaled('1'), targetOutScaled: target, maxSlippageBps: null }).ok, true);

  let t = 0;
  const outs = ['50000000', '70000000', '97000000'];
  const res = await waitForImpact({
    capBps: 500, targetOutScaled: target.toString(), maxSlippageBps: 500,
    measure: async () => ({ swapBps: 10, out: outs.shift() ?? '97000000' }),
    sleep: async () => { t += 2000; }, now: () => t,
  });
  assert.equal(res.ok, true);
  assert.equal(res.waitedMs, 4000, 'two spiked quotes were waited out');
});

test('10% by default for both the tolerance and the impact, one setting', () => {
  const order = createOrder({ side: 'sell', inTokenId: '0x1:4663', outTokenId: 'cash', amount: '10', targetOut: '5' });
  assert.equal(order.maxSlippageBps, 1000);
  assert.equal(order.maxImpactBps, 1000);
});

test('sensor for a buy: relay in reverse, Jupiter on Solana', async () => {
  const { relayQuoteBody, isSolanaToken, jupiterQuoteUrl, parseJupiterImpact, relayOutToScaled } = await import('../src/shared/impact.js');
  const b = relayQuoteBody({ sender: '0xabc', chainId: 4663, token: '0xtok', amount: 5n, side: 'buy', solanaAddress: '327Q' });
  assert.equal(b.originChainId, 792703809);
  assert.equal(b.destinationChainId, 4663);
  assert.equal(b.destinationCurrency, '0xtok');
  assert.equal(b.user, '327Q');
  assert.equal(b.recipient, '0xabc');
  assert.equal(isSolanaToken(1399811149), true);
  assert.equal(isSolanaToken(4663), false);
  assert.match(jupiterQuoteUrl({ inputMint: 'A', outputMint: 'B', amount: 7n }), /lite-api\.jup\.ag.*inputMint=A.*outputMint=B.*amount=7/);
  const j = parseJupiterImpact({ outAmount: '1005809564', priceImpactPct: '0.0198' });
  assert.equal(j.swapBps, 198);
  assert.equal(j.out, '1005809564');
  assert.throws(() => parseJupiterImpact({ error: 'no route' }), /no route/);
  // Output in a 9-decimal token into the 1e18 scale.
  assert.equal(relayOutToScaled('1000', 9), 1000n * 10n ** 9n);
});

test('the sensor output scale follows the FOMO quote, not the recorded decimals', async () => {
  const { scaleOutByReference } = await import('../src/shared/impact.js');
  // A 6-decimal token: Jupiter returned 3 324 053 619 (3324 tokens), FOMO 3324e18.
  const ref = 3324053619000000000000n;
  assert.equal(scaleOutByReference('3324053619', ref), ref);
  // An 18-decimal token: the output is already in the 1e18 scale, factor 1.
  assert.equal(scaleOutByReference('569558944668811242196', 569558944668811242196n), 569558944668811242196n);
  // USDC on a sell: 6 decimals.
  assert.equal(scaleOutByReference('403625389', 403n * 10n ** 18n), 403625389n * 10n ** 12n);
  assert.equal(scaleOutByReference('0', ref), null);
  assert.equal(scaleOutByReference('5', null), null);

  let t = 0;
  const res = await waitForImpact({
    capBps: 1000, maxSlippageBps: 1000, side: 'buy', outDecimals: 18,
    targetOutScaled: (3300n * 10n ** 18n).toString(), referenceOutScaled: ref.toString(),
    measure: async () => ({ swapBps: 68, out: '3324053619' }),
    sleep: async () => { t += 2000; }, now: () => t,
  });
  assert.equal(res.ok, true, 'with a reference the output reads right and the trade goes');
});
