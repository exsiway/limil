// Client of the user's own hub (daemon/ in this repository).
//
// The hub keeps the order list for a runner browser on the server, which
// executes while this laptop is closed. The extension stays the place where
// orders are placed and shown: it mirrors the order list to the hub after
// every change, pulls the verdicts back (filled / failed / cancelled) and
// includes the runner browser's session key in the grant. Until a runner
// browser is paired the hub reports no key, and this browser keeps executing.
//
// Every request is signed with the extension's session key, the way the hub
// expects (src/shared/daemon-api.js). The hub learns that key at pairing from
// a one-time token the person copies from its console.

import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { PROTOCOL, authMessage, bodyHashOf, orderForDaemon, parsePairing, randomToken, redactSample, refinesVerdict } from '../shared/daemon-api.js';
import { findJwtPaths, replaceAtPaths } from '../shared/jwt.js';
import { AUTONOMY_REQUIRED, autonomousOn } from '../shared/autonomy.js';
import { t } from '../shared/i18n.js';
import { ensureSessionKey } from './runner.js';
import { mutateOrders } from './orders-store.js';

async function settings() {
  const bag = await chrome.storage.local.get('settings');
  return bag.settings ?? {};
}

async function saveSettings(patch) {
  const bag = await chrome.storage.local.get('settings');
  const merged = { ...(bag.settings ?? {}), ...patch };
  await chrome.storage.local.set({ settings: merged });
  return merged;
}

async function signer() {
  await ensureSessionKey();
  const bag = await chrome.storage.local.get('runner.secret');
  const secret = bag['runner.secret'];
  if (!secret) throw new Error(t('daemon.noKey'));
  return privateKeyToAccount(secret);
}

/**
 * The hub is on when autonomous mode is on and it is paired. Autonomous mode
 * is the master: with it off nothing here reaches the network, whatever the
 * pairing state (shared/autonomy.js). Whether a runner browser is paired
 * THERE is a separate question (`daemon.sessionKey`): the orders are mirrored
 * either way, so a runner that pairs later finds them waiting.
 */
export async function daemonActive(s = null) {
  const cfg = s ?? await settings();
  return autonomousOn(cfg) && Boolean(cfg.daemonEnabled && cfg.daemon?.url);
}

/**
 * Host permission for the hub's origin. Only CHECKED here: a request needs a
 * user gesture, which a service worker never has, so the popup asks for it in
 * its click handler before calling pair (see popup.js grantOrigin).
 */
export async function ensureOriginPermission(url) {
  const origin = `${new URL(url).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  throw new Error(t('daemon.noPermission', { origin }));
}

export async function call(base, path, { method = 'GET', body = null, account = null } = {}) {
  const signer_ = account ?? await signer();
  const text = body ? JSON.stringify(body) : '';
  const ts = Date.now();
  // Every request carries a fresh nonce; the daemon remembers the nonces it
  // has seen inside the time window and refuses a second appearance, so a
  // captured request cannot be replayed. The signed path is the WHOLE request
  // target, query included: nothing in the URL is left unsigned.
  const nonce = randomToken(crypto.getRandomValues(new Uint8Array(24)));
  const message = authMessage({ ts, nonce, method, path, bodyHash: bodyHashOf(keccak256, text) });
  const signature = await signer_.signMessage({ message });
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Limil ${signer_.address}:${ts}:${nonce}:${signature}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? text : undefined,
    });
  } catch (err) {
    // A Tailscale address that does not answer is almost always Tailscale
    // switched off on this side; say so instead of a bare "Failed to fetch".
    const host = (() => { try { return new URL(base).hostname; } catch { return ''; } })();
    const tail = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ? `, ${t('daemon.hintTailscale')}` : '';
    throw new Error(t('daemon.unreachable', { error: String(err?.message || err) }) + tail);
  }
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(json?.error ?? t('daemon.http', { status: res.status }));
  return json;
}

/** Pairs with a daemon from its printed string; stores its addresses. */
export async function pair({ pairing }) {
  if (!autonomousOn(await settings())) throw new Error(AUTONOMY_REQUIRED);
  const { url, token } = parsePairing(pairing);
  await ensureOriginPermission(url);
  const hello = await call(url, '/v1/pair', { method: 'POST', body: { token } });
  if (hello.protocol !== PROTOCOL) throw new Error(t('daemon.protocol', { theirs: hello.protocol, ours: PROTOCOL }));
  await saveSettings({
    daemonEnabled: true,
    daemon: { url, sessionKey: hello.sessionKey ?? null, runner: hello.runner ?? null, version: hello.version, pairedAt: Date.now() },
  });
  await sync().catch(() => { /* first sync is retried on the next change */ });
  // And read the hub back at once. Its answer says whether a runner browser
  // is paired: that key is the one the grant planner adds, and its presence
  // is what makes this browser stand down (runnerExecutes).
  await pull().catch(() => { /* the timer pulls again shortly */ });
  return status();
}

/**
 * Leave the hub.
 *
 * The remote half is what stands the server down: unpairing makes the hub
 * drop the order list, and the runner browser cancels its mirrored copies on
 * its next poll. The local half, clearing the settings, is what lets THIS
 * browser execute again.
 *
 * So a failed remote half is not a detail. If the hub cannot be reached, the
 * server keeps the orders and keeps executing them while this browser starts
 * executing them too: two executors on one position, which is the one thing
 * the whole arrangement exists to prevent. It is reported, and the caller
 * decides.
 *
 * The settings are cleared either way: refusing to switch off would leave the
 * person unable to leave a server they cannot reach.
 */
export async function unpair() {
  const cfg = await settings();
  let remote = { ok: true, error: null };
  if (cfg.daemon?.url) {
    remote = await call(cfg.daemon.url, '/v1/pair', { method: 'DELETE' })
      .then(() => ({ ok: true, error: null }))
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));
  }
  await saveSettings({ daemonEnabled: false, daemon: null });
  return { paired: false, standDown: remote.ok, error: remote.error };
}

/**
 * After a session key rotation the hub still knows the owner by the OLD key.
 * The old secret is kept under its own storage key until the hub has been
 * told, signed by that old key, who the new owner is; then it is deleted.
 * Runs before every sync and pull, so a hub that was unreachable at the
 * moment of the rotation learns of it on the next round.
 */
async function finishOwnerRotation(cfg = null) {
  const c = cfg ?? await settings();
  const bag = await chrome.storage.local.get(['runner.secret.prev', 'runner']);
  const prev = bag['runner.secret.prev'];
  const next = bag.runner?.sessionKeyAddress ?? null;
  if (!prev || !c.daemon?.url) return { rotated: false };
  if (!next) return { rotated: false };
  let done = false;
  try {
    await call(c.daemon.url, '/v1/owner/rotate', { method: 'POST', body: { next }, account: privateKeyToAccount(prev) });
    done = true;
  } catch (err) {
    // The old key may already be a stranger to the hub: the rotation landed
    // and the answer was lost. A read signed by the NEW key settles it.
    try { await call(c.daemon.url, '/v1/state'); done = true; } catch { /* the hub is unreachable, next round */ }
    if (!done) return { rotated: false, error: String(err?.message || err) };
  }
  await chrome.storage.local.remove('runner.secret.prev');
  return { rotated: true };
}

/** Pushes the watching orders and the wallets to the daemon. */
export async function sync() {
  const cfg = await settings();
  if (!(await daemonActive(cfg))) return { skipped: true };
  await finishOwnerRotation(cfg);
  const bag = await chrome.storage.local.get('orders');
  // Every live order goes to the hub, buys included: the runner browser
  // executes them all.
  const orders = (Array.isArray(bag.orders) ? bag.orders : [])
    .filter((o) => o && typeof o === 'object' && o.status === 'watching')
    .map(orderForDaemon);
  const wallet = orders.find((o) => o.sender)?.sender ?? null;
  const solanaAddress = orders.find((o) => o.solanaAddress)?.solanaAddress ?? null;
  // The signing sample goes along with its tokens redacted, so a runner
  // browser on the server can sign without a sell of its own first. When the
  // redaction cannot PROVE the sample clean it stays here (fail-closed) and
  // only the reason travels; the runner browser then captures its own.
  const sampleBag = await chrome.storage.local.get('privy.sample');
  const redaction = sampleBag['privy.sample']
    ? redactSample(sampleBag['privy.sample'], { findJwtPaths, replaceAtPaths })
    : { sample: null, reason: null };
  return call(cfg.daemon.url, '/v1/orders', {
    method: 'PUT',
    body: { wallet, solanaAddress, orders, sample: redaction.sample, sampleWithheld: redaction.reason },
  });
}

/**
 * Pulls the hub's verdicts: an order the runner browser filled, failed or
 * cancelled is closed here too, so the panel and the chart stop showing it.
 * Returns the hub state.
 */
export async function pull() {
  const cfg = await settings();
  if (!(await daemonActive(cfg))) return null;
  await finishOwnerRotation(cfg);
  const state = await call(cfg.daemon.url, '/v1/state');
  // The hub's session key is the runner browser's, or null while none is
  // paired. Remembered here because two decisions hang on it: the grant plan
  // adds that key on the next order, and this browser stands down only while
  // there is one (runnerExecutes). A runner that unpairs takes its key with
  // it, so the field is cleared too, and this browser resumes.
  //
  // Saved on any difference, not only on a key change: a hub whose runner
  // paired BEFORE the owner reports the runner's key from the first moment,
  // so a key-only comparison would never fire and the owner would not learn.
  const runner = state.runner ?? null;
  const key = state.sessionKey ?? null;
  const keyChanged = key !== (cfg.daemon.sessionKey ?? null);
  const runnerChanged = (cfg.daemon.runner?.key ?? null) !== (runner?.key ?? null);
  if (keyChanged || runnerChanged) {
    await saveSettings({ daemon: { ...cfg.daemon, sessionKey: key, runner } });
  }
  const remote = new Map((state.orders ?? []).map((o) => [o.id, o]));
  // The hub's verdicts are applied under the shared queue, after the network
  // call and never across it: the panel and the runner write this same array,
  // and an overlapping write would either lose a verdict, leaving an order
  // the hub already filled live here, or resurrect one cancelled meanwhile.
  //
  // A `cancelled` verdict counts too. The hub marks an order cancelled either
  // because THIS browser stopped listing it (then it is already closed here
  // and nothing changes) or because the runner browser cancelled its copy,
  // its orders switch went off, say. In the second case the hub will not
  // reopen it ("a closed order stays closed"), so leaving it `watching` here
  // showed a live stop-loss that no browser was watching.
  await mutateOrders((current) => {
    let changed = false;
    const orders = current.map((o) => {
      const r = remote.get(o.id);
      if (!r || r.status === 'watching') return o;
      // Normally only a live order takes a verdict. The exception is the hub
      // refining one it already gave: `triggered` became `filled` when the
      // chain answered, and that is the line the owner reads.
      if (o.status !== 'watching' && !refinesVerdict(o.status, r.status)) return o;
      changed = true;
      return {
        ...o, status: r.status, closedAt: r.closedAt ?? new Date().toISOString(), closedTx: r.closedTx ?? null, closedBy: 'daemon',
        ...(r.status === 'cancelled' ? { cancelReason: r.cancelReason ?? 'cancelled on the server' } : {}),
      };
    });
    // Nothing moved: no write, so a quiet round cannot rewrite the list at all.
    return changed ? { orders } : {};
  });
  return state;
}

/**
 * The string a browser on the server needs to pair itself.
 *
 * Asked of the hub over the owner's signed channel, so the popup can hand the
 * person one command instead of sending them through a remote desktop to
 * paste a token into a browser they are driving over a video stream.
 */
export async function runnerPairing() {
  const cfg = await settings();
  if (!(await daemonActive(cfg))) return { pairing: null, reason: 'no server is paired' };
  return call(cfg.daemon.url, '/v1/runner/pairing');
}

/** How long a pulled hub state serves repeated popup status calls. */
const STATUS_TTL_MS = 10_000;
let lastStatus = null;

/** For the popup: the hub's address, the key to grant, watching count, the runner browser. */
export async function status() {
  const cfg = await settings();
  if (!cfg.daemon?.url) return { paired: false, enabled: false };
  const base = { paired: true, enabled: Boolean(cfg.daemonEnabled), ...cfg.daemon };
  try {
    // The popup asks every two seconds while open; the hub is asked at most
    // once per STATUS_TTL_MS and the popup gets the same answer in between.
    const state = (lastStatus && Date.now() - lastStatus.at < STATUS_TTL_MS && lastStatus.url === cfg.daemon.url)
      ? lastStatus.state
      : await pull();
    lastStatus = { at: Date.now(), url: cfg.daemon.url, state };
    return {
      ...base,
      online: true,
      watching: (state?.orders ?? []).filter((o) => o.status === 'watching').length,
      journal: (state?.journal ?? []).slice(-8),
      runner: state?.runner ?? null,
    };
  } catch (err) {
    return { ...base, online: false, error: String(err?.message || err) };
  }
}

/**
 * Orders change from the panel, the runner and the popup; the hub must see
 * every change. One storage listener, debounced, covers them all.
 */
let syncTimer = null;
export function installOrderMirror() {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.orders) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { sync().catch(() => { /* retried on the next change or pull */ }); }, 1500);
  });
}
