// Telling Privy's two non-refusals apart from a real one.
//
// Both of these arrived in this project as a wall of raw Privy text under a
// saved order, and both read like "your wallet is banned" when neither was:
// one is an expired token inside the captured envelope, the other is Privy
// saying the embedded wallet has not been loaded into this page session yet.
// The second is the harder one, because it names an address, and which
// address it names is the whole difference between "nothing is wrong" and
// "this envelope belongs to another wallet".

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { privyRefusalText } from '../src/shared/envelope.js';

const WALLET = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const OTHER = '0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb';

test('the wallet we asked for, not loaded: say it is loadable, not broken', () => {
  const text = privyRefusalText(
    `Failed to initialize: '${WALLET}' not loaded on this device`,
    { expectSender: WALLET },
  );
  assert.match(text, /the envelope is good/);
  assert.match(text, /SAME tab without reloading/);
  // And it must not send the person off to re-capture anything.
  assert.doesNotMatch(text, /re-?captur/i);
});

test('case does not decide it, the address is compared case-insensitively', () => {
  const text = privyRefusalText(
    `Failed to initialize: '${WALLET.toLowerCase()}' not loaded on this device`,
    { expectSender: WALLET },
  );
  assert.match(text, /the envelope is good/);
});

test('the same words about ANOTHER wallet get no such reassurance', () => {
  const text = privyRefusalText(
    `Failed to initialize: '${OTHER}' not loaded on this device`,
    { expectSender: WALLET },
  );
  assert.doesNotMatch(text, /the envelope is good/);
  assert.match(text, /not loaded on this device/);
});

test('an expired token still says it is a token and not a ban', () => {
  const text = privyRefusalText('Invalid auth token', { expectSender: WALLET });
  assert.match(text, /expired token in the envelope sample/);
  assert.match(text, /not a refusal to sign/);
});

test('anything else is passed through as it came', () => {
  assert.equal(privyRefusalText('rate limited', { expectSender: WALLET }), 'Privy refused: rate limited');
});

test('a wallet not loaded in this tab is connected the way the SDK does it, and the request is sent once more', async () => {
  const { readFileSync } = await import('node:fs');
  const bridge = readFileSync(new URL('../src/main/privy-bridge.js', import.meta.url), 'utf8');
  const body = bridge.slice(bridge.indexOf('export async function requestViaPrivy('), bridge.indexOf('export async function connectWallet('));
  assert.match(body, /if \(!\/not loaded on this device\/i\.test\(text\) \|\| !ours\) throw new Error\(privyRefusalText\(text, \{ expectSender \}\)\);/);
  assert.match(body, /await connectWallet\(\);\s*try \{\s*answer = await send\(\);/);
  assert.equal([...body.matchAll(/await send\(\)/g)].length, 2, 'one retry, not a loop');
  const connect = bridge.slice(bridge.indexOf('export async function connectWallet('), bridge.indexOf('function exchange('));
  assert.match(connect, /buildConnectRequest\(state\.sample/);
  assert.match(connect, /wallet_not_on_device/, 'a wallet not on the device is recovered');
  assert.match(connect, /buildRecoverRequest\(state\.sample/);
  assert.match(connect, /ensureFreshToken\(\)/, 'the token in the connect message is the fresh one');
});
