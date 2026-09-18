// Disconnecting limil: return the wallet to FOMO's contract and revoke the keys.
//
// Connection happens on its own and silently, so the reverse must exist too;
// otherwise "reversible" in the interface would be an empty word. It is also
// the migration path: contract code is immutable, and if a flaw is ever found
// this is the only way to move people to a fixed one.
//
// Two operations, not one. The EntryPoint applies the 7702 authorization
// BEFORE validation, so in the operation that returns the delegate to
// Simple7702Account the account is no longer our contract and the revoke
// functions do not exist. Hence the order: revoke on our code first, then return.
//
// The order is chosen by the cost of a mistake. Revoke succeeded, return
// failed: the wallet stays with us but the keys are dead, safe and repeatable.
// The other way round: the wallet is FOMO's and our key records lie unreachable
// in its storage. Neither is dangerous, the first is cleaner.

import { encodeFunctionData } from 'viem';

import { NONCE_KEY, SIMPLE_7702_ACCOUNT, isLegacyDelegate } from '../shared/chains.js';
import { delegateFromCode } from '../shared/authorization.js';
import {
  ACCOUNT_ABI,
  REVOKE_SESSIONS_ABI,
  buildUserOp,
  userOpHash,
  userOpToJson,
  userOpTypedDataJson,
} from '../shared/userop.js';
import { signAuthorization } from './authorization.js';
import { encodeRevokeAll } from './grant-session.js';
import * as privy from './privy-bridge.js';
import { sendUserOperation, waitForReceipt } from './bundler.js';

/** Builds, signs and sends one operation on behalf of the owner. */
async function sendOwnerOp({ sender, chainId, callData, authorization, callBackground }) {
  const nonce = await callBackground('rpc.getNonce', {
    chainId, sender, key: NONCE_KEY.toString(),
  });
  const userOp = buildUserOp({ sender, nonce: BigInt(nonce), callData });
  const typedData = userOpTypedDataJson({ userOp, chainId });
  const signature = await privy.signTypedData({ address: sender, typedData });
  const opHash = await sendUserOperation({ chainId, userOp, signature, authorization });
  const receipt = await waitForReceipt({ chainId, userOpHash: opHash }).catch(() => null);
  return {
    hash: userOpHash({ userOp, chainId }),
    userOpHash: opHash,
    userOp: userOpToJson(userOp, signature),
    success: receipt?.success ?? null,
    transactionHash: receipt?.receipt?.transactionHash ?? null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.sender the wallet
 * @param {number} opts.chainId
 * @param {string|null} opts.key session key address; null means nothing to revoke
 * @param {string[]|null} opts.keys every other key the wallet granted (hub, runner browser)
 * @param {(t:string,p?:any)=>Promise<any>} opts.callBackground
 */
export async function disconnectAccount({ sender, chainId, key = null, keys = null, callBackground }) {
  const report = { startedAt: new Date().toISOString(), steps: [], done: false };
  const step = (name, ok, detail) => report.steps.push({ name, ok, detail });

  // Which of our contracts the wallet runs decides HOW the keys are revoked:
  // version 2 revokes them all in one call, version 1 has no such call and
  // gets one owner batch of self-calls to revokeSession. Both are one
  // operation, one signature.
  let delegate = null;
  try {
    delegate = delegateFromCode(await callBackground('rpc.getCode', { chainId, address: sender }));
  } catch (err) {
    step('delegate read', false, { error: String(err?.message || err) });
  }
  const legacy = isLegacyDelegate(delegate);

  // 1. Revoke EVERY key this wallet granted: the extension's own, the hub's,
  //    the runner browser's. Returning the delegate alone does not wipe the
  //    old contract's storage, a later re-delegation, before the grants
  //    expire, would find them intact. A failure does not stop us: the person
  //    asked to disconnect, and returning the delegate achieves that on its
  //    own. The refusal stays in the report.
  const all = [...new Set([...(Array.isArray(keys) ? keys : []), key].filter((k) => /^0x[0-9a-fA-F]{40}$/.test(String(k ?? ''))).map((k) => k.toLowerCase()))];
  if (!all.length) step('session keys revoked', true, { note: 'there was no key, nothing to revoke' });
  else {
    try {
      const callData = legacy
        ? encodeRevokeAll({ sender, keys: all })
        : encodeFunctionData({ abi: REVOKE_SESSIONS_ABI, functionName: 'revokeSessions', args: [all] });
      const res = await sendOwnerOp({ sender, chainId, callData, callBackground });
      step('session keys revoked', res.success !== false, { keys: all, contract: legacy ? 'v1' : 'v2', ...res });
    } catch (err) {
      step('session keys revoked', false, { keys: all, error: String(err?.message || err) });
    }
  }

  // 2. Return the delegate. The operation body is an EMPTY batch: there is
  //    nothing else to do, the operation only carries the authorization. The
  //    empty batch executes on FOMO's code and does nothing.
  const signed = await signAuthorization({
    sender,
    chainId,
    delegate: SIMPLE_7702_ACCOUNT,
    // A LIVE authorization: it changes the account code back. Consent is the
    // person's click on Disconnect.
    allowLive: true,
    callBackground,
  });
  step('return authorization signed', true, { delegate: SIMPLE_7702_ACCOUNT });

  const back = await sendOwnerOp({
    sender,
    chainId,
    callData: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'executeBatch', args: [[]] }),
    authorization: signed.authorizationRpc,
    callBackground,
  });
  step('delegate returned to the FOMO contract', back.success !== false, back);

  // The last word is the chain's, not the receipt's: read the code and see who
  // the delegate really is now.
  const code = await callBackground('rpc.getCode', { chainId, address: sender });
  const now = typeof code === 'string' && code.startsWith('0xef0100')
    ? `0x${code.slice(8, 48)}`.toLowerCase()
    : null;
  report.delegateNow = now;
  report.done = now === SIMPLE_7702_ACCOUNT.toLowerCase();
  step('verified on chain', report.done, { delegate: now });
  return report;
}
