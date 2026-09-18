// Quick buy and sell from the feed.
//
// Alerts and Feed list the trades and theses of other people as cards. Under
// every "Buy", "Sell" and "Thesis" card three small buttons appear: two green
// ones buy that token at market for a fixed amount of cash, a red one sells
// a share of the holding. The Tokens tab lists tokens as rows (Trending, Most
// held, Graduated and the rest); every row gets the same three buttons.
// The amounts and the share come from the popup. A press asks for
// confirmation with a second press within a few seconds; then the trade goes
// through FOMO's own pipeline exactly like a tap in the app: their quote, a
// Privy signature on the page, Jito. Nothing is watched afterwards and no
// order is created.
//
// The DOM is FOMO's and changes without notice. Everything that identifies a
// card is read by role rather than by a fixed class chain: the badge text,
// the token link with a tradeId, the first truncated name. When the markup
// drifts the buttons simply do not appear; nothing else on the page breaks.

import {
  extractTokenBalance, extractWallets, normalizeBalance, tokenIdFromLocation,
} from '../shared/balances.js';
import { CASH_TOKEN_ADDRESS, CASH_TOKEN_ID } from '../shared/chains.js';
import { t } from '../shared/i18n.js';
import { amountFromPercent, chainFromTokenId, formatCompact } from '../shared/orders.js';
import {
  CONFIRM_WINDOW_MS, TOKEN_ROW_SELECTOR, formatPercent, formatUsd, normalizeAmounts, normalizeSellPercent, rowCss, tokenIdFromLogo, tokenRowRoomCss, usdToCashUnits,
} from '../shared/quick-buy.js';
import { cssVariables } from '../shared/theme.js';
import * as tokenList from './token-list.js';

const STYLE_ID = 'limil-quick-style';
/** The rule that makes room under token rows; on the page only while the buttons are. */
const ROOM_STYLE_ID = 'limil-quick-room';
const ROW_CLASS = 'lc-feedbuy';
const MARK = 'data-limil-quick';
/** How long a buy may take on the page: relay status is polled for 90 s. */
const BUY_TIMEOUT_MS = 150_000;

let callMain = null;
let callBackground = null;
export function attachMain(fn) { callMain = fn; }
export function attachBackground(fn) { callBackground = fn; }

/** What each button buys: set when the row is mounted, read on a press. */
const meta = new WeakMap();
/** When a button was armed by its first press; 0 or absent means not armed. */
const armed = new WeakMap();

const state = {
  on: false,
  amounts: normalizeAmounts(null),
  /** Share of the holding the sell button sells. */
  sellPercent: normalizeSellPercent(null),
  /** Second press required before a buy. Off buys on the first press. */
  confirm: true,
  observer: null,
  /** A scan in progress: its own DOM changes must not start another. */
  scanning: false,
  /** Token lists whose rows the extension places (token-list.js). */
  scrollers: new Set(),
  /** One buy at a time: two presses on two cards must not race for the wallet. */
  busy: false,
};

// -------------------------------------------------------------------- style

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `:root { ${cssVariables()} }\n${rowCss(ROW_CLASS)}`;
  (document.head ?? document.documentElement).append(style);
}

function ensureRoom(on) {
  const existing = document.getElementById(ROOM_STYLE_ID);
  if (!on) { existing?.remove(); return; }
  if (existing) return;
  const style = document.createElement('style');
  style.id = ROOM_STYLE_ID;
  style.textContent = tokenRowRoomCss();
  (document.head ?? document.documentElement).append(style);
}

// -------------------------------------------------------------------- cards

/** Leaf element whose whole text is the badge word. */
function badgeOf(card) {
  for (const el of card.querySelectorAll('span, div')) {
    if (el.children.length) continue;
    const text = el.textContent.trim();
    if (text === 'Buy' || text === 'Sell' || text === 'Thesis') return text;
  }
  return null;
}

/** Token name of a trade card: the dotted-underlined name in the trade row. */
function tradeTokenOf(card) {
  const el = card.querySelector('[class*="border-dotted"]');
  return el ? el.textContent.trim() : null;
}

/** Token name of a thesis card: the truncated, underlined name after the author. */
function thesisTokenOf(card) {
  const names = [...card.querySelectorAll('.truncate')].map((el) => el.textContent.trim()).filter(Boolean);
  return names.length > 1 ? names[1] : null;
}

/** Every card of the two lists. The class pair is FOMO's card separator. */
function allCards() {
  return [...document.querySelectorAll('div.border-b.border-bg-secondary')];
}

/**
 * Every token row of the Tokens tab: the row is one link to the token's
 * page, inside the clipping box of an animated list item. The strip goes
 * inside the link, into the room the rule above reserves under the text,
 * so the row is as tall with the strip as without it and FOMO's list, which
 * measures a row once inside React's commit, has the right height from the
 * start. A press stops the link from navigating.
 */
const TOKEN_ROW = `${TOKEN_ROW_SELECTOR}:not([href*="tradeId="])`;
function allTokenRows() {
  return [...document.querySelectorAll(TOKEN_ROW)].map((link) => ({ box: link.parentElement, link }));
}

/** The scrolling element of the list a token row belongs to. */
function scrollerOf(box) {
  return box.closest('.legend-list-content-container')?.parentElement ?? null;
}

/** Token name of a token row: the first truncated text, the symbol. */
function rowTokenOf(link) {
  const el = link.querySelector('.truncate');
  return el ? el.textContent.trim() : null;
}

/** Token id of a card: the trade link when there is one, else the token logo. */
function tokenIdOf(card) {
  const link = card.querySelector('a[href*="tradeId="]');
  if (link) {
    const fromLink = tokenIdFromLocation(new URL(link.getAttribute('href'), location.origin).href);
    if (fromLink) return fromLink;
  }
  for (const img of card.querySelectorAll('img')) {
    const id = tokenIdFromLogo(img.getAttribute('src'));
    if (id) return id;
  }
  return null;
}

/**
 * Whether a row still belongs to the card it sits in. The lists are
 * virtualised: as the user scrolls, FOMO reuses a card element for another
 * trade and re-renders its content, while our row and mark stay on the
 * element. A row whose token or place no longer matches is removed and the
 * card is judged afresh.
 */
function rowStillValid(card, badge, tokenId) {
  const row = card.querySelector(`.${ROW_CLASS}`);
  if (!row) return false;
  if (row.dataset.tokenId !== tokenId || row.dataset.badge !== badge) return false;
  if (badge === 'Token') return row.parentElement?.lastElementChild === row;
  const anchor = badge === 'Thesis' ? null : card.querySelector('a[href*="tradeId="]');
  return anchor ? anchor.nextElementSibling === row : card.lastElementChild === row;
}

/** The token a row links to, or null when the link is not a token page FOMO trades on. */
function tokenIdOfLink(link) {
  try {
    return tokenIdFromLocation(new URL(link.getAttribute('href'), location.origin).href);
  } catch {
    return null;
  }
}

function scan() {
  if (!state.on) return;
  for (const card of allCards()) {
    const badge = badgeOf(card);
    const wanted = badge === 'Buy' || badge === 'Sell' || badge === 'Thesis';
    const tokenId = wanted ? tokenIdOf(card) : null;
    if (card.hasAttribute(MARK)) {
      if (wanted && tokenId && rowStillValid(card, badge, tokenId)) continue;
      unmount(card);
    }
    if (!wanted || !tokenId) continue;
    const token = badge === 'Thesis' ? thesisTokenOf(card) : tradeTokenOf(card);
    mount({ card, badge, token, tokenId });
  }
  for (const { box, link } of allTokenRows()) {
    const tokenId = tokenIdOfLink(link);
    if (box.hasAttribute(MARK)) {
      if (tokenId && rowStillValid(box, 'Token', tokenId)) continue;
      unmount(box);
    }
    if (!tokenId) continue;
    mount({ card: box, badge: 'Token', token: rowTokenOf(link), tokenId, at: link });
    // The list places its rows 53px apart whatever they measure; while the
    // strip is on, the rows of that list are placed by the extension.
    const scroller = scrollerOf(box);
    if (scroller) { tokenList.attach(scroller); state.scrollers.add(scroller); }
  }
  // A row orphaned outside any card (the element stopped being a card or a
  // token row). On a token row the mark is on the box above the strip.
  for (const row of document.querySelectorAll(`.${ROW_CLASS}`)) {
    if (!row.parentElement?.closest(`[${MARK}]`)) row.remove();
  }
}

/**
 * The scan runs in the observer's own microtask, before the browser's next
 * rendering step, and not on a timer. FOMO's Tokens list measures a row at
 * its first rendering step and places every row below by that height; a
 * strip added later grew the row without moving the rows below it, and
 * they overlapped. Added before that first step, the strip is part of the
 * height the list measures. The scan is cheap: a few queries over the
 * cards and rows on the page.
 */
function scheduleScan() {
  if (state.scanning) return;
  state.scanning = true;
  try {
    scan();
  } finally {
    state.scanning = false;
  }
}

// --------------------------------------------------------------------- row

/** The idle label of a button, by what it does. */
function idleLabel(m) {
  return m.kind === 'sell' ? t('quick.sellButton', { pct: formatPercent(m.pct) }) : t('quick.button', { amount: formatUsd(m.usd) });
}
function armedLabel(m) {
  return m.kind === 'sell' ? t('quick.sellConfirm', { pct: formatPercent(m.pct) }) : t('quick.confirm', { amount: formatUsd(m.usd) });
}

function mount({ card, badge, token, tokenId, at = null }) {
  ensureStyle();
  const row = document.createElement('div');
  row.className = badge === 'Token' ? `${ROW_CLASS} ${ROW_CLASS}-token` : ROW_CLASS;
  row.dataset.tokenId = tokenId;
  row.dataset.badge = badge;
  const note = document.createElement('span');
  note.className = 'lc-feedbuy-note';
  // A click on the text takes it away; it stops there, the card must not open.
  note.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setNote(note, ''); });
  const specs = [
    ...state.amounts.map((usd) => ({ kind: 'buy', usd })),
    { kind: 'sell', pct: state.sellPercent },
  ];
  for (const spec of specs) {
    const button = document.createElement('button');
    button.type = 'button';
    const m = { ...spec, row, note, tokenId, token };
    button.textContent = idleLabel(m);
    button.title = spec.kind === 'sell'
      ? t('quick.sellTitle', { pct: formatPercent(spec.pct), token: token ?? '' })
      : t('quick.title', { amount: formatUsd(spec.usd), token: token ?? '' });
    if (spec.kind === 'sell') button.classList.add('lc-sell');
    meta.set(button, m);
    button.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // A page script can dispatch a click on this button; such a click is
      // not trusted by the browser and buys nothing. Only a real press counts.
      if (ev.isTrusted === false) return;
      press(button);
    });
    row.append(button);
  }
  row.append(note);
  card.setAttribute(MARK, '1');
  // A token row: the strip goes into the link, into the reserved room; the
  // press handler stops the link. A Buy or Sell card is one anchor: the row
  // goes after it, not inside, or a click would navigate. A Thesis card is a
  // plain block: the row goes last.
  const anchor = badge === 'Thesis' ? null : card.querySelector('a[href*="tradeId="]');
  if (at) at.append(row);
  else if (anchor) anchor.insertAdjacentElement('afterend', row);
  else card.append(row);
}

function unmount(card) {
  card.removeAttribute(MARK);
  card.querySelector(`.${ROW_CLASS}`)?.remove();
}

/** How long a result stays on the list's card before it goes on its own. */
const TOKEN_NOTE_MS = 20000;
const noteTimers = new WeakMap();
const TOAST_CLASS = 'lc-feedbuy-toast';

/**
 * The frame of a token list: the positioned box the scroller sits in. The
 * rows are clipped to their fixed height, so a result about a token row is
 * shown on a card at the bottom of this frame, in full.
 */
function frameOf(row) {
  const scroller = row.closest('.legend-list-content-container')?.parentElement;
  const frame = scroller?.parentElement;
  return frame && getComputedStyle(frame).position !== 'static' ? frame : scroller ?? null;
}

function showToast(frame, text, tone) {
  let toast = frame.querySelector(`:scope > .${TOAST_CLASS}`);
  if (!text) { toast?.remove(); return; }
  if (!toast) {
    toast = document.createElement('div');
    toast.className = TOAST_CLASS;
    toast.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); toast.remove(); });
    frame.append(toast);
  }
  toast.textContent = text;
  toast.className = `${TOAST_CLASS}${tone ? ` ${tone}` : ''}`;
  clearTimeout(noteTimers.get(toast));
  if (tone) noteTimers.set(toast, setTimeout(() => toast.remove(), TOKEN_NOTE_MS));
}

function setNote(note, text, tone = '') {
  note.textContent = text;
  // The whole text on hover, for when the line is short.
  note.title = text;
  note.className = `lc-feedbuy-note${tone ? ` ${tone}` : ''}`;
  const row = note.parentElement;
  if (!row || !row.classList.contains(`${ROW_CLASS}-token`)) return;
  const frame = frameOf(row);
  if (frame) showToast(frame, text, tone);
}

/** A refusal or a failure, in the journal too: the note under a card is small and goes with the card. */
function journal(text) {
  callBackground?.('runner.note', { text }).catch(() => {});
}

/**
 * A press on one of the buttons, whichever surface it came from.
 *
 * The click handler above calls this after the isTrusted check; the feed
 * mirror (feed-mirror.js) calls it for a press in the side panel, which
 * arrives over the extension's own port and not as a DOM event. Anything
 * that is not a button this module mounted is refused: the page cannot
 * make a press out of an element of its own.
 *
 * @returns {boolean} whether the element was one of ours
 */
export function press(button) {
  const m = meta.get(button);
  if (!m || !button.isConnected) return false;
  const now = Date.now();
  const armedAt = armed.get(button) ?? 0;
  if (state.confirm && now - armedAt > CONFIRM_WINDOW_MS) {
    // First press arms; a stray tap in a scrolling feed trades nothing.
    armed.set(button, now);
    button.classList.add('lc-arm');
    button.textContent = armedLabel(m);
    setTimeout(() => {
      if (Date.now() - (armed.get(button) ?? 0) >= CONFIRM_WINDOW_MS) {
        button.classList.remove('lc-arm');
        button.textContent = idleLabel(m);
      }
    }, CONFIRM_WINDOW_MS + 50);
    return true;
  }
  armed.delete(button);
  button.classList.remove('lc-arm');
  button.textContent = idleLabel(m);
  const run = m.kind === 'sell' ? sell(m) : buy(m);
  run.catch(() => { /* reported in the note */ });
  return true;
}

// --------------------------------------------------------------------- buy

/** Text for a canSign refusal, by its code; the same wording as the panel. */
function offlineText(canSign) {
  if (canSign?.code === 'no-privy') return t('panel.offline.noPrivy');
  if (canSign?.code === 'other-wallet') return t('panel.offline.otherWallet');
  return t('panel.offline.text');
}

async function buy({ row, note, usd, tokenId, token }) {
  if (!callMain) { setNote(note, t('panel.notReady'), 'bad'); return; }
  if (state.busy) { setNote(note, t('quick.busy'), 'bad'); return; }
  state.busy = true;
  const buttons = [...row.querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;
  setNote(note, t('quick.working'));
  try {
    const session = await callMain('fomo.status');
    const uuid = session?.userId;
    if (!uuid) throw new Error(t('quick.noSession'));

    // Wallets and cash come from the balances, the same source as the panel.
    const balances = await callMain('fomo.balances', { uuid });
    const wallets = extractWallets(balances);
    const cash = normalizeBalance(extractTokenBalance(balances, CASH_TOKEN_ADDRESS));
    const amount = usdToCashUnits(usd);
    if (cash?.amount !== undefined && cash?.amount !== null && BigInt(cash.amount) < amount) {
      throw new Error(t('quick.noCash', { have: formatCompact(cash.amount.toString(), 6) }));
    }

    // Can the page sign at all: the envelope sample must exist and be this wallet's.
    const canSign = await callMain('privy.canSign', { sender: wallets.evm ?? null });
    if (canSign && canSign.ok === false) throw new Error(offlineText(canSign));

    // Market buy through FOMO: cash on Solana → the token. No target, so no
    // tolerance of our own applies; relay's own slippage stands, as in the app.
    const report = await callMain('swap.prepare', {
      sender: wallets.evm ?? null,
      side: 'buy',
      solanaAddress: wallets.solana ?? null,
      chainId: chainFromTokenId(tokenId),
      inTokenId: CASH_TOKEN_ID,
      outTokenId: tokenId,
      amount: amount.toString(),
      maxSlippageBps: null,
      targetOutScaled: null,
      sign: true,
      send: true,
    }, BUY_TIMEOUT_MS);

    if (report?.blocked && !report?.sent) throw new Error(report.blocked);
    if (report?.sent && report?.receipt?.success) {
      setNote(note, t('quick.done', { amount: formatUsd(usd), token: token ?? '' }), 'ok');
    } else if (report?.sent) {
      // Sent, and the chain's word on it: a failure or a drop is not a buy.
      const failed = report?.receipt?.success === false;
      setNote(note, report?.note ?? t('quick.sent'), failed ? 'bad' : 'ok');
    } else {
      throw new Error(report?.note ?? t('quick.notSent'));
    }
    callBackground?.('runner.note', {
      text: `quick buy ${formatUsd(usd)} of ${token ?? tokenId}: ${report?.receipt?.status ?? (report?.sent ? 'sent' : 'not sent')}`,
    }).catch(() => {});
  } catch (err) {
    const text = String(err?.message || err);
    setNote(note, text, 'bad');
    journal(`quick buy ${formatUsd(usd)} of ${token ?? tokenId} failed: ${text}`);
  } finally {
    state.busy = false;
    for (const b of buttons) b.disabled = false;
  }
}

/**
 * A market sell of a share of the holding, through FOMO like the buy: their
 * quote for token → cash, the wallet's signature through Privy on the page,
 * their sender. The holding comes from the balances the app itself fetches;
 * a Solana mint without decimals there is read from the chain instead, the
 * way the order panel does it. Nothing is watched afterwards.
 */
async function sell({ row, note, pct, tokenId, token }) {
  if (!callMain) { setNote(note, t('panel.notReady'), 'bad'); return; }
  if (state.busy) { setNote(note, t('quick.busy'), 'bad'); return; }
  state.busy = true;
  const buttons = [...row.querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;
  setNote(note, t('quick.selling'));
  try {
    const session = await callMain('fomo.status');
    const uuid = session?.userId;
    if (!uuid) throw new Error(t('quick.noSession'));

    const balances = await callMain('fomo.balances', { uuid });
    const wallets = extractWallets(balances);
    const address = String(tokenId).split(':')[0];
    const holding = extractTokenBalance(balances, address);
    if (!holding) throw new Error(t('quick.noHolding', { token: token ?? address }));

    // Minimal units of the holding. FOMO's balances carry no decimals for a
    // Solana mint; the token account on the chain has both.
    let held = null;
    try {
      held = normalizeBalance(holding)?.amount ?? null;
    } catch {
      held = null;
    }
    const isSolanaMint = !/^0x[0-9a-f]{40}$/i.test(address);
    if (held === null && isSolanaMint && wallets.solana && callBackground) {
      const res = await callBackground('solana.tokenBalance', { owner: wallets.solana, mint: address });
      if (res?.amount !== undefined) held = BigInt(res.amount);
    }
    if (held === null || held <= 0n) throw new Error(t('quick.noHolding', { token: token ?? address }));
    const amount = amountFromPercent(held, pct);

    const canSign = await callMain('privy.canSign', { sender: wallets.evm ?? null });
    if (canSign && canSign.ok === false) throw new Error(offlineText(canSign));

    const report = await callMain('swap.prepare', {
      sender: wallets.evm ?? null,
      side: 'sell',
      solanaAddress: wallets.solana ?? null,
      chainId: chainFromTokenId(tokenId),
      inTokenId: tokenId,
      outTokenId: CASH_TOKEN_ID,
      amount: amount.toString(),
      maxSlippageBps: null,
      targetOutScaled: null,
      sign: true,
      send: true,
    }, BUY_TIMEOUT_MS);

    if (report?.blocked && !report?.sent) throw new Error(report.blocked);
    if (report?.sent && report?.receipt?.success) {
      setNote(note, t('quick.sellDone', { pct: formatPercent(pct), token: token ?? '' }), 'ok');
    } else if (report?.sent) {
      // Sent, and the chain's word on it: a failure or a drop is not a sale.
      const failed = report?.receipt?.success === false;
      setNote(note, report?.note ?? t('quick.sent'), failed ? 'bad' : 'ok');
    } else {
      throw new Error(report?.note ?? t('quick.notSent'));
    }
    callBackground?.('runner.note', {
      text: `quick sell ${formatPercent(pct)} of ${token ?? tokenId}: ${report?.receipt?.status ?? (report?.sent ? 'sent' : 'not sent')}`,
    }).catch(() => {});
  } catch (err) {
    const text = String(err?.message || err);
    setNote(note, text, 'bad');
    journal(`quick sell ${formatPercent(pct)} of ${token ?? tokenId} failed: ${text}`);
  } finally {
    state.busy = false;
    for (const b of buttons) b.disabled = false;
  }
}

// ------------------------------------------------------------------ control

export function start(settings = {}) {
  state.amounts = normalizeAmounts(settings.quickBuyAmounts);
  state.sellPercent = normalizeSellPercent(settings.quickSellPercent);
  state.confirm = settings.quickBuyConfirm !== false;
  if (state.on) { rerender(); return; }
  state.on = true;
  ensureStyle();
  ensureRoom(true);
  state.observer = new MutationObserver(scheduleScan);
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
}

export function stop() {
  state.on = false;
  for (const toast of document.querySelectorAll(`.${TOAST_CLASS}`)) toast.remove();
  state.observer?.disconnect();
  state.observer = null;
  ensureRoom(false);
  for (const scroller of state.scrollers) tokenList.detach(scroller);
  state.scrollers.clear();
  for (const card of document.querySelectorAll(`[${MARK}]`)) unmount(card);
}

/** Settings changed in the popup: switch and amounts. */
export function update(settings = {}) {
  if (settings.quickBuyEnabled === true) start(settings);
  else stop();
  return { on: state.on, amounts: state.amounts, sellPercent: state.sellPercent };
}

/** Rebuilds the rows with the current amounts and language. */
export function rerender() {
  if (!state.on) return;
  for (const card of document.querySelectorAll(`[${MARK}]`)) unmount(card);
  scan();
}

export function status() {
  return { on: state.on, amounts: state.amounts, sellPercent: state.sellPercent, rows: document.querySelectorAll(`.${ROW_CLASS}`).length };
}
