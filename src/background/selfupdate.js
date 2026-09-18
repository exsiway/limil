// Picks up a new build without anyone pressing ⟳.
//
// An unpacked extension runs the files it loaded at start. `npm run build`
// (or the server's update script) replaces them on disk, but the running
// service worker and the content scripts in open tabs keep the old code
// until the extension is reloaded. That was one manual click per machine,
// and on a server nobody is there to click.
//
// Every build writes its stamp to dist/build.json next to the bundles. The
// stamp compiled into this worker is compared with the one on disk every
// couple of minutes; when they differ and nothing is being executed, the
// extension reloads itself (chrome.runtime.reload re-reads an unpacked
// extension from disk), and on the way back up reloads the FOMO tabs whose
// content scripts still run the old bundle.

import { isBusy, note } from './runner.js';

const ALARM = 'limil-selfupdate';
const EVERY_MIN = 2;

/** The stamp compiled into this worker. */
export function ownStamp() {
  return typeof __LIMIL_BUILD__ === 'string' ? __LIMIL_BUILD__ : null;
}

/** The stamp of the files on disk right now, or null when unreadable. */
export async function diskStamp() {
  try {
    const res = await fetch(chrome.runtime.getURL('dist/build.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.stamp === 'string' ? json.stamp : null;
  } catch {
    return null;
  }
}

/** How long to give a reloaded tab before asking it which build it runs. */
const SETTLE_MS = 1500;
/** How many times to ask before reloading it again. */
const ASKS = 4;
/** How many reloads one tab gets before it is left alone. */
const RELOADS = 2;

/**
 * Reloads a tab until its content scripts answer with this build, or gives up.
 *
 * A reload is not the end of the job. Reloading a tab in the moment the
 * extension itself is coming back up gives a page with no content scripts at
 * all: `fetch` is never patched, FOMO's own first request fails and the person
 * sees an empty app and blames the update. Nothing noticed, because nobody
 * asked the tab afterwards what it was running.
 *
 * So the tab is asked, and asked again while it settles, and reloaded a second
 * time if it still cannot answer. Two reloads is the limit: past that the
 * cause is not a race and reloading forever would be worse than a stale tab.
 *
 * The moving parts are arguments so the policy can be tested without a browser.
 */
export async function reloadUntilFresh(tabId, mine, {
  stampOf, reload, sleep, asks = ASKS, reloads = RELOADS, settleMs = SETTLE_MS,
} = {}) {
  for (let attempt = 1; attempt <= reloads; attempt += 1) {
    await reload(tabId);
    for (let ask = 0; ask < asks; ask += 1) {
      // Asked before the first wait: a tab that came back cleanly answers at
      // once, and waiting on it would only make an update feel slow.
      if (await stampOf(tabId) === mine) return { ok: true, reloads: attempt };
      await sleep(settleMs);
    }
  }
  return { ok: false, reloads };
}

/** Reloads FOMO tabs whose content script does not report this worker's stamp. */
export async function reloadStaleTabs() {
  const mine = ownStamp();
  if (!mine) return 0;
  let reloaded = 0;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['https://fomo.family/*', 'https://*.fomo.family/*'] }); } catch { return 0; }
  const stampOf = async (tabId) => {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'ui.build' });
      return res?.result ?? res ?? null;
    } catch { return null; } // an orphaned old script cannot answer
  };
  for (const tab of tabs) {
    const theirs = await stampOf(tab.id);
    if (theirs !== mine) {
      // The reason travels into the tab (it survives the reload there) and
      // into the journal: a tab reloaded for no visible reason is a bug hunt.
      const why = `reloading tab ${tab.id}: it runs ${theirs ?? 'no answer'}, this worker runs ${mine}`;
      try { await chrome.tabs.sendMessage(tab.id, { type: 'ui.note', payload: { text: why } }); } catch { /* orphaned */ }
      note({ text: why }).catch(() => {});
      const out = await reloadUntilFresh(tab.id, mine, {
        stampOf,
        reload: async (id) => { try { await chrome.tabs.reload(id); } catch { /* tab gone */ } },
        sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
      });
      // Counted as reloaded either way: the number says how many tabs this
      // worker sent back, and a tab that would not come back fresh is a
      // separate line in the journal rather than a silent zero.
      reloaded += 1;
      if (!out.ok) {
        note({ text: `tab ${tab.id} still does not run ${mine} after ${out.reloads} reloads; reload it yourself if the app looks empty` })
          .catch(() => {});
      }
    }
  }
  return reloaded;
}

async function check() {
  const disk = await diskStamp();
  const mine = ownStamp();
  if (!disk || !mine || disk === mine) return { updated: false };
  // Not in the middle of a trade: a reload here would drop a signed
  // operation on the floor. The next check comes in two minutes.
  if (isBusy()) return { updated: false, reason: 'busy' };
  try { await chrome.storage.local.set({ 'selfupdate.pending': { from: mine, to: disk, at: Date.now() } }); } catch { /* fine */ }
  await note({ text: `new build on disk (${disk}), this worker runs ${mine}, reloading the extension` }).catch(() => {});
  chrome.runtime.reload();
  return { updated: true };
}

/**
 * Creates the alarm only when it does not exist yet. `chrome.alarms.create`
 * with an existing name cancels and replaces that alarm, which restarts its
 * period; the runner's alarm wakes this worker every minute and the worker
 * sleeps within half a minute, so an alarm re-created on every start never
 * reached its two minutes and never fired.
 */
async function ensureAlarm() {
  let existing = null;
  try { existing = await chrome.alarms.get(ALARM); } catch { /* treated as absent */ }
  if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: EVERY_MIN });
}

export function install() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) check().catch(() => { /* next time */ });
  });
  ensureAlarm().catch(() => { /* the start-up check below still runs */ });
  // Every worker start is a check too: the worker seldom lives long enough
  // for the alarm, and the check is one fetch of a 32-byte file. When the
  // build on disk is this one, tabs that still run a previous bundle are
  // reloaded; when it is newer, the extension reloads itself and the new
  // worker takes care of the tabs.
  check()
    .then((r) => (r.updated ? 0 : reloadStaleTabs()))
    .catch(() => reloadStaleTabs().catch(() => {}));
}
