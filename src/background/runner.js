// The runner: alarm, session key and one round over the orders.
//
// Why here and not on the page. Chrome throttles timers in a background tab and
// freezes the tab after a few minutes. `chrome.alarms` is the one clock that
// survives both a sleeping service worker and a frozen tab, so the clock lives
// here and the page carries out instructions.
//
// What lives where:
//
//   session key      here, in chrome.storage; bounded by the contract, which is
//                    what the contract exists for; only the address leaves
//   FOMO headers     on the page, in tab memory: IP-bound and short-lived
//   quote and send   on the page: only it has the headers for their API and bundler
//   signature        here: the session key never enters the page context, where
//                    foreign code runs
//
// The cycle: the alarm wakes us, we decide, the page quotes and assembles, we
// sign, the page sends. The secret never leaves its world.
//
// This runner does not work without an open FOMO tab: without it there is no
// quote and no bundler access. A machine that is on with a tab open is its
// working environment. For a closed laptop there is the daemon (daemon/).

import { privateKeyToAccount } from 'viem/accounts';

import {
  RUNNER_LIMITS,
  limitsWith,
  armState,
  decide,
  interruptedAttempt,
  logEntry,
  positionProvenIntact,
  sendMayHaveHappened,
  runnerGate,
  trimLog, nextToQuote, senderMismatch } from '../shared/runner.js';
import { checkAgainstGrant } from '../shared/grant.js';
import { parseSwapArgs } from '../shared/swap-args.js';
import { ticketValid, verifyOperation } from '../shared/runner-verify.js';
import { shouldTrigger } from '../shared/trigger.js';
import { SESSION_VIEW_ABI, decodeBatch, userOpHash } from '../shared/userop.js';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { ethCall, ethGetCode } from './rpc.js';
// Used inside solanaRpc only: daemon.js imports this module too, and a
// binding read at call time is what keeps that cycle harmless.
import { call as hubCall } from './daemon.js';
import { signedInWallet } from './signedin.js';
import { parseDecimal } from '../shared/swaps.js';
import { chainFromTokenId, isTriggered, sellsLeftWithoutPosition, triggerOf } from '../shared/orders.js';
import { MIRRORED } from '../shared/daemon-api.js';
import { RENEW_BEFORE_MS, grantCovers, planGrant } from '../shared/grant-plan.js';
import { t } from '../shared/i18n.js';
import { CHAINS, RELAY_ROUTER, RELAY_SWAP_SELECTOR, SOLANA_NETWORK_ID, delegateFor, isLegacyDelegate } from '../shared/chains.js';
import { delegateFromCode } from '../shared/authorization.js';
import { ERC20_ABI } from '../shared/userop.js';
import { issueIntent } from './intent.js';
import { loadOrders, mutateOrders } from './orders-store.js';
import { autonomousOn, runnerExecutes } from '../shared/autonomy.js';
import { waitForImpact } from './impact.js';
import { tokenPageUrl } from '../shared/balances.js';
import { checkBuyRoute } from './route-check.js';
import { routeSupported } from '../shared/route-check.js';
import { GUARD_CASH, guardSpecFor } from '../shared/output-guard.js';
import { DEFAULT_MAX_IMPACT_BPS } from '../shared/impact.js';

const ALARM = 'limil.runner';
const STORAGE_KEY = 'runner';
/** The private key is stored SEPARATELY from the rest of the state: it is never handed out. */
const SECRET_KEY = 'runner.secret';
/**
 * The signing ticket has its own storage key. As a field inside `state` its
 * spending would be lost: `signForRunner` would set `used: true` in its copy
 * of the state while `tick()` wrote back its own copy, taken before the
 * signature, with `used: false`. A separate key removes the whole class of
 * lost updates: the ticket does not share a writer with the rest of the state.
 */
const TICKET_KEY = 'runner.ticket';
const ATTEMPT_KEY = 'runner.attempt';

async function readState() {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  return bag[STORAGE_KEY] ?? {
    armed: false,
    armedUntil: 0,
    sessionKeyAddress: null,
    log: [],
    attempts: {},
    samples: {},
  };
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

async function readSecret() {
  const bag = await chrome.storage.local.get(SECRET_KEY);
  return bag[SECRET_KEY] ?? null;
}

async function readTicket() {
  const bag = await chrome.storage.local.get(TICKET_KEY);
  return bag[TICKET_KEY] ?? null;
}

async function writeTicket(ticket) {
  await chrome.storage.local.set({ [TICKET_KEY]: ticket });
  return ticket;
}

async function clearTicket() {
  await chrome.storage.local.remove(TICKET_KEY);
}

/**
 * The marker that says "an execution was started and its end is not recorded".
 *
 * Its own key, written and removed on its own, because the whole point is to
 * outlive the worker that wrote it. The signing ticket cannot do this job: it
 * is cleared as soon as the page answers, and on Solana it is never spent at
 * all, since Privy signs there rather than the session key here.
 */
async function readAttempt() {
  const bag = await chrome.storage.local.get(ATTEMPT_KEY);
  return bag[ATTEMPT_KEY] ?? null;
}

async function writeAttempt(attempt) {
  await chrome.storage.local.set({ [ATTEMPT_KEY]: attempt });
}

async function clearAttempt() {
  await chrome.storage.local.remove(ATTEMPT_KEY);
}

/**
 * The page says a send is going out for this order, before it goes.
 *
 * Only the attempt this round already wrote is touched, so this cannot invent
 * an execution or reach an order that is not being executed right now.
 */
export async function markAttemptSent({ orderId, txHash = null }) {
  const attempt = await readAttempt();
  if (!attempt || attempt.orderId !== orderId) return { ok: false };
  await writeAttempt({ ...attempt, sent: true, txHash: txHash ?? attempt.txHash ?? null });
  return { ok: true };
}

/**
 * Creates a new session key.
 *
 * The key is generated HERE and never handed out: neither to the popup nor to
 * the page. Only the address leaves; the on-chain grant is issued to it.
 * An existing key is never overwritten without `replace`: the old private
 * part would be gone for good while its grant kept hanging on chain, on an
 * address nothing can sign with any more.
 */
export async function createSessionKey({ replace = false } = {}) {
  const existing = await readSecret();
  if (existing && !replace) {
    const state = await readState();
    throw new Error(
      `a session key already exists: ${state.sessionKeyAddress}. `
      + 'Replacing it discards the private part for good and leaves its grant orphaned; '
      + 'confirm the replacement explicitly and the grant will have to be re-issued to the new address.',
    );
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const account = privateKeyToAccount(hex);
  await chrome.storage.local.set({ [SECRET_KEY]: hex });
  const state = await readState();
  state.sessionKeyAddress = account.address;
  state.armed = false;
  state.armedUntil = 0;
  await writeState(state);
  return { address: account.address };
}

/** Signs a hash with the session key. The only place the private part is read. */
async function signWithSessionKey(hash) {
  const secret = await readSecret();
  if (!secret) throw new Error('no session key, it is created when the extension starts');
  return privateKeyToAccount(secret).sign({ hash });
}

export function status(state) {
  const arm = armState(state, { now: Date.now() });
  return {
    armed: arm.armed,
    reason: arm.reason,
    msLeft: arm.msLeft ?? 0,
    sessionKeyAddress: state.sessionKeyAddress,
    sampleWindowMin: RUNNER_LIMITS.sampleWindowMs / 60_000,
    log: (state.log ?? []).slice(-25).reverse(),
  };
}

export async function runnerStatus() {
  return status(await readState());
}

/**
 * The public part of the state: key address, sample window, version, journal.
 *
 * Separate from `runnerStatus`, which the page never sees. The key address
 * becomes public with the first grant anyway; the journal is exposed because
 * the panel already draws the orders in the page DOM and the cost of hiding
 * the reasons for a refusal turned out higher than what hiding protected.
 */
export async function runnerInfo() {
  const state = await readState();
  const bag = await chrome.storage.local.get(['settings', 'orders']);
  const liveOrders = (bag.orders ?? []).filter((o) => o?.status === 'watching').length;
  const limits = limitsWith(await settingsWithPolicy(bag.settings), undefined, liveOrders);
  let version = null;
  try { const m = chrome.runtime.getManifest(); version = m.version_name || m.version; } catch { /* no access */ }
  return {
    sessionKeyAddress: state.sessionKeyAddress ?? null,
    sampleWindowMin: RUNNER_LIMITS.sampleWindowMs / 60_000,
    version,
    log: (state.log ?? []).slice(-40).reverse(),
    // The number the round actually decides by, not the one in the input field.
    maxFiresPerDay: limits.maxFiresPerDay,
    // The account whose order this browser last executed: the one fact about
    // the signed-in account that cannot be wrong (signedin.js falls back to it).
    lastExecutedSender: state.lastExecutedSender ?? null,
  };
}

// ------------------------------------------------------------------- round

/**
 * Solana nodes, all at once, the first good answer taken.
 *
 * The public nodes answer 429 to a burst of requests, 403 to a request they
 * find too large, and 5xx now and then; each is slow in its own way. The
 * guard's simulation and account reads stand between a signature and the
 * chain and are on the path of every quick trade, so the question goes to
 * every node at the same time and the first answer that is not a refusal
 * wins; only when every node refused is the round repeated, twice, a little
 * apart. A node the person configured in the popup (`solanaRpcUrl`, their
 * own key with a provider) is asked FIRST and alone: their traffic goes
 * through their node, and the public ones are a fallback for when it does
 * not answer. Each request has its own timeout: a node that hangs must not
 * hold a trade.
 */
export const SOLANA_RPCS = Object.freeze([
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
]);
const SOLANA_RPC_TIMEOUT_MS = 8000;
const SOLANA_RPC_PAUSES_MS = [400, 1200];
let lastSolanaRpcError = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The hub as a node. The public Solana nodes answer 403 to any request that
 * carries a browser Origin (every request from here does) while the hub,
 * a plain process on the same box, is answered. So a paired runner asks the
 * hub first (/v1/runner/solana, daemon/solana.mjs, signed like every runner
 * call); the person's own node and the public list remain the fallback.
 * Returns undefined when there is no hub to ask, so the caller falls through.
 */
async function hubSolanaRpc(method, params) {
  let cfg;
  try { cfg = (await chrome.storage.local.get('settings'))?.settings ?? {}; } catch { return undefined; }
  const url = String(cfg?.mirror?.url ?? '').trim();
  if (!url || !cfg.mirrorEnabled) return undefined;
  const out = await hubCall(url, '/v1/runner/solana', { method: 'POST', body: { method, params } });
  if (out?.error) throw new Error(`hub: ${out.error}`);
  return out?.result;
}

/**
 * Settings with the managed policy underneath: a headless runner has no popup
 * to raise `runnerMaxFiresPerDay` in, so the policy file that paired it may
 * carry the number (still capped by the ceiling in limitsWith). A value set
 * in the popup wins; the policy only fills the blank.
 */
async function settingsWithPolicy(settings) {
  const own = settings ?? {};
  if (Number.isInteger(Number(own.runnerMaxFiresPerDay)) && Number(own.runnerMaxFiresPerDay) >= 1) return own;
  try {
    const managed = (await chrome.storage.managed?.get('runnerMaxFiresPerDay')) ?? {};
    const raw = Number(managed.runnerMaxFiresPerDay);
    return Number.isInteger(raw) && raw >= 1 ? { ...own, runnerMaxFiresPerDay: raw } : own;
  } catch {
    return own;
  }
}

/** The person's own node, if any: settings.solanaRpcUrl, an https URL. */
async function ownSolanaRpc() {
  try {
    const bag = await chrome.storage.local.get('settings');
    const url = String(bag?.settings?.solanaRpcUrl ?? '').trim();
    return /^https:\/\/\S+$/.test(url) ? url : null;
  } catch {
    return null;
  }
}

async function askNode(url, method, params) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(SOLANA_RPC_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`${host}: ${json.error.message}`);
    return json.result;
  } catch (err) {
    throw new Error(err?.message?.startsWith(host) ? err.message : `${host}: ${String(err?.message || err)}`);
  }
}

/** One round: every node asked at once; the first result, or every refusal. */
async function solanaRpcRound(urls, method, params) {
  return new Promise((resolve, reject) => {
    const errors = [];
    let settled = false;
    for (const url of urls) {
      askNode(url, method, params).then((result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      }, (err) => {
        errors.push(String(err?.message || err));
        if (!settled && errors.length === urls.length) { settled = true; reject(new Error(errors.join('; '))); }
      });
    }
  });
}

export async function solanaRpc(method, params) {
  let lastErr = null;
  try {
    const viaHub = await hubSolanaRpc(method, params);
    if (viaHub !== undefined) { lastSolanaRpcError = null; return viaHub; }
  } catch (err) {
    lastErr = String(err?.message || err);
  }
  const own = await ownSolanaRpc();
  if (own) {
    try {
      const result = await askNode(own, method, params);
      lastSolanaRpcError = null;
      return result;
    } catch (err) {
      lastErr = String(err?.message || err);
    }
  }
  for (let attempt = 0; attempt <= SOLANA_RPC_PAUSES_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(SOLANA_RPC_PAUSES_MS[attempt - 1]);
    try {
      const result = await solanaRpcRound([...SOLANA_RPCS], method, params);
      lastSolanaRpcError = null;
      return result;
    } catch (err) {
      lastErr = `${lastErr ? `${lastErr}; then ` : ''}${String(err?.message || err)}`;
    }
  }
  lastSolanaRpcError = lastErr;
  throw new Error(`Solana nodes did not answer (${SOLANA_RPC_PAUSES_MS.length + 1} tries): ${lastErr}`);
}

async function readTokenBalance({ chainId, token, owner, solanaOwner = null }) {
  if (!chainId || !token) return null;
  // A Solana token: the sum over all token accounts of the owner for this mint.
  if (Number(chainId) === SOLANA_NETWORK_ID) {
    if (!solanaOwner) return null;
    try {
      const result = await solanaRpc('getTokenAccountsByOwner', [solanaOwner, { mint: token }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      let total = 0n;
      for (const item of result?.value ?? []) {
        const amount = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (amount !== undefined) total += BigInt(amount);
      }
      return total;
    } catch {
      return null;
    }
  }
  if (!owner) return null;
  try {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
    const raw = await ethCall(chainId, { to: token, data });
    return decodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', data: raw });
  } catch {
    return null;
  }
}

/**
 * Guard revert count per order. Returns the pause length in ms when this
 * revert triggers one, else 0. A successful send does not reset the count on
 * purpose: the order leaves circulation after it anyway.
 */
const GUARD_BACKOFF = Object.freeze({ afterBlocks: 3, pauseMs: 10 * 60_000 });
function noteGuardBlock(state, orderId, now) {
  const prev = state.guardPause?.[orderId] ?? { count: 0, until: 0 };
  const count = prev.count + 1;
  const pause = count % GUARD_BACKOFF.afterBlocks === 0 ? GUARD_BACKOFF.pauseMs : 0;
  state.guardPause = { ...(state.guardPause ?? {}), [orderId]: { count, until: pause ? now + pause : 0, at: now } };
  return pause;
}

/**
 * Confirms a Solana transaction by its signature status: landed in a block
 * without an error. Up to a minute: Jito lands it in seconds, the nodes
 * answer later.
 */
async function confirmSolanaTx(txHash, { attempts = 12, everyMs = 5000 } = {}) {
  if (!txHash) return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleepAlive(everyMs);
    try {
      const result = await solanaRpc('getSignatureStatuses', [[txHash], { searchTransactionHistory: true }]);
      const st = result?.value?.[0];
      if (st && st.err) return false;
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return true;
    } catch { /* every node silent, try again */ }
  }
  return null;
}

/**
 * Closes an order in storage.
 *
 * Written TWICE on a send: `triggered` the moment the bundler accepted, then
 * `filled` once the balance proves the sell. "The bundler accepted" and "the
 * position is gone" are different statements, an operation can pass
 * validation without moving a token, but both take the order out of the
 * active set, and the first must be on disk before the confirmation wait: that
 * wait runs up to a minute, the worker may not survive it, and an order still
 * `watching` on the next start would fire a SECOND time.
 */
async function markDone(orderId, status, detail, reason = null) {
  // Through the shared queue: the panel and the hub write this same array,
  // and a verdict lost to an overlapping write leaves a filled order live.
  await mutateOrders((orders) => orders.map((o) => (
    o.id === orderId
      ? { ...o, status, closedAt: o.closedAt ?? new Date().toISOString(), closedTx: detail ?? o.closedTx ?? null, ...(reason ? { cancelReason: reason } : {}) }
      : o
  )));
}

/**
 * Closes the orders a filled sell has left without a position.
 *
 * A take profit and a stop loss over one holding are two watching orders for
 * one position: when either fills, the other must stop. It is measured, not
 * assumed. The wallet's balance is read again here rather than taken from the
 * confirmation, because that value is a sentinel on one Solana path and a
 * buy's output balance on another, and closing a live order on a wrong number
 * is worse than leaving it. A node that will not answer cancels nothing.
 *
 * @returns {Promise<object[]>} journal entries, one per closed order
 */
async function closeOrdersLeftWithoutPosition(filled, { now }) {
  if (filled.side === 'buy') return [];
  const token = String(filled.inTokenId ?? '').split(':')[0] || null;
  const chainId = chainFromTokenId(filled.inTokenId) ?? Number(filled.chainId);
  if (!token || !Number.isFinite(chainId)) return [];
  const remaining = await readTokenBalance({
    chainId, token, owner: filled.sender, solanaOwner: filled.solanaAddress ?? null,
  });
  if (remaining === null) return [];
  // The read is outside the queue and the decision inside it, so an order
  // added or closed meanwhile is judged as it stands at the moment of writing.
  const closed = await mutateOrders((orders) => {
    const ids = new Set(sellsLeftWithoutPosition(orders, { filled, remaining }));
    if (!ids.size) return { result: [] };
    const at = new Date(now).toISOString();
    return {
      orders: orders.map((o) => (ids.has(o.id)
        ? {
          ...o,
          status: 'cancelled',
          closedAt: o.closedAt ?? at,
          cancelledAt: o.cancelledAt ?? at,
          cancelReason: `the position was sold by order ${filled.id}`,
        }
        : o)),
      result: [...ids],
    };
  });
  return closed.map((id) => logEntry({
    orderId: id,
    act: 'cancel',
    reason: `the position was sold by another order of yours, nothing left to sell, order closed`,
    now,
  }));
}

/**
 * The tab to talk to.
 *
 * Answering is not the same as being fit: a content script answers a ping
 * from a throttled background tab too, but Chrome throttles background tabs
 * and the chart feed in them falls silent, so the watcher there is blind. All
 * tabs are asked and the best one chosen: freshest tick first, visible on a
 * tie. When none answers, the first is returned so that `askPage` produces
 * the familiar error and triggers the reload cure.
 */
export async function fomoTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://fomo.family/*', 'https://*.fomo.family/*'],
  });
  const alive = [];
  for (const tab of tabs) {
    try {
      // A cheap ping: the handler lives in the content script and makes no network call.
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'ui.status' });
      const st = res?.result ?? res ?? {};
      alive.push({
        tab,
        // No tick at all counts as infinitely old.
        age: Number.isFinite(st.livePriceAgeMs) ? st.livePriceAgeMs : Number.MAX_SAFE_INTEGER,
        visible: Boolean(st.visible),
      });
    } catch {
      // A deaf tab, try the next one.
    }
  }
  if (!alive.length) return tabs[0] ?? null;
  alive.sort((a, b) => (a.age - b.age) || (Number(b.visible) - Number(a.visible)));
  return alive[0].tab;
}

/**
 * Signs that nobody in the tab can answer: an ORPHANED content script. After
 * an extension update the old script in an open tab is cut off from the new
 * service worker and the new one is not injected until the tab reloads.
 */
const PAGE_DOWN = [
  /Receiving end does not exist/i,
  /message channel closed/i,
  /Extension context invalidated/i,
];

/**
 * Pause between attempts to heal a tab. The timestamp lives in STORAGE, not
 * in a module variable: an MV3 service worker sleeps within tens of seconds
 * and restarts, so a module variable would reset before every round.
 */
const HEAL_COOLDOWN_MS = 5 * 60_000;

/**
 * Backoff on quote refusals.
 *
 * Their API sits behind Cloudflare and a refusal arrives WITHOUT CORS headers,
 * i.e. as `Failed to fetch` with no status. Hammering a refusal is doubly
 * pointless: it does not go through and it prolongs the refusal. After two in
 * a row we back off, the longer the refusals last the less often we ask, with
 * a ceiling so the order is not left unattended for good.
 */
const QUOTE_BACKOFF_AFTER = 2;
/**
 * After how many consecutive refusals the watcher's nudge respects the pause
 * too. Below it the nudge bypasses the pause: a level crossing is the one
 * moment when a quote is certainly not wasted. Above it the bypass turns into
 * a loop, because the price sits beyond the level and the watcher nudges on
 * every crossing.
 */
const QUOTE_HARD_BLOCK_AFTER = 4;
/**
 * Orders quoted per round. The watcher covers only the orders of the open
 * page; the rest have to be asked. Without a cap ten limit orders would mean
 * ten requests a minute to an API that refuses already at one.
 */
const QUOTES_PER_PASS = 3;
/** Backoff ceiling: with the minute poll gone refusals are rare and a long backoff is not needed. */
const QUOTE_BACKOFF_MAX_MS = 2 * 60_000;

/** How long a watcher heartbeat counts as fresh: two minutes at one beat per half minute. */
const WATCHDOG_FRESH_MS = 2 * 60_000;

/**
 * No order goes longer than this without a quote, whatever the watcher says.
 *
 * The watcher looks at a level derived from the market cap while execution is
 * decided by the quote. The two are different quantities and drift apart
 * silently. A control quote every two minutes catches the drift and calibrates
 * the level, which otherwise has no way to learn it is wrong.
 */
const QUOTE_FLOOR_MS = 2 * 60_000;

/**
 * The extension keeps a FOMO tab open itself while there are live orders: if
 * the user closed theirs, the runner opens a pinned background tab on the
 * token page of the first order. The chart watcher, quotes and Privy live in
 * it. Not more often than every five minutes: if the tab does not come up,
 * hammering it open is pointless.
 */
const AUTO_TAB_EVERY_MS = 5 * 60_000;
async function ensureFomoTab(state, orders, now) {
  const live = (orders ?? []).find((o) => o?.status === 'watching');
  if (!live) return null;
  if (now - Number(state.autoTabAt ?? 0) < AUTO_TAB_EVERY_MS) return null;
  const url = tokenPageUrl(live.side === 'buy' ? live.outTokenId : live.inTokenId) ?? 'https://fomo.family/';
  state.autoTabAt = now;
  try {
    const tab = await chrome.tabs.create({ url, active: false, pinned: true });
    return { tab, url };
  } catch (err) {
    return { error: String(err?.message || err), url };
  }
}

/**
 * Orders being executed RIGHT NOW.
 *
 * Two rounds can run at once: the minute alarm and the watcher's nudge, which
 * arrives FROM THE PAGE (`runner.nudge` is on the content script allow-list)
 * and can therefore arrive any time and any number of times. None of the other
 * fuses separates the two: the attempt cooldown, the daily limit and the order
 * status are all written AFTER the send, and the ticket is re-issued before
 * EVERY assembly. Without this lock one position was sold twice.
 *
 * A module-level lock, not storage, on purpose: the race exists only between
 * concurrent calls, which always live in one service worker instance. A
 * worker that falls asleep leaves no hanging executions.
 */
const inFlight = new Set();
/** Whether an order is being executed right now (a self-reload must wait). */
export function isBusy() { return inFlight.size > 0; }

/** Whether a message looks like a network refusal rather than a parse error. */
function looksLikeRefusal(message) {
  return /Failed to fetch|NetworkError|429|too many/i.test(String(message ?? ''));
}

/**
 * An AUTHORIZATION failure, not a rate limit. The cure differs.
 *
 * Their API token and the Privy token are different things. The Privy token
 * refreshes itself; the header for `/swaps/v2` and the bundler is captured
 * from the page's own requests and goes stale while the page is idle. Only a
 * tab reload fixes it: the app comes up again, receives a fresh token, and
 * the interceptor captures it.
 */
function looksLikeAuthFailure(message) {
  return /\b401\b|JWT|unauthorized|token expired|Invalid auth/i.test(String(message ?? ''));
}

/** How long to wait after N consecutive refusals. */
function backoffMs(streak) {
  if (streak < QUOTE_BACKOFF_AFTER) return 0;
  const step = 2 ** (streak - QUOTE_BACKOFF_AFTER) * 60_000;
  return Math.min(step, QUOTE_BACKOFF_MAX_MS);
}

/**
 * Heals a deaf tab by reloading it.
 *
 * Re-injecting the scripts (chrome.scripting) would not help: the Privy and
 * TradingView interceptors only work at document_start, before the page
 * bundle. Injected later they are late forever. A reload restores everything
 * and costs a second.
 */
async function healTab(tabId, state, { now = Date.now() } = {}) {
  if (now - Number(state.healedAt ?? 0) < HEAL_COOLDOWN_MS) return false;
  state.healedAt = now;
  try {
    await chrome.tabs.reload(tabId);
    return true;
  } catch {
    return false;
  }
}

export async function askPage(tabId, type, payload) {
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type, payload });
  } catch (err) {
    const message = String(err?.message || err);
    if (PAGE_DOWN.some((re) => re.test(message))) {
      const down = new Error('the FOMO tab does not answer, reload it. '
        + 'After an extension update the old content script in an open tab no longer works');
      down.pageDown = true;
      throw down;
    }
    throw err;
  }
  if (res?.error) throw new Error(res.error);
  return res?.result;
}

/**
 * Appends an idle entry without repeating it back to back. The round runs
 * every minute; "no orders" every minute would push everything else out of a
 * 200-entry journal within hours, and a repeat says nothing new.
 */
function noteIdle(state, entry) {
  const last = (state.log ?? []).at(-1);
  if (last && last.act === entry.act && last.reason === entry.reason) return state.log ?? [];
  return trimLog([...(state.log ?? []), entry]);
}

/**
 * Rounds run one at a time. Two concurrent rounds would each read and write
 * their own copy of the state (journal, attempts, samples): the second
 * overwriting the first, a firing with `fired: true` dropping out of the daily
 * count. The queue removes the whole class: every round starts from the state the
 * previous one left.
 */
let queue = Promise.resolve();

/**
 * Runs `fn` after everything queued before it. Every writer of the `runner`
 * state goes through here, the round, the watcher's heartbeat, the page's
 * journal lines, because a writer outside the queue reads the state, waits,
 * and writes back a copy that no longer has what the round wrote meanwhile:
 * the `fired` entry the daily count is made of, the attempt the cooldown is
 * made of, a guard pause.
 */
function queued(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => { /* the reason is in the caller's result or journal */ });
  return run;
}

export function tick(opts = {}) {
  return queued(() => tickUnlocked(opts));
}

/**
 * A pause that keeps the service worker alive. A bare `setTimeout` does not:
 * Chrome ends an idle MV3 worker after about half a minute without an
 * extension API call, and the confirmation waits below run longer than that
 * with nothing but timers and `fetch` in them. A storage read is an extension
 * API call and resets that clock.
 */
async function sleepAlive(ms) {
  await new Promise((r) => { setTimeout(r, ms); });
  try { await chrome.storage.local.get(TICKET_KEY); } catch { /* the pause itself is what matters */ }
}

/**
 * One round: examine the orders, execute when due.
 *
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {string|null} [opts.onlyOrderId] check ONLY this order
 * @param {number} [opts.confirmations] how many samples to require
 */
async function tickUnlocked({ now = Date.now(), onlyOrderId = null, confirmations } = {}) {
  const state = await readState();
  const bagS = await chrome.storage.local.get(['settings', 'orders']);
  // The orders switch in the popup: off means the runner does not run at all.
  if (bagS.settings?.ordersEnabled !== true) {
    state.log = noteIdle(state, logEntry({ act: 'skip', reason: 'limit orders are switched off in the popup', now }));
    await writeState(state);
    return { acted: false, reason: 'orders are off' };
  }
  // A runner browser on the user's server executes instead of this one: two
  // executors on one position would sell it twice. The extension keeps
  // watching the chart and mirroring orders; verdicts come back through
  // daemon.pull(). A hub with NO runner browser paired does not count, it
  // executes nothing, and yielding to it left the orders with no executor.
  if (runnerExecutes(bagS.settings)) {
    state.log = noteIdle(state, logEntry({ act: 'skip', reason: 'the runner browser on the user\'s server executes', now }));
    await writeState(state);
    return { acted: false, reason: 'the runner browser executes' };
  }
  // Before anything else: did a previous worker die with a signature out?
  // The ticket outlives the process that wrote it, and the lock that stops a
  // second attempt does not.
  const leftover = interruptedAttempt(
    { attempt: await readAttempt(), ticket: await readTicket() },
    bagS.orders ?? [],
  );
  if (leftover) {
    await markDone(leftover, 'triggered', null);
    await clearAttempt();
    await clearTicket();
    state.log = trimLog([...(state.log ?? []), logEntry({
      orderId: leftover,
      act: 'recover',
      reason: 'a signature was issued before this browser stopped and the outcome was never recorded; '
        + 'the order is off the watch list rather than sent again, CHECK THE POSITION',
      now,
    })]);
    await writeState(state);
    bagS.orders = await loadOrders();
  }
  const liveOrders = (bagS.orders ?? []).filter((o) => o?.status === 'watching').length;
  const limits = limitsWith(await settingsWithPolicy(bagS.settings), undefined, liveOrders);
  const gate = runnerGate(state, { now, limits });
  if (!gate.ok) {
    // The alarm is NOT cleared: the gate also closes on the daily limit, and
    // that one passes by itself as the window slides.
    state.log = noteIdle(state, logEntry({ act: 'skip', reason: gate.reason, now }));
    await writeState(state);
    return { acted: false, reason: gate.reason };
  }

  const tab = await fomoTab();
  if (!tab) {
    const opened = await ensureFomoTab(state, Array.isArray(bagS.orders) ? bagS.orders : [], now);
    state.log = noteIdle(state, logEntry({
      act: 'skip',
      reason: opened?.tab
        ? `no FOMO tab was open, opened a background one (${opened.url}), next round in a minute`
        : `no FOMO tab is open, nothing to quote with${opened?.error ? ` (could not open one: ${opened.error})` : ''}`,
      now,
    }));
    await writeState(state);
    return { acted: false, reason: 'no FOMO tab' };
  }

  // Being refused, do not ask. The pause is per round: the refusal comes from
  // their API, not from a particular order. The watcher's nudge bypasses a
  // short pause (a level crossing is the one moment a quote is not wasted)
  // but respects a long one, when the refusals are no longer about one quote.
  const hardBlock = Number(state.quoteFails ?? 0) >= QUOTE_HARD_BLOCK_AFTER;
  if ((!onlyOrderId || hardBlock) && state.quoteBlockedUntil && now < state.quoteBlockedUntil) {
    const left = Math.ceil((state.quoteBlockedUntil - now) / 1000);
    state.log = noteIdle(state, logEntry({
      act: 'skip',
      reason: `their API refuses requests, waiting ${left} s so as not to prolong the refusal`,
      now,
    }));
    await writeState(state);
    return { acted: false, reason: 'backing off after quote refusals' };
  }

  const bag = await chrome.storage.local.get('orders');
  // A broken entry (null after structured clone) would sink the WHOLE round
  // on `o.status` before anything reached the journal; it is filtered out.
  let orders = (Array.isArray(bag.orders) ? bag.orders : [])
    .filter((o) => o && typeof o === 'object' && o.status === 'watching')
    // A nudge is about ONE order: the others are not touched, and a spare
    // quote is a step towards a refusal of their API.
    .filter((o) => !onlyOrderId || o.id === onlyOrderId);
  // While the watcher covers an order, its quote is not requested, with two
  // safety limits, both below: a control quote every QUOTE_FLOOR_MS whatever
  // the watcher says, and an order whose LAST quote already showed the target
  // reached is no longer counted as covered and is quoted every round until it
  // gathers confirmations and fires (or the price walks back).
  const beatFresh = state.watchdogAt && (now - state.watchdogAt) < WATCHDOG_FRESH_MS;
  // Covered means confirmed RECENTLY, by whichever tab did it. `watchdogIds`
  // is read as the fallback for state written by a build before timestamps.
  const seenAt = state.watchdogSeen && typeof state.watchdogSeen === 'object'
    ? state.watchdogSeen
    : null;
  const seenIds = new Set(seenAt
    ? Object.entries(seenAt)
      .filter(([, at]) => now - Number(at) < WATCHDOG_FRESH_MS)
      .map(([id]) => id)
    : (Array.isArray(state.watchdogIds) ? state.watchdogIds : []));
  const lastSample = (o) => (state.samples?.[o.id] ?? []).at(-1);
  const quoteSaysReached = (o) => {
    const sample = lastSample(o);
    if (!sample) return false;
    try {
      return isTriggered(o, sample.out);
    } catch {
      return false;
    }
  };
  const dueForFloor = (o) => now - Number(lastSample(o)?.at ?? 0) >= QUOTE_FLOOR_MS;
  // EVERY live order must be covered, not merely "as many levels as orders".
  const watched = (o) => seenIds.has(o.id) && !quoteSaysReached(o) && !dueForFloor(o);
  const covered = orders.length > 0 && orders.every(watched);
  if (!onlyOrderId && beatFresh && covered) {
    state.log = noteIdle(state, logEntry({
      act: 'idle',
      reason: `the watcher follows the price (${orders.length} of ${orders.length}), quotes only on a crossing`,
      now,
    }));
    await writeState(state);
    return { acted: false, reason: 'watching the live price' };
  }
  // The watcher covers part of the orders, those are not quoted.
  if (!onlyOrderId && beatFresh) orders = orders.filter((o) => !watched(o));

  // A handful per round, the rest next time. The chart lives only on the open
  // page, so the watcher sees one token's orders; ten tokens would mean nine
  // uncovered orders and nine requests a minute. Round-robin from the one not
  // asked for longest, so nobody starves.
  // The choice is `nextToQuote` in shared/runner.js, pure and tested: orders
  // already at their target go first so their confirmations do not expire.
  if (!onlyOrderId) {
    const lastAskedAt = (o) => {
      const last = (state.samples?.[o.id] ?? []).at(-1);
      return last ? Number(last.at) : 0;
    };
    orders = nextToQuote(orders, { lastAskedAt, reached: quoteSaysReached, limit: QUOTES_PER_PASS });
  }

  // An empty round is written too: "armed, waiting, no entries" must not happen.
  if (!orders.length) {
    // A nudge about an order no longer watched (closed by another round or
    // cancelled by the user) is not "no orders": the others may stand.
    const reason = onlyOrderId
      ? `order ${onlyOrderId} is no longer watched, the watcher's nudge is skipped`
      : 'no orders are watched, nothing to do';
    state.log = noteIdle(state, logEntry({ act: 'idle', reason, now }));
    await writeState(state);
    return { acted: false, reason };
  }

  const entries = [];
  // The wallet's delegate per chain, read once for the round: every order of
  // a chain shares the answer and a node round trip per order is waste.
  const delegateCache = new Map();
  // The account this browser is signed in to, once for the round. An order
  // for another wallet is refused below: with two accounts in one browser an
  // EVM sell took one wallet's tokens and paid the other.
  const signedIn = await signedInWallet({ fallback: state.lastExecutedSender ?? null });

  for (const order of orders) {
    const attempts = state.attempts?.[order.id] ?? [];
    let decision;
    /** The observed price picture, for calibrating the spread threshold. */
    let observed = null;
    try {
      // The quote doubles as the price sample. One request per order per round.
      const quote = await askPage(tab.id, 'page.swap.prepare', {
        sender: order.sender,
        side: order.side,
        solanaAddress: order.solanaAddress ?? null,
        chainId: chainFromTokenId(order.inTokenId),
        inTokenId: order.inTokenId,
        outTokenId: order.outTokenId,
        amount: order.amount,
        sign: false,
        send: false,
      });
      // Units: `expectedOut` is a human-readable DECIMAL string; the order
      // target is an integer in QUOTE_SCALE. The sample is converted to the
      // same scale here. An answer WITHOUT a number is a failed quote, not a
      // sample: turned into 0 it would count as a price at-or-below any
      // stop-loss level, and on a nudge one sample is enough to fire.
      const rawOut = quote?.quote?.expectedOut;
      if (rawOut === undefined || rawOut === null || rawOut === '') throw new Error('the quote carries no expectedOut');
      const out = parseDecimal(String(rawOut));
      if (out <= 0n) throw new Error(`the quote's expectedOut is not positive (${String(rawOut).slice(0, 40)})`);
      const samples = [...(state.samples?.[order.id] ?? []), { out: out.toString(), at: now }]
        .slice(-10);
      state.samples = { ...(state.samples ?? {}), [order.id]: samples };

      // A quote went through, the refusal counter resets.
      state.quoteFails = 0;
      state.quoteBlockedUntil = 0;

      // The window is passed explicitly: the trigger.js default of 60 s equals
      // the round interval, and confirmations fell out of it as fast as they
      // were gathered.
      const trigger = shouldTrigger({
        targetOut: order.targetOut,
        direction: triggerOf(order),
        ...(confirmations ? { confirmations } : {}),
        samples,
        now,
        windowMs: RUNNER_LIMITS.sampleWindowMs,
      });
      // Limits are passed explicitly, otherwise `decide` falls back to the defaults.
      decision = decide({ runner: state, order, attempts, trigger, now, limits });
      // The spread goes into the journal as a NUMBER, not only inside the
      // reason text: the spread threshold can only be calibrated from data.
      observed = {
        spreadBps: trigger.spreadBps,
        confirmed: trigger.confirmed,
        median: trigger.median,
        samples: samples.length,
      };
    } catch (err) {
      // A deaf tab is not a quote refusal, and it can be fixed without the user.
      if (err?.pageDown) {
        // The tab is dead for ALL orders at once, so the round stops here.
        const healed = await healTab(tab.id, state, { now });
        entries.push(logEntry({
          act: 'skip',
          reason: healed
            ? 'the FOMO tab did not answer, reloaded it, next round in a minute'
            : 'the FOMO tab does not answer and a reload was already tried, open it yourself',
          now,
        }));
        break;
      }
      if (looksLikeAuthFailure(err?.message)) {
        // A stale session is not cured by waiting: their backend issues the
        // header to their page. Reload the tab, same cooldown as for a deaf
        // script. This does NOT count towards the refusal backoff.
        const healed = await healTab(tab.id, state, { now });
        decision = {
          act: 'skip',
          reason: healed
            ? 'the FOMO session went stale, reloaded the tab, next round in a minute'
            : 'THE FOMO SESSION IS STALE and a reload was already tried, open the FOMO tab yourself',
        };
      } else if (looksLikeRefusal(err?.message)) {
        // Their API refuses. Count consecutive refusals and back off.
        state.quoteFails = Number(state.quoteFails ?? 0) + 1;
        const wait = backoffMs(state.quoteFails);
        if (wait) state.quoteBlockedUntil = now + wait;
        // The error text stays in the line rather than being paraphrased:
        // "their API refuses" once hid a failure that was somewhere else.
        const raw = String(err?.message || err).slice(0, 120);
        decision = {
          act: 'skip',
          reason: wait
            ? `network refusal (${state.quoteFails} in a row), backing off ${Math.round(wait / 1000)} s: ${raw}`
            : `quote failed: ${raw}`,
        };
      } else {
        decision = { act: 'skip', reason: `quote failed: ${String(err?.message || err)}` };
      }
    }

    if (decision.act !== 'fire') {
      entries.push(logEntry({
        orderId: order.id, act: decision.act, reason: decision.reason, detail: observed, now,
      }));
      // Shelved is a verdict, not a mood: the order has used its attempts and
      // will never fire here. Closed as `shelved` with the reason, so the hub
      // and the owner's list say so instead of showing it watching for ever.
      if (decision.act === 'shelve') await markDone(order.id, 'shelved', null, decision.reason);
      continue;
    }

    // Backoff after guard reverts: three in a row means ten minutes of silence.
    const pausedUntil = state.guardPause?.[order.id]?.until ?? 0;
    if (pausedUntil > now) {
      entries.push(logEntry({
        orderId: order.id, act: 'skip',
        reason: `the guard reverted the trade ${state.guardPause[order.id].count} times in a row, waiting another ${Math.ceil((pausedUntil - now) / 60000)} min`,
        now,
      }));
      continue;
    }

    // This order is already being executed by a concurrent round. Selling
    // twice is worse than being late: lateness is visible and fixable.
    if (inFlight.has(order.id)) {
      entries.push(logEntry({
        orderId: order.id,
        act: 'skip',
        reason: 'this order is already being executed, not starting a second round',
        now,
      }));
      continue;
    }
    // Status from storage, not from the list taken at the start of the round:
    // while the quote ran, the user may have cancelled it or a neighbour closed it.
    const freshBag = await chrome.storage.local.get('orders');
    const fresh = (Array.isArray(freshBag.orders) ? freshBag.orders : [])
      .find((o) => o && typeof o === 'object' && o.id === order.id);
    if (fresh?.status !== 'watching') {
      entries.push(logEntry({
        orderId: order.id,
        act: 'skip',
        reason: `the order is already in status ${fresh?.status ?? 'removed'}, not executing`,
        now,
      }));
      continue;
    }
    inFlight.add(order.id);

    const isBuy = order.side === 'buy';
    // A sell of a Solana token takes the buy path: a Solana transaction, a
    // Privy signature, confirmation by balance or by transaction.
    const solanaSide = isBuy || chainFromTokenId(order.inTokenId) === SOLANA_NETWORK_ID;
    // On a sell the input token is watched (it leaves the EVM wallet); on a
    // buy the output token (it arrives on the EVM or Solana wallet).
    const watchId = isBuy ? order.outTokenId : order.inTokenId;
    const orderChain = chainFromTokenId(watchId) ?? Number(order.chainId);
    const orderToken = String(watchId ?? '').split(':')[0] || null;

    const foreign = senderMismatch(order, signedIn);
    if (foreign) {
      entries.push(logEntry({
        orderId: order.id, act: 'skip',
        reason: `the order belongs to ${foreign.sender.slice(0, 10)}… but this browser is signed in as ${foreign.signedIn.slice(0, 10)}…: not executing for another account`,
        detail: foreign, now,
      }));
      inFlight.delete(order.id);
      continue;
    }
    // An order that came from the hub is executed only for an account this
    // browser can name: the page said, or a send the bundler accepted said.
    // With neither there is no proof, and a runner does not sell on a guess
    // (two accounts in one browser). An order placed in this
    // browser carries the sender its own page reported when it was placed.
    if (!signedIn && order[MIRRORED]) {
      entries.push(logEntry({
        orderId: order.id, act: 'skip',
        reason: 'the account this browser is signed in to is unknown: a hub order is not executed without it. Open the FOMO tab signed in, or trade once by hand',
        now,
      }));
      inFlight.delete(order.id);
      continue;
    }

    // Delegation. The session key means nothing until the wallet runs OUR
    // contract: while it is delegated elsewhere, FOMO's own account, or
    // nowhere, the key's signature is not a signature to whatever code the
    // account does run, and the bundler answers AA24. Learning it from the
    // bundler would cost a quote, an assembly, a signature, an attempt and a
    // pause. One `eth_getCode` says it first.
    //
    // Not a failure of the order: the delegation is signed in the owner's
    // browser, through Privy, when an order is placed. So this is a skip with
    // the reason in words, and the order stays live for when it is signed.
    if (!solanaSide && orderChain && order.sender) {
      const cacheKey = `${orderChain}:${String(order.sender).toLowerCase()}`;
      if (!delegateCache.has(cacheKey)) {
        try {
          delegateCache.set(cacheKey, delegateFromCode(await ethGetCode(orderChain, order.sender)));
        } catch {
          // A silent node is not proof of anything; the round proceeds as
          // before and the bundler stays the last word.
          delegateCache.set(cacheKey, undefined);
        }
      }
      const current = delegateCache.get(cacheKey);
      const ours = delegateFor(orderChain);
      if (current !== undefined && String(current ?? '').toLowerCase() !== String(ours ?? '').toLowerCase()) {
        const where = CHAINS[orderChain]?.name ?? `chain ${orderChain}`;
        entries.push(logEntry({
          orderId: order.id,
          act: 'skip',
          reason: current
            ? `on ${where} the wallet runs ${current}, not the limil account, the session key cannot sign for it. `
              + 'The delegation is signed in the browser where FOMO is logged in, when an order is placed'
            : `on ${where} the wallet is not delegated yet, the session key cannot sign for it. `
              + 'The delegation is signed in the browser where FOMO is logged in, when an order is placed',
          detail: { delegate: current ?? null, expected: ours ?? null },
          now,
        }));
        inFlight.delete(order.id);
        continue;
      }
    }

    // Price impact. The price arrived, but does the pool absorb our size?
    // While the impact is above the cap the trade waits, polling the pool
    // every two seconds for up to a minute. Not waited out: not an attempt,
    // the next round asks again. Someone else's impact is caught here too:
    // relay returns the output, and it shows when the quote flew away from
    // the target by more than the tolerance.
    const capBps = order.maxImpactBps === undefined ? DEFAULT_MAX_IMPACT_BPS : order.maxImpactBps;
    const slipBps = order.maxSlippageBps ?? null;
    let impactNote = null;
    if ((capBps !== null || slipBps !== null) && orderToken && orderChain) {
      const swapAmount = BigInt(order.amount);
      const guard = await waitForImpact({
        sender: order.sender, chainId: orderChain, token: orderToken, amount: swapAmount, capBps,
        side: order.side, solanaAddress: order.solanaAddress ?? null,
        outDecimals: isBuy ? Number(order.decimals ?? 18) : 6,
        // Reference for the output scale: the last FOMO quote of this order.
        referenceOutScaled: (state.samples?.[order.id] ?? []).at(-1)?.out ?? null,
        targetOutScaled: order.targetOut, maxSlippageBps: slipBps,
        // Up to a minute of waiting: keep the worker alive through it.
        sleep: sleepAlive,
      });
      if (!guard.ok) {
        entries.push(logEntry({
          orderId: order.id,
          act: 'skip',
          reason: `${guard.reason} (waited ${Math.round(guard.waitedMs / 1000)} s)`,
          detail: { impactBps: guard.impactBps, capBps, maxSlippageBps: slipBps },
          now,
        }));
        inFlight.delete(order.id);
        continue;
      }
      impactNote = guard.measured
        ? (capBps !== null ? `impact ${(guard.impactBps / 100).toFixed(2)}% at a cap of ${(capBps / 100).toFixed(2)}%` : 'price within tolerance')
        : guard.reason;
    }

    // Buy route. The guard is impossible on a buy: the EVM swap is done by
    // the relay solver without us. So before signing, the same route is
    // looked at with the same aggregator and its v4 pools are run through
    // the Uniswap quoter, which executes the hooks. Not passed, not signed,
    // the order lives, same backoff as the guard. Nothing to check with (chain
    // not described, Kyber silent), not signed either. A buy of a Solana
    // token has no EVM swap and no v4 hooks; there is nothing to check.
    if (isBuy && orderToken && orderChain && orderChain !== SOLANA_NETWORK_ID) {
      const cash = GUARD_CASH[orderChain];
      // A chain the route check does not cover (no Kyber slug, no v4 quoter)
      // can never pass this gate. Rather than being skipped every round with
      // a growing pause, shown as live for ever, it is closed with the reason,
      // and `orders.add` refuses it at placement.
      if (!routeSupported(orderChain)) {
        await markDone(order.id, 'failed', null);
        entries.push(logEntry({
          orderId: order.id, act: 'failed',
          reason: `a buy on chain ${orderChain} cannot be checked before signing (no route check there), order closed`,
          now,
        }));
        inFlight.delete(order.id);
        continue;
      }
      const route = cash
        ? await checkBuyRoute({
          chainId: orderChain, tokenIn: cash.token, tokenOut: orderToken, amountIn: BigInt(order.amount),
          capBps: slipBps ?? DEFAULT_MAX_IMPACT_BPS,
        })
        : { ok: false, reason: `the cash token of chain ${orderChain} is not described, the route cannot be checked`, hops: [] };
      if (!route.ok) {
        const pause = noteGuardBlock(state, order.id, now);
        entries.push(logEntry({
          orderId: order.id, act: 'skip',
          reason: `${route.reason}${pause ? `, backing off ${Math.round(pause / 60000)} min` : ''}`,
          detail: { route: { worstShortfallBps: route.worstShortfallBps ?? null, hops: route.hops } }, now,
        }));
        inFlight.delete(order.id);
        continue;
      }
      impactNote = `${impactNote ? `${impactNote}; ` : ''}route checked, worst v4 hop ${(Number(route.worstShortfallBps ?? 0) / 100).toFixed(2)}% below the promise`;
    }

    // Execution. Quote, assembly and send happen on the page, the signature
    // here; an assembled operation lives for minutes, so the whole cycle has
    // to fit in one round. The balance BEFORE the send proves the sell later.
    const balanceBefore = await readTokenBalance({
      chainId: orderChain, token: orderToken, owner: order.sender, solanaOwner: order.solanaAddress ?? null,
    });

    // Nothing to sell. The position can go while an order watches it: sold by
    // hand in FOMO, or by another order of the owner's placed elsewhere. An
    // exact zero is the only unambiguous case, so only that one closes the
    // order; a part of a position still sells, because an order written for
    // "all of it" should take what is left rather than nothing.
    if (!isBuy && balanceBefore === 0n) {
      await markDone(order.id, 'cancelled', null, 'the position is gone, nothing left to sell');
      entries.push(logEntry({
        orderId: order.id, act: 'cancel',
        reason: 'the wallet holds none of this token any more, order closed instead of sending a sale of nothing',
        now,
      }));
      inFlight.delete(order.id);
      continue;
    }

    // On-chain proof of the sell. Without it a filled order stayed `watching`
    // and could fire a SECOND time after the cooldown. Closed by balance, not
    // by receipt: an operation can pass validation and move no token.
    const confirmSold = async () => {
      if (balanceBefore === null) return null;
      // Solana balances change with block delay and after Jito; wait longer
      // than on EVM, on a buy and on a sell of a Solana token alike.
      const attempts = solanaSide ? 6 : 2;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt) await sleepAlive(solanaSide ? 5000 : 3000);
        const after = await readTokenBalance({
          chainId: orderChain, token: orderToken, owner: order.sender, solanaOwner: order.solanaAddress ?? null,
        });
        if (after === null) return null;
        // A sell removes the whole order amount (with a rounding allowance);
        // a buy is any arrival of the output token.
        if (isBuy ? after > balanceBefore : balanceBefore - after >= (BigInt(order.amount) * 9n) / 10n) return after;
      }
      return null;
    };

    // Whether a signature was ISSUED this round. The ticket is spent in
    // signForRunner before signing, so "ticket spent" means "signature went to the page".
    let signed = false;
    try {
      // Signing ticket: single-use, short, for THIS order. Until it is issued
      // the session key signs nothing, whoever asks.
      await writeTicket({ orderId: order.id, at: now, used: false });
      // Before the page is asked, and not a line later. From here until this
      // order's outcome is written, a worker that stops leaves evidence that
      // something was started; the next round reads it and does not execute
      // the same order again.
      await writeAttempt({ orderId: order.id, at: now });
      let report;
      try {
        report = await askPage(tab.id, 'page.swap.execute', {
          orderId: order.id,
          side: order.side,
          solanaAddress: order.solanaAddress ?? null,
          sender: order.sender,
          chainId: orderChain,
          inTokenId: order.inTokenId,
          outTokenId: order.outTokenId,
          amount: order.amount,
          maxSlippageBps: order.maxSlippageBps,
          // The target travels under an EXPLICIT name with its scale.
          targetOutScaled: order.targetOut,
        });
      } finally {
        // The ticket dies with the attempt, whatever its outcome.
        try { signed = Boolean((await readTicket())?.used); } catch { /* assume not */ }
        await clearTicket();
      }
      // The guard reverted the trade in simulation: the route would give less
      // than the floor. Not a failure and not an attempt, the order lives.
      if (!report?.sent && report?.guard?.blocked) {
        const pause = noteGuardBlock(state, order.id, now);
        entries.push(logEntry({
          orderId: order.id, act: 'skip',
          reason: `${report.blocked}${pause ? `, backing off ${Math.round(pause / 60000)} min` : ''}`,
          detail: { guard: report.guard }, now,
        }));
        continue;
      }
      // The FOMO quote is worse than the target by more than the tolerance:
      // someone else's impact between the relay measurement and the quote.
      if (!report?.sent && report?.slippage?.ok === false) {
        entries.push(logEntry({
          orderId: order.id, act: 'skip',
          reason: `${report.slippage.reason ?? report.blocked}, waiting for the price to come back`,
          detail: { shortfallBps: report.slippage.shortfallBps ?? null }, now,
        }));
        continue;
      }
      // Sent, and the chain says it reverted. The one outcome after a send
      // where the position is known to be intact: the batch reverted as a
      // whole, no token moved, so the order may go on watching.
      //
      // This reads `=== false`, which the executors now set ONLY for a proven
      // revert: a receipt that says so, a Solana transaction that landed and
      // failed, or one dropped before inclusion. An outcome nobody knows is
      // `null` and falls through below, where the order leaves the watch list
      // rather than risking a second sale.
      if (positionProvenIntact(report)) {
        const pause = noteGuardBlock(state, order.id, now);
        state.attempts = {
          ...(state.attempts ?? {}),
          [order.id]: [...attempts, { at: now, ok: false }].slice(-10),
        };
        entries.push(logEntry({
          orderId: order.id, act: 'failed',
          reason: `the operation reverted on chain (${report.receipt.transactionHash ?? report.userOpHash ?? 'no hash'}), `
            + `position intact, the order stays${pause ? `, backing off ${Math.round(pause / 60000)} min` : ''}`,
          detail: { receipt: report.receipt, guard: report.guard ?? null }, now,
        }));
        continue;
      }
      const ok = Boolean(report?.sent);
      // ANY ACCEPTED SEND TAKES THE ORDER OUT OF CIRCULATION, and it does so
      // BEFORE the confirmation wait: `triggered` leaves the active set, so a
      // worker that dies during the wait cannot fire the same position again.
      if (ok) await markDone(order.id, 'triggered', report?.userOpHash ?? null);
      let sold = ok ? await confirmSold() : null;
      // A buy whose balance did not confirm (wrong owner, delivery delay):
      // ask the network about the transaction itself.
      if (ok && sold === null && solanaSide && report?.txHash) {
        const landed = await confirmSolanaTx(report.txHash);
        if (landed === true) sold = 0n;
      }
      // Confirmed: `filled`. Not confirmed (node silent, balance unchanged):
      // it stays `triggered`, off watch, for the person to check.
      if (ok && sold !== null) {
        await markDone(order.id, 'filled', report?.userOpHash ?? null);
        entries.push(...await closeOrdersLeftWithoutPosition(order, { now }));
      }
      // The account this browser holds, proven by a send the bundler took. A
      // rejected send proves nothing and must not stand in for one.
      if (ok) state.lastExecutedSender = order.sender ?? state.lastExecutedSender ?? null;

      state.attempts = {
        ...(state.attempts ?? {}),
        [order.id]: [...attempts, { at: now, ok }].slice(-10),
      };
      entries.push(logEntry({
        orderId: order.id,
        act: ok ? (sold !== null ? 'filled' : 'sent') : 'failed',
        reason: (ok
          ? (sold !== null
            ? 'executed and confirmed by balance, order closed'
            : `${solanaSide ? 'Jito' : 'the bundler'} accepted, but the ${isBuy ? 'buy' : 'sell'} could not be confirmed, order taken off watch, check the position`
              + (solanaSide && lastSolanaRpcError ? ` (Solana nodes: ${lastSolanaRpcError})` : ''))
          : (report?.blocked ?? 'the send was not confirmed')) + (impactNote ? `; ${impactNote}` : ''),
        fired: ok,
        detail: report?.userOpHash ?? null,
        now,
      }));
    } catch (err) {
      const message = String(err?.message || err);
      // A SIGNATURE WAS ISSUED AND NO ANSWER CAME, that is not "not sent".
      //
      // After the signature the page sends the operation and waits for the
      // receipt. The answer may fail to arrive for any reason, bus timeout,
      // tab reload, while the operation is ALREADY with the bundler.
      // Treating such an order as live means selling the same position twice
      // after the cooldown. The only refusal after which the operation is
      // certainly not with the bundler is its own refusal in words.
      const refusedByBundler = /bundler refused/.test(message);
      // On a buy there is no ticket: Privy signs on the page. Two things can
      // say a send went out there. The page's own AFTER SEND marker, when it
      // still has a channel to answer through, and the attempt marker it wrote
      // BEFORE sending, which survives the page. Without the second one, a tab
      // closed or a message port lost between the send and the answer looked
      // exactly like "never sent", and the order was free to fire again.
      const attemptSent = Boolean((await readAttempt())?.sent);
      const sentBeforeError = sendMayHaveHappened({ signed, solanaSide, message, attemptSent });
      if (sentBeforeError && !refusedByBundler) {
        await markDone(order.id, 'triggered', null);
        const sold = await confirmSold();
        if (sold !== null) {
          await markDone(order.id, 'filled', null);
          state.lastExecutedSender = order.sender ?? state.lastExecutedSender ?? null;
          entries.push(...await closeOrdersLeftWithoutPosition(order, { now }));
        }
        state.attempts = {
          ...(state.attempts ?? {}),
          [order.id]: [...attempts, { at: now, ok: sold !== null }].slice(-10),
        };
        entries.push(logEntry({
          orderId: order.id,
          act: sold !== null ? 'filled' : 'sent',
          reason: sold !== null
            ? `the page did not answer (${message.slice(0, 80)}), but the balance moved, executed, order closed`
            : `a signature was issued but the page did not answer (${message.slice(0, 80)}), the operation may be with the bundler, order taken off watch, CHECK THE POSITION`,
          fired: true,
          now,
        }));
      } else {
        state.attempts = {
          ...(state.attempts ?? {}),
          [order.id]: [...attempts, { at: now, ok: false }].slice(-10),
        };
        entries.push(logEntry({
          orderId: order.id, act: 'failed', reason: message, now,
        }));
      }
    } finally {
      // After the outcome, never before: this runs on every path out of the
      // block above, including the early ones that never executed anything.
      await clearAttempt();
      inFlight.delete(order.id);
    }
  }

  state.log = trimLog([...(state.log ?? []), ...entries]);
  await writeState(state);
  return { acted: true, entries };
}

/**
 * Signs an operation with the session key.
 *
 * The hash is NOT accepted from outside. The page hands over the operation
 * itself and the hash is computed here, so signing something we did not build
 * is impossible rather than unlikely. Three conditions, all mandatory: the
 * runner is armed, a ticket of our own is out for this order, and the
 * operation's contents match the order.
 */
/**
 * Spends the signing ticket for an order: read, validate and mark used as ONE
 * step. As three separate awaits, two signature requests arriving together
 * would both read the ticket unspent and both get a signature, one ticket,
 * two signed operations. Every spend queues behind the previous one; the
 * second in line finds the ticket already used.
 */
let ticketChain = Promise.resolve();
export function spendTicket({ orderId, now = Date.now() }) {
  const run = ticketChain.then(async () => {
    const stored = await readTicket();
    const ticket = ticketValid(stored, { orderId, now });
    if (!ticket.ok) throw new Error(`signature not issued: ${ticket.reason}`);
    // Written to ITS OWN key so tick() cannot overwrite it.
    await writeTicket({ ...stored, used: true });
    return stored;
  });
  ticketChain = run.catch(() => {});
  return run;
}

export async function signForRunner({ userOp, chainId, orderId }) {
  const state = await readState();
  const arm = armState(state, { now: Date.now() });
  if (!arm.armed) throw new Error(`the runner is not working: ${arm.reason}`);

  // The ticket is issued by tick() before it asks the page to assemble. It is
  // only LOOKED AT here; it is spent (atomically) right before signing, once
  // the operation has passed every check below.
  const stored = await readTicket();
  const ticket = ticketValid(stored, { orderId, now: Date.now() });
  if (!ticket.ok) throw new Error(`signature not issued: ${ticket.reason}`);

  const bag = await chrome.storage.local.get('orders');
  const order = (Array.isArray(bag.orders) ? bag.orders : [])
    .find((o) => o && typeof o === 'object' && o.id === orderId);
  if (!order) throw new Error('the order the ticket was issued for was not found');

  const verdict = verifyOperation({ userOp, order });
  if (!verdict.ok) throw new Error(`the operation does not match the order: ${verdict.reason}`);

  // The chain is part of the hash and comes from the page. A signature under
  // another chain is a signature under an operation we did not build.
  const orderChain = chainFromTokenId(order.inTokenId);
  if (orderChain && Number(chainId) !== orderChain) {
    throw new Error(`operation for chain ${chainId}, but the order is on chain ${orderChain}`);
  }

  // Third check: against the grant the owner issued to the key ON CHAIN. The
  // contract checks the same itself but answers with an opaque bundler error;
  // here the refusal gets a name before sending. A read failure does not
  // block: the node may be silent, and the last word is on-chain validation.
  try {
    const grant = await readGrant({
      chainId, account: order.sender, key: state.sessionKeyAddress, userOp,
    });
    if (grant) {
      const against = checkAgainstGrant({
        calls: grant.calls,
        grant: grant.session,
        isAllowed: grant.isAllowed,
        isFeeRecipient: grant.isFeeRecipient,
        tokenBudgetOf: grant.tokenBudgetOf,
        account: order.sender,
        now: Math.floor(Date.now() / 1000),
      });
      if (!against.ok) throw new Error(`the grant does not allow it: ${against.reason}`);
    }
  } catch (err) {
    // Our own refusal propagates, a foreign read failure does not.
    if (String(err?.message || '').startsWith('the grant does not allow it')) throw err;
  }

  // Our own hash, from the same bytes that go to the bundler.
  const hash = userOpHash({ userOp, chainId });

  // The ticket is spent BEFORE signing, and atomically: a second request for
  // the same order that raced this far is refused here. If the signature
  // fails, a retry goes through a new round and a new ticket.
  await spendTicket({ orderId });

  return signWithSessionKey(hash);
}

/**
 * Reads the grant for a SPECIFIC plan: the session and exactly the pairs the
 * plan asks for. Separate from readGrant, which derives the pairs from an
 * assembled operation; here nothing is assembled yet.
 */
async function readGrantFor(key, chainId, account, plan) {
  const view = async (functionName, args) => {
    const data = encodeFunctionData({ abi: SESSION_VIEW_ABI, functionName, args });
    const raw = await ethCall(chainId, { to: account, data });
    return decodeFunctionResult({ abi: SESSION_VIEW_ABI, functionName, data: raw });
  };
  const session = await view('getSession', [key]);
  const allowed = new Map();
  const feeRecipients = new Map();
  const tokenBudgets = new Map();
  if (session?.exists) {
    for (let i = 0; i < plan.targets.length; i += 1) {
      const pair = `${plan.targets[i]}|${plan.selectors[i]}`;
      if (!allowed.has(pair)) {
        allowed.set(pair, Boolean(await view('isAllowedCall', [key, plan.targets[i], plan.selectors[i]])));
      }
    }
    for (const to of plan.feeRecipients) {
      feeRecipients.set(to, Boolean(await view('isFeeRecipient', [key, to])));
    }
    // The approve caps live per token (contract v2); each token of the plan
    // is asked for its own.
    for (const cap of plan.tokenCaps ?? []) {
      tokenBudgets.set(cap.token, await view('tokenBudget', [key, cap.token]));
    }
    // The router's pair is granted by the contract from the swap spec rather
    // than listed, so it is read from the session itself, not asked about.
  }
  return { session, allowed, feeRecipients, tokenBudgets };
}

/**
 * Reads the grant issued to the key straight from the chain. Returns null when
 * it could not be read: diagnostics must not become a new reason to refuse.
 */
async function readGrant({ chainId, account, key, userOp }) {
  if (!key || !account) return null;

  const view = async (functionName, args) => {
    const data = encodeFunctionData({ abi: SESSION_VIEW_ABI, functionName, args });
    const raw = await ethCall(chainId, { to: account, data });
    return decodeFunctionResult({ abi: SESSION_VIEW_ABI, functionName, data: raw });
  };

  // The batch is decoded with the same decoder as the verifier.
  const decoded = decodeBatch(userOp.callData);
  if (!decoded.calls) return null;
  const { calls } = decoded;

  const session = await view('getSession', [key]);

  // Pairs and recipients are asked once per unique value: the round runs
  // inside the signing window and spare calls are not wanted.
  const allowedCache = new Map();
  const recipientCache = new Map();
  const budgetCache = new Map();
  for (const call of calls) {
    const target = String(call.target).toLowerCase();
    const selector = String(call.data ?? '').slice(0, 10).toLowerCase();
    const pair = `${target}:${selector}`;
    if (!allowedCache.has(pair)) {
      allowedCache.set(pair, await view('isAllowedCall', [key, target, selector]));
    }
    if (selector === '0xa9059cbb') {
      const to = `0x${String(call.data).replace(/^0x/, '').slice(32, 72)}`.toLowerCase();
      if (!recipientCache.has(to)) {
        recipientCache.set(to, await view('isFeeRecipient', [key, to]));
      }
    }
    if (selector === '0x095ea7b3' && !budgetCache.has(target)) {
      budgetCache.set(target, await view('tokenBudget', [key, target]));
    }
    // The swap names the tokens it will pull, and those are the budgets the
    // contract charges; an approve need not even be present.
    if (target === String(session?.swapRouter ?? '').toLowerCase() && selector === String(session?.swapSelector ?? '').toLowerCase()) {
      const args = parseSwapArgs(call.data);
      for (const token of args?.tokens ?? []) {
        if (!budgetCache.has(token)) budgetCache.set(token, await view('tokenBudget', [key, token]));
      }
    }
  }

  return {
    session,
    calls: calls.map((c) => ({ target: c.target, data: c.data })),
    isAllowed: (target, selector) => Boolean(allowedCache.get(`${target}:${selector}`)),
    isFeeRecipient: (to) => Boolean(recipientCache.get(to)),
    tokenBudgetOf: (token) => budgetCache.get(String(token).toLowerCase()) ?? null,
  };
}

/**
 * Heartbeat of the live-price watcher.
 *
 * While it is fresh the scheduled round does NOT quote: the ticks watch the
 * price and a quote is needed only at a crossing. The heartbeat is
 * accumulated PER ORDER rather than replaced as a whole: every open tab
 * beats, each sees only its own token, and a whole-list replacement would make
 * two tabs erase each other's coverage. Orders not confirmed for longer than the
 * freshness window drop out on their own, which is how a closed tab leaves
 * the coverage.
 */
export function watchdog(args = {}) {
  // Queued behind a running round: an unqueued beat would read the state and
  // write it back over the round's log and attempts a moment later.
  return queued(() => watchdogUnlocked(args));
}

async function watchdogUnlocked({ levels = 0, ids = [] } = {}) {
  const state = await readState();
  const now = Date.now();
  state.watchdogAt = now;
  state.watchdogLevels = Number(levels) || 0;

  const seen = { ...(state.watchdogSeen ?? {}) };
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string') seen[id] = now;
  }
  for (const [id, at] of Object.entries(seen)) {
    if (now - Number(at) > WATCHDOG_FRESH_MS) delete seen[id];
  }
  state.watchdogSeen = seen;
  // The older field is kept for state written by earlier builds.
  state.watchdogIds = Object.keys(seen);
  await writeState(state);
  return { ok: true };
}

/**
 * A line in the journal from the page: the quick buy reports its outcome here
 * so the executor's log stays the one place that tells what the extension did
 * with money. Text only; nothing is executed.
 */
export async function note({ text } = {}) {
  const line = String(text ?? '').slice(0, 300);
  if (!line) return { ok: false };
  // Queued like the heartbeat: a journal line is a write of the same state.
  return queued(async () => {
    const state = await readState();
    state.log = trimLog([...(state.log ?? []), logEntry({ act: 'note', reason: line, now: Date.now() })]);
    await writeState(state);
    return { ok: true };
  });
}

/**
 * Nudge from the live-price watcher: check an order now. The scheduled round
 * wakes once a minute and needs three samples, i.e. up to three minutes late
 * by design. The chart feed sees the crossing within seconds and has already
 * confirmed it over several ticks, so ONE quote is enough here: the quote is
 * still the source of truth for execution, the watcher only says when to ask.
 *
 * The trade-off is named: the chart confirms the market-cap LEVEL, not the
 * quote, and one quote can be an outlier. What guards against that is not a
 * second sample but the quote itself being rejected when it is not a number
 * (below), the impact wait before the send, and the guard floor in the batch.
 * Two confirmations here would cost a burst poll on every crossing, which on a
 * fast move is the difference between filling and missing.
 */
export async function nudge({ orderId } = {}) {
  if (!orderId) return { acted: false, reason: 'nudge without an order' };
  const result = await tick({ now: Date.now(), onlyOrderId: orderId, confirmations: 1 });
  scheduleBurst(orderId, result);
  return result;
}

/**
 * Quote burst after a crossing.
 *
 * The price touched the level but the first quote did not confirm the target:
 * on a small order the relay fee makes quotes swing a few percent around it.
 * Waiting for the minute alarm turned that into six minutes. Instead the
 * order is quoted again every few seconds, up to BURST.polls in all, each
 * time with one confirmation: the first quote at or past the target fires.
 * The burst stops as soon as the order is anything but "watch".
 */
const BURST = Object.freeze({ polls: 5, everyMs: 6_000 });
const bursts = new Map();

function watchEntry(result, orderId) {
  return (result?.entries ?? []).find((e) => e?.orderId === orderId && e?.act === 'watch');
}

function scheduleBurst(orderId, result) {
  if (!watchEntry(result, orderId)) { bursts.delete(orderId); return; }
  const burst = bursts.get(orderId) ?? { left: BURST.polls - 1, timer: null };
  if (burst.timer) return;
  if (burst.left <= 0) { bursts.delete(orderId); return; }
  burst.left -= 1;
  burst.timer = setTimeout(async () => {
    burst.timer = null;
    try {
      const again = await tick({ now: Date.now(), onlyOrderId: orderId, confirmations: 1 });
      scheduleBurst(orderId, again);
    } catch {
      bursts.delete(orderId);
    }
  }, BURST.everyMs);
  bursts.set(orderId, burst);
}

/**
 * The session key is created ON ITS OWN, without a click. Generating a key
 * pair is safe and opens nothing: rights come only with the on-chain grant,
 * issued when an order is placed. If the secret exists but the address was
 * lost, the address is derived from the secret rather than a new key created,
 * which would leave the on-chain grant orphaned.
 */
export async function ensureSessionKey() {
  const state = await readState();
  const secret = await readSecret();
  if (state.sessionKeyAddress && secret) return { address: state.sessionKeyAddress };
  if (secret) {
    try {
      state.sessionKeyAddress = privateKeyToAccount(secret).address;
      state.armed = false;
      state.armedUntil = 0;
      await writeState(state);
      return { address: state.sessionKeyAddress };
    } catch { /* a broken secret, create a new one below */ }
  }
  return createSessionKey({ replace: false }).catch(async () => ({
    address: (await readState()).sessionKeyAddress,
  }));
}

// ------------------------------------------------------------ key rotation
//
// Every grant renewal goes to a NEW session key. A grant to the same address
// would hand a stolen key its rights back with every renewal; a new key
// leaves the stolen one to expire with the grant it had. The steps:
//
//   1. the plan for a chain finds the current key's grant due for renewal
//      and no rotation running: a next key is created and kept under its own
//      storage key; the plan asks for the grant on the NEXT key, on this chain
//      and, as the panel walks them, on every chain with live orders;
//   2. once the next key has a session on every such chain it is promoted:
//      it becomes the signing key, the old secret is kept under
//      runner.secret.prev for one thing only, telling the hub who the owner is
//      now (daemon.js finishOwnerRotation), and the old ADDRESS is remembered
//      as retired per chain;
//   3. on each retired chain the next plan revokes the old key, in the grant
//      operation when one is due anyway, or as a revoke-only round otherwise;
//      the chain drops off the retired list when its session is seen gone.
//
// Until promotion the old key keeps signing and keeps its grant: nothing is
// revoked before its successor can sign everywhere. If the revoke never
// happens (the panel is never opened on that chain again), the old key dies
// with its grant's validUntil, which is the bound the rotation shortens.

const NEXT_SECRET_KEY = 'runner.secret.next';
const PREV_SECRET_KEY = 'runner.secret.prev';

/** Whether the session's expiry is inside the renewal window. */
function renewalDue(session, now) {
  const until = Number(session?.validUntil ?? 0) * 1000;
  return !until || until <= now + RENEW_BEFORE_MS;
}

/** Creates the next key, or returns the rotation already under way. */
async function beginRotation({ now = Date.now() } = {}) {
  return queued(async () => {
    const state = await readState();
    if (state.rotation?.next) return state.rotation;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const hex = `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const next = privateKeyToAccount(hex).address;
    await chrome.storage.local.set({ [NEXT_SECRET_KEY]: hex });
    state.rotation = { next, startedAt: now };
    state.log = trimLog([...(state.log ?? []), logEntry({ act: 'note', reason: `session key rotation started: ${next} will replace ${state.sessionKeyAddress}`, now })]);
    await writeState(state);
    return state.rotation;
  });
}

/** Whether `key` has a session on the account on this chain. Throws when the node does not answer. */
async function sessionExists(chainId, account, key) {
  const data = encodeFunctionData({ abi: SESSION_VIEW_ABI, functionName: 'getSession', args: [key] });
  const raw = await ethCall(chainId, { to: account, data });
  return Boolean(decodeFunctionResult({ abi: SESSION_VIEW_ABI, functionName: 'getSession', data: raw })?.exists);
}

/**
 * Promotes the next key once it is granted on every chain with live orders.
 * Returns true when the promotion happened in this call.
 */
async function promoteRotationIfGranted({ rotation, sender, now = Date.now() }) {
  const chains = await orderChains();
  for (const c of chains) {
    let ok = false;
    try { ok = await sessionExists(c, sender, rotation.next); } catch { return false; }
    if (!ok) return false;
  }
  return queued(async () => {
    const bag = await chrome.storage.local.get([SECRET_KEY, NEXT_SECRET_KEY]);
    const nextSecret = bag[NEXT_SECRET_KEY];
    const state = await readState();
    if (!nextSecret || state.rotation?.next !== rotation.next) return false;
    const old = state.sessionKeyAddress;
    await chrome.storage.local.set({ [PREV_SECRET_KEY]: bag[SECRET_KEY], [SECRET_KEY]: nextSecret });
    await chrome.storage.local.remove(NEXT_SECRET_KEY);
    state.sessionKeyAddress = rotation.next;
    state.rotation = null;
    state.retired = old ? { key: String(old).toLowerCase(), chains } : null;
    state.log = trimLog([...(state.log ?? []), logEntry({ act: 'note', reason: `session key rotated: ${rotation.next} signs from now on, ${old} is revoked on the next grant round of each chain`, now })]);
    await writeState(state);
    return true;
  });
}

/** Drops a chain from the retired list once the old key's session is gone there. */
async function forgetRetired(chainId) {
  await queued(async () => {
    const state = await readState();
    if (!state.retired) return;
    const chains = (state.retired.chains ?? []).filter((c) => c !== chainId);
    state.retired = chains.length ? { ...state.retired, chains } : null;
    await writeState(state);
  });
}

/**
 * Whether the live orders need a grant, and what exactly to request.
 *
 * Computed HERE, not on the page, because the orders live here and the chain
 * is read from here. The page only CARRIES the request to Privy and the
 * bundler; it is the only path to them.
 */
/**
 * Whether the live orders can actually EXECUTE, read from the chain.
 *
 * A signing envelope for this wallet is the smallest part of the truth, and
 * not enough to say "orders available". An order needs the wallet delegated
 * to our contract on ITS chain and a session grant that covers it, and either
 * can be missing while the envelope is perfect.
 *
 * Read-only on purpose: no intents are issued and nothing is written, so the
 * popup may call it as often as it likes. `grantPlan` remains the thing that
 * ACTS; this only looks.
 *
 * @returns {Promise<{ok: boolean, code: string, reason: string|null}>}
 *   `ok` with code 'idle' means there is nothing to execute, not a fault.
 */
export async function readiness({ now = Date.now() } = {}) {
  const settingsBag = await chrome.storage.local.get('settings');
  const settings = settingsBag.settings ?? {};
  if (settings.ordersEnabled !== true) return { ok: false, code: 'off', reason: t('ready.off') };

  const bag = await chrome.storage.local.get('orders');
  const live = (bag.orders ?? []).filter((o) => o?.status === 'watching');
  if (!live.length) return { ok: true, code: 'idle', reason: null };

  // EVERY chain that has live orders, not just the newest order's.
  //
  // Delegation and the grant are per chain, the chain id is inside the
  // authorization the owner signs, and the grant lives in the account's
  // storage on that chain. The planner works on one chain at a time (the
  // newest order's), so orders on a second chain can be unexecutable while
  // the first is perfect. A lamp that looked at one chain would go green over
  // exactly that.
  const byChain = new Map();
  for (const o of live) {
    const chainId = chainFromTokenId(o?.inTokenId);
    // Solana orders need no contract at all: they are signed by Privy on
    // Solana, with no delegation, no session key and no grant to check.
    if (!chainId || chainId === SOLANA_NETWORK_ID) continue;
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(o);
  }
  if (!byChain.size) return { ok: true, code: 'solana', reason: null };

  const problems = [];
  for (const [chainId, orders] of byChain) {
    const verdict = await chainReadiness(chainId, orders, now);
    if (!verdict.ok) problems.push(verdict);
  }
  if (!problems.length) return { ok: true, code: 'ready', reason: null };
  // One chain broken: its own words. Several: all of them, because fixing one
  // would otherwise turn the lamp green with the other still dead.
  if (problems.length === 1) return problems[0];
  return {
    ok: false,
    code: problems[0].code,
    reason: problems.map((p) => p.reason).join(' '),
  };
}

/** One chain's verdict: is the wallet delegated there, and does the grant cover these orders. */
async function chainReadiness(chainId, orders, now) {
  const sender = orders.find((o) => o?.sender)?.sender ?? null;
  if (!sender) return { ok: false, code: 'no-wallet', reason: t('ready.noWallet') };

  const where = CHAINS[chainId]?.name ?? `chain ${chainId}`;
  const ourDelegate = delegateFor(chainId);
  if (!ourDelegate) return { ok: false, code: 'no-contract', reason: t('ready.noContract', { chain: where }) };

  const guardSpec = guardSpecFor(chainId);
  if (!guardSpec) return { ok: false, code: 'no-guard', reason: t('ready.noContract', { chain: where }) };

  let plan;
  try {
    plan = planGrant(orders, {
      router: RELAY_ROUTER, swapSelector: RELAY_SWAP_SELECTOR, guard: guardSpec, chainId, now,
      solanaAddress: orders.find((o) => o?.solanaAddress)?.solanaAddress ?? null,
    });
  } catch (err) {
    return { ok: false, code: 'no-plan', reason: String(err?.message || err) };
  }
  if (!plan) return { ok: true, code: 'idle', reason: null };

  // The chain is the authority here, not anything this worker remembers.
  let delegate = null;
  try {
    delegate = delegateFromCode(await ethGetCode(chainId, sender));
  } catch (err) {
    return { ok: false, code: 'node', reason: t('ready.node', { error: String(err?.message || err) }) };
  }
  if (String(delegate ?? '').toLowerCase() !== ourDelegate.toLowerCase()) {
    return { ok: false, code: 'not-delegated', reason: t('ready.notDelegated', { chain: where }) };
  }

  const { address: key } = await ensureSessionKey();
  let grant;
  try {
    grant = await readGrantFor(key, chainId, sender, plan);
  } catch (err) {
    return { ok: false, code: 'node', reason: t('ready.node', { error: String(err?.message || err) }) };
  }
  const covers = grantCovers(grant.session, plan, {
    now,
    isAllowed: (target, sel) => grant.allowed.get(`${target}|${sel}`) === true,
    isFeeRecipient: (to) => grant.feeRecipients.get(to) === true,
    tokenBudgetOf: (token) => grant.tokenBudgets.get(token) ?? null,
  });
  if (!covers.ok) {
    return {
      ok: false,
      code: 'no-grant',
      reason: t('ready.noGrant', { chain: where, missing: (covers.missing ?? []).join('; ') }),
    };
  }
  return { ok: true, code: 'ready', reason: null };
}

/**
 * The chains that have live EVM orders, newest order first.
 *
 * A grant lives on ONE chain, the chain id is inside the authorization the
 * owner signs, and the grant sits in the account's storage there, so a
 * wallet trading on two chains needs two of them. `grantPlan` plans one chain
 * per call; this says which calls are owed.
 */
export async function orderChains() {
  const bag = await chrome.storage.local.get('orders');
  const live = (bag.orders ?? []).filter((o) => o?.status === 'watching');
  const seen = [];
  for (const o of live) {
    const chainId = chainFromTokenId(o?.inTokenId);
    // Solana needs no contract: signed by Privy, no delegation and no grant.
    if (!chainId || chainId === SOLANA_NETWORK_ID) continue;
    if (!seen.includes(chainId)) seen.push(chainId);
  }
  return seen;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.now] ms
 * @param {number} [opts.chainId] plan for THIS chain instead of the newest
 *   order's. The caller walks `orderChains()` so that a second chain is not
 *   left un-granted while the first looks perfect.
 */
export async function grantPlan({ now = Date.now(), chainId: wantChain = null } = {}) {
  const settingsBag = await chrome.storage.local.get('settings');
  const settings = settingsBag.settings ?? {};
  // Grant and delegation only with orders switched on.
  if (settings.ordersEnabled !== true) {
    return { needed: false, reason: 'limit orders are switched off in the popup' };
  }
  const { address: current } = await ensureSessionKey();
  if (!current) return { needed: false, reason: 'no key and none could be created' };
  const keyState = await readState();
  let rotation = keyState.rotation?.next ? keyState.rotation : null;
  let key = rotation?.next ?? current;

  // A runner browser issues no grants of its own. The hub reports its key
  // as the one to grant, and the OWNER's browser grants it in its plan; two
  // browsers granting at once from one account under one nonce key collide
  // at the EntryPoint (AA25) and one of them fails for nothing.
  //
  // Unless the owner is HEADLESS: a program on the hub (a bot) that holds no
  // Privy session and cannot sign anything. The hub says so on every poll
  // (mirror.js keeps it in settings.mirror.ownerHeadless), and then this
  // browser is the only one that can grant, so it plans for its own key and
  // background/headless-grant.js carries the plan to the page.
  if (autonomousOn(settings) && settings.mirrorEnabled && settings.mirror?.url && settings.mirror?.ownerHeadless !== true) {
    return { needed: false, reason: 'this browser executes for another one; the owner\'s browser issues the grants' };
  }

  const bag = await chrome.storage.local.get('orders');
  const live = (bag.orders ?? []).filter((o) => o?.status === 'watching');
  if (!live.length) return { needed: false, reason: 'no live orders, nothing to grant' };

  // The grant lives on ONE chain: the contract is deployed on 4663 and the
  // grant is read and issued on the account there. Orders on other chains
  // are not part of this plan. The plan follows the NEWEST order's chain:
  // `orders.add` puts it first and the plan is requested at placement.
  const chainId = wantChain ?? chainFromTokenId(live[0]?.inTokenId);
  if (!chainId) return { needed: false, reason: 'the order names no chain, nothing to grant on' };
  // Solana sells take no part in any of this: they are signed by Privy on
  // Solana, with no delegation, no session key and no grant. Asking for a
  // grant on their network id would answer "the settlement token is not
  // described there", which reads as a fault and is not one.
  if (chainId === SOLANA_NETWORK_ID) {
    return { needed: false, reason: 'Solana orders are signed on Solana, no grant is involved' };
  }
  const orders = live.filter((o) => chainFromTokenId(o?.inTokenId) === chainId);
  if (!orders.length) return { needed: false, reason: `no live orders on chain ${chainId}` };
  // The grant names the execution template, guard, settlement token,
  // depository, and the contract refuses approve without it. A chain whose
  // settlement token is not described gets no grant, said in words.
  const guardSpec = guardSpecFor(chainId);
  if (!guardSpec) {
    const name = CHAINS[chainId]?.name ?? `chain ${chainId}`;
    return {
      needed: false,
      blocked: true,
      reason: `auto-execution of sells is not available on ${name}, the output guard's settlement token is not described there. Buys are checked by a different route (Robinhood, Base)`,
    };
  }
  const plan = planGrant(orders, {
    solanaAddress: orders.find((o) => o?.solanaAddress)?.solanaAddress ?? null,
    router: RELAY_ROUTER, swapSelector: RELAY_SWAP_SELECTOR, guard: guardSpec, chainId, now,
  });
  if (!plan) return { needed: false, reason: 'no live orders, nothing to grant' };

  const sender = orders.find((o) => o?.sender)?.sender ?? null;
  if (!sender) return { needed: false, reason: 'the orders carry no wallet address' };

  // Delegation is checked FIRST. `grantSession` lives in OUR contract; while
  // the wallet is delegated to FOMO's Simple7702Account the method does not
  // exist and the grant dies with an opaque bundler error.
  let delegate = null;
  try {
    delegate = delegateFromCode(await ethGetCode(chainId, sender));
  } catch (err) {
    return { needed: false, reason: `the delegate could not be read: ${String(err?.message || err)}` };
  }
  // Not our delegate is not a refusal but one more job done for the user: the
  // authorization travels inside the same operation as the grant. The
  // EntryPoint applies it before validation, so by `grantSession` the account
  // already runs our code.
  const ourDelegate = delegateFor(chainId);
  if (!ourDelegate) {
    const name = CHAINS[chainId]?.name ?? `chain ${chainId}`;
    return {
      needed: false,
      blocked: true,
      reason: `auto-execution of sells is not available on ${name}, the limil account contract is not deployed there. Buys are checked by a different route (Robinhood, Base)`,
    };
  }
  const needsDelegation = String(delegate ?? '').toLowerCase() !== ourDelegate.toLowerCase();

  // A delegation changes the wallet's code, and its consent is the Limit
  // orders switch in the popup, a control on the extension's own surface,
  // checked at the top of this function. The page cannot flip it, and with it
  // off no plan is made, so the MAIN world has nothing to sign.

  // The contract has to EXIST on this chain. Delegating to an address without
  // code turns the wallet into an account that answers nothing: the bundler
  // reports it as "AA23 reverted 0x", which tells the user nothing. Said here
  // in words instead, before any signature is asked for.
  if (needsDelegation) {
    let deployed = false;
    try {
      deployed = String(await ethGetCode(chainId, ourDelegate) ?? '0x').length > 2;
    } catch (err) {
      return { needed: false, reason: `the contract could not be checked on chain ${chainId}: ${String(err?.message || err)}` };
    }
    if (!deployed) {
      const name = CHAINS[chainId]?.name ?? `chain ${chainId}`;
      return {
        needed: false,
        blocked: true,
        reason: `auto-execution of sells is not available on ${name} yet, the limil account contract is not deployed there. `
          + 'Buys are checked by a different route (Robinhood, Base)',
      };
    }
  }

  let grant = null;
  try {
    grant = needsDelegation
      ? { session: { exists: false }, allowed: new Map(), feeRecipients: new Map(), tokenBudgets: new Map() }
      : await readGrantFor(key, chainId, sender, plan);
  } catch (err) {
    // The node did not answer. Issuing blindly is not an option: it is a
    // signature that changes rights.
    return { needed: false, reason: `the grant could not be read: ${String(err?.message || err)}` };
  }
  const coversOf = (g) => grantCovers(g.session, plan, {
    now,
    isAllowed: (target, sel) => g.allowed.get(`${target}|${sel}`) === true,
    isFeeRecipient: (to) => g.feeRecipients.get(to) === true,
    tokenBudgetOf: (token) => g.tokenBudgets.get(token) ?? null,
  });
  let covers = needsDelegation ? { ok: false, missing: ['the wallet is not delegated yet'] } : coversOf(grant);
  // A renewal goes to a NEW key (see "key rotation" above): the current key
  // has a session here and it is inside the renewal window, so the next key
  // is created and this plan asks for ITS grant instead.
  if (!rotation && !needsDelegation && grant?.session?.exists && renewalDue(grant.session, now)) {
    rotation = await beginRotation({ now });
    key = rotation.next;
    try {
      grant = await readGrantFor(key, chainId, sender, plan);
    } catch (err) {
      return { needed: false, reason: `the grant could not be read: ${String(err?.message || err)}` };
    }
    covers = coversOf(grant);
  }
  // The next key is granted here; when it is granted on every chain with
  // live orders it takes over, and the old key is queued for revocation.
  if (rotation && covers.ok && await promoteRotationIfGranted({ rotation, sender, now })) {
    rotation = null;
  }
  // The retired key of a past rotation: revoked on this chain with the next
  // grant, or in a round of its own when no grant is due.
  const retiredState = await readState();
  let retire = retiredState.retired?.key && (retiredState.retired.chains ?? []).includes(chainId) ? retiredState.retired.key : null;
  if (retire) {
    let stillThere = true;
    try { stillThere = await sessionExists(chainId, sender, retire); } catch { stillThere = true; }
    if (!stillThere) { await forgetRetired(chainId); retire = null; }
  }
  // The daemon's key, when one is paired: same plan, second grant. Read
  // separately so a covered extension key does not hide a missing daemon
  // grant, and a missing daemon grant alone still makes the plan needed,
  // with an empty main part.
  // The server's key is granted only in autonomous mode: local-only means no
  // second key on the wallet either.
  const daemonKey = autonomousOn(settings) && settings.daemonEnabled ? (settings.daemon?.sessionKey ?? null) : null;
  // Both keys get the SAME grant. A narrower guard for a daemon executing on
  // its own, one measuring the wallet instead of relay's depository, would
  // need a mode that sells outside FOMO's pipeline and costs the PnL entry.
  // Everything executes in a browser, cross-chain, so the depository is what
  // the guard can watch.
  let extra = [];
  if (daemonKey && String(daemonKey).toLowerCase() !== String(key).toLowerCase()) {
    let dgrant = null;
    try {
      dgrant = needsDelegation
        ? { session: { exists: false }, allowed: new Map(), feeRecipients: new Map(), tokenBudgets: new Map() }
        : await readGrantFor(daemonKey, chainId, sender, plan);
    } catch { dgrant = null; }
    const dcovers = !dgrant ? { ok: true } : (needsDelegation ? { ok: false, missing: ['the wallet is not delegated yet'] } : grantCovers(dgrant.session, plan, {
      now,
      isAllowed: (target, sel) => dgrant.allowed.get(`${target}|${sel}`) === true,
      isFeeRecipient: (to) => dgrant.feeRecipients.get(to) === true,
      tokenBudgetOf: (token) => dgrant.tokenBudgets.get(token) ?? null,
    }));
    if (!dcovers.ok) extra = [{ key: daemonKey, missing: dcovers.missing }];
  }
  if (covers.ok && !extra.length && !retire) return { needed: false, reason: 'the grant covers the orders' };

  const limitsJson = {
    validUntil: plan.validUntil,
    maxOps: plan.maxOps,
    maxValuePerCall: plan.maxValuePerCall.toString(),
    valueBudget: plan.valueBudget.toString(),
    feeBudget: plan.feeBudget.toString(),
    maxFeePerOp: plan.maxFeePerOp.toString(),
  };
  const tokenCapsJson = plan.tokenCaps.map((c) => ({
    token: c.token,
    maxPerOp: c.maxPerOp.toString(),
    budget: c.budget.toString(),
    minOutPerUnit: c.minOutPerUnit.toString(),
  }));
  // Migration from the first contract version: its grants survive the change
  // of code in its own storage, so every key this wallet holds is revoked
  // THERE first, in the same round, before the new delegation is applied.
  const revokeFirst = [...new Set([
    ...(isLegacyDelegate(delegate) ? [key, daemonKey].filter(Boolean) : []),
    ...(retire ? [retire] : []),
  ].map((k) => String(k).toLowerCase()))];
  // Nothing but the retired key to do on this chain: a revoke-only round.
  const revokeOnly = Boolean(retire) && covers.ok && !extra.length && !needsDelegation;
  const shared = {
    sender, chainId, limits: limitsJson, tokenCaps: tokenCapsJson, guard: plan.guard, swap: plan.swap,
    targets: plan.targets, selectors: plan.selectors, feeRecipients: plan.feeRecipients,
  };
  const params = { ...shared, key, revokeFirst, revokeOnly };
  const mainNeeded = !covers.ok || revokeOnly;

  // One-time intents, one per signature the page is about to ask for. The
  // MAIN world hands each back with the parameters, and this worker spends it
  // only if the parameters still hash the same (background/intent.js).
  const intents = {
    delegation: needsDelegation ? await issueIntent({ kind: 'delegate', params: { sender, chainId, delegate: ourDelegate } }) : null,
    grant: (mainNeeded || needsDelegation) ? await issueIntent({ kind: 'grant', params }) : null,
  };
  const extraOut = [];
  for (const e of extra) {
    // The legacy revoke rides with the FIRST operation of the round only.
    // The SAME field set as the main round: the page rebuilds the params from
    // what it receives and the intent is spent only if they hash the same, so a
    // field present on one side and absent on the other refuses the grant.
    const p = { ...shared, key: e.key, revokeFirst: [], revokeOnly: false };
    extraOut.push({ ...p, missing: e.missing, intent: await issueIntent({ kind: 'grant', params: p }) });
  }

  return {
    needed: true,
    // The extension key's own grant may already be fine while the daemon's is not.
    mainNeeded,
    extra: extraOut,
    missing: covers.missing ?? [],
    // Delegation is a separate field: only the page can sign it through Privy,
    // but the worker is the one that knows it is needed.
    delegation: needsDelegation ? { delegate: ourDelegate, from: delegate } : null,
    params,
    intents,
  };
}

/**
 * Makes sure the alarm exists on every worker start, as long as a session key
 * exists. Only when it does not exist yet: `chrome.alarms.create` with an
 * existing name cancels and replaces that alarm, which restarts its period,
 * and this worker is started by the watcher's heartbeat every half minute,
 * re-created each time, the minute alarm never reached its minute.
 */
export async function restoreAlarm() {
  const state = await readState();
  if (!armState(state, { now: Date.now() }).armed) return;
  let existing = null;
  try { existing = await chrome.alarms.get?.(ALARM); } catch { /* treated as absent */ }
  if (existing) return;
  await chrome.alarms.create(ALARM, { periodInMinutes: RUNNER_LIMITS.pollMinutes });
}

export const RUNNER_ALARM = ALARM;
