// Service worker: all network and all storage. The page runs under the
// fomo.family CSP and cannot reach RPC nodes itself, so chain requests live here.

import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { ENTRY_POINT_V08, SOLANA_NETWORK_ID, rpcUrl } from '../shared/chains.js';
import { routeSupported } from '../shared/route-check.js';
import { ENTRY_POINT_ABI, ERC20_ABI } from '../shared/userop.js';
import { initLocale, t } from '../shared/i18n.js';
import {
  installOrderMirror, pair as daemonPair, pull as daemonPull, runnerPairing as daemonRunnerPairing, status as daemonStatus, unpair as daemonUnpair,
} from './daemon.js';
import { ethCall } from './rpc.js';
import { install as installSelfUpdate } from './selfupdate.js';
import {
  ensureLoop as mirrorLoop, install as installMirror, pair as mirrorPair, pull as mirrorPull, status as mirrorStatus, unpair as mirrorUnpair,
} from './mirror.js';
import {
  RUNNER_ALARM, ensureSessionKey, grantPlan as runnerGrantPlan, note as runnerNote, nudge, orderChains as runnerOrderChains, readiness as runnerReadiness, restoreAlarm, runnerInfo, runnerStatus, signForRunner, solanaRpc, tick as runnerTick, watchdog,
  markAttemptSent,
} from './runner.js';
import { INTENT_KINDS, consumeIntent, issueIntent } from './intent.js';
import { loadOrders, mutateOrders } from './orders-store.js';
import { gateSender, maskSettings, pickPageSettings, senderKind } from './senders.js';
import { redactSample } from '../shared/daemon-api.js';
import { findJwtPaths, replaceAtPaths } from '../shared/jwt.js';

/** Upper bound on accounts asked for in one Solana read: getMultipleAccounts takes 100. */
const SOLANA_MAX_ACCOUNTS = 100;

/**
 * Why an object handed to `orders.add` is not an order, or null when it is.
 *
 * Kept deliberately narrower than the panel's own validation (shared/orders.js
 * validateOrder): this is the last line, and it must accept every order the
 * panel builds today and the stored shapes older builds wrote. What it refuses
 * is the shapeless: no id, no sender, no token, an amount that is not a
 * positive integer, a status other than watching. And a buy on an EVM chain
 * the buy route check does not cover, which the runner could never sign.
 */
function orderProblem(order) {
  if (!order || typeof order !== 'object') return 'not an object';
  if (typeof order.id !== 'string' || !order.id || order.id.length > 80) return 'no usable id';
  if (order.status !== undefined && order.status !== 'watching') return `status ${String(order.status)} is not watching`;
  if (typeof order.sender !== 'string' || !order.sender) return 'no sender';
  if (typeof order.inTokenId !== 'string' || !order.inTokenId) return 'no input token';
  try {
    if (BigInt(order.amount) <= 0n) return 'amount is not positive';
  } catch {
    return 'amount is not an integer';
  }
  if (order.side === 'buy' && typeof order.outTokenId === 'string') {
    const chain = Number(order.outTokenId.split(':')[1]);
    if (Number.isInteger(chain) && chain !== SOLANA_NETWORK_ID && !routeSupported(chain)) {
      return t('order.err.buyRoute', { chain });
    }
  }
  return null;
}

const ACCOUNT_1271_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'magicValue', type: 'bytes4' }],
  },
];

const STORAGE = {
  sample: 'privy.sample',
};

const handlers = {
  async 'rpc.getNonce'({ chainId, sender, key }) {
    const data = encodeFunctionData({
      abi: ENTRY_POINT_ABI,
      functionName: 'getNonce',
      args: [sender, BigInt(key)],
    });
    const raw = await ethCall(chainId, { to: ENTRY_POINT_V08, data });
    const nonce = decodeFunctionResult({
      abi: ENTRY_POINT_ABI,
      functionName: 'getNonce',
      data: raw,
    });
    return nonce.toString();
  },

  async 'rpc.isValidSignature'({ chainId, account, hash, signature }) {
    const data = encodeFunctionData({
      abi: ACCOUNT_1271_ABI,
      functionName: 'isValidSignature',
      args: [hash, signature],
    });
    const raw = await ethCall(chainId, { to: account, data });
    // bytes4 arrives zero-padded to 32 bytes; decode rather than compare raw.
    return decodeFunctionResult({
      abi: ACCOUNT_1271_ABI,
      functionName: 'isValidSignature',
      data: raw,
    });
  },

  /** An ERC-20 balance straight from the chain; the page checks a sale by it when the bundler's receipt is missing. */
  async 'rpc.tokenBalance'({ chainId, token, owner }) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(token ?? '')) || !/^0x[0-9a-fA-F]{40}$/.test(String(owner ?? ''))) throw new Error('a token and an owner address are required');
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
    const raw = await ethCall(chainId, { to: token, data });
    return decodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', data: raw }).toString();
  },

  async 'rpc.getTransactionCount'({ chainId, address }) {
    const res = await fetch(rpcUrl(chainId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'latest'],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return BigInt(json.result).toString();
  },

  async 'rpc.getCode'({ chainId, address }) {
    const res = await fetch(rpcUrl(chainId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  },

  // Privy envelope sample: captured on the page, kept here so it survives
  // navigation and reloads.
  //
  // Kept WITHOUT its token. The envelope carries the Privy session JWT, and
  // a session key next to a live JWT is the one thing that lets a thief of
  // this storage trade: the key signs, the JWT opens FOMO's bundler, which
  // is the only one that pays the gas. So the token is cut out before the
  // sample is written (the same redaction the hub receives) and the page puts
  // its own live token back in at every use (privy-bridge.js refreshToken).
  // A sample whose redaction cannot be proven clean is not stored at all.
  async 'sample.save'({ sample }) {
    const redaction = redactSample(sample, { findJwtPaths, replaceAtPaths });
    if (!redaction.sample) {
      await runnerNote({ text: `signing envelope not stored: ${redaction.reason}` }).catch(() => {});
      return { stored: false, reason: redaction.reason };
    }
    // The wallet the envelope was captured from stays readable for the panel.
    const first = Array.isArray(sample?.params) ? sample.params[0] : null;
    const address = /^0x[0-9a-fA-F]{40}$/.test(String(first ?? '')) ? first : null;
    // `savedAt` lets a tab that already holds a sample tell which is newer.
    await chrome.storage.local.set({ [STORAGE.sample]: { ...redaction.sample, ...(address ? { params: [address] } : {}), savedAt: Date.now() } });
    return { stored: true };
  },

  async 'sample.load'() {
    const bag = await chrome.storage.local.get(STORAGE.sample);
    return bag[STORAGE.sample] ?? null;
  },

  async 'sample.clear'() {
    await chrome.storage.local.remove(STORAGE.sample);
    return true;
  },

  // ------------------------------------------------------------------ orders
  //
  // Every change below is a read-modify-write of one array in storage, and
  // this worker is not the only writer of it: the runner closes filled
  // orders, the daemon applies remote verdicts, the mirror merges the hub's
  // list. They all go through the one queue in `orders-store.js`, because two
  // that overlap leave the later write on top of a stale array, an order
  // that vanishes is never executed, an order that comes back is executed
  // after it was cancelled. Reads stay outside the queue: a list one write
  // stale is harmless, and queueing them would serialise the whole panel.
  async 'orders.list'() {
    return (await loadOrders()).filter((o) => o.status === 'watching');
  },

  /**
   * Adds an order. The shape is checked here, not only in the panel: the
   * panel runs in the page and a page script can reach this handler, so what
   * lands in the list has to be an order and has to be new. A duplicate id
   * returns the existing order rather than a second copy of it.
   */
  'orders.add': ({ order }) => {
    const problem = orderProblem(order);
    if (problem) throw new Error(`refused to add the order: ${problem}`);
    return mutateOrders((orders) => {
      const existing = orders.find((o) => o.id === order.id);
      if (existing) return { result: existing };
      const clean = { ...order, status: 'watching' };
      return { orders: [clean, ...orders], result: clean };
    });
  },

  /** Cancels every live order: with limit orders switched off there is nothing to execute them with. */
  'orders.cancelAll': ({ reason = null } = {}) => mutateOrders((current) => {
    let cancelled = 0;
    const orders = current.map((o) => {
      if (o.status !== 'watching') return o;
      cancelled += 1;
      return { ...o, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: reason };
    });
    return { orders, result: { cancelled } };
  }),

  'orders.cancel': ({ id, reason = null }) => mutateOrders((current) => ({
    orders: current.map(
      (o) => (o.id === id
        // The reason is kept: an order cancelled automatically otherwise looks lost.
        ? { ...o, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: reason }
        : o),
    ),
    result: true,
  })),

  /**
   * Balance and decimals of a Solana token straight from the chain. The panel
   * needs it when the FOMO balances response carries no decimals for a mint.
   */
  async 'solana.tokenBalance'({ owner, mint }) {
    if (!owner || !mint) throw new Error(t('bg.needOwnerMint'));
    const result = await solanaRpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let amount = 0n;
    let decimals = null;
    for (const item of result?.value ?? []) {
      const ta = item?.account?.data?.parsed?.info?.tokenAmount;
      if (!ta) continue;
      amount += BigInt(ta.amount ?? 0);
      if (decimals === null && Number.isInteger(ta.decimals)) decimals = ta.decimals;
    }
    return { amount: amount.toString(), decimals };
  },

  /**
   * Raw account data (base64) for the Solana transaction guard: address
   * lookup tables are resolved from it. Read-only.
   */
  async 'solana.accounts'({ addresses }) {
    if (!Array.isArray(addresses) || !addresses.length) throw new Error('addresses are required');
    if (addresses.length > SOLANA_MAX_ACCOUNTS) throw new Error(`at most ${SOLANA_MAX_ACCOUNTS} accounts per read`);
    const result = await solanaRpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
    return result?.value ?? [];
  },

  /**
   * Before-and-after account states for a transaction about to be signed
   * (shared/solana-guard.js). The node simulates it with signature checks
   * off; nothing is sent. Read-only.
   */
  /** Whether a sent transaction landed: the node's status for its signature, and its block height. Read-only. */
  async 'solana.signatureStatus'({ signature }) {
    if (typeof signature !== 'string' || !signature) throw new Error('a signature is required');
    const [statuses, blockHeight] = await Promise.all([
      solanaRpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]),
      solanaRpc('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null),
    ]);
    const entry = statuses?.value?.[0] ?? null;
    return { entry: entry ? { err: entry.err ?? null, confirmationStatus: entry.confirmationStatus ?? null, confirmations: entry.confirmations ?? null } : null, blockHeight };
  },

  async 'solana.simulate'({ tx, addresses }) {
    if (typeof tx !== 'string' || !tx) throw new Error('a base64 transaction is required');
    if (!Array.isArray(addresses) || !addresses.length) throw new Error('addresses are required');
    if (addresses.length > SOLANA_MAX_ACCOUNTS) throw new Error(`at most ${SOLANA_MAX_ACCOUNTS} accounts per simulation`);
    const before = await solanaRpc('getMultipleAccounts', [addresses, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const sim = await solanaRpc('simulateTransaction', [tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      encoding: 'base64',
      accounts: { encoding: 'jsonParsed', addresses },
    }]);
    const value = sim?.value ?? sim ?? {};
    return {
      pre: before?.value ?? [],
      post: value.accounts ?? [],
      err: value.err ?? null,
      logs: Array.isArray(value.logs) ? value.logs.slice(-12) : [],
    };
  },

  // One-time intents for privileged page operations (background/intent.js).
  // Issuing is for the extension's own contexts (this worker, the popup);
  // the MAIN world may only consume, and only with the exact parameters.
  async 'intent.issue'({ kind, params }) {
    if (!INTENT_KINDS.includes(kind)) throw new Error(`unknown intent kind "${kind}"`);
    return issueIntent({ kind, params });
  },
  'intent.consume': ({ id, kind, params }) => consumeIntent({ id, kind, params }),

  // The user's own hub (daemon/): pairing, status, verdicts. There is no
  // separate hub switch: autonomous mode off unpairs it (popup.js).
  'daemon.pair': ({ pairing }) => daemonPair({ pairing }),
  'daemon.unpair': () => daemonUnpair(),
  /** The command line that pairs a browser on the server; popup only. */
  'daemon.runnerPairing': () => daemonRunnerPairing(),
  'daemon.status': () => daemonStatus(),
  // Runner browser: this extension executes the orders of a paired laptop.
  'mirror.pair': ({ pairing }) => mirrorPair({ pairing }),
  'mirror.unpair': () => mirrorUnpair(),
  'mirror.status': () => mirrorStatus(),
  'mirror.pull': () => mirrorPull(),

  async 'settings.get'() {
    const bag = await chrome.storage.local.get('settings');
    return bag.settings ?? {};
  },

  async 'settings.set'({ settings }) {
    const bag = await chrome.storage.local.get('settings');
    const merged = { ...(bag.settings ?? {}), ...settings };
    await chrome.storage.local.set({ settings: merged });
    return merged;
  },

  // ------------------------------------------------------------------ runner
  //
  // The only place where the extension spends money without a person present.
  'runner.status': () => runnerStatus(),
  // Session key address and the sample window only: no journal internals.
  'runner.info': () => runnerInfo(),
  // Nudge from the live-price watcher: execution is still gated by the
  // ticket, the verifier and the grant; the nudge only speeds up the check.
  'runner.nudge': ({ orderId }) => nudge({ orderId }),
  // Journal line from the quick-buy buttons: text only, nothing is executed.
  'runner.note': ({ text }) => runnerNote({ text }),
  // The page is about to send a Solana transaction. It writes this on the
  // attempt marker so that a page which then goes silent, a closed tab, a lost
  // message port, is read as an outcome nobody knows rather than as "never
  // sent". It cannot create, cancel or alter an order; the worst a hostile
  // page does with it is retire an order of its own that was executing anyway.
  'runner.sending': ({ orderId, txHash }) => markAttemptSent({ orderId, txHash }),
  'runner.watchdog': (info) => watchdog(info ?? {}),
  // Grant plan for the live orders: computed here (orders and chain reads are
  // here), carried to Privy and the bundler by the page, which alone can reach them.
  'runner.grantPlan': ({ chainId = null } = {}) => runnerGrantPlan({ chainId }),
  /** Which chains owe a grant. One grant per chain; the panel walks them. */
  'runner.grantChains': () => runnerOrderChains(),
  // Read-only: what the CHAIN says about whether the live orders can execute.
  'runner.readiness': () => runnerReadiness(),
  // Signing with the session key. The private part stays here: the page
  // receives a signature, never the key. The whole operation is passed, not a
  // hash: the worker recomputes the hash and checks the contents.
  'runner.sign': ({ userOp, chainId, orderId }) => signForRunner({ userOp, chainId, orderId }),
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RUNNER_ALARM) return;
  // A runner browser catches up with the hub before quoting: new orders in, verdicts out.
  mirrorPull().catch(() => { /* shown in the popup */ });
  mirrorLoop().catch(() => {});
  // Errors are swallowed on purpose: one failed round must not take the
  // service worker down with it. Daemon verdicts first, so an order filled on
  // the server is closed before the runner looks at it.
  daemonPull().catch(() => { /* daemon off or unreachable */ })
    .then(() => runnerTick())
    .catch(() => { /* the reason is in the round's journal */ });
});

// The alarm does not outlive the process, so it is restored on every start of
// the service worker. The session key is created on its own: generating a key
// pair grants nothing; rights come only with the on-chain grant, which is
// issued when an order is placed. Order matters: the alarm is set only when a
// key exists, so it follows the key on first start.
initLocale().catch(() => { /* English stays */ });

/**
 * Extension storage holds the session key's private part and the Privy
 * envelope sample. By default `chrome.storage.local` is also
 * readable by this extension's content scripts, i.e. by code that runs in a
 * tab next to fomo.family's own. Content scripts need none of it directly,
 * they ask this worker, so the storage is closed to them. Chrome's flag is
 * remembered per extension install, but it is set on every start in case an
 * older build left it open.
 */
chrome.storage?.local?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch?.(() => { /* older Chrome */ });

/**
 * What content scripts need to know, they hear from here: the order list
 * changed (the panel redraws) and the interface language
 * changed (the panel relabels). Tabs without our script ignore the message.
 */
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  const notes = [];
  if (changes.orders) notes.push({ type: 'orders.changed' });
  // The envelope sample was refreshed by one tab: every other FOMO tab takes
  // it at once, so a signature made in one tab serves them all without a
  // reload. The stored sample carries no token; each tab puts its own in.
  if (changes[STORAGE.sample] && changes[STORAGE.sample].newValue) {
    notes.push({ type: 'sample.changed', payload: { sample: changes[STORAGE.sample].newValue } });
  }
  const lang = changes.settings?.newValue?.uiLang;
  if (lang && lang !== changes.settings?.oldValue?.uiLang) notes.push({ type: 'locale.changed', payload: { uiLang: lang } });
  if (!notes.length) return;
  chrome.tabs.query({ url: ['https://fomo.family/*', 'https://*.fomo.family/*'] })
    .then((tabs) => {
      for (const tab of tabs) for (const note of notes) chrome.tabs.sendMessage(tab.id, note).catch(() => { /* no script in this tab */ });
    })
    .catch(() => {});
});

/**
 * A pairing the popup started but could not finish: Chrome's host-permission
 * dialog closes the popup, and its script dies mid-await. The popup writes
 * the pairing string to settings before asking, and the moment the permission
 * lands here the pairing is completed from this side, which nothing closes.
 */
chrome.permissions?.onAdded?.addListener(async () => {
  const bag = await chrome.storage.local.get('settings');
  const s = bag.settings ?? {};
  for (const [key, run] of [['pendingDaemonPairing', daemonPair], ['pendingMirrorPairing', mirrorPair]]) {
    const pairing = s[key];
    if (!pairing) continue;
    // Claimed first so the popup, should it reopen in the meantime, does not pair twice.
    await chrome.storage.local.set({ settings: { ...s, [key]: null } });
    try {
      await run({ pairing });
    } catch (err) {
      // The refusal is kept for the popup to show on its next open.
      const again = (await chrome.storage.local.get('settings')).settings ?? {};
      await chrome.storage.local.set({ settings: { ...again, [`${key}Error`]: String(err?.message || err) } });
    }
  }
});

installOrderMirror();
installMirror();
installSelfUpdate();

ensureSessionKey()
  .catch(() => { /* created on the next start */ })
  .then(() => restoreAlarm())
  .catch(() => { /* no state yet on the first run */ });

/**
 * The one entry to everything above, and therefore the place where WHO is
 * asking has to matter.
 *
 * Every context of this extension reaches this listener: the popup, and the
 * content scripts that share a tab with fomo.family's own code. They are not
 * equally trusted. A content script must not read the server pairing, must
 * not mint the intents that authorise a delegation, and must not flip the switch that
 * consents to one; `senders.js` holds the list of what it may do instead.
 * The masking of settings happens here rather than in the handlers, so a new
 * handler cannot forget it.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  const handler = handlers[type];
  if (!handler) {
    sendResponse({ error: t('bg.unknownCommand', { type }) });
    return false;
  }
  const runtimeId = chrome.runtime?.id ?? null;
  const refusal = gateSender(type, sender, { runtimeId });
  if (refusal) {
    sendResponse({ error: refusal });
    return false;
  }
  const fromTab = senderKind(sender, { runtimeId }) === 'tab';
  let payload = msg.payload ?? {};
  // A tab writes its own panel state and nothing else.
  if (fromTab && type === 'settings.set') payload = { ...payload, settings: pickPageSettings(payload.settings) };
  Promise.resolve()
    .then(() => handler(payload))
    .then((result) => sendResponse({
      result: fromTab && (type === 'settings.get' || type === 'settings.set') ? maskSettings(result) : result,
    }))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});
