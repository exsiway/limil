// The server browser reports WHICH account it is signed in to.
//
// FOMO's swap endpoint takes no wallet argument: the account is whoever asks.
// So a browser on a server signed in to another account quotes for that other
// account and cannot execute one of the owner's orders, its Solana quotes
// revert on simulation, and its EVM operations would be built for the wrong
// wallet and refused by the verifier. Meanwhile the owner's popup said
// "Autonomous orders available", because the hub answered an HTTP request.
//
// The hub keeps what the runner reports so the owner's side can compare.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createHub } from '../daemon/hub.mjs';

function harness() {
  const state = {
    data: { orders: [], attempts: {}, samples: {}, runner: { key: '0xabc' }, version: 1 },
    save() {},
    note() {},
    sessionAccount: () => ({ address: '0x2222222222222222222222222222222222222222' }),
  };
  return { state, executor: createHub({ state, log: () => {} }) };
}

test('the reported wallet is kept, lower-cased', () => {
  const { state, executor } = harness();
  executor.applyRunnerReport({
    orders: [], journal: [], version: '0.2.0', build: 'b', watching: 0,
    wallet: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
  });
  assert.equal(state.data.runner.wallet, '0xabcdef0123456789abcdef0123456789abcdef01');
});

test('a browser that cannot say which account it is on reports null, not a guess', () => {
  // Silence is better than a guess here: the owner's side turns a mismatch
  // into a red lamp, and a wrong guess would either hide a real problem or
  // invent one.
  const { state, executor } = harness();
  executor.applyRunnerReport({ orders: [], journal: [], wallet: null });
  assert.equal(state.data.runner.wallet, null);
});

test('anything that is not an address is refused rather than stored', () => {
  const { state, executor } = harness();
  for (const junk of ['not-an-address', '0x123', 42, {}, '0xZZZZ007A93FB08C9F84DD36a439d3094d47c8209']) {
    executor.applyRunnerReport({ orders: [], journal: [], wallet: junk });
    assert.equal(state.data.runner.wallet, null, `stored ${JSON.stringify(junk)}`);
  }
});

test('a report without a journal does not touch what is remembered', () => {
  // Verdict-only reports arrive between journal ones; they must not blank the
  // account, or the lamp would flicker red for no reason.
  const { state, executor } = harness();
  executor.applyRunnerReport({ orders: [], journal: [], wallet: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' });
  executor.applyRunnerReport({ orders: [] });
  assert.equal(state.data.runner.wallet, '0xabcdef0123456789abcdef0123456789abcdef01');
});
