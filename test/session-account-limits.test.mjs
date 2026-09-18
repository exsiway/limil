// The grant the extension's own planner produces, replayed against the
// contract's limits.
//
// Each case is asserted as REFUSED so that no version quietly opens it:
//
// 1. one approve cap shared across tokens of different decimals, a cap sized
//    for eighteen decimals let a million times the order through for six;
// 2. an output guard that was allowed but not required, so a sell could skip
//    it entirely;
// 3. a budget charged from `approve`, so an allowance that already stood to
//    the router moved tokens for free;
// 4. a floor the signing key chose for itself, so it could be one wei.
//
// 5. a payout the contract could not see: the guard measures a SHARED relay
//    depository, and an attacker could satisfy it with their own deposit
//    credited to their own off-chain request. Version 4 closes it: the sale
//    carries relay's order, the contract recomputes the order id, requires it
//    in the deposit and requires the payout to go to the owner's own address.
//
// The batches here are built the way a key holder would build them, not the
// way the extension does: the point is what the CONTRACT refuses.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ABI, ENTRY_POINT, NOW, call, delegateTo, fund, makeVm } from './helpers/evm.mjs';
import { PRICE_SCALE, planGrant } from '../src/shared/grant-plan.js';
import { GUARD_ADDRESS, GUARD_CASH, RELAY_DEPOSITORY, guardCalls, guardSpecFor } from '../src/shared/output-guard.js';
import { depositData, key32, nested } from './helpers/relay-deposit.mjs';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const session = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const tokenA = `0x${'aa'.repeat(20)}`;
const tokenB = `0x${'bb'.repeat(20)}`;
const router = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const SWAP = '0xf9e4bab4';
const CHAIN = 4663;
const ONE = 10n ** 18n;
const SIX = 10n ** 6n;

// Two live orders: one token of eighteen decimals for $1, one of six for $1.
const ORDERS = [
  {
    status: 'watching', side: 'sell', inTokenId: `${tokenA}:${CHAIN}`, amount: String(ONE),
    targetOut: String(ONE), maxSlippageBps: 0,
  },
  {
    status: 'watching', side: 'sell', inTokenId: `${tokenB}:${CHAIN}`, amount: String(SIX),
    targetOut: String(ONE), maxSlippageBps: 0,
  },
];

const plan = planGrant(ORDERS, { router, swapSelector: SWAP, guard: guardSpecFor(CHAIN), chainId: CHAIN, now: Number(NOW) * 1000 });
const CASH = guardSpecFor(CHAIN).settlementToken;
/** The deposit relay nests inside the swap; the contract does not read its id. */
const deposit = (id = key32('a relay order')) => [RELAY_DEPOSITORY, false, 0n, nested(depositData(owner.address, CASH, id))];
const priceOf = (token) => plan.tokenCaps.find((c) => c.token === token).minOutPerUnit;
const needed = (token, amount) => (amount * priceOf(token)) / PRICE_SCALE;

async function grantedVm() {
  const vm = await makeVm();
  await delegateTo(vm, owner.address);
  await fund(vm, ENTRY_POINT);
  const grant = await call(vm, {
    from: ENTRY_POINT, to: owner.address,
    data: encodeFunctionData({
      abi: ABI,
      functionName: 'grantSession',
      args: [session.address, {
        limits: {
          validUntil: BigInt(plan.validUntil), maxOps: BigInt(plan.maxOps), maxValuePerCall: plan.maxValuePerCall,
          valueBudget: plan.valueBudget, feeBudget: plan.feeBudget, maxFeePerOp: plan.maxFeePerOp,
        },
        tokenCaps: plan.tokenCaps,
        guard: plan.guard,
        swap: plan.swap,
        targets: plan.targets,
        selectors: plan.selectors,
        feeRecipients: plan.feeRecipients,
      }],
    }),
  });
  assert.equal(grant.reverted, false, "the planner's grant is accepted by the contract as is");
  return vm;
}

async function validate(vm, calls) {
  const list = calls.map((c) => ({ target: c.target, value: c.value ?? 0n, data: c.data }));
  const callData = encodeFunctionData({ abi: ABI, functionName: 'executeBatch', args: [list] });
  const hash = keccak256(callData);
  const signature = await session.sign({ hash });
  const userOp = {
    sender: owner.address, nonce: 0n, initCode: '0x', callData,
    accountGasLimits: `0x${'00'.repeat(32)}`, preVerificationGas: 0n, gasFees: `0x${'00'.repeat(32)}`, paymasterAndData: '0x', signature,
  };
  const result = await call(vm, {
    from: ENTRY_POINT, to: owner.address,
    data: encodeFunctionData({ abi: ABI, functionName: 'validateUserOp', args: [userOp, hash, 0n] }),
  });
  assert.equal(result.reverted, false, 'validation itself must not revert');
  return (BigInt(result.returned) & ((1n << 160n) - 1n)) === 0n;
}

const SWAP_HEAD = [
  { type: 'address[]' },
  { type: 'uint256[]' },
  { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'bytes' }] },
  { type: 'address' },
  { type: 'address' },
  { type: 'bytes' },
];
const swap = (sales, refundTo = owner.address, inner = [deposit()]) => ({
  target: router,
  data: `${SWAP}${encodeAbiParameters(SWAP_HEAD, [sales.map((s) => s.token), sales.map((s) => s.amount), inner, refundTo, refundTo, '0x']).slice(2)}`,
});
const approve = (token, amount) => ({
  target: token,
  data: `0x095ea7b3${router.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`,
});
/** The guard as the runner builds it, at the floor the granted price demands. */
const wrap = (calls, floor) => {
  const g = guardCalls({ chainId: CHAIN, minGain: floor });
  return [g.before, ...calls, g.after];
};

test('1. a 6-decimal token is measured by ITS cap, not by an 18-decimal one', async () => {
  const vm = await grantedVm();
  const tooMuch = 10n ** 12n;
  assert.equal(await validate(vm, wrap([swap([{ token: tokenB, amount: tooMuch }])], needed(tokenB, tooMuch))), false,
    "token B is capped by its own order, not by token A's");
  assert.equal(await validate(vm, wrap([swap([{ token: tokenB, amount: SIX }])], needed(tokenB, SIX))), true);
  assert.equal(await validate(vm, wrap([swap([{ token: tokenA, amount: ONE }])], needed(tokenA, ONE))), true);
});

test('2. a sell batch without the output guard around the swap is refused', async () => {
  const vm = await grantedVm();
  assert.equal(await validate(vm, [approve(tokenA, ONE), swap([{ token: tokenA, amount: ONE }])]), false);
});

test('3. a swap with NO approve is charged all the same, a standing allowance is not free', async () => {
  // The second version charged the budget from `approve`, so a batch that
  // spent an allowance already standing to the router cost nothing at all.
  const vm = await grantedVm();
  const read = async () => {
    const r = await call(vm, {
      from: ENTRY_POINT, to: owner.address,
      data: encodeFunctionData({ abi: ABI, functionName: 'tokenBudget', args: [session.address, tokenA] }),
    });
    return BigInt(`0x${r.returned.slice(2).slice(3 * 64, 4 * 64)}`);
  };
  assert.equal(await read(), 0n);
  assert.equal(await validate(vm, wrap([swap([{ token: tokenA, amount: ONE }])], needed(tokenA, ONE))), true);
  assert.equal(await read(), ONE, 'the swap alone spent the budget');
  // And the budget really runs out: the plan allows the order plus one retry.
  assert.equal(await validate(vm, wrap([swap([{ token: tokenA, amount: ONE }])], needed(tokenA, ONE))), true);
  assert.equal(await validate(vm, wrap([swap([{ token: tokenA, amount: ONE }])], needed(tokenA, ONE))), false, 'nothing left');
});

test('4. the floor is the owner\'s price, not a number the key writes', async () => {
  const vm = await grantedVm();
  const sale = [swap([{ token: tokenA, amount: ONE }])];
  // A floor of one wei is short of the price.
  assert.equal(await validate(vm, wrap(sale, 1n)), false, 'a dust floor no longer passes');
  assert.equal(await validate(vm, wrap(sale, needed(tokenA, ONE) - 1n)), false, 'nor a hair under the price');
  assert.equal(await validate(vm, wrap(sale, needed(tokenA, ONE))), true);
  assert.deepEqual(guardSpecFor(CHAIN), {
    guard: GUARD_ADDRESS, settlementToken: GUARD_CASH[CHAIN].token, depository: RELAY_DEPOSITORY,
  });
});

test('what the contract enforced before still holds: an approve to a stranger is refused', async () => {
  const vm = await grantedVm();
  const toStranger = {
    target: tokenA,
    data: `0x095ea7b3${'dd'.repeat(20).padStart(64, '0')}${ONE.toString(16).padStart(64, '0')}`,
  };
  assert.equal(await validate(vm, wrap([toStranger, swap([{ token: tokenA, amount: ONE }])], needed(tokenA, ONE))), false);
});
