// Two things a hub must do when the person on the other end is not being
// polite: stay up, and forget the previous owner.

import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { authMessage, bodyHashOf, randomToken } from '../src/shared/daemon-api.js';
import { createReplayCache, startServer } from '../daemon/server.mjs';
import { createHub } from '../daemon/hub.mjs';

const owner = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const next = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const runner = privateKeyToAccount(`0x${'66'.repeat(32)}`);

function fakeState() {
  const data = {
    owner: owner.address.toLowerCase(),
    pairToken: 'PairTokenPairToken1234',
    runnerToken: 'RunnerTokenRunner1234',
    runner: {
      key: runner.address.toLowerCase(),
      journal: [{ act: 'filled', reason: 'sold 100 TOKEN for the previous owner' }],
      wallet: '0x3333333333333333333333333333333333333333',
    },
    orders: [{ id: 'ord_1', status: 'watching' }],
    journal: [{ kind: 'filled', orderId: 'ord_1', tx: '0xdeadbeef' }],
    wallet: owner.address.toLowerCase(),
    solanaAddress: 'So11111111111111111111111111111111111111112',
    sample: { redacted: true },
    version: 7,
  };
  return {
    data,
    save() {},
    note(entry) { data.journal.push(entry); },
    rotateToken() { data.pairToken = randomToken(randomBytes(32)); },
    rotateRunnerToken() { data.runnerToken = randomToken(randomBytes(32)); },
  };
}

const state = fakeState();
// The real hub, not a stub: what a runner report does to the stored journal
// is exactly what is under test here.
const server = startServer({
  state,
  executor: createHub({ state, log: () => {} }),
  port: 0,
  host: '127.0.0.1',
  log: () => {},
  replay: createReplayCache(),
  runnerUrl: 'http://daemon:8787',
});
const ready = new Promise((r) => { server.once('listening', r); });
after(() => new Promise((r) => { server.close(r); }));

async function base() { await ready; return `http://127.0.0.1:${server.address().port}`; }

async function send(account, method, path, body = null) {
  const text = body ? JSON.stringify(body) : '';
  const ts = Date.now();
  const nonce = randomToken(randomBytes(24));
  const message = authMessage({ ts, nonce, method, path, bodyHash: bodyHashOf(keccak256, text) });
  const signature = await account.signMessage({ message });
  const headers = { authorization: `Limil ${account.address}:${ts}:${nonce}:${signature}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${await base()}${path}`, { method, headers, body: body ? text : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** A raw request line, because no HTTP client will send a target this broken. */
function raw(port, line) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${line}\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let out = '';
    socket.on('data', (chunk) => { out += chunk.toString(); });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

test('a request target no parser accepts is answered, not fatal', async () => {
  await ready;
  // Before the fix this threw out of the async handler as an unhandled
  // rejection and ended the process, at the request of an unauthenticated
  // stranger who only had to ask badly.
  const answer = await raw(server.address().port, 'GET http://[ HTTP/1.1');
  assert.match(answer, /^HTTP\/1\.1 400/, 'a bad target gets a bad-request answer');

  // The point of the test: the hub is still there afterwards.
  const res = await fetch(`${await base()}/v1/hello`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).protocol, 'the hub answers the next caller');
});

test('unpairing takes the journals with it, and the next owner sees none of them', async () => {
  const gone = await send(owner, 'DELETE', '/v1/pair');
  assert.equal(gone.status, 200);

  // The gap: a runner that keeps its pairing goes on reporting while the hub
  // has no owner. Anything it says here would otherwise be waiting for
  // whoever pairs next.
  const orphaned = await send(runner, 'POST', '/v1/runner/status', {
    orders: [],
    journal: [{ at: Date.now(), act: 'filled', reason: 'sold 100 TOKEN for the previous owner' }],
    watching: 0,
    wallet: '0x3333333333333333333333333333333333333333',
  });
  assert.equal(orphaned.status, 200, 'an unowned hub still answers its runner');

  const paired = await send(next, 'POST', '/v1/pair', { token: state.data.pairToken });
  assert.equal(paired.status, 200, 'a fresh token pairs the next owner');

  const seen = await send(next, 'GET', '/v1/state');
  assert.equal(seen.status, 200);
  const text = JSON.stringify(seen.json);
  assert.ok(!text.includes('0xdeadbeef'), 'no transaction of the previous owner');
  assert.ok(!text.includes('previous owner'), "no line of the previous owner's runner");
  assert.ok(!text.includes('0x3333333333333333333333333333333333333333'), 'not even which account the runner was on');
  assert.deepEqual(seen.json.orders, [], 'and no orders');
  assert.ok(state.data.runner?.key, 'the runner keeps its own pairing, which is not the owner\'s to take');

  // The runner kept its pairing AND its own journal, in its own storage, and
  // reports the last lines on every round. This is where the previous owner's
  // activity used to come back.
  const stale = await send(runner, 'POST', '/v1/runner/status', {
    orders: [],
    journal: [
      { at: Date.now() - 3_600_000, act: 'filled', reason: 'sold 100 TOKEN for the previous owner' },
      { at: Date.now(), act: 'idle', reason: 'nothing to do under the new owner' },
    ],
    watching: 0,
    wallet: '0x3333333333333333333333333333333333333333',
  });
  assert.equal(stale.status, 200, 'the runner is still allowed to report');

  const after = await send(next, 'GET', '/v1/state');
  const text2 = JSON.stringify(after.json);
  assert.ok(!text2.includes('previous owner'), 'a heartbeat does not bring the old lines back');
  assert.ok(text2.includes('nothing to do under the new owner'), 'what happened under this owner is kept');
});
