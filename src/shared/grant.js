// Checks an assembled operation against the grant issued to the key ON CHAIN.
//
// runner-verify.js checks that the operation matches the ORDER: right wallet,
// right token, no transfers. This module checks that it matches what the owner
// ALLOWED this key in `grantSession`. Different questions, different sources
// of truth: the order lives in storage, the grant lives on chain.
//
// The contract performs the same check itself, but its refusal comes back as
// an opaque bundler error ("AA23 reverted") that does not say WHICH limit
// failed. Here the same refusal gets a name and a number, before sending and
// for free. It is not a replacement for the contract: the values read may be a
// block stale and the node may lie. The last word stays with on-chain
// validation; this is diagnostics and an early refusal.

import { parseSwapArgs } from './swap-args.js';

const lower = (v) => String(v ?? '').toLowerCase();
const selectorOf = (data) => lower(String(data ?? '').slice(0, 10));
const ZERO = '0x0000000000000000000000000000000000000000';
const PRICE_SCALE = 10n ** 18n;

const SEL_TRANSFER = '0xa9059cbb';
const SEL_APPROVE = '0x095ea7b3';
const SEL_SNAPSHOT = '0x204e94b0';       // snapshot(address,address)
const SEL_ASSERT_GAINED = '0xdb794558';  // assertGained(address,address,uint256)

/** Argument word `index` as a number; null when the word is missing. */
function amountArg(data, index) {
  const hex = String(data ?? '').replace(/^0x/, '');
  const word = hex.slice(8 + index * 64, 8 + index * 64 + 64);
  return word.length < 64 ? null : BigInt(`0x${word}`);
}

/** Argument word `index` as an address (the low 20 bytes); null when missing. */
function addressArg(data, index) {
  const hex = String(data ?? '').replace(/^0x/, '');
  const word = hex.slice(8 + index * 64, 8 + index * 64 + 64);
  return word.length < 64 ? null : `0x${word.slice(24)}`.toLowerCase();
}

/**
 * The execution template of a guarded key, as the contract checks it: first
 * call snapshot(settlementToken, depository), last call assertGained(same,
 * floor), the guard nowhere else. Returns {reason} or {floor}.
 */
function templateProblem(calls, grant) {
  const guard = lower(grant.guard);
  const token = lower(grant.guardToken);
  const holder = lower(grant.guardHolder);
  if (calls.length < 2) return { reason: 'a guarded key sends batches of at least two calls: snapshot, the trade, assertGained' };
  const first = calls[0];
  const last = calls[calls.length - 1];
  const onGuard = (c, sel, len) => lower(c.target) === guard && selectorOf(c.data) === sel
    && String(c.data ?? '').replace(/^0x/, '').length === len * 2
    && addressArg(c.data, 0) === token && addressArg(c.data, 1) === holder;
  if (!onGuard(first, SEL_SNAPSHOT, 68)) {
    return { reason: `the batch must open with guard.snapshot(${token}, ${holder}), the grant's template` };
  }
  if (!onGuard(last, SEL_ASSERT_GAINED, 100)) {
    return { reason: `the batch must close with guard.assertGained(${token}, ${holder}, floor), the grant's template` };
  }
  const floor = amountArg(last.data, 2) ?? 0n;
  if (floor === 0n) return { reason: 'the guard floor is zero, the contract requires a gain above zero' };
  for (let i = 1; i + 1 < calls.length; i += 1) {
    if (lower(calls[i].target) === guard) return { reason: 'the guard may appear only as the first and the last call' };
  }
  return { floor };
}

/**
 * Whether the operation fits the issued grant.
 *
 * @param {object} opts
 * @param {{target: string, data: string}[]} opts.calls decoded batch calls
 * @param {object} opts.grant the Session read from the contract
 * @param {string} opts.account the wallet the operation is for
 * @param {(target: string, selector: string) => boolean} opts.isAllowed pair is granted
 * @param {(to: string) => boolean} opts.isFeeRecipient address accepted as fee recipient
 * @param {(token: string) => {exists: boolean, maxPerOp: bigint, budget: bigint, spent: bigint, minOutPerUnit: bigint}|null} opts.tokenBudgetOf
 *   the on-chain TokenBudget of a token
 * @param {number} opts.now seconds, not ms: validUntil on chain is in seconds
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkAgainstGrant({ calls, grant, account, isAllowed, isFeeRecipient, tokenBudgetOf, now }) {
  if (!grant?.exists) {
    return {
      ok: false,
      reason: 'this key has no grant on chain, grantSession is required for its address',
    };
  }

  const validUntil = Number(grant.validUntil ?? 0);
  if (validUntil && now > validUntil) {
    const ago = Math.round((now - validUntil) / 60);
    return { ok: false, reason: `the key expired ${ago} min ago, the grant renews itself when fomo.family is open in the browser that placed the order` };
  }

  const maxOps = BigInt(grant.maxOps ?? 0);
  const opsUsed = BigInt(grant.opsUsed ?? 0);
  if (opsUsed >= maxOps) {
    return {
      ok: false,
      reason: `the key has used all operations: ${opsUsed} of ${maxOps}, the grant renews itself when fomo.family is open in the browser that placed the order`,
    };
  }

  // The template first: with a guard on the grant, a batch of the wrong shape
  // is refused before its contents are looked at, as in the contract.
  const guarded = grant.guard && lower(grant.guard) !== ZERO;
  let floor = 0n;
  if (guarded) {
    const verdict = templateProblem(calls, grant);
    if (verdict.reason) return { ok: false, reason: verdict.reason };
    floor = verdict.floor;
  }

  // Sums are per OPERATION and per TOKEN, as in the contract, and they come
  // from the SWAP's own arguments rather than from `approve`: an allowance
  // that already stands would otherwise cost nothing.
  const soldByToken = new Map();
  let requiredFloor = 0n;
  let feeTotal = 0n;
  for (const call of calls) {
    const target = lower(call.target);
    const selector = selectorOf(call.data);

    if (!isAllowed(target, selector)) {
      return {
        ok: false,
        reason: `pair (${target}, ${selector}) is not granted to the key, add it in grantSession`,
      };
    }

    if (guarded && target === lower(grant.swapRouter) && selector === lower(grant.swapSelector)) {
      const args = parseSwapArgs(call.data);
      if (!args) return { ok: false, reason: 'the swap call does not decode, the contract would refuse it' };
      for (let i = 0; i < args.tokens.length; i += 1) {
        const token = args.tokens[i];
        const tb = typeof tokenBudgetOf === 'function' ? tokenBudgetOf(token) : null;
        if (!tb?.exists) return { ok: false, reason: `${token} has no cap in the grant, selling it is forbidden` };
        soldByToken.set(token, (soldByToken.get(token) ?? 0n) + args.amounts[i]);
        requiredFloor += (args.amounts[i] * BigInt(tb.minOutPerUnit ?? 0)) / PRICE_SCALE;
      }
    }

    if (selector === SEL_APPROVE) {
      const allowance = amountArg(call.data, 1);
      const tb = typeof tokenBudgetOf === 'function' ? tokenBudgetOf(target) : null;
      if (!tb?.exists) return { ok: false, reason: `${target} has no cap in the grant, approve of it is forbidden` };
      if (allowance !== null && allowance > BigInt(tb.maxPerOp ?? 0)) {
        return { ok: false, reason: `approve of ${allowance} exceeds the cap ${tb.maxPerOp} for ${target}` };
      }
    }

    if (selector === SEL_TRANSFER) {
      const to = addressArg(call.data, 0);
      if (!isFeeRecipient(to)) {
        return { ok: false, reason: `${to} is not granted as a fee recipient in grantSession` };
      }
      const amount = amountArg(call.data, 1);
      if (amount !== null) feeTotal += amount;
    }
  }

  for (const [token, sold] of soldByToken) {
    const tb = tokenBudgetOf(token);
    const cap = BigInt(tb.maxPerOp ?? 0);
    if (sold > cap) {
      return {
        ok: false,
        reason: `the swap sells ${sold} of ${token}, above the cap ${cap}, the order is larger than the grant allows`,
      };
    }
    const left = BigInt(tb.budget ?? 0) - BigInt(tb.spent ?? 0);
    if (sold > left) {
      return { ok: false, reason: `the swap sells ${sold} of ${token}, above the remaining budget ${left}, a new grant is needed` };
    }
  }

  if (guarded && floor < requiredFloor) {
    return {
      ok: false,
      reason: `the guard floor ${floor} is below the ${requiredFloor} the granted price demands for this amount`,
    };
  }

  const feeCap = BigInt(grant.maxFeePerOp ?? 0);
  if (feeTotal > feeCap) {
    return { ok: false, reason: `fee ${feeTotal} exceeds the cap ${feeCap} (maxFeePerOp)` };
  }

  return { ok: true, reason: null };
}
