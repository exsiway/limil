// ISOLATED world: the only place that sees both the page and chrome.*. It
// relays messages between the MAIN world, the service worker and the popup,
// and hosts the order panel and the quick-buy buttons, which need the DOM but
// not the page's JS.

import { createChannel, MAIN, ISO } from '../shared/bus.js';
import * as limitUi from './limit-ui.js';
import * as feedBuy from './feed-buy.js';
import * as feedMirror from './feed-mirror.js';
import { initLocale, onLocaleChange, setLocale, t } from '../shared/i18n.js';

/** Bridge to the service worker: network and storage live only there. */
const bg = (type, payload) => chrome.runtime.sendMessage({ type, payload }).then((res) => {
  if (res?.error) throw new Error(res.error);
  return res?.result;
});

/**
 * What the MAIN world is ALLOWED to ask the service worker.
 *
 * This is a trust boundary, kept even though the bus itself is now private
 * (shared/bus.js: a MessagePort the page never sees). The MAIN world runs in
 * the page's realm, and a defence that rests on one property of one channel
 * is one property away from nothing. So the list stays an allow-list: a new
 * command is UNAVAILABLE to the MAIN world by default, and nothing here hands
 * out a right the worker does not check again on its own side.
 *
 * Deliberately absent: `settings.*`, `orders.*` (the MAIN world places no
 * orders), `intent.issue` (only the worker and the
 * popup mint intents) and all runner control except `runner.sign`, which is
 * protected by the ticket and the verification of the operation against the
 * order (shared/runner-verify.js).
 */
const MAIN_MAY_ASK = new Set([
  // Chain reads: MAIN cannot reach RPC under the page CSP.
  'rpc.getNonce',
  'rpc.isValidSignature',
  'rpc.getTransactionCount',
  'rpc.getCode',
  'rpc.tokenBalance',
  // Solana reads for the transaction guard: account states and a simulation.
  'solana.accounts',
  'solana.simulate',
  'solana.signatureStatus',
  // Privy envelope sample: captured on the page, stored here.
  'sample.save',
  'sample.load',
  'sample.clear',
  // Session key address and the sample window.
  'runner.info',
  // Runner signature, behind the ticket, see above.
  'runner.sign',
  // Nudge from the price watcher: asks the worker to check THIS order now.
  // It is not free of consequence: the worker runs one tick for that order
  // with confirmations: 1, and the order executes if the quote confirms the
  // target. What the page cannot do through it is name a price, an amount or
  // a wallet; the tick reads the stored order and quotes for itself.
  'runner.nudge',
  // Watcher heartbeat: reports that the price is being watched.
  'runner.watchdog',
  // A line for the journal: text only, nothing is executed.
  'runner.note',
  'runner.sending',
  // Spending a one-time intent the worker issued: consuming needs the id,
  // and a spent intent grants nothing further.
  'intent.consume',
]);

// The channel is opened FIRST, at document_start: this world creates the
// MessageChannel and hands one port to the MAIN world in the same injection
// pass, before the page's first script can run.
const callMain = createChannel({
  self: ISO,
  peer: MAIN,
  handlers: {
    // The MAIN world cannot reach the network under the page CSP, we do it
    // for it, but only for the allowed commands.
    bg: ({ type, payload }) => {
      if (!MAIN_MAY_ASK.has(type)) {
        // Loud and with the command name: a silent refusal on this boundary
        // takes hours to debug.
        throw new Error(t('bg.pageDenied', { type }));
      }
      return bg(type, payload);
    },

    // Watcher heartbeat goes to the service worker, which decides whether a
    // quote poll is needed. The panel gets the same price: the level is
    // computed from it rather than from a lagging market cap.
    priceAlive: (info) => {
      bg('runner.watchdog', info).catch(() => { /* the worker may be asleep */ });
      limitUi.applyLivePrice(info?.price);
      return true;
    },

    // The price crossed a level: ask the worker to check THIS order now,
    // without waiting for the minute alarm.
    orderCrossed: async ({ orderId }) => {
      try {
        const res = await bg('runner.nudge', { orderId });
        // A quote came back, i.e. we have "output now" and "price now" as a
        // pair. Refine the level: the drawn one may come from a lagging cap.
        const entry = (res?.entries ?? []).find((e) => e.orderId === orderId);
        const median = entry?.detail?.median;
        if (median) callMain('chart.calibrate', { orderId, median }).catch(() => {});
      } catch {
        // The runner may be off, not the watcher's concern.
      }
      return true;
    },

    chartSymbolChanged: () => {
      // The previous token's price must not become the new one's level.
      limitUi.resetLivePrice();
      limitUi.refreshChartLines();
      return true;
    },

    fomoReady: () => {
      limitUi.refreshContext().catch(() => { /* shown in the panel itself */ });
      return true;
    },

    // The page fetched balances itself; take them for free. The MAIN world
    // runs in the page's realm, so what arrives here is UNTRUSTED: without a
    // `source` it refreshes the displayed amounts only. Cancelling orders and
    // learning the wallet addresses happen on balances this world asked for
    // itself (limitUi.refreshContext), never on pushed ones.
    fomoBalances: (json) => {
      limitUi.applyBalances(json);
      return true;
    },

    // A token response, look for the market cap in it.
    fomoToken: (json) => {
      limitUi.applyTokenInfo(json);
      return true;
    },
  },
});

limitUi.attachBackground(bg);
feedBuy.attachBackground(bg);
// Interface language: asked from the worker once (this world cannot read
// extension storage), then followed through `locale.changed` messages.
initLocale({ load: () => bg('settings.get') }).then(() => { limitUi.rerender(); feedBuy.rerender(); }).catch(() => {});
onLocaleChange(() => { limitUi.rerender(); feedBuy.rerender(); });
// The panel needs the FOMO API, which lives in the MAIN world with the
// captured session headers.
limitUi.attachMain(callMain);
feedBuy.attachMain(callMain);
feedMirror.attachMain(callMain);
feedMirror.attachBackground(bg);

/**
 * How long to wait for the MAIN world on long commands.
 *
 * The bus default is two minutes, exactly as long as the page waits for the
 * bundler receipt. With a quote and a signature ahead of it the execution did
 * not fit, and an operation ALREADY with the bundler came back to the runner
 * as a timeout, i.e. as a failure that keeps the order watched and lets it
 * fire a second time. Disconnecting is two operations and needs even more.
 */
const PAGE_TIMEOUTS = {
  'swap.execute': 300_000,
  'session.grant': 360_000,
  'session.disconnect': 360_000,
};

/** Popup commands executed right here, over the page DOM. */
const pageHandlers = {
  'ui.status': () => limitUi.status(),
  // Build stamp of the bundle running IN THIS TAB. The service worker asks
  // for it after a self-reload (background/selfupdate.js): a tab that answers
  // with another stamp, or does not answer, still runs the old bundle and is
  // reloaded. It must be answered HERE, over chrome.runtime.onMessage, a
  // handler on the MessagePort bus to the MAIN world (shared/bus.js) never
  // sees the worker's message, and the tab was reloaded on every worker
  // start as "stale".
  'ui.build': () => {
    const stamp = typeof __LIMIL_BUILD__ === 'string' ? __LIMIL_BUILD__ : 'no stamp';
    // A trace that survives a reload of this tab: when the worker asked and
    // what this bundle answered. Read it in DevTools: sessionStorage['limil.build'].
    try { sessionStorage.setItem('limil.build', `${stamp} asked ${new Date().toISOString()}`); } catch { /* storage closed */ }
    return stamp;
  },
  // The worker says why it is about to reload this tab; kept in the tab's
  // sessionStorage so the reason is still there after the reload.
  'ui.note': ({ text } = {}) => {
    try { sessionStorage.setItem('limil.lastReload', `${String(text ?? '')} at ${new Date().toISOString()}`); } catch { /* storage closed */ }
    return true;
  },
  'ui.refresh': () => limitUi.refreshContext(),
  // Storage lives in the worker and is closed to this world; the worker says
  // when the order list or the interface language changed.
  'orders.changed': () => limitUi.reloadOrdersFromStorage(),
  'locale.changed': ({ uiLang } = {}) => { if (uiLang) setLocale(uiLang); return true; },
  // Another tab refreshed the envelope sample; this tab adopts it if it is newer than its own.
  'sample.changed': ({ sample } = {}) => callMain('sample.adopt', { sample }),
  'ui.start': (opts) => limitUi.start(opts),
  'ui.stop': () => limitUi.stop(),
  // Quick buy from the feed: switch and amounts from the popup.
  'quick.update': (settings) => feedBuy.update(settings ?? {}),
  'quick.status': () => feedBuy.status(),
  // The side panel's mirror of the feed block: how many panels, is the block there.
  'feed.status': () => feedMirror.status(),
};

// The side panel connects over a port when it opens; nothing runs until then.
feedMirror.install();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const local = pageHandlers[msg?.type];
  if (local) {
    Promise.resolve()
      .then(() => local(msg.payload ?? {}))
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }

  // Everything prefixed "page." is addressed to the MAIN world: the Privy
  // provider lives there. Only the extension's own contexts (worker, popup)
  // can send a runtime message, so this is not a page-reachable path.
  if (msg?.type?.startsWith('page.')) {
    const type = msg.type.slice('page.'.length);
    callMain(type, msg.payload, PAGE_TIMEOUTS[type])
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }
  return false;
});

/**
 * The content script starts at document_start, when document.body and
 * document.head are still null. Anything that touches the DOM must wait, or
 * mounting fails with a TypeError and the panel never appears.
 */
function whenDomReady() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

// The bundle stamp on the document: which build this tab runs, readable
// without the popup (DevTools, or a script on the page).
try { document.documentElement.dataset.limilBuild = typeof __LIMIL_BUILD__ === 'string' ? __LIMIL_BUILD__ : 'no stamp'; } catch { /* no root yet */ }

Promise.all([bg('settings.get').catch(() => ({})), whenDomReady()])
  .then(([settings]) => {
    // Collapsed state and slippage survive a page reload.
    limitUi.restoreState(settings ?? {});
    // The order panel only with the popup switch on: without the switch
    // there is neither a panel nor a wallet delegation.
    if (settings?.ordersEnabled === true) limitUi.start();
    // Quick-buy buttons in the feed: off until switched on in the popup.
    if (settings?.quickBuyEnabled === true) {
      try { feedBuy.start(settings); } catch (err) { console.warn('[limil] quick buy did not start:', err); }
    }
  })
  .catch((err) => {
    console.warn('[limil] start on the page failed:', err);
  });
