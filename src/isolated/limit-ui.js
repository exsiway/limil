// The limit order panel embedded in the FOMO interface.
//
// It sits under the trade card (Buy/Sell) of a token page, same column, same
// width. The anchor is found by the button text and a Tailwind class, not by
// generated class names, which change with every rebuild of their app.
//
// The balance comes from their API through the MAIN world, not from the DOM:
// the DOM shows a rounded "16.7K", from which the exact amount in minimal
// units, the one signed into the UserOperation, cannot be recovered.

import { CASH_DECIMALS, CASH_TOKEN_ADDRESS, CASH_TOKEN_ID } from '../shared/chains.js';
import {
  extractTokenBalance,
  extractWallets,
  normalizeBalance,
  toMinimalUnits,
  tokenFromLocation,
  tokenIdFromLocation,
  tokenPageUrl,
} from '../shared/balances.js';
import {
  DEFAULT_MAX_SLIPPAGE_BPS,
  SIDES,
  amountFromPercent,
  bpsToPercent,
  chartTrouble,
  createOrder,
  describeOrder,
  findDuplicateOrder,
  formatCompact,
  formatSlippage,
  orderSymbol,
  orderTokenAddress,
  ordersToRetire,
  percentToBps,
  targetMarketCap,
  targetOutFromPercent,
  tickerLabel,
} from '../shared/orders.js';
import { QUOTE_SCALE, describeRoute, parseSwapQuote } from '../shared/swaps.js';
import { findTokenInfo } from '../shared/marketcap.js';
import { baseCss, cssVariables, fontFaces } from '../shared/theme.js';
import { attachTooltip } from '../shared/tooltip.js';
import { localeDir, t } from '../shared/i18n.js';

const PANEL_ID = 'limil-panel';
const STYLE_ID = 'limil-panel-style';
const ANCHOR_TEXTS = ['closed trades'];
const ANCHOR_TAGS = 'div,section,article,header,button,h1,h2,h3,h4,h5,h6,span,p,li,summary,td';

const state = {
  observer: null,
  docked: true,
  collapsed: false,
  context: null,           // {symbol, decimals, balance, tokenId, cash…}
  form: {
    side: SIDES.SELL,
    amountPercent: 10,
    targetPercent: 60,
    // One number for both: the tolerance against the target and the pool impact cap.
    slippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
  },
  orders: [],
  notice: null,
  lastMountReason: null,
  loadingContext: false,
  ordersOpen: false,
  /** When the balance was last updated, by any path. */
  lastBalanceAt: null,
  /**
   * Update source counters. free, read from the page's own response at no
   * cost; polled, requested by us.
   */
  balanceStats: { free: 0, polled: 0, failed: 0 },
  /** What relay set in the last quote. FOMO has no value of its own. */
  relaySlippageBps: null,
  /** Token market cap taken from the front end's responses. */
  marketCapUsd: null,
  priceUsd: null,
  /**
   * When the cap was received. Freshness matters: it arrives only with
   * incidental responses and lags the chart by minutes on a fast move.
   */
  marketCapAt: 0,
  /**
   * Whose cap it is. Without the binding, after a token switch the target
   * level was computed from the neighbour's cap.
   */
  marketCapFor: null,
  /** Route and its tolerance, probed BEFORE an order is placed. Per side. */
  routeBySide: {},
  probing: false,
};

let callBackground = async () => { throw new Error(t('panel.notReady')); };
let callMain = async () => { throw new Error(t('panel.notReady')); };

export function attachBackground(fn) { callBackground = fn; }
export function attachMain(fn) { callMain = fn; }

// -------------------------------------------------------------------- styles

const CSS = () => `
${fontFaces((p) => chrome.runtime.getURL(p))}

/* The panel is a FOMO card: border-bg-tertiary, rounded-2xl, p-2, gap-2. Its
   variables come from the page (their Tailwind theme) with our fallbacks. */
#${PANEL_ID} {
${cssVariables()}
  width: 322px;
  border: 1px solid var(--lc-line);
  border-radius: var(--lc-r-lg);
  overflow: visible;
  background: var(--lc-bg);
  color: var(--lc-text);
  font: 500 14px/1.5 var(--lc-font);
  box-shadow: 0 14px 40px rgba(0,0,0,.55);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
#${PANEL_ID}[data-float="1"] { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; }
#${PANEL_ID}[data-float="0"] { position: static; width: auto; margin: 8px 0 0; box-shadow: none; }
#${PANEL_ID} * { box-sizing: border-box; }

${baseCss(`#${PANEL_ID}`)}

#${PANEL_ID} .lc-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px 4px; user-select: none;
}
#${PANEL_ID}[data-collapsed="1"] .lc-head { padding: 10px 12px; }
#${PANEL_ID} .lc-title { font-weight: 700; font-size: 16px; flex: 1; }
#${PANEL_ID} .lc-icon {
  background: none; border: none; color: var(--lc-dim); cursor: pointer;
  font: inherit; font-size: 14px; line-height: 1; padding: 4px 6px; border-radius: var(--lc-r-xs);
}
#${PANEL_ID} .lc-icon:hover { color: var(--lc-text); background: var(--lc-line); }
#${PANEL_ID} .lc-body { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 8px; }
#${PANEL_ID}[data-collapsed="1"] .lc-body { display: none; }
#${PANEL_ID} .lc-quick { display: flex; gap: 6px; }
#${PANEL_ID} .lc-quick button {
  flex: 1; padding: 4px 0; border-radius: var(--lc-r-xs); border: none;
  background: var(--lc-card-hover); color: var(--lc-dim); cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 700; transition: color .15s, background-color .15s;
}
#${PANEL_ID} .lc-quick button:hover { color: var(--lc-text); }
#${PANEL_ID} .lc-quick button.on { color: var(--lc-text); background: var(--lc-line); }
/* Slider: 4px track filled to the thumb in the accent, white round thumb. */
#${PANEL_ID} input[type=range] {
  -webkit-appearance: none; appearance: none; width: 100%; height: 20px; margin: 0;
  background: transparent; cursor: pointer; --fill: 50%;
}
#${PANEL_ID} input[type=range]::-webkit-slider-runnable-track {
  height: 4px; border-radius: 999px;
  background: linear-gradient(to right, var(--lc-accent) 0, var(--lc-accent) var(--fill), var(--lc-line-strong) var(--fill), var(--lc-line-strong) 100%);
}
#${PANEL_ID} input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 16px; height: 16px; margin-top: -6px;
  border-radius: 50%; background: var(--lc-text); border: none;
  box-shadow: 0 1px 3px rgba(0,0,0,.35); transition: transform .15s ease, box-shadow .15s ease;
}
#${PANEL_ID} input[type=range]:active::-webkit-slider-thumb,
#${PANEL_ID} input[type=range]:focus-visible::-webkit-slider-thumb { transform: scale(1.15); }
#${PANEL_ID} input[type=range]:focus-visible { outline: none; }
#${PANEL_ID} input[type=range]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--lc-accent-soft); }
#${PANEL_ID} .lc-scale {
  display: flex; justify-content: space-between;
  color: var(--lc-faint); font-size: 10px; margin: -4px 0 0;
}
#${PANEL_ID} .lc-summary { font-size: 12px; font-weight: 500; padding: 0 4px; }
#${PANEL_ID}[data-side="sell"] .lc-summary { color: var(--lc-sell); }
#${PANEL_ID}[data-side="buy"] .lc-summary { color: var(--lc-buy); }
/* The action button: FOMO's filled trade button, green for buy, red for sell. */
#${PANEL_ID} .lc-go {
  width: 100%; padding: 10px; border-radius: var(--lc-r-sm); border: none;
  font: inherit; font-size: 16px; font-weight: 700; cursor: pointer; color: var(--lc-bg);
  transition: filter .15s ease, opacity .15s ease;
}
#${PANEL_ID}[data-side="sell"] .lc-go { background: var(--lc-sell); }
#${PANEL_ID}[data-side="buy"] .lc-go { background: var(--lc-buy); }
#${PANEL_ID} .lc-go:hover { filter: brightness(1.08); }
#${PANEL_ID} .lc-go:disabled { opacity: .5; cursor: not-allowed; filter: none; }
/* "Auto-execution is off" block: their critical-transparent surface. */
#${PANEL_ID} .lc-warn-block {
  padding: 8px 12px; border-radius: var(--lc-r-sm);
  background: var(--lc-bad-soft); border: 1px solid var(--lc-bad-soft);
  color: var(--lc-bad); display: grid; gap: 4px; font-size: 12px; line-height: 1.4;
}
#${PANEL_ID} .lc-warn-block b { font-weight: 700; }
#${PANEL_ID} .lc-warn-block span { color: var(--lc-text); opacity: .85; }
#${PANEL_ID} .lc-slip {
  border-radius: var(--lc-r-sm); padding: 6px 12px; background: var(--lc-card);
}
#${PANEL_ID} .lc-slip-head { display: flex; align-items: center; gap: 8px; }
#${PANEL_ID} .lc-slip-head .lc-unit:first-child { flex: 1; font-size: 14px; color: var(--lc-dim); }
#${PANEL_ID} .lc-slip-auto {
  padding: 4px 8px; border-radius: var(--lc-r-xs); border: none;
  background: var(--lc-card-hover); color: var(--lc-dim); cursor: pointer; font: inherit; font-size: 12px;
  font-weight: 700; white-space: nowrap;
}
#${PANEL_ID} .lc-slip-auto.on { color: var(--lc-text); background: var(--lc-line); }
#${PANEL_ID} .lc-slip-custom {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 8px;
  border: 1px solid var(--lc-line-strong); border-radius: var(--lc-r-xs); background: transparent;
}
#${PANEL_ID} .lc-slip-custom:focus-within { border-color: var(--lc-accent); }
#${PANEL_ID} .lc-slip-input {
  width: 44px; padding: 4px 0; border: none; background: transparent; color: var(--lc-text);
  font: inherit; font-size: 12px; text-align: right; outline: none; -moz-appearance: textfield;
  font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .lc-slip-input::-webkit-outer-spin-button, #${PANEL_ID} .lc-slip-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
#${PANEL_ID} .lc-balance {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 0 4px;
}
#${PANEL_ID} .lc-balance .lc-muted { margin: 0; }
#${PANEL_ID} .lc-balance-tools { display: flex; align-items: center; gap: 6px; flex: none; }
#${PANEL_ID} .lc-warn-row { position: relative; display: inline-flex; cursor: help; }
#${PANEL_ID} .lc-warn-mark { color: var(--lc-warn); font-size: 14px; line-height: 1; }
#${PANEL_ID} .lc-warn-row .lc-tip { white-space: pre-line; }
#${PANEL_ID} .lc-orders { border-top: 1px solid var(--lc-line); padding-top: 8px; }
#${PANEL_ID} .lc-orders-head {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; padding: 2px 4px; background: none; border: none;
  color: var(--lc-dim); font: inherit; font-size: 12px; cursor: pointer;
  text-align: start; line-height: 1.4;
}
#${PANEL_ID} .lc-orders-head:hover { color: var(--lc-text); }
#${PANEL_ID} .lc-chevron { transition: transform .14s ease; flex: none; }
#${PANEL_ID} .lc-collapse { display: inline-flex; align-items: center; }
#${PANEL_ID} .lc-collapse.open .lc-chevron { transform: rotate(180deg); }
#${PANEL_ID} .lc-orders-head.open .lc-chevron { transform: rotate(180deg); }
#${PANEL_ID} .lc-order {
  display: flex; justify-content: space-between; gap: 8px; align-items: center;
  padding: 6px 4px; border-bottom: 1px solid var(--lc-line); font-size: 12px;
}
#${PANEL_ID} .lc-order-text { flex: 1; min-width: 0; }
#${PANEL_ID} .lc-side { font-weight: 700; }
#${PANEL_ID} .lc-side.sell { color: var(--lc-sell); }
#${PANEL_ID} .lc-side.buy { color: var(--lc-buy); }
#${PANEL_ID} .lc-ticker { color: var(--lc-text); font-weight: 700; text-decoration: none; }
#${PANEL_ID} a.lc-ticker { color: var(--lc-accent); }
#${PANEL_ID} a.lc-ticker:hover { color: var(--lc-text); text-decoration: underline; }
#${PANEL_ID} .lc-order button {
  background: none; border: none; color: var(--lc-faint); cursor: pointer;
  font: inherit; padding: 2px 4px; border-radius: var(--lc-r-xs); display: inline-flex;
  align-items: center; flex: none;
}
#${PANEL_ID} .lc-order button:hover { background: var(--lc-sell-soft); color: var(--lc-sell); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS();
  // At document_start there is no head yet, do not fail here, or mounting
  // dies silently and the panel never appears.
  (document.head ?? document.documentElement).append(style);
}

// -------------------------------------------------------------------- anchor

function matchesAnchorText(el) {
  const text = (el.textContent ?? '').trim().toLowerCase();
  if (!text || text.length > 40) return false;
  return ANCHOR_TEXTS.some((a) => text === a || text.startsWith(a));
}

/** Is this a token page? Only there the trade card and the panel belong. */
function isTokenPage() {
  return Boolean(tokenIdFromLocation(location.href));
}

/**
 * The trade card: the FOMO block with the Buy/Sell segment and the amount
 * field (`div.rounded-2xl` around the Buy button). The panel goes right after
 * it, same column, same width. Found by button text and the rounded class.
 */
function findTradeCard() {
  const buy = [...document.querySelectorAll('button')].find((b) => {
    const text = (b.textContent ?? '').trim().toLowerCase();
    return (text === 'buy' || text === 'sell') && /flex-1/.test(String(b.className));
  });
  let card = buy?.parentElement ?? null;
  for (let i = 0; i < 6 && card; i += 1, card = card.parentElement) {
    if (/rounded-2xl/.test(String(card.className)) && card.getBoundingClientRect().width > 200) return card;
  }
  return null;
}

/** The trade card, or as a fallback the "Closed trades" section. */
function findAnchor() {
  const card = findTradeCard();
  if (card) return card;
  for (const el of document.querySelectorAll(ANCHOR_TAGS)) {
    if (!matchesAnchorText(el)) continue;
    let section = el;
    for (let i = 0; i < 3 && section.parentElement; i += 1) {
      if (section.parentElement.childElementCount > 1) break;
      section = section.parentElement;
    }
    return section;
  }
  return null;
}

// ------------------------------------------------------------------- context

function contextSummary() {
  const ctx = state.context;
  if (!ctx) return null;
  return {
    symbol: ctx.symbol,
    tokenId: ctx.tokenId,
    balance: ctx.balance?.toString() ?? null,
    decimals: ctx.decimals ?? null,
    marketCapUsd: state.marketCapUsd,
    sender: ctx.sender ?? null,
    solanaAddress: ctx.solanaAddress ?? null,
    cash: ctx.cashBalance?.toString() ?? null,
    error: ctx.error ?? null,
  };
}

/**
 * Asks their API which token is open and how much of it the wallet holds. One
 * request per page open, not a poll: their API is behind Cloudflare.
 */
export async function refreshContext() {
  if (state.loadingContext) return state.context;
  state.loadingContext = true;
  try {
    const address = tokenFromLocation(location.href);
    if (!address) {
      state.context = { error: null, notOnToken: true };
      return state.context;
    }

    // The user id comes from the paths of their own requests, already seen by
    // the interceptor.
    const session = await callMain('fomo.status');
    const uuid = session?.userId;
    if (!uuid) {
      // The id appears as soon as the page talks to their API. Wait quietly:
      // the user cannot influence it.
      state.context = { error: null, waiting: true };
      scheduleContextRetry();
      return state.context;
    }

    const balances = await callMain('fomo.balances', { uuid });
    state.balanceStats.polled += 1;
    return applyBalances(balances, { address, uuid, source: 'poll' });
  } catch (err) {
    state.context = { ...state.context, error: String(err?.message || err) };
    // An error is a reason to retry too: the page may not have been ready.
    scheduleContextRetry();
    return state.context;
  } finally {
    state.loadingContext = false;
    // The EVM wallet address comes from the balance rows, and there are none
    // while the wallet holds no EVM token, right before the first buy. Then
    // the Privy envelope gives the address: it is the wallet we sign with.
    if (state.context && !state.context.sender) {
      callMain('gate.inspect')
        .then((info) => {
          if (info?.address && state.context && !state.context.sender) {
            state.context.sender = info.address;
            render();
          }
        })
        .catch(() => { /* no envelope yet, the address comes with the balance */ });
    }
    // Can the extension sign for this wallet at all? Asked with the context:
    // the answer depends on the wallet, which changes here. Local, over the
    // bus, no network.
    callMain('privy.canSign', { sender: state.context?.sender ?? null })
      .then((res) => {
        const was = state.canSign?.ok;
        state.canSign = res ?? null;
        if (was !== res?.ok) render();
      })
      .catch(() => { /* MAIN not up, no warning, so as not to alarm for nothing */ });
    render();
  }
}

/**
 * Probes the route and its tolerance BEFORE an order is placed.
 *
 * The tolerance is set by the route, and the spread between routes is large:
 * 600-732 bps on a sell from 4663, 1000 on a buy, 2000 on Base, 4500 on a
 * Solana-native swap. Learning it at the click is too late. A quote executes
 * nothing and costs nothing.
 */
async function probeRoute() {
  const calc = computed();
  if (!calc || state.probing) return;
  const side = state.form.side;
  if (state.routeBySide[side]) return;

  state.probing = true;
  try {
    const raw = await callMain('fomo.quote', {
      inTokenId: calc.inTokenId,
      outTokenId: calc.outTokenId,
      amount: calc.amount.toString(),
    });
    const quote = parseSwapQuote(raw);
    state.routeBySide[side] = {
      route: quote.route,
      canExecute: quote.canExecute,
      slippageBps: quote.slippageBps ?? null,
    };
    if (quote.slippageBps !== null && quote.slippageBps !== undefined) {
      state.relaySlippageBps = Number(quote.slippageBps);
    }
  } catch (err) {
    state.routeBySide[side] = { error: String(err?.message || err) };
  } finally {
    state.probing = false;
    render();
  }
}

/** How much of what is sold/bought with the current form. */
function computed() {
  const ctx = state.context;
  if (!ctx || ctx.error) return null;
  const selling = state.form.side === SIDES.SELL;
  const balance = selling ? ctx.balance : ctx.cashBalance;
  const decimals = selling ? ctx.decimals : ctx.cashDecimals;
  const symbol = selling ? (ctx.symbol || '') : 'USDC';
  if (!balance || balance <= 0n) return null;
  try {
    return {
      amount: amountFromPercent(balance, state.form.amountPercent),
      decimals,
      symbol,
      // The token may not be on the balance (a first buy): the id comes from the page URL.
      inTokenId: selling ? ctx.tokenId : CASH_TOKEN_ID,
      outTokenId: selling ? CASH_TOKEN_ID : (ctx.tokenId ?? tokenIdFromLocation(location.href)),
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- rendering

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) el.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/**
 * Wraps a listener so that only a REAL event reaches it.
 *
 * The panel lives in the page's DOM, and a page script can dispatch any event
 * on any element it finds: `input` on the amount field after setting it to
 * 100, `click` on the Buy segment, `click` on an order's trash button. Such
 * events arrive with isTrusted === false, and every control of the panel
 * drops them, so `state.form` is written by the person's own input only. This
 * is the first half of the defence; the second is fieldDrift(), which
 * compares the fields with the form at the moment of placing.
 *
 * A closed shadow root would put the controls out of the page's reach
 * altogether and was considered. It is not done here: the panel is styled by
 * a stylesheet in the document head keyed on its id (ensureStyle, theme.js),
 * is found by id from a dozen places in this file and by the chart bridge,
 * and moving all of that inside a root buys little once a script that reaches
 * the elements can change neither the form nor what place() reads.
 */
function real(handler) {
  return (ev) => {
    if (ev?.isTrusted === false) return;
    handler(ev);
  };
}

/**
 * What the fields show against what the form holds, at placing time.
 *
 * The form is written by trusted events only (see real()). A page script that
 * set `input.value` directly, or dispatched a synthetic input event, changed
 * the field and not the form: the person then reads one number on screen and
 * would trade another, and a single real click on the button would do it. So
 * the fields are read back from the DOM and compared with the form one by
 * one; any difference refuses the placement and names the field. The slider
 * is not compared: it mirrors the number field and clamps to its own range.
 *
 * @returns {string|null} the name of the field that differs, or null
 */
function fieldDrift() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return 'panel';
  const { form } = state;
  const amount = panel.querySelector('.lc-amount');
  if (amount && Number(amount.value) !== Number(form.amountPercent)) return 'amount';
  const target = panel.querySelector('#lc-target-number');
  if (target && Number(target.value) !== Number(form.targetPercent)) return 'target';
  const slip = panel.querySelector('.lc-slip-input');
  if (slip) {
    let shown;
    try {
      shown = slip.value === '' ? DEFAULT_MAX_SLIPPAGE_BPS : percentToBps(slip.value);
    } catch {
      shown = null;
    }
    if (shown !== form.slippageBps) return 'slippage';
  }
  const sellButton = panel.querySelector('.lc-seg button.sell');
  if (sellButton && sellButton.classList.contains('on') !== (form.side === SIDES.SELL)) return 'side';
  return null;
}

/**
 * Round "?" with a hover tooltip. The tooltip is an ordinary child node shown
 * by CSS, not a title attribute: title allows neither line breaks nor timing.
 */
function helpButton(text) {
  const button = h('button', {
    class: 'lc-help',
    type: 'button',
    'aria-label': text,
    // The click does nothing: the button exists to be hovered and focused.
    onclick: (ev) => ev.preventDefault(),
  }, ['?', h('span', { class: 'lc-tip' }, text)]);
  attachTooltip(button, button.querySelector('.lc-tip'));
  return button;
}

/**
 * Cancels orders whose token was sold by hand and is no longer on the balance.
 *
 * The danger is one-sided: leaving a spare order is minor, erasing a live one
 * by mistake loses the user's work. So it acts ONLY on a response of the right
 * shape, and any uncertainty means "leave it alone".
 */
function retireSoldOrders(balances) {
  // A response of the wrong shape or empty is no reason to cancel orders.
  const rows = balances?.responseObject?.balances ?? balances?.balances;
  if (!Array.isArray(rows) || !rows.length) return;

  const stale = ordersToRetire(state.orders, (address) => {
    const entry = normalizeBalance(extractTokenBalance(balances, address));
    // NOT FOUND MEANS UNKNOWN, not zero. A `0n` here once cancelled orders in
    // batches: leaving the token page was enough for the balances to hold
    // something else. A sold position is closed by the runner, which checks
    // the balance on chain.
    return entry ? entry.amount : null;
  });
  if (!stale.length) return;

  Promise.all(stale.map((item) => callBackground('orders.cancel', {
    id: item.id, reason: item.reason,
  })))
    .then(() => callBackground('orders.list'))
    .then((orders) => {
      state.orders = orders ?? [];
      syncChart();
      state.notice = {
        text: stale.length === 1
          ? t('panel.retired.one')
          : t('panel.retired.many', { n: stale.length }),
        tone: '',
      };
      render();
    })
    .catch(() => { /* failed, the orders simply stay */ });
}

/**
 * Market cap fit for computing the target LEVEL.
 *
 * The order target is computed from a FRESH quote, the level from the cap,
 * and when they diverge the caption and the line show the wrong place. A
 * stale cap is not used at all: no level is more honest than a wrong one,
 * and the trigger does not depend on it, it is decided by the output.
 */
const MARKET_CAP_TTL_MS = 60_000;
/**
 * How long the live price counts as live. The watcher beats at least once a
 * minute, so two minutes means "no beat", not "slightly old".
 */
const LIVE_PRICE_TTL_MS = 120_000;

function freshMarketCap() {
  if (!state.marketCapUsd) return null;
  // A foreign cap is worse than none: the level would land confidently in the wrong place.
  const here = state.context?.address ?? tokenFromLocation(location.href);
  if (state.marketCapFor && here && state.marketCapFor !== String(here).toLowerCase()) return null;
  return Date.now() - state.marketCapAt <= MARKET_CAP_TTL_MS ? state.marketCapUsd : null;
}

/**
 * The base for "target as a percentage of the market".
 *
 * THE LIVE CHART PRICE BEATS THE CAP FROM FOMO RESPONSES. The cap arrives with
 * incidental responses and lags; a +3% target computed from a lagging cap can
 * land exactly on the current market. The level is also handed to the
 * watcher, which follows the CHART price; computing it from another quantity
 * wakes the runner in the wrong place.
 *
 * The live price is used only if it agrees with the known cap within a factor
 * of two: the FOMO chart switches between "Price" and "MCap", and in the
 * former the feed carries the token price, nine orders of magnitude away.
 */
function levelBase() {
  const cap = freshMarketCap();
  const live = Number(state.livePrice ?? 0);
  const age = Date.now() - Number(state.livePriceAt ?? 0);
  if (!Number.isFinite(live) || live <= 0 || age > LIVE_PRICE_TTL_MS) return cap;
  // No cap yet, right after a token switch, before its card arrived. The
  // chart price already belongs to the new token, and a level from it is more
  // honest than none.
  if (!cap) return live;
  const ratio = live / cap;
  return ratio > 0.5 && ratio < 2 ? live : cap;
}

/** Symbol change: the previous token's price is no longer good for anything. */
export function resetLivePrice() {
  state.livePrice = null;
  state.livePriceAt = 0;
}

/**
 * The live price arrives with the watcher's heartbeat. The panel only
 * remembers it: the level may be computed from it, execution may not.
 */
export function applyLivePrice(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return;
  state.livePrice = value;
  state.livePriceAt = Date.now();
}

export function applyTokenInfo(json) {
  const address = state.context?.address ?? tokenFromLocation(location.href);
  if (!address) return null;
  const info = findTokenInfo(json, address);
  const hadUnits = freshMarketCap() !== null;
  // Collected piecewise: ticker and cap may come from different responses.
  if (info.priceUsd !== null) state.priceUsd = info.priceUsd;
  if (info.marketCapUsd !== null) {
    state.marketCapUsd = info.marketCapUsd;
    state.marketCapAt = Date.now();
    state.marketCapFor = String(address).toLowerCase();
  }
  if (info.symbol && state.context) state.context.symbol = info.symbol;
  if (info.marketCapUsd !== null || info.symbol) render();
  redrawWhenUnitsArrive(hadUnits);
  return info;
}

/**
 * Lays a balances response out into the panel context.
 *
 * Separate because the same response arrives FOR FREE: their front end fetches
 * balances on navigation and after trades, we read its response and update
 * without a request of our own. Polling their API is only the fallback.
 *
 * TWO LEVELS OF TRUST. A response this world asked for itself (refreshContext,
 * `hint.source === 'poll'`) went to FOMO's API over headers the MAIN world
 * captured, and the MAIN world could still have answered anything; but a
 * PUSHED response (`fomoBalances` from content.js) is whatever the page realm
 * chose to hand over. So only a polled response may cancel orders through
 * retireSoldOrders, and only it may set the wallet addresses an order is
 * built with. A pushed one refreshes the displayed amounts and nothing else:
 * a wrong number on screen is corrected by the next poll, a cancelled order
 * or a foreign sender is not.
 */
export function applyBalances(balances, hint = {}) {
  const trusted = hint.source === 'poll';
  if (!trusted) state.balanceStats.free += 1;
  // THE PAGE ADDRESS BEATS THE REMEMBERED ONE. The balances response covers
  // every token, so the position is taken for the token open NOW.
  const here = tokenFromLocation(location.href);
  const address = hint.address ?? here ?? state.context?.address;
  if (!address) return state.context;
  // A poll answered for a page that has since been left: the app navigated
  // while the request was in flight. Laying it out would put the previous
  // token's position under the new token's name.
  if (hint.address && here && hint.address !== here) return state.context;

  const token = normalizeBalance(extractTokenBalance(balances, address));
  const cash = normalizeBalance(extractTokenBalance(balances, CASH_TOKEN_ADDRESS));
  // Two wallets: EVM for the sell, Solana for the buy. Both come from here.
  const wallets = extractWallets(balances);
  // The balances response carries token facts too, the ticker, sometimes the cap.
  const info = findTokenInfo(balances, address);
  const hadUnits = freshMarketCap() !== null;
  if (info.priceUsd !== null) state.priceUsd = info.priceUsd;
  if (info.marketCapUsd !== null) {
    state.marketCapUsd = info.marketCapUsd;
    state.marketCapAt = Date.now();
    state.marketCapFor = String(address).toLowerCase();
  }
  redrawWhenUnitsArrive(hadUnits);
  // An empty response must not erase a known balance.
  if (!token && !cash && !state.context) return state.context;

  // TOKEN CHANGED, ITS FIELDS ARE NOT INHERITED. Ticker, decimals and tokenId
  // belong to a SPECIFIC token; on a token without a position `token` is
  // empty, and the previous tokenId would sit next to the new address, i.e. a
  // pair the user never chose would go into the quote. Wallets and cash are
  // token-independent and carry over.
  const sameToken = state.context?.address === address;
  const prev = sameToken ? state.context : null;

  state.context = {
    ...state.context,
    address,
    uuid: hint.uuid ?? state.context?.uuid ?? null,
    symbol: token?.symbol || info.symbol || prev?.symbol || '',
    decimals: token?.decimals ?? prev?.decimals ?? 18,
    balance: token?.amount ?? 0n,
    tokenId: token?.tokenId ?? prev?.tokenId ?? tokenIdFromLocation(location.href),
    // The wallets the order is signed for come from a polled response only;
    // see the trust note above the function.
    sender: (trusted ? wallets.evm : null) ?? state.context?.sender ?? null,
    solanaAddress: (trusted ? wallets.solana : null) ?? state.context?.solanaAddress ?? null,
    cashBalance: cash?.amount ?? 0n,
    // What the whole holding is worth, when they say. Only used to put a
    // dollar figure beside the token amount in the order line.
    balanceUsd: token?.usd ?? (sameToken ? prev?.balanceUsd ?? null : null),
    // USDC has six decimals; the response cannot be relied on here.
    cashDecimals: cash?.decimals ?? CASH_DECIMALS,
    error: null,
  };
  state.lastBalanceAt = Date.now();
  contextRetries = 0;
  // Cancelling is irreversible and the pushed path is page-controlled: a
  // page script that hands over a balances document with zero rows would
  // otherwise cancel every order in one call.
  if (trusted) retireSoldOrders(balances);
  render();
  // A Solana token without decimals: the FOMO response carries none for
  // mints, and a default of 18 showed "< 0.001". Ask the chain: the token
  // account holds decimals and balance side by side.
  const isSolanaMint = !/^0x[0-9a-f]{40}$/i.test(String(address));
  if (isSolanaMint && (token?.decimals === null || token?.decimals === undefined) && state.context.solanaAddress) {
    const forAddress = address;
    callBackground('solana.tokenBalance', { owner: state.context.solanaAddress, mint: address })
      .then((res) => {
        if (!res || state.context?.address !== forAddress) return;
        if (Number.isInteger(res.decimals)) state.context.decimals = res.decimals;
        if (res.amount !== undefined) state.context.balance = BigInt(res.amount);
        render();
      })
      .catch(() => { /* the chain did not answer, what FOMO gave stays */ });
  }
  return state.context;
}

/**
 * Retry of the context: the app talks to its API a moment after load, and the
 * first attempt often comes before the session exists.
 */
let contextRetries = 0;
let contextTimer = null;
/**
 * Fallback polling. The main path is reading their front end's responses,
 * which is free. But if the user just sits on the page, the front end does not
 * fetch balances and the data ages. Then we ask ourselves, carefully: only in
 * a VISIBLE tab, only when a free update has not come for a while, with
 * backoff on errors so as not to hit 429.
 */
const POLL_MS = 20_000;
const POLL_MAX_MS = 120_000;
let pollTimer = null;
let pollBackoff = POLL_MS;
/** How often an open tab re-checks the grant; renewal itself happens only when it is due. */
const GRANT_RECHECK_MS = 6 * 60 * 60 * 1000;

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    if (!document.getElementById(PANEL_ID)) return;
    // A free update came recently, no request of our own.
    if (state.lastBalanceAt && Date.now() - state.lastBalanceAt < pollBackoff) return;
    try {
      await refreshContext();
      pollBackoff = POLL_MS;
    } catch {
      state.balanceStats.failed += 1;
      pollBackoff = Math.min(pollBackoff * 2, POLL_MAX_MS);
    }
  }, 5_000);
}

function scheduleContextRetry() {
  if (contextRetries >= 10) return;
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    contextRetries += 1;
    refreshContext().then((ctx) => {
      if (ctx?.balance !== undefined) contextRetries = 0;
    }).catch(() => {});
  }, 1500);
}

/** Balance of the side being traded. Zero while nothing is known. */
function currentBalance() {
  const ctx = state.context;
  const selling = state.form.side === SIDES.SELL;
  return {
    amount: (selling ? ctx?.balance : ctx?.cashBalance) ?? 0n,
    decimals: (selling ? ctx?.decimals : ctx?.cashDecimals) ?? 18,
    symbol: selling ? (ctx?.symbol || '') : 'USDC',
  };
}

/** Trash icon as a vector: an emoji is coloured and stands out. */
function trashIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [
    'M2.5 4h11',
    'M6 4V2.6h4V4',
    'M3.8 4l.6 8.6a1 1 0 0 0 1 .9h5.2a1 1 0 0 0 1-.9L12.2 4',
    'M6.6 6.8v4M9.4 6.8v4',
  ]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Disclosure chevron, rotated rather than swapped for another glyph. */
function chevronIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'lc-chevron');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M3.5 6L8 10.5 12.5 6');
  svg.append(path);
  return svg;
}

/**
 * The order list, across ALL tokens, not only the open one. Collapsed by
 * default: it grows, and the panel has limited room.
 */
function ordersBlock() {
  const box = h('div', { class: 'lc-orders' });
  box.append(h('button', {
    class: `lc-orders-head ${state.ordersOpen ? 'open' : ''}`,
    onclick: real(() => { state.ordersOpen = !state.ordersOpen; render(); }),
  }, [
    h('span', {}, t('panel.orders', { n: state.orders.length })),
    chevronIcon(),
  ]));
  if (!state.ordersOpen) return box;

  for (const order of state.orders) {
    // An order may have been saved without a ticker. If its token is the one
    // open now, the ticker is known, use it instead of a bare address.
    const symbol = order.symbol
      ? order.symbol
      : (orderTokenAddress(order) === state.context?.address && state.context?.symbol)
        ? state.context.symbol
        : orderSymbol(order);
    box.append(h('div', { class: 'lc-order' }, [
      orderLabel({ ...order, symbol }),
      h('button', {
        onclick: real(() => cancel(order.id)),
        title: t('panel.cancel'),
        'aria-label': t('panel.cancel'),
      }, [trashIcon()]),
    ]));
  }
  return box;
}

/**
 * Order caption with markup: the side in colour (sell red, buy green), the
 * ticker as a link to the token page. The text is the one describeOrder
 * gives, split at the side word and the ticker, so translation and markup
 * cannot drift apart.
 */
function orderLabel(order) {
  const text = describeOrder(order);
  const verb = order.side === SIDES.BUY ? t('order.buy') : t('order.sell');
  const ticker = tickerLabel(order.symbol);
  const url = tokenPageUrl(order.side === SIDES.BUY ? order.outTokenId : order.inTokenId);
  const nodes = [];
  let rest = text;
  if (verb && rest.startsWith(verb)) {
    nodes.push(h('span', { class: `lc-side ${order.side === SIDES.BUY ? 'buy' : 'sell'}` }, verb));
    rest = rest.slice(verb.length);
  }
  const at = ticker ? rest.indexOf(ticker) : -1;
  if (at >= 0) {
    nodes.push(rest.slice(0, at));
    nodes.push(url
      ? h('a', { class: 'lc-ticker', href: url, title: url }, ticker)
      : h('span', { class: 'lc-ticker' }, ticker));
    rest = rest.slice(at + ticker.length);
  }
  nodes.push(rest);
  return h('span', { class: 'lc-order-text' }, nodes);
}

/** Balance row: the number on the left, the refresh icon on the right. */
function balanceRow(selling) {
  const b = currentBalance();
  // The warning mark may be absent: when everything works there is nothing to warn about.
  const mark = warningMark(selling);
  return h('div', { class: 'lc-balance' }, [
    h('span', { class: 'lc-muted' },
      t('panel.balance', { amount: formatCompact(b.amount, b.decimals), symbol: b.symbol ?? '' }).trim()),
    h('div', { class: 'lc-balance-tools' }, [
      ...(mark ? [mark] : []),
      h('button', {
        class: 'lc-icon',
        title: t('panel.balance.refresh'),
        'aria-label': t('panel.balance.refresh'),
        onclick: real(() => refreshContext()),
      }, [refreshIcon()]),
    ]),
  ]);
}

const OFFLINE_TITLE = () => t('panel.offline.title');
const OFFLINE_TEXT = () => t('panel.offline.text');

/**
 * Text for a canSign refusal, by its code. A generic "make a sell" was once
 * shown when the envelope was long captured and the page simply lacked the
 * Privy frame after navigating around the site; the person made a spare sell
 * where a reload would have done.
 */
function offlineText(canSign) {
  if (canSign?.code === 'no-privy') return t('panel.offline.noPrivy');
  if (canSign?.code === 'other-wallet') return t('panel.offline.otherWallet');
  return OFFLINE_TEXT();
}

/**
 * The warning mark. The text sits behind a hover: it matters, but taking a
 * third of the panel permanently is not worth it. The mark disappears when
 * everything works: a permanent warning that means nothing stops being read.
 */
function warningMark(selling) {
  const lines = [];
  if (state.canSign && state.canSign.ok === false) {
    lines.push(`${OFFLINE_TITLE()}\n\n${offlineText(state.canSign)}`);
  }
  if (!lines.length) return null;
  // The tip is shown and placed by attachTooltip, like the "?" tips: the
  // class alone never showed it, and the mark stood there unexplained. The
  // row is focusable so the text is reachable from the keyboard as well.
  const tip = h('span', { class: 'lc-tip' }, lines.join('\n\n'));
  const row = h('div', { class: 'lc-warn-row', tabindex: '0' }, [
    h('span', { class: 'lc-warn-mark' }, '⚠'),
    tip,
  ]);
  attachTooltip(row, tip);
  return row;
}

function refreshIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [
    'M13.5 7a5.5 5.5 0 1 0-1.3 4.3',
    'M13.6 3.4v3.3h-3.3',
  ]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * The dollar value of a sell if its target is reached, or null.
 *
 * A person reads "$4.62" faster than "2.15 $PONS at $770.6M MC", and the
 * second sentence does not answer what they came to ask. This is the share of
 * the holding being sold, moved by the target percent, the same arithmetic
 * the target is expressed in, so it agrees with the level on the chart.
 *
 * Null unless the balance came with a value: an invented figure about money
 * would be worse than none.
 */
function sellValueAtTarget() {
  if (state.form.side !== SIDES.SELL) return null;
  const move = Number(state.form.targetPercent);
  if (!Number.isFinite(move)) return null;
  // Preferred: what a real quote said this amount fetches right now, moved by
  // the target percent. Second best: the value the balances response gave for
  // the whole holding, if it gave one. Neither, no figure, and the line says
  // nothing about dollars rather than guessing about money.
  const quoted = quotedNowUsd();
  if (quoted !== null) return quoted * (1 + move / 100);
  const whole = Number(state.context?.balanceUsd);
  const share = Number(state.form.amountPercent);
  if (!Number.isFinite(whole) || whole <= 0 || !Number.isFinite(share) || share <= 0) return null;
  const value = (whole * share / 100) * (1 + move / 100);
  return value > 0 ? value : null;
}

/**
 * The last quote for exactly this token and this amount, if it is fresh.
 *
 * Their API sits behind Cloudflare and answers 429 to frequent asking, so
 * this is asked once when the amount stops changing and remembered by the
 * pair it was asked for. A quote for a different amount tells us nothing
 * about this one and is ignored rather than scaled.
 */
const VALUE_QUOTE_TTL_MS = 90_000;

/**
 * What one token is worth, from a quote for the WHOLE holding.
 *
 * Quoting the amount on the slider does not work: FOMO refuses to quote a
 * trade under two dollars, and a quarter of a small position is under two
 * dollars, the request goes out, comes back refused, and the line stays
 * blank while everything looks fine. So the question asked is the one they
 * will answer, once per token, and the price per token is divided out of it.
 *
 * Slightly optimistic for a smaller share, since a bigger trade takes more
 * impact; the figure is prefixed with "≈" and is not used for anything but
 * reading.
 */
function unitPriceUsd() {
  const ctx = state.context;
  const q = state.valueQuote;
  if (!ctx || !q) return null;
  if (q.tokenId !== ctx.tokenId || q.balance !== String(ctx.balance)) return null;
  if (Date.now() - q.at > VALUE_QUOTE_TTL_MS) return null;
  return Number.isFinite(q.unit) && q.unit > 0 ? q.unit : null;
}

function quotedNowUsd() {
  const calc = computed();
  const unit = unitPriceUsd();
  if (!calc || unit === null) return null;
  const tokens = Number(calc.amount) / 10 ** Number(calc.decimals ?? 18);
  return Number.isFinite(tokens) && tokens > 0 ? tokens * unit : null;
}

/**
 * Asks once per token, when the panel settles. Silent about failure: this is
 * a convenience on a line that reads fine without it.
 */
let valueQuoteTimer = null;
function scheduleValueQuote() {
  clearTimeout(valueQuoteTimer);
  valueQuoteTimer = setTimeout(async () => {
    const ctx = state.context;
    const calc = computed();
    if (!ctx || !calc || state.form.side !== SIDES.SELL) return;
    if (unitPriceUsd() !== null) return;
    const balance = ctx.balance;
    if (!balance || balance <= 0n) return;
    try {
      const raw = await callMain('fomo.quote', {
        inTokenId: calc.inTokenId,
        outTokenId: calc.outTokenId,
        amount: String(balance),
      });
      const out = Number(parseSwapQuote(raw)?.expectedOut);
      const tokens = Number(balance) / 10 ** Number(ctx.decimals ?? 18);
      if (!Number.isFinite(out) || out <= 0 || !Number.isFinite(tokens) || tokens <= 0) return;
      state.valueQuote = { tokenId: ctx.tokenId, balance: String(balance), unit: out / tokens, at: Date.now() };
      render();
    } catch { /* no figure this time; the line stands without one */ }
  }, 1200);
}

function summaryText() {
  const calc = computed();
  // Nothing to compute, stay silent: the balance row below already says it all.
  if (!calc) return '';
  // Every path that draws this line asks for the figure it needs. The ask is
  // debounced and returns at once when the answer is already in hand, so a
  // dragged slider costs one request when it stops, not one per position.
  scheduleValueQuote();
  const selling = state.form.side === SIDES.SELL;
  return describeOrder({
    side: state.form.side,
    amount: calc.amount,
    decimals: calc.decimals,
    // On a buy the caption names the token's ticker, not the cash.
    symbol: selling ? calc.symbol : (state.context?.symbol || ''),
    percent: state.form.targetPercent,
    targetMarketCapUsd: targetMarketCap(levelBase(), state.form.targetPercent),
    // What it comes to in dollars if the target is reached. The share of the
    // holding being sold, moved by the target percent, the same arithmetic
    // the target itself is written in. Null when the balance carries no
    // value; then the line simply says nothing about dollars.
    valueUsd: sellValueAtTarget(),
  });
}

function render() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const { form } = state;
  const calc = computed();
  const selling = form.side === SIDES.SELL;

  panel.dataset.side = selling ? 'sell' : 'buy';
  panel.dir = localeDir();
  panel.dataset.collapsed = state.collapsed ? '1' : '0';
  panel.dataset.float = state.docked ? '0' : '1';
  panel.textContent = '';

  // Header: title and collapse. The panel sits in the column under the trade
  // card and is not draggable: one place, like any of their blocks.
  const head = h('div', { class: 'lc-head' }, [
    h('span', { class: 'lc-title' }, t('panel.title')),
    h('button', {
      class: `lc-icon lc-collapse ${state.collapsed ? '' : 'open'}`,
      title: state.collapsed ? t('panel.expand') : t('panel.collapse'),
      onclick: real((ev) => { ev.stopPropagation(); toggleCollapsed(); }),
    }, [chevronIcon()]),
  ]);
  panel.append(head);

  const body = h('div', { class: 'lc-body' });
  panel.append(body);
  if (state.collapsed) return;

  body.append(h('div', { class: 'lc-seg', style: 'margin-bottom:10px' }, [
    h('button', {
      class: `sell ${selling ? 'on' : ''}`,
      onclick: real(() => { form.side = SIDES.SELL; render(); probeRoute(); }),
    }, t('panel.sell')),
    h('button', {
      class: `buy ${selling ? '' : 'on'}`,
      onclick: real(() => { form.side = SIDES.BUY; render(); probeRoute(); }),
    }, t('panel.buy')),
  ]));

  body.append(h('div', { class: 'lc-row' }, [
    h('label', {}, t('panel.amount')),
    helpButton(t('panel.amount.help')),
    h('input', {
      type: 'number', min: '1', max: '100', step: '1', value: String(form.amountPercent),
      class: 'lc-amount',
      oninput: real((ev) => { form.amountPercent = Number(ev.target.value); updateSummary(); }),
    }),
    h('span', { class: 'lc-unit' }, t('panel.amount.unit')),
  ]));
  body.append(h('div', { class: 'lc-quick' }, [10, 25, 50, 100].map((p) => h('button', {
    onclick: real(() => { form.amountPercent = p; render(); }),
  }, `${p}%`))));

  body.append(h('div', { class: 'lc-row' }, [
    h('label', {}, t('panel.target')),
    helpButton(t('panel.target.help')),
    h('input', {
      type: 'number', step: '1', value: String(form.targetPercent),
      id: 'lc-target-number',
      oninput: real((ev) => {
        form.targetPercent = Number(ev.target.value);
        syncTarget('number');
      }),
    }),
    h('span', { class: 'lc-unit' }, t('panel.target.unit')),
  ]));
  body.append(h('input', {
    type: 'range', min: '-100', max: '100', step: '1', value: String(form.targetPercent),
    id: 'lc-target-range',
    style: `--fill:${fillOf(form.targetPercent)}`,
    // No render() here: a full re-render recreates this element mid-drag, the
    // browser loses pointer capture and the slider reacts to clicks only.
    oninput: real((ev) => {
      form.targetPercent = Number(ev.target.value);
      ev.target.style.setProperty('--fill', fillOf(form.targetPercent));
      syncTarget('range');
    }),
  }));
  body.append(h('div', { class: 'lc-scale' }, ['-100%', '0%', '+100%'].map((label) => h('span', {}, label))));

  body.append(renderSlippage());

  // Nothing can sign: neither the button nor place() may take an order.
  const offline = Boolean(state.canSign && state.canSign.ok === false);

  const summary = summaryText();
  if (summary) body.append(h('div', { class: 'lc-summary', id: 'lc-summary' }, summary));
  body.append(balanceRow(selling));

  // The action button does not accept a click only to refuse: when the action
  // is impossible the button says so. The check in place() stays for calls
  // that bypass the interface.
  body.append(h('button', {
    class: 'lc-go',
    ...(calc && !offline ? {} : { disabled: 'disabled' }),
    // A real press is necessary and not sufficient. A synthetic click is
    // dropped by real(); but a page script may instead prepare the fields
    // (amount 100, target 0, slippage 100) and wait for the person's own
    // click, so place() also reads the fields back and refuses when they
    // differ from the form, which only trusted events write.
    onclick: real(() => place()),
  }, selling ? t('panel.place.sell') : t('panel.place.buy')));

  // AUTO-EXECUTION OFF, SAID BEFORE, NOT AFTER. The extension cannot request
  // a signature until it has seen HOW their app requests one: the envelope is
  // versioned, cannot be guessed, and an ordinary page load does not produce
  // it. One real signature is needed, and only a SELL qualifies: a buy is
  // signed on the Solana side. The order is not accepted meanwhile: an order
  // that cannot execute looks like one that will, and the person finds out
  // at the price they wanted. The button above is disabled for the same
  // reason, and place() refuses a call that comes another way.
  if (offline) {
    body.append(h('div', { class: 'lc-warn-block' }, [
      h('b', {}, `⚠️ ${OFFLINE_TITLE()}`),
      h('span', {}, offlineText(state.canSign)),
    ]));
  }

  if (state.notice) {
    body.append(h('div', { class: `lc-muted ${state.notice.tone ?? ''}` }, state.notice.text));
  }

  if (state.orders.length) body.append(ordersBlock());
}

/** Fill share of the track: a −100..100 scale with zero in the middle. */
function fillOf(percent) {
  const p = Math.max(-100, Math.min(100, Number(percent) || 0));
  return `${(p + 100) / 2}%`;
}

/**
 * Keeps the slider and the number field in step without re-rendering the
 * panel. The source is passed so the field the user is typing in is not
 * rewritten, or the caret jumps.
 */
function syncTarget(source) {
  const range = document.getElementById('lc-target-range');
  const number = document.getElementById('lc-target-number');
  const value = String(state.form.targetPercent);
  if (range && source !== 'range') {
    range.value = value;
    range.style.setProperty('--fill', fillOf(state.form.targetPercent));
  }
  if (number && source !== 'number') number.value = value;
  updateSummary();
}

function updateSummary() {
  const node = document.getElementById('lc-summary');
  if (node) node.textContent = summaryText();
}

/**
 * Slippage: one setting for both bounds.
 *
 * For the user "how much worse am I willing to take" is one number, so both
 * the quote-against-target tolerance and the pool impact cap come from it.
 * 10% by default as the "Auto" chip, with a field for a custom percent next
 * to it, like in FOMO.
 */
function renderSlippage() {
  const box = h('div', { class: 'lc-slip' });
  const own = state.form.slippageBps;
  const isAuto = own === DEFAULT_MAX_SLIPPAGE_BPS;

  const input = h('input', {
    type: 'number', min: '0.1', max: '100', step: '0.5',
    class: 'lc-slip-input',
    value: isAuto ? '' : String(bpsToPercent(own)),
    placeholder: String(bpsToPercent(DEFAULT_MAX_SLIPPAGE_BPS)),
    oninput: real((ev) => {
      if (ev.target.value === '') { state.form.slippageBps = DEFAULT_MAX_SLIPPAGE_BPS; }
      else {
        try {
          const bps = percentToBps(ev.target.value);
          if (bps === 0) return;
          state.form.slippageBps = bps;
          state.notice = null;
        } catch (err) {
          state.notice = { text: String(err.message), tone: 'bad' };
          return;
        }
      }
      savePanelState();
      auto.classList.toggle('on', state.form.slippageBps === DEFAULT_MAX_SLIPPAGE_BPS);
    }),
  });
  const auto = h('button', {
    class: `lc-slip-auto ${isAuto ? 'on' : ''}`,
    onclick: real(() => {
      state.form.slippageBps = DEFAULT_MAX_SLIPPAGE_BPS;
      input.value = '';
      savePanelState();
      render();
    }),
  }, t('panel.slippage.auto', { value: formatSlippage(DEFAULT_MAX_SLIPPAGE_BPS) }));

  box.append(h('div', { class: 'lc-slip-head' }, [
    h('span', { class: 'lc-unit' }, t('panel.slippage')),
    helpButton(t('panel.slippage.help')),
    auto,
    h('span', { class: 'lc-slip-custom' }, [input, h('span', { class: 'lc-unit' }, '%')]),
  ]));
  return box;
}

// ----------------------------------------------------- collapse and settings

/**
 * Docked: no inline style, the column lays it out. Floating is only the
 * fallback for a page without the trade card: bottom-right, fixed, no drag.
 */
function applyPosition(panel) {
  panel.style.cssText = '';
}

function toggleCollapsed() {
  state.collapsed = !state.collapsed;
  render();
  savePanelState();
}

function savePanelState() {
  callBackground('settings.set', {
    settings: {
      panelCollapsed: state.collapsed,
      slippageBps: state.form.slippageBps,
    },
  }).catch(() => { /* panel state is not critical */ });
}

export function restoreState(settings = {}) {
  const { panelCollapsed, slippageBps, lastRelaySlippageBps } = settings;
  if (panelCollapsed !== undefined) state.collapsed = Boolean(panelCollapsed);
  if (Number.isFinite(Number(slippageBps)) && Number(slippageBps) > 0) state.form.slippageBps = Number(slippageBps);
  if (lastRelaySlippageBps !== undefined) state.relaySlippageBps = lastRelaySlippageBps;
}

// ------------------------------------------------------------------- actions

async function place() {
  // Nothing can sign: the order would be watched and never executed. The
  // button is disabled for this, and this guards the calls that bypass it.
  if (state.canSign && state.canSign.ok === false) {
    state.notice = { text: offlineText(state.canSign), tone: 'bad' };
    render();
    return;
  }
  // Before anything else: what is on screen must be what the form holds. See
  // fieldDrift() for why the two can differ and why that refuses.
  const drift = fieldDrift();
  if (drift) {
    state.notice = { text: t('panel.err.fieldDrift', { field: drift }), tone: 'bad' };
    render();
    return;
  }
  const calc = computed();
  if (!calc) return;
  const button = document.querySelector(`#${PANEL_ID} .lc-go`);
  if (button) { button.disabled = true; button.textContent = t('panel.quoting'); }
  try {
    // The live price is asked for HERE rather than taken from the heartbeat:
    // the beat comes every half minute and may not have come at all on a fresh
    // tab. The level is set once and for good, so its base is taken this instant.
    try {
      const live = await callMain('chart.live');
      applyLivePrice(live?.price);
    } catch { /* no chart, the cap from FOMO responses stays */ }
    if (!calc.inTokenId || !calc.outTokenId) {
      throw new Error(t('panel.err.pair'));
    }
    // One quote per placement. Not a poll: their API is behind Cloudflare.
    const quoteAmount = calc.amount;
    const raw = await callMain('fomo.quote', {
      inTokenId: calc.inTokenId,
      outTokenId: calc.outTokenId,
      amount: quoteAmount.toString(),
    });
    const quote = parseSwapQuote(raw);

    // An order that cannot be executed is not saved.
    if (!quote.canExecute) {
      throw new Error(t('panel.err.route', { route: describeRoute(quote.route) }));
    }
    if (!quote.expectedOut) throw new Error(t('panel.err.noOut'));
    // Now the tolerance relay really set is visible.
    if (quote.slippageBps !== null && quote.slippageBps !== undefined) {
      state.relaySlippageBps = Number(quote.slippageBps);
      await callBackground('settings.set', {
        settings: { lastRelaySlippageBps: state.relaySlippageBps },
      }).catch(() => {});
    }

    // The quote comes as a human-readable decimal string. Through Number it
    // loses digits, and the order target is computed from it, so it is
    // converted exactly, as an integer in QUOTE_SCALE, the scale in which
    // future quotes are compared at trigger time.
    const marketOut = toMinimalUnits(quote.expectedOut, QUOTE_SCALE);
    const order = createOrder({
      side: state.form.side,
      inTokenId: calc.inTokenId,
      outTokenId: calc.outTokenId,
      amount: calc.amount,
      targetOut: targetOutFromPercent(marketOut, state.form.targetPercent, state.form.side),
      percent: state.form.targetPercent,
      amountPercent: state.form.amountPercent,
      maxSlippageBps: state.form.slippageBps,
      maxImpactBps: state.form.slippageBps,
      // Ticker and decimals of the TOKEN: on a buy calc is about USDC.
      symbol: state.form.side === SIDES.SELL ? calc.symbol : (state.context?.symbol || ''),
      decimals: state.form.side === SIDES.SELL ? calc.decimals : (state.context?.decimals ?? 18),
      marketCapUsd: freshMarketCap(),
      targetMarketCapUsd: targetMarketCap(levelBase(), state.form.targetPercent),
      // The address tells orders apart when the ticker did not arrive: the
      // list spans every token.
      tokenAddress: state.context?.address ?? null,
      sender: state.context?.sender ?? null,
      solanaAddress: state.context?.solanaAddress ?? null,
    });
    // A DUPLICATE IS A DOUBLE SELL, and it appears innocently: placement
    // returned an error, the person pressed again, the first order was
    // already saved.
    const duplicate = findDuplicateOrder(state.orders, order);
    if (duplicate) {
      throw new Error(t('panel.err.duplicate'));
    }
    await callBackground('orders.add', { order });
    state.orders = await callBackground('orders.list');
    syncChart();
    // The grant is requested HERE. Placing a limit order is the consent to its
    // execution, there is no other moment in the product where the person
    // says "execute for me". A refusal does not cancel the order: it is saved
    // and watched, and the runner names the missing grant at its first attempt.
    const outSymbol = state.form.side === SIDES.SELL ? 'USDC' : (state.context?.symbol || '');
    const target = formatCompact(order.targetOut, QUOTE_SCALE);
    state.notice = {
      text: t('panel.saved', { out: formatCompact(quote.expectedOut), symbol: outSymbol, target }),
      tone: 'ok',
    };
    // The grant AFTER the order notice, awaited: without the await its message
    // was overwritten by the line above and the grant went unreported.
    await ensureGrant();
  } catch (err) {
    state.notice = { text: String(err?.message || err), tone: 'bad' };
  }
  render();
}

/**
 * Hands the orders to the TradingView chart to be drawn as lines. Called
 * ONLY when the order list changed, not on every render: lines are recreated
 * and flicker otherwise. A drawing failure must not touch the panel.
 */
/**
 * The last trouble reported by the chart, so one problem is written down once.
 *
 * The panel syncs on every order change, every symbol change and every time
 * the list is re-read; a note per sync would bury the journal. A note per new
 * problem is what a person needs.
 */
let lastChartTrouble = '';

/** Writes down why the chart has no level on it, when that is worth writing. */
function noteChartTrouble(report) {
  const trouble = chartTrouble(report);
  const key = trouble.join(' | ');
  if (!key || key === lastChartTrouble) {
    if (!key) lastChartTrouble = '';
    return;
  }
  lastChartTrouble = key;
  callBackground('runner.note', { text: `chart: ${key}` }).catch(() => { /* the journal is best effort */ });
}

/**
 * The units to convert a level with: the cap and the price it was read
 * beside, or nothing.
 *
 * THE PAIR BELONGS TO ONE TOKEN. Their ratio is the supply, and a supply is
 * a property of a token, not of a page. After a move from one token to
 * another the remembered cap is the PREVIOUS token's until the new balances
 * arrive, and dividing this token's level by that token's supply lands the
 * line confidently in the wrong place, or so far off the axis that it is
 * dropped and the chart looks empty. `freshMarketCap` already refuses a
 * foreign or stale cap; the price is only meaningful next to the cap it came
 * with, so it goes when the cap goes.
 */
function chartUnits() {
  const marketCapUsd = freshMarketCap();
  return { marketCapUsd, tokenPriceUsd: marketCapUsd === null ? null : (state.priceUsd ?? null) };
}

/**
 * Redraws the chart the moment the units become usable.
 *
 * The cap and the price arrive over the network, a moment after the page was
 * opened or the token changed, and until they do a level stored as a cap
 * cannot be placed on an axis drawn in prices: it is dropped as out of scale
 * and the chart shows nothing. Nothing used to ask for a redraw afterwards,
 * so on a blue chip the level stayed missing until the order list happened to
 * change, which to a person looks like the take-profit vanishing on reload.
 *
 * Only on the transition from "no units" to "units", not on every response:
 * balances are pushed often, and recreating the lines each time makes them
 * flicker.
 *
 * @param {boolean} hadUnits whether the units were usable BEFORE the response
 */
function redrawWhenUnitsArrive(hadUnits) {
  if (hadUnits || freshMarketCap() === null) return;
  syncChart();
}

function syncChart() {
  callMain('chart.sync', {
    orders: state.orders ?? [],
    // THE PAGE ADDRESS FIRST: the context arrives over the network and is
    // still empty at the first sync, while the token in the URL is known
    // synchronously.
    tokenAddress: tokenFromLocation(location.href) ?? state.context?.address ?? null,
    // The token's market cap and price right now. Together they give the
    // supply, which is what turns a level stored as a cap into the units this
    // chart happens to be drawn in.
    ...chartUnits(),
  }).then(noteChartTrouble).catch(() => { /* no chart or not ready yet */ });
}

/**
 * Re-reads the orders and draws them on the current chart. Called on symbol
 * change. The address comes from the PAGE URL, not from `state.context`,
 * which still holds the previous token at the moment of navigation.
 */
export async function refreshChartLines() {
  try {
    state.orders = (await callBackground('orders.list')) ?? [];
  } catch {
    // The list could not be read, draw what we have.
  }
  const address = tokenFromLocation(location.href) ?? state.context?.address ?? null;
  callMain('chart.sync', {
    orders: state.orders ?? [], tokenAddress: address, ...chartUnits(),
  })
    .then(noteChartTrouble)
    .catch(() => { /* there may be no chart on this page */ });
}

/**
 * Requests a grant for the key when the live orders lack one.
 *
 * What to request is decided by the service worker: it holds the orders and
 * reads the chain. The page carries the request: Privy and the bundler are
 * reachable only from it. The panel in between decides nothing.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] quiet completion at page open: silent when
 *   the grant suffices, speaks only when it does something or fails. At
 *   placement it may not be silent, the person is waiting for the answer.
 */
async function ensureGrant({ quiet = false } = {}) {
  // One grant per chain, and a wallet can trade on several.
  //
  // The chain id is inside the authorization the owner signs and the grant
  // lives in the account's storage on that chain, so a wallet with orders on
  // two chains needs two of each; planning the newest order's chain alone
  // would leave a second chain un-granted and silent until an order happened
  // to be placed there.
  let chains = null;
  try { chains = await callBackground('runner.grantChains'); } catch { chains = null; }
  // An empty list is an ANSWER: every live order is on Solana, or there are
  // none, and neither needs a grant. Only a worker that could not answer at
  // all falls back to the newest order's chain.
  if (Array.isArray(chains) && !chains.length) return null;
  if (!Array.isArray(chains)) return ensureGrantOn(null, { quiet });
  let last = null;
  for (const chainId of chains) {
    // Each chain gets its own pass; a refusal on one is reported and the rest
    // are still attempted, because they are independent grants.
    last = await ensureGrantOn(chainId, { quiet });
  }
  return last;
}

async function ensureGrantOn(chainId, { quiet = false } = {}) {
  const base = quiet ? t('panel.grant.base') : (state.notice?.text ?? '');
  let plan;
  try {
    plan = await callBackground('runner.grantPlan', chainId === null ? {} : { chainId });
  } catch (err) {
    // Silence is not an option: without a grant the order will not execute.
    state.notice = { text: t('panel.grant.checkFailed', { base, error: String(err?.message || err) }), tone: 'bad' };
    render();
    return null;
  }
  // "Not needed" and "cannot" are different things, and the second must be said.
  if (plan?.blocked) {
    state.notice = { text: t('panel.grant.blocked', { base, reason: plan.reason }), tone: 'bad' };
    callBackground('runner.note', { text: `grant blocked: ${plan.reason}` }).catch(() => {});
    render();
    return plan;
  }
  if (!plan?.needed) return plan;

  const needsDelegation = Boolean(plan.delegation);
  const mainNeeded = plan.mainNeeded !== false;
  state.notice = {
    text: needsDelegation ? t('panel.grant.connecting', { base }) : t('panel.grant.enabling', { base }),
    tone: 'ok',
  };
  render();
  try {
    // THE DELEGATION IS SIGNED HERE, because only the owner can sign it
    // through Privy, and Privy lives on the page. It travels INSIDE the same
    // operation as the grant: the EntryPoint applies it before validation, so
    // by `grantSession` the account already runs our contract. One sponsored
    // operation instead of a gas courier.
    let authorization = null;
    if (needsDelegation) {
      const signed = await callMain('gate.signAuthorization', {
        sender: plan.params.sender,
        chainId: plan.params.chainId,
        delegate: plan.delegation.delegate,
        // allowLive is required: this is a LIVE authorization changing the
        // account code. Consent is the Limit orders switch in the popup (the
        // worker plans no delegation with it off), and the person is told
        // again in the line below. The intent binds this signature to the
        // worker's plan.
        allowLive: true,
        intent: plan.intents?.delegation ?? null,
      });
      authorization = signed?.authorizationRpc ?? null;
      if (!authorization) throw new Error(t('panel.grant.noSignature'));
    }
    // One operation per key: the extension's own key first (with the
    // delegation, if any), then the daemon's. Each is an owner signature
    // through Privy; a refusal names the key that did not get its grant.
    const rounds = [];
    if (mainNeeded || needsDelegation) rounds.push({ params: plan.params, authorization, label: 'extension', intent: plan.intents?.grant ?? null });
    for (const extraParams of plan.extra ?? []) rounds.push({ params: extraParams, authorization: null, label: 'daemon', intent: extraParams.intent ?? null });
    for (const round of rounds) {
      // The grant waits for a receipt for up to two minutes, as long as the
      // bus default, and a wallet migrating from the previous contract sends a
      // revoke operation first; the timeout is raised so "not enabled" does
      // not arrive before the operations land.
      const report = await callMain('session.grant', { ...round.params, send: true, authorization: round.authorization, intent: round.intent }, 360_000);
      if (!report?.sent) throw new Error(`${round.label}: ${report?.note ?? t('panel.grant.rejected')}`);
    }
    state.notice = {
      // The change of the wallet code is stated PLAINLY: it is the one action
      // here whose effect no grant bounds.
      text: needsDelegation
        ? t('panel.grant.onDelegated', { base })
        : t('panel.grant.on', { base }),
      tone: 'ok',
    };
  } catch (err) {
    const reason = String(err?.message || err);
    state.notice = { text: t('panel.grant.failed', { base, reason }), tone: 'bad' };
    // Into the journal as well, not only onto this line. A delegation that
    // fails here is the difference between an order that executes and one
    // that sits watching forever, and the line is gone with the next render
    //, so the reason survived nowhere and could not be looked up afterwards.
    callBackground('runner.note', {
      text: `${needsDelegation ? 'delegation' : 'grant'} failed: ${reason}`,
    }).catch(() => { /* the journal is a courtesy, not a condition */ });
  }
  render();
  return plan;
}

async function cancel(id) {
  await callBackground('orders.cancel', { id });
  state.orders = await callBackground('orders.list');
  syncChart();
  render();
}

/**
 * Orders change not only from the panel: the runner closes a filled order IN
 * STORAGE. Storage is the one source shared by both worlds and it reports its
 * changes itself; a subscription is cheaper than polling and more exact than
 * any timer. It also removes the closed order's line and level: the level list
 * is rebuilt from what is still live.
 */
let ordersReloading = false;
async function reloadOrdersFromStorage() {
  // Our own write raises the same event; a second pass over a running one adds nothing.
  if (ordersReloading) return;
  ordersReloading = true;
  try {
    const fresh = await callBackground('orders.list');
    state.orders = Array.isArray(fresh) ? fresh : [];
    syncChart();
    render();
  } catch {
    // The worker may be asleep. The next storage change calls us again.
  } finally {
    ordersReloading = false;
  }
}

// Extension storage is closed to content scripts (the worker marks it for
// trusted contexts only); the worker sends `orders.changed` instead, and
// content.js routes it here.
export { reloadOrdersFromStorage };

// ------------------------------------------------------------------ mounting

/** How long to wait for the trade card before falling back to floating. */
const FLOAT_GRACE_MS = 8000;

export function mount(options = {}) {
  if (!document.body) {
    state.lastMountReason = t('panel.mount.noDom');
    return { mounted: false, reason: state.lastMountReason };
  }
  ensureStyle();

  // Only token pages have a trade card and a reason for the panel. On a
  // profile or the feed (the app navigates without reloading) the panel is
  // taken down, not floated; it comes back with the next token page.
  if (!isTokenPage()) {
    document.getElementById(PANEL_ID)?.remove();
    state.docked = false;
    state.lastMountReason = t('panel.mount.noAnchor');
    return { mounted: false, reason: state.lastMountReason };
  }

  const anchor = findAnchor();
  document.getElementById(PANEL_ID)?.remove();
  const panel = h('div', { id: PANEL_ID });
  if (anchor) anchor.after(panel);
  else {
    // No card yet, usually because the page is still rendering. Showing the
    // floating fallback now would flash it at the bottom for a second and
    // then jump; stay invisible until the card comes, and float only when it
    // has not come within the grace period.
    document.body.append(panel);
    panel.hidden = Date.now() - (state.startedAt ?? 0) < FLOAT_GRACE_MS;
  }
  state.docked = Boolean(anchor);

  render();
  applyPosition(panel);
  state.lastMountReason = anchor ? null : t('panel.mount.noAnchor');
  return { mounted: true, docked: state.docked, reason: state.lastMountReason };
}

export function start(options = {}) {
  state.startedAt = Date.now();
  const result = mount(options);

  state.observer?.disconnect();
  let timer = null;
  let lastUrl = location.href;
  state.observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const existing = document.getElementById(PANEL_ID);
      // The trade card is not there at document_start, so the first mount
      // floats; it also re-renders on token change and takes the panel with
      // it, or leaves the panel next to a stale card. Whenever the card and
      // the panel disagree about where the panel is, re-seat it. Off a token
      // page the panel is removed and nothing is mounted.
      if (!isTokenPage()) {
        existing?.remove();
        state.docked = false;
      } else {
        const card = findTradeCard();
        const misplaced = card ? existing?.previousElementSibling !== card : state.docked;
        if (!existing || misplaced) mount(options);
      }
      // Navigation between tokens inside the app: same orders, another chart.
      // Re-read the list and redraw, and refresh the context, otherwise the
      // panel keeps showing the previous token's position and "Place sell"
      // would build an order on the wrong token.
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // The context is dropped NOW, not when the new balances arrive. In
        // between, the panel kept the previous token's position and a click
        // in that second built an order on it; with no context computed()
        // is null, the button is disabled and nothing can be placed until
        // refreshContext lays the new token out.
        state.context = null;
        render();
        callBackground('orders.list')
          .then((orders) => { state.orders = orders ?? []; syncChart(); })
          .catch(() => { /* the list catches up later */ });
        refreshContext().catch(() => { /* a retry is scheduled inside */ });
      }
    }, 500);
  });
  state.observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  });
  // Belt and braces: a re-seat check on a timer as well. A mutation the
  // observer never saw (a throttled background tab, a card that arrived
  // before the observer did) must not leave the panel floating for good.
  // The grant is re-checked on a timer too, not only at page open: a tab
  // left open for weeks would otherwise never renew, and the orders would
  // stop at the end of the month without a word. Silent when nothing is due.
  clearInterval(state.grantTimer);
  state.grantTimer = setInterval(() => {
    if (state.orders.length) ensureGrant({ quiet: true }).catch(() => {});
  }, GRANT_RECHECK_MS);
  clearInterval(state.seatTimer);
  state.seatTimer = setInterval(() => {
    const existing = document.getElementById(PANEL_ID);
    if (!isTokenPage()) { existing?.remove(); state.docked = false; return; }
    const card = findTradeCard();
    const misplaced = card ? existing?.previousElementSibling !== card : state.docked;
    if (existing && misplaced) mount(options);
    // Grace over and still no card: the hidden fallback becomes visible.
    else if (existing && !card && existing.hidden && Date.now() - state.startedAt >= FLOAT_GRACE_MS) existing.hidden = false;
  }, 1000);

  callBackground('orders.list')
    .then((orders) => {
      state.orders = orders ?? [];
      render();
      // Lines on the chart at an ordinary page open too, not only after an
      // order is added.
      syncChart();
      // THE GRANT IS COMPLETED HERE IF PLACEMENT DID NOT MANAGE. Tried only
      // once, at placement, a failure would leave the order watched without
      // rights until the runner found out. The check is cheap and silent when
      // the grant suffices.
      if (state.orders.length) ensureGrant({ quiet: true }).catch(() => {});
    })
    .catch(() => { /* storage is empty */ });
  refreshContext()
    .then(() => probeRoute())
    .catch(() => { /* a retry is scheduled */ });
  startPolling();

  return result;
}

/** Redraw with the current language; the content script calls it on a change. */
export function rerender() {
  render();
}

export function stop() {
  state.observer?.disconnect();
  state.observer = null;
  clearInterval(state.seatTimer);
  clearInterval(state.grantTimer);
  clearInterval(pollTimer);
  document.getElementById(PANEL_ID)?.remove();
  return { mounted: false };
}

export function status() {
  return {
    mounted: Boolean(document.getElementById(PANEL_ID)),
    anchorFound: Boolean(findAnchor()),
    docked: state.docked,
    collapsed: state.collapsed,
    orders: state.orders.length,
    context: contextSummary(),
    balanceStats: { ...state.balanceStats },
    lastBalanceAgeSeconds: state.lastBalanceAt
      ? Math.round((Date.now() - state.lastBalanceAt) / 1000) : null,
    // Whether the chart is alive IN THIS TAB: the runner picks the tab by it.
    // Chrome throttles background tabs and the feed goes silent in them.
    // Visibility is reported apart from the tick age: a hidden tab with a
    // live tick beats a visible one without, and the chooser decides.
    visible: !document.hidden,
    livePriceAgeMs: state.livePriceAt ? Date.now() - state.livePriceAt : null,
  };
}
