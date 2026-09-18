// Privy envelope replay tests.
//
// The exact wire format is not ours and may change, so what is checked is not
// a concrete shape but the PROPERTY the design rests on: whatever the wrapper,
// the RPC node is found, the id is replaced, and everything else in the
// envelope stays untouched.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  addressesIn,
  envelopeBelongsTo,
  buildRequest,
  describeSample,
  extractError,
  extractSignature,
  findIdPaths,
  findRpcNode,
  matchesRequestId,
  parseEnvelope,
} from '../src/shared/envelope.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';

/** The observed shape: {event, data} with a nested request. */
const nested = {
  event: 'privy:wallets:rpc',
  id: 'privy-42',
  data: {
    chainId: 'eip155:4663',
    request: {
      method: 'eth_signTypedData_v4',
      params: [WALLET, '{"primaryType":"PackedUserOperation"}'],
    },
  },
};

/** A flat JSON-RPC form, in case there is no wrapper at all. */
const flat = {
  id: 7,
  jsonrpc: '2.0',
  method: 'eth_signTypedData_v4',
  params: ['0xabc', '{}'],
};

test('the RPC node is found deep inside the envelope', () => {
  const found = findRpcNode(nested);
  assert.deepEqual(found.path, ['data', 'request']);
  assert.equal(found.method, 'eth_signTypedData_v4');
});

test('the RPC node is found in a flat envelope too', () => {
  assert.deepEqual(findRpcNode(flat).path, []);
});

test('an envelope without an RPC node is not a sample', () => {
  assert.equal(findRpcNode({ event: 'privy:ready', data: { ok: true } }), null);
  assert.equal(describeSample({ event: 'privy:ready' }), null);
});

test('identifier fields are found on every level', () => {
  const paths = findIdPaths({ id: 'a', data: { requestId: 'b', inner: { id: 'c' } } });
  assert.deepEqual(paths.sort(), [['data', 'inner', 'id'], ['data', 'requestId'], ['id']].sort());
});

test('a string envelope is recognised and returned as a string', () => {
  const sample = describeSample(JSON.stringify(nested));
  assert.equal(sample.wasString, true);
  const { payload } = buildRequest(sample, { method: 'eth_chainId', params: [], requestId: 'x' });
  assert.equal(typeof payload, 'string');
  assert.equal(JSON.parse(payload).data.request.method, 'eth_chainId');
});

test('our request replaces method, params and every id without touching the rest', () => {
  const sample = describeSample(nested);
  const { payload } = buildRequest(sample, {
    method: 'eth_signTypedData_v4',
    params: ['0xdead', '{"ours":true}'],
    requestId: 'limil-1',
  });

  assert.equal(payload.id, 'limil-1');
  assert.equal(payload.data.request.params[1], '{"ours":true}');
  // Fields we did not touch must arrive as they were.
  assert.equal(payload.event, 'privy:wallets:rpc');
  assert.equal(payload.data.chainId, 'eip155:4663');
  // The sample is not mutated: it is reused for the next requests.
  assert.equal(nested.data.request.params[0], WALLET);
  assert.equal(nested.id, 'privy-42');
});

test('an incomplete sample builds no request', () => {
  assert.throws(() => buildRequest({ envelope: {} }, { method: 'x', params: [], requestId: 'y' }),
    /incomplete/);
});

test('the signature is extracted from an answer of any depth', () => {
  const sig = `0x${'ab'.repeat(65)}`;
  assert.equal(extractSignature({ data: { result: sig } }), sig);
  assert.equal(extractSignature({ a: { b: { c: { signature: sig } } } }), sig);
  // 64 bytes is a hash, not a signature: the two must not be confused.
  assert.equal(extractSignature({ data: { result: `0x${'ab'.repeat(32)}` } }), null);
});

test('a Privy refusal is recognised both as a string and as an object', () => {
  assert.match(extractError({ data: { error: 'User rejected' } }), /User rejected/);
  assert.match(extractError({ data: { error: { code: 4001, message: 'rejected' } } }), /4001/);
  assert.equal(extractError({ data: { result: '0x00' } }), null);
});

test('a foreign answer is not picked up by id', () => {
  assert.equal(matchesRequestId({ id: 'limil-1' }, 'limil-1'), true);
  assert.equal(matchesRequestId({ data: { requestId: 'limil-1' } }, 'limil-1'), true);
  assert.equal(matchesRequestId({ id: 'privy-99' }, 'limil-1'), false);
});

test('garbage is not an envelope', () => {
  assert.equal(parseEnvelope('not json'), null);
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope(42), null);
  assert.equal(parseEnvelope('"a string"'), null);
});

test('the envelope knows which wallet it belongs to', () => {
  // The envelope is cloned whole, together with the address of the account it
  // was captured from. When the person switches accounts, Privy answers "not
  // loaded on this device" about the OLD address, and from the outside that
  // looks like a broken signature.
  const sample = { envelope: { data: { wallet: { address: WALLET }, nested: [{ x: 'not an address' }] } } };

  assert.equal(envelopeBelongsTo(sample, WALLET), true);
  assert.equal(envelopeBelongsTo(sample, WALLET.toUpperCase()), true, 'case must not decide');
  assert.equal(envelopeBelongsTo(sample, OTHER_WALLET), false);
});

test('an envelope without addresses is not treated as foreign', () => {
  // Refusing on a guess is worse than letting it through: the envelope may
  // carry no address at all, and then there is nothing to judge by.
  const sample = { envelope: { data: { method: 'secp256k1_sign', params: ['0xdead'] } } };
  assert.equal(envelopeBelongsTo(sample, OTHER_WALLET), true);
});

test('addresses are collected from any depth, but not infinitely', () => {
  const a = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const b = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const found = addressesIn({ one: a, deep: { deeper: [{ two: b }] } });
  assert.deepEqual([...found].sort(), [a, b].sort());
  // An envelope should have no cycles, but the depth is bounded: the walk
  // must end on a long chain.
  let node = { addr: a };
  for (let i = 0; i < 40; i += 1) node = { next: node };
  assert.doesNotThrow(() => addressesIn(node));
});

test('a Solana envelope is built from an EVM sample: chainType, hdWalletIndex, params as an object', async () => {
  const { buildSolanaRequest, extractSolanaSignature, describeSample } = await import('../src/shared/envelope.js');
  const sample = describeSample({
    data: {
      accessToken: 'tok', chainType: 'ethereum', entropyId: '0xabc', entropyIdVerifier: 'ethereum-address-verifier',
      request: { method: 'eth_signTypedData_v4', params: ['0xabc', '{}'] },
    },
    event: 'privy:wallets:rpc',
    id: 'id-9',
  });
  const { payload, requestId } = buildSolanaRequest(sample, { method: 'signMessage', params: { message: 'AAAA' }, requestId: 'limil-1' });
  assert.equal(requestId, 'limil-1');
  assert.equal(payload.id, 'limil-1');
  assert.equal(payload.data.chainType, 'solana');
  assert.equal(payload.data.hdWalletIndex, 0);
  assert.equal(payload.data.request.method, 'signMessage');
  assert.deepEqual(payload.data.request.params, { message: 'AAAA' });
  assert.equal(payload.data.entropyId, '0xabc', 'the wallet stays the same');

  const sig = 'VnoePH5fdBKXvIJRGh5R2/44Yt1rb5nKOvs3MZMvtXxfqWk2Xi+3H45nurm4NRbFXenOAS2uxqdZP+X4QE2FDg==';
  assert.equal(extractSolanaSignature({ data: { address: '327Q', response: { data: { signature: sig }, method: 'signMessage' } } }), sig);
  assert.equal(extractSolanaSignature({ data: { error: 'no' } }), null);
});

test('a sample is captured from a buy as well: signMessage counts as an envelope, an EVM request goes back to ethereum', async () => {
  const { describeSample, buildRequest } = await import('../src/shared/envelope.js');
  const sample = describeSample({
    data: {
      accessToken: 'tok', chainType: 'solana', entropyId: '0xabc', entropyIdVerifier: 'ethereum-address-verifier',
      hdWalletIndex: 0, request: { method: 'signMessage', params: { message: 'AAAA' } },
    },
    event: 'privy:wallets:rpc',
    id: 'id-3',
  });
  assert.ok(sample, 'the buy envelope is recognised as a sample');
  assert.equal(sample.method, 'signMessage');
  const { payload } = buildRequest(sample, { method: 'eth_signTypedData_v4', params: ['0xabc', '{}'], requestId: 'limil-2' });
  assert.equal(payload.data.chainType, 'ethereum');
  assert.equal(payload.data.request.method, 'eth_signTypedData_v4');
});

test('the connect message is built from the sample: the wallet entropy and the token, in the SDK transport', async () => {
  const { buildConnectRequest, describeSample } = await import('../src/shared/envelope.js');
  const raw = JSON.stringify({
    id: 'fomo-1',
    event: 'privy:wallets:rpc',
    data: {
      accessToken: 'tok', entropyId: 'ent', entropyIdVerifier: 'ver', hdWalletIndex: 0, chainType: 'ethereum',
      request: { method: 'eth_signTypedData_v4', params: ['0x0000000000000000000000000000000000000001', '{}'] },
    },
  });
  const sample = describeSample(raw);
  const { payload, requestId } = buildConnectRequest(sample, { requestId: 'limil-c' });
  assert.equal(requestId, 'limil-c');
  assert.equal(typeof payload, 'string', 'a string sample builds a string message');
  assert.deepEqual(JSON.parse(payload), { id: 'limil-c', event: 'privy:wallets:connect', data: { accessToken: 'tok', entropyId: 'ent', entropyIdVerifier: 'ver' } });
  const { buildRecoverRequest } = await import('../src/shared/envelope.js');
  assert.equal(JSON.parse(buildRecoverRequest(sample, { requestId: 'limil-r' }).payload).event, 'privy:wallets:recover');
  // Without the entropy there is nothing to connect with.
  const bare = describeSample(JSON.stringify({ id: 'x', event: 'privy:wallets:rpc', data: { accessToken: 'tok', request: { method: 'eth_signTypedData_v4', params: [] } } }));
  assert.throws(() => buildConnectRequest(bare, { requestId: 'y' }), /no wallet entropy/);
});
