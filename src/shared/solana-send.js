// The pure part of sending a Solana trade: what goes where.
//
//   POST mainnet.hudson.jito.wtf/api/v1/sendTransactionWeb?mev_protection_default=true
//        body is the base64 of the signed transaction as text; success is 200 with an empty body
//   POST api.relay.link/transactions/index {chainId: 792703809, requestId, txHash}
//   GET  /swaps/v2/status?relaySwapId=…  → {responseObject: {status: "SUCCESS"}}
//
// The relay transaction arrives with the FOMO fee payer's signature already in
// slot 0 and an empty user slot; the fee payer's signature is duplicated in a
// separate field.

import { SOLANA_RELAY_CHAIN_ID } from './chains.js';
import {
  base64ToBytes, bytesToBase64, missingSigners, parseTransaction, serializeTransaction,
  transactionSignature, withSignature,
} from './solana-tx.js';

export const JITO_SEND_URL = 'https://mainnet.hudson.jito.wtf/api/v1/sendTransactionWeb?mev_protection_default=true';
export const RELAY_INDEX_URL = 'https://api.relay.link/transactions/index';

/**
 * Parses the transaction from a quote and places the fee payer's signature if
 * it came separately. Returns the parsed transaction and the message for Privy.
 */
export function prepareForSigning({ tx, feePayerAddress = null, feePayerSignature = null }) {
  let parsed = parseTransaction(base64ToBytes(tx));
  if (feePayerAddress && feePayerSignature) {
    parsed = withSignature(parsed, feePayerAddress, feePayerSignature);
  }
  return { parsed, messageBase64: bytesToBase64(parsed.message) };
}

/** Who still has to sign: on a buy exactly one address, the user. */
export function userSignerOf(parsed, known = null) {
  const missing = missingSigners(parsed);
  if (known && missing.includes(known)) return known;
  if (missing.length === 1) return missing[0];
  if (!missing.length) throw new Error('the transaction is already fully signed, nothing to sign');
  throw new Error(`signatures are missing from several addresses (${missing.join(', ')}), not what a buy looks like`);
}

/** Places the user's signature and returns what goes to Jito plus the hash. */
export function finalize(parsed, userAddress, userSignatureBase64) {
  const signed = withSignature(parsed, userAddress, userSignatureBase64);
  const left = missingSigners(signed);
  if (left.length) throw new Error(`signatures still missing: ${left.join(', ')}`);
  return { base64: bytesToBase64(serializeTransaction(signed)), txHash: transactionSignature(signed) };
}

export function relayIndexBody({ relaySwapId, txHash }) {
  return { chainId: SOLANA_RELAY_CHAIN_ID, requestId: relaySwapId, txHash };
}

export function swapStatusPath(relaySwapId) {
  return `/swaps/v2/status?relaySwapId=${encodeURIComponent(relaySwapId)}`;
}

/** Status from a /swaps/v2/status answer. */
/**
 * What the node says about a sent transaction, as one word.
 *
 * `getSignatureStatuses` answers null for a signature the node has not seen
 * (not yet, or never: dropped before the blockhash expired), an entry with
 * `err` for one that landed and failed, and an entry with a confirmation
 * status for one that landed. `blockHeight` is the node's current height and
 * `lastValidBlockHeight` the transaction's: past it an unseen signature is
 * not coming.
 *
 * @returns {'pending'|'landed'|'failed'|'expired'}
 */
export function judgeSignatureStatus(entry, { blockHeight = null, lastValidBlockHeight = null } = {}) {
  if (entry && typeof entry === 'object') {
    if (entry.err) return 'failed';
    const status = entry.confirmationStatus ?? (entry.confirmations === null ? 'finalized' : null);
    if (status === 'confirmed' || status === 'finalized') return 'landed';
    return 'pending';
  }
  if (Number.isFinite(blockHeight) && Number.isFinite(lastValidBlockHeight) && blockHeight > lastValidBlockHeight) return 'expired';
  return 'pending';
}

export function readSwapStatus(json) {
  return String(json?.responseObject?.status ?? json?.status ?? '').toUpperCase() || null;
}
