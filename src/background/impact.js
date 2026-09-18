// Price impact measurement through public quotes, and waiting for the pool.

import {
  isSolanaToken, jupiterQuoteUrl, parseJupiterImpact, parseRelayImpact, poolVerdict, relayOutToScaled, relayQuoteBody,
  scaleOutByReference,
} from '../shared/impact.js';
import { CASH_TOKEN_ADDRESS } from '../shared/chains.js';

const RELAY_QUOTE = 'https://api.relay.link/quote';

/**
 * One measurement. The sensor depends on the token's chain: relay for EVM
 * (both trade directions), Jupiter for tokens native to Solana, where relay
 * takes no part. Throws when the sensor did not answer or the answer did not parse.
 */
async function measureImpact({ sender, chainId, token, amount, side = 'sell', solanaAddress = null }) {
  if (isSolanaToken(chainId)) {
    const url = jupiterQuoteUrl(side === 'buy'
      ? { inputMint: CASH_TOKEN_ADDRESS, outputMint: token, amount }
      : { inputMint: token, outputMint: CASH_TOKEN_ADDRESS, amount });
    const res = await fetch(url);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`jupiter answered non-JSON (HTTP ${res.status})`); }
    if (!res.ok) throw new Error(`jupiter HTTP ${res.status}: ${json?.error ?? text.slice(0, 120)}`);
    return parseJupiterImpact(json);
  }
  const res = await fetch(RELAY_QUOTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(relayQuoteBody({ sender, chainId, token, amount, side, solanaAddress })),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`relay answered non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`relay HTTP ${res.status}: ${json?.message ?? text.slice(0, 120)}`);
  return parseRelayImpact(json);
}

/**
 * Waits until the impact is within the cap.
 *
 * Measured every `everyMs`, at most `maxWaitMs`. Two consecutive measurement
 * failures release the trade with a note: a relay outage must not block every
 * sell, and relay's own tolerance still applies at execution.
 *
 * @returns {{ok: boolean, impactBps: number|null, reason: string|null, measured: boolean, waitedMs: number}}
 */
export async function waitForImpact({
  sender, chainId, token, amount, capBps,
  side = 'sell', solanaAddress = null, outDecimals = 6,
  /** Last FOMO quote in the 1e18 scale: the reference for scaling the sensor output. */
  referenceOutScaled = null,
  targetOutScaled = null, maxSlippageBps = null,
  maxWaitMs = 60_000, everyMs = 2_000, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  measure = measureImpact, now = () => Date.now(),
}) {
  const guardsImpact = capBps !== null && capBps !== undefined;
  const guardsPrice = maxSlippageBps !== null && maxSlippageBps !== undefined
    && targetOutScaled !== null && targetOutScaled !== undefined;
  if (!guardsImpact && !guardsPrice) {
    return { ok: true, impactBps: null, reason: null, measured: false, waitedMs: 0 };
  }
  const started = now();
  let failures = 0;
  let last = null;
  for (;;) {
    try {
      last = await measure({ sender, chainId, token, amount, side, solanaAddress });
      failures = 0;
      const verdict = poolVerdict({
        impactBps: last.swapBps,
        capBps: guardsImpact ? capBps : null,
        outScaled: last.out !== null && last.out !== undefined
          ? (scaleOutByReference(last.out, referenceOutScaled) ?? relayOutToScaled(last.out, outDecimals))
          : null,
        targetOutScaled: guardsPrice ? targetOutScaled : null,
        maxSlippageBps: guardsPrice ? maxSlippageBps : null,
      });
      if (verdict.ok) {
        return { ok: true, impactBps: last.swapBps, reason: null, measured: true, waitedMs: now() - started };
      }
      if (now() - started + everyMs > maxWaitMs) {
        return { ok: false, impactBps: last.swapBps, reason: verdict.reason, measured: true, waitedMs: now() - started };
      }
    } catch (err) {
      failures += 1;
      if (failures >= 2) {
        return {
          ok: true, impactBps: null, measured: false, waitedMs: now() - started,
          reason: `impact not measured (${String(err?.message || err).slice(0, 80)}), proceeding under relay's tolerance`,
        };
      }
    }
    await sleep(everyMs);
  }
}
