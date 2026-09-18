// Quick buy and sell from the feed: the pure part.
//
// Every Buy, Sell and Thesis card in Alerts and Feed, and every token row in
// Tokens, gets three buttons: two buy the token at market through FOMO for a
// fixed amount of cash, the third sells a share of the holding. The DOM work
// lives in isolated/feed-buy.js; what can be tested without a page is here:
// amount handling and reading the token out of a card.

import { CASH_DECIMALS, CHAINS, SOLANA_NETWORK_ID } from './chains.js';
import { tokenFromLocation } from './balances.js';

/** Default button amounts in USD. */
export const DEFAULT_QUICK_BUY_AMOUNTS = [50, 200];

/** Default share of the holding the sell button sells, in percent. */
export const DEFAULT_QUICK_SELL_PERCENT = 50;

/** Two taps within this window confirm a buy; a single tap does nothing. */
export const CONFIRM_WINDOW_MS = 3000;

/** Highest amount a button may carry: a typo must not become a position. */
export const MAX_QUICK_BUY_USD = 10_000;

/**
 * Button amounts from a setting. Accepts a list or a "50, 200" string, keeps
 * positive numbers up to two decimals and at most two of them, drops
 * duplicates, sorts ascending. Nothing usable means the defaults.
 */
export function normalizeAmounts(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;\s]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const n = Math.round(Number(String(item).replace(/[$\s]/g, '')) * 100) / 100;
    if (!Number.isFinite(n) || n <= 0 || n > MAX_QUICK_BUY_USD) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out.length ? out.slice(0, 2) : [...DEFAULT_QUICK_BUY_AMOUNTS];
}

/**
 * The sell button's share of the holding, from a setting: a number above 0
 * and up to 100, one decimal kept. Anything else means the default.
 */
export function normalizeSellPercent(input) {
  const n = Math.round(Number(String(input ?? '').replace(/[%\s]/g, '')) * 10) / 10;
  if (!Number.isFinite(n) || n <= 0 || n > 100) return DEFAULT_QUICK_SELL_PERCENT;
  return n;
}

/** "50%", "33.3%", the way the sell button reads. */
export function formatPercent(pct) {
  const n = Number(pct);
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/** USD to minimal units of the cash token (USDC, six decimals), exactly. */
export function usdToCashUnits(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) throw new Error('the amount must be above zero');
  return BigInt(Math.round(n * 10 ** CASH_DECIMALS));
}

/** "$50", "$12.5", the way the button reads. */
export function formatUsd(usd) {
  const n = Number(usd);
  return `$${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}`;
}

/**
 * Token id from FOMO's token logo URL. Thesis cards carry no link to the
 * token, but their logo comes from `token-media.defined.fi/<chain>_<address>_…`,
 * which names both. Anything else, or a chain FOMO does not trade on, is null.
 */
export function tokenIdFromLogo(src) {
  const m = String(src ?? '').match(/token-media\.defined\.fi\/(\d+)_([A-Za-z0-9]+)_/);
  if (!m) return null;
  const chainId = Number(m[1]);
  const known = chainId === SOLANA_NETWORK_ID || Object.prototype.hasOwnProperty.call(CHAINS, chainId);
  const address = tokenFromLocation(m[2]);
  return known && address ? `${address}:${chainId}` : null;
}

/**
 * The room under every token row of the Tokens tab, while the buttons are
 * on. FOMO's Tokens list measures a row inside React's commit, before any
 * observer of ours can run, and a row that grows afterwards is not moved
 * apart from its neighbours on their page. So the room is not made by the
 * strip: this rule, present before the rows exist, gives every token row
 * its extra height from the first layout, and the strip is placed into it
 * without changing the height. The page carries the rule only while quick
 * buy is on (isolated/feed-buy.js); the panel mirrors that (panel/panel.js).
 */
export const TOKEN_ROW_SELECTOR = 'div.grid > div.overflow-hidden > a[href*="/tokens/"]';
export function tokenRowRoomCss() {
  return `${TOKEN_ROW_SELECTOR} { position: relative; padding-bottom: 40px !important; }\n`;
}

/**
 * The buttons' stylesheet, scoped to the row class. Used on the page
 * (isolated/feed-buy.js) and in the side panel, which mirrors the rows and
 * must draw them the same; the `--lc-*` variables come from shared/theme.js.
 */
export function rowCss(rowClass) {
  return `
.${rowClass} {
  display: flex; align-items: center; gap: 6px; padding: 0 12px 10px 52px; margin-top: -2px;
  font-family: var(--lc-font); font-size: 12px; line-height: 1;
  /* The strip measures ITSELF. A feed card is narrower than the panel it sits
     in, so the width that decides whether three buttons fit on one line is
     this element's, not the document's: in a 600px panel a 300px card still
     wrapped the sell button onto a second row. */
  container-type: inline-size;
}
.${rowClass}.${rowClass}-token {
  position: absolute; left: 56px; right: 8px; bottom: 8px; padding: 0; margin: 0;
}
.${rowClass} button {
  appearance: none; border: 1px solid var(--lc-buy-soft); border-radius: var(--lc-r-pill);
  background: var(--lc-buy-soft); color: var(--lc-buy); font: inherit; font-weight: 700;
  padding: 5px 10px; cursor: pointer; white-space: nowrap;
  transition: background-color .15s, color .15s, border-color .15s;
  /* Shrinkable, and the last resort. Three buttons want 241px; a row narrower
     than that plus its offsets used to push the sell button straight out of
     the row, because nothing here was allowed to give. Now they shrink, and
     only past the point where the compact rules below have run out do the
     labels clip. */
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
}
.${rowClass} button:hover { background: var(--lc-buy); color: var(--lc-bg); }
.${rowClass} button.lc-arm { background: var(--lc-buy); color: var(--lc-bg); }
.${rowClass} button.lc-sell { border-color: var(--lc-sell-soft); background: var(--lc-sell-soft); color: var(--lc-sell); }
.${rowClass} button.lc-sell:hover, .${rowClass} button.lc-sell.lc-arm { background: var(--lc-sell); color: var(--lc-bg); }
.${rowClass} button:disabled { opacity: .55; cursor: default; }
.${rowClass} { flex-wrap: wrap; }
.${rowClass} .lc-feedbuy-note { color: var(--lc-dim); font-size: 11px; min-width: 0; line-height: 1.3; }
.${rowClass} .lc-feedbuy-note:empty { display: none; }
.${rowClass} .lc-feedbuy-note:not(:empty) { flex-basis: 100%; white-space: normal; word-break: break-word; }
.${rowClass} .lc-feedbuy-note.ok { color: var(--lc-buy); }
.${rowClass} .lc-feedbuy-note.bad { color: var(--lc-bad); }
/* A token row has a fixed height and the list clips to it: the result of a
   trade there is shown on a card at the bottom of the list instead, in
   full, until it is clicked or times out. */
.${rowClass}.${rowClass}-token { flex-wrap: nowrap; }
.${rowClass}.${rowClass}-token .lc-feedbuy-note { display: none; }
/* A narrow window, and above all the side panel, whose width IS the document's.
   A 13-inch laptop opens the panel at around 300px and the three buttons stop
   fitting a few pixels before that. Less padding, a smaller label and a tighter
   left offset buy back some fifty pixels, which is enough to keep all three
   whole down to about 250px. */
@media (max-width: 340px) {
  .${rowClass} { gap: 4px; font-size: 11px; }
  .${rowClass} button { padding: 4px 7px; }
  .${rowClass}.${rowClass}-token { left: 46px; right: 6px; }
}
/* Narrow strip, wide window: a feed card in a side panel. Only the children
   can be styled from here, which is why the buttons carry the savings. */
@container (max-width: 320px) {
  .${rowClass} button { padding: 4px 7px; font-size: 11px; }
}
@container (max-width: 270px) {
  .${rowClass} button { padding: 3px 5px; font-size: 10px; }
}
.lc-feedbuy-toast {
  position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 5;
  padding: 8px 10px; border-radius: var(--lc-r-sm); background: var(--lc-card);
  border: 1px solid var(--lc-line); box-shadow: 0 8px 24px rgba(0,0,0,.45);
  color: var(--lc-dim); font-family: var(--lc-font); font-size: 12px; line-height: 1.35;
  white-space: pre-wrap; word-break: break-word; cursor: pointer;
}
.lc-feedbuy-toast.ok { color: var(--lc-buy); }
.lc-feedbuy-toast.bad { color: var(--lc-bad); }
`;
}
