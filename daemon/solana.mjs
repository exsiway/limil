// A Solana JSON-RPC relay for the runner browser.
//
// The public Solana nodes refuse a request that carries a browser Origin:
// `api.mainnet-beta.solana.com` answers 403 "Access forbidden" to any Origin
// header at all, and the extension cannot leave it off, while the same
// request without an Origin is answered. So the
// browser asks THIS process, which asks the node as a plain client. The
// runner is authenticated like on every other /v1/runner route, and only
// read/submit methods a wallet needs are relayed: this is not an open proxy.
const NODES = Object.freeze([
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
]);
const ALLOWED = new Set([
  'getLatestBlockhash', 'getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountsByOwner',
  'getTokenAccountBalance', 'getSignatureStatuses', 'getTransaction', 'sendTransaction', 'simulateTransaction',
  'getRecentPrioritizationFees', 'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'getSlot', 'getBlockHeight',
  'isBlockhashValid', 'getEpochInfo', 'getVersion', 'getHealth',
]);
const TIMEOUT_MS = 8000;

export function makeSolanaRelay({ nodes = NODES, fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  async function ask(url, method, params) {
    const host = new URL(url).host;
    const res = await fetchFn(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`${host}: ${json.error.message ?? JSON.stringify(json.error)}`);
    return json.result;
  }
  /** `{ result }` from the first node that answers, or `{ error }` naming every refusal. */
  async function relay({ method, params = [] } = {}) {
    if (typeof method !== 'string' || !ALLOWED.has(method)) return { error: `method not relayed: ${String(method).slice(0, 40)}` };
    const errors = [];
    for (const url of nodes) {
      try { return { result: await ask(url, method, Array.isArray(params) ? params : []) }; }
      catch (err) { errors.push(String(err?.message || err)); }
    }
    return { error: `Solana nodes did not answer: ${errors.join('; ')}` };
  }
  return { relay, allowed: ALLOWED };
}
