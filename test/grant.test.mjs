// Checking an operation against the grant issued to the key on chain.
//
// The point of this layer is clarity, not security (the contract provides
// that): the user must learn the NAME of the limit that failed rather than
// "AA23 reverted" from the bundler. So what is checked above all is that a
// refusal carries a name and a number, and that this reading of a batch
// agrees with the contract's, which the EVM tests pin separately.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encodeAbiParameters } from 'viem';

import { checkAgainstGrant } from '../src/shared/grant.js';
import { GUARD_ADDRESS, GUARD_CASH, RELAY_DEPOSITORY, guardCalls } from '../src/shared/output-guard.js';

const ACCOUNT = '0xabababababababababababababababababababab';
const TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const TOKEN_B = '0x2222222222222222222222222222222222222222';
const ROUTER = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const COLLECTOR = '0xc011ec700000000000000000000000000000c0fe';
const STRANGER = '0x1111111111111111111111111111111111111111';
const SWAP = '0xf9e4bab4';

const NOW = 1_800_000_000; // seconds: validUntil on chain is in seconds
const PRICE_SCALE = 10n ** 18n;
const ONE = 10n ** 18n;
const PRICE = 10n ** 6n; // one token of eighteen decimals for one settlement unit of six
const needed = (amount, price = PRICE) => (amount * price) / PRICE_SCALE;

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.replace(/^0x/, '').padStart(64, '0');

const approve = (spender, amount) => `0x095ea7b3${addrWord(spender)}${word(amount)}`;
const transfer = (to, amount) => `0xa9059cbb${addrWord(to)}${word(amount)}`;

const SWAP_HEAD = [
  { type: 'address[]' },
  { type: 'uint256[]' },
  { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'bytes' }] },
  { type: 'address' },
  { type: 'address' },
  { type: 'bytes' },
];
const swap = (sales = [{ token: TOKEN, amount: ONE }], refundTo = ACCOUNT) => ({
  target: ROUTER,
  data: `${SWAP}${encodeAbiParameters(SWAP_HEAD, [sales.map((s) => s.token), sales.map((s) => s.amount), [], refundTo, refundTo, '0x']).slice(2)}`,
});

/** The template as the runner builds it: on the wallet, at the price's floor. */
const wrap = (calls, floor = needed(ONE)) => {
  const g = guardCalls({ chainId: 4663, minGain: floor });
  return [g.before, ...calls, g.after];
};

const grant = (over = {}) => ({
  exists: true,
  validUntil: NOW + 3600,
  maxOps: 100n,
  opsUsed: 3n,
  maxFeePerOp: 1000n,
  guard: GUARD_ADDRESS,
  guardToken: GUARD_CASH[4663].token,
  guardHolder: RELAY_DEPOSITORY,
  swapRouter: ROUTER,
  swapSelector: SWAP,
  ...over,
});

const budgets = (over = {}) => (token) => ({
  [TOKEN]: { exists: true, maxPerOp: 2n * ONE, budget: 10n * ONE, spent: 0n, minOutPerUnit: PRICE },
  [TOKEN_B]: { exists: true, maxPerOp: ONE, budget: ONE, spent: 0n, minOutPerUnit: 2n * PRICE },
  ...over,
}[token] ?? { exists: false });

const check = (over = {}) => checkAgainstGrant({
  calls: over.calls ?? wrap([{ target: TOKEN, data: approve(ROUTER, ONE) }, swap()]),
  grant: over.grant ?? grant(),
  account: over.account ?? ACCOUNT,
  isAllowed: over.isAllowed ?? (() => true),
  isFeeRecipient: over.isFeeRecipient ?? ((to) => to === COLLECTOR),
  tokenBudgetOf: over.tokenBudgetOf ?? budgets(),
  now: over.now ?? NOW,
});

test('an operation within the limits passes', () => {
  const r = check();
  assert.equal(r.ok, true, r.reason);
});

test('a key without a grant is named as such, not "refused"', () => {
  const r = check({ grant: { exists: false } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /grantSession/);
});

test('an expired key says how long ago it expired', () => {
  const r = check({ grant: grant({ validUntil: NOW - 600 }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired 10 min ago/);
});

test('exhausted operations show the count', () => {
  const r = check({ grant: grant({ maxOps: 5n, opsUsed: 5n }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /5 of 5/);
});

test('a missing pair names both the target and the selector', () => {
  const r = check({ isAllowed: (t) => t !== ROUTER });
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(ROUTER));
  assert.match(r.reason, /0xf9e4bab4/);
});

test('the sale is measured by the SWAP, so a standing allowance is not free', () => {
  // No approve in the batch at all: the swap's own arguments say what leaves.
  const r = check({ calls: wrap([swap([{ token: TOKEN, amount: 3n * ONE }])], needed(3n * ONE)) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sells 3000000000000000000 of 0x0bd7/);
  assert.match(r.reason, /above the cap 2000000000000000000/);
});

test('an exhausted budget names the remainder', () => {
  const r = check({
    calls: wrap([swap()], needed(ONE)),
    tokenBudgetOf: budgets({ [TOKEN]: { exists: true, maxPerOp: 2n * ONE, budget: 10n * ONE, spent: (10n * ONE) - (ONE / 2n), minOutPerUnit: PRICE } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /above the remaining budget 500000000000000000/);
});

test('two sales of one token are summed, two tokens are not', () => {
  const twice = wrap([swap([{ token: TOKEN, amount: (3n * ONE) / 2n }]), swap([{ token: TOKEN, amount: ONE }])], needed((5n * ONE) / 2n));
  assert.match(check({ calls: twice }).reason, /sells 2500000000000000000 of 0x0bd7/);
  const both = wrap([swap([{ token: TOKEN, amount: ONE }, { token: TOKEN_B, amount: ONE }])], needed(ONE) + needed(ONE, 2n * PRICE));
  assert.equal(check({ calls: both }).ok, true);
});

test('the floor must meet the price the owner fixed', () => {
  assert.equal(check({ calls: wrap([swap()], needed(ONE)) }).ok, true);
  const short = check({ calls: wrap([swap()], needed(ONE) - 1n) });
  assert.equal(short.ok, false);
  assert.match(short.reason, /guard floor 999999 is below the 1000000 the granted price demands/);
  assert.match(check({ calls: wrap([swap()], 1n) }).reason, /below the 1000000/);
});

test('a token with no cap in the grant can be neither sold nor approved', () => {
  assert.match(check({ calls: wrap([swap([{ token: STRANGER, amount: 1n }])], needed(ONE)) }).reason, /no cap in the grant/);
  assert.match(check({ calls: wrap([{ target: STRANGER, data: approve(ROUTER, 1n) }], 1n) }).reason, /approve of it is forbidden/);
});

test('an approve above the token cap is named', () => {
  const r = check({ calls: wrap([{ target: TOKEN, data: approve(ROUTER, 3n * ONE) }], 1n) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /approve of 3000000000000000000 exceeds the cap 2000000000000000000/);
});

test('a swap call that does not decode is refused rather than guessed at', () => {
  const r = check({ calls: wrap([{ target: ROUTER, data: `${SWAP}0000` }], needed(ONE)) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not decode/);
});

test('a fee above the cap names both values', () => {
  const r = check({
    calls: wrap([swap(), { target: TOKEN, data: transfer(COLLECTOR, 2000n) }], needed(ONE)),
    grant: grant({ maxFeePerOp: 10n }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fee 2000 exceeds the cap 10/);
});

test('a foreign fee recipient is named by address', () => {
  const r = check({ calls: wrap([{ target: TOKEN, data: transfer(STRANGER, 10n) }], 1n) });
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(STRANGER));
});

test('a zero validUntil is not treated as expired', () => {
  const r = check({ grant: grant({ validUntil: 0 }) });
  assert.equal(r.ok, true, r.reason);
});

test('the template is checked as the contract checks it, and the refusal says which part', () => {
  const trade = [{ target: TOKEN, data: approve(ROUTER, ONE) }, swap()];
  const g = guardCalls({ chainId: 4663, minGain: needed(ONE) });
  assert.match(check({ calls: trade }).reason, /must open with guard\.snapshot/);
  assert.match(check({ calls: [g.before, ...trade] }).reason, /must close with guard\.assertGained/);
  assert.match(check({ calls: [g.before, ...trade, g.before, g.after] }).reason, /only as the first and the last/);
  const zeroFloor = { target: g.after.target, data: `${g.after.data.slice(0, -64)}${'00'.repeat(32)}` };
  assert.match(check({ calls: [g.before, ...trade, zeroFloor] }).reason, /floor is zero/);
  assert.match(check({ calls: [g.before] }).reason, /at least two calls/);
  // A grant without a template checks no template.
  const bare = { ...grant(), guard: '0x0000000000000000000000000000000000000000' };
  assert.equal(check({ calls: [{ target: ROUTER, data: swap().data }], grant: bare }).ok, true);
});
