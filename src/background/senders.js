// Who may ask the worker for what.
//
// `chrome.runtime.onMessage` delivers messages from every context of this
// extension to one listener: the popup, the ISOLATED content scripts, and
// anything that ever runs inside them. Handing each of them the whole handler
// table would be wrong even though no web page reaches the API directly
// (there is no `externally_connectable`, and the MAIN world only speaks
// through the ISO allow-list): a content script is the part of the
// extension that shares a tab with hostile code, and it must not be able to
// read the server pairing, mint a grant intent, or flip the switch that consents to
// delegation. Storage access levels do not help here, the worker reads
// storage on the caller's behalf, so the answer has to be gated instead.
//
// Two questions, both answered here: WHICH commands a tab may send, and WHAT
// of the settings it may see and write.

/**
 * Commands a content script legitimately needs.
 *
 * Everything else is the popup's: minting intents, pairing a server,
 * cancelling every order at once,
 * and the full settings write. A command missing from this set is not a bug
 * to be papered over by adding it, check first whether a page context has
 * any business asking for it.
 */
const TAB_MAY_ASK = new Set([
  // Chain and Solana reads: the page runs under fomo.family's CSP and cannot
  // reach an RPC node itself.
  'rpc.getNonce',
  'rpc.isValidSignature',
  'rpc.getTransactionCount',
  'rpc.getCode',
  'rpc.tokenBalance',
  'solana.accounts',
  'solana.simulate',
  'solana.signatureStatus',
  'solana.tokenBalance',
  // The Privy envelope sample: captured on the page, stored by the worker.
  'sample.save',
  'sample.load',
  'sample.clear',
  // Orders: the panel adds and cancels its own.
  'orders.list',
  'orders.add',
  'orders.cancel',
  // The runner. `runner.sign` is additionally behind a one-time ticket and
  // the verification of the operation against the order; `grantPlan` only
  // plans and signs nothing.
  'runner.info',
  'runner.nudge',
  'runner.note',
  'runner.sending',
  'runner.readiness',
  'runner.watchdog',
  'runner.grantPlan',
  'runner.grantChains',
  'runner.sign',
  // Spending an intent the worker issued. Issuing stays with the popup.
  'intent.consume',
  // Settings: masked on the way out, key-filtered on the way in (below).
  'settings.get',
  'settings.set',
]);

/**
 * Settings a page context may READ. The list is the fields the panel
 * actually uses; everything else, the daemon and mirror blocks with their session keys
 * and pairing tokens, never leaves the worker for a tab.
 */
export const PAGE_SETTINGS_FIELDS = Object.freeze([
  'uiLang',
  'ordersEnabled',
  'quickBuyEnabled',
  'quickBuyAmounts',
  'quickSellPercent',
  'quickBuyConfirm',
  'panelCollapsed',
  'slippageBps',
  'lastRelaySlippageBps',
]);

/**
 * Settings a page context may WRITE: the panel's own interface state and the
 * tolerance relay reported. Deliberately NOT `ordersEnabled`, that switch is
 * the consent to delegation, and it belongs to the popup, a surface the page
 * cannot reach. Nor anything about a server.
 */
export const PAGE_SETTINGS_KEYS = Object.freeze([
  'panelCollapsed',
  'slippageBps',
  'lastRelaySlippageBps',
]);

/** Hosts whose tabs carry our content scripts (manifest `content_scripts`). */
const TAB_HOSTS = [/^https:\/\/([a-z0-9-]+\.)*fomo\.family$/i];

function hostAllowed(url) {
  try {
    return TAB_HOSTS.some((re) => re.test(new URL(String(url)).origin));
  } catch {
    return false;
  }
}

/**
 * What kind of context sent this message.
 *
 * A tab is recognised by `sender.tab`, which Chrome sets for content scripts
 * and never for an extension page; the popup and the worker's own pages have
 * none. The extension id is checked as well: it costs nothing and a message
 * from another extension is not something to answer at all.
 *
 * @returns {'tab'|'extension'|'foreign'}
 */
export function senderKind(sender, { runtimeId } = {}) {
  if (runtimeId && sender?.id && sender.id !== runtimeId) return 'foreign';
  if (sender?.tab) return hostAllowed(sender.url ?? sender.tab.url) ? 'tab' : 'foreign';
  return 'extension';
}

/**
 * Whether this sender may send this command. Returns null when it may, and
 * the refusal in words when it may not.
 */
export function gateSender(type, sender, { runtimeId } = {}) {
  const kind = senderKind(sender, { runtimeId });
  if (kind === 'foreign') return `"${type}" refused: the sender is not a context of this extension`;
  if (kind === 'extension') return null;
  if (!TAB_MAY_ASK.has(type)) return `"${type}" is not available to a page context`;
  return null;
}

/** The settings a tab may see. */
export function maskSettings(settings) {
  const out = {};
  for (const key of PAGE_SETTINGS_FIELDS) {
    if (settings?.[key] !== undefined) out[key] = settings[key];
  }
  return out;
}

/** The settings a tab may write, everything else dropped silently. */
export function pickPageSettings(settings) {
  const out = {};
  for (const key of PAGE_SETTINGS_KEYS) {
    if (settings?.[key] !== undefined) out[key] = settings[key];
  }
  return out;
}
