// Deciding when a limit order fires.
//
// The naive check "latest quote >= target" is wrong: the same request repeated
// three times within seconds spreads by up to 4.5%. On such drift an order
// fires on a random spike that is gone a second later, and the user gets an
// execution at a price that never existed.
//
// Hence three rules, each checked separately:
//
//   1. a trigger is confirmed by SEVERAL consecutive samples, not one;
//   2. samples older than the window are discarded;
//   3. the decision uses the MEDIAN, not the last value: the median survives
//      a single outlier, the mean does not.
//
// Arithmetic only: no network, no quotes. The price source is plugged in from
// outside.

/** Consecutive samples that must confirm the target. */
export const DEFAULT_CONFIRMATIONS = 3;

/** Samples older than this take no part in the decision. */
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Spread at which no decision is made at all. 4.5% is observed as normal; a
 * window twice as wide means the market or the route misbehaves, and firing
 * on such a picture is dangerous.
 */
const DEFAULT_MAX_SPREAD_BPS = 900;

/**
 * Share of the spread the median must clear beyond the target for the
 * crossing to count.
 *
 * A fixed spread ceiling treats a 2% target and a 50% target alike, although
 * the danger differs: with targets at ±2% and a quote spread of 4.5%, two
 * opposite orders gathered confirmations at the same time on a flat price, and
 * which one fired first was chance. So a crossing counts only when the median
 * is beyond the target by more than HALF the observed spread. A target inside
 * the noise never fires; a target outside it behaves as before.
 */
const MARGIN_OF_SPREAD = 0.5;

/**
 * Cap on that margin, in bps.
 *
 * Half the spread is reasonable on a quiet token and ruinous on a jumpy one:
 * at a spread of 418 bps it demanded another 2.1% beyond the target, so a stop
 * loss at −5% would in effect fire at −7%. The user sets the target
 * deliberately; the protection may not eat percents of it. One and a half
 * percent is the most it may take.
 */
export const MARGIN_CAP_BPS = 150;

/** The median survives a single outlier, unlike the mean. */
export function median(values) {
  if (!values.length) throw new Error('empty sample set');
  const sorted = [...values].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

/** Range of the set in basis points relative to the median. */
export function spreadBps(values) {
  const nums = values.map(BigInt);
  const mid = median(nums);
  if (mid === 0n) throw new Error('median is zero');
  const lo = nums.reduce((a, b) => (b < a ? b : a));
  const hi = nums.reduce((a, b) => (b > a ? b : a));
  return Number(((hi - lo) * 10_000n) / mid);
}

/**
 * Samples fit for a decision: not older than the window, in chronological
 * order.
 *
 * @param {{out: bigint|string, at: number}[]} samples
 */
export function freshSamples(samples, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  return samples
    .filter((s) => Number.isFinite(s?.at) && now - s.at <= windowMs)
    .sort((a, b) => a.at - b.at);
}

/**
 * Whether it is time to execute the order.
 *
 * @param {object} opts
 * @param {bigint|string} opts.targetOut  output target
 * @param {{out: bigint|string, at: number}[]} opts.samples quote samples
 * @returns {{fire: boolean, reason: string, median: string|null,
 *            spreadBps: number|null, confirmed: number}}
 */
export function shouldTrigger({
  targetOut,
  /**
   * Where the price has to go: 'at-or-above' for a take profit (output at
   * least the target), 'at-or-below' for a stop loss (output at most the
   * target).
   */
  direction = 'at-or-above',
  samples = [],
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  confirmations = DEFAULT_CONFIRMATIONS,
  maxSpreadBps = DEFAULT_MAX_SPREAD_BPS,
}) {
  const target = BigInt(targetOut);
  if (target <= 0n) throw new Error('target must be above zero');

  const fresh = freshSamples(samples, { now, windowMs });
  if (fresh.length < confirmations) {
    return {
      fire: false,
      reason: `${fresh.length} of ${confirmations} samples, waiting for confirmation`,
      median: null,
      spreadBps: null,
      confirmed: 0,
    };
  }

  // Only the last `confirmations` samples: the order fires on the current
  // picture, not on the whole window.
  const window = fresh.slice(-confirmations);
  const outs = window.map((s) => BigInt(s.out));
  const mid = median(outs);
  const spread = spreadBps(outs);

  if (spread > maxSpreadBps) {
    return {
      fire: false,
      reason: `quote spread is ${spread.toFixed(0)} bps at a ceiling of ${maxSpreadBps}, `
        + 'no decision on such a picture',
      median: mid.toString(),
      spreadBps: spread,
      confirmed: 0,
    };
  }

  // The condition must hold on EVERY sample of the window. One crossing is not
  // enough: that is exactly how drift smuggles in a false trigger. The
  // direction is mandatory: with a one-sided comparison a stop loss fired the
  // moment it was placed.
  const below = direction === 'at-or-below';
  const confirmed = outs.filter((out) => (below ? out <= target : out >= target)).length;
  const confirmedWord = below ? 'drop to target confirmed' : 'target confirmed';
  const holdsWord = below ? 'drop to target holds' : 'target holds';
  const drift = `spread ${spread.toFixed(0)} bps`;
  if (confirmed < confirmations) {
    return {
      fire: false,
      // The spread is always printed, not only on a trigger: it shows whether
      // the target sits inside the noise. The threshold is printed as a
      // number: "why did it not fire when the target was reached" is a
      // question the source code should not be the only answer to.
      reason: `${confirmedWord} ${confirmed} of ${confirmations} times, ${drift}`,
      needAtMost: below ? (target - (target * BigInt(Math.min(Math.round(spread * MARGIN_OF_SPREAD), MARGIN_CAP_BPS))) / 10000n).toString() : null,
      needAtLeast: below ? null : (target + (target * BigInt(Math.min(Math.round(spread * MARGIN_OF_SPREAD), MARGIN_CAP_BPS))) / 10000n).toString(),
      median: mid.toString(),
      spreadBps: spread,
      confirmed,
    };
  }

  // Margin beyond the target. Crossing is not enough: if the median is beyond
  // the target by less than half the spread, what is beyond the target is
  // noise, not the market.
  const marginBps = Math.min(Math.round(spread * MARGIN_OF_SPREAD), MARGIN_CAP_BPS);
  const needed = (target * BigInt(marginBps)) / 10000n;
  const edge = below ? target - mid : mid - target;
  if (edge < needed) {
    return {
      fire: false,
      reason: `${confirmedWord} ${confirmed} of ${confirmations}, but the edge ${edge} `
        + `is below the margin ${needed} (${marginBps} bps at ${drift}), noise, not a move`,
      median: mid.toString(),
      spreadBps: spread,
      confirmed,
    };
  }

  return {
    fire: true,
    reason: `${holdsWord} for ${confirmed} consecutive samples, ${drift}, edge ${edge}`,
    median: mid.toString(),
    spreadBps: spread,
    confirmed,
  };
}
