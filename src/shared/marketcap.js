// Token facts from FOMO API responses: ticker, market cap, decimals.
//
// The exact endpoint is not known, so the tree is walked and fields are taken
// from the node that refers to the wanted token. The address binding is
// mandatory: one response carries data for several tokens, and the first value
// found would belong to a neighbour, an error that looks perfectly plausible.
//
// When nothing is found the result is null: an order label with an address and
// a percent is more honest than an invented ticker or level.

const CAP_KEYS = ['marketCap', 'marketCapUsd', 'mcap', 'mcapUsd', 'fdv', 'fdvUsd', 'marketCapUsdc'];
/**
 * The token's price in dollars, when the same payload carries one.
 *
 * Taken together with the market cap above it gives the supply, and the supply
 * is what says whether a chart is drawn in caps or in prices. Optional: a
 * payload without a price simply leaves it null.
 */
const PRICE_KEYS = ['priceUsd', 'priceUSD', 'usdPrice', 'price', 'currentPrice', 'priceUsdc'];
const SYMBOL_KEYS = ['symbol', 'tokenSymbol', 'ticker'];
const DECIMALS_KEYS = ['decimals', 'tokenDecimals'];
const ADDRESS_KEYS = /^(address|mint|tokenId|tokenAddress|contractAddress)$/i;

function pickNumber(node, keys) {
  for (const key of keys) {
    const value = Number(node[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function pickString(node, keys) {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Whether the node refers to the wanted token. */
function isAbout(node, wanted) {
  return Object.entries(node).some(([key, value]) => ADDRESS_KEYS.test(key)
    && typeof value === 'string'
    && value.split(':')[0].toLowerCase() === wanted);
}

/**
 * Looks for the ticker, market cap and decimals of a token.
 *
 * The whole tree is walked and the facts are COLLECTED piecewise: the ticker
 * may sit in one node and the market cap in a sibling, both about our token.
 * Stopping at the first match would lose half of the facts.
 *
 * @returns {{symbol: string|null, marketCapUsd: number|null, priceUsd: number|null, decimals: number|null}}
 */
export function findTokenInfo(root, address) {
  const found = { symbol: null, marketCapUsd: null, priceUsd: null, decimals: null };
  if (!address) return found;
  const wanted = String(address).toLowerCase();

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const children = Object.values(node)
      .filter((v) => v && typeof v === 'object' && !Array.isArray(v));

    // A node is "ours" if the address is in the node itself OR in any direct
    // child. The latter is the balance row shape: the address sits in
    // `balance`, the ticker in the sibling `userToken`.
    if (isAbout(node, wanted) || children.some((c) => isAbout(c, wanted))) {
      for (const source of [node, ...children]) {
        found.symbol ??= pickString(source, SYMBOL_KEYS);
        found.marketCapUsd ??= pickNumber(source, CAP_KEYS);
        found.priceUsd ??= pickNumber(source, PRICE_KEYS);
        found.decimals ??= pickNumber(source, DECIMALS_KEYS);
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(root, 0);
  return found;
}
