// Limit order model tests.
//
// A UserOp is later assembled and signed from these numbers, so percentages of
// amounts are computed in integers. Checked here: rounding does not move the
// target, and an invalid order never lives to see a signature.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  TRIGGER,
  triggerOf,
  DEFAULT_MAX_SLIPPAGE_BPS,
  ORDER_STATUS,
  SIDES,
  amountFromPercent,
  bpsToPercent,
  createOrder,
  describeOrder,
  formatCompact,
  formatMarketCap,
  formatSlippage,
  isTriggered,
  orderSymbol,
  orderTokenAddress,
  ordersToRetire,
  percentToBps,
  targetMarketCap,
  targetOutFromPercent,
  tickerLabel,
  validateOrder,
} from '../src/shared/orders.js';

const ONE = 10n ** 18n;

test('a share of the balance goes through basis points and loses no digits', () => {
  assert.equal(amountFromPercent(1000n * ONE, 100), 1000n * ONE);
  assert.equal(amountFromPercent(1000n * ONE, 50), 500n * ONE);
  assert.equal(amountFromPercent(1000n * ONE, 33.3), 333n * ONE);
  assert.throws(() => amountFromPercent(1000n, 0), /within/);
  assert.throws(() => amountFromPercent(1000n, 101), /within/);
  assert.throws(() => amountFromPercent(0n, 50), /balance is empty/);
});

test('the target from a percent against market, up and down', () => {
  // Sell 60% above market.
  assert.equal(targetOutFromPercent(100n * ONE, 60), 160n * ONE);
  assert.equal(targetOutFromPercent(100n * ONE, 0), 100n * ONE);
  // Stop-loss: willing to take 30% less.
  assert.equal(targetOutFromPercent(100n * ONE, -30), 70n * ONE);
  assert.throws(() => targetOutFromPercent(100n, -100), /makes no sense/);
  assert.throws(() => targetOutFromPercent(0n, 10), /quote is empty/);
});

test('the compact format matches what the FOMO panel draws', () => {
  assert.equal(formatCompact(279815.8154359413842091), '279.8K');
  assert.equal(formatCompact(4840), '4.8K');
  assert.equal(formatCompact(2_500_000), '2.5M');
  assert.equal(formatCompact(1_200_000_000), '1.2B');
  // A bigint in minimal units is scaled by decimals.
  assert.equal(formatCompact(279815n * ONE, 18), '279.8K');
});

test('the order caption reads like a sentence', () => {
  assert.equal(
    describeOrder({ side: SIDES.SELL, amount: 279815n * ONE, decimals: 18, symbol: 'SHRUB', percent: 60 }),
    'Sell 279.8K $SHRUB 60% above market',
  );
  assert.match(
    describeOrder({ side: SIDES.SELL, amount: ONE, symbol: 'X', percent: -20 }),
    /20% below market/,
  );
  assert.match(
    describeOrder({ side: SIDES.BUY, amount: ONE, symbol: 'X', percent: 0 }),
    /Buy .* at the current market/,
  );
});

// Tolerance: bps do not belong in the interface, the user thinks in percent.
test('percent converts to basis points and back', () => {
  assert.equal(percentToBps(1), 100);
  assert.equal(percentToBps('0.5'), 50);
  assert.equal(percentToBps(7.32), 732);
  assert.equal(bpsToPercent(732), 7.32);
  assert.equal(bpsToPercent(100), 1);
  // An empty field means "not set", not zero: zero would mean zero tolerance.
  assert.equal(percentToBps(''), null);
  assert.equal(percentToBps(null), null);
  assert.equal(bpsToPercent(null), null);
  assert.throws(() => percentToBps(-1), /negative/);
  assert.throws(() => percentToBps(101), /makes no sense/);
});

test('the slippage caption tells "not set" from zero', () => {
  assert.equal(formatSlippage(null), 'not set');
  assert.equal(formatSlippage(undefined), 'not set');
  assert.equal(formatSlippage(0), '0%');
  assert.equal(formatSlippage(100), '1%');
  assert.equal(formatSlippage(732), '7.32%');
});

test('an order without its own tolerance is legal: there is simply no bound', () => {
  const order = createOrder({
    side: SIDES.SELL,
    inTokenId: '0xaaa:4663',
    outTokenId: '0xbbb:4663',
    amount: 100n,
    targetOut: 200n,
    maxSlippageBps: null,
  });
  assert.equal(order.maxSlippageBps, null);
  assert.deepEqual(validateOrder(order), []);
});

test('an invalid order does not live to see a signature', () => {
  const base = {
    side: SIDES.SELL,
    inTokenId: '0xaaa:4663',
    outTokenId: '0xbbb:4663',
    amount: '100',
    targetOut: '200',
    maxSlippageBps: 100,
  };
  assert.deepEqual(validateOrder(base), []);
  assert.match(validateOrder({ ...base, amount: '0' }).join(), /above zero/);
  assert.match(validateOrder({ ...base, side: 'sideways' }).join(), /side/);
  assert.match(validateOrder({ ...base, outTokenId: base.inTokenId }).join(), /the same/);
  assert.match(validateOrder({ ...base, maxSlippageBps: -1 }).join(), /slippage/);
  assert.match(validateOrder({ ...base, amount: 'lots' }).join(), /does not parse/);
});

test('a created order gets an id, a status and the default tolerance', () => {
  const order = createOrder({
    side: SIDES.SELL,
    inTokenId: '0xaaa:4663',
    outTokenId: '0xbbb:4663',
    amount: 100n,
    targetOut: 200n,
    percent: 60,
  });
  assert.match(order.id, /^ord_/);
  assert.equal(order.status, ORDER_STATUS.WATCHING);
  assert.equal(order.maxSlippageBps, DEFAULT_MAX_SLIPPAGE_BPS);
  assert.throws(() => createOrder({ side: SIDES.SELL }), /tokens not set/);
});

test('the trigger fires when the offer is not below the target', () => {
  const order = { targetOut: '200' };
  assert.equal(isTriggered(order, '199'), false);
  assert.equal(isTriggered(order, '200'), true);
  assert.equal(isTriggered(order, '201'), true);
});

test('small numbers are readable and zero is zero', () => {
  // In the panel this is the balance caption: "0" reads as absence, "0.00"
  // as a very small number.
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(0n, 18), '0');
  assert.equal(formatCompact(0.5), '0.5');
  assert.equal(formatCompact(0.1234), '0.1234');
  // Exponent notation has no place in the interface: "1.23e-11" tells the
  // user nothing. Below the visible threshold it is honest to call it dust.
  assert.equal(formatCompact('12300000', 18), '< 0.001');
  // The same remainder with the CORRECT six decimals is $12.30, not dust.
  assert.equal(formatCompact('12300000', 6), '12.30');
});

// A stored order keeps its amount as a STRING of integer minimal units. The
// division by decimals applies to it the same way as to a bigint, or the
// active order list prints "23264867362.4B" instead of "23.26".
test('a string of minimal units divides by decimals the same way a bigint does', () => {
  assert.equal(formatCompact('23264867362400000000', 18), formatCompact(23264867362400000000n, 18));
  assert.equal(formatCompact('23264867362400000000', 18), '23.26');
  assert.equal(formatCompact('13400000000000000000000', 18), '13.4K');
  assert.equal(formatCompact('2000000000000000000000000', 18), '2M');
  // Human numbers without decimals still pass as they are.
  assert.equal(formatCompact('4840'), '4.8K');
});

// The order list is shared across tokens, so the line must name the token.
// Without a ticker the captions of different orders were word-for-word equal.
test('the order caption tells tokens apart even without a ticker', () => {
  const a = describeOrder({ side: SIDES.SELL, amount: '23260000000000000000', decimals: 18, symbol: '0x0bd7…ad73', percent: -3 });
  const b = describeOrder({ side: SIDES.SELL, amount: '23260000000000000000', decimals: 18, symbol: '0xb200…6f01', percent: -3 });
  assert.notEqual(a, b);
  assert.match(a, /0x0bd7…ad73/);
});

// Market cap is more informative than a percent: the level does not depend on
// when you look at it, while "18% above market" means another price an hour
// later.
test('the target cap is the current cap scaled by the same share', () => {
  assert.equal(targetMarketCap(2_000_000, 38), 2_760_000);
  assert.equal(targetMarketCap(1_000_000, -30), 700_000);
  assert.equal(targetMarketCap(0, 10), null);
  assert.equal(targetMarketCap(1_000_000, NaN), null);
});

test('the cap is written the way traders write it, without trailing zeros', () => {
  assert.equal(formatMarketCap(4_740_000), '$4.74M');
  assert.equal(formatMarketCap(500_000), '$500k');
  assert.equal(formatMarketCap(1_250_000_000), '$1.25B');
  assert.equal(formatMarketCap(125_700_000), '$125.7M');
  assert.equal(formatMarketCap(850), '$850');
  assert.equal(formatMarketCap(0), null);
});

test('the order caption names the level, not the offset', () => {
  const order = {
    side: SIDES.SELL, amount: '2000000000000000000000', decimals: 18,
    symbol: 'BEAR', percent: 38, targetMarketCapUsd: 2_760_000,
  };
  assert.equal(describeOrder(order), 'Sell 2K $BEAR at $2.76M MC');
  // No cap: fall back to the percent rather than stay silent.
  assert.match(describeOrder({ ...order, targetMarketCapUsd: null }), /38% above market/);
});

test('a shortened address gets no dollar sign, it is not a ticker', () => {
  assert.equal(tickerLabel('BEAR'), '$BEAR');
  assert.equal(tickerLabel('0x0bd7…ad73'), '0x0bd7…ad73');
  assert.equal(tickerLabel(''), '');
});

// Automatic order cleanup. The danger is one-sided: leaving a stale order is
// a small nuisance, deleting a live one by mistake loses the user's work. So
// "unknown" is never read as zero.
test('an order is retired only when the position is EXACTLY zero', () => {
  const sell = {
    id: 'a', status: ORDER_STATUS.WATCHING, side: SIDES.SELL,
    tokenAddress: '0xaaa',
  };
  assert.deepEqual(ordersToRetire([sell], () => 0n).map((r) => r.id), ['a']);
  assert.deepEqual(ordersToRetire([sell], () => 100n), []);
  // Unknown is no reason to delete.
  assert.deepEqual(ordersToRetire([sell], () => null), []);
  assert.deepEqual(ordersToRetire([sell], () => undefined), []);
  // Neither is a lookup failure.
  assert.deepEqual(ordersToRetire([sell], () => { throw new Error('no data'); }), []);
});

test('an empty token balance does not cancel a buy', () => {
  const buy = {
    id: 'b', status: ORDER_STATUS.WATCHING, side: SIDES.BUY, tokenAddress: '0xaaa',
  };
  assert.deepEqual(ordersToRetire([buy], () => 0n), []);
});

test('already cancelled orders and orders without an address are left alone', () => {
  assert.deepEqual(ordersToRetire([
    { id: 'c', status: ORDER_STATUS.CANCELLED, side: SIDES.SELL, tokenAddress: '0xaaa' },
    { id: 'd', status: ORDER_STATUS.WATCHING, side: SIDES.SELL, tokenAddress: null },
  ], () => 0n), []);
});

// Orders stored before the address field existed must still name their token:
// the address lives in inTokenId, which is where it is taken from.
test('an old order recovers its address from inTokenId', () => {
  const old = { side: SIDES.SELL, inTokenId: `${'0x' + 'ab'.repeat(20)}:4663` };
  assert.equal(orderTokenAddress(old), '0x' + 'ab'.repeat(20));
  // No symbol stored: the shortened address stands in.
  assert.equal(orderSymbol(old), '0xabab…abab');
  assert.equal(orderSymbol({ symbol: 'BEAR' }), 'BEAR');
  assert.equal(orderTokenAddress({ inTokenId: 'garbage' }), null);
});

test('a buy takes its address from the output token, not the input', () => {
  const buy = { side: SIDES.BUY, inTokenId: 'CASH:1399811149', outTokenId: `${'0x' + 'cd'.repeat(20)}:4663` };
  assert.equal(orderTokenAddress(buy), '0x' + 'cd'.repeat(20));
});

test('cleanup sees old orders without the address field too', () => {
  const old = {
    id: 'legacy', status: ORDER_STATUS.WATCHING, side: SIDES.SELL,
    inTokenId: `${'0x' + 'ab'.repeat(20)}:4663`,
  };
  assert.deepEqual(ordersToRetire([old], () => 0n).map((r) => r.id), ['legacy']);
});

// ---------------------------------------------------- trigger direction

test('a negative percent makes the order a stop-loss at placement', () => {
  const stop = createOrder({
    side: SIDES.SELL, inTokenId: 'a:1', outTokenId: 'b:1',
    amount: '1000', targetOut: '980', percent: -2,
  });
  assert.equal(stop.triggerWhen, TRIGGER.BELOW);

  const take = createOrder({
    side: SIDES.SELL, inTokenId: 'a:1', outTokenId: 'b:1',
    amount: '1000', targetOut: '1020', percent: 2,
  });
  assert.equal(take.triggerWhen, TRIGGER.ABOVE);
});

test('an old order without the field is read by the sign of the percent', () => {
  assert.equal(triggerOf({ percent: -5 }), TRIGGER.BELOW);
  assert.equal(triggerOf({ percent: 5 }), TRIGGER.ABOVE);
  // Neither field nor percent: the old behaviour, take-profit.
  assert.equal(triggerOf({}), TRIGGER.ABOVE);
});

test('isTriggered compares in the right direction', () => {
  const stop = { targetOut: '980', triggerWhen: TRIGGER.BELOW };
  assert.equal(isTriggered(stop, '1000'), false, 'price above target, the stop did not fire');
  assert.equal(isTriggered(stop, '980'), true);
  assert.equal(isTriggered(stop, '900'), true);

  const take = { targetOut: '1020', triggerWhen: TRIGGER.ABOVE };
  assert.equal(isTriggered(take, '1000'), false);
  assert.equal(isTriggered(take, '1020'), true);
});

test('a stop-loss is named as one rather than looking like a take-profit', () => {
  const line = describeOrder({
    side: SIDES.SELL, amount: '1000000000000000000', decimals: 18,
    symbol: 'X', percent: -2, targetMarketCapUsd: 2580000,
  });
  assert.match(line, /stop-loss/);
});

// ----------------------- retiring by balance: unknown does not mean zero

const sellOrder = () => ({
  id: 'o1',
  status: 'watching',
  side: SIDES.SELL,
  inTokenId: '0x1111111111111111111111111111111111111111:4663',
});

test('a token missing from the answer does NOT retire the order', () => {
  // With the opposite behaviour orders fell in batches as soon as the user
  // left the token page: the balances held something else, and the lookup
  // returned zero instead of "unknown".
  assert.deepEqual(ordersToRetire([sellOrder()], () => null), []);
  assert.deepEqual(ordersToRetire([sellOrder()], () => undefined), []);
});

test('an explicit zero remainder retires the order', () => {
  const retire = ordersToRetire([sellOrder()], () => 0n);
  assert.equal(retire.length, 1);
  assert.match(retire[0].reason, /token sold/);
});

test('a non-zero remainder keeps the order', () => {
  assert.deepEqual(ordersToRetire([sellOrder()], () => 5n), []);
});

test('an empty token balance does not cancel a buy order', () => {
  const buy = { ...sellOrder(), side: SIDES.BUY };
  assert.deepEqual(ordersToRetire([buy], () => 0n), []);
});

test('a buy target: price down means more tokens, the trigger sign is flipped', async () => {
  const { targetOutFromPercent, triggerFor, TRIGGER, SIDES, createOrder } = await import('../src/shared/orders.js');
  const market = 1000n;
  assert.equal(targetOutFromPercent(market, -20, SIDES.BUY), 1250n, 'price −20% → 25% more tokens for the same cash');
  assert.equal(targetOutFromPercent(market, 25, SIDES.BUY), 800n);
  assert.equal(targetOutFromPercent(market, -20, SIDES.SELL), 800n, 'a sell as before');
  assert.equal(triggerFor(SIDES.BUY, -20), TRIGGER.ABOVE);
  assert.equal(triggerFor(SIDES.BUY, 10), TRIGGER.BELOW);
  assert.equal(triggerFor(SIDES.SELL, -20), TRIGGER.BELOW);
  const o = createOrder({ side: 'buy', inTokenId: 'EPjF:1399811149', outTokenId: '0x1:4663', amount: '5000000', targetOut: '1250', percent: -20, solanaAddress: '327Q' });
  assert.equal(o.triggerWhen, TRIGGER.ABOVE);
  assert.equal(o.solanaAddress, '327Q');
});

test('a buy is captioned in tokens once the target is known, and in cash before a quote', () => {
  const withTarget = describeOrder({
    side: SIDES.BUY, amount: '2390000', symbol: 'CAT', percent: -1, targetMarketCapUsd: 798_430,
    targetOut: (224_000n * 10n ** 18n).toString(),
  });
  assert.equal(withTarget, 'Buy 224K $CAT at $798.43k MC');
  const before = describeOrder({ side: SIDES.BUY, amount: '2390000', symbol: 'CAT', percent: -1, targetMarketCapUsd: 798_430 });
  assert.equal(before, 'Buy for 2.39 USDC $CAT at $798.43k MC');
});
