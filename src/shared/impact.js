// Price impact: how much our own size moves the pool.
//
// Relay applies its own tolerance to the execution; that tolerance does not
// protect against a large order eating through thin liquidity. The user sets
// an impact cap, and while the pool cannot absorb the size within it the trade
// waits for liquidity to settle.
//
// The sensor is the public relay quote (`api.relay.link/quote`), which needs
// neither keys nor a FOMO session and can be polled often. Only parsing and
// decisions live here; the network calls are in background/impact.js.

import { SOLANA_RELAY_CHAIN_ID, SOLANA_NETWORK_ID, CASH_TOKEN_ADDRESS } from './chains.js';

/**
 * Default cap: 10%. In the panel the impact cap and the slippage tolerance are
 * one setting: for the user both mean "how much worse am I willing to take".
 */
export const DEFAULT_MAX_IMPACT_BPS = 1000;

/**
 * Relay requires a valid recipient even for a quote; the recipient does not
 * affect the price. This is not a wallet anyone holds: the base58 of
 * sha256("limil placeholder recipient"), a syntactically valid key that relay
 * accepts and that has no owner.
 */
const SOLANA_PLACEHOLDER = 'LNzrU227zXrWYZJaGC6YQUQ4F7nBehVRdUBHYATuvzE';

/** Request body for a relay quote: token ↔ USDC on Solana, the way FOMO trades. */
export function relayQuoteBody({ sender, chainId, token, amount, side = 'sell', solanaAddress = null }) {
  if (side === 'buy') {
    // Buy: USDC on Solana into a token on EVM. The user is the Solana wallet.
    return {
      user: solanaAddress ?? SOLANA_PLACEHOLDER,
      recipient: sender,
      originChainId: SOLANA_RELAY_CHAIN_ID,
      destinationChainId: Number(chainId),
      originCurrency: CASH_TOKEN_ADDRESS,
      destinationCurrency: token,
      amount: String(amount),
      tradeType: 'EXACT_INPUT',
    };
  }
  return {
    user: sender,
    recipient: solanaAddress ?? SOLANA_PLACEHOLDER,
    originChainId: Number(chainId),
    destinationChainId: SOLANA_RELAY_CHAIN_ID,
    originCurrency: token,
    destinationCurrency: CASH_TOKEN_ADDRESS,
    amount: String(amount),
    tradeType: 'EXACT_INPUT',
  };
}

/** A token native to Solana: relay is not involved there, Jupiter is the sensor. */
export function isSolanaToken(chainId) {
  return Number(chainId) === SOLANA_NETWORK_ID;
}

/** Jupiter quote URL: public, no keys. */
export function jupiterQuoteUrl({ inputMint, outputMint, amount }) {
  const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: '50' });
  return `https://lite-api.jup.ag/swap/v1/quote?${q}`;
}

export function parseJupiterImpact(quote) {
  if (quote?.error) throw new Error(`jupiter: ${quote.error}`);
  const pct = Number(quote?.priceImpactPct);
  if (!Number.isFinite(pct) || quote?.outAmount === undefined) throw new Error('jupiter: no priceImpactPct in the answer');
  return { swapBps: Math.round(Math.abs(pct) * 10_000), totalBps: null, out: String(quote.outAmount), inUsd: NaN, outUsd: NaN };
}

/** Relay percent ("0.47") to basis points; null when the field is absent. */
function percentToBps(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
}

/**
 * Parses a relay answer: swap impact, total impact with fees, output.
 * A missing swapImpact is a parse failure, not "zero impact".
 */
export function parseRelayImpact(quote) {
  const d = quote?.details;
  if (!d) throw new Error(quote?.message ? `relay: ${quote.message}` : 'relay: no details in the answer');
  const swapBps = percentToBps(d.swapImpact?.percent);
  if (swapBps === null) throw new Error('relay: no swapImpact in the answer');
  return {
    swapBps,
    totalBps: percentToBps(d.totalImpact?.percent),
    inUsd: Number(d.currencyIn?.amountUsd ?? NaN),
    outUsd: Number(d.currencyOut?.amountUsd ?? NaN),
    out: d.currencyOut?.amount ?? null,
  };
}

/**
 * Impact verdict. A null or undefined cap means no limit.
 * @returns {{ok: boolean, reason: string|null}}
 */
export function impactVerdict(impactBps, capBps) {
  if (capBps === null || capBps === undefined) return { ok: true, reason: null };
  const cap = Number(capBps);
  if (!Number.isFinite(cap) || cap < 0) throw new Error(`impact cap is not a number: ${capBps}`);
  if (impactBps <= cap) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `price impact ${(impactBps / 100).toFixed(2)}% is above the cap ${(cap / 100).toFixed(2)}%, waiting for the pool to settle`,
  };
}

/**
 * Scales the sensor output by a REFERENCE value rather than by the recorded
 * decimals.
 *
 * The sensor returns the output in the token's minimal units, and the decimals
 * stored in the order may be wrong. The reference is the last FOMO quote in
 * the 1e18 scale: the power of ten that brings the output closest to it is
 * chosen. Quote and sensor price the same trade and cannot differ by an order
 * of magnitude.
 *
 * @returns {bigint|null} output in the 1e18 scale, or null without a reference
 */
export function scaleOutByReference(out, referenceScaled) {
  const raw = BigInt(out);
  const ref = BigInt(referenceScaled ?? 0);
  if (raw <= 0n || ref <= 0n) return null;
  let best = null;
  let bestGap = null;
  for (let k = 0; k <= 18; k += 1) {
    const scaled = raw * 10n ** BigInt(k);
    // Log-distance: the ratio closest to 1 wins.
    const gap = scaled > ref ? Number(scaled / ref) : Number(ref / scaled);
    if (bestGap === null || gap < bestGap) { bestGap = gap; best = scaled; }
  }
  return best;
}

/** Aggregator output in minimal units to the target scale (1e18). USDC has 6 decimals. */
export function relayOutToScaled(out, decimals = 6) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 18) throw new Error(`decimals ${decimals} outside 0..18`);
  return BigInt(out) * 10n ** BigInt(18 - d);
}

/**
 * Verdict on the pool as a whole: impact within the cap AND output not worse
 * than the target by more than the tolerance. The second guards against
 * someone else's impact: the price was one thing when the order triggered, a
 * large trade went through and the quote dropped for seconds. Wait for it to
 * come back instead of selling at the bottom of the spike.
 *
 * @param {object} o
 * @param {number} o.impactBps       our impact per relay
 * @param {number|null} o.capBps     impact cap; null means no limit
 * @param {bigint|null} o.outScaled  relay output in the target scale
 * @param {bigint|string|null} o.targetOutScaled  order target
 * @param {number|null} o.maxSlippageBps  tolerance below target; null means no limit
 */
export function poolVerdict({ impactBps, capBps, outScaled = null, targetOutScaled = null, maxSlippageBps = null }) {
  const impact = impactVerdict(impactBps, capBps);
  if (!impact.ok) return impact;
  if (outScaled === null || targetOutScaled === null || targetOutScaled === undefined
    || maxSlippageBps === null || maxSlippageBps === undefined) {
    return { ok: true, reason: null };
  }
  const target = BigInt(targetOutScaled);
  if (target <= 0n) return { ok: true, reason: null };
  const floor = (target * BigInt(10_000 - Math.min(10_000, Math.max(0, Number(maxSlippageBps))))) / 10_000n;
  if (BigInt(outScaled) >= floor) return { ok: true, reason: null };
  const worseBps = Number(((target - BigInt(outScaled)) * 10_000n) / target);
  return {
    ok: false,
    reason: `offered ${(worseBps / 100).toFixed(2)}% below target at a tolerance of ${(Number(maxSlippageBps) / 100).toFixed(2)}%, waiting for the price to come back`,
  };
}
