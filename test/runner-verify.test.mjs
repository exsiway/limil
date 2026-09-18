// Verification of an operation before the session key signs it.
//
// Foreign code runs in the MAIN world, so the runner must not sign any hash
// that arrives over the bus. This is the second line of defence: only what
// matches the order is signed. The contract remains the last word; these
// checks catch a forgery before a signature exists at all.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData } from 'viem';

import { TICKET_TTL_MS, ticketValid, verifyOperation } from '../src/shared/runner-verify.js';
import { GUARD_ADDRESS, GUARD_CASH, RELAY_DEPOSITORY, guardCalls } from '../src/shared/output-guard.js';
import { ACCOUNT_ABI, encodeExecuteBatch } from '../src/shared/userop.js';

const SENDER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROUTER = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const COLLECTOR = '0xc011ec700000000000000000000000000000c0fe';
const STRANGER = '0x3333333333333333333333333333333333333333';
const ENTRY_POINT = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';

// The order amount is mandatory: the approve cap is checked against it.
const order = (over = {}) => ({
  id: 'o1', sender: SENDER, inTokenId: `${TOKEN}:4663`, status: 'watching',
  amount: '10000', ...over,
});

const erc20 = (name, args) => encodeFunctionData({
  abi: [{
    type: 'function',
    name,
    stateMutability: 'nonpayable',
    inputs: name === 'transfer' || name === 'approve'
      ? [{ name: 'a', type: 'address' }, { name: 'b', type: 'uint256' }]
      : [],
    outputs: [],
  }],
  functionName: name,
  args,
});

// The router's own arguments, as it reads them: `transferAndMulticall` takes
// `tokens`/`amounts` out of the wallet with `transferFrom`, so this is the
// trade size no matter what allowance stands.
const SWAP_HEAD = [
  { type: 'address[]' },
  { type: 'uint256[]' },
  { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'bytes' }] },
  { type: 'address' },
  { type: 'address' },
  { type: 'bytes' },
];
const swapOf = (sales, to = SENDER) => `0xf9e4bab4${encodeAbiParameters(
  SWAP_HEAD,
  [sales.map((x) => x.token), sales.map((x) => x.amount), [], to, to, '0x'],
).slice(2)}`;
const SWAP = swapOf([{ token: TOKEN, amount: 10000n }]);

/** An ordinary batch: approve of the token to the router and the swap. */
const goodCalls = () => [
  { target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, 1000n]) },
  { target: ROUTER, value: 0n, data: SWAP },
];

const opWith = (calls, over = {}) => ({
  sender: SENDER,
  callData: encodeExecuteBatch(calls),
  ...over,
});

const check = (calls, over = {}, ord = order()) =>
  verifyOperation({ userOp: opWith(calls, over), order: ord });

// ------------------------------------------------------------ trade size

test('an approve above the order amount is refused', () => {
  const calls = goodCalls();
  calls[0] = { target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, 10001n]) };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /approve is larger than the trade/);
});

test('an approve of exactly the order amount passes', () => {
  const calls = goodCalls();
  calls[0] = { target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, 10000n]) };
  assert.equal(check(calls).ok, true);
});

test('a swap larger than the order is refused, whatever the approve says', () => {
  // Measuring only the approve is not enough: an allowance of exactly the
  // order amount can stand in the batch while the swap moves twice as much,
  // and a standing allowance from an earlier round needs no approve at all,
  // so the batch can carry none. On chain the grant's per-token cap is the
  // LARGEST live order of that token, so with a small and a large order open
  // at once the small order's ticket could sign the large order's size.
  const calls = goodCalls();
  calls[0] = { target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, 10000n]) };
  calls[1] = { target: ROUTER, value: 0n, data: swapOf([{ token: TOKEN, amount: 20000n }]) };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /above the order amount/);
});

test('a swap of exactly the order amount passes, and one below it too', () => {
  const exact = goodCalls();
  exact[1] = { target: ROUTER, value: 0n, data: swapOf([{ token: TOKEN, amount: 10000n }]) };
  assert.equal(check(exact).ok, true);
  // A quote may round down; selling less than asked is not a theft.
  const less = goodCalls();
  less[1] = { target: ROUTER, value: 0n, data: swapOf([{ token: TOKEN, amount: 9999n }]) };
  assert.equal(check(less).ok, true);
});

test('a swap with no approve at all is still measured', () => {
  // The allowance the router already holds is not in this batch, so an
  // approve is no part of the proof of size.
  const r = check([{ target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, 0n]) },
    { target: ROUTER, value: 0n, data: swapOf([{ token: TOKEN, amount: 20000n }]) }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /above the order amount/);
});

test('a swap selling a token that is not the order input is refused', () => {
  const calls = goodCalls();
  calls[1] = { target: ROUTER, value: 0n, data: swapOf([{ token: STRANGER, amount: 10000n }]) };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /the order is for/);
});

test('a swap carrying a second token alongside the order one is refused', () => {
  const calls = goodCalls();
  calls[1] = {
    target: ROUTER,
    value: 0n,
    data: swapOf([{ token: TOKEN, amount: 10000n }, { token: STRANGER, amount: 1n }]),
  };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /an order has one input/);
});

test('two swap calls in one batch are refused', () => {
  const half = swapOf([{ token: TOKEN, amount: 5000n }]);
  const r = check([
    { target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, 10000n]) },
    { target: ROUTER, value: 0n, data: half },
    { target: ROUTER, value: 0n, data: half },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /an order is sold once/);
});

test('a batch with no swap call at all is refused', () => {
  // The token is touched, so the old "input token is in the batch" check is
  // satisfied, and nothing in the batch is the trade.
  const r = check([{ target: TOKEN, value: 0n, data: `0x70a08231${SENDER.slice(2).padStart(64, '0')}` }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no swap call/);
});

test('calldata that does not decode as the router\'s function is refused', () => {
  const calls = goodCalls();
  calls[1] = { target: ROUTER, value: 0n, data: `0xf9e4bab4${'11'.repeat(64)}` };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not decode/);
});

test('another function on the router is refused', () => {
  const calls = goodCalls();
  calls[1] = { target: ROUTER, value: 0n, data: `0xdeadbeef${'00'.repeat(64)}` };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /with selector 0xdeadbeef/);
});

test('increaseAllowance is refused outright, as in the contract', () => {
  const inc = (spender, value) => `0x39509351${spender.slice(2).padStart(64, '0')}`
    + value.toString(16).padStart(64, '0');
  for (const value of [10001n, 500n]) {
    const calls = goodCalls();
    calls[0] = { target: TOKEN, value: 0n, data: inc(ROUTER, value) };
    const r = check(calls);
    assert.equal(r.ok, false);
    assert.match(r.reason, /banned selector/);
  }
});

test('increaseAllowance to an unknown spender is refused', () => {
  const inc = (spender) => `0x39509351${spender.slice(2).padStart(64, '0')}${'0'.repeat(64)}`;
  const calls = goodCalls();
  calls[0] = { target: TOKEN, value: 0n, data: inc(STRANGER) };
  assert.equal(check(calls).ok, false);
});

test('an approve of uint256 max is refused', () => {
  const max = (1n << 256n) - 1n;
  const calls = goodCalls();
  calls[0] = { target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, max]) };
  assert.equal(check(calls).ok, false);
});

test('any token transfer in the batch is refused', () => {
  const calls = [...goodCalls(), { target: TOKEN, value: 0n, data: erc20('transfer', [COLLECTOR, 1n]) }];
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /contains no transfers/);
});

test('an order without an amount is not signed', () => {
  const r = check(goodCalls(), {}, order({ amount: undefined }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /order amount/);
});

// ------------------------------------------------------------------ normal

test('an ordinary sell batch passes', () => {
  const r = check(goodCalls());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.calls, 2);
});

// ------------------------------------------------------- foreign and wrong

test('an operation for another wallet is refused', () => {
  const r = check(goodCalls(), { sender: STRANGER });
  assert.equal(r.ok, false);
  assert.match(r.reason, /another wallet/);
});

test('a call into the account itself is refused', () => {
  // That is how the parser would be bypassed by nesting.
  const r = check([{ target: SENDER, value: 0n, data: SWAP }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /the account itself/);
});

test('a call into the EntryPoint is refused', () => {
  const r = check([{ target: ENTRY_POINT, value: 0n, data: SWAP }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /EntryPoint/);
});

test('anything but executeBatch is not signed', () => {
  const callData = encodeFunctionData({
    abi: ACCOUNT_ABI, functionName: 'execute', args: [ROUTER, 0n, SWAP],
  });
  const r = verifyOperation({
    userOp: { sender: SENDER, callData }, order: order(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /calls execute, not executeBatch/);
});

test('undecodable callData is not signed', () => {
  const r = verifyOperation({
    userOp: { sender: SENDER, callData: `0xdeadbeef${'ff'.repeat(64)}` },
    order: order(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not decode/);
});

test('a transfer to a stranger is refused', () => {
  const calls = [...goodCalls(), { target: TOKEN, value: 0n, data: erc20('transfer', [STRANGER, 9n]) }];
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /contains no transfers/);
});

// ------------------------------------------------------------------ approve

test('an approve to an unknown spender is refused', () => {
  // The classic theft: approve(attacker, max) and transferFrom from a foreign address.
  const calls = goodCalls();
  calls[0] = { target: TOKEN, value: 0n, data: erc20('approve', [STRANGER, 2n ** 200n]) };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown spender/);
});

// ------------------------------------------------------------- other limits

test('banned selectors do not pass', () => {
  for (const sel of ['0x23b872dd', '0xd505accf', '0xa22cb465']) {
    const r = check([{ target: TOKEN, value: 0n, data: `${sel}${'00'.repeat(64)}` }]);
    assert.equal(r.ok, false, sel);
    assert.match(r.reason, /banned selector/);
  }
});

test('native value in the batch is refused', () => {
  const calls = goodCalls();
  calls[1] = { ...calls[1], value: 1n };
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /native value/);
});

test('an over-long batch is refused', () => {
  const calls = [...goodCalls(), { target: ROUTER, value: 0n, data: SWAP }, { target: ROUTER, value: 0n, data: SWAP },
    { target: ROUTER, value: 0n, data: SWAP }, { target: ROUTER, value: 0n, data: SWAP }];
  const r = check(calls);
  assert.equal(r.ok, false);
  assert.match(r.reason, /calls in the batch/);
});

test('a batch without the order input token is refused', () => {
  const r = check([{ target: ROUTER, value: 0n, data: SWAP }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /input token/);
});

// ------------------------------------------------------------------- ticket

test('without a ticket no signature is issued', () => {
  const r = ticketValid(null, { orderId: 'o1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no signature was requested/);
});

test('the ticket is single-use', () => {
  const t = { orderId: 'o1', at: Date.now(), used: true };
  assert.match(ticketValid(t, { orderId: 'o1' }).reason, /already used/);
});

test('a ticket for another order is not good', () => {
  const t = { orderId: 'o1', at: Date.now() };
  assert.match(ticketValid(t, { orderId: 'o2' }).reason, /another order/);
});

test('an expired ticket is not good', () => {
  const now = Date.now();
  const t = { orderId: 'o1', at: now - TICKET_TTL_MS - 1 };
  assert.match(ticketValid(t, { orderId: 'o1', now }).reason, /expired/);
});

test('a fresh ticket for its own order is good', () => {
  const now = Date.now();
  assert.equal(ticketValid({ orderId: 'o1', at: now }, { orderId: 'o1', now }).ok, true);
});

// ------------------------------------------------------------ output guard

// The target in the quote scale 1e18: $100 = 100e18; the guard floor is in six-decimal USDG.
const guarded = (over = {}) => order({ targetOut: (100n * 10n ** 18n).toString(), maxSlippageBps: 500, ...over });
const wrap = (calls, minGain) => {
  const g = guardCalls({ chainId: 4663, minGain  });
  return [g.before, ...calls, g.after];
};

test('an order with a target and slippage is not signed without the guard', () => {
  const r = check(goodCalls(), {}, guarded());
  assert.equal(r.ok, false);
  assert.match(r.reason, /output guard/);
});

test('a guard with a floor of at least target × (1 − slippage) passes', () => {
  // 100 USDC at 5% → floor 95 USDC.
  const r = check(wrap(goodCalls(), 95_000_000n), {}, guarded());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.guarded, true);
  assert.equal(check(wrap(goodCalls(), 96_000_000n), {}, guarded()).ok, true, 'higher is allowed');
});

test('a guard floor below the computed one is refused', () => {
  const r = check(wrap(goodCalls(), 94_999_999n), {}, guarded());
  assert.equal(r.ok, false);
  assert.match(r.reason, /guard floor .* below/);
});

test('the guard must watch the chain token and the relay depository', () => {
  const g = guardCalls({ chainId: 4663, minGain: 95_000_000n  });
  const swapWord = (data, i, addr) => `${data.slice(0, 10 + i * 64)}${addr.slice(2).padStart(64, '0')}${data.slice(10 + (i + 1) * 64)}`;
  const wrongToken = { ...g.before, data: swapWord(g.before.data, 0, STRANGER) };
  assert.match(check([wrongToken, ...goodCalls(), g.after], {}, guarded()).reason, /does not watch the chain's USDG/);
  const wrongHolder = { ...g.after, data: swapWord(g.after.data, 1, STRANGER) };
  assert.match(check([g.before, ...goodCalls(), wrongHolder], {}, guarded()).reason, /the guard watches 0x3333/);
  assert.equal(GUARD_CASH[4663].token.length, 42);
  assert.equal(RELAY_DEPOSITORY.length, 42);
});

test('snapshot first, check last, otherwise the check checks something else', () => {
  const g = guardCalls({ chainId: 4663, minGain: 95_000_000n  });
  assert.match(check([...goodCalls(), g.before, g.after], {}, guarded()).reason, /snapshot must be the first/);
  assert.match(check([g.before, g.after, ...goodCalls()], {}, guarded()).reason, /check must be the last/);
  assert.match(check([g.before, ...goodCalls()], {}, guarded()).reason, /exactly two/);
});

test('without slippage no guard is required, but a foreign guard does not pass', () => {
  const t = (100n * 10n ** 18n).toString();
  assert.equal(check(goodCalls(), {}, order({ targetOut: t })).ok, true);
  const g = guardCalls({ chainId: 4663, minGain: 1n  });
  assert.equal(check([g.before, ...goodCalls(), g.after], {}, order({ targetOut: t })).ok, true);
  const alien = { target: GUARD_ADDRESS, value: 0n, data: `0xdeadbeef${'00'.repeat(64)}` };
  assert.equal(check([alien, ...goodCalls()], {}, order()).ok, false);
});

// ------------------------------------------------- refundTo and nftRecipient

test('a stranger in refundTo or nftRecipient does not refuse, in step with the contract', () => {
  // Live relay quotes put relay's own address in both words (see the
  // contract's "two remaining head words" note and session-account.test.mjs).
  // Requiring the wallet would refuse every real sell; the words receive
  // native leftovers and mints, and this batch carries neither.
  const calls = goodCalls();
  calls[1] = { target: ROUTER, value: 0n, data: swapOf([{ token: TOKEN, amount: 10000n }], STRANGER) };
  const r = check(calls);
  assert.equal(r.ok, true, r.reason);
});

// ------------------------------------------- version 4: the order in the operation
