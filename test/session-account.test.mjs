// Session-key account tests: the contract that is live.
//
// This contract becomes the CODE of the wallet and decides who may spend.
// It cannot be checked by reasoning: here it runs on a real EVM in the same
// position as on chain, with the code at the owner's address.
//
// What matters most is not whether the allowed works but whether the
// forbidden DOES NOT. The session key lives outside the wallet, and if the
// bounds leak the whole idea is lost.
//
// What the tests pin: rights that must not come back after a revoke, targets
// and selectors as pairs rather than a product, value limits gas cannot drain
// past, approve only to the router, the summed value of a batch, no calls into
// self or the EntryPoint, one approve cap per token whatever its decimals, a
// guard that is required, a budget charged by the swap rather than by
// `approve`, a guard that measures relay's depository, a floor the owner fixes
// rather than the signing key.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, toFunctionSelector, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ABI, ENTRY_POINT, NOW, call, delegateTo, fund, makeVm } from './helpers/evm.mjs';
import { SEL_ASSERT, SEL_SNAPSHOT } from '../src/shared/output-guard.js';
import { depositData, key32, nested } from './helpers/relay-deposit.mjs';

const OWNER_KEY = `0x${'11'.repeat(32)}`;
const SESSION_KEY = `0x${'22'.repeat(32)}`;
const owner = privateKeyToAccount(OWNER_KEY);
const session = privateKeyToAccount(SESSION_KEY);

const TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const TOKEN_B = '0x2222222222222222222222222222222222222222';
const ROUTER = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const STRANGER = '0x1111111111111111111111111111111111111111';
const GUARD = '0x55f1dd8f6afe957fdfabb70e31b0f9ff46f237f3';
const CASH = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const ZERO = '0x0000000000000000000000000000000000000000';

/** The id relay's deposit carries; the contract does not read it. */
const ORDER_ID = key32('a relay order');
/** The depository call relay nests inside its proxy call, one level down. */
const deposit = (id = ORDER_ID, depositor = owner.address, token = CASH) => [DEPOSITORY, false, 0n, nested(depositData(depositor, token, id))];

const APPROVE = '0x095ea7b3';
const INCREASE_ALLOWANCE = '0x39509351';
const SWAP = '0xf9e4bab4';
const TRANSFER = '0xa9059cbb';
const PERMIT = '0xd505accf';

const PRICE_SCALE = 10n ** 18n;
// One token of eighteen decimals is worth one settlement unit of six.
const PRICE = 10n ** 6n;
const ONE = 10n ** 18n;
/** What the contract will demand of the floor for `amount` at `price`. */
const needed = (amount, price = PRICE) => (amount * price) / PRICE_SCALE;

const pad = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const word = (n) => n.toString(16).padStart(64, '0');

const approveTo = (spender, amount = 0n) => `${APPROVE}${pad(spender)}${word(amount)}`;
const increaseTo = (spender) => `${INCREASE_ALLOWANCE}${pad(spender)}${word(0n)}`;
const transferTo = (to, amount) => `${TRANSFER}${pad(to)}${word(amount)}`;

// The relay proxy's entry point, encoded as it really is. The contract reads
// the two arrays and the two addresses out of this and charges the budgets
// from them, so the tests must speak the real layout.
const SWAP_HEAD = [
  { type: 'address[]' },
  { type: 'uint256[]' },
  { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'bytes' }] },
  { type: 'address' },
  { type: 'address' },
  { type: 'bytes' },
];
function swapCall(sales = [{ token: TOKEN, amount: ONE }], over = {}) {
  const refundTo = over.refundTo ?? owner.address;
  const args = encodeAbiParameters(SWAP_HEAD, [
    sales.map((s) => s.token),
    sales.map((s) => s.amount),
    over.inner ?? [deposit()],
    refundTo,
    over.nftRecipient ?? refundTo,
    '0x',
  ]);
  return { target: over.target ?? ROUTER, data: `${SWAP}${args.slice(2)}` };
}

/** The guard's two calls, on the session's token and depository. */
const snapshot = (token = CASH, holder = DEPOSITORY) => ({ target: GUARD, data: `${SEL_SNAPSHOT}${pad(token)}${pad(holder)}` });
const assertGained = (min, token = CASH, holder = DEPOSITORY) => ({ target: GUARD, data: `${SEL_ASSERT}${pad(token)}${pad(holder)}${word(min)}` });

/** A bare UserOp with the given callData and signature. Gas fields overridable. */
function userOp(sender, callData, signature, over = {}) {
  return {
    sender,
    nonce: 0n,
    initCode: '0x',
    callData,
    accountGasLimits: over.accountGasLimits ?? `0x${'00'.repeat(32)}`,
    preVerificationGas: over.preVerificationGas ?? 0n,
    gasFees: over.gasFees ?? `0x${'00'.repeat(32)}`,
    paymasterAndData: '0x',
    signature,
  };
}

/** EntryPoint v0.8 gas packing: two uint128 in one word. */
const packPair = (hi, lo) => `0x${hi.toString(16).padStart(32, '0')}${lo.toString(16).padStart(32, '0')}`;

function batch(calls) {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'executeBatch',
    args: [calls.map((c) => ({ target: c.target, value: c.value ?? 0n, data: c.data }))],
  });
}
/** A guarded key's entry point is the same executeBatch. */
const tbatch = batch;
/** A guarded batch: what a session key of the extension always sends. */
const gbatch = (calls, floor = needed(ONE)) => batch([snapshot(), ...calls, assertGained(floor)]);

/** The Grant struct with defaults: one capped token, the guard, the router. */
function grantData(over = {}) {
  const tokenCaps = over.tokenCaps ?? [{
    token: TOKEN,
    maxPerOp: over.maxPerOp ?? 10n ** 24n,
    budget: over.budget ?? 10n ** 27n,
    minOutPerUnit: over.minOutPerUnit ?? PRICE,
  }];
  const guard = over.guard === null
    ? { guard: ZERO, settlementToken: ZERO, depository: ZERO }
    : { guard: GUARD, settlementToken: CASH, depository: DEPOSITORY, ...(over.guard ?? {}) };
  const swap = over.swap === null
    ? { router: ZERO, selector: '0x00000000' }
    : { router: ROUTER, selector: SWAP, ...(over.swap ?? {}) };
  return encodeFunctionData({
    abi: ABI,
    functionName: 'grantSession',
    args: [
      over.key ?? session.address,
      {
        limits: {
          validUntil: over.validUntil ?? NOW + 3600n,
          maxOps: over.maxOps ?? 100n,
          maxValuePerCall: over.maxValuePerCall ?? 0n,
          valueBudget: over.valueBudget ?? 0n,
          feeBudget: over.feeBudget ?? 0n,
          maxFeePerOp: over.maxFeePerOp ?? 0n,
        },
        tokenCaps,
        guard,
        swap,
        targets: over.targets ?? [TOKEN],
        selectors: over.selectors ?? [APPROVE],
        feeRecipients: over.feeRecipients ?? [],
      },
    ],
  });
}

async function freshVm() {
  const vm = await makeVm();
  await delegateTo(vm, owner.address);
  await fund(vm, ENTRY_POINT);
  return vm;
}

async function grantReverts(vm, over) {
  const r = await call(vm, { from: ENTRY_POINT, to: owner.address, data: grantData(over) });
  return r.reverted;
}

async function setup(overrides = {}) {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, overrides), false, 'granting the key must not revert');
  return vm;
}

async function validate(vm, signer, callData, over = {}) {
  const hash = keccak256(encodePacked(['bytes'], [callData]));
  const signature = await signer.sign({ hash });
  const result = await call(vm, {
    from: ENTRY_POINT,
    to: owner.address,
    data: encodeFunctionData({
      abi: ABI,
      functionName: 'validateUserOp',
      args: [userOp(owner.address, callData, signature, over), hash, 0n],
    }),
  });
  if (result.reverted) return { accepted: false, reverted: true, validUntil: null };
  const data = BigInt(result.returned);
  return {
    accepted: (data & ((1n << 160n) - 1n)) === 0n,
    reverted: false,
    validUntil: (data >> 160n) & ((1n << 48n) - 1n),
  };
}

const accepted = async (vm, callData, over) => (await validate(vm, session, callData, over)).accepted;

/** The batch the runner builds: approve, swap, allowance reset, inside the guard. */
const sell = (amount = ONE, sales = [{ token: TOKEN, amount }]) => [
  { target: TOKEN, data: approveTo(ROUTER, amount) },
  swapCall(sales),
  { target: TOKEN, data: approveTo(ROUTER, 0n) },
];
const allowedBatch = gbatch(sell());

/** The on-chain TokenBudget, decoded by hand. */
async function budgetOf(vm, key, token) {
  const r = await call(vm, {
    from: ENTRY_POINT, to: owner.address,
    data: encodeFunctionData({ abi: ABI, functionName: 'tokenBudget', args: [key, token] }),
  });
  const hex = r.returned.slice(2);
  const at = (i) => BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`);
  return { exists: at(0) === 1n, maxPerOp: at(1), budget: at(2), spent: at(3), minOutPerUnit: at(4) };
}

// ------------------------------------------------------------ the owner

test('the owner signs anything, the account behaves as before', async () => {
  const vm = await setup();
  const anything = batch([{ target: STRANGER, data: transferTo(STRANGER, 1n) }]);
  const r = await validate(vm, owner, anything);
  assert.equal(r.accepted, true);
  assert.equal(r.validUntil, 0n);
});

// ------------------------------------------------------- session key: yes

test('the key executes what it is allowed, and the term goes into validationData', async () => {
  const vm = await setup();
  const r = await validate(vm, session, allowedBatch);
  assert.equal(r.accepted, true);
  assert.equal(r.validUntil, NOW + 3600n);
});

test('a term in the past is not cut by the contract itself, it hands it to the EntryPoint', async () => {
  const vm = await setup({ validUntil: NOW - 3600n });
  const r = await validate(vm, session, allowedBatch);
  assert.equal(r.accepted, true);
  assert.equal(r.validUntil, NOW - 3600n);
});

// ------------------------------------------- the price: what v3 exists for

test('the floor must meet the price the OWNER fixed, not one the key picked', async () => {
  // The second version took the floor from the signature and checked only
  // that it was above zero, so a leaked key wrote one wei. Now the grant
  // carries a price per token and the contract does the arithmetic.
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch(sell(), needed(ONE))), true, 'exactly the price passes');
  assert.equal(await accepted(vm, gbatch(sell(), needed(ONE) + 1n)), true, 'more than the price passes');
  assert.equal(await accepted(vm, gbatch(sell(), needed(ONE) - 1n)), false, 'a hair under does not');
  assert.equal(await accepted(vm, gbatch(sell(), 1n)), false, 'and dust certainly does not');
});

test('the price is per token and the demands of one operation add up', async () => {
  const vm = await setup({
    tokenCaps: [
      { token: TOKEN, maxPerOp: 10n ** 24n, budget: 10n ** 27n, minOutPerUnit: PRICE },
      { token: TOKEN_B, maxPerOp: 10n ** 24n, budget: 10n ** 27n, minOutPerUnit: 2n * PRICE },
    ],
    targets: [TOKEN, TOKEN_B],
    selectors: [APPROVE, APPROVE],
  });
  const sales = [{ token: TOKEN, amount: ONE }, { token: TOKEN_B, amount: ONE }];
  const both = (floor) => gbatch([swapCall(sales)], floor);
  const want = needed(ONE) + needed(ONE, 2n * PRICE);
  assert.equal(await accepted(vm, both(want)), true);
  assert.equal(await accepted(vm, both(want - 1n)), false, 'the two prices are summed, not taken one at a time');
});

test('a token cap without a price is not granted', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { minOutPerUnit: 0n }), true);
});

// ------------------------------- the budget: charged from what leaves

test('a swap with NO approve still spends the budget, a standing allowance is not free', async () => {
  // The third version's reason for existing. The second charged the budget
  // from `approve`, so a batch that used an allowance already standing to the
  // router moved tokens and cost nothing.
  const vm = await setup({ maxPerOp: 2n * ONE, budget: 3n * ONE });
  const before = await budgetOf(vm, session.address, TOKEN);
  assert.equal(before.spent, 0n);
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE))), true, 'the swap alone is a legitimate batch');
  const after = await budgetOf(vm, session.address, TOKEN);
  assert.equal(after.spent, ONE, 'and it was charged in full');
});

test('the budget is charged by the swap, and an approve alone costs nothing', async () => {
  const vm = await setup({ maxPerOp: 2n * ONE, budget: 3n * ONE });
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: approveTo(ROUTER, ONE) }], 1n)), true);
  assert.equal((await budgetOf(vm, session.address, TOKEN)).spent, 0n, 'a permission is not a spend');
});

test('the per-operation cap and the session budget both bound the sale', async () => {
  const vm = await setup({ maxPerOp: ONE, budget: 2n * ONE });
  assert.equal(await accepted(vm, gbatch([swapCall([{ token: TOKEN, amount: ONE + 1n }])], needed(ONE + 1n))), false, 'above the per-op cap');
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE))), true, 'first');
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE))), true, 'second');
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE))), false, 'third: the budget is gone');
});

test('two swaps of one token in one operation are summed, two tokens are not', async () => {
  const vm = await setup({
    maxPerOp: ONE,
    budget: 10n * ONE,
    tokenCaps: [
      { token: TOKEN, maxPerOp: ONE, budget: 10n * ONE, minOutPerUnit: PRICE },
      { token: TOKEN_B, maxPerOp: ONE, budget: 10n * ONE, minOutPerUnit: PRICE },
    ],
    targets: [TOKEN, TOKEN_B],
    selectors: [APPROVE, APPROVE],
  });
  const twice = [swapCall([{ token: TOKEN, amount: (ONE * 6n) / 10n }]), swapCall([{ token: TOKEN, amount: (ONE * 6n) / 10n }])];
  assert.equal(await accepted(vm, gbatch(twice, needed((ONE * 12n) / 10n))), false, 'one token, summed past its cap');
  const each = [swapCall([{ token: TOKEN, amount: ONE }]), swapCall([{ token: TOKEN_B, amount: ONE }])];
  assert.equal(await accepted(vm, gbatch(each, needed(2n * ONE))), true, 'two tokens, each at its own cap');
});

test('a token with no cap cannot be sold, whatever the pair list says', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch([swapCall([{ token: TOKEN_B, amount: 1n }])], needed(ONE))), false);
});

test('a rejected operation does not consume the budget', async () => {
  const vm = await setup({ maxPerOp: ONE, budget: ONE });
  assert.equal(await accepted(vm, gbatch([swapCall([{ token: TOKEN, amount: ONE + 1n }])], needed(ONE + 1n))), false);
  const gassy = { accountGasLimits: packPair(100_000n, 200_000n), preVerificationGas: 50_000n, gasFees: packPair(0n, 10n) };
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE)), gassy), false, 'refused on gas');
  assert.equal((await budgetOf(vm, session.address, TOKEN)).spent, 0n);
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE))), true, 'the whole budget is still there');
});

test('tokenBudget shows the caps, the price and what was spent', async () => {
  const vm = await setup({ maxPerOp: 2n * ONE, budget: 5n * ONE });
  assert.deepEqual(await budgetOf(vm, session.address, TOKEN), {
    exists: true, maxPerOp: 2n * ONE, budget: 5n * ONE, spent: 0n, minOutPerUnit: PRICE,
  });
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE))), true);
  assert.equal((await budgetOf(vm, session.address, TOKEN)).spent, ONE);
  assert.equal((await budgetOf(vm, session.address, STRANGER)).exists, false);
});

// --------------------------------- the swap's own arguments

test('the swap\'s refundTo is left alone: live quotes put relay\'s own address there', async () => {
  // Requiring the wallet would refuse every real sell. It is safe to leave:
  // the key may send no native value and receives no mints, so those two
  // words lead nowhere.
  const vm = await setup();
  const away = gbatch([swapCall([{ token: TOKEN, amount: ONE }], { refundTo: STRANGER })], needed(ONE));
  assert.equal(await accepted(vm, away), true);
});

test('a swap call that does not decode is refused rather than read past its end', async () => {
  const vm = await setup();
  for (const data of [SWAP, `${SWAP}${'00'.repeat(64)}`, `${SWAP}${'ff'.repeat(192)}`]) {
    assert.equal(await accepted(vm, gbatch([{ target: ROUTER, data }], needed(ONE))), false, `malformed: ${data.slice(0, 20)}`);
  }
});

test('the router is granted by the contract, and no other function on it is', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { targets: [TOKEN, ROUTER], selectors: [APPROVE, '0x12345678'] }), true);
  const live = await setup();
  const r = await call(live, {
    from: ENTRY_POINT, to: owner.address,
    data: encodeFunctionData({ abi: ABI, functionName: 'isAllowedCall', args: [session.address, ROUTER, SWAP] }),
  });
  assert.equal(BigInt(r.returned), 1n, 'the swap pair comes with the grant');
  assert.equal(await accepted(live, gbatch([{ target: ROUTER, data: `0x12345678${'00'.repeat(64)}` }], needed(ONE))), false);
});

test('a grant needs the guard, the settlement token and the router together', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { guard: { settlementToken: ZERO } }), true, 'no settlement token');
  assert.equal(await grantReverts(vm, { guard: { depository: ZERO } }), true, 'no depository');
  assert.equal(await grantReverts(vm, { guard: { guard: ZERO } }), true, 'a token without a guard');
  assert.equal(await grantReverts(vm, { swap: { router: ZERO } }), true, 'a guard without a router');
  assert.equal(await grantReverts(vm, { swap: { selector: '0x00000000' } }), true, 'a router without a selector');
  assert.equal(await grantReverts(vm, { guard: { guard: owner.address } }), true, 'the account as guard');
  assert.equal(await grantReverts(vm, { swap: { router: GUARD } }), true, 'the guard as router');
  assert.equal(await grantReverts(vm, { swap: { router: owner.address } }), true, 'the account as router');
  assert.equal(await grantReverts(vm, { guard: null, swap: null }), true, 'caps without a template');
  assert.equal(await grantReverts(vm, { guard: null, swap: null, tokenCaps: [] }), true, 'the approve pair without a cap');
  // The settlement token may not itself be sold: the batch would then satisfy
  // its own floor out of the proceeds.
  assert.equal(await grantReverts(vm, {
    tokenCaps: [{ token: CASH, maxPerOp: ONE, budget: ONE, minOutPerUnit: PRICE }], targets: [CASH], selectors: [APPROVE],
  }), true);
});

test('a key without a template may call plain targets, but never sell', async () => {
  const vm = await setup({ guard: null, swap: null, tokenCaps: [], targets: [STRANGER], selectors: ['0x12345678'] });
  assert.equal(await accepted(vm, batch([{ target: STRANGER, data: `0x12345678${'00'.repeat(64)}` }])), true);
  const single = encodeFunctionData({ abi: ABI, functionName: 'execute', args: [STRANGER, 0n, `0x12345678${'00'.repeat(64)}`] });
  assert.equal(await accepted(vm, single), true, 'execute is open to an unguarded key');
  assert.equal(await accepted(vm, batch([{ target: TOKEN, data: approveTo(ROUTER, ONE) }])), false, 'no pair, no cap: no approve');
});

// ------------------------------------------------- the execution template

test('a sell batch without the guard around the trade is refused', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, tbatch(sell())), false);
  assert.equal(await accepted(vm, allowedBatch), true, 'the same trade inside the template passes');
});

test('the template is snapshot FIRST and assertGained LAST, nothing else will do', async () => {
  const vm = await setup();
  const trade = sell();
  const floor = needed(ONE);
  assert.equal(await accepted(vm, tbatch([...trade, snapshot(), assertGained(floor)])), false, 'snapshot not first');
  assert.equal(await accepted(vm, tbatch([snapshot(), assertGained(floor), ...trade])), false, 'assertGained not last');
  assert.equal(await accepted(vm, tbatch([snapshot(), ...trade])), false, 'no check at the end');
  assert.equal(await accepted(vm, tbatch([...trade, assertGained(floor)])), false, 'no snapshot at the start');
  assert.equal(await accepted(vm, tbatch([assertGained(floor), ...trade, snapshot()])), false, 'the two swapped');
  assert.equal(await accepted(vm, tbatch([snapshot(), ...trade, snapshot(), assertGained(floor)])), false, 'a second snapshot resets the measurement');
  assert.equal(await accepted(vm, tbatch([snapshot(), assertGained(1n)])), true, 'an empty trade inside the template is harmless');
  assert.equal(await accepted(vm, tbatch([snapshot()])), false, 'one call is not a template');
});

test("the guard must measure the session's own token and holder", async () => {
  const vm = await setup();
  const trade = sell();
  const floor = needed(ONE);
  assert.equal(await accepted(vm, tbatch([snapshot(STRANGER), ...trade, assertGained(floor, STRANGER)])), false, 'another token');
  assert.equal(await accepted(vm, tbatch([snapshot(CASH, STRANGER), ...trade, assertGained(floor, CASH, STRANGER)])), false, 'another holder');
  assert.equal(await accepted(vm, tbatch([snapshot(), ...trade, assertGained(floor, STRANGER)])), false, 'the check on another token');
  assert.equal(await accepted(vm, tbatch([snapshot(), ...trade, assertGained(0n)])), false, 'a zero floor is no check');
  const longer = { target: GUARD, data: `${assertGained(floor).data}00` };
  assert.equal(await accepted(vm, tbatch([snapshot(), ...trade, longer])), false, 'a longer assertGained');
  const shorter = { target: GUARD, data: snapshot().data.slice(0, -2) };
  assert.equal(await accepted(vm, tbatch([shorter, ...trade, assertGained(floor)])), false, 'a shorter snapshot');
  const dirty = { target: GUARD, data: `${SEL_SNAPSHOT}${'ff'.repeat(12)}${CASH.slice(2)}${pad(DEPOSITORY)}` };
  assert.equal(await accepted(vm, tbatch([dirty, ...trade, assertGained(floor)])), false, 'dirty address bits');
});

test('a guarded key has no use of execute, a single call cannot carry the template', async () => {
  const vm = await setup();
  const single = encodeFunctionData({ abi: ABI, functionName: 'execute', args: [ROUTER, 0n, swapCall().data] });
  assert.equal(await accepted(vm, single), false);
});

test("the guard's pairs come from the contract, and only the two of the template", async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { targets: [TOKEN, GUARD], selectors: [APPROVE, SEL_SNAPSHOT] }), true);
  assert.equal(await grantReverts(vm, { targets: [TOKEN, GUARD], selectors: [APPROVE, '0x12345678'] }), true);
  const live = await setup();
  for (const sel of [SEL_SNAPSHOT, SEL_ASSERT]) {
    const r = await call(live, {
      from: ENTRY_POINT, to: owner.address,
      data: encodeFunctionData({ abi: ABI, functionName: 'isAllowedCall', args: [session.address, GUARD, sel] }),
    });
    assert.equal(BigInt(r.returned), 1n, `${sel} is granted with the template`);
  }
  assert.equal(await accepted(live, gbatch([{ target: TOKEN, data: approveTo(GUARD, ONE) }], 1n)), false, 'the guard is never a spender');
});

test("the guard selectors are the ones of LimilOutputGuard's signatures", async () => {
  assert.equal(SEL_SNAPSHOT, toFunctionSelector('snapshot(address,address)'));
  assert.equal(SEL_ASSERT, toFunctionSelector('assertGained(address,address,uint256)'));
  const vm = await setup();
  assert.equal(await accepted(vm, allowedBatch), true);
});

// ------------------------------------------------------- session key: no

test('a foreign target is rejected even with an allowed selector', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch([{ target: STRANGER, data: approveTo(ROUTER, ONE) }], 1n)), false);
});

test('permission is a pair, not a product of the lists', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: `${SWAP}${'00'.repeat(64)}` }], 1n)), false);
  assert.equal(await accepted(vm, gbatch([{ target: ROUTER, data: approveTo(ROUTER, ONE) }], 1n)), false);
});

test('a forbidden call inside an allowed batch kills the whole batch', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch([...sell(), { target: STRANGER, data: transferTo(STRANGER, 1n) }])), false);
});

test('an unknown entry point is not available to the key', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, grantData({ targets: [STRANGER], selectors: [SWAP] })), false);
});

test('malformed callData reverts validation rather than passing', async () => {
  const vm = await setup();
  const selector = batch([]).slice(0, 10);
  assert.equal(await accepted(vm, `${selector}${'ff'.repeat(64)}`), false);
});

// ------------------------------------------------- native value

test('a native transfer without a selector does not pass', async () => {
  const vm = await setup({ maxValuePerCall: ONE, valueBudget: ONE });
  assert.equal(await accepted(vm, gbatch([{ target: ROUTER, value: 1n, data: '0x' }], 1n)), false);
});

test('native value does not leave when no cap is set', async () => {
  const vm = await setup({ valueBudget: ONE });
  assert.equal(await accepted(vm, gbatch([{ ...swapCall(), value: 1n }], needed(ONE))), false);
});

test('a zero valueBudget forbids native value rather than lifting the limit', async () => {
  const vm = await setup({ maxValuePerCall: 100n, valueBudget: 0n });
  assert.equal(await accepted(vm, gbatch([{ ...swapCall(), value: 1n }], needed(ONE))), false);
});

test('an amount above the per-call cap is rejected', async () => {
  const vm = await setup({ maxValuePerCall: 100n, valueBudget: ONE });
  assert.equal(await accepted(vm, gbatch([{ ...swapCall(), value: 101n }], needed(ONE))), false);
  assert.equal(await accepted(vm, gbatch([{ ...swapCall(), value: 100n }], needed(ONE))), true);
});

test('the total budget runs out and lets nothing more through', async () => {
  const vm = await setup({ maxValuePerCall: 100n, valueBudget: 150n });
  const spend = gbatch([{ ...swapCall(), value: 100n }], needed(ONE));
  assert.equal(await accepted(vm, spend), true, 'the first fits');
  assert.equal(await accepted(vm, spend), false, 'the second exceeds the budget');
});

test('a batch does not bypass the value budget by summing calls', async () => {
  const vm = await setup({ maxValuePerCall: 100n, valueBudget: 150n });
  const two = gbatch([{ ...swapCall(), value: 100n }, { ...swapCall(), value: 100n }], needed(2n * ONE));
  assert.equal(await accepted(vm, two), false);
});

// --------------------------------------------------- gas and operation count

test('the number of operations per session is bounded by maxOps', async () => {
  const vm = await setup({ maxOps: 2n });
  assert.equal(await accepted(vm, allowedBatch), true, 'first');
  assert.equal(await accepted(vm, allowedBatch), true, 'second');
  assert.equal(await accepted(vm, allowedBatch), false, 'third, beyond maxOps');
});

test('inflated gas fields do not slip past feeBudget', async () => {
  const vm = await setup({ feeBudget: 0n });
  const gassy = {
    accountGasLimits: packPair(100_000n, 200_000n),
    preVerificationGas: 50_000n,
    gasFees: packPair(0n, 10n),
  };
  assert.equal(await accepted(vm, allowedBatch, gassy), false);
  assert.equal(await accepted(vm, allowedBatch), true);
});

test('feeBudget is charged at the worst-case cost and runs out', async () => {
  const vm = await setup({ feeBudget: 4_000_000n });
  const gassy = {
    accountGasLimits: packPair(100_000n, 200_000n),
    preVerificationGas: 50_000n,
    gasFees: packPair(0n, 10n),
  };
  assert.equal(await accepted(vm, allowedBatch, gassy), true, 'the first within budget');
  assert.equal(await accepted(vm, allowedBatch, gassy), false, 'the second beyond');
});

// --------------------------------------------------------- approve

test('an approve to a foreign spender is rejected, to the router it passes', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: approveTo(STRANGER, ONE) }], 1n)), false);
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: approveTo(ROUTER, ONE) }], 1n)), true);
});

test('an approve above the token cap is refused, so no huge allowance is left behind', async () => {
  const vm = await setup({ maxPerOp: ONE, budget: 10n * ONE });
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: approveTo(ROUTER, ONE + 1n) }], 1n)), false);
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: approveTo(ROUTER, ONE) }], 1n)), true);
});

test('increaseAllowance is never granted', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { targets: [TOKEN], selectors: [INCREASE_ALLOWANCE] }), true);
  const vm2 = await setup();
  assert.equal(await accepted(vm2, gbatch([{ target: TOKEN, data: increaseTo(ROUTER) }], 1n)), false);
});

test('an approve with truncated arguments does not pass', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: APPROVE }], 1n)), false);
});

// ------------------------------------------------------- fee recipients

const COLLECTOR = '0xc011ec700000000000000000000000000000c0fe';

const feeSetup = (over = {}) => setup({
  targets: [TOKEN, TOKEN],
  selectors: [APPROVE, TRANSFER],
  feeRecipients: [COLLECTOR],
  maxFeePerOp: 1000n,
  ...over,
});

test('a transfer to the listed recipient within the cap passes', async () => {
  const vm = await feeSetup();
  assert.equal(await accepted(vm, gbatch([...sell(), { target: TOKEN, data: transferTo(COLLECTOR, 900n) }])), true);
});

test('a transfer to a FOREIGN address is rejected, even under the cap', async () => {
  const vm = await feeSetup();
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: transferTo(STRANGER, 1n) }], 1n)), false);
});

test('two transfers each under the cap are rejected by their sum', async () => {
  const vm = await feeSetup();
  assert.equal(await accepted(vm, gbatch([
    { target: TOKEN, data: transferTo(COLLECTOR, 600n) },
    { target: TOKEN, data: transferTo(COLLECTOR, 600n) },
  ], 1n)), false);
  assert.equal(await accepted(vm, gbatch([
    { target: TOKEN, data: transferTo(COLLECTOR, 600n) },
    { target: TOKEN, data: transferTo(COLLECTOR, 400n) },
  ], 1n)), true);
});

test('a transfer above the cap is rejected even to the listed recipient', async () => {
  const vm = await feeSetup();
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: transferTo(COLLECTOR, 1001n) }], 1n)), false);
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: transferTo(COLLECTOR, 1000n) }], 1n)), true);
});

test("one session's recipient does not act in another", async () => {
  const vm = await feeSetup();
  const ok = gbatch([{ target: TOKEN, data: transferTo(COLLECTOR, 100n) }], 1n);
  assert.equal(await accepted(vm, ok), true);
  assert.equal(await grantReverts(vm, {}), false);
  assert.equal(await accepted(vm, ok), false, 'the old recipient is dead');
});

test('a transfer does not pass when the session provided for none', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, gbatch([{ target: TOKEN, data: transferTo(COLLECTOR, 1n) }], 1n)), false);
});

test('a transfer pair without a cap is not granted at all', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { targets: [TOKEN], selectors: [TRANSFER], maxFeePerOp: 0n }), true);
});

test('a cap without recipients and recipients without a cap are not accepted', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { maxFeePerOp: 1000n }), true, 'a cap without recipients');
  assert.equal(await grantReverts(vm, { feeRecipients: [COLLECTOR] }), true, 'recipients without a cap');
});

test('the account itself and the zero address are not accepted as recipients', async () => {
  const vm = await freshVm();
  for (const bad of [ZERO, owner.address, ENTRY_POINT]) {
    assert.equal(await grantReverts(vm, { feeRecipients: [bad], maxFeePerOp: 1000n }), true, `recipient ${bad}`);
  }
});

// ------------------------------------------------- granting: what cannot be granted

const BANNED_SIGNATURES = [
  'transferFrom(address,address,uint256)',
  'setApprovalForAll(address,bool)',
  'safeTransferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256,bytes)',
  'safeTransferFrom(address,address,uint256,uint256,bytes)',
  'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)',
  'increaseAllowance(address,uint256)',
  'transferAndCall(address,uint256,bytes)',
  'approveAndCall(address,uint256,bytes)',
  'authorizeOperator(address)',
];

test('banned selectors computed from signatures are neither granted nor validated', async () => {
  const vm = await freshVm();
  for (const signature of BANNED_SIGNATURES) {
    const selector = toFunctionSelector(signature);
    assert.equal(await grantReverts(vm, {
      targets: [TOKEN], selectors: [selector], feeRecipients: [COLLECTOR], maxFeePerOp: 1000n,
    }), true, `granting ${signature} must revert`);
    // Nor as the swap selector, which the contract grants itself.
    assert.equal(await grantReverts(vm, { swap: { selector } }), true, `granting ${signature} as the swap must revert`);
  }
  const live = await setup();
  for (const signature of BANNED_SIGNATURES) {
    const selector = toFunctionSelector(signature);
    assert.equal(await accepted(live, gbatch([{ target: TOKEN, data: `${selector}${'00'.repeat(96)}` }], 1n)), false, `validating ${signature}`);
  }
});

test('token transfer selectors are not granted at all', async () => {
  const vm = await freshVm();
  for (const selector of [TRANSFER, PERMIT]) {
    assert.equal(await grantReverts(vm, { targets: [TOKEN], selectors: [selector] }), true, `granting ${selector} must revert`);
  }
});

test('the account itself and the EntryPoint are not granted as targets', async () => {
  const vm = await freshVm();
  for (const target of [owner.address, ENTRY_POINT]) {
    assert.equal(await grantReverts(vm, { targets: [target], selectors: ['0x12345678'] }), true, `target ${target} must revert the grant`);
  }
});

test('an eternal key and a key without an operation count are not granted', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { validUntil: 0n }), true, 'validUntil=0 must revert');
  assert.equal(await grantReverts(vm, { maxOps: 0n }), true, 'maxOps=0 must revert');
});

test('lists of different lengths are not accepted, the pairs must line up', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { targets: [TOKEN, STRANGER], selectors: [APPROVE] }), true);
});

test('a cap that forbids, or two caps for one token, are refused', async () => {
  const vm = await freshVm();
  assert.equal(await grantReverts(vm, { maxPerOp: 0n }), true, 'a zero cap');
  assert.equal(await grantReverts(vm, { budget: 0n }), true, 'a zero budget');
  assert.equal(await grantReverts(vm, { maxPerOp: 2n, budget: 1n }), true, 'a cap above its own budget');
  assert.equal(await grantReverts(vm, {
    tokenCaps: [
      { token: TOKEN, maxPerOp: 1n, budget: 1n, minOutPerUnit: 1n },
      { token: TOKEN, maxPerOp: 5n, budget: 5n, minOutPerUnit: 1n },
    ],
  }), true, 'two caps for one token');
  for (const bad of [ZERO, owner.address, ENTRY_POINT]) {
    assert.equal(await grantReverts(vm, {
      tokenCaps: [{ token: bad, maxPerOp: 1n, budget: 1n, minOutPerUnit: 1n }], targets: [], selectors: [],
    }), true, `a cap on ${bad}`);
  }
});

// ------------------------------------------------------- life cycle

test('an unregistered key fits nothing', async () => {
  const vm = await setup();
  const stranger = privateKeyToAccount(`0x${'33'.repeat(32)}`);
  assert.equal((await validate(vm, stranger, allowedBatch)).accepted, false);
});

test('a revoked key stops working immediately', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, allowedBatch), true);
  const revoke = await call(vm, {
    from: ENTRY_POINT, to: owner.address,
    data: encodeFunctionData({ abi: ABI, functionName: 'revokeSession', args: [session.address] }),
  });
  assert.equal(revoke.reverted, false);
  assert.equal(await accepted(vm, allowedBatch), false);
});

test('revokeSessions kills several keys in one call, and is closed to outsiders', async () => {
  const second = privateKeyToAccount(`0x${'44'.repeat(32)}`);
  const vm = await setup();
  assert.equal(await grantReverts(vm, { key: second.address }), false);
  assert.equal((await validate(vm, second, allowedBatch)).accepted, true);
  await fund(vm, STRANGER);
  const data = encodeFunctionData({ abi: ABI, functionName: 'revokeSessions', args: [[session.address, second.address]] });
  assert.equal((await call(vm, { from: STRANGER, to: owner.address, data })).reverted, true, 'an outsider cannot revoke');
  assert.equal((await call(vm, { from: ENTRY_POINT, to: owner.address, data })).reverted, false);
  assert.equal((await validate(vm, session, allowedBatch)).accepted, false);
  assert.equal((await validate(vm, second, allowedBatch)).accepted, false);
});

test('revoke and re-grant do not resurrect old rights or old budgets', async () => {
  const vm = await setup();
  assert.equal(await accepted(vm, allowedBatch), true);
  const revoke = await call(vm, {
    from: ENTRY_POINT, to: owner.address,
    data: encodeFunctionData({ abi: ABI, functionName: 'revokeSession', args: [session.address] }),
  });
  assert.equal(revoke.reverted, false);
  // A re-grant to the same key, with a smaller cap and a higher price.
  assert.equal(await grantReverts(vm, { maxPerOp: ONE / 2n, budget: ONE, minOutPerUnit: 2n * PRICE }), false);
  assert.equal(await accepted(vm, gbatch([swapCall()], needed(ONE, 2n * PRICE))), false, 'the old size is over the new cap');
  const half = ONE / 2n;
  assert.equal(await accepted(vm, gbatch([swapCall([{ token: TOKEN, amount: half }])], needed(half, 2n * PRICE))), true);
  assert.equal((await budgetOf(vm, session.address, TOKEN)).spent, half, 'the epoch started from zero');
});

// --------------------------------------------------------------- access

test('an outsider cannot grant themselves a key', async () => {
  const vm = await setup();
  await fund(vm, STRANGER);
  const attempt = await call(vm, {
    from: STRANGER, to: owner.address, data: grantData({ key: STRANGER }),
  });
  assert.equal(attempt.reverted, true);
});

test('validateUserOp accepts calls from the EntryPoint only', async () => {
  const vm = await setup();
  await fund(vm, STRANGER);
  const hash = keccak256(toHex('anything'));
  const attempt = await call(vm, {
    from: STRANGER,
    to: owner.address,
    data: encodeFunctionData({
      abi: ABI,
      functionName: 'validateUserOp',
      args: [userOp(owner.address, allowedBatch, await owner.sign({ hash })), hash, 0n],
    }),
  });
  assert.equal(attempt.reverted, true);
});

test('execute and executeBatch are closed to outsiders', async () => {
  const vm = await setup();
  await fund(vm, STRANGER);
  const attempt = await call(vm, { from: STRANGER, to: owner.address, data: allowedBatch });
  assert.equal(attempt.reverted, true);
});

