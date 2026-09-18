// After an update the tab has to come back running the new build, and the
// worker has to know whether it did.
//
// Reloading a tab while the extension is still coming back up gives a page
// with no content scripts: fetch is never patched, the app's first request
// fails and the person sees an empty site. The fix is not a longer wait, it
// is asking the tab afterwards and reloading again if it cannot answer.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { reloadUntilFresh } from '../src/background/selfupdate.js';

const NOW = '2026-09-18 16:00:00';

/** A tab that starts answering `answersAfter` asks into reload number `onReload`. */
function fakeTab({ freshOnReload = 1, asksBeforeAnswer = 0 }) {
  const state = { reloads: 0, asks: 0, sleeps: 0 };
  return {
    state,
    reload: async () => { state.reloads += 1; state.asks = 0; },
    stampOf: async () => {
      state.asks += 1;
      const fresh = state.reloads >= freshOnReload && state.asks > asksBeforeAnswer;
      return fresh ? NOW : null;
    },
    sleep: async () => { state.sleeps += 1; },
  };
}

test('one reload, the tab answers, done', async () => {
  const tab = fakeTab({ freshOnReload: 1 });
  const out = await reloadUntilFresh(7, NOW, tab);
  assert.deepEqual(out, { ok: true, reloads: 1 });
  assert.equal(tab.state.reloads, 1, 'no second reload when the first worked');
});

test('a tab that needs a moment is waited for, not reloaded again', async () => {
  // The scripts are there but the page is still starting: it answers on the
  // third ask. Reloading again here would throw away a working load.
  const tab = fakeTab({ freshOnReload: 1, asksBeforeAnswer: 2 });
  const out = await reloadUntilFresh(7, NOW, tab);
  assert.equal(out.ok, true);
  assert.equal(tab.state.reloads, 1);
  assert.equal(tab.state.asks, 3, 'it kept asking while the tab settled');
});

test('a tab reloaded into the gap is reloaded a second time', async () => {
  // This is the reported bug: the first reload lands while the extension is
  // still registering its content scripts, so the page runs without them.
  const tab = fakeTab({ freshOnReload: 2 });
  const out = await reloadUntilFresh(7, NOW, tab);
  assert.deepEqual(out, { ok: true, reloads: 2 }, 'the second reload catches it');
});

test('a tab that never answers is left alone rather than reloaded forever', async () => {
  const tab = fakeTab({ freshOnReload: 99 });
  const out = await reloadUntilFresh(7, NOW, tab);
  assert.deepEqual(out, { ok: false, reloads: 2 });
  assert.equal(tab.state.reloads, 2, 'two reloads is the limit');
});

test('a tab running some other build is not mistaken for a fresh one', async () => {
  const tab = {
    state: { reloads: 0 },
    reload: async () => { tab.state.reloads += 1; },
    stampOf: async () => '2026-01-01 00:00:00',
    sleep: async () => {},
  };
  const out = await reloadUntilFresh(7, NOW, tab);
  assert.equal(out.ok, false);
});
