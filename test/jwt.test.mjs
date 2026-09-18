// Tests for the token inside the Privy envelope.
//
// Substituting the token edits SOMEONE ELSE'S structure that we neither invent
// nor fully understand. So the replacement must touch exactly the JWT fields
// and nothing else, and the expiry must be read correctly: it tells the user
// "expired" before Privy answers "Invalid auth token".

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  decodeJwtPayload,
  findJwtPaths,
  freshestToken,
  getAtPath,
  looksLikeJwt,
  replaceAtPaths,
  secondsUntilExpiry,
} from '../src/shared/jwt.js';

/** Builds a JWT-like string with the given expiry. The signature is fake. */
function makeJwt(exp) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp })}.c2lnbmF0dXJlXzEyMzQ1`;
}

const NOW = 1_800_000_000_000; // fixed time so the tests do not drift

test('a JWT is recognised, look-alike strings are not', () => {
  assert.equal(looksLikeJwt(makeJwt(1)), true);
  assert.equal(looksLikeJwt('an ordinary string'), false);
  assert.equal(looksLikeJwt('a.b.c'), false, 'parts too short');
  assert.equal(looksLikeJwt('0xdeadbeef'), false);
  assert.equal(looksLikeJwt(null), false);
  assert.equal(looksLikeJwt(12345), false);
});

test('the expiry is read, including a past one', () => {
  const alive = makeJwt(Math.floor(NOW / 1000) + 600);
  const dead = makeJwt(Math.floor(NOW / 1000) - 120);
  assert.equal(secondsUntilExpiry(alive, NOW), 600);
  assert.equal(secondsUntilExpiry(dead, NOW), -120);
  // A token without exp: the term is unknown, which is NOT the same as expired.
  const noExp = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.c2lnMTIzNDU2`;
  assert.equal(secondsUntilExpiry(noExp, NOW), null);
  assert.equal(secondsUntilExpiry('garbage', NOW), null);
});

test('the payload is decoded without verifying the signature', () => {
  assert.deepEqual(decodeJwtPayload(makeJwt(42)), { exp: 42 });
  assert.equal(decodeJwtPayload('not a token'), null);
});

test('token paths are found at any depth', () => {
  const token = makeJwt(1);
  const envelope = {
    id: 'req-1',
    data: { headers: { authorization: token }, nested: [{ t: token }] },
    method: 'eth_signTypedData_v4',
  };
  const paths = findJwtPaths(envelope);
  assert.equal(paths.length, 2);
  for (const path of paths) assert.equal(getAtPath(envelope, path), token);
});

test('the replacement touches only the token fields and spoils nothing else', () => {
  const old = makeJwt(1);
  const fresh = makeJwt(2);
  const envelope = {
    id: 'req-1',
    method: 'eth_signTypedData_v4',
    params: ['0xabc', '{"types":{}}'],
    auth: old,
    deep: { token: old, keep: 42 },
  };
  const patched = replaceAtPaths(envelope, findJwtPaths(envelope), fresh);

  assert.equal(patched.auth, fresh);
  assert.equal(patched.deep.token, fresh);
  assert.equal(patched.deep.keep, 42);
  assert.equal(patched.method, 'eth_signTypedData_v4');
  assert.deepEqual(patched.params, ['0xabc', '{"types":{}}']);
  // The original envelope is unchanged: it may still be needed as it is.
  assert.equal(envelope.auth, old);
});

test('the freshest token is the one with the furthest expiry', () => {
  const soon = makeJwt(Math.floor(NOW / 1000) + 60);
  const later = makeJwt(Math.floor(NOW / 1000) + 3600);
  const best = freshestToken([soon, later, 'garbage'], NOW);
  assert.equal(best.token, later);
  assert.equal(best.left, 3600);
  assert.equal(freshestToken(['garbage', null], NOW), null);
});
