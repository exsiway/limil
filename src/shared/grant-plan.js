// Which grant the live orders need, and whether the issued grant covers it.
//
// The user never issues a grant by hand. They place an order; the extension
// decides whether the session key has enough rights to execute it and, if not,
// requests exactly what is missing. Two pure functions: "what is needed" and
// "does the existing grant cover it".
//
// This differs from grant.js, which checks an ASSEMBLED operation against the
// grant before sending. Here nothing is assembled yet: the plan is computed
// from the order list alone.
//
// Why the per-operation cap is one order's size and not the balance. The
// (router, swap selector) pair is granted as a whole: the contract does not
// parse the router calldata, so the swap recipient is checked by nobody, and
// anyone can request a relay quote with any recipient. A leaked key can
// therefore route up to the cap per operation to anyone. Capping it at the
// largest live order of THAT token, rather than the balance, is the whole
// difference between "one order per operation" and "everything per operation".
//
// Caps are per token (contract version 2): raw units of an 18-decimal token
// and a 6-decimal token do not add, so each token the key may approve gets
// its own cap and its own budget. Sums are per batch, not per call (the
// contract adds up every approve of one token in a batch), and the budget caps
// the whole session: the first real bound on the loss from a leaked key. It is
// the sum of the live orders of that token plus one retry, not cap × ops.
//
// The plan also names the execution template and the price. The contract
// requires every operation to bracket itself with the guard on the relay
// depository and to demand at least what the sold amount is worth at
// `minOutPerUnit`, a price taken from the order's own target. So a leaked key
// can neither skip the guard nor name a floor of its own. On version 3 it can
// still direct the proceeds to itself, because the payout is named in an
// off-chain quote the chain never sees; the bound on that is the per-token
// budget.
//
// `minOutPerUnit` is settlement units per 1e18 raw units of the token. When
// several orders of one token are live, the LEAST demanding of them sets it,
// or the others could not execute; the bound is therefore the lowest live
// target on that token, which is stated here rather than glossed over.

import { chainFromTokenId } from './orders.js';
import { SOLANA_NETWORK_ID } from './chains.js';
import { guardFloor, settlementFor } from './output-guard.js';
import { t } from './i18n.js';

/** The one selector a sell order needs on its token: approve for the router. */
export const SEL_APPROVE = '0x095ea7b3';

/**
 * Default grant lifetime. An open-ended grant is deliberately not issued: an
 * abandoned installation would otherwise remain a standing risk forever.
 * Thirty days with automatic renewal while a tab is alive is indistinguishable
 * from forever for the user and puts a limit on a forgotten machine.
 */
export const GRANT_DAYS = 30;

/**
 * Renew EARLY: whenever less than three weeks of the thirty days remain.
 *
 * The grant is renewed only when a FOMO tab is open in the owner's browser
 * (the owner signs, silently, through Privy). Renewing in the last day would
 * mean that a person who used the site daily for a month and then left for a
 * week comes back to orders that stopped, without a word. With this threshold
 * every visit leaves at least three weeks of execution behind it, and regular
 * use costs one renewal per nine days or so. The limit must never be
 * something the person discovers; it exists for a leaked key, not for them.
 */
export const RENEW_BEFORE_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * Operations reserved per order: a failed validation consumes one too, and
 * a guard revert in the bundler's simulation counts as one. Generous on
 * purpose: the count bounds nothing the per-token budget does not already
 * bound, while running out of it would stop orders quietly between visits.
 */
const OPS_PER_ORDER = 10;
/** Never request fewer: retries across several orders must not hit the ceiling. */
export const OPS_FLOOR = 60;

const lower = (v) => String(v ?? '').toLowerCase();
/** Fixed-point scale of tokenCaps[].minOutPerUnit, as in the contract. */
export const PRICE_SCALE = 10n ** 18n;
const tokenOf = (order) => lower(String(order?.inTokenId ?? '').split(':')[0]);
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * What to request from `grantSession` for these orders to execute.
 *
 * @param {object[]} orders live orders (status watching)
 * @param {object} opts
 * @param {string} opts.router relay router address; the ONE contract the key
 *   may hand tokens to, granted by the contract itself
 * @param {string} opts.swapSelector the one function on it, whose arguments
 *   the contract parses
 * @param {{guard: string, settlementToken: string}} opts.guard the execution
 *   template (output-guard.js guardSpecFor); required, selling without it is
 *   unbounded, and the contract refuses such a grant anyway
 * @param {number} opts.chainId the chain, for the settlement token's decimals
 * @param {number} [opts.now] ms
 */
export function planGrant(orders, { router, swapSelector, guard, chainId, now = Date.now(), solanaAddress = null }) {
  // Buys are signed by Privy and need no session key: their input token is
  // USDC on Solana, outside the EVM contract's reach. Sells of Solana tokens
  // are signed by Privy too, so they are excluded as well.
  const live = (orders ?? []).filter((o) => o?.status === 'watching' && o.side !== 'buy' && tokenOf(o)
    && chainFromTokenId(o.inTokenId) !== SOLANA_NETWORK_ID);
  if (!live.length) return null;
  if (!guard?.guard || !guard.settlementToken || !guard.depository) {
    throw new Error('the grant needs the output guard template: guard, settlement token and depository');
  }
  if (!lower(router) || !lower(swapSelector)) throw new Error('the grant needs the router and its swap selector');
  const settlement = settlementFor(chainId);
  if (!settlement) throw new Error(`the settlement token is not described for chain ${chainId}`);

  // Per token: the largest order, the sum of orders, and the least demanding
  // price among them, all in raw units.
  const perToken = new Map();
  for (const order of live) {
    let swapAmount;
    try {
      swapAmount = BigInt(order.amount);
    } catch {
      // An order with an unparsable amount must not sink the whole plan: it
      // will not execute anyway, the others still need their grant.
      continue;
    }
    if (swapAmount <= 0n) continue;
    // The order's own floor, in settlement units, then per unit of the token.
    // An order without a target or a sane slippage cannot price anything and
    // is left out: it would otherwise set the bound to zero for every order
    // of that token.
    let perUnit;
    try {
      const { floor } = guardFloor({
        targetOutScaled: order.targetOut,
        maxSlippageBps: order.maxSlippageBps,
        decimals: settlement.decimals,
      });
      perUnit = (floor * PRICE_SCALE) / swapAmount;
    } catch {
      continue;
    }
    if (perUnit <= 0n) continue;
    const token = tokenOf(order);
    const acc = perToken.get(token) ?? { max: 0n, total: 0n, price: null };
    if (swapAmount > acc.max) acc.max = swapAmount;
    acc.total += swapAmount;
    acc.price = acc.price === null || perUnit < acc.price ? perUnit : acc.price;
    perToken.set(token, acc);
  }
  if (!perToken.size) return null;

  const tokenCaps = [];
  const targets = [];
  const selectors = [];
  // Only approve on the order tokens: a sell batch contains no transfer, so
  // the key gets no transfer right.
  for (const [token, acc] of perToken) {
    tokenCaps.push({
      token,
      maxPerOp: acc.max,
      // Session budget: what this token's orders can actually spend plus one
      // retry. A failed attempt consumes budget like a successful one and
      // retries are expected (maxAttemptsPerOrder).
      budget: acc.total + acc.max,
      minOutPerUnit: acc.price,
    });
    targets.push(token);
    selectors.push(SEL_APPROVE);
  }
  // Neither the router's pair nor the guard's are listed: the contract grants
  // both from the template and the swap spec, and refuses either address in
  // the pair list, so the list cannot widen what may be called on them.

  return {
    validUntil: Math.floor(now / 1000) + GRANT_DAYS * 24 * 60 * 60,
    maxOps: Math.max(OPS_FLOOR, live.length * OPS_PER_ORDER),
    maxValuePerCall: 0n,
    valueBudget: 0n,
    feeBudget: 0n,
    maxFeePerOp: 0n,
    tokenCaps,
    guard: {
      guard: lower(guard.guard),
      settlementToken: lower(guard.settlementToken),
      depository: lower(guard.depository),
    },
    swap: { router: lower(router), selector: lower(swapSelector) },
    targets,
    selectors,
    feeRecipients: [],
  };
}

/**
 * Whether the issued grant covers the plan.
 *
 * Returns what is MISSING in words: a bare "does not cover" would mean
 * re-issuing blindly on every placement.
 *
 * @param {object} grant the Session read from the contract
 * @param {object} plan from planGrant
 * @param {object} [opts]
 * @param {number} [opts.now] ms
 * @param {(target: string, selector: string) => boolean} [opts.isAllowed]
 * @param {(token: string) => {exists: boolean, maxApprovePerOp: bigint, approveBudget: bigint, spentApprove: bigint}|null} [opts.tokenBudgetOf]
 *   the on-chain TokenBudget of a token; without it the caps are not checked
 */
export function grantCovers(grant, plan, { now = Date.now(), isAllowed, tokenBudgetOf } = {}) {
  const missing = [];
  if (!plan) return { ok: true, missing };
  if (!grant?.exists) return { ok: false, missing: [t('grant.none')] };

  const secs = Math.floor(now / 1000);
  const until = Number(grant.validUntil ?? 0);
  if (!until || until <= secs + RENEW_BEFORE_MS / 1000) {
    missing.push(t('grant.expiring', { until: until ? new Date(until * 1000).toISOString() : t('grant.no') }));
  }
  const opsLeft = BigInt(grant.maxOps ?? 0) - BigInt(grant.opsUsed ?? 0);
  if (opsLeft < BigInt(Math.min(plan.maxOps, OPS_PER_ORDER))) {
    missing.push(t('grant.opsLow', { n: opsLeft }));
  }
  if (BigInt(grant.maxFeePerOp ?? 0) < plan.maxFeePerOp) {
    missing.push(t('grant.feeCap', { have: grant.maxFeePerOp, need: plan.maxFeePerOp }));
  }
  // The template must be the one the runner builds batches for: a different
  // settlement token or depository on chain means every batch would be
  // refused by the contract, and a zero guard means no approve at all.
  const g = plan.guard;
  if (lower(grant.guard ?? ZERO) !== g.guard || lower(grant.guardToken ?? ZERO) !== g.settlementToken
    || lower(grant.guardHolder ?? ZERO) !== g.depository) {
    missing.push(t('grant.guardMismatch', { guard: g.guard, token: g.settlementToken, depository: g.depository }));
  }
  // The router and its one selector are part of the grant now, not of the
  // pair list: a grant naming another router would refuse every batch.
  if (lower(grant.swapRouter ?? ZERO) !== plan.swap.router || lower(grant.swapSelector ?? '0x') !== plan.swap.selector) {
    missing.push(t('grant.guardMismatch', { guard: g.guard, token: g.settlementToken, depository: plan.swap.router }));
  }
  if (typeof tokenBudgetOf === 'function') {
    for (const cap of plan.tokenCaps) {
      const tb = tokenBudgetOf(cap.token);
      if (!tb?.exists || BigInt(tb.maxPerOp ?? 0) < cap.maxPerOp) {
        missing.push(t('grant.tokenCap', { token: cap.token, have: tb?.exists ? tb.maxPerOp : 0, need: cap.maxPerOp }));
        continue;
      }
      // The session budget is the only bound on the total loss, so its
      // remainder is checked separately from the per-operation cap.
      const left = BigInt(tb.budget ?? 0) - BigInt(tb.spent ?? 0);
      if (left < cap.maxPerOp) missing.push(t('grant.tokenBudgetLow', { token: cap.token, left }));
      // The price on chain must be the plan's exactly. Higher and the honest
      // batch's floor would fall short of it and every sale would be refused;
      // lower and the bound on a leaked key would be weaker than the live
      // orders justify. Both are a re-grant.
      else if (BigInt(tb.minOutPerUnit ?? 0) !== cap.minOutPerUnit) {
        missing.push(t('grant.tokenPrice', { token: cap.token, have: tb.minOutPerUnit ?? 0, need: cap.minOutPerUnit }));
      }
    }
  }
  if (typeof isAllowed === 'function') {
    for (let i = 0; i < plan.targets.length; i += 1) {
      if (!isAllowed(plan.targets[i], plan.selectors[i])) {
        missing.push(t('grant.pairMissing', { target: plan.targets[i], selector: plan.selectors[i] }));
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
