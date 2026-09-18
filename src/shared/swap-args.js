// The head of the relay proxy's swap call, read the way the contract reads it.
//
// `transferAndMulticall(address[] tokens, uint256[] amounts, Call3Value[]
// calls, address refundTo, address nftRecipient, bytes metadata)` moves the
// tokens with `transferFrom(msg.sender, ...)`, and msg.sender is the wallet.
// So `tokens` and `amounts` are exactly what leaves the wallet, whatever
// allowance happens to stand, and `refundTo` and `nftRecipient` are where
// anything left over would go.
//
// The account contract parses the same four fields in validation and charges
// the per-token budgets from them. This module exists so the browser can say
// in words what the contract would refuse silently, and so the two readings
// can be compared in a test rather than trusted to stay in step.
//
// `calls` is deliberately not parsed. It is an arbitrary list of arbitrary
// calls and nothing useful can be concluded from it; that is why the guard
// measures the wallet afterwards instead.

import { decodeAbiParameters } from 'viem';

const HEAD = [
  { name: 'tokens', type: 'address[]' },
  { name: 'amounts', type: 'uint256[]' },
  { name: 'calls', type: 'tuple[]', components: [
    { name: 'target', type: 'address' },
    { name: 'allowFailure', type: 'bool' },
    { name: 'value', type: 'uint256' },
    { name: 'callData', type: 'bytes' },
  ] },
  { name: 'refundTo', type: 'address' },
  { name: 'nftRecipient', type: 'address' },
  { name: 'metadata', type: 'bytes' },
];

/**
 * @param {string} data the swap call's calldata, selector included
 * @returns {{tokens: string[], amounts: bigint[], refundTo: string, nftRecipient: string}|null}
 *   null when the call does not decode, which for the contract is a refusal
 */
export function parseSwapArgs(data) {
  const hex = String(data ?? '');
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 10 + 6 * 64) return null;
  let decoded;
  try {
    decoded = decodeAbiParameters(HEAD, `0x${hex.slice(10)}`);
  } catch {
    return null;
  }
  const [tokens, amounts, , refundTo, nftRecipient] = decoded;
  if (!Array.isArray(tokens) || !Array.isArray(amounts) || tokens.length !== amounts.length || !tokens.length) return null;
  return {
    tokens: tokens.map((a) => String(a).toLowerCase()),
    amounts: amounts.map((v) => BigInt(v)),
    refundTo: String(refundTo).toLowerCase(),
    nftRecipient: String(nftRecipient).toLowerCase(),
  };
}
