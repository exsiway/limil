// Chain reads for the service worker.
//
// A separate module because index.js imports runner.js and the runner needs
// the same eth_call to read the issued grant; importing back into index.js
// would close a cycle.

import { rpcUrl } from '../shared/chains.js';

/**
 * Code at an address. Tells what the wallet is delegated to: an EIP-7702
 * account's code is the `0xef0100` marker followed by the delegate address.
 */
export async function ethGetCode(chainId, address) {
  const res = await fetch(rpcUrl(chainId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`RPC ${chainId}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${chainId}: ${json.error.message}`);
  return json.result;
}

export async function ethCall(chainId, { to, data }) {
  const res = await fetch(rpcUrl(chainId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`RPC ${chainId}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${chainId}: ${json.error.message}`);
  return json.result;
}
