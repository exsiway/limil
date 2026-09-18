// The grant round a runner browser runs when the hub's owner is a program.
//
// The laptop's order panel plans, signs the delegation on the page and sends
// one sponsored grant per key (isolated/limit-ui.js ensureGrantOn). A runner
// whose owner cannot sign has to do the same from the worker, and these pin
// that it does exactly that, in that order, and stops asking a wallet that
// cannot sign every twenty seconds.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { grantForHeadlessOwner, resetHeadlessRounds, HEADLESS_RETRY_MS } from '../src/background/headless-grant.js';

const SENDER = '0xabcdef0123456789abcdef0123456789abcdef01';
const KEY = '0x3333333333333333333333333333333333333333';
const DELEGATE = '0xc21366f5e034d1E13171aa150E1d0e31e31cc364';

function deps({ plan, onPage = async () => ({ sent: true }), tab = { id: 7 }, chains = [4663] } = {}) {
  const calls = [];
  const notes = [];
  return {
    calls, notes,
    d: {
      orderChains: async () => chains,
      grantPlan: async ({ chainId }) => (typeof plan === 'function' ? plan(chainId) : plan),
      fomoTab: async () => tab,
      askPage: async (tabId, type, payload) => { calls.push({ tabId, type, payload }); return onPage(type, payload); },
      note: async ({ text }) => { notes.push(text); },
    },
  };
}

const params = (chainId = 4663) => ({ sender: SENDER, chainId, key: KEY, targets: ['0xcd'], selectors: ['0x095ea7b3'], limits: {}, tokenCaps: [], guard: {}, swap: {}, revokeFirst: [], revokeOnly: false });

test('a wallet not yet delegated: the authorization is signed on the page, then the grant carries it', async () => {
  resetHeadlessRounds();
  const { d, calls, notes } = deps({
    plan: { needed: true, mainNeeded: true, delegation: { delegate: DELEGATE, from: '0xe6ca' }, params: params(), intents: { delegation: 'i-del', grant: 'i-grant' }, extra: [] },
    onPage: async (type) => (type === 'page.gate.signAuthorization' ? { authorizationRpc: { chainId: '0x1237' } } : { sent: true }),
  });
  const out = await grantForHeadlessOwner({ deps: d, now: 1_000 });
  assert.equal(out.acted, true);
  assert.deepEqual(calls.map((c) => c.type), ['page.gate.signAuthorization', 'page.session.grant']);
  assert.equal(calls[0].payload.allowLive, true, 'a live authorization, as the panel sends it');
  assert.equal(calls[0].payload.intent, 'i-del', 'bound to the worker\'s plan');
  assert.equal(calls[0].payload.delegate, DELEGATE);
  assert.equal(calls[1].payload.send, true);
  assert.equal(calls[1].payload.intent, 'i-grant');
  assert.deepEqual(calls[1].payload.authorization, { chainId: '0x1237' }, 'the authorization rides inside the grant operation');
  assert.equal(calls[1].payload.key, KEY, 'this browser\'s own key is what gets granted');
  assert.match(notes[0], /granted 0x3333/);
  assert.match(notes[0], /delegated/);
});

test('already delegated and a grant needed: one operation, no authorization', async () => {
  resetHeadlessRounds();
  const { d, calls } = deps({ plan: { needed: true, mainNeeded: true, delegation: null, params: params(), intents: { grant: 'i' }, extra: [] } });
  const out = await grantForHeadlessOwner({ deps: d });
  assert.equal(out.acted, true);
  assert.deepEqual(calls.map((c) => c.type), ['page.session.grant']);
  assert.equal(calls[0].payload.authorization, null);
});

test('a grant that covers the orders, a Solana-only list, or a blocked chain asks the page for nothing', async () => {
  resetHeadlessRounds();
  const covered = deps({ plan: { needed: false, reason: 'the grant covers the orders' } });
  assert.equal((await grantForHeadlessOwner({ deps: covered.d })).acted, false);
  assert.equal(covered.calls.length, 0);
  const none = deps({ chains: [] });
  assert.match((await grantForHeadlessOwner({ deps: none.d })).reason, /nothing to grant/);
  const blocked = deps({ plan: { needed: false, blocked: true, reason: 'the limil account contract is not deployed there' } });
  const b = await grantForHeadlessOwner({ deps: blocked.d });
  assert.equal(b.acted, false);
  assert.equal(blocked.calls.length, 0);
  assert.match(blocked.notes[0], /blocked/, 'said in the journal, where the owner reads it off the hub');
});

test('a page that cannot sign (no Privy envelope yet) is noted and not asked again for ten minutes', async () => {
  resetHeadlessRounds();
  const { d, calls, notes } = deps({
    plan: { needed: true, mainNeeded: true, delegation: null, params: params(), intents: { grant: 'i' }, extra: [] },
    onPage: async () => { throw new Error('no signing envelope: do one sell by hand in this tab'); },
  });
  const first = await grantForHeadlessOwner({ deps: d, now: 10_000 });
  assert.equal(first.acted, false);
  assert.match(first.results[0].reason, /envelope/);
  assert.match(notes[0], /failed: no signing envelope/);
  const soon = await grantForHeadlessOwner({ deps: d, now: 10_000 + HEADLESS_RETRY_MS / 2 });
  assert.match(soon.results[0].reason, /retried later/);
  assert.equal(calls.length, 1, 'not asked again inside the pause');
  await grantForHeadlessOwner({ deps: d, now: 10_000 + HEADLESS_RETRY_MS + 1 });
  assert.equal(calls.length, 2, 'asked again once the pause is over');
  await grantForHeadlessOwner({ deps: d, now: 10_000 + HEADLESS_RETRY_MS + 2, force: true });
  assert.equal(calls.length, 3, 'force ignores the pause');
});

test('a grant the page did not send is a failure, not a success with a note', async () => {
  resetHeadlessRounds();
  const { d, notes } = deps({
    plan: { needed: true, mainNeeded: true, delegation: null, params: params(), intents: { grant: 'i' }, extra: [] },
    onPage: async () => ({ sent: false, note: 'AA25 invalid account nonce' }),
  });
  const out = await grantForHeadlessOwner({ deps: d });
  assert.equal(out.acted, false);
  assert.match(out.results[0].reason, /AA25/);
  assert.match(notes[0], /runner key: AA25/);
});

test('every chain with orders gets its own round, and no FOMO tab is a stated reason', async () => {
  resetHeadlessRounds();
  const { d, calls } = deps({
    chains: [4663, 8453],
    plan: (chainId) => ({ needed: true, mainNeeded: true, delegation: null, params: params(chainId), intents: { grant: `i${chainId}` }, extra: [] }),
  });
  const out = await grantForHeadlessOwner({ deps: d });
  assert.equal(out.acted, true);
  assert.deepEqual(calls.map((c) => c.payload.chainId), [4663, 8453]);
  const noTab = deps({ plan: { needed: true, mainNeeded: true, params: params(), intents: {}, extra: [] }, tab: null });
  resetHeadlessRounds();
  const nt = await grantForHeadlessOwner({ deps: noTab.d });
  assert.equal(nt.results[0].reason, 'no FOMO tab');
  assert.equal(noTab.calls.length, 0);
});
