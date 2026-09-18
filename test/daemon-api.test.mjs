import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

import {
  PLACEHOLDER_JWT, PROTOCOL, authFresh, authMessage, bodyHashOf, isPrivateHost, orderForDaemon, parseAuthorization, parsePairing,
  randomToken, redactSample, redactionProblems,
} from '../src/shared/daemon-api.js';
import { findJwtPaths, replaceAtPaths } from '../src/shared/jwt.js';

test('pairing string parses into origin and token, with or without a scheme', () => {
  assert.deepEqual(parsePairing('http://192.168.1.4:8787#abcdefghijklmnop'), { url: 'http://192.168.1.4:8787', token: 'abcdefghijklmnop' });
  assert.deepEqual(parsePairing('  daemon:8787#abcdefghijklmnop_-1 '), { url: 'http://daemon:8787', token: 'abcdefghijklmnop_-1' }); // gitleaks:allow, alphabet fixture, not a secret
  assert.deepEqual(parsePairing('https://box.example.com:8787#abcdefghijklmnop'), { url: 'https://box.example.com:8787', token: 'abcdefghijklmnop' });
  assert.throws(() => parsePairing('http://10.0.0.1:8787/path#abcdefghijklmnop'), /without a path/);
  assert.throws(() => parsePairing('http://10.0.0.1:8787#short'), /malformed/);
  assert.throws(() => parsePairing('nothing here'), /look like/);
});

test('plain http is refused towards a public address and accepted towards a private one', () => {
  // The order list, the wallet and the pairing token would travel in the
  // clear, and a captured request could be replayed inside its window.
  assert.throws(() => parsePairing('http://1.2.3.4:8787#abcdefghijklmnop'), /plain http to a public address/);
  assert.throws(() => parsePairing('box.example.com:8787#abcdefghijklmnop'), /plain http to a public address/);
  for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.0.2', '100.64.0.1', '100.127.9.9', 'daemon', 'box.local', '[::1]', '[fd12:3456::1]', '[fe80::1]']) {
    assert.equal(isPrivateHost(host), true, host);
    assert.doesNotThrow(() => parsePairing(`http://${host}:8787#abcdefghijklmnop`), host);
  }
  for (const host of ['1.2.3.4', '172.32.0.1', '100.128.0.1', 'example.com', '8.8.8.8', '[2001:db8::1]']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('a signed request round-trips through the header format, nonce included', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const body = JSON.stringify({ orders: [] });
  const ts = Date.now();
  const nonce = randomToken(new Uint8Array(24).map((_, i) => i * 13));
  const path = '/v1/runner/orders?since=3&wait=25';
  const message = authMessage({ ts, nonce, method: 'get', path, bodyHash: bodyHashOf(keccak256, body) });
  assert.match(message, new RegExp(`^limil-daemon\\n${PROTOCOL}\\n${ts}\\n${nonce}\\nGET\\n`));
  const signature = await account.signMessage({ message });
  const header = `Limil ${account.address}:${ts}:${nonce}:${signature}`;
  const parsed = parseAuthorization(header);
  assert.equal(parsed.address, account.address.toLowerCase());
  assert.equal(parsed.ts, ts);
  assert.equal(parsed.nonce, nonce);
  assert.ok(await verifyMessage({ address: parsed.address, message, signature: parsed.signature }));
  // A different body changes the message and the signature no longer verifies.
  const other = authMessage({ ts, nonce, method: 'GET', path, bodyHash: bodyHashOf(keccak256, '{}') });
  assert.equal(await verifyMessage({ address: parsed.address, message: other, signature: parsed.signature }), false);
  // So does a changed query string: the whole request target is signed.
  const tampered = authMessage({ ts, nonce, method: 'GET', path: '/v1/runner/orders?since=-1&wait=25', bodyHash: bodyHashOf(keccak256, body) });
  assert.equal(await verifyMessage({ address: parsed.address, message: tampered, signature: parsed.signature }), false);
  assert.equal(parseAuthorization('Bearer x'), null);
  // The protocol-1 header shape (no nonce) is not accepted.
  assert.equal(parseAuthorization(`Limil ${account.address}:${ts}:${signature}`), null);
});

test('redaction is fail-closed: a sample without a recognisable token does not travel', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(60)}.${'b'.repeat(40)}`;
  const clean = { envelope: { data: { auth: jwt, request: { method: 'eth_signTypedData_v4', params: ['0x1111111111111111111111111111111111111111', '{"x":1}'] } } }, rpcPath: ['data', 'request'] };
  const ok = redactSample(clean, { findJwtPaths, replaceAtPaths });
  assert.equal(ok.reason, null);
  assert.equal(ok.sample.redacted, true);
  assert.equal(ok.sample.envelope.data.auth, PLACEHOLDER_JWT);
  assert.equal(clean.envelope.data.auth, jwt, 'the original is left intact');

  // No JWT at all: the old code forwarded the envelope untouched as "redacted".
  const opaque = { envelope: { data: { accessToken: 'opaque-session-value-1234567890', request: { method: 'eth_sign', params: [] } } }, rpcPath: ['data', 'request'] };
  const refused = redactSample(opaque, { findJwtPaths, replaceAtPaths });
  assert.equal(refused.sample, null);
  assert.match(refused.reason, /no recognisable token/);

  // A JWT is replaced but a Bearer token sits next to it: still refused.
  const mixed = { envelope: { data: { auth: jwt, headers: { authorization: `Bearer ${'x'.repeat(64)}` }, request: { method: 'eth_sign', params: [] } } }, rpcPath: ['data', 'request'] };
  const partly = redactSample(mixed, { findJwtPaths, replaceAtPaths });
  assert.equal(partly.sample, null);
  assert.match(partly.reason, /credential-shaped values remain/);
  assert.ok(redactionProblems(mixed.envelope).some((p) => p.includes('headers.authorization')));

  // Addresses, ids and typed-data JSON are not credentials.
  assert.deepEqual(redactionProblems({ id: 'e7a1b2c3-0000-4000-8000-aaaaaaaaaaaa', params: ['0x' + 'ab'.repeat(32), '{"primaryType":"PackedUserOperation"}'] }), []);
  assert.equal(redactSample(null, { findJwtPaths, replaceAtPaths }).sample, null);
});

test('signatures expire outside the window', () => {
  const now = 1_000_000_000_000;
  assert.equal(authFresh(now - 60_000, { now }), true);
  assert.equal(authFresh(now - 10 * 60_000, { now }), false);
  assert.equal(authFresh(NaN, { now }), false);
});

test('random tokens are URL-safe and long enough for parsePairing', () => {
  const token = randomToken(new Uint8Array(32).map((_, i) => i * 7));
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(parsePairing(`http://localhost:1#${token}`).token, token);
});

test('the wire order carries execution fields and the watcher level, nothing else', () => {
  const slim = orderForDaemon({ id: 'o', status: 'watching', side: 'sell', inTokenId: 't:4663', outTokenId: 'c', amount: 5n, targetOut: 7n, marketCapUsd: 1, chart: {}, notice: 'x' });
  assert.deepEqual(Object.keys(slim).sort(), ['amount', 'amountPercent', 'createdAt', 'decimals', 'id', 'inTokenId', 'marketCapUsd', 'maxImpactBps', 'maxSlippageBps', 'outTokenId', 'percent', 'sender', 'side', 'solanaAddress', 'status', 'symbol', 'targetMarketCapUsd', 'targetOut', 'tokenAddress', 'triggerWhen']);
  assert.equal('chart' in slim, false);
  assert.equal(slim.amount, '5');
});

test('redaction refuses what it did not inspect: depth, size, and fields outside the envelope', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(60)}.${'b'.repeat(40)}`;
  // A credential buried deeper than the scanner looks must not travel: the
  // depth itself is a refusal.
  let deep = { secret: 'SYNTHETIC-SECRET-DO-NOT-USE' };
  for (let i = 0; i < 14; i += 1) deep = { nested: deep };
  const buried = redactSample({ envelope: { token: jwt, deep }, rpcPath: ['x'] }, { findJwtPaths, replaceAtPaths });
  assert.equal(buried.sample, null);
  assert.match(buried.reason, /deeper than 12 levels/);

  // Fields beside the envelope (the original params, anything a future
  // capture records) are not copied: the export is an allow-list.
  const outside = redactSample(
    { envelope: { token: jwt, request: { method: 'eth_sign', params: [] } }, params: { token: 'SYNTHETIC-TOPLEVEL-SECRET' }, extra: 'x', rpcPath: ['request'], idPaths: [['id']], method: 'eth_sign', wasString: true },
    { findJwtPaths, replaceAtPaths },
  );
  assert.equal(outside.reason, null);
  assert.deepEqual(Object.keys(outside.sample).sort(), ['envelope', 'idPaths', 'method', 'redacted', 'rpcPath', 'wasString']);
  assert.equal(JSON.stringify(outside.sample).includes('SYNTHETIC-TOPLEVEL-SECRET'), false);
  assert.deepEqual(outside.sample.rpcPath, ['request']);
  assert.deepEqual(outside.sample.idPaths, [['id']]);

  // An envelope larger than any Privy envelope is refused unread.
  const huge = redactSample({ envelope: { token: jwt, pad: 'x'.repeat(70_000) }, rpcPath: ['x'] }, { findJwtPaths, replaceAtPaths });
  assert.equal(huge.sample, null);
  assert.match(huge.reason, /larger than any Privy envelope/);
  // No rpcPath: the runner could not rebuild a request; refused rather than guessed.
  assert.match(redactSample({ envelope: { token: jwt } }, { findJwtPaths, replaceAtPaths }).reason, /no rpcPath/);
});
