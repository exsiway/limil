import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isApiRequest } from '../src/shared/fomo-api.js';
import {
  chainKeyOf, marketCapOf, parseCandle, subscribeMessage,
} from '../src/shared/price-stream.js';

test('the REST API is told from the other fomo hosts by host and path', () => {
  assert.equal(isApiRequest('https://prod-api.fomo.family', '/swaps/v2'), true);
  assert.equal(isApiRequest('https://prod-api.fomo.family', '/v2/users/abc/balances'), true);
  assert.equal(isApiRequest('https://prod-api.fomo.family', '/trades/738baa64'), true);
  assert.equal(isApiRequest('https://mobula-api.fomo.family', '/'), false, 'the candle host');
  assert.equal(isApiRequest('https://evm-data.prod-edge.fomo.family', '/v2/anything'), false, 'the data host');
  assert.equal(isApiRequest('https://prod-api.fomo.family', '/health'), false, 'not an API path we know');
  assert.equal(isApiRequest('https://evil.example', '/swaps/v2'), false);
  assert.equal(isApiRequest('not a url', '/swaps/v2'), false);
});

test('the socket chain key: evm:<id> for EVM, solana for Solana', () => {
  assert.equal(chainKeyOf('0x2ab8a4dd2191989ac2898006df350b236d2b7777:56'), 'evm:56');
  assert.equal(chainKeyOf('0x39dbed3a2bd333467115de45665cc57f813c4571:4663'), 'evm:4663');
  assert.equal(chainKeyOf('7Ksh2R9hrUJqejjNErBg3XRNA2BDoL9DJmPGNwCqk989:1399811149'), 'solana');
  assert.equal(chainKeyOf('0xabc'), null);
});

test('the subscribe message has the shape the chart sends', () => {
  const m = subscribeMessage({ tokenId: '0x2ab8a4dd2191989ac2898006df350b236d2b7777:56', authorization: 'jwt', id: 'limil-1' });
  assert.deepEqual(m, {
    type: 'ohlcv', authorization: 'jwt',
    payload: { asset: '0x2ab8a4dd2191989ac2898006df350b236d2b7777', chainId: 'evm:56', period: '1m', subscriptionId: 'limil-1' },
  });
  assert.throws(() => subscribeMessage({ tokenId: 'nochain', authorization: 'x', id: 'a' }), /names no chain/);
});

test('a candle frame is read, everything else is ignored', () => {
  const frame = '{"type":"ohlcv","subscriptionId":"fomo-2","volume":40787.8,"open":0.917,"high":0.918,"low":0.915,"close":0.9166581501337725,"time":1788624480000,"period":"1m","tradeTime":1788624532000,"asset":"0x39dbed3a2bd333467115de45665cc57f813c4571"}';
  assert.deepEqual(parseCandle(frame), { id: 'fomo-2', close: 0.9166581501337725, asset: '0x39dbed3a2bd333467115de45665cc57f813c4571', time: 1788624532000 });
  assert.equal(parseCandle('{"event":"pong"}'), null);
  assert.equal(parseCandle('{"type":"subscribed"}'), null);
  assert.equal(parseCandle('not json'), null);
  assert.equal(parseCandle({ type: 'ohlcv', close: 0 }), null, 'a zero close is no price');
});

test('market cap is price times supply, the chart quantity', () => {
  assert.equal(marketCapOf(0.9166, 1_000_000_000), 916_600_000);
  assert.equal(marketCapOf(0.004579, 1e9), 4_579_000);
  assert.equal(marketCapOf(1, 0), null);
  assert.equal(marketCapOf(null, 1e9), null);
});

test('a candle with no known id and no asset is attributed to no token', async () => {
  // `lower(null)` is '' and every key starts with '', so such a frame would
  // land on the first token in the map: a price for one token, an order
  // firing on another.
  const { matchToken } = await import('../src/main/price-stream.js');
  const tokens = new Map([
    ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:56', { id: 'limil-1', supply: 1e9 }],
    ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:4663', { id: 'limil-2', supply: 1e9 }],
  ]);
  assert.equal(matchToken({ id: 'fomo-9', asset: null, close: 1 }, tokens), null);
  assert.equal(matchToken({ id: null, asset: '', close: 1 }, tokens), null);
  assert.equal(matchToken({ id: 'nothing', asset: undefined, close: 1 }, tokens), null);
  // The two legitimate paths still work: by subscription id, then by asset.
  assert.equal(matchToken({ id: 'limil-2', asset: null, close: 1 }, tokens)[0], '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:4663');
  assert.equal(matchToken({ id: 'fomo-1', asset: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', close: 1 }, tokens)[0], '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:56');
});
