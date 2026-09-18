// The token inside the envelope is refreshed from the page's own storage, and
// the page's storage holds more JWTs than Privy's. Taking the longest-lived
// one once put a foreign token into the envelope; the sample is persisted and
// refreshed from itself, so the poisoning outlived every reload until the next
// real signature. A replacement must be of the envelope's family.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const NOW = 1788240000000;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.signature`;
const privy = (seconds, over = {}) => jwt({ iss: 'privy.io', sub: 'did:privy:abc', aud: 'app-1', exp: Math.floor(NOW / 1000) + seconds, ...over });

/** The bridge reads window.localStorage and document.cookie; both are stubbed. */
function storageOf(entries) {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (i) => keys[i] ?? null, getItem: (k) => entries[k] ?? null };
}
function withPage(entries) {
  globalThis.window = { localStorage: storageOf(entries), sessionStorage: null };
  globalThis.document = { cookie: '' };
}

const bridge = await import('../src/main/privy-bridge.js');

test('a fresher token of another family does not enter the envelope', () => {
  const current = privy(600);
  const stranger = jwt({ iss: 'analytics.example', sub: 'visitor-1', exp: Math.floor(NOW / 1000) + 86_400 });
  withPage({ 'vendor:token': stranger });
  bridge.loadSample({ envelope: { data: { token: current } }, rpcPath: [] });
  const r = bridge.refreshToken();
  assert.equal(r.ok, false);
  assert.match(r.reason, /same issuer, subject and audience/);
  assert.match(r.reason, /left as it is/);
  assert.equal(bridge.getSample().envelope.data.token, current, 'the envelope is untouched');
});

test('a fresher token of the same family replaces the one in the envelope', () => {
  const current = privy(600);
  const fresher = privy(3600);
  const stranger = jwt({ iss: 'analytics.example', sub: 'visitor-1', exp: Math.floor(NOW / 1000) + 86_400 });
  // The stranger lives longer than both; it must not win.
  withPage({ 'vendor:token': stranger, 'privy:token': fresher });
  bridge.loadSample({ envelope: { data: { token: current } }, rpcPath: [] });
  const r = bridge.refreshToken();
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.changed, true);
  assert.equal(r.source, 'localStorage:privy:token');
  assert.equal(bridge.getSample().envelope.data.token, fresher);
});

test('another Privy account is another family too', () => {
  const current = privy(600);
  const other = privy(3600, { sub: 'did:privy:someone-else' });
  withPage({ 'privy:token': other });
  bridge.loadSample({ envelope: { data: { token: current } }, rpcPath: [] });
  assert.equal(bridge.refreshToken().ok, false);
  assert.equal(bridge.getSample().envelope.data.token, current);
});

test('a sample stored without its token takes the page\'s Privy token, by key name, as soon as it is loaded', async () => {
  // The worker stores the envelope with the redaction placeholder in place of
  // the token (test/sample-redacted.test.mjs). There is no family to match
  // then, so the token comes from Privy's own storage keys and nothing else.
  const { PLACEHOLDER_JWT } = await import('../src/shared/daemon-api.js');
  const live = privy(3600);
  const stranger = jwt({ iss: 'analytics.example', sub: 'visitor-1', exp: Math.floor(NOW / 1000) + 86_400 });
  withPage({ 'vendor:token': stranger, 'privy:token': live });
  bridge.loadSample({ envelope: { data: { token: PLACEHOLDER_JWT } }, rpcPath: [], redacted: true });
  assert.equal(bridge.getSample().envelope.data.token, live, 'filled in at load, before any request');
  // Without a Privy token on the page the placeholder stays and the reason says so.
  withPage({ 'vendor:token': stranger });
  bridge.loadSample({ envelope: { data: { token: PLACEHOLDER_JWT } }, rpcPath: [], redacted: true });
  const r = bridge.refreshToken();
  assert.equal(r.ok, false);
  assert.match(r.reason, /stored without its token/);
  assert.equal(bridge.getSample().envelope.data.token, PLACEHOLDER_JWT);
});
