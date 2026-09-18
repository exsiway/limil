// Token context: which token the page shows and how much of it the wallet holds.
//
// Balances come from the FOMO API (`/v2/users/{uuid}/balances`), not from the
// DOM. The DOM shows a formatted "16.7K", which cannot be turned back into the
// exact amount in minimal units that goes into a signed UserOperation.
//
// The response schema is not documented, so the parser is tolerant: the known
// shape is read by field name first and a tree walk is the fallback. When
// neither matches, the panel reports it instead of showing zero.

/** Keys under which providers usually put a balance in minimal units. */
const AMOUNT_KEYS = [
  'tokenAmountRemaining',
  'rawAmount',
  'amountRaw',
  'balanceRaw',
  'rawBalance',
  'amount',
  'balance',
];

const DECIMALS_KEYS = ['decimals', 'tokenDecimals', 'decimal'];
const SYMBOL_KEYS = ['symbol', 'tokenSymbol', 'ticker'];
const ADDRESS_KEYS = ['address', 'tokenAddress', 'contractAddress', 'mint', 'id', 'tokenId'];

/**
 * Keys that hold the address of the TOKEN.
 *
 * `address` is deliberately absent: in a FOMO balance row it is the wallet
 * address (see `extractWallets`). Matching on it once returned a position for
 * a wallet address and picked up 18 decimals for a 6-decimal token.
 */
const TOKEN_ADDRESS_KEYS = ['tokenAddress', 'contractAddress', 'mint', 'tokenId'];

/** Keys whose presence marks a node as describing a wallet rather than a token. */
const WALLET_KEYS = ['userAddress', 'walletAddress', 'owner'];
const NETWORK_KEYS = ['networkId', 'chainId', 'network'];

function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  yield node;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') yield* walk(value, depth + 1);
  }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decimals inferred from a raw / human-readable pair.
 *
 * For Solana tokens the FOMO response carries no `decimals` field, only
 * `balance` (raw) and `shiftedBalance` (human). Their ratio is exactly
 * 10^decimals; the nearest integer power is returned when it really is one.
 */
export function inferDecimals(raw, shifted) {
  const r = Number(raw);
  const s = Number(shifted);
  if (!Number.isFinite(r) || !Number.isFinite(s) || r <= 0 || s <= 0) return null;
  const d = Math.log10(r / s);
  const rounded = Math.round(d);
  if (rounded < 0 || rounded > 18 || Math.abs(d - rounded) > 0.01) return null;
  return rounded;
}

function pick(node, keys) {
  for (const key of keys) {
    const value = node[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

/**
 * Network by the slug in a token page URL: `/tokens/<slug>/<address>`.
 * Needed when the token is not on the balance yet (a first buy), because the
 * `<address>:<network>` id has no other source then.
 */
const NETWORK_BY_SLUG = {
  robinhood: 4663, base: 8453, bnb: 56, bsc: 56, ethereum: 1, eth: 1, monad: 143,
  hyperliquid: 1337, solana: 1399811149,
};

/** FOMO token page URL for an `<address>:<network>` id; null for networks without a slug. */
export function tokenPageUrl(tokenId) {
  const [address, network] = String(tokenId ?? '').split(':');
  if (!address || !network) return null;
  const slug = Object.entries(NETWORK_BY_SLUG).find(([, id]) => id === Number(network))?.[0];
  return slug ? `https://fomo.family/tokens/${slug}/${address}` : null;
}

export function tokenIdFromLocation(href) {
  const m = String(href ?? '').match(/\/tokens\/([a-z0-9-]+)\/([^/?#]+)/i);
  if (!m) return null;
  const network = NETWORK_BY_SLUG[m[1].toLowerCase()];
  const address = tokenFromLocation(m[2]);
  return network && address ? `${address}:${network}` : null;
}

/**
 * Token address from a page URL. The route format is not relied upon: the
 * path is searched for anything that can be a token address, an EVM address
 * or a base58 Solana mint.
 */
export function tokenFromLocation(href) {
  const text = String(href ?? '');
  const evm = text.match(/0x[a-fA-F0-9]{40}/);
  if (evm) return evm[0];
  // base58 without 0, O, I, l; a Solana mint is 32-44 characters.
  const solana = text.match(/(?:^|[/=])([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?&#])/);
  return solana ? solana[1] : null;
}

function headOf(value) {
  return typeof value === 'string' ? value.split(':')[0].toLowerCase() : null;
}

/**
 * Whether a node refers to the wanted TOKEN address.
 *
 * Token-specific keys are checked first. The generic `address` and `id` are
 * accepted only when the node does not look like a wallet row: no wallet
 * marker and no token address of its own that contradicts the match.
 */
function matchesAddress(node, address) {
  const wanted = address.toLowerCase();
  for (const key of TOKEN_ADDRESS_KEYS) {
    if (headOf(node[key]) === wanted) return true;
  }
  const hasWalletMarker = WALLET_KEYS.some((k) => typeof node[k] === 'string');
  const ownToken = TOKEN_ADDRESS_KEYS.map((k) => headOf(node[k])).find((v) => v !== null);
  // The node names its own token and it is not the wanted one: a different match.
  if (hasWalletMarker || (ownToken && ownToken !== wanted)) return false;
  for (const key of ['address', 'id']) {
    if (headOf(node[key]) === wanted) return true;
  }
  return false;
}

/**
 * Finds a position by token address.
 *
 * The known shape of the FOMO response is
 *
 *   responseObject.balances[].balance.{tokenAddress, balance, shiftedBalance}
 *
 * where `balance` is an integer in minimal units and `shiftedBalance` the
 * human-readable number. Fields are read by name; the tree walk below is only
 * the fallback for a changed schema.
 *
 * @returns {{amount: string, decimals: number|null, symbol: string,
 *            networkId: number|null, tokenId: string|null, human?: boolean,
 *            includeInEquity?: boolean|null}|null}
 */
/** A USD amount from whichever field carries it, or null. */
function usdOf(node) {
  if (!node || typeof node !== 'object') return null;
  for (const key of ['usdValue', 'valueUsd', 'usd', 'value', 'totalUsd', 'balanceUsd']) {
    const n = Number(node[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

export function extractTokenBalance(balances, address) {
  if (!address) return null;
  const wanted = address.toLowerCase();

  const rows = balances?.responseObject?.balances ?? balances?.balances;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const entry = row?.balance;
      if (typeof entry?.tokenAddress !== 'string') continue;
      if (entry.tokenAddress.toLowerCase() !== wanted) continue;

      // Prefer minimal units: the trade amount is computed from them.
      const raw = entry.balance;
      const shifted = entry.shiftedBalance;
      const useRaw = raw !== undefined && raw !== null && raw !== '';
      return {
        amount: String(useRaw ? raw : shifted),
        human: !useRaw,
        // No default of 18: USDC has 6, and a silent 18 turned $12.26 into
        // 1.23e-11. Unknown means null unless the raw/human pair says otherwise.
        decimals: numberOrNull(row?.userToken?.decimals ?? entry.decimals) ?? inferDecimals(raw, shifted),
        symbol: String(row?.userToken?.symbol ?? entry.symbol ?? ''),
        networkId: entry.networkId === undefined ? null : Number(entry.networkId),
        tokenId: entry.tokenId ?? null,
        // Dust filter flag the app uses to decide whether to show the position.
        includeInEquity: row?.valuation?.includeInEquity ?? null,
        // What the holding is worth, if they say. Used to show the order's
        // size in dollars beside its size in tokens, a person reads "$4.62"
        // faster than "2.15 $PONS at $770.6M MC". Tolerant about the name and
        // null when absent: no figure at all beats an invented one.
        usd: usdOf(row?.valuation) ?? usdOf(row) ?? usdOf(entry),
      };
    }
    // The exact path did not match; fall through to the tolerant walk.
  }

  for (const node of walk(balances)) {
    if (!matchesAddress(node, address)) continue;
    const amount = pick(node, AMOUNT_KEYS);
    if (amount === null) continue;

    // Same rule as above: unknown decimals stay null, the caller decides.
    const decimals = numberOrNull(pick(node, DECIMALS_KEYS));
    const networkRaw = pick(node, NETWORK_KEYS);
    const tokenIdRaw = ADDRESS_KEYS
      .map((key) => node[key])
      .find((value) => typeof value === 'string' && value.includes(':'));

    return {
      amount: String(amount),
      decimals,
      symbol: String(pick(node, SYMBOL_KEYS) ?? ''),
      networkId: networkRaw === null ? null : Number(networkRaw),
      tokenId: tokenIdRaw ?? (networkRaw !== null ? `${address}:${networkRaw}` : null),
    };
  }
  return null;
}

/**
 * Wallet addresses from a balances response.
 *
 * FOMO has two: sells leave from the EVM address, buys are paid from the
 * Solana address where the cash lives. In each balance row `address` is the
 * wallet (as opposed to `tokenAddress`), and its format tells the network.
 *
 * @returns {{evm: string|null, solana: string|null}}
 */
export function extractWallets(balances) {
  const rows = balances?.responseObject?.balances ?? balances?.balances;
  const found = { evm: null, solana: null };
  if (!Array.isArray(rows)) return found;

  for (const row of rows) {
    const address = row?.balance?.address;
    if (typeof address !== 'string') continue;
    if (!found.evm && /^0x[0-9a-fA-F]{40}$/.test(address)) found.evm = address;
    else if (!found.solana && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) found.solana = address;
    if (found.evm && found.solana) break;
  }
  return found;
}

/**
 * Whether a value looks like a human-readable amount rather than minimal
 * units. Both occur in the FOMO response; confusing them is a 10^18 error, so
 * the decision is explicit: a decimal point means human.
 */
export function looksHumanAmount(value) {
  return typeof value === 'string' && value.includes('.');
}

/** Human-readable amount to minimal units without loss of digits. */
export function toMinimalUnits(amount, decimals) {
  // The API returns human amounts as numbers; at the edges of the range
  // String() yields exponent notation, which the pattern below rejects.
  const text = typeof amount === 'number' && /e/i.test(String(amount)) && Number.isFinite(amount)
    ? amount.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
    : String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not an amount: "${amount}"`);
  const [whole, fraction = ''] = text.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/**
 * Normalises a balance entry to minimal units.
 *
 * The `human` flag from the parser says exactly which field was taken. The
 * decimal-point heuristic remains only for the fallback path, where a round
 * human number ("9") has no point and would otherwise pass as minimal units.
 */
export function normalizeBalance(entry) {
  if (!entry) return null;
  const raw = entry.amount;
  const isHuman = entry.human ?? looksHumanAmount(raw);
  if (!isHuman) return { ...entry, amount: BigInt(raw) };
  // Converting a human amount without decimals is not "approximately right",
  // it is a multiplication by 10^0 instead of 10^6. The UserOperation is
  // signed over this amount, so the failure has to be loud.
  if (!Number.isFinite(entry.decimals)) {
    throw new Error('token decimals unknown, cannot convert a human-readable amount');
  }
  return { ...entry, amount: toMinimalUnits(raw, entry.decimals) };
}

/**
 * User id from the path of any FOMO request of the form `/v2/users/{uuid}/...`.
 * `GET /user` returns Not Found and is not a source.
 */
export function uuidFromPath(path) {
  const m = String(path ?? '').match(
    /\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
  );
  return m ? m[1] : null;
}
