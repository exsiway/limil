// EIP-7702 authorization tests.
//
// An applied authorization changes the CODE of the wallet, which is to say it
// decides who controls the funds. A mistake in the hash or in the signature
// parity throws no exception and reverts nothing: the authorization simply
// does not apply, or applies to the wrong thing. So the hash, the tuple and
// the protection against a live authorization are all checked exactly.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { concatHex, keccak256, toRlp } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  toAuthorizationRpc,
  AUTHORIZATION_MAGIC,
  authorizationHash,
  delegateFromCode,
  isInertAuthorization,
  rlpUint,
  toAuthorizationTuple,
} from '../src/shared/authorization.js';

const DELEGATE = '0xe6cae83bde06e4c305530e199d7217f42808555b';
const OTHER = '0x1111111111111111111111111111111111111111';

test('the hash matches the manual keccak(0x05 || rlp) assembly', () => {
  const manual = keccak256(concatHex([
    AUTHORIZATION_MAGIC,
    toRlp(['0x1237', DELEGATE, '0x07']),
  ]));
  assert.equal(authorizationHash({ chainId: 4663, address: DELEGATE, nonce: 7 }), manual);
});

test('zero in RLP is the empty string, not a zero byte', () => {
  assert.equal(rlpUint(0), '0x');
  assert.equal(rlpUint(7), '0x07');
  assert.equal(rlpUint(4663), '0x1237');
  assert.notEqual(
    authorizationHash({ chainId: 4663, address: DELEGATE, nonce: 0 }),
    keccak256(concatHex([AUTHORIZATION_MAGIC, toRlp(['0x1237', DELEGATE, '0x00'])])),
  );
});

test('the hash depends on the chain, the delegate and the nonce', () => {
  const base = authorizationHash({ chainId: 4663, address: DELEGATE, nonce: 1 });
  assert.notEqual(base, authorizationHash({ chainId: 8453, address: DELEGATE, nonce: 1 }));
  assert.notEqual(base, authorizationHash({ chainId: 4663, address: DELEGATE, nonce: 2 }));
  assert.notEqual(base, authorizationHash({ chainId: 4663, address: OTHER, nonce: 1 }));
});

test('address case does not affect the hash, garbage is rejected', () => {
  assert.equal(
    authorizationHash({ chainId: 1, address: DELEGATE.toUpperCase().replace('0X', '0x'), nonce: 1 }),
    authorizationHash({ chainId: 1, address: DELEGATE, nonce: 1 }),
  );
  assert.throws(() => authorizationHash({ chainId: 1, address: '0x123', nonce: 1 }), /does not parse/);
});

// The parity in the tuple is 0 or 1. With 27/28 the authorization would not
// apply, and the only way to learn that would be the burnt gas.
test('the tuple carries parity 0/1, not 27/28', async () => {
  const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const hash = authorizationHash({ chainId: 4663, address: DELEGATE, nonce: 3 });
  const signature = await account.sign({ hash });

  const tuple = toAuthorizationTuple({
    chainId: 4663, address: DELEGATE, nonce: 3n, signature,
  });
  assert.ok(tuple.yParity === 0 || tuple.yParity === 1, `parity ${tuple.yParity}`);
  assert.equal(tuple.chainId, 4663);
  assert.equal(tuple.address, DELEGATE.toLowerCase());
  assert.equal(tuple.nonce, '3');
  assert.match(tuple.r, /^0x[0-9a-f]{64}$/i);
  assert.match(tuple.s, /^0x[0-9a-f]{64}$/i);
});

test('the delegate is read out of the 0xef0100<address> code', () => {
  assert.equal(delegateFromCode(`0xef0100${DELEGATE.slice(2)}`), DELEGATE);
  assert.equal(delegateFromCode('0x'), null);
  assert.equal(delegateFromCode('0x6080604052'), null);
  assert.equal(delegateFromCode(null), null);
});

// Inertness separates a safe probe from a change of the wallet code.
test('an authorization to the current delegate or with a stale nonce is inert', () => {
  const current = { currentDelegate: DELEGATE, currentNonce: 5n };
  assert.equal(isInertAuthorization({ address: DELEGATE, nonce: 5n, ...current }).inert, true);
  assert.equal(isInertAuthorization({ address: OTHER, nonce: 4n, ...current }).inert, true);
  // Another delegate and a current nonce: that is a LIVE authorization.
  const live = isInertAuthorization({ address: OTHER, nonce: 5n, ...current });
  assert.equal(live.inert, false);
  assert.equal(live.sameDelegate, false);
  assert.equal(live.staleNonce, false);
});

test('the rpc form of the authorization: hex where the bundler expects hex', () => {
  // The bundler accepts the authorization inside a UserOp only in hex, while a
  // type-4 transaction takes numbers. The same tuple handed over in the wrong
  // form is rejected without a readable message, so both forms live side by
  // side and both are checked.
  const tuple = {
    chainId: 4663,
    address: '0x2222222222222222222222222222222222222222',
    nonce: '6',
    yParity: 1,
    r: `0x${'ab'.repeat(32)}`,
    s: `0x${'cd'.repeat(32)}`,
  };
  const rpc = toAuthorizationRpc(tuple);
  assert.equal(rpc.chainId, '0x1237');
  assert.equal(rpc.nonce, '0x6');
  assert.equal(rpc.yParity, '0x1');
  assert.equal(rpc.address, tuple.address, 'the address stays an address');
  assert.equal(rpc.r, tuple.r);
  assert.equal(rpc.s, tuple.s);
});

test('zero parity does not become an empty string', () => {
  // `0x${(0).toString(16)}` gives '0x0', not '0x', worth checking anyway:
  // the bundler would read an empty value as a missing field.
  const rpc = toAuthorizationRpc({
    chainId: 1, address: '0xabc', nonce: 0, yParity: 0, r: '0x1', s: '0x2',
  });
  assert.equal(rpc.yParity, '0x0');
  assert.equal(rpc.nonce, '0x0');
});
