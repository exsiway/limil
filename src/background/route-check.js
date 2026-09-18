// Buy route check before sending: the network part. Logic is in shared/route-check.js.

import { decodeEventLog, decodeFunctionResult, encodeFunctionData } from 'viem';

import { rpcUrl } from '../shared/chains.js';
import {
  INITIALIZE_ABI, INITIALIZE_TOPIC, QUOTER_ABI, V4, hopDirection, hopQuoteKey, isV4Hop, kyberRouteUrl, routeHops,
  routeSupported, routeVerdict,
} from '../shared/route-check.js';

const KYBER_TIMEOUT_MS = 10_000;
const poolKeys = new Map();

async function rpc(chainId, method, params) {
  const res = await fetch(rpcUrl(chainId), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${chainId}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${chainId}: ${json.error.message}`);
  return json.result;
}

/** Pool key from the Initialize event; a log query by pool id over the whole history is fast. */
async function poolKey(chainId, poolId) {
  const cacheKey = `${chainId}:${poolId}`;
  if (poolKeys.has(cacheKey)) return poolKeys.get(cacheKey);
  const logs = await rpc(chainId, 'eth_getLogs', [{
    address: V4[chainId].poolManager, fromBlock: '0x0', toBlock: 'latest', topics: [INITIALIZE_TOPIC, poolId],
  }]);
  if (!logs?.length) throw new Error(`pool ${poolId.slice(0, 10)} not found in the PoolManager`);
  const { args } = decodeEventLog({ abi: INITIALIZE_ABI, data: logs[0].data, topics: logs[0].topics });
  const key = { currency0: args.currency0, currency1: args.currency1, fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks };
  poolKeys.set(cacheKey, key);
  return key;
}

async function quoteHop(chainId, hop) {
  try {
    const key = await poolKey(chainId, hop.pool);
    const dir = hopDirection(key, hop, chainId);
    if (dir.error) return { error: dir.error };
    const { zeroForOne } = dir;
    const data = encodeFunctionData({
      abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: hop.amountIn, hookData: '0x' }],
    });
    const raw = await rpc(chainId, 'eth_call', [{ to: V4[chainId].quoter, data }, 'latest']);
    const [out] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', data: raw });
    return { out, hooks: key.hooks, fee: key.fee };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

/**
 * The Kyber route for a buy and its v4 hops through the quoter.
 *
 * @returns {{ok: boolean, reason: string|null, routeOut: bigint|null, worstShortfallBps: number|null, hops: object[]}}
 */
export async function checkBuyRoute({ chainId, tokenIn, tokenOut, amountIn, capBps }) {
  const chain = Number(chainId);
  if (!routeSupported(chain)) return { ok: false, reason: `the route on chain ${chain} cannot be checked`, routeOut: null, worstShortfallBps: null, hops: [] };
  let response;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), KYBER_TIMEOUT_MS);
    const res = await fetch(kyberRouteUrl({ chainId: chain, tokenIn, tokenOut, amountIn }), { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    response = await res.json();
  } catch (err) {
    return { ok: false, reason: `Kyber route not received: ${String(err?.message || err).slice(0, 120)}`, routeOut: null, worstShortfallBps: null, hops: [] };
  }
  let parsed;
  try { parsed = routeHops(response); } catch (err) {
    return { ok: false, reason: String(err?.message || err), routeOut: null, worstShortfallBps: null, hops: [] };
  }
  const quotes = {};
  for (const hop of parsed.hops) {
    if (!isV4Hop(hop) || quotes[hopQuoteKey(hop)]) continue;
    quotes[hopQuoteKey(hop)] = await quoteHop(chain, hop);
  }
  const verdict = routeVerdict({ hops: parsed.hops, quotes, capBps });
  return {
    ...verdict, routeOut: parsed.amountOut,
    hops: parsed.hops.map((h) => ({
      exchange: h.exchange, pool: h.pool, amountIn: h.amountIn.toString(), amountOut: h.amountOut.toString(),
      quoter: quotes[hopQuoteKey(h)] ? (quotes[hopQuoteKey(h)].error ?? quotes[hopQuoteKey(h)].out.toString()) : null,
    })),
  };
}
