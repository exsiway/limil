// The whole runner round: sampling, triggering, ticket, signature.
//
// `tick()` is exercised as a real cycle against a fake chrome.*, with no
// network and no money: storage, tabs and alarms are stubbed, and the page is
// a function.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { buildUserOp, encodeExecuteBatch, userOpToJson, SESSION_VIEW_ABI } from '../src/shared/userop.js';
import { guardCalls, guardFloor } from '../src/shared/output-guard.js';
import { parseDecimal } from '../src/shared/swaps.js';

const SENDER = '0x1111111111111111111111111111111111111111';
/**
 * The wallet already runs our contract.
 *
 * The executor reads the delegate before it quotes: while the wallet runs
 * FOMO's own account, or nothing, the session key is not a signature to that
 * code and the bundler answers AA24, after a quote, an assembly and a
 * signature, costing the order an attempt and a pause. The fixtures answer
 * `eth_getCode` with our delegate so they exercise the path past that check.
 */
const DELEGATED_CODE = '0xef0100c21366f5e034d1e13171aa150e1d0e31e31cc364';
const isGetCode = (init) => String(init?.body ?? '').includes('eth_getCode');
const codeAnswer = { ok: true, status: 200, json: async () => ({ result: DELEGATED_CODE }) };
const TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROUTER = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const SECRET = `0x${'11'.repeat(32)}`;
const CHAIN = 4663;

/** The quote arrives as a human-readable decimal string, as from relay. */
const QUOTE = '100.500000000000000001';
/** Target below the market, so the order must fire. */
const TARGET = (parseDecimal('100.0')).toString();
/** A sample on which the target is NOT reached, for the watcher fixtures. */
const BELOW_TARGET = parseDecimal('99.0').toString();

const erc20 = (name, args) => encodeFunctionData({
  abi: [{
    type: 'function',
    name,
    stateMutability: 'nonpayable',
    inputs: [{ name: 'a', type: 'address' }, { name: 'b', type: 'uint256' }],
    outputs: [],
  }],
  functionName: name,
  args,
});

/**
 * The router's swap, with the arguments it actually reads. The trade size is
 * in `amounts`, not in the approve, so a fixture with an unreadable body is
 * a batch of unknown size and is refused before it is signed.
 */
const swapOf = (token, amount) => `0xf9e4bab4${encodeAbiParameters(
  [
    { type: 'address[]' }, { type: 'uint256[]' },
    { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'bytes' }] },
    { type: 'address' }, { type: 'address' }, { type: 'bytes' },
  ],
  [[token], [amount], [], SENDER, SENDER, '0x'],
).slice(2)}`;

/** A batch of exactly the shape swap-exec builds: guard, approve, swap, guard. */
function realUserOp() {
  const guard = guardCalls({ chainId: CHAIN, minGain: guardFloor({ targetOutScaled: TARGET, maxSlippageBps: 500 }).floor });
  const calls = [
    guard.before,
    { target: TOKEN, value: 0n, data: erc20('approve', [ROUTER, 1000n]) },
    { target: ROUTER, value: 0n, data: swapOf(TOKEN, 10000n) },
    guard.after,
  ];
  return userOpToJson(buildUserOp({
    sender: SENDER, nonce: 1n, callData: encodeExecuteBatch(calls),
  }));
}

const makeOrder = (over = {}) => ({
  id: 'o1',
  status: 'watching',
  sender: SENDER,
  // No chainId field: createOrder never stores one; the chain lives in inTokenId.
  inTokenId: `${TOKEN}:${CHAIN}`,
  outTokenId: 'cash',
  amount: '10000',
  targetOut: TARGET,
  maxSlippageBps: 500,
  ...over,
});

/**
 * Fake chrome.*: only what the runner touches, storage, tabs and alarms.
 * There is no network at all; the page answers through a function.
 */
const reloaded = [];
let tabsList = [{ id: 7 }];
let deafTabs = new Set();
function installChrome({ store, onPage, tabs = [{ id: 7 }], deaf = [] }) {
  const asked = [];
  // The orders switch in the popup is on in the fixtures unless a test says otherwise.
  store.settings = { ordersEnabled: true, ...(store.settings ?? {}) };
  reloaded.length = 0;
  tabsList = tabs;
  deafTabs = new Set(deaf);
  // The network is muted EXPLICITLY: signing reads the grant from the chain,
  // and without this stub the test went to a live RPC. The read fails, the
  // runner swallows it and signs, exactly as with an unreachable node. The
  // grant itself is checked separately in test/grant.test.mjs.
  globalThis.fetch = async () => { throw new Error('no network in the fixture'); };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(key) { delete store[key]; },
      },
    },
    tabs: {
      async query() { return tabsList; },
      async sendMessage(id, msg) {
        // The liveness ping is served separately: it must not land in `asked`
        // and must fail for deaf tabs, like the real sendMessage.
        if (msg?.type === 'ui.status') {
          if (deafTabs.has(id)) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { result: true };
        }
        asked.push({ ...msg, tabId: id });
        return onPage(msg, id);
      },
    },
    alarms: { async create() {}, async clear() {} },
  };
  globalThis.chrome.tabs.reload = async (id) => { reloaded.push(id); };
  return asked;
}

const armed = (now) => ({
  armed: true,
  armedUntil: now + 3600_000,
  sessionKeyAddress: privateKeyToAccount(SECRET).address,
  log: [],
  attempts: {},
  samples: {},
});

// ---------------------------------------------------------------------------

test('samples accumulate in the target scale, not as human-readable strings', async () => {
  const t0 = 1_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: (msg) => {
      // Before the trigger the runner may only quote.
      assert.equal(msg.type, 'page.swap.prepare');
      return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
    },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  const samples = store.runner.samples.o1;
  assert.equal(samples.length, 1);
  assert.equal(samples[0].out, parseDecimal(QUOTE).toString());
  assert.match(samples[0].out, /^\d+$/);
});

test('three confirmations suffice and the round reaches execution', async () => {
  const t0 = 2_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  let executed = null;
  installChrome({
    store,
    onPage: (msg) => {
      if (msg.type === 'page.swap.prepare') {
        return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      }
      executed = msg.payload;
      return { result: { sent: true, userOpHash: '0xdead' } };
    },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  assert.equal(executed, null, 'two samples are not enough, that is the protection against a spike');
  await tick({ now: t0 + 2000 });

  assert.ok(executed, 'the order must execute on the third confirmation');
  // The node does not answer in this test, so the sell cannot be confirmed:
  // the order leaves the active set as `triggered` rather than waiting to fire again.
  assert.equal(store.orders[0].status, 'triggered');
  // The target travels under a name that carries its scale.
  assert.equal(executed.targetOutScaled, TARGET);
  assert.equal(executed.orderId, 'o1');
  assert.equal(store.runner.log.at(-1).act, 'sent');
});

test('the ticket lives for exactly one signature and does not come back after the round', async () => {
  // Real time: signForRunner checks the ticket by Date.now(), not by the passed `now`.
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  const mod = await import('../src/background/runner.js');
  const seen = [];

  installChrome({
    store,
    onPage: async (msg) => {
      if (msg.type === 'page.swap.prepare') {
        return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      }
      // The page asks for a signature exactly the way swap-exec does.
      const ask = () => mod.signForRunner({
        userOp: realUserOp(), chainId: CHAIN, orderId: msg.payload.orderId,
      });
      seen.push(await ask().then((s) => ({ ok: true, s })).catch((e) => ({ ok: false, e: e.message })));
      // A second request on the same ticket is reuse.
      seen.push(await ask().then((s) => ({ ok: true, s })).catch((e) => ({ ok: false, e: e.message })));
      return { result: { sent: true, userOpHash: '0xdead' } };
    },
  });

  await mod.tick({ now: t0 });
  await mod.tick({ now: t0 + 1000 });
  await mod.tick({ now: t0 + 2000 });

  assert.equal(seen.length, 2, 'a signature should have been requested');
  assert.equal(seen[0].ok, true, `first signature not issued: ${seen[0].e}`);
  assert.match(seen[0].s, /^0x[0-9a-f]{130}$/);
  assert.equal(seen[1].ok, false);
  assert.match(seen[1].e, /already used/);
  // After the round there is no ticket at all.
  assert.equal(store['runner.ticket'], undefined);
});

test('without a session key the runner neither quotes nor signs', async () => {
  const t0 = 4_000_000;
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), sessionKeyAddress: null },
    'runner.secret': SECRET,
  };
  const asked = installChrome({ store, onPage: () => assert.fail('the page must not be touched') });
  const mod = await import('../src/background/runner.js');

  const out = await mod.tick({ now: t0 });
  assert.equal(out.acted, false);
  assert.equal(asked.length, 0);

  await assert.rejects(
    () => mod.signForRunner({ userOp: realUserOp(), chainId: CHAIN, orderId: 'o1' }),
    /not working.*no session key/,
  );
});

test('a broken entry in the orders does not sink the round', async () => {
  // chrome.storage returns an undefined array element as null.
  const t0 = 5_000_000;
  const store = { orders: [null, makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  const out = await tick({ now: t0 });
  assert.equal(out.acted, true);
  assert.equal(store.runner.samples.o1.length, 1);
});

test('a second key creation does not silently erase the first', async () => {
  const store = { 'runner.secret': SECRET, runner: { sessionKeyAddress: '0xabc' } };
  installChrome({ store, onPage: () => ({}) });
  const mod = await import('../src/background/runner.js');

  await assert.rejects(() => mod.createSessionKey(), /already exists/);
  assert.equal(store['runner.secret'], SECRET, 'the previous key must remain');

  // An explicit replacement is allowed and changes the key.
  const made = await mod.createSessionKey({ replace: true });
  assert.match(made.address, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(store['runner.secret'], SECRET);
});

test('a round without orders leaves an entry but does not repeat it', async () => {
  const t0 = 6_000_000;
  const store = { orders: [], runner: armed(t0), 'runner.secret': SECRET };
  const asked = installChrome({ store, onPage: () => assert.fail('nothing to quote') });
  const { tick } = await import('../src/background/runner.js');

  const out = await tick({ now: t0 });
  assert.equal(out.acted, false);
  assert.equal(asked.length, 0, 'the page is not touched without orders');
  assert.equal(store.runner.log.length, 1);
  assert.equal(store.runner.log[0].act, 'idle');
  assert.match(store.runner.log[0].reason, /no orders are watched/);

  // A second round back to back must not multiply the same line.
  await tick({ now: t0 + 60_000 });
  await tick({ now: t0 + 120_000 });
  assert.equal(store.runner.log.length, 1, 'a back-to-back repeat is not written');
});

test('a new order breaks the silence', async () => {
  const t0 = 7_000_000;
  const store = { orders: [], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.equal(store.runner.log.at(-1).act, 'idle');

  store.orders = [makeOrder()];
  await tick({ now: t0 + 60_000 });
  assert.equal(store.runner.log.at(-1).act, 'watch', 'with an order the round speaks again');
});

// ------------------------------------------------------------------- tabs

test('a deaf tab is called deaf, not a quote refusal', async () => {
  // After an extension update the content script in an open tab is orphaned:
  // tabs.query finds it, but nobody answers.
  const t0 = 8_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  const last = store.runner.log.at(-1);
  assert.equal(last.act, 'skip');
  assert.match(last.reason, /FOMO tab did not answer/);
  assert.match(last.reason, /reloaded/);
  assert.ok(!/quote failed/.test(last.reason), 'the quote is not to blame');
});

test('a channel closed midway reads the same', async () => {
  const t0 = 9_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: () => {
      throw new Error('A listener indicated an asynchronous response by returning true, '
        + 'but the message channel closed before a response was received');
    },
  });
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  assert.match(store.runner.log.at(-1).reason, /FOMO tab did not answer/);
});

test('a raised daily limit really lets the round through', async () => {
  const t0 = Date.now();
  const fired = [1, 2, 3, 4, 5].map((i) => ({ at: t0 - i * 60_000, fired: true, act: 'fired' }));
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), log: fired },
    'runner.secret': SECRET,
    settings: { runnerMaxFiresPerDay: 20 },
  };
  installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  const out = await tick({ now: t0 });
  assert.equal(out.acted, true, 'at a limit of 20 with five firings the round must run');
  assert.equal(store.runner.log.at(-1).act, 'watch');
});

test('without the setting the default limit stops the round', async () => {
  const t0 = Date.now();
  const fired = [1, 2, 3, 4, 5].map((i) => ({ at: t0 - i * 60_000, fired: true, act: 'fired' }));
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), log: fired },
    'runner.secret': SECRET,
  };
  installChrome({ store, onPage: () => assert.fail('must not quote') });
  const { tick } = await import('../src/background/runner.js');

  const out = await tick({ now: t0 });
  assert.equal(out.acted, false);
  assert.match(out.reason, /5 executions today at a limit of 5/);
});

test('the runner reloads a deaf tab itself', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.equal(reloaded.length, 1, 'the tab should have been reloaded');
  assert.match(store.runner.log.at(-1).reason, /reloaded it/);

  // The next round does not hammer the reload: if it did not help, say so.
  await tick({ now: t0 + 60_000 });
  assert.equal(reloaded.length, 1, 'no second reload');
});

test('a deaf tab yields ONE entry per round, not one per order', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder(), makeOrder({ id: 'o2' })],
    runner: armed(t0),
    'runner.secret': SECRET,
  };
  installChrome({
    store,
    onPage: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  const deaf = store.runner.log.filter((e) => /FOMO tab/.test(e.reason));
  assert.equal(deaf.length, 1, 'two orders must produce one entry');
  assert.match(deaf[0].reason, /reloaded it/);
  assert.equal(reloaded.length, 1);
});

// ------------------------------------------------- delegation before the trade

test('a wallet delegated elsewhere is skipped in words, not sent to the bundler', async () => {
  // What this looked like in life: a new FOMO account, still running FOMO's
  // own Simple7702Account. The runner quoted, assembled, signed and sent,
  // and the bundler answered "AA24 signature error", which spent an attempt
  // and put the order on a pause, once a minute, saying nothing about the one
  // thing that was actually missing.
  const t0 = 2_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  globalThis.fetch = async (url, init) => {
    // FOMO's own account, not ours.
    if (isGetCode(init)) return { ok: true, status: 200, json: async () => ({ result: '0xef0100e6cae83bde06e4c305530e199d7217f42808555b' }) };
    if (String(url).includes('relay.link')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ details: { swapImpact: { percent: '0.10' } } }) };
    }
    return { ok: true, json: async () => ({ result: `0x${(0n).toString(16).padStart(64, '0')}` }) };
  };
  const { tick } = await import('../src/background/runner.js');
  // Three rounds: the trigger needs three confirmations before execution is
  // even considered, and it is at execution that the delegate matters.
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });

  const line = store.runner.log.at(-1);
  assert.equal(line.act, 'skip');
  assert.match(line.reason, /not the limil account/);
  assert.match(line.reason, /0xe6cae83b/i, 'the reason names what the wallet does run');
  assert.equal(asked.some((m) => m.type === 'page.swap.execute'), false, 'nothing was sent for execution');
  assert.equal(store['runner.ticket'], undefined, 'and no signing ticket was issued');
  assert.equal(store.orders[0].status, 'watching', 'the order lives, the delegation is a missing step, not a failure');
});

test('an undelegated wallet is skipped too, and says so', async () => {
  const t0 = 2_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({ store, onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }) });
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) return { ok: true, status: 200, json: async () => ({ result: '0x' }) };
    if (String(url).includes('relay.link')) return { ok: true, status: 200, text: async () => JSON.stringify({ details: { swapImpact: { percent: '0.10' } } }) };
    return { ok: true, json: async () => ({ result: `0x${(0n).toString(16).padStart(64, '0')}` }) };
  };
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });
  assert.match(store.runner.log.at(-1).reason, /not delegated yet/);
});

test('a node that will not answer does not block the round', async () => {
  // Silence is not proof of anything: the chain stays the last word, as
  // before this check existed.
  const t0 = 2_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({ store, onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }) });
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) throw new Error('the node is silent');
    if (String(url).includes('relay.link')) return { ok: true, status: 200, text: async () => JSON.stringify({ details: { swapImpact: { percent: '0.10' } } }) };
    return { ok: true, json: async () => ({ result: `0x${(0n).toString(16).padStart(64, '0')}` }) };
  };
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });
  assert.notEqual(store.runner.log.at(-1).reason ?? '', undefined);
  assert.equal(/not delegated|not the limil account/.test(store.runner.log.at(-1).reason ?? ''), false,
    'a silent node is not reported as a missing delegation');
});

test('the runner picks a tab that answers, not the first in the list', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    tabs: [{ id: 1 }, { id: 2 }],
    deaf: [1],
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  const out = await tick({ now: t0 });
  assert.equal(out.acted, true, 'a live tab exists, the round must go through');
  assert.equal(store.runner.log.at(-1).act, 'watch');
});

test('when every tab is deaf, the first one is healed', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    tabs: [{ id: 1 }, { id: 2 }],
    deaf: [1, 2],
    onPage: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.deepEqual(reloaded, [1]);
});

test('a confirmed sell closes the order, an unconfirmed one takes it off watch', async () => {
  const t0 = Date.now();
  const order = makeOrder({ amount: (1000n * 10n ** 18n).toString() });
  const store = { orders: [order], runner: armed(t0), 'runner.secret': SECRET };

  installChrome({
    store,
    onPage: (msg) => (msg.type === 'page.swap.prepare'
      ? { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }
      : { result: { sent: true, userOpHash: '0xabc' } }),
  });

  // The network stub is set AFTER installChrome, which mutes fetch itself.
  // The balance drops by exactly the order amount, the sell happened.
  let call = 0;
  const before = 2000n * 10n ** 18n;
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) return codeAnswer;
    // The impact measurement uses the same fetch against relay: answer "pool
    // fine" so the balance counter sees only node requests.
    if (String(url).includes('relay.link')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ details: { swapImpact: { percent: '0.10' } } }) };
    }
    call += 1;
    const value = call === 1 ? before : before - 1000n * 10n ** 18n;
    return { ok: true, json: async () => ({ result: `0x${value.toString(16).padStart(64, '0')}` }) };
  };
  const mod = await import('../src/background/runner.js');

  await mod.tick({ now: t0 });
  await mod.tick({ now: t0 + 1000 });
  await mod.tick({ now: t0 + 2000 });

  assert.equal(store.orders[0].status, 'filled', 'a confirmed sell closes the order');
  assert.equal(store.runner.log.at(-1).act, 'filled');
  assert.match(store.runner.log.at(-1).reason, /confirmed by balance/);
});

test('after two refusals in a row the runner backs off instead of hammering', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  let asks = 0;
  installChrome({
    store,
    onPage: () => { asks += 1; throw new Error('Failed to fetch'); },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  await tick({ now: t0 + 60_000 });
  assert.equal(asks, 2, 'the first two times we ask');
  // The error text must stay in the line.
  assert.match(store.runner.log.at(-1).reason, /network refusal/);
  assert.match(store.runner.log.at(-1).reason, /Failed to fetch/);

  // A third round INSIDE the pause (until t0+120 s) must not touch their API.
  await tick({ now: t0 + 90_000 });
  assert.equal(asks, 2, 'no asking inside the pause');
  assert.match(store.runner.log.at(-1).reason, /waiting/);
});

test('a successful quote resets the refusal counter', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  let fail = true;
  installChrome({
    store,
    onPage: () => {
      if (fail) throw new Error('Failed to fetch');
      return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
    },
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.equal(store.runner.quoteFails, 1);

  fail = false;
  await tick({ now: t0 + 60_000 });
  assert.equal(store.runner.quoteFails, 0, 'success resets the counter');
  assert.equal(store.runner.quoteBlockedUntil, 0);
});

// ---------------------------------------------------------------- watcher

test('the watcher nudge checks only its own order and one quote suffices', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder(), makeOrder({ id: 'o2' })],
    runner: armed(t0),
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: (msg) => (msg.type === 'page.swap.prepare'
      ? { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }
      : { result: { sent: true, userOpHash: '0xabc' } }),
  });
  const mod = await import('../src/background/runner.js');

  await mod.nudge({ orderId: 'o2' });

  // Exactly one order was quoted, not both.
  const quotes = asked.filter((m) => m.type === 'page.swap.prepare');
  assert.equal(quotes.length, 1, 'spare quotes are a step towards a refusal of their API');
  const last = store.runner.log.at(-1);
  assert.equal(last.orderId, 'o2');
  assert.ok(['fired', 'sent', 'filled', 'failed'].includes(last.act), `reached execution: ${last.act}`);
});

test('a nudge without an order does nothing', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  const asked = installChrome({ store, onPage: () => assert.fail('nothing to quote') });
  const mod = await import('../src/background/runner.js');
  const out = await mod.nudge({});
  assert.equal(out.acted, false);
  assert.equal(asked.length, 0);
});

test('while the watcher follows the price the scheduled round does not quote', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: {
      ...armed(t0),
      watchdogAt: t0 - 10_000,
      watchdogLevels: 1,
      watchdogIds: ['o1'],
      // A fresh quote on which the target is NOT reached: only then can the
      // watcher be taken at its word.
      samples: { o1: [{ out: BELOW_TARGET, at: t0 - 60_000 }] },
    },
    'runner.secret': SECRET,
  };
  const asked = installChrome({ store, onPage: () => assert.fail('must not quote') });
  const { tick } = await import('../src/background/runner.js');

  const out = await tick({ now: t0 });
  assert.equal(out.acted, false);
  assert.equal(asked.length, 0, 'not a single call to the page');
  assert.match(store.runner.log.at(-1).reason, /watcher/);
});

test('when the watcher falls silent the round quotes again', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    // The heartbeat is older than two minutes: the tick stream stopped.
    runner: { ...armed(t0), watchdogAt: t0 - 5 * 60_000, watchdogLevels: 1 },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.ok(asked.length > 0, 'without the watcher polling must return');
});

test('a nudge quotes even with a live watcher', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), watchdogAt: t0 - 1000, watchdogLevels: 1, watchdogIds: ['o1'] },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: (msg) => (msg.type === 'page.swap.prepare'
      ? { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }
      : { result: { sent: true, userOpHash: '0xabc' } }),
  });
  const mod = await import('../src/background/runner.js');

  await mod.nudge({ orderId: 'o1' });
  assert.ok(asked.length > 0, 'a crossing must reach a quote');
});

test('the watcher nudge bypasses a short refusal backoff', async () => {
  // The backoff saves quotes from being wasted; a level crossing is exactly the
  // case where a quote is not wasted. The bypass holds while refusals are FEW.
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), quoteBlockedUntil: t0 + 5 * 60_000, quoteFails: 2 },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: (msg) => (msg.type === 'page.swap.prepare'
      ? { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }
      : { result: { sent: true, userOpHash: '0xabc' } }),
  });
  const mod = await import('../src/background/runner.js');

  // The scheduled round respects the pause.
  await mod.tick({ now: t0 });
  assert.equal(asked.length, 0, 'the scheduled round is silent inside the pause');

  // A crossing does not.
  await mod.nudge({ orderId: 'o1' });
  assert.ok(asked.length > 0, 'a crossing must reach a quote');
});

test('an order the watcher does not see keeps being quoted', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder(), makeOrder({ id: 'o2' })],
    // The watcher is alive but sees only one level of two orders.
    runner: { ...armed(t0), watchdogAt: t0 - 5_000, watchdogLevels: 1, watchdogIds: ['o1'] },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.ok(asked.length > 0, 'an order invisible to the watcher must be quoted');
});

test('when the watcher sees every order, polling is silent', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: {
      ...armed(t0),
      watchdogAt: t0 - 5_000,
      watchdogLevels: 1,
      watchdogIds: ['o1'],
      samples: { o1: [{ out: BELOW_TARGET, at: t0 - 60_000 }] },
    },
    'runner.secret': SECRET,
  };
  const asked = installChrome({ store, onPage: () => assert.fail('must not quote') });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.equal(asked.length, 0);
  assert.match(store.runner.log.at(-1).reason, /watcher follows the price \(1 of 1\)/);
});

test('an order without a single quote is not left to the watcher', async () => {
  // The watcher level is derived from the market cap, execution from the
  // quote. Without one quote there is nothing to compare them with.
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), watchdogAt: t0 - 5_000, watchdogLevels: 1, watchdogIds: ['o1'] },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.ok(asked.length > 0, 'the first quote must happen');
});

test('a control quote goes out even with a live watcher after the floor interval', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: {
      ...armed(t0),
      watchdogAt: t0 - 5_000,
      watchdogLevels: 1,
      watchdogIds: ['o1'],
      samples: { o1: [{ out: BELOW_TARGET, at: t0 - 11 * 60_000 }] },
    },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.ok(asked.length > 0, 'after minutes of silence a control quote is due');
});

test('once a quote shows the target reached, the watcher is no longer trusted', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: {
      ...armed(t0),
      watchdogAt: t0 - 5_000,
      watchdogLevels: 1,
      watchdogIds: ['o1'],
      samples: { o1: [{ out: parseDecimal(QUOTE).toString(), at: t0 - 30_000 }] },
    },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.ok(asked.length > 0, 'a reached target must override the watcher silence');
});

test('stale levels do not count as coverage of a live order', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder({ id: 'live' })],
    runner: {
      ...armed(t0),
      watchdogAt: t0 - 5_000,
      watchdogLevels: 2,
      watchdogIds: ['closed-1', 'closed-2'],
    },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const { tick } = await import('../src/background/runner.js');

  await tick({ now: t0 });
  assert.ok(asked.length > 0, 'an uncovered order must be quoted');
});

test('the nudge and the alarm do not sell one position twice', async () => {
  const t0 = Date.now();
  const sample = { out: parseDecimal(QUOTE).toString(), at: t0 - 1000 };
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [sample, sample, sample] } },
    'runner.secret': SECRET,
  };

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let executes = 0;
  installChrome({
    store,
    onPage: async (msg) => {
      if (msg.type === 'page.swap.prepare') {
        return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      }
      executes += 1;
      // Hold the first send until the second round reaches its fork: that is
      // the window in which the position could be sold twice.
      await held;
      return { result: { sent: true, userOpHash: '0xdead' } };
    },
  });
  const mod = await import('../src/background/runner.js');

  const byAlarm = mod.tick({ now: t0 });
  const byWatchdog = mod.nudge({ orderId: 'o1' });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  release();
  await Promise.all([byAlarm, byWatchdog]);

  assert.equal(executes, 1, 'a second send for the same order is not allowed');
  // Rounds run in turn: the second starts after the first closed the order.
  const skipped = (store.runner.log ?? []).find((e) => /no longer watched|already being executed/.test(e.reason ?? ''));
  assert.ok(skipped, 'the refusal of the second round must be in the journal');
  // The first round's entry is NOT lost.
  const sent = (store.runner.log ?? []).find((e) => e.orderId === 'o1' && e.fired);
  assert.ok(sent, 'the first round\'s execution must stay in the journal');
  assert.equal(store.orders[0].status, 'triggered');
});

test('a second tab on another token does not remove coverage from an order', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [{ out: BELOW_TARGET, at: t0 - 60_000 }] } },
    'runner.secret': SECRET,
  };
  const asked = installChrome({ store, onPage: () => assert.fail('must not quote') });
  const mod = await import('../src/background/runner.js');

  // The tab with the order sees it.
  await mod.watchdog({ levels: 1, ids: ['o1'] });
  // A tab on another token has no levels and reports an empty list.
  await mod.watchdog({ levels: 0, ids: [] });

  await mod.tick({ now: t0 });
  assert.equal(asked.length, 0, 'the order is still covered by the other tab');
  assert.match(store.runner.log.at(-1).reason, /watcher follows the price \(1 of 1\)/);
});

test('a closed tab loses its coverage on its own', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [{ out: BELOW_TARGET, at: t0 - 60_000 }] } },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const mod = await import('../src/background/runner.js');

  await mod.watchdog({ levels: 1, ids: ['o1'] });
  // The heartbeat is fresh, but this order's confirmation is older than the freshness window.
  store.runner.watchdogSeen = { o1: t0 - 5 * 60_000 };
  store.runner.watchdogAt = t0;

  await mod.tick({ now: t0 });
  assert.ok(asked.length > 0, 'an unconfirmed order must be quoted');
});

test('a stale session is fixed by a tab reload, not by waiting', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [{ out: BELOW_TARGET, at: t0 - 60_000 }] } },
    'runner.secret': SECRET,
  };
  installChrome({
    store,
    onPage: () => { throw new Error('FOMO API 401: {"message":"JWT token expired"}'); },
  });
  const mod = await import('../src/background/runner.js');

  await mod.tick({ now: t0 });
  assert.deepEqual(reloaded, [7], 'the tab must be reloaded');
  assert.match(store.runner.log.at(-1).reason, /FOMO session (went|is) stale/i);
  // This does not count towards the refusal backoff.
  assert.ok(!store.runner.quoteFails, 'an authorization failure does not accumulate backoff');
});

test('the nudge bypasses a short pause but respects a long one', async () => {
  const t0 = Date.now();
  const few = {
    orders: [makeOrder()],
    runner: { ...armed(t0), quoteFails: 2, quoteBlockedUntil: t0 + 60_000, samples: {} },
    'runner.secret': SECRET,
  };
  let asked = installChrome({
    store: few,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const mod = await import('../src/background/runner.js');
  await mod.tick({ now: t0, onlyOrderId: 'o1', confirmations: 1 });
  assert.ok(asked.length > 0, 'the nudge bypasses a short pause');

  const many = {
    orders: [makeOrder()],
    runner: { ...armed(t0), quoteFails: 5, quoteBlockedUntil: t0 + 60_000, samples: {} },
    'runner.secret': SECRET,
  };
  asked = installChrome({ store: many, onPage: () => assert.fail('must not ask') });
  await mod.tick({ now: t0, onlyOrderId: 'o1', confirmations: 1 });
  assert.equal(asked.length, 0, 'the nudge respects a long pause');
});

test('the runner picks the tab with a LIVE chart, not the first that answers', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: {} },
    'runner.secret': SECRET,
    settings: { ordersEnabled: true },
  };
  const askedTabs = [];
  tabsList = [{ id: 1 }, { id: 2 }, { id: 3 }];
  globalThis.fetch = async () => { throw new Error('no network in the fixture'); };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(key) { delete store[key]; },
      },
    },
    tabs: {
      async query() { return tabsList; },
      async reload() {},
      async sendMessage(id, msg) {
        if (msg?.type === 'ui.status') {
          // The first is throttled (a three-minute-old tick), the second is
          // live, the third has no chart at all.
          const byId = {
            1: { livePriceAgeMs: 180_000, visible: false },
            2: { livePriceAgeMs: 900, visible: true },
            3: { visible: false },
          };
          return { result: byId[id] };
        }
        askedTabs.push(id);
        return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      },
    },
    alarms: { async create() {}, async clear() {} },
  };
  const mod = await import('../src/background/runner.js');

  await mod.tick({ now: t0 });
  assert.deepEqual([...new Set(askedTabs)], [2], 'quoting must go through the live tab');
});

test('ten orders do not become ten quotes a minute', async () => {
  const t0 = Date.now();
  const orders = Array.from({ length: 10 }, (_, i) => makeOrder({
    id: `o${i}`, inTokenId: `0x${String(i).repeat(40).slice(0, 40)}:${CHAIN}`,
  }));
  const store = { orders, runner: { ...armed(t0), samples: {} }, 'runner.secret': SECRET };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const mod = await import('../src/background/runner.js');

  await mod.tick({ now: t0 });
  const quotes = asked.filter((m) => m.type === 'page.swap.prepare').length;
  assert.ok(quotes <= 3, `asked ${quotes} in one round, at most three expected`);
});

test('the queue is round-robin: nobody starves', async () => {
  const t0 = Date.now();
  // Each order has its own amount: the quote payload carries no order id, and
  // the amount is the only way to tell them apart in the fake page.
  const orders = Array.from({ length: 6 }, (_, i) => makeOrder({
    id: `o${i}`, amount: String(1000 + i),
  }));
  const store = {
    orders,
    runner: {
      ...armed(t0),
      // The first three have a fresh sample, the rest have none at all.
      samples: { o0: [{ out: BELOW_TARGET, at: t0 - 1000 }],
        o1: [{ out: BELOW_TARGET, at: t0 - 2000 }],
        o2: [{ out: BELOW_TARGET, at: t0 - 3000 }] },
    },
    'runner.secret': SECRET,
  };
  const asked = installChrome({
    store,
    onPage: () => ({ result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }),
  });
  const mod = await import('../src/background/runner.js');

  await mod.tick({ now: t0 });
  const askedAmounts = asked.filter((m) => m.type === 'page.swap.prepare').map((m) => m.payload.amount);
  assert.deepEqual(askedAmounts.sort(), ['1003', '1004', '1005'],
    'those without samples must be asked');
});

test('the daily limit grows with the number of orders', async () => {
  const { limitsWith, RUNNER_LIMITS } = await import('../src/shared/runner.js');
  assert.equal(limitsWith({}, RUNNER_LIMITS, 0).maxFiresPerDay, 5, 'without orders, the base five');
  assert.equal(limitsWith({}, RUNNER_LIMITS, 2).maxFiresPerDay, 5, 'five suffice for a couple of orders');
  assert.equal(limitsWith({}, RUNNER_LIMITS, 10).maxFiresPerDay, 20, 'ten orders, two per order');
  // The hard ceiling stays: a runaway loop hits it anyway.
  assert.equal(limitsWith({}, RUNNER_LIMITS, 100).maxFiresPerDay, RUNNER_LIMITS.maxFiresPerDayCeiling);
  // An explicit setting still wins.
  assert.equal(limitsWith({ runnerMaxFiresPerDay: 7 }, RUNNER_LIMITS, 10).maxFiresPerDay, 7);
});

// ------------------------------------------------------- after the signature

test('a signature was issued and the page did not answer, the order leaves the watch', async () => {
  const t0 = Date.now();
  const sample = { out: parseDecimal(QUOTE).toString(), at: t0 - 1000 };
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [sample, sample, sample] } },
    'runner.secret': SECRET,
  };
  const mod = await import('../src/background/runner.js');
  installChrome({
    store,
    onPage: async (msg) => {
      if (msg.type === 'page.swap.prepare') {
        return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      }
      await mod.signForRunner({ userOp: realUserOp(), chainId: CHAIN, orderId: msg.payload.orderId });
      throw new Error('timed out waiting for "swap.execute" from world main');
    },
  });

  await mod.tick({ now: t0 });
  assert.equal(store.orders[0].status, 'triggered', 'after an issued signature the order does not stay live');
  const entry = store.runner.log.find((e) => e.orderId === 'o1');
  assert.equal(entry.act, 'sent');
  assert.equal(entry.fired, true, 'counts as an execution, the daily limit includes it');
  assert.match(entry.reason, /CHECK THE POSITION/);
});

test('a bundler refusal in words after the signature keeps the order watched', async () => {
  const t0 = Date.now();
  const sample = { out: parseDecimal(QUOTE).toString(), at: t0 - 1000 };
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [sample, sample, sample] } },
    'runner.secret': SECRET,
  };
  const mod = await import('../src/background/runner.js');
  installChrome({
    store,
    onPage: async (msg) => {
      if (msg.type === 'page.swap.prepare') {
        return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      }
      await mod.signForRunner({ userOp: realUserOp(), chainId: CHAIN, orderId: msg.payload.orderId });
      throw new Error('bundler refused (-32500): AA23 reverted');
    },
  });

  await mod.tick({ now: t0 });
  assert.equal(store.orders[0].status, 'watching');
  const entry = store.runner.log.find((e) => e.orderId === 'o1');
  assert.equal(entry.act, 'failed');
  assert.equal(entry.fired, false);
});

test('an order cancelled during the quote is not executed', async () => {
  const t0 = Date.now();
  const sample = { out: parseDecimal(QUOTE).toString(), at: t0 - 1000 };
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [sample, sample, sample] } },
    'runner.secret': SECRET,
  };
  let executed = 0;
  installChrome({
    store,
    onPage: async (msg) => {
      if (msg.type === 'page.swap.prepare') {
        // While the quote ran, the person cancelled the order from the panel.
        store.orders = [{ ...store.orders[0], status: 'cancelled' }];
        return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      }
      executed += 1;
      return { result: { sent: true } };
    },
  });
  const mod = await import('../src/background/runner.js');
  await mod.tick({ now: t0 });
  assert.equal(executed, 0);
  assert.match(store.runner.log.at(-1).reason, /already in status cancelled/);
});

test('a signature under another chain is not issued', async () => {
  const t0 = Date.now();
  const store = {
    orders: [makeOrder()],
    runner: armed(t0),
    'runner.secret': SECRET,
    'runner.ticket': { orderId: 'o1', at: t0, used: false },
  };
  installChrome({ store, onPage: () => ({}) });
  const mod = await import('../src/background/runner.js');
  await assert.rejects(
    mod.signForRunner({ userOp: realUserOp(), chainId: 8453, orderId: 'o1' }),
    /chain 8453, but the order is on chain 4663/,
  );
});

test('every chain with live orders is owed a grant, newest first', async () => {
  // A grant lives on ONE chain: the chain id is inside the authorization the
  // owner signs, and the grant sits in the account's storage there. Planning
  // only the newest order's chain left a second chain un-granted and silent
  // until an order happened to be placed on it.
  const OTHER = '0x2222222222222222222222222222222222222222';
  const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149';
  const store = {
    orders: [
      makeOrder({ id: 'new', inTokenId: `${TOKEN}:${CHAIN}` }),
      makeOrder({ id: 'base', inTokenId: `${OTHER}:8453` }),
      makeOrder({ id: 'sol', inTokenId: SOL }),
      makeOrder({ id: 'dead', inTokenId: `${OTHER}:8453`, status: 'cancelled' }),
    ],
    runner: armed(Date.now()),
    'runner.secret': SECRET,
  };
  installChrome({ store, onPage: () => ({}) });
  const mod = await import('../src/background/runner.js');
  const chains = await mod.orderChains();
  assert.deepEqual(chains, [CHAIN, 8453], 'newest first, Solana left out, cancelled left out');
});

test('a Solana order asks for no grant and reports no fault', async () => {
  // "Auto-execution of sells is not available on chain 1399811149, the
  // settlement token is not described there" would be the whole message under
  // a freshly saved Solana order, and nothing is wrong: a Solana sell is
  // signed by Privy on Solana, with no delegation, no session key and no
  // grant. Said like a fault, it sends people looking for one.
  const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149';
  const store = {
    orders: [makeOrder({ id: 'sol', inTokenId: SOL })],
    runner: armed(Date.now()),
    'runner.secret': SECRET,
  };
  installChrome({ store, onPage: () => ({}) });
  const mod = await import('../src/background/runner.js');
  const plan = await mod.grantPlan();
  assert.equal(plan.needed, false);
  assert.equal(plan.blocked, undefined, 'not a fault, there is simply nothing to grant');
  assert.match(plan.reason, /signed on Solana/);
  assert.deepEqual(await mod.orderChains(), [], 'and no chain owes a grant');
});

test('a plan can be asked for a chain that is not the newest', async () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  const store = {
    orders: [
      makeOrder({ id: 'new', inTokenId: `${TOKEN}:${CHAIN}` }),
      makeOrder({ id: 'base', inTokenId: `${OTHER}:8453`, amount: '777' }),
    ],
    runner: armed(Date.now()),
    'runner.secret': SECRET,
  };
  installChrome({ store, onPage: () => ({}) });
  const { delegateFor } = await import('../src/shared/chains.js');
  const ZERO = '0x0000000000000000000000000000000000000000';
  const notGranted = encodeFunctionResult({
    abi: SESSION_VIEW_ABI,
    functionName: 'getSession',
    result: {
      validUntil: 0n, maxOps: 0n, opsUsed: 0n, exists: false, maxValuePerCall: 0n, valueBudget: 0n,
      spentValue: 0n, feeBudget: 0n, spentFees: 0n, maxFeePerOp: 0n, guard: ZERO, guardToken: ZERO,
      guardHolder: ZERO, swapRouter: ZERO, swapSelector: '0x00000000',
    },
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const result = body.method === 'eth_getCode'
      ? `0xef0100${delegateFor(8453).slice(2).toLowerCase()}`
      : notGranted;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  const mod = await import('../src/background/runner.js');
  const plan = await mod.grantPlan({ chainId: 8453 });
  assert.equal(plan.needed, true);
  assert.equal(plan.params.chainId, 8453);
  assert.deepEqual(plan.params.targets, [OTHER], 'only that chain\'s token');
  assert.equal(plan.params.tokenCaps[0].maxPerOp, '777');
});

test('a key with a lost address record is recovered from the secret, not recreated', async () => {
  const store = { runner: { ...armed(Date.now()), sessionKeyAddress: null }, 'runner.secret': SECRET };
  installChrome({ store, onPage: () => ({}) });
  const mod = await import('../src/background/runner.js');
  const { address } = await mod.ensureSessionKey();
  assert.equal(address, privateKeyToAccount(SECRET).address);
  assert.equal(store['runner.secret'], SECRET, 'the secret is not overwritten');
});

test('the grant plan is computed for one chain, the newest order\'s by default', async () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  const store = {
    orders: [
      makeOrder({ id: 'new', inTokenId: `${TOKEN}:${CHAIN}` }),
      makeOrder({ id: 'old', inTokenId: `${OTHER}:8453`, amount: '999999999' }),
    ],
    runner: armed(Date.now()),
    'runner.secret': SECRET,
  };
  installChrome({ store, onPage: () => ({}) });
  const { delegateFor } = await import('../src/shared/chains.js');
  const LIMIL_DELEGATE = delegateFor(CHAIN);
  const ZERO = '0x0000000000000000000000000000000000000000';
  const notGranted = encodeFunctionResult({
    abi: SESSION_VIEW_ABI,
    functionName: 'getSession',
    result: {
      validUntil: 0n, maxOps: 0n, opsUsed: 0n, exists: false, maxValuePerCall: 0n, valueBudget: 0n,
      spentValue: 0n, feeBudget: 0n, spentFees: 0n, maxFeePerOp: 0n, guard: ZERO, guardToken: ZERO,
      guardHolder: ZERO, swapRouter: ZERO, swapSelector: '0x00000000',
    },
  });
  const asked = [];
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) return codeAnswer;
    const body = JSON.parse(init.body);
    asked.push({ url, method: body.method });
    const result = body.method === 'eth_getCode'
      ? `0xef0100${LIMIL_DELEGATE.slice(2).toLowerCase()}`
      : notGranted;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  const mod = await import('../src/background/runner.js');
  const plan = await mod.grantPlan();
  assert.equal(plan.needed, true);
  assert.equal(plan.params.chainId, CHAIN);
  assert.ok(plan.params.targets.includes(TOKEN));
  assert.ok(!plan.params.targets.includes(OTHER), 'a token of another chain is not in the plan');
  assert.equal(plan.params.tokenCaps.length, 1);
  const cap = plan.params.tokenCaps[0];
  assert.equal(cap.token, TOKEN);
  assert.equal(cap.maxPerOp, '10000', 'the cap covers this chain\'s orders only');
  assert.equal(cap.budget, (10000n * 2n).toString());
  assert.ok(BigInt(cap.minOutPerUnit) > 0n, 'and the owner\'s price rides with it');
  assert.equal(plan.params.guard.guard, '0x55f1dd8f6afe957fdfabb70e31b0f9ff46f237f3', 'the template rides in the plan');
  assert.equal(plan.params.swap.router, '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', 'and the one router it may sell through');
  assert.deepEqual(plan.params.revokeFirst, [], 'already on the current contract: nothing to revoke on the way');
  assert.ok(asked.every((a) => a.url.includes('robinhood')), 'the other chain was not called');
});

test('a FOMO quote refused on tolerance is a wait, not an attempt', async () => {
  const t0 = Date.now();
  const sample = { out: parseDecimal(QUOTE).toString(), at: t0 - 1000 };
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), samples: { o1: [sample, sample, sample] } },
    'runner.secret': SECRET,
  };
  installChrome({
    store,
    onPage: (msg) => (msg.type === 'page.swap.prepare'
      ? { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }
      : { result: { sent: false, blocked: 'quote is 4200.0 bps below target at a tolerance of 500 bps, not signing', slippage: { ok: false, shortfallBps: 4200, reason: 'quote is 4200.0 bps below target at a tolerance of 500 bps, not signing' } } }),
  });
  const mod = await import('../src/background/runner.js');
  await mod.tick({ now: t0 });
  assert.equal(store.orders[0].status, 'watching');
  assert.equal((store.runner.attempts?.o1 ?? []).length, 0, 'no attempt recorded, it is a wait');
  const entry = store.runner.log.find((e) => e.orderId === 'o1');
  assert.equal(entry.act, 'skip');
  assert.match(entry.reason, /waiting for the price to come back/);
});

test('with the orders switch off the round does not quote and no grant is planned', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET, settings: { ordersEnabled: false } };
  let asked = 0;
  installChrome({ store, onPage: () => { asked += 1; return {}; } });
  const mod = await import('../src/background/runner.js');
  const res = await mod.tick({ now: t0 });
  assert.equal(res.acted, false);
  assert.match(res.reason, /off/);
  assert.equal(asked, 0, 'the page was not touched');
  const plan = await mod.grantPlan();
  assert.equal(plan.needed, false);
  assert.match(plan.reason, /switched off/);
});

// ------------------------------------------------------------ output guard

/** Network for these tests: relay says "pool fine", the node balance does not change. */
function stubNetworkUnchanged(before = 2000n * 10n ** 18n) {
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) return codeAnswer;
    if (String(url).includes('relay.link')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ details: { swapImpact: { percent: '0.10' } } }) };
    }
    return { ok: true, json: async () => ({ result: `0x${before.toString(16).padStart(64, '0')}` }) };
  };
}

test('the guard reverted the trade in simulation, the order lives, the round is not an attempt', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  let executes = 0;
  installChrome({
    store,
    onPage: (msg) => {
      if (msg.type === 'page.swap.prepare') return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      executes += 1;
      return { result: { sent: false, blocked: 'output guard: the trade would give less than the floor 95, not sending', guard: { applied: true, blocked: true, minGain: '95' } } };
    },
  });
  stubNetworkUnchanged();
  const mod = await import('../src/background/runner.js');
  for (let i = 0; i < 3; i += 1) await mod.tick({ now: t0 + i * 1000 });

  assert.ok(executes >= 1, 'execution was reached');
  assert.equal(store.orders[0].status, 'watching', 'the order stays watched');
  const skip = store.runner.log.findLast((e) => e.act === 'skip' && /output guard/.test(e.reason));
  assert.ok(skip, 'the guard revert is a skip in the journal');
  assert.equal(store.runner.attempts?.o1?.length ?? 0, 0, 'no attempt recorded');
});

test('three guard reverts in a row, a ten-minute pause, then trying again', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  let executes = 0;
  installChrome({
    store,
    onPage: (msg) => {
      if (msg.type === 'page.swap.prepare') return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      executes += 1;
      return { result: { sent: false, blocked: 'output guard: below the floor', guard: { applied: true, blocked: true, minGain: '95' } } };
    },
  });
  stubNetworkUnchanged();
  const mod = await import('../src/background/runner.js');
  // Three price confirmations, then three guard reverts.
  for (let i = 0; i < 6; i += 1) await mod.tick({ now: t0 + i * 1000 });
  const after3 = executes;
  assert.ok(after3 >= 3, `expected at least three executions, got ${after3}`);
  assert.match(store.runner.log.findLast((e) => /backing off/.test(e.reason))?.reason ?? '', /backing off 10 min/);

  // Inside the pause execution is not attempted.
  await mod.tick({ now: t0 + 7000 });
  assert.equal(executes, after3, 'no execution inside the pause');
  assert.match(store.runner.log.at(-1).reason, /waiting another/);

  // The pause is over, try again. The price samples expired meanwhile, so
  // three confirmations are needed again.
  for (let i = 0; i < 3; i += 1) await mod.tick({ now: t0 + 11 * 60_000 + i * 1000 });
  assert.ok(executes > after3, 'execution resumed after the pause');
  assert.equal(store.orders[0].status, 'watching');
});

test('a reverted receipt after the send does not remove the order: the position is intact', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: (msg) => (msg.type === 'page.swap.prepare'
      ? { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }
      : { result: { sent: true, userOpHash: '0xabc', receipt: { success: false, transactionHash: '0xtx' }, guard: { applied: true, minGain: '95' } } }),
  });
  stubNetworkUnchanged();
  const mod = await import('../src/background/runner.js');
  for (let i = 0; i < 3; i += 1) await mod.tick({ now: t0 + i * 1000 });

  assert.equal(store.orders[0].status, 'watching', 'an on-chain revert keeps the order live');
  const failed = store.runner.log.findLast((e) => e.act === 'failed');
  assert.match(failed?.reason ?? '', /reverted on chain .* position intact/);
  assert.equal(store.runner.attempts.o1.at(-1).ok, false, 'the revert is recorded as a failed attempt');
});

// -------------------------------------------------------------- buy route

test('a buy without a route check is not signed: Kyber silent, the order lives', async () => {
  const t0 = Date.now();
  const CASH = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:solana';
  const order = makeOrder({
    side: 'buy', inTokenId: CASH, outTokenId: `${TOKEN}:${CHAIN}`, amount: '20000000', decimals: 18,
    solanaAddress: '5gGoWZSyv1NuMNBQEqs9Gn43zgsX74v8fUxvLjt53CBo',
  });
  const store = { orders: [order], runner: armed(t0), 'runner.secret': SECRET };
  let executes = 0;
  installChrome({
    store,
    onPage: (msg) => {
      if (msg.type === 'page.swap.prepare') return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
      if (msg.type === 'page.swap.execute') executes += 1;
      return { result: { sent: false } };
    },
  });
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) return codeAnswer;
    const u = String(url);
    if (u.includes('relay.link')) return { ok: true, status: 200, text: async () => JSON.stringify({ details: { swapImpact: { percent: '0.10' } } }) };
    if (u.includes('kyberswap')) throw new Error('Failed to fetch');
    return { ok: true, json: async () => ({ result: `0x${(1000n).toString(16).padStart(64, '0')}` }) };
  };
  const mod = await import('../src/background/runner.js');
  for (let i = 0; i < 4; i += 1) await mod.tick({ now: t0 + i * 1000 });

  assert.equal(executes, 0, 'signing was not reached');
  assert.equal(store.orders[0].status, 'watching');
  const skip = store.runner.log.findLast((e) => /Kyber route not received/.test(e.reason));
  assert.ok(skip, `expected a Kyber reason, journal: ${store.runner.log.slice(-3).map((e) => e.reason).join(' | ')}`);
});

test('a buy of a Solana token goes without the Kyber route check', async () => {
  const t0 = Date.now();
  const CASH = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:solana';
  const SOL_TOKEN = '7Ksh2R9hrUJqejjNErBg3XRNA2BDoL9DJmPGNwCqk989:1399811149';
  const order = makeOrder({
    side: 'buy', inTokenId: CASH, outTokenId: SOL_TOKEN, amount: '20000000', decimals: 6,
    solanaAddress: '5gGoWZSyv1NuMNBQEqs9Gn43zgsX74v8fUxvLjt53CBo',
    // Without slippage the sensor output is not compared with the target:
    // only "Kyber is not asked" is checked here, not the price impact.
    maxSlippageBps: null,
  });
  const store = { orders: [order], runner: armed(t0), 'runner.secret': SECRET };
  let executes = 0;
  let kyberAsked = 0;
  installChrome({
    store,
    onPage: (msg) => {
      if (msg.type === 'page.swap.prepare') return { result: { quote: { expectedOut: QUOTE, chainId: 1399811149 } } };
      if (msg.type === 'page.swap.execute') executes += 1;
      return { result: { sent: false, blocked: 'dry run' } };
    },
  });
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) return codeAnswer;
    const u = String(url);
    if (u.includes('kyberswap')) { kyberAsked += 1; throw new Error('must not be called'); }
    if (u.includes('jup.ag')) return { ok: true, status: 200, text: async () => JSON.stringify({ priceImpactPct: '0.001', outAmount: '1000' }) };
    return { ok: true, json: async () => ({ result: { value: [] } }) };
  };
  const mod = await import('../src/background/runner.js');
  for (let i = 0; i < 4; i += 1) await mod.tick({ now: t0 + i * 1000 });

  assert.equal(kyberAsked, 0, 'Kyber was not asked');
  assert.ok(executes >= 1, `execution was reached, journal: ${store.runner.log.slice(-3).map((e) => e.reason).join(' | ')}`);
});

// ----------------------------------------------------------- own FOMO tab

test('no FOMO tab, the runner opens a background one itself, at most every five minutes', async () => {
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({ store, tabs: [], onPage: () => ({ result: {} }) });
  const created = [];
  globalThis.chrome.tabs.create = async (opts) => { created.push(opts); return { id: 99 }; };
  const mod = await import('../src/background/runner.js');

  await mod.tick({ now: t0 });
  assert.equal(created.length, 1, 'a tab was opened');
  assert.match(created[0].url, /fomo\.family\/tokens\/robinhood\/0x/);
  assert.equal(created[0].active, false, 'in the background');
  assert.equal(created[0].pinned, true, 'pinned');
  assert.match(store.runner.log.at(-1).reason, /opened a background one/);

  await mod.tick({ now: t0 + 60_000 });
  assert.equal(created.length, 1, 'not opened a second time after a minute');
  await mod.tick({ now: t0 + 6 * 60_000 });
  assert.equal(created.length, 2, 'tried again after five minutes');
});

// --------------------------------------------------- one writer at a time

test('a heartbeat during a round does not erase what the round wrote, nor the round the beat', async () => {
  // A `watchdog` that read the state and wrote it back a moment later over
  // the round's journal and attempts would lose a firing from the daily count
  // or a cooldown. Both writers go through the same queue.
  const t0 = Date.now();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  const mod = await import('../src/background/runner.js');
  let beat = null;
  installChrome({
    store,
    onPage: async (msg) => {
      assert.equal(msg.type, 'page.swap.prepare');
      // The page is slow; the watcher beats while the round waits for it.
      beat = mod.watchdog({ levels: 1, ids: ['o1'] });
      await new Promise((r) => { setTimeout(r, 5); });
      return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
    },
  });

  await mod.tick({ now: t0 });
  await beat;
  assert.equal(store.runner.samples.o1.length, 1, 'the round\'s sample survived the beat');
  assert.ok(store.runner.log.length >= 1, 'the round\'s journal line survived the beat');
  assert.equal(store.runner.watchdogAt > 0, true, 'and the beat survived the round');
  assert.deepEqual(store.runner.watchdogIds, ['o1']);
});

test('an accepted send takes the order off watch BEFORE the confirmation wait', async () => {
  // The confirmation wait runs up to a minute on timers and fetch alone; the
  // worker may not survive it. An order still `watching` on the next start
  // fired the same position a second time.
  const t0 = Date.now();
  const order = { ...makeOrder(), amount: (1000n * 10n ** 18n).toString() };
  const store = { orders: [order], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({
    store,
    onPage: (msg) => (msg.type === 'page.swap.prepare'
      ? { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } }
      : { result: { sent: true, userOpHash: '0xabc' } }),
  });
  let call = 0;
  const seenAtConfirm = [];
  const before = 2000n * 10n ** 18n;
  globalThis.fetch = async (url, init) => {
    if (isGetCode(init)) return codeAnswer;
    if (String(url).includes('relay.link')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ details: { swapImpact: { percent: '0.10' } } }) };
    }
    call += 1;
    // The second balance read is the confirmation: what does the order say then?
    if (call === 2) seenAtConfirm.push(store.orders[0].status);
    const value = call === 1 ? before : before - 1000n * 10n ** 18n;
    return { ok: true, json: async () => ({ result: `0x${value.toString(16).padStart(64, '0')}` }) };
  };
  const mod = await import('../src/background/runner.js');
  for (let i = 0; i < 3; i += 1) await mod.tick({ now: t0 + i * 1000 });

  assert.deepEqual(seenAtConfirm, ['triggered'], 'off watch already while the balance is being read');
  assert.equal(store.orders[0].status, 'filled', 'and filled once the balance proved it');
  assert.equal(store.orders[0].closedTx, '0xabc');
});

test('the alarm is created once and not re-created on every worker start', async () => {
  // `chrome.alarms.create` with an existing name restarts its period; the
  // heartbeat starts this worker every half minute, so the minute alarm never
  // reached its minute.
  const t0 = Date.now();
  const store = { orders: [], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({ store, onPage: () => ({ result: {} }) });
  const created = [];
  let existing = null;
  globalThis.chrome.alarms = { async get() { return existing; }, async create(name, info) { created.push({ name, info }); }, async clear() {} };
  const mod = await import('../src/background/runner.js');

  await mod.restoreAlarm();
  assert.equal(created.length, 1, 'no alarm yet: created');
  existing = { name: created[0].name };
  await mod.restoreAlarm();
  await mod.restoreAlarm();
  assert.equal(created.length, 1, 'an existing alarm is left alone');
});

// -------------------------------------------------------------- key rotation

/**
 * A node that answers the session views for a granted key: getSession as
 * `session`, tokenBudget as the plan's caps, isAllowedCall true, and the
 * version-3 delegate everywhere else. `granted` says which keys have a session.
 */
async function rotationNode({ granted, validUntil }) {
  const { planGrant } = await import('../src/shared/grant-plan.js');
  const { guardSpecFor } = await import('../src/shared/output-guard.js');
  const { RELAY_ROUTER, RELAY_SWAP_SELECTOR, delegateFor } = await import('../src/shared/chains.js');
  const plan = planGrant([makeOrder()], { router: RELAY_ROUTER, swapSelector: RELAY_SWAP_SELECTOR, guard: guardSpecFor(CHAIN), chainId: CHAIN });
  const ZERO = '0x0000000000000000000000000000000000000000';
  const sel = (functionName, args) => encodeFunctionData({ abi: SESSION_VIEW_ABI, functionName, args }).slice(0, 10);
  const SEL_SESSION = sel('getSession', [ZERO]);
  const SEL_BUDGET = sel('tokenBudget', [ZERO, ZERO]);
  const SEL_ALLOWED = sel('isAllowedCall', [ZERO, ZERO, '0x00000000']);
  const session = (exists) => encodeFunctionResult({
    abi: SESSION_VIEW_ABI,
    functionName: 'getSession',
    result: {
      validUntil: exists ? BigInt(validUntil) : 0n, maxOps: exists ? 100n : 0n, opsUsed: 0n, exists,
      maxValuePerCall: 0n, valueBudget: 0n, spentValue: 0n, feeBudget: 0n, spentFees: 0n, maxFeePerOp: 0n,
      guard: exists ? plan.guard.guard : ZERO, guardToken: exists ? plan.guard.settlementToken : ZERO,
      guardHolder: exists ? plan.guard.depository : ZERO, swapRouter: exists ? plan.swap.router : ZERO,
      swapSelector: exists ? plan.swap.selector : '0x00000000',
    },
  });
  const cap = plan.tokenCaps[0];
  const budget = encodeFunctionResult({
    abi: SESSION_VIEW_ABI, functionName: 'tokenBudget',
    result: { exists: true, maxPerOp: cap.maxPerOp, budget: cap.budget, spent: 0n, minOutPerUnit: cap.minOutPerUnit },
  });
  const allowed = encodeFunctionResult({ abi: SESSION_VIEW_ABI, functionName: 'isAllowedCall', result: true });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_getCode') {
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: `0xef0100${delegateFor(CHAIN).slice(2).toLowerCase()}` }) };
    }
    const data = String(body.params?.[0]?.data ?? '');
    const s = data.slice(0, 10);
    let result = '0x';
    if (s === SEL_SESSION) {
      const key = `0x${data.slice(34, 74)}`.toLowerCase();
      seen.push(key);
      result = session(granted.has(key));
    } else if (s === SEL_BUDGET) result = budget;
    else if (s === SEL_ALLOWED) result = allowed;
    else return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  return { plan, seen };
}

test('a renewal goes to a NEW key: the plan asks for the next key\'s grant and keeps the old one signing', async () => {
  const t0 = Date.now();
  const current = privateKeyToAccount(SECRET).address.toLowerCase();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({ store, onPage: () => ({}) });
  // Granted to the current key, expiring in a day: inside the renewal window.
  await rotationNode({ granted: new Set([current]), validUntil: Math.floor(t0 / 1000) + 24 * 3600 });
  const mod = await import('../src/background/runner.js');
  const plan = await mod.grantPlan({ now: t0 });
  assert.equal(plan.needed, true);
  const next = store.runner.rotation?.next;
  assert.ok(next, 'a rotation is under way');
  assert.notEqual(next.toLowerCase(), current, 'to a new address');
  assert.equal(plan.params.key.toLowerCase(), next.toLowerCase(), 'the grant is for the next key');
  assert.deepEqual(plan.params.revokeFirst, [], 'nothing is revoked before the successor can sign');
  assert.equal(plan.params.revokeOnly, false);
  assert.ok(store['runner.secret.next'], 'its secret is kept apart');
  assert.equal(store['runner.secret'], SECRET, 'the current key still signs');
  assert.equal(privateKeyToAccount(store['runner.secret.next']).address.toLowerCase(), next.toLowerCase());
  assert.equal((await mod.grantPlan({ now: t0 })).params.key.toLowerCase(), next.toLowerCase(), 'asked again, the same next key, no second rotation');
});

test('a grant that is not due for renewal rotates nothing', async () => {
  const t0 = Date.now();
  const current = privateKeyToAccount(SECRET).address.toLowerCase();
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({ store, onPage: () => ({}) });
  await rotationNode({ granted: new Set([current]), validUntil: Math.floor(t0 / 1000) + 29 * 24 * 3600 });
  const mod = await import('../src/background/runner.js');
  const plan = await mod.grantPlan({ now: t0 });
  assert.equal(plan.needed, false, plan.reason);
  assert.equal(store.runner.rotation ?? null, null);
  assert.equal(store['runner.secret.next'], undefined);
});

test('once the next key is granted everywhere it takes over, and the old one is revoked on the next round', async () => {
  const t0 = Date.now();
  const old = privateKeyToAccount(SECRET).address.toLowerCase();
  const nextSecret = `0x${'33'.repeat(32)}`;
  const next = privateKeyToAccount(nextSecret).address.toLowerCase();
  const store = {
    orders: [makeOrder()],
    runner: { ...armed(t0), rotation: { next, startedAt: t0 - 60_000 } },
    'runner.secret': SECRET,
    'runner.secret.next': nextSecret,
  };
  installChrome({ store, onPage: () => ({}) });
  // Both keys have a session: the old one still, the next one freshly granted.
  await rotationNode({ granted: new Set([old, next]), validUntil: Math.floor(t0 / 1000) + 30 * 24 * 3600 });
  const mod = await import('../src/background/runner.js');
  const plan = await mod.grantPlan({ now: t0 });
  // Promoted.
  assert.equal(store['runner.secret'], nextSecret, 'the next key signs from now on');
  assert.equal(store['runner.secret.prev'], SECRET, 'the old secret is kept only to tell the hub');
  assert.equal(store['runner.secret.next'], undefined);
  assert.equal(store.runner.sessionKeyAddress.toLowerCase(), next);
  assert.equal(store.runner.rotation ?? null, null);
  assert.deepEqual(store.runner.retired, { key: old, chains: [CHAIN] });
  assert.equal((await mod.ensureSessionKey()).address.toLowerCase(), next);
  // And this very plan revokes the old key on this chain, in a round of its own.
  assert.equal(plan.needed, true);
  assert.equal(plan.params.revokeOnly, true);
  assert.deepEqual(plan.params.revokeFirst, [old]);
  assert.equal(plan.params.key.toLowerCase(), next);
  // The old key's session gone: the chain drops off the retired list and nothing is due.
  await rotationNode({ granted: new Set([next]), validUntil: Math.floor(t0 / 1000) + 30 * 24 * 3600 });
  const after = await mod.grantPlan({ now: t0 });
  assert.equal(after.needed, false, after.reason);
  assert.equal(store.runner.retired ?? null, null);
});

test('every grant round carries the same fields the page puts into the intent, the runner key\'s too', async () => {
  // The page rebuilds the params from what it receives and spends the intent
  // only if they hash the same. The runner-key round once lacked a field the
  // main round had; the page added it with its default, the hashes differed,
  // and the grant was refused with "intent parameters differ" on a live order.
  const t0 = Date.now();
  const current = privateKeyToAccount(SECRET).address.toLowerCase();
  const runnerKey = '0x5555555555555555555555555555555555555555';
  const store = {
    orders: [makeOrder()],
    runner: armed(t0),
    'runner.secret': SECRET,
    settings: { ordersEnabled: true, autonomousEnabled: true, daemonEnabled: true, daemon: { url: 'http://127.0.0.1:8787', sessionKey: runnerKey, runner: { key: runnerKey } } },
  };
  installChrome({ store, onPage: () => ({}) });
  await rotationNode({ granted: new Set([current]), validUntil: Math.floor(t0 / 1000) + 29 * 24 * 3600 });
  const mod = await import('../src/background/runner.js');
  const plan = await mod.grantPlan({ now: t0 });
  assert.equal(plan.needed, true);
  assert.equal(plan.mainNeeded, false, 'the extension key is covered');
  assert.equal(plan.extra.length, 1, 'the runner key needs its grant');
  const PAGE_FIELDS = ['sender', 'chainId', 'key', 'limits', 'tokenCaps', 'guard', 'swap', 'targets', 'selectors', 'feeRecipients', 'revokeFirst', 'revokeOnly'];
  const strip = (o) => Object.keys(o).filter((k) => !['intent', 'missing'].includes(k)).sort();
  assert.deepEqual(strip(plan.params), [...PAGE_FIELDS].sort());
  assert.deepEqual(strip(plan.extra[0]), [...PAGE_FIELDS].sort());
  assert.equal(plan.extra[0].key, runnerKey);
  assert.equal(plan.extra[0].revokeOnly, false);
});

test('a runner browser grants for ITSELF when the hub says its owner is headless, and for nobody when it does not', async () => {
  // The gate: "this browser executes for another one; the owner's browser
  // issues the grants": true for a laptop owner, false for a program on the
  // hub that holds no Privy session. mirror.js writes the hub's word into
  // settings.mirror.ownerHeadless; this is what grantPlan does with it.
  const OTHER = '0x2222222222222222222222222222222222222222';
  const mk = (ownerHeadless) => ({
    orders: [makeOrder({ id: 'base', inTokenId: `${OTHER}:8453`, amount: '777' })],
    runner: armed(Date.now()),
    'runner.secret': SECRET,
    settings: { ordersEnabled: true, autonomousEnabled: true, mirrorEnabled: true, mirror: { url: 'http://daemon:8787', ...(ownerHeadless == null ? {} : { ownerHeadless }) } },
  });
  const { delegateFor } = await import('../src/shared/chains.js');
  const ZERO = '0x0000000000000000000000000000000000000000';
  const notGranted = encodeFunctionResult({
    abi: SESSION_VIEW_ABI,
    functionName: 'getSession',
    result: {
      validUntil: 0n, maxOps: 0n, opsUsed: 0n, exists: false, maxValuePerCall: 0n, valueBudget: 0n,
      spentValue: 0n, feeBudget: 0n, spentFees: 0n, maxFeePerOp: 0n, guard: ZERO, guardToken: ZERO,
      guardHolder: ZERO, swapRouter: ZERO, swapSelector: '0x00000000',
    },
  });
  const chainStub = async (url, init) => {
    const body = JSON.parse(init.body);
    const result = body.method === 'eth_getCode' ? `0xef0100${delegateFor(8453).slice(2).toLowerCase()}` : notGranted;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };

  installChrome({ store: mk(null), onPage: () => ({}) });
  globalThis.fetch = chainStub;
  let mod = await import('../src/background/runner.js');
  const laptop = await mod.grantPlan({ chainId: 8453 });
  assert.equal(laptop.needed, false);
  assert.match(laptop.reason, /executes for another one/, 'a laptop owner grants; this browser does not');

  installChrome({ store: mk(true), onPage: () => ({}) });
  globalThis.fetch = chainStub;
  mod = await import('../src/background/runner.js');
  const headless = await mod.grantPlan({ chainId: 8453 });
  assert.equal(headless.needed, true, 'nobody else can: this browser plans');
  assert.equal(headless.params.chainId, 8453);
  assert.equal(headless.params.key.toLowerCase(), (await mod.ensureSessionKey()).address.toLowerCase(), 'for its own session key');
  assert.deepEqual(headless.params.targets, [OTHER]);
});

// --------------------------------------------------- the account it holds

/** The page names the signed-in account: ui.status answered with a context. */
function pageSignedInAs(sender) {
  const inner = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (id, msg) => (
    msg?.type === 'ui.status' ? { result: { context: { sender } } } : inner(id, msg)
  );
}

const quoteOrSend = (report, seen) => (msg) => {
  if (msg.type === 'page.swap.prepare') return { result: { quote: { expectedOut: QUOTE, chainId: CHAIN } } };
  seen.executed = msg.payload;
  return { result: report };
};

test('a send the bundler rejected does not become the account this browser is known to hold', async () => {
  const t0 = 9_000_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  const seen = { executed: null };
  installChrome({ store, onPage: quoteOrSend({ sent: false, error: 'AA24 signature error' }, seen) });
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });
  assert.ok(seen.executed, 'the attempt was made');
  assert.equal(store.runner.lastExecutedSender ?? null, null, 'a rejected send is not proof of the account');
});

test('a send the bundler accepted names the account this browser holds', async () => {
  const t0 = 9_100_000;
  const store = { orders: [makeOrder()], runner: armed(t0), 'runner.secret': SECRET };
  installChrome({ store, onPage: quoteOrSend({ sent: true, userOpHash: '0xdead' }, {}) });
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });
  assert.equal(store.runner.lastExecutedSender, SENDER);
});

test('a hub order is not executed while the account this browser holds is unknown', async () => {
  const t0 = 9_200_000;
  const store = { orders: [makeOrder({ mirrored: true })], runner: armed(t0), 'runner.secret': SECRET };
  const seen = { executed: null };
  installChrome({ store, onPage: quoteOrSend({ sent: true, userOpHash: '0xdead' }, seen) });
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });
  assert.equal(seen.executed, null, 'nothing is sent on a guess about the account');
  assert.equal(store.orders[0].status, 'watching');
  assert.ok(store.runner.log.some((e) => e.act === 'skip' && /unknown/.test(e.reason)), 'the journal says why');
});

test('the same hub order executes once the page names the account', async () => {
  const t0 = 9_300_000;
  const store = { orders: [makeOrder({ mirrored: true })], runner: armed(t0), 'runner.secret': SECRET };
  const seen = { executed: null };
  installChrome({ store, onPage: quoteOrSend({ sent: true, userOpHash: '0xdead' }, seen) });
  pageSignedInAs(SENDER);
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });
  assert.ok(seen.executed, 'the page named the account and it matches the order');
  assert.equal(store.runner.lastExecutedSender, SENDER);
});

test('a hub order for another account is refused even when the page names one', async () => {
  const t0 = 9_400_000;
  const store = { orders: [makeOrder({ mirrored: true })], runner: armed(t0), 'runner.secret': SECRET };
  const seen = { executed: null };
  installChrome({ store, onPage: quoteOrSend({ sent: true, userOpHash: '0xdead' }, seen) });
  pageSignedInAs('0x2222222222222222222222222222222222222222');
  const { tick } = await import('../src/background/runner.js');
  await tick({ now: t0 });
  await tick({ now: t0 + 1000 });
  await tick({ now: t0 + 2000 });
  assert.equal(seen.executed, null);
  assert.ok(store.runner.log.some((e) => e.act === 'skip' && /another account/.test(e.reason)));
});
