// The limit order model and the arithmetic around it.
//
// The shape mirrors what the user sees in the panel: an input amount plus a
// target expressed as a percentage of the market ("sell 60% above market").
// Internally everything is integer arithmetic in minimal units: percentages of
// money in doubles drift in the last digits, and these numbers are what the
// UserOperation is signed over.

import { DEFAULT_MAX_IMPACT_BPS } from './impact.js';
import { t } from './i18n.js';

export const SIDES = { SELL: 'sell', BUY: 'buy' };

/**
 * WHEN the order fires. Not the same thing as the trade side.
 *
 * A take profit waits for the price to rise: fire when the output is at or
 * above the target. A stop loss waits for the price to fall: its target is
 * below the market, so "at or above target" would be true the moment it is
 * placed. The direction is decided once, at placement, and stored with the
 * order; deriving it later from the sign of the percentage is impossible
 * because the market has moved by then.
 */
export const TRIGGER = {
  /** Take profit on a sell: fire when the output is AT LEAST the target. */
  ABOVE: 'at-or-above',
  /** Stop loss on a sell: fire when the output is AT MOST the target. */
  BELOW: 'at-or-below',
};

/**
 * Trigger direction of an order. Orders saved without the field derive it
 * from the sign of the percentage; zero or none means take profit.
 */
export function triggerOf(order) {
  if (order?.triggerWhen === TRIGGER.BELOW || order?.triggerWhen === TRIGGER.ABOVE) {
    return order.triggerWhen;
  }
  return Number(order?.percent) < 0 ? TRIGGER.BELOW : TRIGGER.ABOVE;
}

/**
 * The lines of a chart-sync report worth telling a person about.
 *
 * Most of what the chart reports is the ordinary noise of a page loading: the
 * widget is not captured yet, the token of the page is not known yet, an
 * order line is unavailable and a shape is drawn instead. Repeating those in
 * the journal would bury everything else.
 *
 * What is left is the cases where an order exists, the chart is there, and
 * still nothing was drawn. That is the state that had a person looking at a
 * chart with no level on it and nothing anywhere saying why.
 */
export function chartTrouble(report) {
  const skipped = Array.isArray(report?.skipped) ? report.skipped : [];
  return skipped.filter((line) => {
    const text = String(line ?? '');
    if (/deferred/.test(text)) return false;          // the chart is still coming up
    if (/page token unknown/.test(text)) return false; // the address arrives a moment later
    if (/order line unavailable/.test(text)) return false; // a shape is drawn instead
    return true;
  });
}

export const ORDER_STATUS = {
  WATCHING: 'watching',
  TRIGGERED: 'triggered',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  /** The runner used every attempt the limits allow; it will not fire again. */
  SHELVED: 'shelved',
};

/**
 * Watching sells that the position can no longer cover.
 *
 * A take profit and a stop loss over one holding are two orders for one
 * position. When one of them fills, the other is still armed: it fires into an
 * empty wallet, and worse, it stays armed for whatever of that token the wallet
 * holds next, so a purchase made a week later is sold by an order the person
 * had forgotten. Once a sell is confirmed, the rest are measured against what
 * is actually left and the ones that no longer fit are closed.
 *
 * A ladder survives. An order the remaining balance still covers is left
 * watching, which is what makes this a measurement and not a rule that one
 * fill ends every other order on the token.
 *
 * @param {object[]} orders    the whole list
 * @param {object} filled      the order that just filled
 * @param {bigint} remaining   the wallet's balance of that token after the sale
 * @returns {string[]} ids to cancel
 */
export function sellsLeftWithoutPosition(orders, { filled, remaining }) {
  if (!filled || filled.side === SIDES.BUY) return [];
  if (typeof remaining !== 'bigint' || remaining < 0n) return [];
  const token = String(filled.inTokenId ?? '');
  const wallet = String(filled.sender ?? '').toLowerCase();
  if (!token || !wallet) return [];
  const out = [];
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!o || o.id === filled.id) continue;
    if (o.status !== ORDER_STATUS.WATCHING || o.side === SIDES.BUY) continue;
    if (String(o.inTokenId ?? '') !== token) continue;
    if (String(o.sender ?? '').toLowerCase() !== wallet) continue;
    let amount;
    // An unreadable amount is not evidence that the order is uncovered.
    try { amount = BigInt(o.amount ?? 0); } catch { continue; }
    if (amount > remaining) out.push(o.id);
  }
  return out;
}

/**
 * Default tolerance: 10% below target.
 *
 * This threshold guards against someone else's price impact: the price at
 * trigger time is one thing, and between the measurement and the execution a
 * large trade can knock the quote down for seconds. Without a threshold the
 * order would sell at the bottom of the spike. A refusal on tolerance is not a
 * failure but a wait: relay is polled every two seconds until the price is
 * back. null remains legal: the user removed the limit deliberately.
 */
export const DEFAULT_MAX_SLIPPAGE_BPS = 1000;

export function bpsToPercent(bps) {
  if (bps === null || bps === undefined) return null;
  return Number(bps) / 100;
}

export function percentToBps(percent) {
  if (percent === null || percent === undefined || percent === '') return null;
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0) throw new Error(t('order.err.slippageNegative'));
  if (value > 100) throw new Error(t('order.err.slippageOver'));
  return Math.round(value * 100);
}

/** Human-readable tolerance for the interface. */
export function formatSlippage(bps) {
  if (bps === null || bps === undefined) return t('order.slippage.notSet');
  const percent = bpsToPercent(bps);
  // Three decimals only for very small non-zero values; zero stays "0",
  // otherwise "0.000%" reads as a rounding error.
  const shown = percent > 0 && percent < 0.01
    ? percent.toFixed(3)
    : String(Number(percent.toFixed(2)));
  return `${shown}%`;
}

/**
 * Chain of an order from its `inTokenId` of the form `<address>:<networkId>`.
 *
 * There is no separate chain field on purpose: the network is already named in
 * the token id, and two sources of one value drift apart sooner or later.
 *
 * @returns {number|null} null when the id names no network
 */
export function chainFromTokenId(tokenId) {
  const tail = String(tokenId ?? '').split(':')[1];
  const n = Number(tail);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Input amount as a share of the balance.
 * @param {bigint} balance
 * @param {number} percent 0..100
 */
export function amountFromPercent(balance, percent) {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new Error(t('order.err.percentRange'));
  }
  const value = BigInt(balance);
  if (value <= 0n) throw new Error(t('order.err.emptyBalance'));
  // Through basis points so that 33.3% keeps its digits.
  return (value * BigInt(Math.round(percent * 100))) / 10_000n;
}

/**
 * Output target from a percentage relative to the market.
 * percent = +60 -> want 60% more than offered now (sell above market).
 * percent = -30 -> accept 30% less (stop loss, or a limit entry below).
 *
 * @param {bigint} marketOut what is offered now, in minimal units
 */
export function targetOutFromPercent(marketOut, percent, side = SIDES.SELL) {
  if (!Number.isFinite(percent)) throw new Error(t('order.err.percentNaN'));
  if (percent <= -100) throw new Error(t('order.err.percentLow'));
  const market = BigInt(marketOut);
  if (market <= 0n) throw new Error(t('order.err.emptyMarket'));
  const move = BigInt(10_000 + Math.round(percent * 100));
  // The percentage is a PRICE move. On a sell the output grows with the price;
  // on a buy the output is tokens for the same cash and grows as the price falls.
  if (side === SIDES.BUY) return (market * 10_000n) / move;
  return (market * move) / 10_000n;
}

/** Trigger direction by side and percentage: on a buy the sign flips. */
export function triggerFor(side, percent) {
  const down = Number(percent) < 0;
  if (side === SIDES.BUY) return down ? TRIGGER.ABOVE : TRIGGER.BELOW;
  return down ? TRIGGER.BELOW : TRIGGER.ABOVE;
}

/** Compact number for panel labels: 279815.8 -> "279.8K". */
export function formatCompact(value, decimals = 0) {
  // The amount arrives as a bigint or as a STRING of integer minimal units
  // (that is how a stored order keeps it); both are divided by the decimals.
  const asInteger = typeof value === 'bigint' ? value
    : (typeof value === 'string' && /^\d+$/.test(value.trim())) ? BigInt(value.trim())
      : null;
  const number = asInteger !== null
    ? Number(asInteger) / 10 ** decimals
    : Number(value) / 10 ** decimals;
  if (!Number.isFinite(number)) return '-';
  const abs = Math.abs(number);
  if (abs === 0) return '0';
  const units = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      // One decimal at every magnitude, like the FOMO panel ("279.8K").
      const scaled = (number / size).toFixed(1).replace(/\.0$/, '');
      return `${scaled}${suffix}`;
    }
  }
  if (abs >= 1) return number.toFixed(2);
  // toPrecision on very small numbers yields "1.23e-11"; below the visible
  // threshold "< 0.001" is more honest.
  if (abs < 0.001) return `${number < 0 ? '-' : ''}< 0.001`;
  return String(Number(number.toFixed(4)));
}

/**
 * Market cap in trader notation: "$4.74M", "$500k", "$1.25B". Suffix case
 * follows the convention: lower-case k, upper-case M and B.
 */
export function formatMarketCap(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const scaled = (n / size).toFixed(2).replace(/\.?0+$/, '');
      return `$${scaled}${suffix}`;
    }
  }
  return `$${Number(n.toFixed(2))}`;
}

/**
 * Target market cap from a percentage relative to the market. The target is
 * set as an offset and shown as a level: the current cap scaled by the same
 * share as the output.
 */
export function targetMarketCap(currentMarketCap, percent) {
  const current = Number(currentMarketCap);
  if (!Number.isFinite(current) || current <= 0) return null;
  if (!Number.isFinite(percent)) return null;
  const target = current * (1 + percent / 100);
  return target > 0 ? target : null;
}

/** Ticker with a dollar sign, as in the feed: SHRUB -> $SHRUB. */
export function tickerLabel(symbol) {
  const text = String(symbol ?? '').trim();
  if (!text) return '';
  // A shortened address is not a ticker and gets no dollar sign.
  return /^[A-Za-z0-9]{1,12}$/.test(text) ? `$${text.toUpperCase()}` : text;
}

/** Order caption for the panel: "Sell 279.8K $SHRUB at $2.76M MC". */
export function describeOrder({
  side, amount, decimals = 18, symbol = '', percent,
  targetMarketCapUsd = null, triggerWhen = null,
  /** Output target in the 1e18 scale; on a buy that is the tokens received. */
  targetOut = null,
  /** What a buy is paid with: "for $2.39 USDC" in the caption. */
  cashSymbol = 'USDC', cashDecimals = 6,
  /** What the trade comes to in dollars at its target, when it is known. */
  valueUsd = null,
}) {
  const verb = side === SIDES.BUY ? t('order.buy') : t('order.sell');
  const ticker = tickerLabel(symbol);
  // On a buy the size is the target token amount ("Buy 224k $CAT"); before a
  // quote exists it is the cash amount.
  const size = side === SIDES.BUY
    ? (targetOut ? formatCompact(targetOut, 18) : t('order.for', { amount: formatCompact(amount, cashDecimals), symbol: cashSymbol }))
    : formatCompact(amount, decimals);

  // With a known market cap the caption names the level: "at $2.76M MC" reads
  // the same no matter when you look, unlike "18% above market". A stop loss
  // is named as such, otherwise two opposite orders would look identical.
  const kind = side !== SIDES.BUY && triggerOf({ percent, triggerWhen }) === TRIGGER.BELOW ? t('order.stopLoss') : '';
  // The dollar figure rides along wherever the caption ends up: what someone
  // wants from "sell 2.15 $PONS at $770.6M MC" is how much that is in money.
  const worth = Number.isFinite(valueUsd) && valueUsd > 0
    ? t('order.worth', { usd: valueUsd >= 100 ? valueUsd.toFixed(0) : valueUsd.toFixed(2) })
    : '';
  const cap = formatMarketCap(targetMarketCapUsd);
  if (cap) return `${t('order.atCap', { verb, size, ticker, kind, cap }).replace(/\s+/g, ' ').trim()}${worth}`;

  if (!Number.isFinite(percent) || percent === 0) {
    return `${t('order.atMarket', { verb, size, ticker }).replace(/\s+/g, ' ').trim()}${worth}`;
  }
  const direction = percent > 0 ? t('order.above') : t('order.below');
  return `${t('order.vsMarket', { verb, size, ticker, pct: Math.abs(percent).toFixed(0), direction }).replace(/\s+/g, ' ').trim()}${worth}`;
}

/**
 * Validates an order before it is saved. Returns a list of problems; an empty
 * list means the order can be placed.
 */
export function validateOrder(order) {
  const problems = [];
  if (!Object.values(SIDES).includes(order.side)) problems.push(t('order.err.noSide'));
  if (!order.inTokenId || !order.outTokenId) problems.push(t('order.err.noTokens'));
  if (order.inTokenId && order.inTokenId === order.outTokenId) {
    problems.push(t('order.err.sameToken'));
  }
  try {
    if (BigInt(order.amount ?? 0) <= 0n) problems.push(t('order.err.amountZero'));
  } catch {
    problems.push(t('order.err.amountNaN'));
  }
  try {
    if (BigInt(order.targetOut ?? 0) <= 0n) problems.push(t('order.err.targetZero'));
  } catch {
    problems.push(t('order.err.targetNaN'));
  }
  const bps = order.maxSlippageBps;
  // null is legal: the user deliberately set no limit of their own.
  if (bps !== null && bps !== undefined && (!Number.isFinite(bps) || bps < 0 || bps > 10_000)) {
    problems.push(t('order.err.slippageRange'));
  }
  const impact = order.maxImpactBps;
  if (impact !== null && impact !== undefined && (!Number.isFinite(impact) || impact < 0 || impact > 10_000)) {
    problems.push(t('order.err.impactRange'));
  }
  return problems;
}

/** Builds an order in the shape it is stored in. */
export function createOrder(input) {
  const order = {
    id: `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    status: ORDER_STATUS.WATCHING,
    side: input.side,
    inTokenId: input.inTokenId,
    outTokenId: input.outTokenId,
    amount: String(input.amount),
    targetOut: String(input.targetOut),
    percent: input.percent ?? null,
    // Share of the position chosen at placement. Separate from `percent`,
    // which is about price (how far the target is from the market); this one
    // is about volume (how much of the position is sold).
    amountPercent: Number.isFinite(Number(input.amountPercent))
      ? Number(input.amountPercent)
      : null,
    // The direction is fixed here, while it is still known on which side of
    // the market the target stands.
    triggerWhen: input.triggerWhen ?? triggerFor(input.side, input.percent),
    maxSlippageBps: input.maxSlippageBps === undefined
      ? DEFAULT_MAX_SLIPPAGE_BPS
      : input.maxSlippageBps,
    // Price impact cap: the trade waits until the pool can absorb the size.
    // null means the user removed the limit.
    maxImpactBps: input.maxImpactBps === undefined
      ? DEFAULT_MAX_IMPACT_BPS
      : input.maxImpactBps,
    symbol: input.symbol ?? '',
    decimals: input.decimals ?? 18,
    // Market cap at placement and the target cap: the order reads as a level
    // rather than as an offset.
    marketCapUsd: input.marketCapUsd ?? null,
    targetMarketCapUsd: input.targetMarketCapUsd ?? null,
    sender: input.sender ?? null,
    // Solana wallet: buys are paid from it.
    solanaAddress: input.solanaAddress ?? null,
  };
  const problems = validateOrder(order);
  if (problems.length) throw new Error(problems.join('; '));
  return order;
}

/**
 * Token address of an order. Older orders have no separate field but carry
 * `inTokenId` as `<address>:<network>`, which is enough for the caption and
 * for the automatic clean-up.
 */
export function orderTokenAddress(order) {
  if (order?.tokenAddress) return order.tokenAddress;
  const id = order?.side === SIDES.BUY ? order?.outTokenId : order?.inTokenId;
  const head = String(id ?? '').split(':')[0];
  return /^0x[0-9a-fA-F]{40}$/.test(head) ? head : null;
}

/** Token label for an order row: the ticker when known, else a shortened address. */
export function orderSymbol(order) {
  const symbol = String(order?.symbol ?? '').trim();
  if (symbol) return symbol;
  const address = orderTokenAddress(order);
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Orders that can no longer execute: the token was sold by hand and none of it
 * remains on the balance.
 *
 * The main danger is removing a live order by mistake. A failed balance load, a
 * changed schema, data that has not arrived yet all look like "no position".
 * So the rule is one-sided: remove ONLY when the position is known to be zero.
 * Unknown means leave it alone.
 *
 * @param {(address: string) => bigint|null|undefined} lookup balance by address;
 *   null or undefined mean "unknown", not "zero"
 */
export function ordersToRetire(orders, lookup) {
  const retire = [];
  for (const order of orders ?? []) {
    if (order.status !== ORDER_STATUS.WATCHING) continue;
    // A buy spends cash, not the token: an empty token balance does not cancel it.
    if (order.side !== SIDES.SELL) continue;
    const address = orderTokenAddress(order);
    if (!address) continue;

    let balance;
    try {
      balance = lookup(address);
    } catch {
      continue;
    }
    if (balance === null || balance === undefined) continue;
    if (BigInt(balance) > 0n) continue;

    retire.push({ id: order.id, reason: t('order.retired') });
  }
  return retire;
}

/**
 * Whether the quote has reached the target. Both sides of the trade are
 * expressed as "how much comes out", and the direction decides the comparison.
 */
export function isTriggered(order, currentOut) {
  const out = BigInt(currentOut);
  const target = BigInt(order.targetOut);
  return triggerOf(order) === TRIGGER.BELOW ? out <= target : out >= target;
}

/**
 * An existing order identical to this one in everything that decides
 * execution.
 *
 * Two identical limit orders mean selling one position twice: the watcher sees
 * two levels and the runner fires both. They appear innocently: placement
 * returned an error, the user pressed again, and the first order had already
 * been saved. Token, side, size and target are compared; a ladder of partial
 * exits differs in size or target and is not a duplicate.
 */
export function findDuplicateOrder(orders, candidate) {
  if (!candidate) return null;
  // The order's token: the output token on a buy, the input token on a sell.
  const tokenOf = (o) => String((o?.side === SIDES.BUY ? o?.outTokenId : o?.inTokenId) ?? '').toLowerCase();
  return (orders ?? []).find((o) => o
    && o.status === 'watching'
    && tokenOf(o) === tokenOf(candidate)
    && o.side === candidate.side
    && String(o.amount) === String(candidate.amount)
    && String(o.targetOut) === String(candidate.targetOut)) ?? null;
}
