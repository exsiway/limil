// MAIN-world entry point. Injected on fomo.family at document_start so the
// transport can be patched before the Privy SDK takes a reference to its iframe.
//
// There is no network request here: the MAIN world runs under the page's CSP,
// so all network I/O goes to the service worker through the ISOLATED world.
//
// THIS WORLD IS THE PAGE'S REALM. Everything below shares a JavaScript heap
// with fomo.family's own bundle and with anything it loads. Two consequences
// shape the code:
//
//   1. The channel to the ISOLATED world is a private MessagePort
//      (shared/bus.js), not window.postMessage: the page cannot read it and
//      cannot speak on it. The port is taken before the page's first line runs.
//   2. Nothing here DECIDES to sign a delegation, a grant or a disconnect.
//      Those commands arrive with a one-time intent the service worker issued
//      for exactly these parameters (background/intent.js), and the worker is
//      asked to spend it before Privy is asked for anything. A page that
//      somehow reached these handlers could still not make them sign what the
//      worker did not plan.

import { createChannel, MAIN, ISO } from '../shared/bus.js';
import * as privy from './privy-bridge.js';
import { sessionPlan } from '../shared/session-health.js';
import * as fomo from './fomo-bridge.js';
import { inspectSample } from './sample.js';
import { prepareSwap } from './swap-exec.js';
import { CASH_TOKEN_ID, SIMPLE_7702_ACCOUNT, delegateFor } from '../shared/chains.js';
import { extractTokenBalance, normalizeBalance } from '../shared/balances.js';
import { amountFromPercent } from '../shared/orders.js';
import { signAuthorization } from './authorization.js';
import { disconnectAccount } from './disconnect.js';
import * as chartBridge from './chart-bridge.js';
import { grantSessionOnChain } from './grant-session.js';
import * as awake from './awake.js';
import * as scrollScale from './scroll-scale.js';

// Before the page's first line: the visibility getters the side panel may
// switch (awake.js), and the scroll-position shadow for a list whose rows
// the extension places (scroll-scale.js). Neither changes anything until asked.
awake.install();
scrollScale.install();

/**
 * How many on-chain operations are in flight right now.
 *
 * While at least one is running the page must NOT be reloaded: the session
 * watchdog below does that itself, and a reload between signing and sending,
 * or between sending and the answer to the runner, leaves the operation with
 * the bundler and the order watched, which is exactly how a position gets sold
 * twice.
 */
let busyOps = 0;
async function withBusy(fn) {
  busyOps += 1;
  try {
    return await fn();
  } finally {
    busyOps -= 1;
  }
}

const lower = (v) => String(v ?? '').toLowerCase();
const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v ?? ''));

/** The worker's confirmation that it planned THIS operation. Throws otherwise. */
async function spendIntent(kind, id, params) {
  if (typeof id !== 'string' || !id) {
    throw new Error(`${kind}: no intent from the extension, this operation can only be started by the extension itself`);
  }
  await callIsolated('bg', { type: 'intent.consume', payload: { id, kind, params } });
}

// The bus is opened FIRST: the port handover is a task queued by the ISOLATED
// world during the same injection pass, and the listener that takes it must
// exist before that task runs. Everything else in this module can wait a tick.
const callIsolated = createChannel({
  self: MAIN,
  peer: ISO,
  handlers: {
    // The one question the panel must answer BEFORE an order is placed: will
    // auto-execution work at all.
    'privy.canSign': ({ sender } = {}) => privy.canSign(sender),
    // Wallet address and method of the captured envelope sample.
    'gate.inspect': () => inspectSample(),

    /**
     * Signs a 7702 authorization.
     *
     * The most dangerous command here. A signed live authorization changes the
     * CODE of the account, and its effect is bounded by nothing: delegated to a
     * foreign contract, the wallet is gone with grants and keys meaning nothing.
     * Hence two locks on top of the private bus: the delegate must be OUR
     * contract on this chain (the only other admissible delegate, FOMO's own,
     * is reached through session.disconnect and nowhere else), and a live one
     * is signed only against an intent the worker issued for this very
     * (sender, chain, delegate).
     */
    'gate.signAuthorization': async ({ sender, chainId, delegate, nonce, allowLive = false, intent = null }) => {
      const ours = delegateFor(chainId);
      if (!isAddress(sender) || !isAddress(delegate)) throw new Error('sender and delegate must be addresses');
      if (lower(delegate) !== lower(ours) && lower(delegate) !== lower(SIMPLE_7702_ACCOUNT)) {
        throw new Error(`delegate ${delegate} is neither the limil contract on chain ${chainId} nor FOMO's, refused`);
      }
      if (allowLive) {
        if (!ours || lower(delegate) !== lower(ours)) {
          throw new Error('a live authorization here may only delegate to the limil contract; returning the wallet to FOMO goes through session.disconnect');
        }
        await spendIntent('delegate', intent, { sender, chainId, delegate });
      }
      return signAuthorization({
        sender,
        chainId,
        delegate,
        nonce,
        allowLive,
        callBackground: (type, payload) => callIsolated('bg', { type, payload }),
      });
    },

    // Disconnect: revoke the key and return the delegate to FOMO's contract.
    // Two operations: the authorization is applied before validation, and in
    // the return operation `revokeSession` no longer exists. Started only by
    // the popup, which issues the intent when the person turns orders off.
    'session.disconnect': async ({ sender, chainId, key = null, keys = null, intent = null }) => {
      const list = Array.isArray(keys) ? keys : [];
      await spendIntent('disconnect', intent, { sender, chainId, key: key ?? null, keys: list });
      return withBusy(() => disconnectAccount({
        sender,
        chainId,
        key,
        keys: list,
        callBackground: (type, payload) => callIsolated('bg', { type, payload }),
      }));
    },

    // Session key grant. Goes as a UserOperation because the FOMO wallet
    // cannot pay gas: native value sent to it is wrapped into WETH by the app.
    // The parameters are the worker's plan, and the worker confirms them here
    // before the owner is asked to sign.
    'session.grant': async ({
      sender, chainId, key, limits, tokenCaps = [], guard = null, swap = null, targets, selectors, feeRecipients,
      revokeFirst = [], revokeOnly = false, send = false, authorization = null, intent = null,
    }) => {
      if (!isAddress(sender) || !isAddress(key)) throw new Error('sender and key must be addresses');
      if (!Array.isArray(targets) || !Array.isArray(selectors) || targets.length !== selectors.length) {
        throw new Error('targets and selectors must be parallel arrays');
      }
      if (!guard || !isAddress(guard.guard) || !isAddress(guard.settlementToken) || !isAddress(guard.depository)) {
        throw new Error('the grant must name the output guard template');
      }
      if (!swap || !isAddress(swap.router) || !/^0x[0-9a-fA-F]{8}$/.test(String(swap.selector ?? ''))) {
        throw new Error('the grant must name the swap router and its selector');
      }
      // Every field the worker planned is part of the intent: a page that
      // changed a cap, dropped the guard or added a key to revoke would not
      // hash the same and the intent would not be spent.
      const params = {
        sender, chainId, key, limits, tokenCaps, guard, swap, targets, selectors,
        feeRecipients: feeRecipients ?? [], revokeFirst: Array.isArray(revokeFirst) ? revokeFirst : [],
        revokeOnly: revokeOnly === true,
      };
      await spendIntent('grant', intent, params);
      return withBusy(() => grantSessionOnChain({
        ...params,
        send,
        authorization,
        callBackground: (type, payload) => callIsolated('bg', { type, payload }),
      }));
    },

    // Live price from the chart feed.
    'chart.live': () => chartBridge.livePrice(),
    'chart.calibrate': (params) => chartBridge.calibrate(params),
    'chart.sync': (params) => chartBridge.syncOrders(params),
    'fomo.status': () => fomo.status(),
    // The side panel mirrors this tab: FOMO is to keep loading while the tab is in the background.
    'awake.set': ({ on } = {}) => awake.setAwake(on),
    // A sample another tab stored: taken when newer than this tab's own.
    'sample.adopt': ({ sample } = {}) => privy.adoptSample(sample),
    'awake.status': () => awake.status(),
    'fomo.quote': (params) => fomo.requestQuote(params),
    'fomo.balances': (params) => fomo.userBalances(params),

    /**
     * Quote (and optionally assembly) of a trade. The runner uses it with
     * `sign: false` as its price sample; the amount may be given as a share
     * of the balance instead of an absolute number.
     */
    async 'swap.prepare'(params) {
      const { sender, chainId, tokenAddress, percent } = params;
      let { inTokenId, outTokenId, amount } = params;

      if (!amount && tokenAddress) {
        const uuid = fomo.userId();
        // The id comes from the addresses of their own requests, so what has
        // to happen is the page's first balances request, not a navigation.
        if (!uuid) {
          throw new Error('user id not captured yet, it is taken from the page\'s first balances request. Wait a couple of seconds after the page loads.');
        }
        const balances = await fomo.userBalances({ uuid });
        const entry = normalizeBalance(extractTokenBalance(balances, tokenAddress));
        if (!entry) throw new Error(`no position for ${tokenAddress} in the balances`);
        amount = amountFromPercent(entry.balance ?? entry.amount, Number(percent)).toString();
        inTokenId = entry.tokenId ?? `${tokenAddress}:${chainId}`;
        outTokenId = CASH_TOKEN_ID;
      }

      return prepareSwap({
        ...params,
        inTokenId,
        outTokenId,
        amount,
        callBackground: (type, payload) => callIsolated('bg', { type, payload }),
      });
    },

    /**
     * Execution of an order by the runner.
     *
     * Separate from swap.prepare on purpose: there a person signs through
     * Privy, here the session key living in the service worker signs. The
     * private part never comes here: the operation goes out, a signature comes
     * back, and the page never sees the key. The whole cycle runs in one
     * round, because an assembled operation lives for minutes.
     */
    async 'swap.execute'(params) {
      return withBusy(() => prepareSwap({
        ...params,
        sign: true,
        send: true,
        // The receipt is awaited for less than the bus lives towards the
        // runner: it needs `sent: true`, and it checks the balance itself.
        receiptTimeoutMs: 90_000,
        // The OPERATION is handed over, not a hash: the worker computes the
        // hash itself and checks the contents against the order. A hash sent
        // from here would rightly be refused, foreign code runs in this world.
        signer: async ({ userOp, chainId }) => callIsolated('bg', {
          type: 'runner.sign',
          payload: { userOp, chainId, orderId: params.orderId },
        }),
        callBackground: (type, payload) => callIsolated('bg', { type, payload }),
      }));
    },
  },
});

privy.install();
// The TradingView chart is intercepted BEFORE the app bundle: later the
// constructor is already held by reference and cannot be replaced.
chartBridge.install({
  // Symbol change: the panel re-reads the orders and asks for a redraw.
  onSymbolChange: () => {
    callIsolated('chartSymbolChanged', {}).catch(() => { /* the panel need not listen */ });
  },
  // The live price crossed an order level, wake the runner at once.
  onCross: (orderId) => {
    callIsolated('orderCrossed', { orderId }).catch(() => { /* the panel may be gone */ });
  },
  // Heartbeat: while it beats the runner need not poll quotes on a schedule.
  onBeat: (info) => {
    callIsolated('priceAlive', info).catch(() => { /* the panel may be gone */ });
  },
});
// As soon as the FOMO session is captured the panel fetches the balance on
// its own; until then it shows "no data".
fomo.install({
  onCapture: (info) => {
    callIsolated('fomoReady', info).catch(() => { /* the panel need not listen */ });
  },
  // The page fetched balances itself, hand its response to the panel instead
  // of making a request of our own.
  onBalances: (json) => {
    callIsolated('fomoBalances', json).catch(() => { /* the panel may be gone */ });
  },
  // Market cap from their own responses: the order is captioned as a level.
  onMarketCap: (json) => {
    callIsolated('fomoToken', json).catch(() => { /* the panel may be gone */ });
  },
});

// The captured sample goes to chrome.storage at once: it is captured once and
// needed later, after a page reload. It travels over the private port only.
privy.onLog((entry) => {
  // The trace of the exchange with the iframe goes to the popup's journal.
  if (entry.level === 'trace') {
    callIsolated('bg', { type: 'runner.note', payload: { text: entry.text } }).catch(() => {});
    return;
  }
  // A discarded envelope is discarded from storage too. Otherwise the copy in
  // chrome.storage came back on the next page load and the refusal repeated
  // forever, whatever the person did in FOMO.
  if (entry.level === 'stale') {
    callIsolated('bg', { type: 'sample.clear' })
      .catch(() => { /* retried on the next refusal */ });
    return;
  }
  // 'capture', taken with recording on, 'refresh', updated on its own. Both
  // are saved: storage must hold the FRESHEST envelope, or a reload brings
  // back an old one with an expired token.
  if (entry.level !== 'capture' && entry.level !== 'refresh') return;
  const sample = privy.getSample();
  if (!sample) return;
  callIsolated('bg', { type: 'sample.save', payload: { sample } })
    .catch(() => { /* saving the sample must not break the page */ });
});

/**
 * When the page was last reloaded for the sake of the session.
 *
 * Kept in sessionStorage, not in a variable: the variable would be reset by
 * the very reload it is meant to limit, and the cooldown never took effect.
 */
const RELOAD_MARK = 'limil.sessionReloadAt';
function readReloadAt() {
  try { return Number(sessionStorage.getItem(RELOAD_MARK) ?? 0) || 0; } catch { return 0; }
}
function writeReloadAt(at) {
  try { sessionStorage.setItem(RELOAD_MARK, String(at)); } catch { /* storage closed */ }
}

/**
 * FOMO session watchdog: fixes the session BEFORE it kills an order.
 *
 * Two tokens, easily confused. The Privy envelope signs operations and
 * refreshes itself. The header for their API and the bundler is captured from
 * requests of THEIR page: while the page is idle no fresh one appears.
 *
 * Remedies go from cheap to blunt: substitute a token of the same family, and
 * if there is none, reload the page, because a new one is issued by their
 * backend to their app. The reload is behind a cooldown: a logout is not cured
 * by it, and looping would not even let the person log in.
 */
function guardSession() {
  const plan = sessionPlan({
    header: fomo.sessionToken(),
    privyToken: privy.freshestKnownToken(),
    lastReloadAt: readReloadAt(),
  });
  if (plan.action === 'substitute') {
    const ok = fomo.substituteSessionToken(privy.freshestKnownToken());
    if (ok) return;
    plan.action = 'reload';
  }
  if (plan.action !== 'reload') return;
  // A trade is in flight, the reload waits for the next tick: an operation
  // with the bundler and an order still watched costs more than a session
  // stale for one more minute.
  if (busyOps > 0) return;
  writeReloadAt(Date.now());
  location.reload();
}

setInterval(() => {
  try {
    const result = privy.ensureFreshToken();
    if (result?.changed) {
      callIsolated('bg', { type: 'sample.save', payload: { sample: privy.getSample() } })
        .catch(() => { /* saving must not break the page */ });
    }
  } catch { /* a background task must not break anything */ }
  try {
    guardSession();
  } catch { /* the session watchdog must not break the page */ }
}, 30_000);

// Restore the sample from the previous session, if there is one.
callIsolated('bg', { type: 'sample.load' })
  .then((sample) => { if (sample) privy.loadSample(sample); })
  .catch(() => { /* no sample yet on the first run */ });
