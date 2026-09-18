// EIP-7702 authorization: hash, signature parsing and the tuple that goes
// into a type-4 transaction or a bundler request.
//
// Privy has no dedicated method for signing an authorization, but it exposes
// `secp256k1_sign`, which signs an arbitrary 32-byte hash without a prefix.
// The hash is therefore computed here and the provider only signs it.
//
// Pure functions: no DOM, no network.

import { concatHex, keccak256, parseSignature, toRlp } from 'viem';

/** Domain separator byte that distinguishes an authorization from any other signed payload. */
export const AUTHORIZATION_MAGIC = '0x05';

/** Minimal RLP integer encoding: zero is the empty string. */
export function rlpUint(value) {
  const big = BigInt(value);
  if (big === 0n) return '0x';
  const hex = big.toString(16);
  return `0x${hex.length % 2 ? '0' : ''}${hex}`;
}

/** keccak(0x05 || rlp([chainId, address, nonce])), what the owner signs. */
export function authorizationHash({ chainId, address, nonce }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) {
    throw new Error(`delegate address does not parse: "${address}"`);
  }
  return keccak256(concatHex([
    AUTHORIZATION_MAGIC,
    toRlp([rlpUint(chainId), address.toLowerCase(), rlpUint(nonce)]),
  ]));
}

/** Current delegate of an account whose code is `0xef0100<address>`. */
export function delegateFromCode(code) {
  if (typeof code !== 'string' || !code.startsWith('0xef0100')) return null;
  return `0x${code.slice(8, 48)}`;
}

/**
 * The authorization tuple as hex strings, the way the bundler JSON-RPC expects
 * it. A type-4 transaction (viem) wants numbers; both forms live here so the
 * same authorization is not accepted in one place and rejected in another.
 */
export function toAuthorizationRpc(tuple) {
  const hex = (v) => `0x${BigInt(v).toString(16)}`;
  return {
    chainId: hex(tuple.chainId),
    address: tuple.address,
    nonce: hex(tuple.nonce),
    yParity: hex(tuple.yParity),
    r: tuple.r,
    s: tuple.s,
  };
}

/**
 * Signature to the tuple shape of a type-4 transaction.
 *
 * `yParity` is 0 or 1, not 27/28: the authorization list carries the parity,
 * and a stray 27 makes the authorization silently invalid.
 */
export function toAuthorizationTuple({ chainId, address, nonce, signature }) {
  const { r, s, yParity, v } = parseSignature(signature);
  const parity = yParity ?? (v === undefined ? undefined : Number(v) - 27);
  if (parity !== 0 && parity !== 1) {
    throw new Error(`unexpected signature parity: ${parity}`);
  }
  return {
    chainId: Number(chainId),
    address: address.toLowerCase(),
    nonce: BigInt(nonce).toString(),
    yParity: parity,
    r,
    s,
  };
}

/**
 * Whether an authorization is inert, i.e. applying it changes nothing.
 *
 * Two reasons: the delegate equals the current one (a no-op) or the nonce is
 * stale (cannot be applied at all).
 */
export function isInertAuthorization({ address, nonce, currentDelegate, currentNonce }) {
  const sameDelegate = Boolean(currentDelegate)
    && address.toLowerCase() === currentDelegate.toLowerCase();
  const staleNonce = BigInt(nonce) < BigInt(currentNonce);
  return { inert: sameDelegate || staleNonce, sameDelegate, staleNonce };
}
