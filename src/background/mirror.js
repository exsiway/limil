// Runner browser: this extension executes the orders of another one.
//
// The picture: the user places orders on the laptop; a browser on a server,
// logged in to FOMO with the same wallet, runs day and night. Both hold the
// extension. The laptop mirrors its orders to the daemon on the server (the
// hub, background/daemon.js); this module, switched on in the server browser
// only, pulls them from the hub, keeps them in this browser's own order list
// (marked mirrored) and reports what happened to them. Execution itself is
// the ordinary runner: chart streams, quotes, the session key and FOMO's own
// pipeline, so buys, Solana sells and the PnL entry all work. The laptop
// stands down while its daemon switch is on, so one position is never sold
// twice.
//
// Authentication is the daemon protocol: every request is signed with this
// browser's session key, which the hub learns at pairing from a one-time
// runner token printed on its console. The owner's wallet grants that key on
// the next order, because the hub reports it as its session key.

import { PROTOCOL, mergeMirror, parsePairing } from '../shared/daemon-api.js';
import { mutateOrders } from './orders-store.js';
import { AUTONOMY_REQUIRED, autonomousOn } from '../shared/autonomy.js';
import { t } from '../shared/i18n.js';
import { call, ensureOriginPermission } from './daemon.js';
import { runnerInfo } from './runner.js';
import { signedInWallet } from './signedin.js';
import { grantForHeadlessOwner, HEADLESS_RECHECK_MS } from './headless-grant.js';

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

/** Behind the autonomous master switch, like the hub link (shared/autonomy.js). */
export async function mirrorActive(s = null) {
  const cfg = s ?? await settings();
  return autonomousOn(cfg) && Boolean(cfg.mirrorEnabled && cfg.mirror?.url);
}

/** Pairs this browser with the hub as its runner. */
export async function pair({ pairing }) {
  if (!autonomousOn(await settings())) throw new Error(AUTONOMY_REQUIRED);
  const { url, token } = parsePairing(pairing);
  await ensureOriginPermission(url);
  const hello = await call(url, '/v1/runner/pair', { method: 'POST', body: { token } });
  if (hello.protocol !== PROTOCOL) throw new Error(t('daemon.protocol', { theirs: hello.protocol, ours: PROTOCOL }));
  await saveSettings({ mirrorEnabled: true, mirror: { url, pairedAt: Date.now(), version: hello.version } });
  await pull().catch(() => { /* retried on the timer */ });
  return status();
}

export async function unpair() {
  const cfg = await settings();
  if (cfg.mirror?.url) {
    await call(cfg.mirror.url, '/v1/runner/pair', { method: 'DELETE' }).catch(() => { /* hub may be gone */ });
  }
  await saveSettings({ mirrorEnabled: false, mirror: null });
  return { paired: false };
}

let lastPull = { at: 0, ok: null, error: null, added: 0, cancelled: 0, reported: 0, watching: 0, version: -1 };
let lastJournalKey = -1;
let lastHeadlessCheck = 0;

/**
 * One round with the hub: take its watching orders into this browser's list,
 * drop the ones it no longer lists, report the ones this browser closed.
 * With `wait` the hub holds the request until something changes (long poll),
 * so a new or cancelled order on the laptop lands here within seconds.
 */
/**
 * The wallet this browser is signed in to, asked of its own FOMO tab.
 *
 * Null when there is no tab or it does not answer, reported as null rather
 * than guessed, because the owner's side turns a mismatch into a red lamp and
 * a guess there would be worse than silence.
 */

export async function pull({ wait = 0 } = {}) {
  const cfg = await settings();
  if (!(await mirrorActive(cfg))) return null;
  const now = Date.now();
  try {
    const since = wait ? (lastPull.version ?? -1) : -1;
    const remote = await call(cfg.mirror.url, `/v1/runner/orders?since=${since}&wait=${wait}`);
    await takeSample(remote.sample);
    // The merge runs under the shared order queue, and the report to the hub
    // runs outside it. Holding the queue across a network call would stop the
    // panel and the runner from writing for as long as the hub takes to
    // answer; doing the merge without it would put this write on top of a
    // stale array, losing an order the panel just added or reviving one the
    // runner just closed. So: merge and write, then talk, then stamp.
    const merged = await mutateOrders((local) => {
      const { orders, added, cancelled, report } = mergeMirror(local, remote.orders ?? [], { now });
      const watching = orders.filter((o) => o.status === 'watching').length;
      return {
        orders: added || cancelled ? orders : undefined,
        result: { added, cancelled, report, watching },
      };
    });
    const { added, cancelled, report } = merged;
    // A headless owner (a program on the hub) cannot sign grants; this browser
    // does, for its own key. Remembered in settings so grantPlan, which reads
    // settings and not this module, sees it; checked on new orders and on a
    // slow clock for renewals and retries. Fire-and-forget: the round takes
    // minutes and the poll must not wait on it.
    const headless = remote.ownerHeadless === true;
    if ((cfg.mirror?.ownerHeadless === true) !== headless) {
      await saveSettings({ mirror: { ...(cfg.mirror ?? {}), ownerHeadless: headless } });
    }
    if (headless && (added > 0 || now - lastHeadlessCheck > HEADLESS_RECHECK_MS)) {
      lastHeadlessCheck = now;
      grantForHeadlessOwner({ now }).catch(() => { /* noted in the journal by the round itself */ });
    }
    let reported = 0;
    // Verdicts, plus this browser's recent journal so the owner sees on the
    // laptop what the server did and why. Sent when there is something new.
    const info = await runnerInfo().catch(() => null);
    const journal = (info?.log ?? []).slice(0, 25);
    const journalKey = journal[0]?.at ?? 0;
    if (report.length || journalKey !== lastJournalKey) {
      await call(cfg.mirror.url, '/v1/runner/status', {
        method: 'POST',
        body: {
          orders: report, journal, version: info?.version ?? null,
          build: typeof __LIMIL_BUILD__ === 'string' ? __LIMIL_BUILD__ : null,
          watching: merged.watching,
          // The account THIS browser is signed in to. FOMO's swap endpoint
          // takes no wallet argument, so this is the account every quote and
          // every operation here is made for; if it is not the one the orders
          // belong to, nothing can execute. The owner's popup compares them.
          wallet: await signedInWallet({ fallback: info?.lastExecutedSender ?? null }),
        },
      });
      lastJournalKey = journalKey;
      reported = report.length;
      // Stamped only after the hub has it, and re-read under the queue so the
      // stamp lands on the list as it stands now, not as it stood before the
      // request. An order closed in between keeps its verdict.
      if (reported) {
        // WHICH verdict was sent, not merely that one was: an order reported
        // as `triggered` and later confirmed `filled` has to be reported
        // again, and only the status tells the two apart.
        const done = new Map(report.map((r) => [r.id, r.status]));
        const at = new Date(now).toISOString();
        await mutateOrders((current) => current.map((o) => (done.has(o.id)
          ? { ...o, reportedAt: at, reportedStatus: done.get(o.id) }
          : o)));
      }
    }
    lastPull = {
      at: Date.now(), ok: true, error: null, added, cancelled, reported,
      watching: (remote.orders ?? []).length, version: remote.version ?? -1,
      // Older hubs do not send it; absent is treated as paired, so an old
      // server keeps its old behaviour rather than falling silent.
      ownerPaired: remote.ownerPaired !== false,
      ownerHeadless: headless,
      hub: remote,
    };
    return lastPull;
  } catch (err) {
    lastPull = { ...lastPull, at: now, ok: false, error: String(err?.message || err) };
    throw err;
  }
}

/**
 * The laptop's signing sample, tokens redacted. Taken only when this browser
 * has none of its own: a sample captured here is fresher. On take, the FOMO
 * tabs are reloaded once so the page picks it up; the live token is put in
 * before every signature by the page itself.
 */
let sampleTaken = false;
async function takeSample(sample) {
  if (!sample?.envelope || sampleTaken) return;
  const bag = await chrome.storage.local.get('privy.sample');
  if (bag['privy.sample']) { sampleTaken = true; return; }
  await chrome.storage.local.set({ 'privy.sample': sample });
  sampleTaken = true;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://fomo.family/*', 'https://*.fomo.family/*'] });
    for (const tab of tabs) chrome.tabs.reload(tab.id);
  } catch { /* no tab yet, loaded on the next page open */ }
}

export async function status() {
  const cfg = await settings();
  if (!cfg.mirror?.url) return { paired: false, enabled: false };
  const base = { paired: true, enabled: Boolean(cfg.mirrorEnabled), url: cfg.mirror.url };
  try {
    // The long-poll loop keeps lastPull fresh; a popup refreshing every two
    // seconds reads that instead of firing a request of its own each time.
    const fresh = lastPull.ok && Date.now() - lastPull.at < 10_000;
    const r = fresh ? lastPull : await pull();
    return { ...base, online: true, watching: r?.watching ?? 0, lastPullAt: r?.at ?? null, owner: r?.hub?.wallet ?? null };
  } catch (err) {
    return { ...base, online: false, error: String(err?.message || err), lastPullAt: lastPull.at || null };
  }
}

/**
 * Keeps pulling while the worker lives, and pushes verdicts as soon as the
 * order list changes (a fill closes an order within seconds, not at the next
 * pull). The runner's minute alarm calls pull() too, so a sleeping worker
 * catches up on wake.
 */
let looping = false;
let pushTimer = null;
/** The long-poll loop: one request in flight at a time, restarted by install() or the alarm. */
/** How long the runner waits between checks while the hub has no owner. */
export const IDLE_POLL_MS = 5 * 60_000;

/**
 * Pairing handed down by a Chromium managed policy.
 *
 * A browser on a server has no one at its keyboard, and walking it through a
 * remote desktop to paste a token is the worst step of the whole setup. So
 * the machine that runs it writes the pairing into the browser's policy and
 * this reads it: `chrome.storage.managed` is Chromium's own channel for
 * settings an administrator provisions, read-only to the extension.
 *
 * Deliberately narrow:
 *  - it pairs only when nothing is paired, so it never overrides a person who
 *    paired by hand, and never re-pairs after someone unpaired on purpose;
 *  - it needs `acceptAutonomousRisk` as well as the pairing. The pairing alone
 *    is read and refused;
 *  - a failure is not retried in a loop; the next worker start tries again.
 *
 * On that second point: autonomous mode is normally switched on by a person,
 * on this extension's own surface, because it is the consent for a machine to
 * trade. A policy may give that consent for the machine it configures, and
 * only because the alternative is worse, not better. Whoever can write a file
 * into Chromium's managed-policy directory already owns that box: they can
 * read its browser profile, replace the extension, or drive the browser
 * outright. A click demanded inside the browser stops none of that; it only
 * forces the owner through a remote desktop, which is the step this exists to
 * remove. What the policy still cannot do is touch a machine where somebody
 * already paired by hand.
 *
 * @returns {Promise<{paired: boolean, reason: string}>}
 */
export async function pairFromPolicy() {
  let managed = {};
  try {
    // The whole bag, not one key: `acceptAutonomousRisk` is read below, and
    // a `get('runnerPairing')` would never return it.
    managed = (await chrome.storage.managed?.get(null)) ?? {};
  } catch {
    // No policy at all is the normal case on a person's own machine.
    return { paired: false, reason: 'no managed policy' };
  }
  const pairing = managed.runnerPairing;
  if (typeof pairing !== 'string' || !pairing.trim()) return { paired: false, reason: 'no pairing in the policy' };
  const cfg = await settings();
  if (cfg.mirror?.url) return { paired: false, reason: 'already paired; a policy does not override a person' };
  if (!autonomousOn(cfg)) {
    if (managed.acceptAutonomousRisk !== true) {
      return { paired: false, reason: `${AUTONOMY_REQUIRED}, or set acceptAutonomousRisk in the policy` };
    }
    // Recorded like a person's acknowledgement, and marked as the policy's so
    // the popup can say where the consent came from. Limit orders go on with
    // it: a runner browser exists to execute, and a policy that consents to
    // that consents to the switch the execution hangs on. Left off, the
    // runner pairs, polls and skips every round with "limit orders are
    // switched off in the popup", which is a remote desktop away from being
    // seen.
    await saveSettings({
      autonomousEnabled: true, autonomousAckAt: Date.now(), autonomousAckBy: 'policy', ordersEnabled: true,
    });
  }
  await pair({ pairing });
  return { paired: true, reason: 'paired from the managed policy' };
}

export async function ensureLoop() {
  if (looping) return;
  looping = true;
  try {
    while (await mirrorActive()) {
      try {
        const round = await pull({ wait: 20 });
        // With autonomous mode off on the owner's side the hub has no owner
        // and no orders, and there is nothing here to do. Holding a long poll
        // open every twenty seconds for an empty list is noise on both ends,
        // so the runner drops to a heartbeat and picks the loop back up by
        // itself when the owner returns, no touching this browser.
        if (round && round.ownerPaired === false) {
          await new Promise((r) => { setTimeout(r, IDLE_POLL_MS); });
        }
      } catch { await new Promise((r) => { setTimeout(r, 5000); }); }
    }
  } finally {
    looping = false;
  }
}
export function install() {
  // A browser paired while the runner switch still existed may have been
  // paused with it. The switch is gone, so nothing could turn it back on:
  // a paired runner is an enabled one.
  settings().then((cfg) => {
    if (cfg.mirror?.url && cfg.mirrorEnabled !== true) return saveSettings({ mirrorEnabled: true });
    return null;
  }).catch(() => { /* storage will be there on the next start */ });
  // A server browser provisioned by a policy pairs itself here, before the
  // loop, so its first round already has a hub to talk to.
  pairFromPolicy().then((r) => { if (r.paired) ensureLoop().catch(() => {}); }).catch(() => {});
  ensureLoop().catch(() => {});
  chrome.storage?.onChanged?.addListener((changes, area) => {
    // Chromium hands a third-party policy to the extension only after the
    // extension has registered its schema, so the first read at worker start
    // can be empty and the values arrive as a change on the `managed` area.
    // Without this the pairing waited for the next worker start, which a busy
    // browser never gives.
    if (area === 'managed') {
      pairFromPolicy().then((r) => { if (r.paired) ensureLoop().catch(() => {}); }).catch(() => {});
      return;
    }
    if (area !== 'local') return;
    if (changes.settings) ensureLoop().catch(() => {});
    if (!changes.orders) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pull().catch(() => {}); }, 1500);
  });
}
