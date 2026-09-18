// The feed mirror: the FOMO tab's side.
//
// The side panel (panel/panel.js) connects to this tab over a port and asks
// for FOMO's Alerts / Tokens / Leaderboard / Feed block. This module finds
// the block, sends it once as a tree and then as deltas from a
// MutationObserver, and takes three commands back: a click on an element of
// the block, a scroll of one of its lists, and a press on one of the quick-
// buy buttons. The serialisation and the filter live in
// shared/mirror-tree.js; here is only what needs the DOM and chrome.*.
//
// What the panel may do through this port is deliberately narrow. A click
// lands on an element of the block and nowhere else. A scroll sets scrollTop.
// A press goes to feed-buy.js, which refuses anything that is not a button
// it mounted itself; the buy then runs the same code as a real press. The
// port is accepted from an extension page only: a content script or a web
// page cannot open it.

import { BLOCK_TABS, MIRROR_PORT, mutationsToOps, serializeNode } from '../shared/mirror-tree.js';
import * as feedBuy from './feed-buy.js';

/** The MAIN world: FOMO's page must keep loading while a panel mirrors it (main/awake.js). */
let callMain = null;
export function attachMain(fn) { callMain = fn; }
/** The worker: a line for the journal when the block is not found. */
let callBackground = null;
export function attachBackground(fn) { callBackground = fn; }
function keepAwake(on) {
  callMain?.('awake.set', { on }).catch(() => { /* the page decides what it shows */ });
}

/** The block is taller than its tab strip; this tells the two apart. */
const ROOT_MIN_HEIGHT = 200;
/** The block is a column; anything wider is the page around it, not the block. */
const ROOT_MAX_WIDTH = 600;
/** How many of the four tabs a candidate must hold: one may be missing in a layout, two is not the block. */
const ROOT_MIN_TABS = 3;
/** After the page re-renders around the block, how long to wait before looking for it again. */
const RESYNC_DELAY_MS = 300;

const LABELS = new Set(BLOCK_TABS);

// Ids: a node keeps its id for as long as it is in the tree, and the panel
// addresses nodes by it. `byId` is the way back for the three commands.
const ids = new WeakMap();
const byId = new Map();
let counter = 0;
function idOf(node) {
  let id = ids.get(node);
  if (!id) {
    counter += 1;
    id = `n${counter}`;
    ids.set(node, id);
    byId.set(id, node);
  }
  return id;
}
const hasId = (node) => ids.has(node);
function forget(node) {
  const id = ids.get(node);
  if (id) { ids.delete(node); byId.delete(id); }
}

const state = {
  /** @type {Set<chrome.runtime.Port>} */
  ports: new Set(),
  /** @type {Element|null} */
  root: null,
  observer: null,
  pageWatch: null,
  resyncTimer: null,
  /** When the collapsed column was last expanded for a panel. */
  expandedAt: 0,
};

/**
 * The block: the nearest ancestor of the tab buttons that holds all of them
 * and has the height of a list, not of a strip. Null when the page does not
 * show it (logged out, a narrow layout, a route without it).
 */
function findRoot() {
  const buttons = [...document.querySelectorAll('button')].filter((b) => LABELS.has(b.textContent.trim()));
  if (buttons.length < ROOT_MIN_TABS) return null;
  // Other buttons on the page may carry the same words (a clan page has its
  // own "Feed"): what counts is how many of the four a candidate holds, not
  // whether it holds every button that matched.
  const tabsIn = (node) => buttons.filter((b) => node.contains(b)).length;
  // The block by its shape first: the tab strip sits in a header row (the
  // rounded top of the block), and the block is that row's parent, the
  // bordered column with the lists under it. Never higher: a page whose
  // layout puts the four tabs elsewhere must not hand the panel the whole
  // page.
  let best = null;
  for (const button of buttons) {
    const header = button.closest('[class*="rounded-t"]');
    const block = header?.parentElement;
    if (!block || block === document.body || block.children.length < 2) continue;
    if (!/\bborder\b/.test(String(block.className))) continue;
    const n = tabsIn(block);
    if (n >= ROOT_MIN_TABS && (!best || n > best.n)) best = { block, n };
  }
  if (best) return best.block;
  // Otherwise the nearest ancestor of a tab that holds at least three of them
  // and has the height of a list, but never one wider than a column: the
  // page itself is not the block.
  for (const button of buttons) {
    let node = button;
    for (let i = 0; i < 12 && node; i += 1) {
      node = node.parentElement;
      if (!node || node === document.body) break;
      const rect = node.getBoundingClientRect();
      if (rect.width > ROOT_MAX_WIDTH) break;
      if (tabsIn(node) >= ROOT_MIN_TABS && rect.height >= ROOT_MIN_HEIGHT) return node;
    }
  }
  return null;
}

/** FOMO's stylesheets, so the panel draws the block with the same CSS. */
function sheetUrls() {
  const out = [];
  for (const link of document.querySelectorAll('link[rel="stylesheet"][href]')) {
    try {
      const u = new URL(link.href, location.href);
      if (u.protocol === 'https:' && /(^|\.)fomo\.family$/i.test(u.hostname)) out.push(u.href);
    } catch { /* not a URL */ }
  }
  return out;
}

function send(port, msg) {
  try { port.postMessage(msg); } catch { /* the panel closed; onDisconnect follows */ }
}

function broadcast(msg) {
  for (const port of state.ports) send(port, msg);
}

/** Why the block was not found, in a line: for the panel's status and the journal. */
function whyNoBlock() {
  const buttons = [...document.querySelectorAll('button')].filter((b) => LABELS.has(b.textContent.trim()));
  const header = buttons[0]?.closest('[class*="rounded-t"]') ?? null;
  const block = header?.parentElement ?? null;
  const rect = block?.getBoundingClientRect();
  const parts = [
    `tabs=${buttons.length}`,
    `header=${header ? 'yes' : 'no'}`,
    block ? `block=${Math.round(rect.width)}x${Math.round(rect.height)} tabsIn=${buttons.filter((b) => block.contains(b)).length} kids=${block.children.length} class="${String(block.className).slice(0, 40)}"` : 'block=none',
    `collapsed=${document.querySelector('button[aria-label*="expand discovery panel" i]') ? 'yes' : 'no'}`,
    `viewport=${window.innerWidth}x${window.innerHeight}`,
    `path=${location.pathname.slice(0, 40)}`,
  ];
  return parts.join(' ');
}

/** Where the block's lists are scrolled to on the page, so the panel starts where the page is. */
function scrollPositions(root) {
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollTop > 0 && hasId(el)) out.push({ i: idOf(el), top: el.scrollTop });
  }
  return out;
}

function snapshotMessage() {
  const root = state.root;
  if (!root) {
    const why = whyNoBlock();
    callBackground?.('runner.note', { text: `feed block not found: ${why}` }).catch(() => {});
    return { type: 'snapshot', tree: null, sheets: [], reason: 'no-block', why };
  }
  const tree = serializeNode(root, idOf);
  return {
    type: 'snapshot',
    tree,
    sheets: sheetUrls(),
    lang: document.documentElement.lang || 'en',
    scrolls: scrollPositions(root),
  };
}

function observeRoot(root) {
  state.observer?.disconnect();
  state.observer = new MutationObserver((records) => {
    if (!state.root || !state.root.isConnected) { scheduleResync(); return; }
    const ops = mutationsToOps(records, { idOf, hasId, forget });
    if (ops.length) broadcast({ type: 'ops', ops });
  });
  state.observer.observe(root, {
    subtree: true, childList: true, characterData: true, attributes: true,
  });
}

/**
 * Finds the block afresh and sends it to every panel. Called on connect and
 * whenever the page re-rendered around the block (a route change, a login).
 */
/**
 * FOMO's column can be collapsed to a chevron (the block is then not on the
 * page at all). A panel that asks for the block gets the column expanded,
 * once per attempt; the chevron in the panel itself is not forwarded, so
 * the panel cannot collapse it back.
 */
function expandCollapsedColumn() {
  const expand = document.querySelector('button[aria-label*="expand discovery panel" i]');
  if (!expand || state.expandedAt && Date.now() - state.expandedAt < 5000) return false;
  state.expandedAt = Date.now();
  expand.click();
  return true;
}

function resync() {
  state.resyncTimer = null;
  let root = findRoot();
  if (!root && state.ports.size && expandCollapsedColumn()) {
    // The column takes a moment to open; look again then.
    state.resyncTimer = setTimeout(resync, 600);
    root = null;
  }
  if (root === state.root && root?.isConnected) return;
  state.observer?.disconnect();
  state.observer = null;
  byId.clear();
  state.root = root;
  if (root) observeRoot(root);
  broadcast(snapshotMessage());
}

function scheduleResync() {
  if (state.resyncTimer) return;
  state.resyncTimer = setTimeout(resync, RESYNC_DELAY_MS);
}

function start() {
  if (state.pageWatch) return;
  keepAwake(true);
  // The block comes and goes with FOMO's routing; the body is watched for
  // that, coarsely, and the block itself finely (observeRoot).
  state.pageWatch = new MutationObserver(() => {
    if (!state.root || !state.root.isConnected) scheduleResync();
  });
  state.pageWatch.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
  state.root = findRoot();
  if (state.root) observeRoot(state.root);
}

function stop() {
  keepAwake(false);
  state.pageWatch?.disconnect();
  state.pageWatch = null;
  state.observer?.disconnect();
  state.observer = null;
  clearTimeout(state.resyncTimer);
  state.resyncTimer = null;
  state.root = null;
  byId.clear();
}

/** A node of the block, by the id the panel has for it; null for anything else. */
function nodeOf(id) {
  const node = byId.get(String(id ?? ''));
  if (!node || !state.root || !node.isConnected || !state.root.contains(node)) return null;
  return node;
}

/** The commands a panel may send, each bounded to the block. */
const commands = {
  click({ i }) {
    const node = nodeOf(i);
    if (!node || node.nodeType !== 1) return false;
    // The quick-buy row is ours: its buttons are pressed through `buy`, and a
    // click on the row itself does nothing. The chevron that collapses FOMO's
    // column would take the block off the page: not from the panel.
    if (node.closest('.lc-feedbuy')) return false;
    if (node.closest('button[aria-label*="discovery panel" i]')) return false;
    const target = node.closest('button, a, [role="button"], [role="tab"]') ?? node;
    if (!state.root.contains(target)) return false;
    target.click();
    return true;
  },
  scroll({ i, top }) {
    const node = nodeOf(i);
    if (!node || node.nodeType !== 1) return false;
    const y = Number(top);
    if (!Number.isFinite(y) || y < 0) return false;
    node.scrollTop = y;
    // A hidden tab dispatches no scroll events of its own (they belong to
    // the rendering steps it does not get), and FOMO's lists mount rows on
    // that event: sent by hand, so the list follows the panel's scrolling.
    node.dispatchEvent(new Event('scroll'));
    return true;
  },
  buy({ i }) {
    const node = nodeOf(i);
    if (!node || node.nodeType !== 1) return false;
    return feedBuy.press(node);
  },
  refresh(_payload, port) {
    send(port, snapshotMessage());
    return true;
  },
};

/**
 * Whether a port was opened by a page of this extension: the side panel, or
 * the panel page shown as a tab. Chrome describes such a sender by its
 * origin, the extension's own, which a content script (origin: the site's)
 * and a web page (no port at all) cannot present. `sender.tab` is not
 * consulted: Chrome sets it for an extension page shown in a tab too.
 */
export function fromExtensionPage(sender, { runtimeId, baseUrl }) {
  if (!sender || sender.id !== runtimeId) return false;
  const origin = String(baseUrl).replace(/\/$/, '');
  if (typeof sender.origin === 'string') return sender.origin === origin;
  return typeof sender.url === 'string' && sender.url.startsWith(`${origin}/`);
}

export function install() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) return;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== MIRROR_PORT) return;
    if (!fromExtensionPage(port.sender, { runtimeId: chrome.runtime.id, baseUrl: chrome.runtime.getURL('') })) {
      port.disconnect();
      return;
    }
    state.ports.add(port);
    port.onDisconnect.addListener(() => {
      state.ports.delete(port);
      if (!state.ports.size) stop();
    });
    port.onMessage.addListener((msg) => {
      const run = commands[msg?.type];
      if (!run) return;
      try { run(msg, port); } catch { /* a stale id or a detached node; the next delta tells the panel */ }
    });
    start();
    if (!state.root && expandCollapsedColumn()) {
      // Answer when the column has opened, not with "no block" first.
      setTimeout(() => { resync(); }, 600);
      return;
    }
    send(port, snapshotMessage());
  });
}

/** For the popup's status line. */
export function status() {
  return { panels: state.ports.size, block: Boolean(state.root?.isConnected) };
}
