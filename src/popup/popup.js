// Popup: the manual console of the extension.
//
// Nothing here runs on its own; every check and every order switch starts
// from a click in this window. Explanations do not take space:
// they sit behind “?” buttons and show on hover.

import { formatPercent, formatUsd, normalizeAmounts, normalizeSellPercent } from '../shared/quick-buy.js';
import { parsePairing, shellSafePairing } from '../shared/daemon-api.js';
import { DELEGATES, isLimilDelegate } from '../shared/chains.js';
import { baseCss, cssVariables } from '../shared/theme.js';
import { attachTooltip } from '../shared/tooltip.js';
import { LOCALES, applyToDom, getLocale, initLocale, setLocale, t } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);

// The theme goes into the document: popup and page panel must look the same,
// and the values live in one place, shared/theme.js.
const themeStyle = document.createElement('style');
themeStyle.textContent = `:root {${cssVariables()}}\n${baseCss()}`;
document.head.append(themeStyle);

// Language first: everything rendered below reads t().
await initLocale();
applyToDom(document);

/** Round “?” with a hover tooltip. */
function helpButton(text) {
  const button = document.createElement('button');
  button.className = 'lc-help';
  button.type = 'button';
  button.setAttribute('aria-label', text);
  button.append(document.createTextNode('?'));
  const tip = document.createElement('span');
  tip.className = 'lc-tip';
  tip.textContent = text;
  button.append(tip);
  button.addEventListener('click', (ev) => ev.preventDefault());
  attachTooltip(button, tip);
  return button;
}

/** Help texts by placeholder id; re-rendered when the language changes. */
const HELP = {
  'orders-toggle-help': 'orders.toggle.help',
  'orders-help': 'orders.ready.help',
  'daemon-help': 'daemon.help',
  'mirror-help': 'mirror.help',
  'quick-help': 'quick.help',
  'feed-help': 'feed.help',
  'rpc-help': 'quick.rpcHelp',
  'autonomous-help': 'autonomous.help',
};

function renderHelp() {
  for (const [id, key] of Object.entries(HELP)) {
    const button = helpButton(t(key));
    button.dataset.help = id;
    const old = document.querySelector(`[data-help="${id}"]`) ?? $(id);
    old?.replaceWith(button);
  }
}
renderHelp();

// ------------------------------------------------------------------ transport

/** Sites with our content script: FOMO only. */
const SITES = [
  { host: 'fomo.family', urls: ['https://fomo.family/*', 'https://*.fomo.family/*'] },
];

function siteOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return null;
    return SITES.find((s) => hostname === s.host || hostname.endsWith(`.${s.host}`)) ?? null;
  } catch {
    return null;
  }
}

const isFomoUrl = (url) => siteOf(url)?.host === 'fomo.family';

/**
 * The tab the popup talks to: the active one if it is ours, else the first
 * open FOMO tab. The active tab is preferred so the switches act on what
 * the person is looking at.
 */
async function activeFomoTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (siteOf(active?.url)) return active;
  for (const site of SITES) {
    const open = await chrome.tabs.query({ url: site.urls });
    if (open.length) return open[0];
  }
  throw new Error(t('err.noTab', { url: active?.url ?? t('err.unknown') }));
}

/**
 * Chrome does not re-inject content scripts into tabs that were open before
 * an update; every message then fails with “Receiving end does not exist”,
 * which does not suggest that F5 is enough.
 */
const NO_RECEIVER = /receiving end does not exist|could not establish connection/i;

async function tab(type, payload) {
  const target = await activeFomoTab();
  let res;
  try {
    res = await chrome.tabs.sendMessage(target.id, { type, payload });
  } catch (err) {
    if (NO_RECEIVER.test(String(err?.message || err))) {
      $('reload-banner').hidden = false;
      throw new Error(t('err.oldTab'));
    }
    throw err;
  }
  if (res?.error) throw new Error(res.error);
  return res?.result;
}

const page = (type, payload) => tab(`page.${type}`, payload);

async function bg(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (res?.error) throw new Error(res.error);
  return res?.result;
}

function show(id, text, tone = '') {
  const box = $(id);
  if (!box) return;
  box.textContent = text;
  box.className = `detail ${tone}`;
}

$('reload-tab').addEventListener('click', async () => {
  const button = $('reload-tab');
  button.disabled = true;
  button.textContent = t('reload.working');
  try {
    const target = await activeFomoTab();
    await chrome.tabs.reload(target.id);
    // Wait for the script to come up: right after reload the same error fires.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await chrome.tabs.sendMessage(target.id, { type: 'ui.status' });
        break;
      } catch { /* not up yet */ }
    }
    $('reload-banner').hidden = true;
  } catch (err) {
    button.textContent = String(err.message || err);
    return;
  } finally {
    button.disabled = false;
  }
  button.textContent = t('reload.button');
});

// ------------------------------------------------------------------ language

function fillLanguageMenu() {
  const select = $('uiLang');
  select.textContent = '';
  for (const [code, { name }] of Object.entries(LOCALES)) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    select.append(option);
  }
  select.value = getLocale();
}
fillLanguageMenu();

$('uiLang').addEventListener('change', async () => {
  const uiLang = $('uiLang').value;
  setLocale(uiLang);
  await bg('settings.set', { settings: { uiLang } }).catch(() => {});
  applyToDom(document);
  renderHelp();
  refreshStatus().catch(() => {});
  // The page panel re-renders itself from the storage change.
});

// -------------------------------------------------------------------- orders

function row(dl, key, value, tone) {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dd.className = tone;
  dl.append(dt, dd);
}

/**
 * Readiness: one lamp and, when it is not green, the one thing to do.
 *
 * The person needs to know whether orders will EXECUTE, and the check is the
 * same one the page panel makes before it warns (`privy.canSign`), so the
 * popup and the panel can never disagree about it.
 */
async function refreshStatus() {
  const box = $('ready');
  const lines = [];
  lines.push(await ordersLine());
  lines.push(await daemonLine());
  renderReady(box, lines);
  renderJournal().catch(() => { /* the journal is a courtesy */ });
}

/**
 * The executor's journal, newest first: what the extension did with money
 * and why, the quick trades' outcomes, the exchange with Privy. The same
 * lines the page's order panel shows.
 */
let journalText = '';
async function renderJournal() {
  const st = await bg('runner.status');
  const entries = st?.log ?? [];
  journalText = entries.map((e) => {
    const when = new Date(e.at).toLocaleTimeString();
    const who = e.orderId ? ` [${String(e.orderId).slice(0, 8)}]` : '';
    return `${when} ${e.act ?? ''}${who}: ${e.reason ?? ''}`;
  }).join('\n');
  $('journal').textContent = journalText || t('journal.empty');
  $('journal-brief').textContent = entries.length ? String(entries.length) : '';
}
$('journal-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(journalText);
    $('journal-copy').textContent = t('journal.copied');
    setTimeout(() => { $('journal-copy').textContent = t('journal.copy'); }, 1500);
  } catch { /* the text is on screen anyway */ }
});

/** Line one: can orders execute through the open browser, and if not, why. */
async function ordersLine() {
  try {
    const target = await activeFomoTab();
    if (!isFomoUrl(target.url)) return { text: t('ready.onlyFomo'), tone: 'bad' };
  } catch (err) {
    return { text: String(err.message || err), tone: 'bad' };
  }
  let on = false;
  try { on = (await bg('settings.get'))?.ordersEnabled === true; } catch { /* off */ }
  if (!on) return { text: t('ready.off'), tone: 'bad' };
  let fomo = null;
  let ui = null;
  let sign = null;
  try {
    [fomo, ui] = await Promise.all([
      page('fomo.status').catch(() => null),
      tab('ui.status').catch(() => null),
    ]);
    sign = await page('privy.canSign', { sender: ui?.context?.sender ?? null });
  } catch (err) {
    return { text: String(err.message || err), tone: 'bad' };
  }
  const connected = Boolean(fomo?.hasSession && fomo?.userId);
  if (!connected) return { text: t('ready.noSession'), tone: 'bad' };
  if (sign && sign.ok === false) {
    const text = sign.code === 'no-privy' ? t('ready.noPrivy')
      : sign.code === 'other-wallet' ? t('ready.otherWallet')
        : t('ready.needSale');
    return { text, tone: 'bad' };
  }
  // Everything above says a signature COULD be made. Whether an order would
  // actually execute is a question for the chain: the wallet has to be
  // delegated to the contract and the session key granted for these orders,
  // and neither follows from having an envelope. This lamp was green through
  // an evening in which nothing could be signed at all, so the chain is asked
  // last and its answer wins.
  try {
    const chain = await bg('runner.readiness');
    if (chain && chain.ok === false) return { text: chain.reason, tone: 'bad' };
  } catch (err) {
    // A failure to ASK is not a failure to execute; say so rather than
    // turning the lamp red on a hiccup, and never say "available" either.
    return { text: t('ready.node', { error: String(err?.message || err) }), tone: 'warn' };
  }
  return { text: t('ready.ok'), tone: 'ok' };
}

/**
 * Line two: orders keep executing with this laptop closed. True on a laptop
 * when its own server is paired, switched on and reachable; true on the
 * server browser itself when it runs as the runner and reaches the hub.
 */
/** A runner browser silent for longer than this is not executing anything. */
const RUNNER_STALE_MS = 5 * 60_000;

async function daemonLine() {
  try {
    const [st, runner, ui] = await Promise.all([
      bg('daemon.status').catch(() => null),
      bg('mirror.status').catch(() => null),
      tab('ui.status').catch(() => null),
    ]);
    const isRunner = Boolean(runner?.paired && runner?.enabled && runner?.online);
    if (isRunner) return { text: t('ready.runner.ok'), tone: 'ok' };
    if (!st?.paired || !st?.enabled) return { text: t('ready.daemon.no'), tone: 'bad' };
    if (!st.online) return { text: t('ready.daemon.offline', { error: st.error ?? '' }), tone: 'bad' };

    // Reachable is not the same as able. This line said "available" for a hub
    // that answered an HTTP request, while the browser executing for it was
    // signed in to another account and could not execute one order.
    const r = st.runner ?? null;
    if (r) {
      const seen = Date.parse(r.reportedAt ?? r.lastSeenAt ?? '') || 0;
      if (!seen || Date.now() - seen > RUNNER_STALE_MS) {
        return { text: t('ready.runner.silent'), tone: 'bad' };
      }
      // FOMO's swap endpoint takes no wallet argument: the account is
      // whoever asks. A server browser signed in elsewhere quotes for that
      // other account, so nothing of ours can execute there.
      const mine = String(ui?.context?.sender ?? '').toLowerCase();
      const theirs = String(r.wallet ?? '').toLowerCase();
      if (mine && theirs && mine !== theirs) {
        return { text: t('ready.runner.otherAccount', { wallet: r.wallet }), tone: 'bad' };
      }
      return { text: t('ready.daemon.ok'), tone: 'ok' };
    }
    // No browser has joined that server yet, so nothing there executes.
    return { text: t('ready.runner.silent'), tone: 'bad' };
  } catch {
    return { text: t('ready.daemon.no'), tone: 'bad' };
  }
}

function renderReady(box, lines) {
  box.textContent = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = `ready-line ${line.tone}`;
    div.textContent = line.text;
    box.append(div);
  }
}

// ------------------------------------------------------------- orders switch
//
// While the switch is off there is no panel on the page, the runner does not
// run and no grant is issued. Turning it off cancels orders and returns the
// wallet to FOMO's delegate.

async function walletAddress() {
  try {
    const ui = await tab('ui.status');
    if (ui?.context?.sender) return ui.context.sender;
  } catch { /* no tab */ }
  try {
    const info = await page('gate.inspect');
    if (info?.address) return info.address;
  } catch { /* no sample */ }
  return null;
}

/**
 * Returns the wallet to FOMO's delegate on every chain where it runs ours.
 * One wallet may be delegated on several chains; each is its own operation.
 */
async function disconnectIfOurs() {
  const sender = await walletAddress();
  if (!sender) return { done: false, reason: t('disconnect.noWallet') };
  const st = await bg('runner.status');
  let touched = 0;
  let failed = null;
  for (const chainId of Object.keys(DELEGATES).map(Number)) {
    let code = null;
    try { code = await bg('rpc.getCode', { chainId, address: sender }); } catch { continue; }
    const delegate = typeof code === 'string' && code.startsWith('0xef0100') ? `0x${code.slice(8, 48)}` : null;
    if (!isLimilDelegate(delegate)) continue;
    touched += 1;
    // The disconnect changes the wallet code back. The worker issues a
    // one-time intent for exactly this (wallet, chain, key); the MAIN world
    // signs nothing without it (background/intent.js).
    const key = st?.sessionKeyAddress ?? null;
    // Every key the wallet may have granted: this browser's, the hub's, the
    // runner browser's. The delegate returns to FOMO, but the old contract's
    // storage keeps the grants; each is revoked by name first.
    const settings = await bg('settings.get').catch(() => ({}));
    const keys = [...new Set([key, settings?.daemon?.sessionKey, settings?.daemon?.runner?.key].filter(Boolean).map((k) => String(k).toLowerCase()))];
    const intent = await bg('intent.issue', { kind: 'disconnect', params: { sender, chainId, key, keys } });
    const report = await page('session.disconnect', { sender, chainId, key, keys, intent });
    if (!report?.done) failed = report;
  }
  if (!touched) return { done: true, reason: t('disconnect.notOurs') };
  const report = failed ?? { done: true };
  return {
    done: Boolean(report?.done),
    reason: report?.done
      ? t('disconnect.done')
      : t('disconnect.pending', { delegate: report?.delegateNow ?? t('disconnect.unreadable') }),
  };
}

// ------------------------------------------------------------ feed panel

// Chrome opens the side panel only from a user gesture; the click here is
// one. The panel connects to a FOMO tab on its own (panel/panel.js).
$('feed-open').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  } catch (err) {
    show('feed-info', String(err?.message || err), 'bad');
  }
});

// ------------------------------------------------------------ own node

/**
 * The person's own Solana node: every quick trade is checked on a node
 * before it is signed, and the public ones are slow and refuse bursts. The
 * URL is saved first, then Chrome is asked for the origin; the permission
 * dialog closes the popup, so nothing after the request may matter.
 */
function cleanRpcUrl(value) {
  const url = String(value ?? '').trim();
  if (!url) return '';
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(t('quick.rpcHttps'));
  return u.href;
}
$('solanaRpcUrl').addEventListener('change', async () => {
  try {
    const solanaRpcUrl = cleanRpcUrl($('solanaRpcUrl').value);
    await bg('settings.set', { settings: { solanaRpcUrl } });
    $('solanaRpcUrl').value = solanaRpcUrl;
    if (!solanaRpcUrl) { show('quick-info', t('quick.rpcOff')); return; }
    const origin = `${new URL(solanaRpcUrl).origin}/*`;
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) { show('quick-info', t('daemon.noPermission', { origin }), 'bad'); return; }
    }
    show('quick-info', t('quick.rpcOn', { host: new URL(solanaRpcUrl).host }), 'ok');
  } catch (err) {
    show('quick-info', String(err?.message || err), 'bad');
  }
});

// ------------------------------------------------------------- quick buy

function quickAmountsFromInputs() {
  return normalizeAmounts([$('quickAmount1').value, $('quickAmount2').value]);
}
function showQuickAmounts(amounts) {
  $('quickAmount1').value = amounts[0] ?? '';
  $('quickAmount2').value = amounts[1] ?? '';
}
async function saveQuick() {
  const quickBuyEnabled = $('quickBuyEnabled').checked;
  const quickBuyAmounts = quickAmountsFromInputs();
  const quickSellPercent = normalizeSellPercent($('quickSellPercent').value);
  const quickBuyConfirm = $('quickConfirm').checked;
  showQuickAmounts(quickBuyAmounts);
  $('quickSellPercent').value = quickSellPercent;
  await bg('settings.set', { settings: { quickBuyEnabled, quickBuyAmounts, quickSellPercent, quickBuyConfirm } });
  // The open FOMO tab picks the change up at once; without a tab the page
  // reads the setting when it loads.
  await tab('quick.update', { quickBuyEnabled, quickBuyAmounts, quickSellPercent, quickBuyConfirm }).catch(() => {});
  show('quick-info', quickBuyEnabled ? t('quick.on', { a: formatUsd(quickBuyAmounts[0]), b: formatUsd(quickBuyAmounts[1] ?? quickBuyAmounts[0]), p: formatPercent(quickSellPercent) }) : '');
}
$('quickBuyEnabled').addEventListener('change', (ev) => {
  ev.target.nextElementSibling?.classList.add('is-init');
  saveQuick().catch((err) => show('quick-info', String(err.message || err), 'bad'));
});
for (const id of ['quickAmount1', 'quickAmount2', 'quickSellPercent', 'quickConfirm']) {
  $(id).addEventListener('change', () => saveQuick().catch((err) => show('quick-info', String(err.message || err), 'bad')));
}

// ------------------------------------------------------------- autonomous mode
//
// Local by default (shared/autonomy.js). The server cards below this switch
// exist only while it is on; turning it on shows the risk and waits for an
// explicit acknowledgement; turning it off unpairs both the hub and the runner
// role and gives back the host permissions they were granted, so "off" means
// the extension talks to no server of yours at all.

function renderAutonomous(settings) {
  const on = settings.autonomousEnabled === true;
  $('autonomousEnabled').checked = on;
  $('autonomous-body').hidden = !on;
  $('autonomous-local').hidden = on;
  $('autonomous-risk').hidden = true;
  if (on) { refreshDaemon(); refreshMirror(); }
}

/**
 * Origins the popup asked Chrome for on pairing; returned when leaving
 * autonomous mode. ONLY those two: the hub's and the runner hub's, taken from
 * the stored pairing. Never "everything not in the manifest", in MV3 the
 * manifest's own host permissions are revocable too, and a list computed by
 * string comparison would take the RPC nodes with it.
 */
async function revokeServerOrigins() {
  try {
    const settings = await bg('settings.get');
    const origins = [settings?.daemon?.url, settings?.mirror?.url]
      .filter(Boolean)
      .map((u) => { try { return `${new URL(u).origin}/*`; } catch { return null; } })
      .filter(Boolean);
    const manifest = new Set(chrome.runtime.getManifest().host_permissions ?? []);
    const extra = origins.filter((o) => !manifest.has(o));
    if (extra.length) await chrome.permissions.remove({ origins: extra });
  } catch { /* nothing granted */ }
}

/**
 * The extension's own host permissions (RPC nodes, quote APIs, FOMO) are
 * revocable by the user in Chrome's settings, and were once revoked by an
 * over-eager version of the function above. Without them every fetch from
 * the worker dies with "Failed to fetch" and nothing says why. Checked on
 * every open; a banner with one button asks Chrome for them back (a request
 * needs a click, which the banner provides).
 */
async function checkHostPermissions() {
  try {
    const origins = chrome.runtime.getManifest().host_permissions ?? [];
    const ok = await chrome.permissions.contains({ origins });
    $('perm-banner').hidden = ok;
  } catch { /* older Chrome */ }
}
$('perm-restore').addEventListener('click', async () => {
  try {
    const origins = chrome.runtime.getManifest().host_permissions ?? [];
    await chrome.permissions.request({ origins });
    await checkHostPermissions();
    refreshStatus().catch(() => {});
  } catch (err) {
    show('orders-toggle-info', String(err.message || err), 'bad');
  }
});
checkHostPermissions();

$('autonomousEnabled').addEventListener('change', async (ev) => {
  ev.target.nextElementSibling?.classList.add('is-init');
  const on = ev.target.checked;
  show('autonomous-info', '');
  if (on) {
    // Not enabled yet: the risk text and the acknowledgement button. The
    // setting is written only when the button is pressed.
    $('autonomous-risk').hidden = false;
    $('autonomous-local').hidden = true;
    return;
  }
  try {
    // Unpairing is what stands the SERVER down: the hub drops the order list
    // and the runner browser cancels its mirrored copies. Switching off also
    // lets this browser execute again, so if the hub was not reached, both
    // would execute the same position. That is said out loud rather than
    // swallowed; the switch still goes off, because a server one cannot reach
    // must still be leavable.
    const left = await bg('daemon.unpair').catch((err) => ({ standDown: false, error: String(err?.message || err) }));
    await bg('mirror.unpair').catch(() => {});
    await revokeServerOrigins();
    const settings = await bg('settings.set', { settings: { autonomousEnabled: false, autonomousAckAt: null } });
    renderAutonomous(settings);
    if (left && left.standDown === false) {
      show('autonomous-info', t('autonomous.off.stuck', { error: left.error ?? '' }), 'bad');
    } else {
      show('autonomous-info', t('autonomous.off.done'), 'ok');
    }
  } catch (err) {
    show('autonomous-info', String(err.message || err), 'bad');
  }
  renderRunner();
});

$('autonomousAck').addEventListener('click', async () => {
  try {
    const settings = await bg('settings.set', { settings: { autonomousEnabled: true, autonomousAckAt: Date.now() } });
    renderAutonomous(settings);
  } catch (err) {
    show('autonomous-info', String(err.message || err), 'bad');
  }
  renderRunner();
});

/**
 * THE SWITCH IS THE CONSENT. Auto-execution needs the wallet delegated to the
 * limil account contract (EIP-7702), a change of the account's code; the
 * page is the wrong place to ask for that, a script on fomo.family can press
 * any button the panel draws, so the decision lives here, on a control the
 * page cannot reach. On: the first order connects the wallet (one signature,
 * no gas). Off: open orders are cancelled and the wallet returns to FOMO's
 * contract. The “?” next to the switch says exactly this.
 */
/**
 * The line under the Limit orders switch, while the switch is on.
 *
 * Orders only execute once the extension has seen how FOMO asks Privy for a
 * signature, and only a SELL on an EVM chain shows it that. Said here, at the
 * switch, rather than after an order has been placed and quietly not fired.
 */
async function showOrdersNotice() {
  let on = false;
  try { on = (await bg('settings.get'))?.ordersEnabled === true; } catch { /* treat as off */ }
  if (!on) return;
  let sign = null;
  try {
    const ui = await tab('ui.status').catch(() => null);
    sign = await page('privy.canSign', { sender: ui?.context?.sender ?? null });
  } catch { return; /* no FOMO tab: the Status card already says so */ }
  if (!sign || sign.ok !== false) { show('orders-toggle-info', ''); return; }
  const text = sign.code === 'no-privy' ? t('ready.noPrivy')
    : sign.code === 'other-wallet' ? t('ready.otherWallet')
      : t('ready.needSale');
  show('orders-toggle-info', text, 'warn');
}

$('ordersEnabled').addEventListener('change', async (ev) => {
  ev.target.nextElementSibling?.classList.add('is-init');
  const on = ev.target.checked;
  try {
    if (on) {
      await bg('settings.set', { settings: { ordersEnabled: true } });
      show('orders-toggle-info', '');
      await tab('ui.start').catch(() => { /* no tab, the panel mounts when one opens */ });
      await showOrdersNotice();
    } else {
      await bg('settings.set', { settings: { ordersEnabled: false } });
      show('orders-toggle-info', t('orders.turningOff'));
      await tab('ui.stop').catch(() => {});
      await bg('orders.cancelAll', { reason: t('orders.cancelReason.off') });
      const res = await disconnectIfOurs();
      show('orders-toggle-info', res.done ? '' : res.reason, res.done ? '' : 'bad');
    }
  } catch (err) {
    show('orders-toggle-info', String(err.message || err), 'bad');
  }
  renderRunner();
});

// ---------------------------------------------------------------- own server
//
// The person's own daemon (daemon/ in the repository) executes orders while
// the browser is closed. The popup pairs with it once and shows whether it
// is alive; orders are mirrored to it from the service worker.

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '-');

/** An info line that currently shows a refusal is left alone by a refresh. */
function showsError(id) {
  return $(id)?.classList.contains('bad') && $(id).textContent.trim() !== '';
}

/** The hub card's last answer: the runner card reads it to stay out of the way. */
let lastDaemon = null;

function renderDaemon(st) {
  lastDaemon = st ?? null;
  const dl = $('daemon-status');
  // No switch here any more: with autonomous mode on and no server paired,
  // the pairing field is simply there. The switch it replaces was a third
  // state over the two that matter, and it stood in front of the one thing
  // this card exists for.
  $('daemon-pair').hidden = Boolean(st?.paired);
  // The runner card follows this one: hidden while this browser owns a hub.
  refreshMirror().catch(() => {});
  $('daemon-disconnect').hidden = !st?.paired;
  $('daemon-details').hidden = !st?.paired;
  dl.textContent = '';
  if (!st?.paired) {
    if (!showsError('daemon-info')) show('daemon-info', '');
    return;
  }
  // One word next to "Details" while it is closed; the table inside.
  const brief = $('daemon-brief');
  brief.textContent = st.online ? t('daemon.online') : t('daemon.offline');
  brief.className = `brief ${st.online ? 'ok' : 'bad'}`;
  row(dl, t('daemon.row.server'), st.url, '');
  row(dl, t('daemon.row.state'), st.online ? t('daemon.online') : t('daemon.offline'), st.online ? 'ok' : 'bad');
  row(dl, t('daemon.row.key'), short(st.sessionKey), '');
  if (st.online) row(dl, t('daemon.row.watching'), String(st.watching ?? 0), '');
  // With no browser executing there, hand over the one command that pairs
  // one. Driving a browser through a remote desktop to paste a token was the
  // worst step of the whole setup and the only one that could not be
  // scripted; it can be now.
  const cmd = $('runner-pair-cmd');
  if (cmd) {
    const wanted = st.online && !st.runner?.key;
    cmd.hidden = !wanted;
    if (wanted && !$('runner-pair-line').value) {
      bg('daemon.runnerPairing')
        .then((r) => { const pairing = shellSafePairing(r?.pairing); if (pairing) $('runner-pair-line').value = `bash scripts/pair-runner.sh '${pairing}'`; })
        .catch(() => { /* an older hub does not offer it; the guide still works */ });
    }
  }
  // A runner browser on the server: its freshness and its last journal lines.
  if (st.runner?.key) {
    const seen = st.runner.lastSeenAt ? Date.now() - new Date(st.runner.lastSeenAt).getTime() : null;
    const fresh = seen !== null && seen < 3 * 60_000;
    row(dl, t('daemon.row.runner'), `${fresh ? t('daemon.runner.live', { n: st.runner.watching ?? 0 }) : t('daemon.runner.silent')}${st.runner.build ? ` · ${st.runner.build}` : ''}`, fresh ? 'ok' : 'warn');
  }
  const lines = (st.runner?.journal ?? []).slice(0, 4).map((e) => `${new Date(e.at).toLocaleTimeString()} ${e.reason}`);
  const note = !st.online ? (st.error ?? t('daemon.offline')) : lines.join('\n');
  show('daemon-info', note, !st.online ? 'bad' : '');
}

$('runner-pair-copy')?.addEventListener('click', async () => {
  const line = $('runner-pair-line').value;
  if (!line) return;
  try {
    await navigator.clipboard.writeText(line);
    show('daemon-info', t('daemon.runner.copied'), 'ok');
  } catch {
    // Clipboard refused: select it so it can be copied by hand.
    $('runner-pair-line').select();
  }
});

async function refreshDaemon() {
  try {
    renderDaemon(await bg('daemon.status'));
  } catch (err) {
    show('daemon-info', String(err.message || err), 'bad');
  }
}

/**
 * Asks Chrome for the hub's origin HERE, inside the click: a permission
 * request needs a user gesture, and the service worker has none. Origins
 * already granted (or listed in the manifest) pass without a prompt.
 */
async function grantOrigin(pairing) {
  const { url } = parsePairing(pairing);
  const origin = `${new URL(url).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  const ok = await chrome.permissions.request({ origins: [origin] });
  if (!ok) throw new Error(t('daemon.noPermission', { origin }));
}

/**
 * The permission prompt closes the popup. Chrome shows the host-permission
 * dialog as a separate window; the popup loses focus and is torn down with
 * everything that was awaiting inside it, so a pairing awaited here would
 * die the moment the person clicked Allow, permission granted, nothing
 * paired, the switch back off on the next open. Hence the pairing string is
 * written to storage FIRST, and whoever comes back first, the service worker
 * on chrome.permissions.onAdded, or this popup on its next open, finishes
 * the pairing (finishPendingPairing below).
 */
$('daemon-connect').addEventListener('click', async () => {
  const button = $('daemon-connect');
  const pairing = $('daemon-pairing').value.trim();
  button.disabled = true;
  show('daemon-info', t('daemon.connecting'));
  try {
    await bg('settings.set', { settings: { pendingDaemonPairing: pairing } });
    await grantOrigin(pairing);
    await bg('settings.set', { settings: { pendingDaemonPairing: null } });
    const st = await bg('daemon.pair', { pairing });
    $('daemon-pairing').value = '';
    renderDaemon(st);
    show('daemon-info', t('daemon.paired'), 'ok');
  } catch (err) {
    await bg('settings.set', { settings: { pendingDaemonPairing: null } }).catch(() => {});
    show('daemon-info', String(err.message || err), 'bad');
  } finally {
    button.disabled = false;
  }
});

/** A pairing interrupted by the permission dialog is finished on the next open. */
async function finishPendingPairing(settings) {
  const jobs = [
    { key: 'pendingDaemonPairing', cmd: 'daemon.pair', info: 'daemon-info', render: renderDaemon, ok: 'daemon.paired' },
    { key: 'pendingMirrorPairing', cmd: 'mirror.pair', info: 'mirror-info', render: renderMirror, ok: 'mirror.paired' },
  ];
  for (const job of jobs) {
    // A refusal the worker met while finishing it on its side.
    const stored = settings?.[`${job.key}Error`];
    if (stored) {
      show(job.info, stored, 'bad');
      $(job.info === 'daemon-info' ? 'daemon-pair' : 'mirror-pair').hidden = false;
      await bg('settings.set', { settings: { [`${job.key}Error`]: null } }).catch(() => {});
    }
    const pairing = settings?.[job.key];
    if (!pairing) continue;
    try {
      const { url } = parsePairing(pairing);
      if (!await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] })) continue;
      // Claimed before pairing so a concurrent worker pass does not pair twice.
      await bg('settings.set', { settings: { [job.key]: null } });
      show(job.info, t('daemon.connecting'));
      const st = await bg(job.cmd, { pairing });
      job.render(st);
      show(job.info, t(job.ok), 'ok');
    } catch (err) {
      show(job.info, String(err.message || err), 'bad');
    }
  }
}

$('daemon-disconnect').addEventListener('click', async () => {
  try {
    await bg('daemon.unpair');
    renderDaemon({ paired: false, enabled: false });
    // Whoever disconnects usually wants to connect to another address next.
    $('daemon-pair').hidden = false;
    $('daemon-pairing').focus();
  } catch (err) {
    show('daemon-info', String(err.message || err), 'bad');
  }
});

// -------------------------------------------------------------- runner browser

function renderMirror(st) {
  const dl = $('mirror-status');
  // A browser is one of two things: the owner that places orders, or the
  // runner that executes someone else's. Never both, and the two cards side
  // by side are the reason people paste the laptop string into the runner
  // field. The runner card stays hidden while this browser owns a hub.
  const owns = Boolean(lastDaemon?.paired);
  $('mirror-card').hidden = owns && !st?.paired;
  if (owns && !st?.paired) return;
  // The pairing IS the switch: a paired browser is a runner, and the way to
  // stop being one is to unpair. A separate switch only paused a runner
  // without unpairing it, which the autonomous switch already does.
  $('mirror-pair').hidden = Boolean(st?.paired);
  $('mirror-disconnect').hidden = !st?.paired;
  $('mirror-details').hidden = !st?.paired;
  dl.textContent = '';
  if (!st?.paired) { if (!showsError('mirror-info')) show('mirror-info', ''); return; }
  const brief = $('mirror-brief');
  brief.textContent = st.online ? t('daemon.online') : t('daemon.offline');
  brief.className = `brief ${st.online ? 'ok' : 'bad'}`;
  row(dl, t('daemon.row.server'), st.url, '');
  row(dl, t('daemon.row.state'), st.online ? t('daemon.online') : t('daemon.offline'), st.online ? 'ok' : 'bad');
  if (st.owner) row(dl, t('mirror.row.owner'), short(st.owner), '');
  if (st.online) row(dl, t('daemon.row.watching'), String(st.watching ?? 0), '');
  if (st.lastPullAt) row(dl, t('daemon.row.lastLoop'), new Date(st.lastPullAt).toLocaleTimeString(), '');
  show('mirror-info', st.online ? '' : (st.error ?? t('daemon.offline')), st.online ? '' : 'bad');
}

async function refreshMirror() {
  try { renderMirror(await bg('mirror.status')); } catch (err) { show('mirror-info', String(err.message || err), 'bad'); }
}

/** The hub inside the server stack is always http://daemon:8787: a bare token is enough. */
const RUNNER_HUB_DEFAULT = 'http://daemon:8787';

$('mirror-connect').addEventListener('click', async () => {
  const button = $('mirror-connect');
  button.disabled = true;
  show('mirror-info', t('daemon.connecting'));
  try {
    let pairing = $('mirror-pairing').value.trim();
    if (pairing && !pairing.includes('#')) pairing = `${RUNNER_HUB_DEFAULT}#${pairing}`;
    // Same dance as the hub card: the permission dialog may close this popup.
    await bg('settings.set', { settings: { pendingMirrorPairing: pairing } });
    await grantOrigin(pairing);
    await bg('settings.set', { settings: { pendingMirrorPairing: null } });
    const st = await bg('mirror.pair', { pairing });
    $('mirror-pairing').value = '';
    renderMirror(st);
    show('mirror-info', t('mirror.paired'), 'ok');
  } catch (err) {
    await bg('settings.set', { settings: { pendingMirrorPairing: null } }).catch(() => {});
    show('mirror-info', String(err.message || err), 'bad');
  } finally {
    button.disabled = false;
  }
});

$('mirror-disconnect').addEventListener('click', async () => {
  try {
    await bg('mirror.unpair');
    renderMirror({ paired: false, enabled: false });
    // Same as the hub card: the pairing field is what comes next.
    $('mirror-pairing').focus();
  } catch (err) {
    show('mirror-info', String(err.message || err), 'bad');
  }
});

/** Runner state lives in the readiness line: redraw it. */
function renderRunner() {
  return refreshStatus().catch(() => {});
}

// --------------------------------------------------------------------- start

bg('settings.get').then((settings) => {
  // Orders stay off until the person turns them on: the switch is the consent
  // to the wallet delegation.
  $('ordersEnabled').checked = settings.ordersEnabled === true;
  showOrdersNotice().catch(() => { /* the Status card carries the same answer */ });
  renderAutonomous(settings);
  finishPendingPairing(settings).catch(() => { /* shown in the card */ });
  $('quickBuyEnabled').checked = settings.quickBuyEnabled === true;
  showQuickAmounts(normalizeAmounts(settings.quickBuyAmounts));
  $('quickSellPercent').value = normalizeSellPercent(settings.quickSellPercent);
  $('solanaRpcUrl').value = settings.solanaRpcUrl ?? '';
  // On by default: a stray tap in a scrolling feed must not buy.
  $('quickConfirm').checked = settings.quickBuyConfirm !== false;
}).catch(() => { /* no settings yet */ });

refreshStatus().catch(() => { /* page not ready */ });
refreshDaemon();
refreshMirror();

// Statuses refresh while the popup is open: otherwise “no session” hangs as a
// verdict although it may have appeared a second ago.
const timer = setInterval(() => { refreshStatus().catch(() => {}); }, 2000);
window.addEventListener('unload', () => clearInterval(timer));
