// The side panel: FOMO's Alerts / Tokens / Leaderboard / Feed block, live,
// on every site.
//
// The block is mirrored from an open FOMO tab (isolated/feed-mirror.js) over
// a port: a snapshot, then deltas. Clicks and scrolls here are forwarded to
// the tab; a press on a quick-buy button is forwarded as a press and runs on
// the tab through the same code as a real one. Nothing is stored here and
// nothing here reaches the network except FOMO's stylesheet and images.
//
// This is an extension page, and the tree it draws was written by other
// people. It is built with createElement and textContent from a filtered
// value (shared/mirror-tree.js); the filter runs again here on apply.

import { MIRROR_PORT, cardKeyText, createMirror } from '../shared/mirror-tree.js';
import { adaptSheet } from '../shared/fomo-css.js';
import { cssVariables, fontFaces } from '../shared/theme.js';
import { rowCss, tokenRowRoomCss } from '../shared/quick-buy.js';
import { applyToDom, initLocale, onLocaleChange, t } from '../shared/i18n.js';

const FOMO_URLS = ['https://fomo.family/*', 'https://*.fomo.family/*'];
/** After a lost connection, how long to wait before trying again. */
const RETRY_MS = 3000;
/** With a tab connected but no block on it, how long before looking at the tabs again. */
const NO_BLOCK_RETRY_MS = 8000;
/** A tab that never sends a snapshot is a tab without our script (reload pending). */
const SNAPSHOT_TIMEOUT_MS = 4000;

const $ = (id) => document.getElementById(id);

// Our own variables and the quick-buy row style; FOMO's stylesheet comes
// with the snapshot and defines the `--color-*` values these read.
const ownStyle = document.createElement('style');
ownStyle.textContent = `${fontFaces((path) => chrome.runtime.getURL(path))}\n:root { ${cssVariables()} }\n${rowCss('lc-feedbuy')}`;
document.head.append(ownStyle);

// The room under token rows exists on the page only while quick buy is on;
// the mirror must draw the rows the same, so the rule follows the setting.
const roomStyle = document.createElement('style');
roomStyle.textContent = tokenRowRoomCss();
async function followQuickBuy() {
  try {
    const bag = await chrome.storage.local.get('settings');
    roomStyle.disabled = bag?.settings?.quickBuyEnabled !== true;
  } catch { roomStyle.disabled = true; }
}
document.head.append(roomStyle);
await followQuickBuy();
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.settings) followQuickBuy();
});

await initLocale();
applyToDom(document);
onLocaleChange(() => applyToDom(document));

const host = $('host');
const mirror = createMirror(document);

const state = {
  /** @type {chrome.runtime.Port|null} */
  port: null,
  tabId: null,
  retry: null,
  snapshotTimer: null,
  /** Which of the open FOMO tabs to try next when one does not answer. */
  turn: 0,
};

function setStatus(key, tone = '') {
  const el = $('status');
  el.textContent = t(key);
  el.className = `status${tone ? ` ${tone}` : ''}`;
  $('open-fomo').hidden = key !== 'feed.status.noTab';
}

/**
 * FOMO's stylesheets and fonts.
 *
 * Each sheet is fetched as text and adapted (shared/fomo-css.js): its
 * @font-face rules are cut out, the files they name are fetched by the
 * extension itself and registered with the FontFace API, its relative
 * url() references are made absolute, and anything that would reach a host
 * other than FOMO's is dropped. Linking the sheet instead leaves the panel
 * in the system face: a font is fetched with CORS, fomo.family sends no CORS
 * header, and a face registered under the same name as the sheet's failing
 * one loses to it. The adapted sheet goes in as a <style>; stale ones are
 * removed. A sheet that cannot be fetched is linked as it is, so the block
 * at least has its layout.
 */
const sheets = new Map();
const loadedFaces = new Set();

async function loadFace(face) {
  const key = `${face.family}|${face.weight}|${face.style}|${face.url}`;
  if (loadedFaces.has(key)) return;
  loadedFaces.add(key);
  try {
    const bytes = await (await fetch(face.url)).arrayBuffer();
    const loaded = new FontFace(face.family, bytes, { weight: face.weight, style: face.style });
    await loaded.load();
    document.fonts.add(loaded);
  } catch {
    loadedFaces.delete(key);
  }
}

async function addSheet(href) {
  let text = null;
  try { text = await (await fetch(href)).text(); } catch { /* linked below */ }
  let el;
  if (text !== null) {
    const { css, faces } = adaptSheet(text, href);
    el = document.createElement('style');
    el.textContent = css;
    for (const face of faces) loadFace(face).catch(() => {});
  } else {
    el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = href;
  }
  el.dataset.fomo = href;
  // The snapshot may have changed its mind while the fetch was out.
  if (sheets.get(href) !== 'pending') return;
  sheets.set(href, el);
  document.head.append(el);
  scheduleRelayout();
}

function applySheets(urls) {
  const wanted = new Set();
  for (const raw of urls ?? []) {
    try {
      const u = new URL(String(raw));
      if (u.protocol === 'https:' && /(^|\.)fomo\.family$/i.test(u.hostname)) wanted.add(u.href);
    } catch { /* not a URL */ }
  }
  for (const [href, el] of sheets) {
    if (wanted.has(href)) continue;
    if (el !== 'pending') el.remove();
    sheets.delete(href);
  }
  for (const href of wanted) {
    if (sheets.has(href)) continue;
    sheets.set(href, 'pending');
    addSheet(href).catch(() => sheets.delete(href));
  }
}

/**
 * FOMO's lists are virtualised: the page mounts a window of rows around
 * its own scroll position, places them by tops it measured or estimated,
 * and recycles the row containers, so a container's contents change and
 * the window moves under the reader. None of that is a way to read a feed.
 *
 * So the panel keeps a SHELF of its own for every such list: one slot per
 * card, keyed by the card's identity (its text without the numbers that
 * tick), holding a copy of the card as the page last showed it. A card
 * that the page has mounted once stays on the shelf, at its place, whether
 * or not the page still mounts it; its copy is refreshed in place when the
 * page changes it; a card that arrives above the viewport is inserted with
 * the scroll moved by exactly its height, so what is being read does not
 * move. The order comes from neighbourhood: rows the page mounts together
 * are in order among themselves, and a new card goes right after the
 * nearest known card before it (or before the nearest known after it). The
 * page's own list stays in the mirror as the hidden source of the copies.
 *
 * The copies are clones, so the mirror's ids do not reach them; a map from
 * each cloned element to the id of its original does, for clicks and
 * presses (cloneIdOf).
 */
const SOURCE_CLASS = 'lm-source';
const SHELF_CLASS = 'lm-shelf';
const SLOT_CLASS = 'lm-slot';
/** How many cards a shelf keeps before the ones farthest from the viewport go. */
const SHELF_MAX = 400;
let relayoutPending = false;
/** For the status line: how many shelves, how many ops could not be applied. */
const diag = { lists: 0, skipped: 0 };
/** Per source list: its shelf. */
const shelves = new WeakMap();
/** Cloned element → id of the original in the mirror. */
const cloneOwners = new WeakMap();

const pageTopOf = (row) => parseFloat(row.style.top) || 0;

/** The rows of a list in the page's order: by the top the page gave them, not by DOM order. */
function rowsOf(list) {
  return [...list.children].filter((r) => r.style?.position === 'absolute').sort((x, y) => pageTopOf(x) - pageTopOf(y));
}

/** The scrolling element a list lives in. */
function scrollerOf(list) {
  let el = list.parentElement;
  while (el && el !== host) {
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * What a row shows, as a key that survives the row being recycled, moved or
 * ticked: a token row is its token (the link), a card is its text without
 * the prices, percentages and relative times that change under it.
 */
function itemKeyOf(row) {
  const link = row.querySelector('a[href*="/tokens/"]:not([href*="tradeId"])');
  if (link) return `token:${link.getAttribute('href')}`;
  return cardKeyText(row.textContent);
}
/** A key too short to name a card: a row mid-recycle, or a bare separator. */
const MIN_KEY = 4;

/** A deep copy of a card, every element of the copy mapped to the id of its original. */
function copyOf(node) {
  const clone = node.cloneNode(true);
  const a = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
  const b = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  let x = a.currentNode;
  let y = b.currentNode;
  while (x && y) {
    const id = mirror.idOf(x);
    if (id) cloneOwners.set(y, id);
    x = a.nextNode();
    y = b.nextNode();
  }
  return clone;
}

/** The mirror id behind a node of the panel: its own, or its original's when it is a copy. */
function idBehind(node) {
  let n = node;
  while (n) {
    const id = cloneOwners.get(n);
    if (id) return id;
    n = n.parentNode;
  }
  return mirror.idOf(node);
}

/** A line for the popup's journal about the panel's layout; throttled. */
let traceCount = 0;
function trace(text) {
  traceCount += 1;
  if (traceCount > 200) return;
  chrome.runtime.sendMessage({ type: 'runner.note', payload: { text: `panel: ${text}` } }).catch(() => {});
}

function shelfFor(list) {
  let shelf = shelves.get(list);
  if (shelf && shelf.el.isConnected) return shelf;
  const el = document.createElement('div');
  el.className = SHELF_CLASS;
  list.parentElement.insertBefore(el, list);
  list.classList.add(SOURCE_CLASS);
  shelf = { el, slots: new Map(), order: [], scroller: scrollerOf(list) };
  shelves.set(list, shelf);
  shelfList.add(list);
  return shelf;
}

/**
 * Brings a shelf up to date with the rows the page mounts now. Cards are
 * added where their neighbours say, copies refreshed where the text moved
 * on, and the scroll compensated for whatever changed above the viewport.
 */
function updateShelf(list) {
  const shelf = shelfFor(list);
  const scroller = shelf.scroller;
  const viewTop = scroller ? scroller.getBoundingClientRect().top : -Infinity;
  const rows = rowsOf(list);
  const seen = [];
  for (const row of rows) {
    const content = row.firstElementChild;
    if (!content) continue;
    const key = itemKeyOf(row);
    if (key.length < MIN_KEY) continue;
    seen.push({ key, content, top: pageTopOf(row) });
  }
  // Order: a card not on the shelf goes after the nearest known card before
  // it in this window, else before the nearest known after it, else at the
  // end (a window with nothing known: further down, the page loads that way).
  for (let i = 0; i < seen.length; i += 1) {
    const { key } = seen[i];
    if (shelf.slots.has(key)) continue;
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j -= 1) { const k = shelf.order.indexOf(seen[j].key); if (k >= 0) at = k + 1; }
    if (at < 0) for (let j = i + 1; j < seen.length && at < 0; j += 1) { const k = shelf.order.indexOf(seen[j].key); if (k >= 0) at = k; }
    if (at < 0) at = shelf.order.length;
    const slot = document.createElement('div');
    slot.className = SLOT_CLASS;
    shelf.slots.set(key, { slot, text: null, top: seen[i].top });
    shelf.order.splice(at, 0, key);
  }
  // Copies: fresh where the page's text changed; the same otherwise.
  let shift = 0;
  for (const { key, content, top } of seen) {
    const entry = shelf.slots.get(key);
    entry.top = top;
    const text = content.textContent ?? '';
    if (entry.text === text) continue;
    const above = entry.slot.isConnected && entry.slot.getBoundingClientRect().bottom <= viewTop;
    const before = entry.slot.offsetHeight;
    entry.slot.replaceChildren(copyOf(content));
    entry.text = text;
    if (above) shift += entry.slot.offsetHeight - before;
  }
  // Places: the DOM order of the slots follows the shelf's order; a slot put
  // in above the viewport shifts the scroll by its height.
  let previous = null;
  for (const key of shelf.order) {
    const { slot } = shelf.slots.get(key);
    const wanted = previous ? previous.nextSibling : shelf.el.firstChild;
    if (slot !== wanted) {
      const wasConnected = slot.isConnected;
      const wasAbove = wasConnected && slot.getBoundingClientRect().bottom <= viewTop;
      shelf.el.insertBefore(slot, wanted);
      const isAbove = slot.getBoundingClientRect().bottom <= viewTop;
      if (!wasConnected && isAbove) shift += slot.offsetHeight;
      else if (wasConnected && wasAbove !== isAbove) shift += (isAbove ? 1 : -1) * slot.offsetHeight;
    }
    previous = slot;
  }
  if (scroller && shift !== 0) {
    applyingScroll.add(mirror.idOf(scroller));
    scroller.scrollTop += shift;
    requestAnimationFrame(() => applyingScroll.delete(mirror.idOf(scroller)));
    trace(`shelf shifted by ${Math.round(shift)}px cards=${shelf.order.length}`);
  }
  // A shelf that grew too long loses the cards farthest from the viewport.
  if (shelf.order.length > SHELF_MAX && scroller) {
    const viewMid = viewTop + scroller.clientHeight / 2;
    const far = [...shelf.order].sort((k1, k2) => {
      const d = (k) => Math.abs(shelf.slots.get(k).slot.getBoundingClientRect().top - viewMid);
      return d(k2) - d(k1);
    }).slice(0, shelf.order.length - SHELF_MAX);
    for (const key of far) {
      const { slot } = shelf.slots.get(key);
      const above = slot.getBoundingClientRect().bottom <= viewTop;
      const h = slot.offsetHeight;
      slot.remove();
      shelf.slots.delete(key);
      shelf.order.splice(shelf.order.indexOf(key), 1);
      if (above) scroller.scrollTop -= h;
    }
  }
}

function relayout() {
  relayoutPending = false;
  const lists = new Set();
  for (const row of host.querySelectorAll('[style*="absolute"]')) {
    const list = row.parentElement;
    if (!list || list === host || row.style.position !== 'absolute') continue;
    if (!/^-?\d/.test(row.style.top ?? '')) continue;
    if (getComputedStyle(list).position !== 'relative' && list.style.position !== 'relative') continue;
    lists.add(list);
  }
  for (const list of lists) updateShelf(list);
  diag.lists = lists.size;
  showDiag();
}

/** The shelf a scroller shows, if any. */
function shelfIn(scroller) {
  for (const [, shelf] of shelfEntries()) if (shelf.scroller === scroller && shelf.el.isConnected) return shelf;
  return null;
}
const shelfList = new Set();
function shelfEntries() {
  const out = [];
  for (const list of shelfList) { const shelf = shelves.get(list); if (shelf) out.push([list, shelf]); }
  return out;
}

/** A slot's top inside its scroller's content, in this side's pixels. */
function slotTopIn(scroller, slot) {
  return slot.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * A scroll position here, said in the page's pixels: the card at that
 * position and the distance into it, carried over to the page's last top
 * for the same card. The heights differ between the two sides; the card
 * does not.
 */
function toPagePixels(scroller, y) {
  const shelf = shelfIn(scroller);
  if (!shelf || !shelf.order.length) return y;
  let at = null;
  for (const key of shelf.order) {
    const entry = shelf.slots.get(key);
    if (slotTopIn(scroller, entry.slot) <= y) at = entry; else break;
  }
  at ??= shelf.slots.get(shelf.order[0]);
  return Math.max(0, at.top + (y - slotTopIn(scroller, at.slot)));
}

/** The page's scroll position, said in this side's pixels; null when no card places it. */
function toPanelPixels(scroller, pageY) {
  const shelf = shelfIn(scroller);
  if (!shelf || !shelf.order.length) return null;
  let at = null;
  for (const key of shelf.order) {
    const entry = shelf.slots.get(key);
    if (entry.top <= pageY) at = entry; else break;
  }
  at ??= shelf.slots.get(shelf.order[0]);
  return Math.max(0, slotTopIn(scroller, at.slot) + (pageY - at.top));
}

function showDiag() {
  $('status').title = `${diag.lists} ${diag.lists === 1 ? 'shelf' : 'shelves'}, ${diag.skipped} skipped ops`;
}
function scheduleRelayout() {
  if (relayoutPending) return;
  relayoutPending = true;
  requestAnimationFrame(() => relayout());
}

/**
 * The scroll position here belongs to the person. The page's position is
 * taken ONCE, with the snapshot, so the panel opens where the page is;
 * after that nothing on the page moves it: not a new thesis at the top,
 * not FOMO's own scrolling, not the page's echo of a position the panel
 * sent. Reading a feed that jumps is not reading.
 */
const applyingScroll = new Set();
function applyScroll(i, top) {
  const el = mirror.registry.get(i);
  if (!el || el.nodeType !== 1) return;
  const pageY = Number(top);
  if (!Number.isFinite(pageY)) return;
  const y = toPanelPixels(el, pageY) ?? pageY;
  if (Math.abs(el.scrollTop - y) < 2) return;
  applyingScroll.add(i);
  el.scrollTop = y;
  requestAnimationFrame(() => applyingScroll.delete(i));
}

function onMessage(msg) {
  if (msg?.type === 'snapshot') {
    clearTimeout(state.snapshotTimer);
    state.snapshotTimer = null;
    applySheets(msg.sheets);
    mirror.snapshot(host, msg.tree);
    shelfList.clear();
    relayout();
    // The lists start where the page has them, once the rows have their height.
    requestAnimationFrame(() => { for (const s of msg.scrolls ?? []) applyScroll(s.i, s.top); });
    if (msg.tree) setStatus('feed.status.live', 'ok');
    else {
      setStatus('feed.status.noBlock', 'bad');
      if (msg.why) { const el = $('status'); el.textContent = `${t('feed.status.noBlock')} · ${msg.why}`; el.title = msg.why; }
      // Another FOMO tab may show it, or this one may again; look in a while.
      if (!state.retry) state.retry = setTimeout(() => { state.retry = null; connect().catch(() => scheduleRetry()); }, NO_BLOCK_RETRY_MS);
    }
  } else if (msg?.type === 'ops') {
    // Changes, then the shelves at once: no frame in between shows the
    // page's containers with new contents in old places.
    diag.skipped += mirror.apply(msg.ops);
    relayout();
  }
}

function disconnect() {
  clearTimeout(state.snapshotTimer);
  state.snapshotTimer = null;
  if (state.port) {
    try { state.port.disconnect(); } catch { /* already gone */ }
  }
  state.port = null;
  state.tabId = null;
}

function scheduleRetry() {
  if (state.retry) return;
  state.retry = setTimeout(() => { state.retry = null; connect().catch(() => scheduleRetry()); }, RETRY_MS);
}

/** Asks a tab whether it shows the block; a tab without our script does not answer. */
async function hasBlock(tab) {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'feed.status' }),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return res?.result?.block === true ? 'yes' : res ? 'no' : 'silent';
  } catch {
    return 'silent';
  }
}

/**
 * Connects to an open FOMO tab: one that shows the block if there is one,
 * else one that answers at all, else the next in turn.
 */
async function connect() {
  disconnect();
  const tabs = await chrome.tabs.query({ url: FOMO_URLS });
  if (!tabs.length) {
    setStatus('feed.status.noTab', 'bad');
    mirror.snapshot(host, null);
    scheduleRetry();
    return;
  }
  const answers = await Promise.all(tabs.map(hasBlock));
  const withBlock = tabs.filter((_, i) => answers[i] === 'yes');
  const awake = tabs.filter((_, i) => answers[i] !== 'silent');
  const pool = withBlock.length ? withBlock : awake.length ? awake : tabs;
  const tab = pool[state.turn % pool.length];
  state.turn += 1;
  setStatus('feed.status.connecting');
  const port = chrome.tabs.connect(tab.id, { name: MIRROR_PORT });
  state.port = port;
  state.tabId = tab.id;
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    if (state.port !== port) return;
    state.port = null;
    state.tabId = null;
    setStatus('feed.status.connecting');
    scheduleRetry();
  });
  // A tab whose content script is not there (opened before an update) keeps
  // the port open and says nothing; move on to the next tab after a while.
  state.snapshotTimer = setTimeout(() => {
    if (state.port === port) { disconnect(); scheduleRetry(); }
  }, SNAPSHOT_TIMEOUT_MS);
}

function post(msg) {
  if (!state.port) return;
  try { state.port.postMessage(msg); } catch { /* the port closed; onDisconnect follows */ }
}

// A click anywhere in the mirror is a click in the tab. Links do not
// navigate here; the tab's router handles them there.
host.addEventListener('click', (ev) => {
  ev.preventDefault();
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target) return;
  const buyButton = target.closest('.lc-feedbuy button');
  if (buyButton) {
    const i = idBehind(buyButton);
    if (i) post({ type: 'buy', i });
    return;
  }
  const i = idBehind(target);
  if (i) post({ type: 'click', i });
});

// Scrolling a list here scrolls it there, so FOMO's virtualised lists render
// the rows this panel is looking at. Only scrolling the PERSON started goes
// across: a wheel, a finger, a key, a grab of the scrollbar. The panel's own
// adjustments (keeping the card being read in place while rows move) never
// do, or the page would answer with new positions, the panel would adjust
// again, and the two would chase each other. One message per pause of
// 120ms, with the position by then, and not the same position twice.
let userScrollUntil = 0;
const USER_SCROLL_MS = 400;
const markUserScroll = () => { userScrollUntil = Date.now() + USER_SCROLL_MS; };
host.addEventListener('wheel', markUserScroll, { passive: true, capture: true });
host.addEventListener('touchmove', markUserScroll, { passive: true, capture: true });
host.addEventListener('pointerdown', markUserScroll, { passive: true, capture: true });
host.addEventListener('keydown', (ev) => { if (/^(Arrow|Page|Home|End|Space)/.test(ev.key) || ev.key === ' ') markUserScroll(); }, true);

const forwardTimers = new Map();
const forwardedTop = new Map();
host.addEventListener('scroll', (ev) => {
  const el = ev.target;
  if (!(el instanceof Element)) return;
  if (Date.now() > userScrollUntil) return;
  const i = mirror.idOf(el);
  if (!i) return;
  clearTimeout(forwardTimers.get(i));
  forwardTimers.set(i, setTimeout(() => {
    forwardTimers.delete(i);
    const top = Math.round(toPagePixels(el, el.scrollTop));
    if (Math.abs((forwardedTop.get(i) ?? -1e9) - top) < 4) return;
    forwardedTop.set(i, top);
    post({ type: 'scroll', i, top });
  }, 120));
}, true);

$('refresh').addEventListener('click', () => {
  if (state.port) post({ type: 'refresh' });
  else connect().catch(() => scheduleRetry());
});

$('open-fomo').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: 'https://fomo.family/', pinned: true, active: false });
  } catch { /* shown by the status on the next try */ }
  clearTimeout(state.retry);
  state.retry = null;
  setTimeout(() => connect().catch(() => scheduleRetry()), SNAPSHOT_TIMEOUT_MS);
});

// A FOMO tab that closes or reloads takes the port with it; onDisconnect
// reconnects. A FOMO tab that opens while none was there is picked up by the retry.
connect().catch(() => scheduleRetry());
