// Preparing a trade on the native path: quote -> tolerance check -> our
// executeBatch -> signature.
//
// Signing and sending are SEPARATE flags on purpose. A signature moves
// nothing; a send spends real funds. Both are off by default: `sign` yields a
// signed UserOperation, `send` hands it to their bundler.

import { NONCE_KEY, SOLANA_NETWORK_ID } from '../shared/chains.js';
import {
  buildUserOp,
  encodeExecuteBatch,
  userOpHash,
  userOpToJson,
  userOpTypedDataJson,
} from '../shared/userop.js';
import {
  buildSwapCalls,
  checkSlippageScaled,
  describeRoute,
  parseSwapQuote,
} from '../shared/swaps.js';
import * as fomo from './fomo-bridge.js';
import * as privy from './privy-bridge.js';
import { estimateGas, sendUserOperation, waitForReceipt } from './bundler.js';
import { GUARD_ADDRESS, GUARD_CASH, guardCalls, guardFloor, guardSupported, looksLikeGuardRevert } from '../shared/output-guard.js';
import { executeBuy } from './solana-exec.js';

/**
 * Assembles a trade and, when the tolerance allows, signs it.
 *
 * @param {object} opts
 * @param {string} opts.sender          FOMO wallet address
 * @param {string} opts.inTokenId       "<address>:<networkId>"
 * @param {string} opts.outTokenId      "<address>:<networkId>"
 * @param {string} opts.amount          in minimal units of the input token
 * @param {string} opts.targetOutScaled output target (QUOTE_SCALE)
 * @param {number} opts.maxSlippageBps  the user's tolerance on top of relay's
 * @param {boolean} [opts.sign]         sign (default no)
 */
export async function prepareSwap({
  sender,
  inTokenId,
  outTokenId,
  amount,
  /**
   * The order target in QUOTE_SCALE, exactly as stored. The scale is in the
   * name: a bare `targetOut` was once taken for a human-readable string and
   * the two sides of the comparison differed by 1e18 without notice.
   */
  targetOutScaled = null,
  maxSlippageBps = null,
  /** Side and Solana wallet: a buy takes another path (solana-exec). */
  side = 'sell',
  solanaAddress = null,
  sign = false,
  /** Send to the bundler. Separate from `sign`: they must not share one switch. */
  send = false,
  /**
   * Who signs. Unset means Privy, i.e. a person with the page open. The
   * runner passes the session key here.
   */
  signer = null,
  /**
   * How long to wait for the receipt after sending. The runner would rather
   * get `sent: true` inside its window than wait for the receipt: it checks
   * the balance itself.
   */
  receiptTimeoutMs = 120_000,
  callBackground,
  /** The order this is for, so the Solana path can mark its attempt as sent. */
  orderId = null,
}) {
  const report = { startedAt: new Date().toISOString(), steps: [], signed: false };
  const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); };

  const swapAmount = BigInt(amount);
  const isBuy = side === 'buy';

  // 1. Quote. Requested ONCE, at the target: their API is behind Cloudflare
  //    and frequent polling gets 429.
  const raw = await fomo.requestQuote({ inTokenId, outTokenId, amount: swapAmount.toString() });
  const quote = parseSwapQuote(raw);
  report.quote = {
    kind: quote.kind,
    relaySwapId: quote.relaySwapId,
    chainId: quote.chainId,
    expectedOut: quote.expectedOut,
    relaySlippageBps: quote.slippageBps,
    feeTierBps: quote.feeTierBps,
    usdFees: quote.usdFees,
  };
  step('quote received', true, report.quote);

  if (!quote.canExecute) {
    step('execution route', false, { route: quote.route });
    report.blocked = `${describeRoute(quote.route)}. This path does not apply here.`;
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // 2. Slippage. Relay sets its own tolerance (600-732 bps in observed
  //    trades). It cannot be narrowed, but a bad quote can be refused. With no
  //    tolerance of the user's own there is nothing to check, and the report
  //    says so instead of substituting some "reasonable" number silently.
  if (maxSlippageBps === null || maxSlippageBps === undefined) {
    report.slippage = {
      ok: true,
      userCap: null,
      relaySlippageBps: quote.slippageBps,
      reason: 'no tolerance of your own, relay\'s slippage applies',
    };
    step('slippage check', true, report.slippage);
  } else if (targetOutScaled === null || targetOutScaled === undefined) {
    // A tolerance without a target has nothing to compare against.
    report.slippage = {
      ok: true,
      userCap: maxSlippageBps,
      relaySlippageBps: quote.slippageBps,
      applied: false,
      reason: `tolerance ${maxSlippageBps} bps is set but no target was passed, `
        + 'nothing to compare against, the tolerance is NOT applied',
    };
    step('slippage check', true, report.slippage);
  } else {
    const slippage = checkSlippageScaled({
      expectedOut: quote.expectedOut,
      targetOutScaled,
      maxSlippageBps,
      relaySlippageBps: quote.slippageBps,
    });
    report.slippage = slippage;
    step('slippage check', slippage.ok, slippage);
    if (!slippage.ok) {
      report.blocked = slippage.reason;
      return report;
    }
  }

  // 3a. A trade on Solana (a buy, or a sell of a Solana token): the
  //     transaction from relay or dflow, a Privy signature, Jito.
  if (quote.kind === 'SOLANA') {
    if (!sign) {
      report.note = 'dry run: quote received, no signature requested';
      report.finishedAt = new Date().toISOString();
      return report;
    }
    // Mints for the guard: what may leave and what should arrive. The output
    // is a Solana mint only when the order settles on Solana; a buy of an EVM
    // token through relay arrives on the other chain and is not checked here.
    const mintOf = (tokenId) => String(tokenId ?? '').split(':')[0] || null;
    const networkOf = (tokenId) => Number(String(tokenId ?? '').split(':')[1] ?? 0);
    await executeBuy({
      quote, sender, solanaAddress, amount, send, report, step, callBackground, orderId,
      inMint: mintOf(inTokenId),
      outMint: networkOf(outTokenId) === SOLANA_NETWORK_ID ? mintOf(outTokenId) : null,
      side: isBuy ? 'buy' : 'sell',
    });
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // 3b. Our executeBatch. The inner calls are theirs, byte for byte: only then
  //     does the indexer keep counting the trade as a swap of the app.
  //
  // Output guard. Relay's tolerance is about 10% below the quote, and pools
  // taking 8–14% on top fit inside it. Our bound stands in the batch itself:
  // the relay depository must gain at least target × (1 − slippage), or the
  // whole batch reverts. Without a target or slippage there is no bound, and
  // the report says so.
  let guard = null;
  const wantsGuard = maxSlippageBps !== null && maxSlippageBps !== undefined
    && targetOutScaled !== null && targetOutScaled !== undefined;
  if (wantsGuard && !guardSupported(quote.chainId)) {
    // Slippage is set but cannot be enforced on this chain. Sending without
    // the guard would silently replace the user's bound with relay's.
    report.guard = { applied: false, blocked: false, reason: `the guard is not described for chain ${quote.chainId}` };
    report.blocked = `slippage ${maxSlippageBps} bps is set, but the output guard is not described for chain ${quote.chainId}, not sending without it`;
    step('output guard', false, report.guard);
    report.finishedAt = new Date().toISOString();
    return report;
  }
  if (wantsGuard) {
    // The contract must EXIST: a call to an address without code passes
    // silently, and the batch would look guarded while guarding nothing.
    const code = await callBackground('rpc.getCode', { chainId: quote.chainId, address: GUARD_ADDRESS });
    if (!code || code === '0x') {
      report.guard = { applied: false, blocked: false, reason: `the guard is not deployed on chain ${quote.chainId}` };
      report.blocked = `the output guard is not deployed on chain ${quote.chainId} (${GUARD_ADDRESS}), not sending without it`;
      step('output guard', false, report.guard);
      report.finishedAt = new Date().toISOString();
      return report;
    }
    const floor = guardFloor({
      targetOutScaled, maxSlippageBps, usdFees: quote.usdFees, decimals: GUARD_CASH[quote.chainId].decimals,
    });
    guard = guardCalls({ chainId: quote.chainId, minGain: floor.floor });
    report.guard = {
      applied: true, minGain: floor.floor.toString(), afterSlippage: floor.afterSlippage.toString(),
      quoteFeesUnits: floor.quoteFeesUnits.toString(), symbol: GUARD_CASH[quote.chainId].symbol,
    };
  } else {
    report.guard = { applied: false, reason: 'no target or slippage, no bound' };
  }
  step('output guard', Boolean(guard), report.guard);

  // The input token travels with the quote so the batch can zero the router's
  // allowance even when relay sent no approval because one already stood.
  const calls = buildSwapCalls(quote, guard, { token: String(inTokenId).split(':')[0] });
  step('batch assembled', true, { calls: calls.length, guarded: Boolean(guard) });

  const nonce = await callBackground('rpc.getNonce', {
    chainId: quote.chainId,
    sender,
    key: NONCE_KEY.toString(),
  });
  const callData = encodeExecuteBatch(calls);
  const userOp = buildUserOp({
    sender,
    nonce: BigInt(nonce),
    callData,
  });
  const hash = userOpHash({ userOp, chainId: quote.chainId });
  report.hash = hash;
  report.userOp = userOpToJson(userOp);
  step('UserOp assembled', true, { hash, nonce });

  if (!sign) {
    report.note = 'dry run: no signature requested';
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // 4. Signature. The signer is injected: for a person it is Privy with typed
  //    data, for the runner the session key signing a raw hash. Both are
  //    verified by the same ecrecover in the contract.
  const typedData = userOpTypedDataJson({ userOp, chainId: quote.chainId });
  const signature = signer
    // The signer receives the operation itself: the session key must
    // recompute the hash, or it signs what it is told rather than what is sent.
    ? await signer({
      hash, typedData, sender, chainId: quote.chainId, userOp: userOpToJson(userOp),
    })
    : await privy.signTypedData({ address: sender, typedData });
  if (!signature) throw new Error('the signer returned an empty signature');
  report.signature = signature;
  report.userOp = userOpToJson(userOp, signature);
  report.signed = true;
  report.signedBy = signer ? 'session key' : 'Privy';
  step(`signature: ${report.signedBy}`, true, { signature });

  if (!send) {
    report.note = 'signed but NOT sent, sending is a separate decision';
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // 4½. Simulation BEFORE sending. The bundler runs the operation; if the
  //     guard reverts it there, nothing is sent: the user loses nothing, no
  //     gas is paid, the order stays live. Other complaints do not block.
  if (guard) {
    try {
      await estimateGas({ chainId: quote.chainId, userOp, signature });
      step('bundler simulation', true, null);
    } catch (err) {
      const text = String(err?.message || err);
      if (looksLikeGuardRevert(text)) {
        report.guard = { ...report.guard, blocked: true, detail: text.slice(0, 300) };
        report.blocked = `output guard: the trade would give less than the floor ${report.guard.minGain}, not sending, waiting for another route`;
        step('bundler simulation', false, { guard: true, detail: text.slice(0, 200) });
        report.finishedAt = new Date().toISOString();
        return report;
      }
      step('bundler simulation', false, { note: 'not a guard complaint, sending anyway', detail: text.slice(0, 200) });
    }
  }

  // The input token's balance before the send: the chain's own record of
  // whether the sale happened, for when the bundler's receipt does not come.
  const inToken = String(inTokenId ?? '').split(':')[0];
  let balanceBefore = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(inToken) && isAddress(sender)) {
    try { balanceBefore = BigInt(await callBackground('rpc.tokenBalance', { chainId: quote.chainId, token: inToken, owner: sender })); } catch { balanceBefore = null; }
  }

  // 5. Send. THIS SPENDS FUNDS. Goes to THEIR bundler by the same method as
  //    their front end.
  const opHash = await sendUserOperation({ chainId: quote.chainId, userOp, signature });
  report.userOpHash = opHash;
  report.sent = true;
  step('sent to the bundler', true, { userOpHash: opHash });

  // Waiting for the receipt must not undo the send. A failure thrown here
  // would take the whole report with it, `sent: true` included: the operation
  // WITH THE BUNDLER while the round recorded `failed` and kept the order
  // watched, i.e. fired on the same position a second time after the cooldown.
  let receipt = null;
  try {
    receipt = await waitForReceipt({ chainId: quote.chainId, userOpHash: opHash, timeoutMs: receiptTimeoutMs });
  } catch (err) {
    report.receiptError = String(err?.message || err);
    step('receipt received', false, { error: report.receiptError });
  }
  if (receipt) {
    report.receipt = {
      success: receipt?.success ?? null,
      actualGasCost: receipt?.actualGasCost ?? null,
      transactionHash: receipt?.receipt?.transactionHash ?? null,
    };
    step('receipt received', Boolean(receipt?.success), report.receipt);
  }

  if (!receipt) {
    // The bundler said nothing usable: the chain decides. The input token's
    // balance going down by the order amount, or at all, is the sale.
    const moved = await balanceMoved({ chainId: quote.chainId, token: inToken, owner: sender, before: balanceBefore, callBackground, step });
    if (moved.confirmed) {
      report.receipt = { success: true, status: `confirmed by balance: ${moved.detail}`, transactionHash: null };
      report.note = `executed, confirmed by the chain (${moved.detail}), operation ${opHash}. Check in the app that the trade shows in positions and PnL`;
    } else {
      // NOT `false`. False means "reverted, position intact" to the runner,
      // and this is the case where nobody knows: no receipt came and the
      // balance did not visibly move, while the operation is with the
      // bundler. Reported as unknown, the order leaves the watch list instead
      // of waiting to be sent a second time.
      report.receipt = { success: null, status: `no receipt and ${moved.detail}` };
      report.note = `sent (${opHash}), but no receipt arrived (${report.receiptError}) and ${moved.detail}. `
        + 'The operation is with the bundler, it cannot be treated as unsent. Check the position in the app.';
    }
    report.finishedAt = new Date().toISOString();
    return report;
  }

  report.note = receipt?.success
    ? 'executed. Check in the app that the trade shows in positions and PnL'
    : 'the bundler returned an unsuccessful receipt, see receipt';
  report.finishedAt = new Date().toISOString();
  return report;
}

/** An EVM address, checksum or not. */
const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v ?? ''));

/** How long the chain is watched for the input token's balance to move. */
const BALANCE_WATCH_MS = 60_000;
const BALANCE_EVERY_MS = 5000;

/**
 * Whether the input token left the wallet, read from the chain.
 *
 * @returns {Promise<{confirmed: boolean, detail: string}>}
 */
async function balanceMoved({ chainId, token, owner, before, callBackground, step }) {
  if (before === null || !/^0x[0-9a-fA-F]{40}$/.test(String(token ?? '')) || !isAddress(owner)) {
    return { confirmed: false, detail: 'the balance before the send is unknown' };
  }
  const deadline = Date.now() + BALANCE_WATCH_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const now = BigInt(await callBackground('rpc.tokenBalance', { chainId, token, owner }));
      last = now;
      if (now < before) {
        step('balance moved', true, { before: before.toString(), after: now.toString() });
        return { confirmed: true, detail: `balance ${before} → ${now}` };
      }
    } catch { /* the node did not answer this time */ }
    await new Promise((resolve) => { setTimeout(resolve, BALANCE_EVERY_MS); });
  }
  step('balance unchanged', false, { before: before.toString(), after: last === null ? null : last.toString() });
  return { confirmed: false, detail: last === null ? 'the chain did not answer' : `the balance did not move (${before})` };
}
