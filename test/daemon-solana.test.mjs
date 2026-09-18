import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSolanaRelay } from '../daemon/solana.mjs';

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('the relay asks the nodes in order without an Origin, and the first answer wins', async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    asked.push({ url, origin: init.headers.Origin ?? init.headers.origin ?? null, body: JSON.parse(init.body) });
    if (url.includes('mainnet-beta')) return reply(403, { error: { code: 403, message: 'Access forbidden' } });
    return reply(200, { jsonrpc: '2.0', id: 1, result: { value: { blockhash: 'abc' } } });
  };
  const r = makeSolanaRelay({ nodes: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], fetchFn });
  const out = await r.relay({ method: 'getLatestBlockhash', params: [] });
  assert.deepEqual(out, { result: { value: { blockhash: 'abc' } } });
  assert.equal(asked.length, 2, 'the refused node is skipped, the next one answers');
  assert.equal(asked[0].origin, null, 'no Origin header leaves this process');
  assert.equal(asked[1].body.method, 'getLatestBlockhash');
});

test('every node refusing is one error naming each; a method outside the wallet set is not relayed at all', async () => {
  const fetchFn = async () => reply(403, {});
  const r = makeSolanaRelay({ nodes: ['https://a.example', 'https://b.example'], fetchFn });
  const out = await r.relay({ method: 'getBalance', params: ['x'] });
  assert.match(out.error, /a\.example: HTTP 403; b\.example: HTTP 403/);
  let calls = 0;
  const r2 = makeSolanaRelay({ nodes: ['https://a.example'], fetchFn: async () => { calls += 1; return reply(200, { result: 1 }); } });
  const refused = await r2.relay({ method: 'requestAirdrop', params: [] });
  assert.match(refused.error, /not relayed/);
  assert.equal(calls, 0);
  const noMethod = await r2.relay({});
  assert.match(noMethod.error, /not relayed/);
});
