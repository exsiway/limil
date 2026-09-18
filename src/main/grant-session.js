// Issuing the session key grant on chain, as a UserOperation, not a transaction.
//
// `grantSession` must come from the account itself (onlySelfOrEntryPoint), so
// the account would have to pay for it, and the FOMO wallet cannot: native
// value sent to it is wrapped into WETH by the app and nothing is left for gas.
// The way out is the same as for the rest of the automation:
// onlySelfOrEntryPoint admits the EntryPoint. The operation goes as a
// UserOperation, Privy signs it, their bundler sponsors the gas. The wallet
// needs no wei.
//
// This is why the code lives in the extension rather than in scripts/: the
// bundler needs their session headers, which are IP-bound and exist only in an
// open tab.

import { encodeFunctionData } from 'viem';

import { NONCE_KEY } from '../shared/chains.js';
import {
  ACCOUNT_ABI,
  GRANT_SESSION_ABI,
  REVOKE_SESSION_ABI,
  buildUserOp,
  userOpHash,
  userOpToJson,
  userOpTypedDataJson,
} from '../shared/userop.js';
import * as privy from './privy-bridge.js';
import { sendUserOperation, waitForReceipt } from './bundler.js';

/** The grantSession calldata from the worker's plan. */
function encodeGrant({ key, limits, tokenCaps, guard, swap, targets, selectors, feeRecipients }) {
  return encodeFunctionData({
    abi: GRANT_SESSION_ABI,
    functionName: 'grantSession',
    args: [
      key,
      {
        limits: {
          validUntil: BigInt(limits.validUntil),
          maxOps: BigInt(limits.maxOps),
          maxValuePerCall: BigInt(limits.maxValuePerCall ?? 0),
          valueBudget: BigInt(limits.valueBudget ?? 0),
          feeBudget: BigInt(limits.feeBudget ?? 0),
          maxFeePerOp: BigInt(limits.maxFeePerOp ?? 0),
        },
        tokenCaps: (tokenCaps ?? []).map((c) => ({
          token: c.token,
          maxPerOp: BigInt(c.maxPerOp),
          budget: BigInt(c.budget),
          minOutPerUnit: BigInt(c.minOutPerUnit),
        })),
        guard: {
          guard: guard.guard,
          settlementToken: guard.settlementToken,
          depository: guard.depository,
        },
        swap: {
          router: swap.router,
          selector: swap.selector,
        },
        targets,
        selectors,
        feeRecipients: feeRecipients ?? [],
      },
    ],
  });
}

/**
 * Revoking keys on the PREVIOUS contract version, as one owner operation of
 * self-calls: `execute` on the account admits msg.sender == self, and
 * `revokeSession(address)` has the same selector in both versions. Used before
 * a re-delegation: the old contract's storage survives the change of code,
 * and a wallet that ever came back to v1 would find its grants alive.
 */
export function encodeRevokeAll({ sender, keys }) {
  const calls = keys.map((k) => ({
    target: sender,
    value: 0n,
    data: encodeFunctionData({ abi: REVOKE_SESSION_ABI, functionName: 'revokeSession', args: [k] }),
  }));
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'executeBatch', args: [calls] });
}

/**
 * Builds, signs and sends the grant.
 *
 * @param {object} opts
 * @param {string} opts.sender wallet address (the account itself)
 * @param {number} opts.chainId
 * @param {string} opts.key session key address
 * @param {object} opts.limits the Limits struct fields
 * @param {{token: string, maxApprovePerOp: string, approveBudget: string}[]} opts.tokenCaps
 * @param {{guard: string, settlementToken: string, depository: string}} opts.guard the template
 * @param {{router: string, selector: string}} opts.swap the one contract and function the key may sell through
 * @param {string[]} opts.targets parallel array of targets
 * @param {string[]} opts.selectors parallel array of selectors
 * @param {string[]} opts.feeRecipients fee recipient addresses (empty)
 * @param {string[]} [opts.revokeFirst] keys to revoke on the wallet's CURRENT
 *   (previous-version) delegate before the delegation is applied
 * @param {boolean} [opts.send] send it; by default only assemble
 */
export async function grantSessionOnChain({
  sender,
  chainId,
  key,
  limits,
  tokenCaps = [],
  guard,
  swap,
  targets,
  selectors,
  feeRecipients,
  revokeFirst = [],
  revokeOnly = false,
  send = false,
  callBackground,
  authorization = null,
}) {
  const report = { startedAt: new Date().toISOString(), steps: [], sent: false };
  const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); };

  if (targets.length !== selectors.length) {
    throw new Error('targets and selectors must have the same length: they are pairs');
  }
  if (!guard?.guard) throw new Error('the grant names no output guard template');
  if (!swap?.router || !swap?.selector) throw new Error('the grant names no swap router');

  // callData is the grantSession call itself, WITHOUT an execute wrapper. The
  // EntryPoint calls the account with these bytes, msg.sender inside is the
  // EntryPoint, which onlySelfOrEntryPoint admits.
  const callData = encodeGrant({ key, limits, tokenCaps, guard, swap, targets, selectors, feeRecipients });

  /**
   * Assembles, signs and sends one owner operation. Returns the bundler's
   * hash, or throws.
   *
   * The nonce is read right before signing, and the whole step repeats on
   * "AA25 invalid account nonce": that refusal means another operation from
   * this account under our nonce key landed between our read and our send,
   * a second grant from the other browser, a sell of the runner's, and the
   * bundler refused BEFORE anything was sent, so a retry with a fresh nonce
   * is safe. A brief pause lets the node see the other operation first.
   */
  async function attempt(n, { label, data, auth }) {
    const nonce = await callBackground('rpc.getNonce', {
      chainId, sender, key: NONCE_KEY.toString(),
    });
    const userOp = buildUserOp({ sender, nonce: BigInt(nonce), callData: data });
    const hash = userOpHash({ userOp, chainId });
    if (label === 'grant') {
      report.hash = hash;
      report.userOp = userOpToJson(userOp);
    }
    step(`${label} UserOp assembled`, true, { hash, nonce, pairs: targets.length, attempt: n });

    if (!send) {
      report.note = 'dry run: not signed and not sent';
      return null;
    }

    // The OWNER signs through Privy: only the owner can issue a grant, and the
    // session key cannot grant itself, its signature would fail this operation.
    const typedData = userOpTypedDataJson({ userOp, chainId });
    const signature = await privy.signTypedData({ address: sender, typedData });
    if (label === 'grant') {
      report.signature = signature;
      report.userOp = userOpToJson(userOp, signature);
    }
    step(`owner signature through Privy (${label})`, true, {});

    // A 7702 authorization, when given, travels INSIDE this operation: the
    // EntryPoint applies it before validation, so by `grantSession` the account
    // already runs our contract. One sponsored operation does both the
    // delegation and the grant.
    return sendUserOperation({ chainId, userOp, signature, authorization: auth });
  }

  const NONCE_RETRIES = 2;
  async function sendWithRetry(op) {
    for (let n = 1; ; n += 1) {
      try {
        return await attempt(n, op);
      } catch (err) {
        const text = String(err?.message || err);
        if (!/AA25|invalid account nonce/i.test(text) || n > NONCE_RETRIES) throw err;
        step('nonce raced by another operation, retrying with a fresh one', false, { detail: text.slice(0, 160) });
        await new Promise((r) => { setTimeout(r, 4000); });
      }
    }
  }

  // Migration from the previous contract: its keys are revoked on ITS code,
  // in an operation of its own BEFORE the one that carries the authorization
  //, the EntryPoint applies the authorization before validation, and on the
  // new code the old storage is unreachable. A failure here does not stop the
  // grant: the old grants expire on their own and are unreachable meanwhile;
  // the report says so.
  const legacyKeys = [...new Set((revokeFirst ?? []).filter((k) => /^0x[0-9a-fA-F]{40}$/.test(String(k ?? ''))).map((k) => k.toLowerCase()))];
  if (legacyKeys.length && send) {
    try {
      const revokeHash = await sendWithRetry({ label: 'revoke on the previous contract', data: encodeRevokeAll({ sender, keys: legacyKeys }), auth: null });
      const rr = await waitForReceipt({ chainId, userOpHash: revokeHash }).catch(() => null);
      step('previous-version keys revoked', rr?.success !== false, { keys: legacyKeys, userOpHash: revokeHash, success: rr?.success ?? null });
    } catch (err) {
      step('previous-version keys revoked', false, { keys: legacyKeys, error: String(err?.message || err).slice(0, 200) });
    }
  }

  // A round that only retires a key: the previous session key after a
  // rotation, once the new one is granted everywhere. The revoke above is the
  // whole operation and there is no grant to send after it.
  if (revokeOnly) {
    report.sent = legacyKeys.length > 0 && report.steps.some((s) => s.name === 'previous-version keys revoked' && s.ok);
    report.note = report.sent ? 'the previous session key was revoked' : 'the previous session key could not be revoked yet';
    report.finishedAt = new Date().toISOString();
    return report;
  }

  const opHash = await sendWithRetry({ label: 'grant', data: callData, auth: authorization });
  if (opHash === null) return report;
  report.userOpHash = opHash;
  report.sent = true;
  step('sent to the bundler', true, { userOpHash: opHash });

  const receipt = await waitForReceipt({ chainId, userOpHash: opHash });
  report.receipt = {
    success: receipt?.success ?? null,
    transactionHash: receipt?.receipt?.transactionHash ?? null,
  };
  step('receipt', Boolean(receipt?.success), report.receipt);
  report.finishedAt = new Date().toISOString();
  return report;
}
