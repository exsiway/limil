// A reverted simulation is asked again, and only that.
//
// Their /swaps/v2 builds the route AND simulates it, and the simulation can
// revert on a leg unrelated to the trade being wrong, for example
// `dflow_close_authority_fee` on a Solana sell of half the balance while
// their own app sells the same token minutes later. An order that meets
// that route once must not sit unquoted until someone reads the journal.
// The body carries a `retry` counter, which is what it is for.
//
// What must NOT be retried is a real refusal, a throttle, an expired
// session, a wrong token. Those come back unchanged and at once, because
// asking again would only spend the rate limit that refused us.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { askQuote, retryableQuote } from '../src/main/fomo-bridge.js';

const revert = () => Object.assign(
  new Error('FOMO API 422: {"success":false,"message":"Swap simulation reverted on-chain: dflow_close_authority_fee: Error: {\\"InstructionError\\":[\\"2\\",{\\"Custom\\":\\"15020\\"}]}"}'),
  { status: 422 },
);
const throttled = () => Object.assign(new Error('FOMO API 429 (429, Cloudflare throttles frequent requests): slow down'), { status: 429 });
const body = { inTokenId: 'a:1', outTokenId: 'b:1', amount: '10', retry: 0 };

test('the reverted simulation is asked again, with the counter raised', async () => {
  const sent = [];
  const out = await askQuote(async (b) => {
    sent.push(b.retry);
    if (sent.length === 1) throw revert();
    return { quote: 'ok' };
  }, body, { waitMs: 0 });
  assert.deepEqual(out, { quote: 'ok' });
  assert.deepEqual(sent, [0, 1], 'the counter goes up, which is what it is for');
});

test('it gives up after two extra tries and reports what the route said', async () => {
  const sent = [];
  await assert.rejects(
    askQuote(async (b) => { sent.push(b.retry); throw revert(); }, body, { waitMs: 0 }),
    /dflow_close_authority_fee/,
  );
  assert.deepEqual(sent, [0, 1, 2], 'the first try plus two, and no more');
});

test('a throttle is not a route problem and is not retried', async () => {
  const sent = [];
  await assert.rejects(
    askQuote(async (b) => { sent.push(b.retry); throw throttled(); }, body, { waitMs: 0 }),
    /429/,
  );
  assert.deepEqual(sent, [0], 'asking again would only spend the limit that refused us');
});

test('a caller that already retried keeps counting from where it was', async () => {
  const sent = [];
  await askQuote(async (b) => {
    sent.push(b.retry);
    if (sent.length === 1) throw revert();
    return {};
  }, { ...body, retry: 5 }, { waitMs: 0 });
  assert.deepEqual(sent, [5, 6]);
});

test('what counts as retryable is the pair "422" and "simulation reverted"', () => {
  assert.equal(retryableQuote(revert()), true);
  assert.equal(retryableQuote(throttled()), false);
  assert.equal(retryableQuote(Object.assign(new Error('simulation reverted'), { status: 500 })), false,
    'the same words with another status are not the same thing');
  assert.equal(retryableQuote(Object.assign(new Error('no route'), { status: 422 })), false);
  assert.equal(retryableQuote(null), false);
});
