// The Privy envelope sample is stored WITHOUT its token.
//
// The envelope carries the Privy session JWT. A session key next to a live
// JWT is the one combination that lets a thief of extension storage trade:
// the key signs, the JWT opens FOMO's bundler, which is the only one that
// pays the gas. So the worker cuts the token out before writing the sample,
// exactly as it does for the copy the hub receives, and the page puts its own
// live token back in at every use.

import { strict as assert } from 'node:assert';
import { test, before } from 'node:test';

import { PLACEHOLDER_JWT } from '../src/shared/daemon-api.js';

let receive;
const bag = { settings: {} };
before(async () => {
  const noop = () => {};
  const local = {
    async get(keys) {
      if (keys == null) return structuredClone(bag);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(bag[k])]));
    },
    async set(v) { Object.assign(bag, structuredClone(v)); },
    async remove(k) { delete bag[k]; },
    async setAccessLevel() {},
  };
  globalThis.chrome = {
    storage: { local, session: local, onChanged: { addListener: noop } },
    runtime: {
      id: 'synthetic-extension-id',
      onMessage: { addListener(fn) { receive = fn; } },
      getURL: (p) => `chrome-extension://synthetic-extension-id/${p}`,
      reload: noop,
      getManifest: () => ({ version: '0.2.0' }),
    },
    alarms: { onAlarm: { addListener: noop }, async create() {}, async get() { return null; } },
    tabs: { async query() { return []; }, async sendMessage() { return null; } },
    permissions: { onAdded: { addListener: noop }, async contains() { return false; } },
  };
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '{}' });
  await import('../src/background/index.js');
});

const fromTab = { url: 'https://fomo.family/tokens/robinhood/0xabc', id: 'synthetic-extension-id', tab: { id: 7 } };
const ask = (type, payload) => new Promise((resolve) => { receive({ type, payload }, fromTab, resolve); });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: 'privy.io', sub: 'did:privy:abc', aud: 'app-1', exp: 4_000_000_000 })}.signature`;
const WALLET = '0x1111111111111111111111111111111111111111';

test('the stored sample carries the placeholder, not the token, and keeps the wallet address', async () => {
  const sample = {
    method: 'eth_signTypedData_v4',
    rpcPath: ['data', 'request'],
    idPaths: [['id']],
    wasString: false,
    params: [WALLET, { types: {} }],
    envelope: { id: 1, data: { accessToken: jwt, request: { method: 'eth_signTypedData_v4', params: [WALLET, {}] } } },
  };
  const res = await ask('sample.save', { sample });
  assert.equal(res.result.stored, true);
  const stored = bag['privy.sample'];
  assert.equal(stored.envelope.data.accessToken, PLACEHOLDER_JWT, 'the token is gone');
  assert.equal(JSON.stringify(stored).includes(jwt), false, 'nowhere in the record');
  assert.equal(stored.redacted, true);
  assert.deepEqual(stored.rpcPath, ['data', 'request']);
  assert.deepEqual(stored.params, [WALLET], 'the wallet stays readable, the typed data does not travel');
  assert.deepEqual(stored.envelope.data.request.params, [WALLET], 'inside the envelope too: the address, and nothing of what was signed');
  const loaded = await ask('sample.load', {});
  assert.equal(loaded.result.envelope.data.accessToken, PLACEHOLDER_JWT);
});

test('a sample whose redaction cannot be proven clean is not stored at all', async () => {
  delete bag['privy.sample'];
  const noToken = { method: 'eth_signTypedData_v4', rpcPath: ['data'], envelope: { data: { request: {} } } };
  const res = await ask('sample.save', { sample: noToken });
  assert.equal(res.result.stored, false);
  assert.match(res.result.reason, /no recognisable token/);
  assert.equal(bag['privy.sample'], undefined);
  const leftover = {
    method: 'eth_signTypedData_v4', rpcPath: ['data'],
    envelope: { data: { accessToken: jwt, apiKey: 'sk-live-0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdef' } },
  };
  const res2 = await ask('sample.save', { sample: leftover });
  assert.equal(res2.result.stored, false);
  assert.match(res2.result.reason, /credential-shaped values remain/);
  assert.equal(bag['privy.sample'], undefined);
});

test('a Solana envelope is stored too: the transaction bytes are not a credential, they are dropped', async () => {
  const solana = {
    method: 'signMessage', rpcPath: ['data', 'request'], idPaths: [['id']], wasString: true,
    params: { message: 'x'.repeat(1148), encoding: 'base64' },
    envelope: {
      id: 'fomo-9',
      event: 'privy:wallets:rpc',
      data: { accessToken: jwt, entropyId: 'ent', entropyIdVerifier: 'ver', chainType: 'solana', hdWalletIndex: 0, requesterAppId: 'app', request: { method: 'signMessage', params: { message: 'x'.repeat(1148), encoding: 'base64' } } },
    },
  };
  const res = await ask('sample.save', { sample: solana });
  assert.equal(res.result.stored, true, res.result.reason);
  const stored = bag['privy.sample'];
  assert.deepEqual(stored.envelope.data.request.params, {}, 'the bytes do not travel');
  assert.equal(stored.envelope.data.requesterAppId, 'app', 'the wallet fields next to them do');
  assert.equal(stored.envelope.data.accessToken, PLACEHOLDER_JWT);
});

test('a stored sample carries the moment it was saved, and every FOMO tab hears of the change', async () => {
  const { readFileSync } = await import('node:fs');
  assert.ok(Number.isFinite(bag['privy.sample']?.savedAt), 'savedAt is stamped');
  const bgSrc = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
  assert.match(bgSrc, /notes\.push\(\{ type: 'sample\.changed', payload: \{ sample: changes\[STORAGE\.sample\]\.newValue \} \}\);/);
  const content = readFileSync(new URL('../src/isolated/content.js', import.meta.url), 'utf8');
  assert.match(content, /'sample\.changed': \(\{ sample \} = \{\}\) => callMain\('sample\.adopt', \{ sample \}\),/);
  const bridge = readFileSync(new URL('../src/main/privy-bridge.js', import.meta.url), 'utf8');
  const adopt = bridge.slice(bridge.indexOf('export function adoptSample('), bridge.indexOf('export function loadSample('));
  assert.match(adopt, /if \(state\.sample && Number\(state\.sampleAt \?\? 0\) >= savedAt\) return \{ adopted: false/, 'an older sample never replaces a newer one');
});
