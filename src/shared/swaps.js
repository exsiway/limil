// The native execution path: FOMO's quote -> our executeBatch.
//
// FOMO does not build the transaction itself; it asks relay and receives ready
// calls. We take EXACTLY those calls and wrap them in our own executeBatch. The
// inner calls are byte-for-byte what the front end would send: only then does
// the indexer still count the trade as a swap of the app rather than a
// transfer or an invisible operation.
//
// Pure functions only: response parsing, tolerance arithmetic and the call
// list. Network and signing live elsewhere.

import { t } from './i18n.js';
import { normalizeAddress } from './userop.js';

/**
 * Scale in which the order target and the normalised quote are stored.
 * Exported because `order.targetOut` and the runner's samples use the same
 * scale; while the number lived in three files the two sides of a comparison
 * drifted apart silently.
 */
export const QUOTE_SCALE = 18;

/** Scale factor for exact arithmetic over human-readable decimal amounts. */
const SCALE = 10n ** BigInt(QUOTE_SCALE);

/**
 * Decimal notation without an exponent.
 *
 * `expectedOutHumanAmount` arrives from the API as a NUMBER, not a string.
 * Outside 1e-7..1e21 `String()` yields "1.23e-8", which the parser rejects.
 * Precision is already lost before it reaches us; the job here is not to turn
 * that loss into a throw.
 */
export function decimalString(value) {
  if (typeof value !== 'number') return String(value ?? '').trim();
  if (!Number.isFinite(value)) return String(value);
  if (!/e/i.test(String(value))) return String(value);
  // toFixed(20) is the spec limit; trailing zeros go so the pattern below
  // sees ordinary notation.
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/** Decimal string -> integer scaled by 1e18. Money decisions are not made in doubles. */
export function parseDecimal(value) {
  const text = decimalString(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a decimal number: "${value}"`);
  const [whole, fraction = ''] = text.split('.');
  const padded = (fraction + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * SCALE + BigInt(padded);
}

/**
 * How much WORSE the quote is than the target, in basis points. Negative means
 * the quote is better than the target. The quote is a human-readable string,
 * the target is ALREADY an integer in QUOTE_SCALE, the way an order stores it.
 *
 * Scaling a stored target a second time would refuse every order with a
 * tolerance as "quote worse than target" even when it was better; the unit is
 * in the name so that cannot happen.
 */
export function shortfallBpsAgainstScaled(expectedOut, targetOutScaled) {
  const expected = parseDecimal(expectedOut);
  const target = BigInt(targetOutScaled);
  if (target === 0n) throw new Error('the target amount cannot be zero');
  return Number(((target - expected) * 10000n * 1000n) / target) / 1000;
}

/**
 * Slippage check for an order: the quote is human-readable, the target comes
 * from storage in QUOTE_SCALE.
 */
export function checkSlippageScaled({
  expectedOut, targetOutScaled, maxSlippageBps, relaySlippageBps = null,
}) {
  if (!Number.isFinite(maxSlippageBps) || maxSlippageBps < 0) {
    throw new Error('maxSlippageBps must be a non-negative number');
  }
  const shortfall = shortfallBpsAgainstScaled(expectedOut, targetOutScaled);
  if (shortfall > maxSlippageBps) {
    return {
      ok: false,
      shortfallBps: shortfall,
      relaySlippageBps,
      reason: `quote is ${shortfall.toFixed(1)} bps below target `
        + `at a tolerance of ${maxSlippageBps} bps, not signing`,
    };
  }
  return { ok: true, shortfallBps: shortfall, relaySlippageBps, reason: null };
}

/**
 * Execution routes. The one endpoint `/swaps/v2` answers with THREE different
 * envelopes, chosen by the network types at the two ends of the trade rather
 * than by chain id.
 *
 * Cash in FOMO lives on Solana. Hence the practical consequence that matters
 * more than anything else: a SELL is EVM -> Solana, our UserOperation path; a
 * BUY is Solana -> EVM, where there is no UserOperation at all.
 */
export const ROUTES = {
  /** v2Swap + relayTransaction.type EVM -> executeBatch in a UserOp, bundler. */
  EVM_USEROP: 'evm-userop',
  /** v2Swap + relayTransaction.type SOLANA -> signed Solana transaction, Jito. */
  SOLANA_RELAY: 'solana-relay',
  /** v1Swap, the dflow aggregator -> signed Solana transaction, Jito. */
  SOLANA_DFLOW: 'solana-dflow',
};

/** Whether we can execute this route ourselves. All three are supported. */
export function canExecuteRoute(route) {
  return route === ROUTES.EVM_USEROP || route === ROUTES.SOLANA_RELAY || route === ROUTES.SOLANA_DFLOW;
}

export function describeRoute(route) {
  return {
    [ROUTES.EVM_USEROP]: t('route.evm'),
    [ROUTES.SOLANA_RELAY]: t('route.solanaRelay'),
    [ROUTES.SOLANA_DFLOW]: t('route.solanaDflow'),
  }[route] ?? t('route.unknown');
}

/**
 * A business error from the API. It arrives as a FOURTH envelope: neither
 * v1Swap nor v2Swap, but `responseObject.errorCode` next to a `message`. Code
 * reading responseObject blindly would take it for an empty quote and complain
 * about the wrong thing.
 */
export function apiError(response) {
  const code = response?.responseObject?.errorCode ?? response?.errorCode;
  if (code === undefined || code === null) return null;
  const message = response?.responseObject?.errorMsg
    ?? response?.message
    ?? String(code);
  // Some errors have an obvious remedy; name it so the user does not have to
  // guess what to do with a foreign service's text.
  const hint = code === 'ERR_SWAP_BELOW_MINIMUM'
    ? t('route.tooSmall')
    : '';
  return { code, message: `${message}${hint}` };
}

/** Extracts what we need from a /swaps/v2 answer and checks it is complete. */
export function parseSwapQuote(response) {
  const error = apiError(response);
  if (error) throw new Error(t('swap.apiRefused', { code: error.code, message: error.message }));

  // v1Swap is the third envelope, with different names for almost every
  // field. A parser that only knows v2Swap is blind to a third of the traffic.
  const v1 = response?.responseObject?.v1Swap ?? response?.v1Swap;
  if (v1?.swapTransaction) {
    return {
      kind: 'SOLANA',
      route: ROUTES.SOLANA_DFLOW,
      canExecute: canExecuteRoute(ROUTES.SOLANA_DFLOW),
      platform: v1.platform ?? 'dflow',
      originAddress: v1.originAddress ?? null,
      tx: v1.swapTransaction,
      feePayerSignature: v1.feePayerSignature ?? null,
      feePayerAddress: v1.feePayerAddress ?? null,
      // Expiry of the signed transaction: it cannot be held until the order
      // fires, it expires with the block.
      lastValidBlockHeight: v1.lastValidBlockHeight ?? null,
      priorityFeeLamports: v1.priorityFeeLamports ?? null,
      expectedOut: v1.expectedOutHumanAmount ?? null,
      // On this route the tolerance is NOT in tradeInfo.
      slippageBps: v1.dynamicSlippageBps ?? null,
      feeTierBps: v1.feeTierBps ?? null,
      flatFee: v1.flatFee ?? null,
      relaySwapId: null,
    };
  }
  return parseV2Quote(response);
}

function parseV2Quote(response) {
  // The answer comes wrapped, but an already unwrapped v2Swap may arrive too.
  // Take the first candidate that really looks like a quote; otherwise an
  // empty object would "pass" as a quote and fail later with a foreign error.
  const candidates = [response?.responseObject?.v2Swap, response?.v2Swap, response];
  const swap = candidates.find((c) => c && typeof c === 'object' && c.relayTransaction);
  if (!swap) throw new Error('no v2Swap with relayTransaction in the answer');

  const relay = swap.relayTransaction;

  const kind = relay.type ?? relay.relayTxType;
  if (kind === 'SOLANA') {
    // A buy: cash lives on Solana, so the origin is Solana. There is no
    // executeBatch here at all; relay builds the whole transaction and FOMO
    // signs it as fee payer and sends it through Jito.
    return {
      kind: 'SOLANA',
      route: ROUTES.SOLANA_RELAY,
      canExecute: canExecuteRoute(ROUTES.SOLANA_RELAY),
      relaySwapId: swap.relaySwapId ?? null,
      tx: relay.tx ?? null,
      feePayerSignature: relay.feePayerSignature ?? null,
      feePayerAddress: relay.feePayerAddress ?? null,
      lastValidBlockHeight: relay.lastValidBlockHeight ?? null,
      // The user's Solana wallet: it signs.
      originAddress: swap.originAddress ?? null,
      expectedOut: swap.expectedOutHumanAmount ?? null,
      slippageBps: swap.tradeInfo?.slippageBps ?? null,
      originChainId: swap.originChainId ?? null,
      destinationChainId: swap.destinationChainId ?? null,
    };
  }

  const deposit = relay.depositTransaction;
  if (!deposit?.to || !deposit?.data) {
    throw new Error('the quote has no depositTransaction, nothing to execute');
  }

  return {
    kind: 'EVM',
    route: ROUTES.EVM_USEROP,
    canExecute: true,
    relaySwapId: swap.relaySwapId ?? null,
    chainId: Number(deposit.chainId ?? relay.approvalTransaction?.chainId ?? swap.originChainId),
    // approvalTransaction may be absent: the allowance was granted by an earlier trade.
    approval: relay.approvalTransaction ?? null,
    deposit,
    expectedOut: swap.expectedOutHumanAmount ?? null,
    slippageBps: swap.tradeInfo?.slippageBps ?? null,
    feeTierBps: swap.feeTierBps ?? null,
    usdFees: swap.usdFees ?? null,
    executionContext: swap.executionContext ?? null,
    destinationChainId: swap.destinationChainId ?? null,
  };
}

function toCall(tx, label) {
  if (!tx?.to || !tx?.data) throw new Error(`${label}: no to or data`);
  return {
    target: normalizeAddress(tx.to, `${label}.to`),
    value: BigInt(tx.value ?? 0),
    data: tx.data,
  };
}

/** approve(address,uint256) */
export const SEL_APPROVE = '0x095ea7b3';

/** `approve(spender, 0)` on a token: resets what the swap did not consume. */
function approveZeroCall(token, spender) {
  return {
    target: normalizeAddress(token, 'approve.token'),
    value: 0n,
    data: `${SEL_APPROVE}${String(spender).replace(/^0x/, '').toLowerCase().padStart(64, '0')}${'0'.repeat(64)}`,
  };
}

/**
 * The call list for our executeBatch: [guard snapshot], approve, swap,
 * [approve 0], [guard check]. The guard brackets the batch: a snapshot of the
 * relay depository's balance before the trade and a check of its gain after.
 * A shortfall reverts everything.
 *
 * THE TRAILING APPROVE(0). The router pulls the token through transferFrom
 * within the allowance, and neither the contract nor the verifier can see
 * where the router sends the proceeds: the swap calldata is opaque. So an
 * allowance left standing after a trade is a standing right to route that
 * much through the router later, by whoever holds a key with the router pair.
 * The batch therefore ends by setting the allowance back to zero. The
 * contract counts it as an approve of 0 (no budget consumed); the verifier
 * knows the spender because the router is a target of the same batch.
 *
 * @param {object} quote result of parseSwapQuote, kind EVM
 * @param {{before: object, after: object}|null} [guard] result of guardCalls
 * @param {object} [opts]
 * @param {boolean} [opts.resetAllowance] append approve(router, 0); default on
 * @param {string} [opts.token] the input token, so the allowance can be reset
 *   even when relay sent no approval because one already stood
 */
export function buildSwapCalls(quote, guard = null, opts = null) {
  if (quote.kind !== 'EVM') {
    throw new Error(`executeBatch does not apply to ${quote.kind}`);
  }
  const calls = [];
  if (guard) calls.push(guard.before);
  let approval = null;
  if (quote.approval) {
    approval = toCall(quote.approval, 'approvalTransaction');
    calls.push(approval);
  }
  const deposit = toCall(quote.deposit, 'depositTransaction');
  calls.push(deposit);
  // The allowance is reset WHETHER OR NOT this quote carried an approval.
  //
  // Relay omits `approvalTransaction` exactly when an allowance already
  // stands, left by an earlier trade, ours or the FOMO app's. That is the
  // case where a reset matters most: a standing allowance is spendable
  // through the router by anyone holding the session key, and the contract
  // charges no approve budget for a batch that contains no approve. Resetting
  // only when we ourselves approved would leave the dangerous case untouched.
  // It does not undo an allowance that exists right
  // now, the swap in this same batch still spends within it, but after our
  // batch there is none left to spend.
  const reset = opts?.resetAllowance ?? true;
  if (reset) {
    // The spender is the one the approval named, the router. When the
    // approval calldata is not a full approve(address,uint256), the deposit
    // target is the spender by construction of the relay flow.
    const hex = approval ? String(approval.data).replace(/^0x/, '') : '';
    const named = hex.length >= 136 ? `0x${hex.slice(32, 72)}` : null;
    const spender = named && !/^0x0{40}$/.test(named) ? named : deposit.target;
    const token = approval?.target ?? (opts?.token ?? null);
    if (token) calls.push(approveZeroCall(token, spender));
  }
  if (guard) calls.push(guard.after);
  return calls;
}
