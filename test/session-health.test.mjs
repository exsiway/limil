// What to do with a FOMO session that is going stale.
//
// WHY THESE TESTS. This function decides whether to reload the tab under the
// person's hands and whether to substitute the token in the header. An error
// one way is a reload loop; the other way is silently broken authorization
// at the moment an order must execute.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  RELOAD_COOLDOWN_MS, REFRESH_BEFORE_SECONDS, sameTokenFamily, sessionPlan,
} from '../src/shared/session-health.js';

const NOW = 1788240000000;

/** Builds a JWT without a signature: only the payload is parsed. */
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.signature`;
}
const claims = { iss: 'privy.io', sub: 'did:privy:abc', aud: 'app-1' };
const withLife = (seconds, over = {}) => jwt({
  ...claims, ...over, exp: Math.floor(NOW / 1000) + seconds,
});

test('a live session is left alone', () => {
  const plan = sessionPlan({ header: withLife(3600), privyToken: null, now: NOW });
  assert.equal(plan.action, 'ok');
  assert.equal(plan.secondsLeft, 3600);
});

test('while there is no header, wait rather than fix', () => {
  // A fresh tab: the page has not made a single request yet. Reloading it now
  // would mean reloading an empty page forever.
  const plan = sessionPlan({ header: null, privyToken: withLife(3600), now: NOW });
  assert.equal(plan.action, 'wait');
});

test('a non-JWT header is left as it is', () => {
  // There is nothing to judge the term by. Touching what works on a guess is
  // the worst option.
  const plan = sessionPlan({ header: 'opaque-token-value', privyToken: null, now: NOW });
  assert.equal(plan.action, 'ok');
  assert.equal(plan.secondsLeft, null);
});

test('an expiring header is fixed by substitution when Privy holds the same family', () => {
  const plan = sessionPlan({
    header: withLife(REFRESH_BEFORE_SECONDS - 1),
    privyToken: withLife(3600),
    now: NOW,
  });
  assert.equal(plan.action, 'substitute', plan.reason);
});

test("someone else's token is not substituted, even if it is fresher", () => {
  // Substituting another account's token would break authorization and then
  // report the fix as done.
  const plan = sessionPlan({
    header: withLife(10),
    privyToken: withLife(3600, { sub: 'did:privy:other' }),
    lastReloadAt: 0,
    now: NOW,
  });
  assert.equal(plan.action, 'reload');
});

test('an expired header with no replacement means a reload', () => {
  const plan = sessionPlan({ header: withLife(-60), privyToken: null, lastReloadAt: 0, now: NOW });
  assert.equal(plan.action, 'reload');
  assert.ok(plan.secondsLeft < 0);
});

test('a second reload in a row is not done, that would be a loop', () => {
  // A logout is not cured by reloading, and spinning it in a circle would not
  // even let the person log in.
  const plan = sessionPlan({
    header: withLife(-60),
    privyToken: null,
    lastReloadAt: NOW - RELOAD_COOLDOWN_MS + 1000,
    now: NOW,
  });
  assert.equal(plan.action, 'wait');
});

test('after the cooldown a reload is allowed again', () => {
  const plan = sessionPlan({
    header: withLife(-60),
    privyToken: null,
    lastReloadAt: NOW - RELOAD_COOLDOWN_MS - 1,
    now: NOW,
  });
  assert.equal(plan.action, 'reload');
});

test('the family is compared by issuer and subject, not by expiry', () => {
  assert.equal(sameTokenFamily(withLife(10), withLife(3600)), true);
  assert.equal(sameTokenFamily(withLife(10), withLife(10, { iss: 'other' })), false);
  assert.equal(sameTokenFamily('not a jwt', withLife(10)), false);
});
