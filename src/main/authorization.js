// Signing an EIP-7702 authorization through the Privy provider.
//
// Privy has no dedicated method, but `secp256k1_sign` signs an arbitrary
// 32-byte hash without a prefix. The authorization hash is computed here and
// the provider signs the 32 bytes without knowing what they are.
//
// THIS MODULE SENDS NOTHING. It returns a signed tuple; sending it is a
// separate and deliberate decision, because an applied authorization changes
// the CODE of the wallet.

import { recoverAddress } from 'viem';
import {
  authorizationHash,
  delegateFromCode,
  isInertAuthorization,
  toAuthorizationRpc,
  toAuthorizationTuple,
} from '../shared/authorization.js';
import * as privy from './privy-bridge.js';

/** The raw signing method exposed by the Privy iframe. */
const RAW_SIGN_METHOD = 'secp256k1_sign';

/**
 * Builds and signs an authorization.
 *
 * @param {object} opts
 * @param {string} opts.sender    the wallet that delegates
 * @param {number} opts.chainId
 * @param {string} opts.delegate  the address to delegate to
 * @param {bigint|string} [opts.nonce] defaults to the account's current nonce
 * @param {(t:string,p?:any)=>Promise<any>} opts.callBackground
 * @param {boolean} [opts.allowLive] sign a NON-inert authorization, one that
 *   really changes the delegate. Without this flag such a one is refused.
 */
export async function signAuthorization({
  sender,
  chainId,
  delegate,
  nonce,
  callBackground,
  allowLive = false,
}) {
  const code = await callBackground('rpc.getCode', { chainId, address: sender });
  const currentDelegate = delegateFromCode(code);
  const currentNonce = BigInt(
    await callBackground('rpc.getTransactionCount', { chainId, address: sender }),
  );
  const useNonce = nonce === undefined ? currentNonce : BigInt(nonce);

  const inertness = isInertAuthorization({
    address: delegate,
    nonce: useNonce,
    currentDelegate,
    currentNonce,
  });
  if (!inertness.inert && !allowLive) {
    throw new Error(
      'this authorization would REALLY change the wallet delegate. It is signed only with '
      + 'explicit consent (allowLive), because it changes the account code.',
    );
  }

  const hash = authorizationHash({ chainId, address: delegate, nonce: useNonce });
  const signature = await privy.requestViaPrivy({
    method: RAW_SIGN_METHOD,
    params: [hash],
    timeoutMs: 60_000,
    // The envelope must belong to the wallet being delegated: with a foreign
    // one Privy refuses naming the foreign address.
    expectSender: sender,
  });

  // Verified BEFORE it is handed out: an authorization signed by the wrong
  // key or over the wrong hash would burn gas at best and delegate to the
  // wrong place at worst.
  const recovered = await recoverAddress({ hash, signature });
  if (recovered.toLowerCase() !== sender.toLowerCase()) {
    throw new Error(
      `the signature does not recover to the wallet: got ${recovered}, expected ${sender}`,
    );
  }

  return {
    hash,
    signature,
    recovered,
    inert: inertness.inert,
    reason: inertness.sameDelegate ? 'the delegate does not change'
      : inertness.staleNonce ? 'stale nonce, cannot be applied'
        : 'LIVE authorization: applying it changes the wallet code',
    currentDelegate,
    currentNonce: currentNonce.toString(),
    authorization: toAuthorizationTuple({
      chainId, address: delegate, nonce: useNonce, signature,
    }),
    // The same authorization as hex: the bundler takes it inside a
    // UserOperation in this form, a type-4 transaction takes numbers.
    authorizationRpc: toAuthorizationRpc(toAuthorizationTuple({
      chainId, address: delegate, nonce: useNonce, signature,
    })),
  };
}
