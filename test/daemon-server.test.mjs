// The daemon's HTTP face against a stranger on the network: replay, query
// tampering, stale timestamps, the public hello, CORS.

import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { PROTOCOL, authMessage, bodyHashOf, randomToken } from '../src/shared/daemon-api.js';
import { createReplayCache, startServer } from '../daemon/server.mjs';

const owner = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'33'.repeat(32)}`);

function fakeState() {
  const data = {
    owner: null, pairToken: 'PairTokenPairToken1234', runnerToken: 'RunnerTokenRunner1234', runner: null,
    orders: [], journal: [], wallet: null, solanaAddress: null, version: 0,
  };
  return {
    data,
    save() {},
    note(entry) { data.journal.push(entry); },
    rotateToken() { data.pairToken = randomToken(randomBytes(32)); },
    rotateRunnerToken() { data.runnerToken = randomToken(randomBytes(32)); },
  };
}

const executor = {
  syncOrders: (body) => {
    // the real hub (daemon/hub.mjs) keeps this; the stub keeps only what the routes read back
    if (typeof body.ownerHeadless === 'boolean') state.data.ownerHeadless = body.ownerHeadless;
    return { added: (body.orders ?? []).length, cancelled: 0, watching: 0 };
  },
  applyRunnerReport: () => ({ applied: 0 }),
};

const state = fakeState();
const server = startServer({ state, executor, port: 0, host: '127.0.0.1', log: () => {}, replay: createReplayCache(), runnerUrl: 'http://daemon:8787' });
const ready = new Promise((r) => { server.once('listening', r); });
after(() => new Promise((r) => { server.close(r); }));

async function base() { await ready; return `http://127.0.0.1:${server.address().port}`; }

/** A protocol-2 signed request; `override` lets a test send a different header than it signed. */
async function signed(account, method, path, body = null, override = {}) {
  const text = body ? JSON.stringify(body) : '';
  const ts = override.ts ?? Date.now();
  const nonce = override.nonce ?? randomToken(randomBytes(24));
  const message = authMessage({ ts, nonce, method, path: override.signedPath ?? path, bodyHash: bodyHashOf(keccak256, text) });
  const signature = await account.signMessage({ message });
  const headers = { authorization: `Limil ${account.address}:${ts}:${nonce}:${signature}`, ...(override.headers ?? {}) };
  if (body) headers['content-type'] = 'application/json';
  return { headers, text };
}

async function send(account, method, path, body = null, override = {}) {
  const { headers, text } = await signed(account, method, path, body, override);
  const res = await fetch(`${await base()}${path}`, { method, headers, body: body ? text : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

test('the public hello says which protocol to speak and nothing about the wallet', async () => {
  const res = await fetch(`${await base()}/v1/hello`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()).sort(), ['daemonVersion', 'protocol']);
});

test('everything else needs a signature; a wrong pairing token counts against the client', async () => {
  const res = await fetch(`${await base()}/v1/state`);
  assert.equal(res.status, 403, 'not paired yet');
  const bad = await send(stranger, 'POST', '/v1/pair', { token: 'WrongTokenWrongToken12' });
  assert.equal(bad.status, 403);
  assert.match(bad.json.error, /token does not match/);
});

test('pairing binds the signer; the same request replayed is refused', async () => {
  const { headers, text } = await signed(owner, 'POST', '/v1/pair', { token: state.data.pairToken });
  const url = `${await base()}/v1/pair`;
  const first = await fetch(url, { method: 'POST', headers, body: text });
  assert.equal(first.status, 200);
  const hello = await first.json();
  assert.equal(hello.protocol, PROTOCOL);
  assert.equal(state.data.owner, owner.address.toLowerCase());
  // Byte-for-byte replay: same nonce, same signature. The token has rotated
  // anyway, but the nonce check refuses it before the token is even looked at
  // on routes where the token does not exist.
  const again = await fetch(url, { method: 'POST', headers, body: text });
  assert.equal(again.status, 403);
});

test('a signed PUT replayed inside the window is refused as a replay', async () => {
  const body = { wallet: '0x1', solanaAddress: null, orders: [{ id: 'o1', status: 'watching' }] };
  const { headers, text } = await signed(owner, 'PUT', '/v1/orders', body);
  const url = `${await base()}/v1/orders`;
  const first = await fetch(url, { method: 'PUT', headers, body: text });
  assert.equal(first.status, 200);
  const replay = await fetch(url, { method: 'PUT', headers, body: text });
  assert.equal(replay.status, 401);
  assert.match((await replay.json()).error, /replayed/);
});

test('the query string is part of the signature', async () => {
  // Signed for one target, sent to another: refused.
  const r = await send(owner, 'GET', '/v1/state?x=1', null, { signedPath: '/v1/state' });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /bad signature/);
  // Signed for exactly what is sent: accepted.
  const ok = await send(owner, 'GET', '/v1/state?x=1');
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.orders));
});

test('a stale timestamp, a foreign key and a protocol-1 header are refused', async () => {
  const stale = await send(owner, 'GET', '/v1/state', null, { ts: Date.now() - 10 * 60_000 });
  assert.equal(stale.status, 401);
  assert.match(stale.json.error, /outside the window/);
  const foreign = await send(stranger, 'GET', '/v1/state');
  assert.equal(foreign.status, 403);
  const { headers } = await signed(owner, 'GET', '/v1/state');
  const v1 = headers.authorization.replace(/:[A-Za-z0-9_-]{24}:/, ':');
  const res = await fetch(`${await base()}/v1/state`, { headers: { authorization: v1 } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /protocol 2/);
});

test('CORS is answered for an extension origin only', async () => {
  const b = await base();
  const web = await fetch(`${b}/v1/hello`, { headers: { origin: 'https://evil.example' } });
  assert.equal(web.headers.get('access-control-allow-origin'), null);
  const ext = await fetch(`${b}/v1/hello`, { headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
  assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  const pre = await fetch(`${b}/v1/orders`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('the replay cache forgets nonces after the window and remembers them inside it', () => {
  const cache = createReplayCache({ windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(cache.admit('0xa', 'n1', { now }), true);
  assert.equal(cache.admit('0xa', 'n1', { now: now + 500 }), false);
  assert.equal(cache.admit('0xb', 'n1', { now }), true, 'nonces are per key');
  // Pruning happens every 200 admissions; after two windows the nonce is gone.
  for (let i = 0; i < 200; i += 1) cache.admit('0xc', `x${i}`, { now: now + 3000 });
  assert.equal(cache.admit('0xa', 'n1', { now: now + 3000 }), true);
});

test('the replay cache survives a restart when backed by the state file', () => {
  const store = { data: {}, saved: 0, save() { this.saved += 1; } };
  const first = createReplayCache({ windowMs: 60_000, store });
  assert.equal(first.admit('0xa', 'n1'), true);
  assert.ok(store.saved >= 1, 'the nonce was persisted');
  // A new process: a new cache built from the same state refuses the same nonce.
  const second = createReplayCache({ windowMs: 60_000, store });
  assert.equal(second.admit('0xa', 'n1'), false, 'replayed after a restart, still refused');
  assert.equal(second.admit('0xa', 'n2'), true);
});

test('the owner can ask for the runner pairing string, with or without a runner paired', async () => {
  // This route sits under /v1/runner/ by name but is the OWNER's: the runner
  // block must not catch it first and answer 403 "no runner browser paired",
  // or the popup's ready-made pair-runner command never appears.
  const pairRes = await send(owner, 'POST', '/v1/pair', { token: state.data.pairToken });
  assert.equal(pairRes.status, 200);
  assert.equal(pairRes.json.sessionKey, null, 'no runner browser: no key to grant, the laptop keeps executing');
  state.data.runner = null;
  const none = await send(owner, 'GET', '/v1/runner/pairing');
  assert.equal(none.status, 200);
  assert.equal(none.json.pairing, `http://daemon:8787#${state.data.runnerToken}`);
  assert.equal(none.json.paired, false);
  state.data.runner = { key: '0x2222222222222222222222222222222222222222' };
  const some = await send(owner, 'GET', '/v1/runner/pairing');
  assert.equal(some.status, 200);
  assert.equal(some.json.paired, true);
  assert.equal(some.json.sessionKey, '0x2222222222222222222222222222222222222222', 'the runner browser\'s key is the one to grant');
  const strangerRes = await send(stranger, 'GET', '/v1/runner/pairing');
  assert.equal(strangerRes.status, 403, 'still behind the owner\'s signature');
  state.data.runner = null;
});

test('unpairing the owner wipes what was theirs on the hub', async () => {
  // Pair first (the earlier test rotated the token; pair afresh with the current one).
  const pairRes = await send(owner, 'POST', '/v1/pair', { token: state.data.pairToken });
  assert.equal(pairRes.status, 200);
  state.data.wallet = '0x1111111111111111111111111111111111111111';
  state.data.solanaAddress = 'SoLAddr';
  state.data.sample = { envelope: { redacted: true }, redacted: true };
  state.data.orders = [{ id: 'o1', status: 'watching' }];
  state.data.runner = { key: '0x2222222222222222222222222222222222222222' };
  const res = await send(owner, 'DELETE', '/v1/pair');
  assert.equal(res.status, 200);
  assert.equal(state.data.owner, null);
  assert.deepEqual(state.data.orders, []);
  assert.equal(state.data.wallet, null);
  assert.equal(state.data.solanaAddress, null);
  assert.equal(state.data.sample, null);
  assert.ok(state.data.runner?.key, 'the runner browser keeps its own pairing');
});

test('the owner key rotates: the outgoing key names its successor, and only the successor is the owner afterwards', async () => {
  const pairRes = await send(owner, 'POST', '/v1/pair', { token: state.data.pairToken });
  assert.equal(pairRes.status, 200);
  const successor = privateKeyToAccount(`0x${'44'.repeat(32)}`);
  const bad = await send(owner, 'POST', '/v1/owner/rotate', { next: 'not-an-address' });
  assert.equal(bad.status, 400);
  const byStranger = await send(stranger, 'POST', '/v1/owner/rotate', { next: successor.address });
  assert.equal(byStranger.status, 403, 'a stranger cannot name the owner');
  const ok = await send(owner, 'POST', '/v1/owner/rotate', { next: successor.address });
  assert.equal(ok.status, 200);
  assert.equal(state.data.owner, successor.address.toLowerCase());
  assert.equal((await send(owner, 'GET', '/v1/state')).status, 403, 'the old key is a stranger now');
  assert.equal((await send(successor, 'GET', '/v1/state')).status, 200, 'the successor is the owner');
  assert.ok(state.data.journal.some((e) => e.kind === 'owner-rotated'));
  // Back to the original owner for the tests that follow.
  await send(successor, 'POST', '/v1/owner/rotate', { next: owner.address });
  assert.equal(state.data.owner, owner.address.toLowerCase());
});

test('a headless owner says so; the hub keeps it, shows it to the runner, and a new owner starts as a browser', async () => {
  const pairRes = await send(owner, 'POST', '/v1/pair', { token: state.data.pairToken });
  assert.equal(pairRes.status, 200);
  const put = await send(owner, 'PUT', '/v1/orders', { orders: [], ownerHeadless: true });
  assert.equal(put.status, 200);
  assert.equal(put.json.ownerHeadless, true);
  const runnerKey = privateKeyToAccount(`0x${'55'.repeat(32)}`);
  state.data.runner = { key: runnerKey.address.toLowerCase() };
  const poll = await send(runnerKey, 'GET', '/v1/runner/orders?since=-1&wait=0');
  assert.equal(poll.status, 200);
  assert.equal(poll.json.ownerHeadless, true, 'the runner browser is told the owner cannot sign grants');
  const again = await send(owner, 'PUT', '/v1/orders', { orders: [] });
  assert.equal(again.json.ownerHeadless, true, 'absent is unchanged, not false');
  const off = await send(owner, 'DELETE', '/v1/pair');
  assert.equal(off.status, 200);
  assert.equal(state.data.ownerHeadless, false);
  state.data.runner = null;
});
