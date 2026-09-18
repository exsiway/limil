// Header assembly for the bundler.
//
// The set for the bundler must be assembled from the API headers rather than
// wait for the page to call the bundler itself: until it did, the extension
// could not send anything before a manual swap.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BUNDLER_ALLOWED_HEADERS,
  bundlerHeaders,
  carriesAuth,
} from '../src/shared/bundler-headers.js';

// Resembles what the front end sends to the API: authorization plus its own
// telemetry plus headers the bundler does not list.
const API_HEADERS = {
  'authorization': 'Bearer aaa',
  'fomo-execution-context': 'web',
  'x-datadog-trace-id': '123',
  'sentry-trace': 'not on the bundler list',
  'baggage': 'not on the bundler list',
  'accept-language': 'en',
};

test('only what the bundler allows makes it into the set', () => {
  const out = bundlerHeaders(API_HEADERS);
  assert.deepEqual(Object.keys(out).sort(), [
    'authorization', 'content-type', 'fomo-execution-context', 'x-datadog-trace-id',
  ]);
  // Exactly these two failed the CORS preflight, and the request never left.
  assert.equal(out['sentry-trace'], undefined);
  assert.equal(out.baggage, undefined);
});

test('content-type is set automatically', () => {
  assert.equal(bundlerHeaders(API_HEADERS)['content-type'], 'application/json');
});

test('the vendor authorization header name is accepted too', () => {
  // FOMO keeps authorization and its own fomo-authorization side by side.
  // Looking for exactly the first would silently return nothing on the
  // second.
  const out = bundlerHeaders({ 'fomo-authorization': 'Bearer bbb' });
  assert.equal(out['fomo-authorization'], 'Bearer bbb');
});

test('without authorization no set is assembled', () => {
  // Sending without it is a guaranteed 401 no_auth_header; better to say so.
  assert.equal(bundlerHeaders({ 'x-datadog-trace-id': '1' }), null);
  assert.equal(bundlerHeaders(null), null);
});

test('header name case does not matter', () => {
  const out = bundlerHeaders({ 'Authorization': 'Bearer ccc' });
  assert.equal(out.authorization, 'Bearer ccc');
});

test('empty values are not carried over', () => {
  assert.equal(bundlerHeaders({ authorization: 'Bearer d', 'traceparent': '' }).traceparent, undefined);
});

test('the allow list is a measurement, not a guess', () => {
  // The list was read off the bundler's CORS preflight. If FOMO changes it,
  // sending fails at the preflight; re-measure with the command in the header
  // of src/shared/bundler-headers.js.
  assert.ok(BUNDLER_ALLOWED_HEADERS.includes('authorization'));
  assert.ok(BUNDLER_ALLOWED_HEADERS.includes('fomo-authorization'));
  assert.ok(BUNDLER_ALLOWED_HEADERS.includes('content-type'));
});

test('the session carrier is recognised under both names', () => {
  assert.equal(carriesAuth('authorization'), true);
  assert.equal(carriesAuth('fomo-authorization'), true);
  assert.equal(carriesAuth('x-datadog-trace-id'), false);
});
