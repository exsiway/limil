// Interception of the TradingView chart on the FOMO page.
//
// The chart is a self-hosted TradingView Charting Library inside a same-origin
// iframe with a blob URL, so its document and window are fully accessible,
// the condition for drawing our own order lines on their chart.
//
// Why interception and not lookup. The app keeps the widget handle in a
// closure of its bundle; it is neither on `window` nor in the React tree. But
// the constructor is taken from the global `window.TradingView`, and that is
// what we replace BEFORE the bundle reaches it, the same technique as for the
// Privy provider, for the same reason: at document_start we run before the
// page. `window.TradingView` does not exist yet at that point, so the
// assignment is intercepted with defineProperty rather than the value replaced.

/** The captured widget handle. Null until the app creates it. */
let widget = null;

/**
 * Live price from the chart's data feed.
 *
 * FOMO gives the chart a data feed that receives every tick. Since the widget
 * constructor is intercepted, the data feed is visible too: `subscribeBars`
 * is wrapped and we listen to what the chart draws. Faster and cheaper than
 * polling quotes: a quote is requested only at a level crossing.
 */
import * as fomo from './fomo-bridge.js';
import * as priceStream from './price-stream.js';

const live = {
  price: null,
  at: 0,
  ticks: 0,
  symbol: null,
  /** Whom to wake when a price arrives. Set by the panel. */
  onTick: null,
  /** The tapped data feed itself: extra symbols are subscribed through it. */
  feed: null,
  /** Token id (address:chain, lower case) of the symbol the chart shows. */
  tokenId: null,
};

/**
 * Last price per token, from the chart's own stream and from our extra
 * streams alike. Levels are checked against the price of THEIR token.
 */
const prices = new Map();
/** Prices older than this do not count as watched: the stream went quiet. */
const PRICE_FRESH_MS = 2 * 60_000;
const lower = (v) => String(v ?? '').toLowerCase();

function recordPrice(tokenId, price) {
  if (!tokenId) return;
  prices.set(tokenId, { price, at: Date.now() });
}
function priceOf(tokenId) {
  return prices.get(lower(tokenId))?.price ?? null;
}
/**
 * An order level in the units the chart is actually drawn in.
 *
 * Levels are stored as market caps, because a cap is the same number whoever
 * looks and whenever. FOMO's chart usually plots the cap too, and then there
 * is nothing to do. It does not always: on a blue chip the axis is the token
 * PRICE, and a level of $324B on an axis around $2,600 is not a line that
 * fits. It is drawn, far above everything, and a person sees an empty chart
 * and nothing anywhere saying why.
 *
 * The cap and the price of the same token arrive together from the app, and
 * their ratio is the supply. The chart then says which of the two IT is
 * speaking: whichever the reference number is closer to, in ratio rather than
 * in difference. The reference is a live tick when there is one, and the
 * middle of the visible axis otherwise.
 *
 * Without both numbers, or without a reference, the level is returned as it
 * is. Guessing would put a line at a price that is not the one the order
 * fires at, which is worse than no line.
 */
export function levelForAxis({ level, marketCapUsd, tokenPriceUsd, reference } = {}) {
  const cap = Number(level);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const capNow = Number(marketCapUsd);
  const priceNow = Number(tokenPriceUsd);
  const ref = Number(reference);
  if (!(capNow > 0) || !(priceNow > 0) || !(ref > 0)) return cap;
  const supply = capNow / priceNow;
  if (!Number.isFinite(supply) || supply <= 0) return cap;
  const towardsCap = Math.abs(Math.log(ref / capNow));
  const towardsPrice = Math.abs(Math.log(ref / priceNow));
  return towardsPrice < towardsCap ? cap / supply : cap;
}

function priceFresh(tokenId) {
  const p = prices.get(lower(tokenId));
  return Boolean(p) && Date.now() - p.at < PRICE_FRESH_MS;
}

/** Wraps the data feed to see every tick without breaking anything. */
function tapDatafeed(config) {
  const feed = config?.datafeed;
  if (!feed || typeof feed.subscribeBars !== 'function' || feed.__limilTapped) return;
  live.feed = feed;
  const original = feed.subscribeBars.bind(feed);
  feed.subscribeBars = (symbolInfo, resolution, onRealtime, uid, onReset) => {
    const wrapped = (bar) => {
      try {
        const close = Number(bar?.close);
        if (Number.isFinite(close) && close > 0) {
          live.price = close;
          live.at = Date.now();
          live.ticks += 1;
          live.symbol = symbolInfo?.name ?? symbolInfo?.ticker ?? null;
          live.tokenId = lower(symbolInfo?.ticker) || live.tokenId;
          recordPrice(live.tokenId, close);
          checkLevels(close, live.tokenId);
          if (live.onTick) live.onTick(close);
        }
      } catch { /* observation must not break the chart */ }
      return onRealtime(bar);
    };
    return original(symbolInfo, resolution, wrapped, uid, onReset);
  };
  feed.__limilTapped = true;
}

/**
 * Levels being watched and the count of consecutive ticks beyond each.
 *
 * The watcher lives here, not in the panel: ticks arrive in this world, and
 * pushing them over the bus would mean hundreds of messages a minute for one
 * event. Only the crossing itself goes out.
 *
 * Two consecutive ticks, not one: a single spike happens in the stream and
 * waking the runner on it wastes a quote. The quote after the nudge checks the
 * target itself anyway.
 */
const WATCH_CONFIRM_TICKS = 2;
let levels = [];
const streak = new Map();

/**
 * When the runner was last nudged for an order.
 *
 * A nudge does not always lead to a trade: the quote may be refused, the
 * spread too wide, the edge too small, the tab deaf. All temporary, all cured
 * by a repeat, and nobody else repeats it while the watcher covers the
 * orders. So beyond the level the nudge repeats, but not more often than once
 * a minute, the interval of the old scheduled poll.
 */
const RECROSS_COOLDOWN_MS = 60_000;
const crossedAt = new Map();

/**
 * Levels refined by an actual quote.
 *
 * Kept separately from `levels`, which is rewritten whole on every re-sync
 * (order added, cancelled, symbol changed). Without this memory every re-sync
 * would reset the level to the target-cap value that the calibration had just
 * corrected, and the next crossing would waste a quote again.
 */
const calibrated = new Map();

/**
 * Sets the levels to watch. The panel calls it on every order change.
 *
 * @param {{orderId: string, price: number, below: boolean}[]} list
 */
function watchLevels(list = []) {
  levels = (Array.isArray(list) ? list : [])
    .filter((l) => Number.isFinite(Number(l?.price)))
    // A refined level is kept, not rolled back to the target cap.
    .map((l) => (calibrated.has(l.orderId) ? { ...l, price: calibrated.get(l.orderId) } : l));
  streak.clear();
  return { watching: levels.length, price: live.price };
}

/**
 * Extra price streams: one per token that has an order but is not the token
 * the chart shows. The chart's data feed forwards only the asset on screen to
 * its listeners, so these go over a socket of our own to the same candle host
 * (main/price-stream.js). The data feed still answers `resolveSymbol`, which
 * carries the total supply needed to turn a candle price into market cap.
 */
function resolveSupply(name) {
  const feed = live.feed;
  if (!feed || typeof feed.resolveSymbol !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      feed.resolveSymbol(name, (info) => resolve(Number(info?.totalSupply) || null), () => resolve(null));
    } catch { resolve(null); }
  });
}

priceStream.configure({
  authorization: () => fomo.sessionToken(),
  resolveSupply,
  onPrice: (key, mc) => {
    recordPrice(key, mc);
    checkLevels(mc, key);
  },
});

/** Streams the given tokens (original case), except the one the chart shows. */
function ensureStreams(tokenIds) {
  const pageAddress = lower(lastRequest?.tokenAddress);
  const list = [];
  for (const id of tokenIds) {
    const key = lower(id);
    if (!key || key === live.tokenId) continue;
    // Before the first tick live.tokenId is unknown; the page address tells.
    if (pageAddress && key.startsWith(`${pageAddress}:`)) continue;
    list.push({ key, name: String(id) });
  }
  priceStream.setTokens(list);
}

/** Streams and their freshness, for diagnostics. */
function streamsInfo() {
  return priceStream.info();
}

/** Whom to wake on a crossing. Set at install. */
let onCross = null;

/**
 * Watcher heartbeat.
 *
 * The runner must know that the price is REALLY being watched, not that the
 * watcher is "configured". The beat comes from the tick handler, so it proves
 * a live stream: no ticks, no beat, and the runner goes back to polling.
 */
const BEAT_MS = 30_000;
let lastBeat = 0;
let onBeat = null;

function checkLevels(price, tokenId = live.tokenId) {
  const now = Date.now();
  if (onBeat && now - lastBeat >= BEAT_MS) {
    lastBeat = now;
    try {
      // Names, not a count: two stale levels numerically "cover" one live
      // order. Only orders whose token has a LIVE price count as watched;
      // a level on a silent stream goes back to the scheduled quotes.
      const ids = levels.filter((l) => priceFresh(l.tokenId)).map((l) => l.orderId);
      onBeat({ price, levels: levels.length, ids });
    } catch { /* the panel need not listen */ }
  }
  for (const level of levels) {
    if (level.tokenId !== tokenId) continue;
    const past = level.below ? price <= level.price : price >= level.price;
    if (!past) { streak.set(level.orderId, 0); continue; }
    const n = (streak.get(level.orderId) ?? 0) + 1;
    streak.set(level.orderId, n);
    if (n < WATCH_CONFIRM_TICKS) continue;
    // The first crossing wakes at once (no mark yet), a repeat not before a
    // minute has passed.
    if (now - (crossedAt.get(level.orderId) ?? 0) < RECROSS_COOLDOWN_MS) continue;
    crossedAt.set(level.orderId, now);
    if (onCross) {
      try { onCross(level.orderId); } catch { /* the panel need not listen */ }
    }
  }
}

/**
 * Refines a level from a quote answer.
 *
 * The level comes from `targetMarketCapUsd`, derived from a market cap that
 * arrives with incidental FOMO responses and lags on a fast move. The order
 * target (`targetOut`) is computed from a FRESH quote. When the two bases
 * diverge, the line and the level are not where the order really fires.
 *
 * Here we get a PAIR taken at one moment: how much is offered now (`median`)
 * and the chart price (`live.price`). Target over current output is the ratio
 * of the wanted level to the current price. No market cap, no lag.
 */
export function calibrate({ orderId, median } = {}) {
  const out = Number(median);
  const level = levels.find((l) => l.orderId === orderId);
  if (!level || !Number.isFinite(out) || out <= 0) return { ok: false };
  const target = Number(level.targetOut);
  if (!Number.isFinite(target) || target <= 0) return { ok: false };

  const base = priceOf(level.tokenId) ?? live.price;
  if (!base) return { ok: false };
  const fixed = base * (target / out);
  const was = level.price;
  level.price = fixed;
  calibrated.set(orderId, fixed);
  // The tick streak counted for the old level; the nudge mark goes with it.
  streak.set(orderId, 0);
  crossedAt.delete(orderId);
  // The line moves with the level: otherwise only the watcher would see the
  // refinement while the person kept looking at the old number.
  try {
    if (lastRequest) syncOrders(lastRequest);
  } catch { /* the chart may be gone, the level is refined anyway */ }
  return { ok: true, was, now: fixed };
}

/** What is known about the live price right now. */
export function livePrice() {
  return {
    price: live.price,
    ticks: live.ticks,
    watching: levels.length,
    ageMs: live.at ? Date.now() - live.at : null,
    symbol: live.symbol,
    tokenId: live.tokenId,
    streams: streamsInfo(),
  };
}

/**
 * Whom to call on a symbol change.
 *
 * Redrawing from the REMEMBERED request is wrong: it carries the token of the
 * page we left. The bridge only REPORTS the change; the panel brings the list
 * and the current address.
 */
let onSymbolChange = null;

/** Wraps the constructor so the instance lands with us. */
function wrapNamespace(ns) {
  if (!ns || typeof ns.widget !== 'function' || ns.__limilWrapped) return ns;
  const Original = ns.widget;
  function Wrapped(...args) {
    // The data feed comes in the widget options, tap it BEFORE construction.
    try { tapDatafeed(args[0]); } catch { /* we can live without ticks */ }
    const instance = new Original(...args);
    widget = instance;
    // Drawing is possible only once ready: activeChart() does not exist before.
    try {
      instance.onChartReady(() => {
        // A NEW WIDGET, not a symbol change. Moving between tokens reuses the
        // chart, but leaving the token page and coming back creates the widget
        // anew. There is no pending request at that moment, so the panel is
        // asked what to draw here and now.
        if (pending) flushPending();
        else if (onSymbolChange) {
          try { onSymbolChange(); } catch { /* the panel may not be up yet */ }
        }

        // Redraw on symbol change. Moving between tokens inside the app does
        // NOT recreate the widget: it reuses the chart and changes the symbol.
        // Our shapes disappear with the old data, and the constructor hook does
        // not fire because nothing is constructed.
        try {
          const chart = instance.activeChart();
          chart.onSymbolChanged().subscribe(null, () => {
            // The last tick belongs to the previous token: until the first
            // tick of the new one there is no live price.
            live.price = null;
            live.at = 0;
            clearOrders();
            if (onSymbolChange) {
              try { onSymbolChange(); } catch { /* the panel may not be up yet */ }
            } else {
              flushPending();
            }
          });
        } catch { /* no symbol-change hook in this build: the next request redraws */ }
      });
    } catch { /* a build without onChartReady, drawn on the next request */ }
    return instance;
  }
  Wrapped.prototype = Original.prototype;
  // Copy the statics: the library hangs versions and utilities on the constructor.
  Object.setPrototypeOf(Wrapped, Original);
  ns.widget = Wrapped;
  ns.__limilWrapped = true;
  return ns;
}

export function install({ onSymbolChange: notify = null, onCross: cross = null, onBeat: beat = null } = {}) {
  onSymbolChange = notify;
  onCross = cross;
  onBeat = beat;
  if (window.__limilChartInstalled) return;
  window.__limilChartInstalled = true;

  // The library may already be loaded (a soft reload, for instance).
  if (window.TradingView) {
    wrapNamespace(window.TradingView);
    return;
  }

  let stored;
  try {
    Object.defineProperty(window, 'TradingView', {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set: (value) => {
        stored = wrapNamespace(value);
      },
    });
  } catch {
    // Could not, do not break the page: the chart is theirs and matters more
    // than our line.
  }
}

/** The widget handle, for diagnostics. */
function instance() {
  return widget;
}

// ---------------------------------------------------------------- drawing

/** Drawn lines by order id, so they can be removed individually. */
const drawn = new Map();

/**
 * Everything we ever drew on this chart.
 *
 * `drawn` was cleared on symbol change and redraw on the assumption that the
 * shapes died with the old chart data. When they survive, the handles are lost
 * and nothing can remove them: a cancelled order vanished from the list while
 * its line stayed on the chart until a page reload. Here the ids are NOT lost;
 * removal goes through this set and misses are swallowed.
 */
const ours = new Set();

/**
 * The last draw request, deferred until the chart is ready. The panel reads
 * the orders right at page load, the widget appears a second later and is
 * ready later still; without deferral the first sync went nowhere.
 */
let pending = null;

/**
 * The last satisfied request, to redraw after the chart is recreated. FOMO
 * recreates the widget when moving between tokens through other pages; the
 * handles in `drawn` then point nowhere, and the panel does not re-sync on a
 * plain navigation.
 */
let lastRequest = null;

function flushPending() {
  const request = pending ?? lastRequest;
  pending = null;
  if (!request) return;
  // Remove for real: if the shapes survived the data change, forgetting them
  // leaves them on the chart forever.
  clearOrders();
  try { syncOrders(request); } catch { /* drawn on the next change */ }
}

/**
 * The chart's units. The FOMO chart is drawn in MARKET CAP (the axis reads
 * "6.18M", "$2.6M"), and the orders keep the target cap in
 * `targetMarketCapUsd`, same quantity, same scale, so the line is placed by
 * it directly. Checked against the visible range: orders of magnitude apart
 * means the line would run off screen and lie.
 */
function visibleRange(chart) {
  try {
    const pane = chart.getPanes()[0];
    const scale = pane.getMainSourcePriceScale();
    const r = scale.getVisiblePriceRange();
    return r && Number.isFinite(r.from) && Number.isFinite(r.to) ? r : null;
  } catch {
    return null;
  }
}

const RED = '#ff4d5e';
const GREEN = '#3ecf8e';
const BLUE = '#6c8cff';

/**
 * Our lines are recognised ON THE CHART by this label, not in our memory.
 *
 * TradingView saves shapes in the chart layout and restores them on the next
 * load, while our handles live in page memory and do not survive it. The
 * result is an orphan line that nothing can remove. Recognising by text
 * removes the dependence on memory: our lines are found on the chart itself,
 * and foreign drawings do not match our label format.
 */
const LABEL_MARK = /^(Take Profit|Stop Loss|Buy)\b/;

/**
 * Removes ALL our lines found on the chart, orphans included. Returns how many.
 */
function sweepOrphans(chart) {
  let swept = 0;
  let shapes;
  try { shapes = chart.getAllShapes(); } catch { return 0; }
  for (const shape of shapes ?? []) {
    try {
      const props = chart.getShapeById(shape.id)?.getProperties?.();
      const text = String(props?.text ?? '');
      if (!LABEL_MARK.test(text)) continue;
      chart.removeEntity(shape.id);
      swept += 1;
    } catch { /* not ours or already gone */ }
  }
  return swept;
}

function styleLine(line, color) {
  // Each call separately: the set of stylers differs between builds, and one
  // missing function must not cancel the whole line.
  const calls = [
    ['setLineColor', color], ['setBodyBorderColor', color], ['setBodyTextColor', color],
    ['setQuantityBackgroundColor', color], ['setQuantityBorderColor', color],
    ['setCancelButtonBorderColor', color], ['setCancelButtonIconColor', color],
    ['setBodyBackgroundColor', '#12131a'], ['setCancelButtonBackgroundColor', '#12131a'],
    ['setLineStyle', 2], ['setLineLength', 100],
  ];
  for (const [name, value] of calls) {
    try { if (typeof line[name] === 'function') line[name](value); } catch { /* styling matters less than the line */ }
  }
}

/** Removes all our lines. Foreign drawings are left alone. */
function clearOrders({ sweep = false } = {}) {
  let chart = null;
  try { chart = widget?.activeChart(); } catch { /* the chart is gone */ }
  if (sweep && chart) sweepOrphans(chart);

  // Order lines first (they have their own removal).
  for (const placed of drawn.values()) {
    if (placed?.kind === 'shape') continue;
    try { placed?.handle?.remove?.(); } catch { /* already gone */ }
  }
  // Then ALL our shapes, including those whose handles were forgotten.
  for (const id of ours) {
    try { chart?.removeEntity(id); } catch { /* the shape may be gone */ }
  }
  drawn.clear();
  ours.clear();
}

/** Forgets an order's calibration: it is closed or cancelled. */
function forgetOrder(orderId) {
  calibrated.delete(orderId);
  streak.delete(orderId);
  crossedAt.delete(orderId);
}

/**
 * Draws the active orders as lines on their chart.
 *
 * @param {object} opts
 * @param {object[]} opts.orders orders in status watching
 * @param {string} opts.tokenAddress token address of the open page
 */
export function syncOrders({ orders = [], tokenAddress = null, marketCapUsd = null, tokenPriceUsd = null } = {}) {
  // Remembered BEFORE the checks: even a deferred request must survive a
  // chart recreation.
  lastRequest = { orders, tokenAddress, marketCapUsd, tokenPriceUsd };

  // A closed order is forgotten HERE. The panel sends ALL live orders, not
  // only the open token's, so absence from the list means the order is gone.
  // Its memory (refined level, tick streak, nudge mark) would otherwise
  // survive the re-sync and wake the runner for nothing.
  const alive = new Set(orders.map((o) => o?.id).filter(Boolean));
  for (const id of new Set([...calibrated.keys(), ...streak.keys(), ...crossedAt.keys()])) {
    if (!alive.has(id)) forgetOrder(id);
  }

  const report = { drawn: 0, skipped: [], range: null };
  // KEEP THE UNITS WITH THE DEFERRED REQUEST. Dropping them here is what made
  // a level vanish on RELOAD and only on reload: at a page load the panel
  // syncs before FOMO has constructed the chart, so the request waits; when
  // the chart arrived, flushPending drew from a request with no cap and no
  // price, the level stayed the market cap it is stored as, and on an axis
  // drawn in prices a cap is off the scale and is dropped. Moving between
  // tokens never showed it, because by then the widget exists, nothing is
  // deferred and the units travel with the request.
  const deferred = { orders, tokenAddress, marketCapUsd, tokenPriceUsd };
  if (!widget) {
    // Keep the request: draw as soon as the chart appears.
    pending = deferred;
    report.skipped.push('widget not captured, deferred until the chart is ready');
    return report;
  }

  let chart;
  try { chart = widget.activeChart(); } catch (err) {
    pending = deferred;
    report.skipped.push(`chart not ready, deferred: ${String(err?.message || err)}`);
    return report;
  }
  // createOrderLine exists in their build but throws ("only available on
  // Trading Platform"); the fallback below draws a shape instead.
  const hasOrderLine = typeof chart.createOrderLine === 'function';

  // Levels for the watcher are collected here: the order target is stored in
  // the same quantity the chart axis is in, market cap.
  const watch = [];

  clearOrders();
  // Sweep orphans: lines that survived a reload in the chart layout are
  // unknown to our memory and would otherwise stay forever.
  const swept = sweepOrphans(chart);
  if (swept) report.swept = swept;
  const range = visibleRange(chart);
  report.range = range ? { from: range.from, to: range.to } : null;

  for (const order of orders) {
    // Draw THE NUMBER THE WATCHER DECIDES BY. A level refined by a quote wins
    // over the one derived from the target cap; otherwise the screen shows one
    // thing and the trigger fires on another.
    const stored = calibrated.get(order?.id) ?? Number(order?.targetMarketCapUsd);
    if (!Number.isFinite(stored) || stored <= 0) {
      report.skipped.push(`${order?.id}: no target market cap, nothing to draw`);
      continue;
    }
    const ownId = order?.side === 'buy' ? order?.outTokenId : order?.inTokenId;
    const own = String(ownId ?? '').split(':')[0].toLowerCase();
    // A level calibrated by a quote is already in the feed's units; only a
    // stored cap needs the supply applied. Done BEFORE the level is watched,
    // because the watcher compares it against the same feed: a cap held up
    // against a price stream never crosses, and the fast path simply never
    // fires.
    const reference = priceOf(ownId)
      ?? (own === String(tokenAddress ?? '').toLowerCase() ? live.price : null)
      ?? (range ? (range.from + range.to) / 2 : null);
    const price = calibrated.has(order?.id) ? stored : (levelForAxis({
      level: stored, marketCapUsd, tokenPriceUsd, reference,
    }) ?? stored);
    const isBuy = order.side === 'buy';
    // Direction BY PRICE. On a sell "output at most the target" is a price
    // drop; on a buy the output is tokens for the same cash, and "at least
    // the target" is a price drop too. The chart level is always a price level.
    const below = isBuy ? order.triggerWhen === 'at-or-above' : order.triggerWhen === 'at-or-below';

    // EVERY order is watched, whatever token the page shows: the level is
    // checked against its own token's stream (see ensureStreams). targetOut
    // travels with the level: the level is calibrated by it later.
    if (ownId) watch.push({ orderId: order.id, price, below, targetOut: order.targetOut, tokenId: lower(ownId), tokenName: String(ownId) });

    // An order of another token is not DRAWN here, and UNKNOWN counts as
    // another token. An empty `tokenAddress` happens routinely (the panel syncs
    // right after reading storage, before the context arrives), and treating
    // it as "draw everything" put a level of one token in front of the live
    // price of another.
    if (!tokenAddress || !own || own !== String(tokenAddress).toLowerCase()) {
      if (!tokenAddress) report.skipped.push(`${order?.id}: page token unknown, not drawing`);
      continue;
    }

    // The magnitude must match the axis, or the line runs off screen.
    if (range) {
      const mid = (range.from + range.to) / 2;
      if (mid > 0 && (price / mid > 1000 || mid / price > 1000)) {
        // WHY it does not fit decides whether this is worth reporting. With no
        // cap and price for this token the level could not be converted at
        // all, and on a chart drawn in prices a cap never fits: that is the
        // ordinary state of the first sync after a load or a token change, and
        // the panel redraws as soon as the two numbers arrive. Saying "not in
        // the scale of the axis" there sends a person looking for a bug in the
        // order.
        const unconverted = !(Number(marketCapUsd) > 0) || !(Number(tokenPriceUsd) > 0);
        report.skipped.push(unconverted
          ? `${order.id}: deferred, the cap and price of this token are not known yet`
          : `${order.id}: target ${price} is not in the scale of the axis (~${Math.round(mid)})`);
        continue;
      }
    }

    const stop = !isBuy && below;
    const color = isBuy ? BLUE : (stop ? RED : GREEN);

    // Terminal-style label with the POSITION SHARE: `amountPercent` (how much
    // is sold), not `percent` (how far the target is from the market).
    const share = Number(order.amountPercent);
    const shareText = Number.isFinite(share) && share > 0 ? ` | ${share.toFixed(0)}%` : '';
    // The exact level IN THE LABEL: the axis and the page header round to one
    // digit, so a $4.25M target and a $4.20M market both read "$4.2M". Two
    // decimals settle "why did it not fire yet".
    const level = price >= 1e9 ? `$${(price / 1e9).toFixed(2)}B`
      : price >= 1e6 ? `$${(price / 1e6).toFixed(2)}M`
        : price >= 1e3 ? `$${(price / 1e3).toFixed(1)}K`
          : `$${price.toFixed(2)}`;
    const label = `${isBuy ? 'Buy' : (stop ? 'Stop Loss' : 'Take Profit')}${shareText} · ${level}`;

    // A real order line first: label, cross, dragging. On the plain Charting
    // Library the method throws, so the refusal is routine and we fall back to
    // a shape.
    let placed = null;
    try {
      if (!hasOrderLine) throw new Error('no such method');
      const line = chart.createOrderLine();
      line.setPrice(price);
      if (typeof line.setText === 'function') line.setText(label);
      if (typeof line.setQuantity === 'function') line.setQuantity(share);
      styleLine(line, color);
      placed = { kind: 'orderLine', handle: line };
    } catch (err) {
      report.skipped.push(`${order.id}: order line unavailable (${String(err?.message || err).slice(0, 60)}), drawing a shape`);
    }

    if (!placed) {
      try {
        // A horizontal line as a shape: no cross and no dragging, but with a
        // label, and the chart keeps the coordinates.
        const visible = typeof chart.getVisibleRange === 'function' ? chart.getVisibleRange() : null;
        const time = visible?.to ?? Math.floor(Date.now() / 1000);
        const id = chart.createShape({ time, price }, {
          shape: 'horizontal_line',
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          overrides: {
            linecolor: color,
            linewidth: 2,
            linestyle: 2,
            showLabel: true,
            text: label,
            textcolor: color,
            horzLabelsAlign: 'left',
            vertLabelsAlign: 'bottom',
            showPrice: true,
          },
        });
        if (id) {
          placed = { kind: 'shape', handle: id };
          ours.add(id);
        }
      } catch (err) {
        report.skipped.push(`${order.id}: shape not placed (${String(err?.message || err).slice(0, 80)})`);
      }
    }

    if (placed) {
      drawn.set(order.id, placed);
      report.drawn += 1;
      report.kind = placed.kind;
    }
  }
  // Levels for the watcher: from here a crossing wakes the runner within
  // seconds instead of waiting for the minute alarm.
  watchLevels(watch);
  // Streams for the tokens the chart does not show.
  ensureStreams([...new Map(watch.map((w) => [w.tokenId, w.tokenName])).values()]);
  report.watching = watch.length;
  report.streams = priceStream.info().tokens.length;
  return report;
}
