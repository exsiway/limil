// Grant planning: what to request and when to re-issue.
//
// WHY THESE TESTS. These two functions decide when the extension signs an
// operation that changes the rights on the wallet on its own. A mistake here
// means either a re-issue on every order placement, or a key without rights
// that learns about it from a bundler refusal at night.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  GRANT_DAYS, OPS_FLOOR, PRICE_SCALE, RENEW_BEFORE_MS,
  grantCovers, planGrant,
} from '../src/shared/grant-plan.js';
import { GUARD_ADDRESS, GUARD_CASH, RELAY_DEPOSITORY, guardSpecFor } from '../src/shared/output-guard.js';

const NOW = 1788240000000;
const ROUTER = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const SWAP = '0xf9e4bab4';
const TOKEN = '0x4444444444444444444444444444444444444444';
const GUARD = guardSpecFor(4663);
const opts = { router: ROUTER, swapSelector: SWAP, guard: GUARD, chainId: 4663, now: NOW };

// A live order carries a target and a tolerance: those are what the grant's
// price per token is derived from, and without them a token cannot be priced
// and is left out of the plan.
const order = (over = {}) => ({
  status: 'watching', inTokenId: `${TOKEN}:4663`, amount: '555050000000000000000',
  targetOut: String(1000n * 10n ** 18n), maxSlippageBps: 0, ...over,
});

/** The on-chain Session a plan would have produced. */
const grantFrom = (plan, over = {}) => ({
  exists: true,
  validUntil: plan.validUntil,
  maxOps: plan.maxOps,
  opsUsed: 0,
  maxFeePerOp: plan.maxFeePerOp,
  guard: plan.guard.guard,
  guardToken: plan.guard.settlementToken,
  guardHolder: plan.guard.depository,
  swapRouter: plan.swap.router,
  swapSelector: plan.swap.selector,
  ...over,
});
/** The on-chain TokenBudget reader a plan would have produced, with overrides per token. */
const budgetsFrom = (plan, over = {}) => (token) => {
  const cap = plan.tokenCaps.find((c) => c.token === token);
  if (!cap) return { exists: false };
  return {
    exists: true, maxPerOp: cap.maxPerOp, budget: cap.budget, spent: 0n, minOutPerUnit: cap.minOutPerUnit,
    ...(over[token] ?? {}),
  };
};
const allowAll = () => true;
const covers = (grant, plan, over = {}) => grantCovers(grant, plan, {
  now: NOW, isAllowed: allowAll, tokenBudgetOf: budgetsFrom(plan), ...over,
});

test('without live orders there is nothing to plan', () => {
  assert.equal(planGrant([], opts), null);
  assert.equal(planGrant([order({ status: 'filled' })], opts), null);
});

test('the per-operation cap follows the LARGEST order of the token, not their sum', () => {
  // A cap equal to the sum of all orders would let a leaked key sell the
  // whole position in one operation.
  const plan = planGrant([order(), order({ amount: '100000000000000000000' })], opts);
  assert.equal(plan.tokenCaps.length, 1);
  assert.equal(plan.tokenCaps[0].token, TOKEN);
  assert.equal(plan.tokenCaps[0].maxPerOp, 555050000000000000000n);
  // The budget: the orders plus one retry of the largest.
  assert.equal(plan.tokenCaps[0].budget, 555050000000000000000n * 2n + 100000000000000000000n);
});

test('each token carries the owner\'s price, and the least demanding live order sets it', () => {
  // The price is what stops a leaked key choosing its own floor. When two
  // orders of one token are live the lower target has to set it, or the
  // cheaper of the two could never execute.
  const dear = order({ targetOut: String(2000n * 10n ** 18n) });
  const cheap = order({ targetOut: String(1000n * 10n ** 18n) });
  const plan = planGrant([dear, cheap], opts);
  const cap = plan.tokenCaps[0];
  // 1000 USDG for 555.05 tokens, in six decimals, per 1e18 raw units.
  const expected = (1000n * 10n ** 6n * PRICE_SCALE) / 555050000000000000000n;
  assert.equal(cap.minOutPerUnit, expected);
  assert.ok(cap.minOutPerUnit > 0n);
});

test('an order that cannot be priced is left out rather than pricing the token at zero', () => {
  const plan = planGrant([order(), order({ targetOut: '0' })], opts);
  assert.equal(plan.tokenCaps.length, 1);
  assert.ok(plan.tokenCaps[0].minOutPerUnit > 0n, 'the unpriced order did not drag the floor to nothing');
  assert.equal(planGrant([order({ targetOut: '0' })], opts), null, 'and alone it is no plan at all');
});

test('caps are per token: a 6-decimal token gets its own numbers', () => {
  const six = '0x6666666666666666666666666666666666666666';
  const plan = planGrant([order(), order({ inTokenId: `${six}:4663`, amount: '1000000' })], opts);
  const byToken = Object.fromEntries(plan.tokenCaps.map((c) => [c.token, c]));
  assert.equal(byToken[six].maxPerOp, 1000000n);
  assert.equal(byToken[six].budget, 2000000n);
  assert.equal(byToken[TOKEN].maxPerOp, 555050000000000000000n, 'the 18-decimal token is not enlarged by the other');
  assert.notEqual(byToken[six].minOutPerUnit, byToken[TOKEN].minOutPerUnit, 'and its price is its own');
});

test('the term and the operation count are requested with headroom', () => {
  const plan = planGrant([order()], opts);
  assert.equal(plan.validUntil, Math.floor(NOW / 1000) + GRANT_DAYS * 86400);
  assert.equal(plan.maxOps, OPS_FLOOR, 'one order still needs headroom for retries');
});

test('the pair list is the tokens alone: the router and the guard come with the grant', () => {
  const other = '0x1111111111111111111111111111111111111111';
  const plan = planGrant([order(), order({ inTokenId: `${other}:4663` })], opts);
  assert.equal(plan.targets.length, 2, 'two tokens with one approve pair each');
  assert.ok(!plan.targets.includes(ROUTER), 'the contract grants the router from the swap spec and refuses it in the list');
  assert.ok(!plan.targets.includes(GUARD_ADDRESS), 'and the guard pairs likewise');
  assert.deepEqual(plan.swap, { router: ROUTER, selector: SWAP });
  assert.deepEqual(plan.guard, { guard: GUARD_ADDRESS, settlementToken: GUARD_CASH[4663].token, depository: RELAY_DEPOSITORY });
  // No fee, so no collectors, and the key gets no transfer pair.
  assert.deepEqual(plan.feeRecipients, []);
  assert.ok(!plan.selectors.includes('0xa9059cbb'), 'transfer is not among the pairs');
  assert.equal(plan.maxFeePerOp, 0n);
});

test('a plan without the guard template or the router is refused, not silently unguarded', () => {
  assert.throws(() => planGrant([order()], { ...opts, guard: null }), /output guard/);
  assert.throws(() => planGrant([order()], { ...opts, guard: { guard: GUARD_ADDRESS } }), /output guard/);
  assert.throws(() => planGrant([order()], { ...opts, router: null }), /router/);
  assert.throws(() => planGrant([order()], { ...opts, chainId: 1 }), /settlement token/);
  assert.equal(guardSpecFor(1), null, 'a chain without a settlement token has no template');
});

test('native value is never granted to the key', () => {
  const plan = planGrant([order()], opts);
  assert.equal(plan.maxValuePerCall, 0n);
  assert.equal(plan.valueBudget, 0n);
});

test('a grant covers its own plan, no re-issue needed', () => {
  const plan = planGrant([order()], opts);
  const res = covers(grantFrom(plan), plan);
  assert.equal(res.ok, true, res.missing.join('; '));
});

test('a grant that was never issued needs issuing', () => {
  const plan = planGrant([order()], opts);
  const res = grantCovers({ exists: false }, plan, { now: NOW });
  assert.equal(res.ok, false);
  assert.match(res.missing[0], /has no grant/);
});

test('the grant is renewed AHEAD of time, not in the last hour', () => {
  // Renewing at expiry would open a window in which the order is alive and
  // there is nothing to execute it with, discovered as a refusal at night.
  const plan = planGrant([order()], opts);
  const nearly = grantFrom(plan, { validUntil: Math.floor((NOW + RENEW_BEFORE_MS - 1000) / 1000) });
  const res = covers(nearly, plan);
  assert.equal(res.ok, false);
  assert.match(res.missing.join(' '), /the key expires/);
});

test('a visit renews the grant long before the last day, so a fortnight away never ends orders', () => {
  // Renewal happens only while a FOMO tab is open; a threshold of one day
  // would let daily use end in a silent stop after one week of absence.
  const plan = planGrant([order()], opts);
  const day = 86400;
  const twentyDaysLeft = grantFrom(plan, { validUntil: Math.floor(NOW / 1000) + 20 * day });
  assert.equal(covers(twentyDaysLeft, plan).ok, false, 'twenty days left: renew now');
  const twentyFiveDaysLeft = grantFrom(plan, { validUntil: Math.floor(NOW / 1000) + 25 * day });
  assert.equal(covers(twentyFiveDaysLeft, plan).ok, true, 'twenty-five days left: nothing to do');
  assert.ok(RENEW_BEFORE_MS >= 14 * day * 1000, 'at least two weeks of execution follow every visit');
  assert.ok(OPS_FLOOR >= 20 * 3, 'ops headroom covers retries of several orders between visits');
});

test('exhausted operations need a re-issue', () => {
  const plan = planGrant([order()], opts);
  const res = covers(grantFrom(plan, { opsUsed: plan.maxOps - 1 }), plan);
  assert.equal(res.ok, false);
  assert.match(res.missing.join(' '), /operations left/);
});

test('an order that grew does not fit the old cap', () => {
  // The cap was issued against the previous balance.
  const plan = planGrant([order({ amount: '900000000000000000000', targetOut: String(1621n * 10n ** 18n) })], opts);
  const oldPlan = planGrant([order()], opts);
  const res = grantCovers(grantFrom(oldPlan), plan, { now: NOW, isAllowed: allowAll, tokenBudgetOf: budgetsFrom(oldPlan) });
  assert.equal(res.ok, false);
  assert.match(res.missing.join(' '), /approve cap/);
  assert.match(res.missing.join(' '), new RegExp(TOKEN), 'the token is named');
});

test('a token without a cap on chain, and a budget nearly spent, are both named', () => {
  const six = '0x6666666666666666666666666666666666666666';
  const plan = planGrant([order(), order({ inTokenId: `${six}:4663`, amount: '1000000' })], opts);
  const onlyFirst = (token) => (token === TOKEN ? budgetsFrom(plan)(token) : { exists: false });
  const missingCap = covers(grantFrom(plan), plan, { tokenBudgetOf: onlyFirst });
  assert.equal(missingCap.ok, false);
  assert.match(missingCap.missing.join(' '), new RegExp(six));
  const nearlySpent = covers(grantFrom(plan), plan, { tokenBudgetOf: budgetsFrom(plan, { [six]: { spent: 1500000n } }) });
  assert.equal(nearlySpent.ok, false);
  assert.match(nearlySpent.missing.join(' '), /approve budget left 500000/);
});

test('a different template, router or price on chain means a re-grant', () => {
  const plan = planGrant([order()], opts);
  const wrongToken = covers(grantFrom(plan, { guardToken: GUARD_CASH[8453].token }), plan);
  assert.equal(wrongToken.ok, false);
  assert.match(wrongToken.missing.join(' '), /guard template/);
  assert.equal(covers(grantFrom(plan, { guard: '0x0000000000000000000000000000000000000000' }), plan).ok, false);
  assert.equal(covers(grantFrom(plan, { swapRouter: '0x1111111111111111111111111111111111111111' }), plan).ok, false, 'another router');
  assert.equal(covers(grantFrom(plan, { swapSelector: '0xdeadbeef' }), plan).ok, false, 'another selector');
  // The price on chain must be the plan's exactly: higher and the honest
  // batch's floor falls short, lower and the bound is weaker than the live
  // orders justify.
  const cheaper = covers(grantFrom(plan), plan, {
    tokenBudgetOf: budgetsFrom(plan, { [TOKEN]: { minOutPerUnit: plan.tokenCaps[0].minOutPerUnit - 1n } }),
  });
  assert.equal(cheaper.ok, false);
  assert.match(cheaper.missing.join(' '), /floor price/);
});

test('a missing pair is named', () => {
  // The router is no longer in the pair list, so the pair that can go missing
  // is a token's approve.
  const plan = planGrant([order()], opts);
  const res = covers(grantFrom(plan), plan, { isAllowed: (t) => t !== TOKEN });
  assert.equal(res.ok, false);
  assert.match(res.missing.join(' '), new RegExp(TOKEN));
});

test('a Solana token sell does not enter the EVM grant', async () => {
  const { SOLANA_NETWORK_ID } = await import('../src/shared/chains.js');
  const sol = order({ inTokenId: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:${SOLANA_NETWORK_ID}` });
  assert.equal(planGrant([sol], opts), null, 'a single Solana sell, no plan');
  const plan = planGrant([order(), sol], opts);
  assert.equal(plan.tokenCaps.length, 1, 'the Solana token gets no cap');
  assert.deepEqual(plan.targets, [TOKEN], 'and no approve pair');
});
