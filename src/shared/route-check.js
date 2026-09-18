// Buy route check before sending: the pure part.
//
// On a buy our transaction lives on Solana and the swap on the EVM side is
// done by the relay solver through the KyberSwap aggregator. None of our code
// runs in that transaction, the output guard has nowhere to stand, and on
// chain the buy is protected only by relay's 10% tolerance. What can be done
// in advance is to look at the same route with the same engine and run its
// Uniswap v4 hops through the official V4Quoter. The quoter executes the
// pool's hook in simulation, so a fee that is invisible in the pool state
// shows up here. A pool the quoter cannot simulate is treated as untrusted.
//
// Only addresses, Kyber response parsing and the verdict arithmetic live here;
// the network calls are in background/route-check.js.

/** KyberSwap chain slugs. A chain not listed cannot be checked and buys there are not signed. */
const KYBER_CHAIN_SLUG = Object.freeze({ 4663: 'robinhood', 8453: 'base' });
const KYBER_API = 'https://aggregator-api.kyberswap.com';

/** Uniswap v4 per chain: PoolManager and quoter, from the official deployment list. */
export const V4 = Object.freeze({
  4663: { poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951', quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' },
  8453: { poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b', quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d' },
});

export const INITIALIZE_ABI = [{
  type: 'event', name: 'Initialize', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true }, { name: 'fee', type: 'uint24', indexed: false },
    { name: 'tickSpacing', type: 'int24', indexed: false }, { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'tick', type: 'int24', indexed: false },
  ],
}];
export const INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

export const QUOTER_ABI = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{
    name: 'params', type: 'tuple', components: [
      { name: 'poolKey', type: 'tuple', components: [
        { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
      ] },
      { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
    ],
  }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}];

/** The native coin in a v4 pool key is the zero address; Kyber names it by its wrapper or its own marker. */
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const KYBER_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const WRAPPED_NATIVE = Object.freeze({
  4663: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  8453: '0x4200000000000000000000000000000000000006',
});

const sameCurrency = (poolCurrency, hopToken, chainId) => {
  const a = String(poolCurrency).toLowerCase();
  const b = String(hopToken).toLowerCase();
  if (a === b) return true;
  if (a === NATIVE) return b === KYBER_NATIVE || b === WRAPPED_NATIVE[Number(chainId)];
  return false;
};

/**
 * Swap direction in the pool for a Kyber hop. Decided by BOTH ends: input and
 * output must match the pool pair, otherwise a different swap would be quoted
 * and the verdict would read "99.99% less" for no reason (native ETH in the
 * pool key versus WETH at Kyber).
 */
export function hopDirection(key, hop, chainId) {
  const inIs0 = sameCurrency(key.currency0, hop.tokenIn, chainId);
  const inIs1 = sameCurrency(key.currency1, hop.tokenIn, chainId);
  const outIs0 = sameCurrency(key.currency0, hop.tokenOut, chainId);
  const outIs1 = sameCurrency(key.currency1, hop.tokenOut, chainId);
  if (inIs0 && outIs1) return { zeroForOne: true };
  if (inIs1 && outIs0) return { zeroForOne: false };
  return { error: `pool pair ${key.currency0.slice(0, 8)}/${key.currency1.slice(0, 8)} does not match hop ${hop.tokenIn.slice(0, 8)}→${hop.tokenOut.slice(0, 8)}` };
}

export function routeSupported(chainId) {
  return Boolean(KYBER_CHAIN_SLUG[Number(chainId)] && V4[Number(chainId)]);
}

export function kyberRouteUrl({ chainId, tokenIn, tokenOut, amountIn }) {
  const slug = KYBER_CHAIN_SLUG[Number(chainId)];
  if (!slug) throw new Error(`Kyber does not know chain ${chainId}`);
  const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: String(amountIn) });
  return `${KYBER_API}/${slug}/api/v1/routes?${q}`;
}

/** Flat list of hops from a Kyber response. Throws when the answer is not a route. */
export function routeHops(response) {
  const summary = response?.data?.routeSummary;
  if (!summary || !Array.isArray(summary.route)) throw new Error('no routeSummary.route in the Kyber answer');
  const hops = [];
  for (const path of summary.route) {
    for (const h of path ?? []) {
      hops.push({
        exchange: String(h.exchange ?? ''), pool: String(h.pool ?? ''), tokenIn: String(h.tokenIn ?? '').toLowerCase(),
        tokenOut: String(h.tokenOut ?? '').toLowerCase(), amountIn: BigInt(h.swapAmount ?? 0), amountOut: BigInt(h.amountOut ?? 0),
      });
    }
  }
  return { hops, amountOut: BigInt(summary.amountOut ?? 0), amountOutUsd: summary.amountOutUsd ?? null };
}

/** A Uniswap v4 hop: Kyber labels them "uniswap-v4", "uniswap-v4-fee" and the like. */
export const isV4Hop = (hop) => /^uniswap-?v4/i.test(hop.exchange);

/**
 * Quote key of a hop: pool AND amount. One pool can occur twice in a split
 * route with different amounts, and quoting one amount against the promise
 * for the other reads as "52% less" for no reason.
 */
export const hopQuoteKey = (hop) => `${hop.pool}:${hop.amountIn.toString()}`;

/**
 * Route verdict. Every v4 hop must simulate in the quoter and give no less
 * than Kyber promises, within the user's slippage. `quotes` is what the quoter
 * answered per v4 hop (keyed by hopQuoteKey): {out} or {error}.
 */
export function routeVerdict({ hops, quotes, capBps }) {
  const cap = Number(capBps);
  let worst = 0;
  const problems = [];
  for (const hop of hops) {
    if (!isV4Hop(hop)) continue;
    const q = quotes[hopQuoteKey(hop)];
    if (!q) { problems.push(`hop ${hop.pool.slice(0, 10)}: quoter not asked`); continue; }
    if (q.error || q.out === undefined || q.out === null) {
      problems.push(`pool ${hop.pool.slice(0, 10)} does not simulate in the quoter (${String(q.error ?? 'no output').slice(0, 80)}), untrusted`);
      continue;
    }
    if (hop.amountOut <= 0n) continue;
    const shortfall = q.out >= hop.amountOut ? 0 : Number(((hop.amountOut - BigInt(q.out)) * 10000n) / hop.amountOut);
    if (shortfall > worst) worst = shortfall;
    if (Number.isFinite(cap) && shortfall > cap) {
      problems.push(`pool ${hop.pool.slice(0, 10)} gives ${(shortfall / 100).toFixed(2)}% less than the route promises`);
    }
  }
  if (problems.length) return { ok: false, worstShortfallBps: worst, reason: `buy route failed the check: ${problems.join('; ')}` };
  return { ok: true, worstShortfallBps: worst, reason: null };
}
