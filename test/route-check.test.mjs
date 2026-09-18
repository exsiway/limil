// Buy route check: Kyber answer parsing and the verdict over v4 hops.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isV4Hop, kyberRouteUrl, routeHops, routeSupported, routeVerdict } from '../src/shared/route-check.js';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const hop = (over = {}) => ({
  exchange: 'uniswap-v4', pool: '0xaaaa', tokenIn: USDG, tokenOut: PONS, amountIn: 100_000_000n, amountOut: 1000n, ...over,
});

test('a Kyber answer is parsed into a flat list of hops', () => {
  const parsed = routeHops({ data: { routeSummary: {
    amountOut: '1000', amountOutUsd: '99.9',
    route: [[{ exchange: 'uniswap-v4-fee', pool: '0xaaaa', tokenIn: USDG, tokenOut: PONS, swapAmount: '100000000', amountOut: '1000' }],
      [{ exchange: 'ekubo-v3', pool: '0xbbbb', tokenIn: USDG, tokenOut: PONS, swapAmount: '5', amountOut: '7' }]],
  } } });
  assert.equal(parsed.hops.length, 2);
  assert.equal(parsed.amountOut, 1000n);
  assert.equal(isV4Hop(parsed.hops[0]), true);
  assert.equal(isV4Hop(parsed.hops[1]), false);
  assert.throws(() => routeHops({ data: {} }), /no routeSummary/);
});

test('a v4 hop the quoter confirms passes', () => {
  const v = routeVerdict({ hops: [hop()], quotes: { '0xaaaa:100000000': { out: 999n } }, capBps: 500 });
  assert.equal(v.ok, true);
  assert.equal(v.worstShortfallBps, 10);
});

test('a v4 hop with a shortfall above the slippage blocks the route', () => {
  const v = routeVerdict({ hops: [hop()], quotes: { '0xaaaa:100000000': { out: 900n } }, capBps: 500 });
  assert.equal(v.ok, false);
  assert.equal(v.worstShortfallBps, 1000);
  assert.match(v.reason, /10\.00% less/);
});

test('a pool the quoter cannot simulate is untrusted, blocked', () => {
  const v = routeVerdict({ hops: [hop()], quotes: { '0xaaaa:100000000': { error: 'Execution reverted for an unknown reason.' } }, capBps: 1000 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not simulate in the quoter/);
  assert.match(routeVerdict({ hops: [hop()], quotes: {}, capBps: 1000 }).reason, /quoter not asked/);
});

test('non-v4 hops are not checked and do not interfere', () => {
  const v = routeVerdict({ hops: [hop({ exchange: 'ekubo-v3', pool: '0xbbbb' })], quotes: {}, capBps: 100 });
  assert.equal(v.ok, true);
});

test('chains and addresses', () => {
  assert.equal(routeSupported(4663), true);
  assert.equal(routeSupported(8453), true);
  assert.equal(routeSupported(56), false);
  assert.match(kyberRouteUrl({ chainId: 4663, tokenIn: USDG, tokenOut: PONS, amountIn: 5n }), /\/robinhood\/api\/v1\/routes\?tokenIn=/);
  assert.throws(() => kyberRouteUrl({ chainId: 56, tokenIn: USDG, tokenOut: PONS, amountIn: 5n }), /does not know chain/);
});

test('the swap direction is decided by both ends of the hop; native in the key equals the wrapper at Kyber', async () => {
  const { hopDirection, NATIVE, WRAPPED_NATIVE, KYBER_NATIVE } = await import('../src/shared/route-check.js');
  const key = { currency0: NATIVE, currency1: PONS };
  assert.deepEqual(hopDirection(key, { tokenIn: WRAPPED_NATIVE[4663], tokenOut: PONS }, 4663), { zeroForOne: true });
  assert.deepEqual(hopDirection(key, { tokenIn: PONS, tokenOut: KYBER_NATIVE }, 4663), { zeroForOne: false });
  assert.match(hopDirection(key, { tokenIn: USDG, tokenOut: PONS }, 4663).error, /does not match/);
  const plain = { currency0: PONS, currency1: USDG };
  assert.deepEqual(hopDirection(plain, { tokenIn: USDG, tokenOut: PONS }, 4663), { zeroForOne: false });
});

test('one pool twice in a route with different amounts is quoted separately', async () => {
  const { hopQuoteKey } = await import('../src/shared/route-check.js');
  const a = hop({ amountIn: 100n, amountOut: 1000n });
  const b = hop({ amountIn: 400n, amountOut: 3900n });
  assert.notEqual(hopQuoteKey(a), hopQuoteKey(b));
  const v = routeVerdict({ hops: [a, b], quotes: { [hopQuoteKey(a)]: { out: 1000n }, [hopQuoteKey(b)]: { out: 3880n } }, capBps: 500 });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.worstShortfallBps, 51);
});
