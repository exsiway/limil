// What a service said, turned into what it means.
//
// Errors reach a person as whatever the other side happened to send. A JSON
// body with a support link and a request id, a four-character bundler code, a
// marketplace's capacity notice. Each of these arrived in front of someone
// tonight exactly as written, and each time the one useful fact in it had to
// be dug out by hand.
//
// The rule the tests hold: recognised errors become a short sentence with the
// numbers kept and something to do; unrecognised ones pass through EXACTLY as
// they came, because a wrong guess is worse than raw text and a bug report
// needs the original.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { explain, explainFully } from '../src/shared/explain.js';

test('a trade under FOMO\'s floor says both numbers and what to do', () => {
  const raw = 'FOMO API 400: {"success":false,"message":"Swap value $1.65 is below minimum $2.00","responseObject":{"errorCode":"ERR_SWAP_BELOW_MINIMUM"}}';
  const out = explain(raw);
  assert.match(out, /1\.65/);
  assert.match(out, /2\.00/);
  assert.match(out, /raise the amount/i);
  assert.doesNotMatch(out, /responseObject|errorCode/, 'no JSON survives into the sentence');
});

test('the same error without numbers still says what to do', () => {
  assert.match(explain('ERR_SWAP_BELOW_MINIMUM'), /raise the amount/i);
});

test('AA24 names the missing connection, not the code', () => {
  const out = explain('bundler refused (-32507): UserOperation reverted with reason: AA24 signature error');
  assert.match(out, /not connected to the limil contract/i);
  assert.doesNotMatch(out, /AA24/);
});

test('AA25 says nothing was lost, because nothing was', () => {
  assert.match(explain('AA25 invalid account nonce'), /Nothing was lost/i);
});

test('their route failing is not the person failing', () => {
  const out = explain('FOMO API 422: Swap simulation reverted on-chain: dflow_close_authority_fee');
  assert.match(out, /could not build a route/i);
  assert.match(out, /Nothing is wrong on your side/i);
});

test('an unrecognised error is passed through exactly', () => {
  const odd = 'Constraint violation in shard 7 (0x8812): retry token expired';
  assert.equal(explain(odd), odd);
  const full = explainFully(odd);
  assert.equal(full.known, false);
  assert.equal(full.raw, odd);
});

test('the raw text is always kept for a bug report', () => {
  const raw = 'AA25 invalid account nonce';
  const full = explainFully(raw);
  assert.equal(full.known, true);
  assert.equal(full.raw, raw);
  assert.notEqual(full.text, raw);
});

test('nothing in, nothing out', () => {
  assert.equal(explain(''), '');
  assert.equal(explain(null), '');
  assert.equal(explain(undefined), '');
  assert.equal(explain(new Error('AA25 invalid account nonce')).length > 0, true);
});
