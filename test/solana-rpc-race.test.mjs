// The Solana nodes are asked all at once and the first good answer wins;
// the person's own node, when set, is asked with them. Fetch is stubbed.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const calls = [];
let plan = {};
globalThis.fetch = async (url) => {
  calls.push(url);
  const p = plan[new URL(url).host] ?? { delay: 10, status: 200, body: { jsonrpc: '2.0', result: 'ok' } };
  await new Promise((r) => setTimeout(r, p.delay));
  if (p.throw) throw new Error(p.throw);
  const status = p.status ?? 200;
  return { ok: status === 200, status, json: async () => p.body };
};
let settings = {};
globalThis.chrome = { storage: { local: { get: async () => ({ settings }), set: async () => {} }, onChanged: { addListener() {} }, session: { get: async () => ({}), set: async () => {} } }, alarms: { create() {}, get: async () => null, onAlarm: { addListener() {} } }, runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, onMessage: { addListener() {} } }, tabs: { query: async () => [] } };

const { solanaRpc, SOLANA_RPCS } = await import('../src/background/runner.js');
const hosts = () => calls.map((u) => new URL(u).host);

test('every public node is asked at once and the fastest good answer is returned', async () => {
  calls.length = 0;
  plan = { 'api.mainnet-beta.solana.com': { delay: 300, body: { result: 'slow' } }, 'solana-rpc.publicnode.com': { delay: 20, body: { result: 'fast' } } };
  const t0 = Date.now();
  assert.equal(await solanaRpc('getSlot', []), 'fast');
  assert.ok(Date.now() - t0 < 250, 'did not wait for the slow one');
  assert.deepEqual(new Set(hosts()), new Set(SOLANA_RPCS.map((u) => new URL(u).host)));
});

test('a refusal from one node is covered by the other in the same round', async () => {
  calls.length = 0;
  plan = { 'api.mainnet-beta.solana.com': { delay: 5, status: 429, body: {} }, 'solana-rpc.publicnode.com': { delay: 40, body: { result: 'answered' } } };
  assert.equal(await solanaRpc('getSlot', []), 'answered');
  assert.equal(calls.length, 2, 'one round was enough');
});

test('when every node refuses, the round is repeated twice and the error names the last answers', async () => {
  calls.length = 0;
  plan = { 'api.mainnet-beta.solana.com': { delay: 5, status: 429, body: {} }, 'solana-rpc.publicnode.com': { delay: 5, status: 403, body: {} } };
  await assert.rejects(solanaRpc('getSlot', []), /Solana nodes did not answer \(3 tries\): .*HTTP 429.*HTTP 403/);
  assert.equal(calls.length, 6);
});

test('the own node from the settings is asked first and alone; the public ones only when it failed; https only', async () => {
  calls.length = 0;
  settings = { solanaRpcUrl: 'https://mainnet.helius-rpc.com/?api-key=abc' };
  plan = { 'mainnet.helius-rpc.com': { delay: 5, body: { result: 'mine' } }, 'api.mainnet-beta.solana.com': { delay: 5, body: { result: 'public' } }, 'solana-rpc.publicnode.com': { delay: 5, body: { result: 'public' } } };
  assert.equal(await solanaRpc('getSlot', []), 'mine');
  assert.deepEqual(hosts(), ['mainnet.helius-rpc.com'], 'no public node was touched');
  calls.length = 0;
  plan['mainnet.helius-rpc.com'] = { delay: 5, status: 500, body: {} };
  assert.equal(await solanaRpc('getSlot', []), 'public');
  assert.equal(hosts()[0], 'mainnet.helius-rpc.com');
  assert.ok(hosts().slice(1).every((h) => h !== 'mainnet.helius-rpc.com'));
  calls.length = 0;
  settings = { solanaRpcUrl: 'http://evil.example/rpc' };
  await solanaRpc('getSlot', []);
  assert.equal(hosts().includes('evil.example'), false, 'a plain-http node is ignored');
  settings = {};
});
