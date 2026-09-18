// A take profit and a stop loss over one holding: when one fills, what
// happens to the other.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ORDER_STATUS, SIDES, sellsLeftWithoutPosition } from '../src/shared/orders.js';

const TOKEN = '0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff:56';
const WALLET = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

const order = (over = {}) => ({
  id: 'ord_a', status: ORDER_STATUS.WATCHING, side: SIDES.SELL,
  inTokenId: TOKEN, sender: WALLET, amount: '1000', ...over,
});

test('the stop loss goes when the take profit took the whole position', () => {
  const filled = order({ id: 'tp', status: ORDER_STATUS.FILLED });
  const orders = [filled, order({ id: 'sl' })];
  assert.deepEqual(sellsLeftWithoutPosition(orders, { filled, remaining: 0n }), ['sl']);
});

test('a ladder the remaining position still covers is left alone', () => {
  const filled = order({ id: 'first', amount: '400', status: ORDER_STATUS.FILLED });
  const orders = [filled, order({ id: 'second', amount: '400' }), order({ id: 'third', amount: '900' })];
  // 600 left: the 400 still fits, the 900 does not.
  assert.deepEqual(sellsLeftWithoutPosition(orders, { filled, remaining: 600n }), ['third']);
});

test('an order for exactly what is left is covered', () => {
  const filled = order({ id: 'tp', status: ORDER_STATUS.FILLED });
  const orders = [filled, order({ id: 'sl', amount: '250' })];
  assert.deepEqual(sellsLeftWithoutPosition(orders, { filled, remaining: 250n }), []);
});

test('another token, another wallet and buys are none of its business', () => {
  const filled = order({ id: 'tp', status: ORDER_STATUS.FILLED });
  const orders = [
    filled,
    order({ id: 'other-token', inTokenId: '0xaaa:56' }),
    order({ id: 'other-wallet', sender: '0x1111111111111111111111111111111111111111' }),
    order({ id: 'a-buy', side: SIDES.BUY }),
    order({ id: 'already-closed', status: ORDER_STATUS.CANCELLED }),
  ];
  assert.deepEqual(sellsLeftWithoutPosition(orders, { filled, remaining: 0n }), []);
});

test('the same wallet in another case is the same wallet', () => {
  const filled = order({ id: 'tp', status: ORDER_STATUS.FILLED, sender: WALLET.toLowerCase() });
  const orders = [filled, order({ id: 'sl', sender: WALLET.toUpperCase() })];
  assert.deepEqual(sellsLeftWithoutPosition(orders, { filled, remaining: 0n }), ['sl']);
});

test('a filled BUY cancels nothing: a buy is not bounded by a holding', () => {
  const filled = order({ id: 'buy', side: SIDES.BUY, status: ORDER_STATUS.FILLED });
  const orders = [filled, order({ id: 'sl' })];
  assert.deepEqual(sellsLeftWithoutPosition(orders, { filled, remaining: 0n }), []);
});

test('an unreadable balance or amount closes nothing', () => {
  const filled = order({ id: 'tp', status: ORDER_STATUS.FILLED });
  assert.deepEqual(sellsLeftWithoutPosition([filled, order({ id: 'sl' })], { filled, remaining: null }), []);
  assert.deepEqual(sellsLeftWithoutPosition([filled, order({ id: 'sl', amount: 'oops' })], { filled, remaining: 0n }), []);
});
