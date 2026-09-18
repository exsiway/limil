// A Solana trade: the transaction from relay or dflow, a look inside it, the
// user's signature through Privy, Jito, registration with relay, status.
//
// Same order as their front end, with one step of our own before the
// signature: shared/solana-guard.js decodes the transaction and simulates it,
// and Privy is asked to sign only what leaves the wallet no poorer than the
// order allows. Everything after Jito's answer is marked "AFTER SEND": the
// transaction is already on the network, and the runner has to take the order
// off watch rather than try again.

import * as fomo from './fomo-bridge.js';
import * as privy from './privy-bridge.js';
import { judgeSignatureStatus } from '../shared/solana-send.js';
import { ROUTES } from '../shared/swaps.js';
import {
  JITO_SEND_URL, RELAY_INDEX_URL, finalize, prepareForSigning, readSwapStatus, relayIndexBody, swapStatusPath,
  userSignerOf,
} from '../shared/solana-send.js';
import { guardSolanaTransaction } from '../shared/solana-guard.js';

const afterSend = (err) => {
  const e = new Error(`AFTER SEND: ${String(err?.message || err)}`);
  e.afterSend = true;
  return e;
};

/**
 * A trade on Solana: a buy (USDC → token) or a sell of a Solana token
 * (token → USDC). One path: relay or dflow builds the transaction, the guard
 * reads it, Privy signs it with the same envelope as for EVM, we send it to Jito.
 *
 * @param {object} o
 * @param {object} o.quote        parsed quote (parseSwapQuote), kind SOLANA
 * @param {string} o.sender       EVM address of the FOMO wallet, the Privy envelope belongs to it
 * @param {string|null} o.solanaAddress the user's Solana wallet, when known
 * @param {bigint|string} o.amount amount in the input mint's units
 * @param {string} o.inMint       the mint that leaves the wallet
 * @param {string|null} o.outMint the mint that should arrive, when it is a Solana mint
 * @param {boolean} o.send        false, sign only, do not send
 * @param {object} o.report       the report being filled
 */
/**
 * Tells the worker a send is about to go out, and refuses to go on without it.
 *
 * Only for an order, where a machine decides whether to try again. A trade a
 * person makes by hand has no orderId, nobody retries it on a timer, and it is
 * sent without this.
 *
 * Every way of not knowing counts as failure: a throw, a refusal, an answer
 * that is not `ok`, or no answer at all within the window. The error says
 * plainly that nothing was sent, because the worker reads it and must leave
 * the order watching rather than treat it as an unknown outcome.
 */
export async function requireSendMark({ callBackground, orderId, txHash = null, timeoutMs = 10_000 }) {
  if (!orderId) return;
  let answer;
  try {
    answer = await Promise.race([
      callBackground('runner.sending', { orderId, txHash }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`no answer in ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    throw new Error(`the send could not be marked (${String(err?.message || err)}); NOTHING WAS SENT`);
  }
  if (!answer?.ok) throw new Error('the send could not be marked (the worker did not accept it); NOTHING WAS SENT');
}

export async function executeBuy({
  quote, sender, solanaAddress = null, amount, inMint, outMint = null, send, report, step, callBackground,
  side = 'buy', orderId = null,
}) {
  const selling = side === 'sell';
  const { parsed, messageBase64 } = prepareForSigning({
    tx: quote.tx, feePayerAddress: quote.feePayerAddress, feePayerSignature: quote.feePayerSignature,
  });
  const userAddress = userSignerOf(parsed, solanaAddress ?? quote.originAddress ?? null);
  step('transaction parsed', true, { route: quote.route, signer: userAddress, lastValidBlockHeight: quote.lastValidBlockHeight ?? null });

  // THE GUARD. Refuses, before any signature exists, a transaction that moves
  // anything but the order amount of the input mint out of the wallet, or
  // that touches the wallet's authorities. dflow swaps deliver in the same
  // transaction, so the output must arrive there; relay fills in a separate
  // transaction of its own, so only the outflow is bounded on that route.
  if (!inMint) throw new Error('Solana guard: the input mint is unknown, not signing');
  const guard = await guardSolanaTransaction({
    parsed,
    user: userAddress,
    inMint,
    outMint,
    amount,
    requireOutput: quote.route === ROUTES.SOLANA_DFLOW,
    callBackground,
  });
  report.solanaGuard = { programs: guard.programs, deltas: guard.effects.deltas, lamportsDelta: guard.effects.lamportsDelta };
  step('solana guard: decoded and simulated', true, report.solanaGuard);

  // The user's signature: Privy, the same envelope as EVM, chainType solana.
  const signature = await privy.signSolanaMessage({ address: sender, messageBase64 });
  const { base64, txHash } = finalize(parsed, userAddress, signature);
  report.signature = signature;
  report.signed = true;
  report.signedBy = 'Privy (Solana)';
  report.txHash = txHash;
  step('signature: Privy (Solana)', true, { txHash });

  if (!send) {
    report.note = 'signed but NOT sent, sending is a separate decision';
    return report;
  }

  // Jito: the body is base64 as text, success is 200 with an empty body.
  //
  // The request itself is the point of no return, not its answer. A reply that
  // never arrives, a socket closed mid-flight, a tab suspended: Jito may have
  // the transaction all the same. Reported as an ordinary error, the runner
  // read it as "not sent" and let the order fire again, which is a second
  // sale. Only Jito's own refusal in words proves nothing went out.
  // Said out loud before the send, because after it this page may never speak
  // again: a tab closed or a message port lost leaves the worker with a plain
  // error and no way to tell it from "never sent". The worker writes this on
  // the attempt marker, which outlives both of us, and treats a silent page
  // after it as an outcome nobody knows rather than as a free retry.
  //
  // For an order it is a precondition, not a courtesy. An order is retried by
  // a machine, so an unmarked send is the whole defect back again. Refusing to
  // send costs one attempt and the order stays watching; sending unmarked can
  // cost the position twice.
  await requireSendMark({ callBackground, orderId, txHash });
  let res;
  try {
    res = await fetch(JITO_SEND_URL, { method: 'POST', body: base64 });
  } catch (err) {
    throw afterSend(err);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Jito refused (HTTP ${res.status}): ${text.slice(0, 200) || 'no body'}`);
  report.sent = true;
  report.userOpHash = txHash;
  step('sent to Jito', true, { txHash });

  // The chain, first: Jito's 200 is an acceptance, not an inclusion. The
  // signature is looked up until it lands, fails, or its blockhash expires
  // unseen (dropped). Without this a transaction that never landed was
  // reported as sent and the person was left to look for a position that
  // did not exist.
  const landing = await waitForLanding({ txHash, lastValidBlockHeight: quote.lastValidBlockHeight ?? null, callBackground, step });
  if (landing.verdict === 'failed') {
    report.receipt = { success: false, status: `failed on chain: ${landing.detail}` };
    report.note = `the transaction landed and failed (${landing.detail}), tx ${txHash}. Nothing was ${selling ? 'sold' : 'bought'}.`;
    return report;
  }
  if (landing.verdict === 'expired') {
    report.receipt = { success: false, status: 'dropped: not included before its blockhash expired' };
    report.note = `the transaction was not included in a block before its blockhash expired, tx ${txHash}. Nothing was ${selling ? 'sold' : 'bought'}; try again.`;
    return report;
  }

  try {
    if (quote.route === ROUTES.SOLANA_RELAY && quote.relaySwapId) {
      const idx = await fetch(RELAY_INDEX_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(relayIndexBody({ relaySwapId: quote.relaySwapId, txHash })),
      });
      step('registered with relay', idx.ok, { status: idx.status });
      // Status: up to ninety seconds, every three seconds, like their front end.
      const deadline = Date.now() + 90_000;
      let status = null;
      while (Date.now() < deadline) {
        try {
          status = readSwapStatus(await fomo.apiRequest({ path: swapStatusPath(quote.relaySwapId) }));
        } catch { status = null; }
        if (status === 'SUCCESS' || status === 'FAILED' || status === 'REFUND') break;
        await new Promise((r) => { setTimeout(r, 3000); });
      }
      // The origin transaction LANDED to get here, so the tokens have left
      // the wallet whatever relay says next. `false` would mean "reverted,
      // position intact" to the runner and let the order fire again; the
      // honest answer for anything but SUCCESS is "not known".
      report.receipt = { success: status === 'SUCCESS' ? true : null, status: status ?? 'no terminal status within 90s' };
      step('relay status', status === 'SUCCESS', { status });
    } else {
      // dflow fills in the same transaction: landed is filled.
      report.receipt = landing.verdict === 'landed'
        ? { success: true, status: 'landed on chain (dflow, same transaction)' }
        : { success: null, status: `sent, the chain has not shown it yet (${landing.detail})` };
    }
  } catch (err) {
    throw afterSend(err);
  }

  report.note = report.receipt?.success
    ? `${selling ? 'sold' : 'bought'} (tx ${txHash}). Check in the app that the trade shows in positions and PnL`
    : `sent (tx ${txHash}), status: ${report.receipt?.status ?? 'not received'}, check the position in the app`;
  return report;
}

/** How long the chain is watched for the sent transaction, and how often. */
const LANDING_TIMEOUT_MS = 75_000;
const LANDING_EVERY_MS = 3000;

/**
 * Watches the chain for the sent transaction.
 *
 * @returns {Promise<{verdict: 'landed'|'failed'|'expired'|'pending', detail: string}>}
 */
async function waitForLanding({ txHash, lastValidBlockHeight, callBackground, step }) {
  const deadline = Date.now() + LANDING_TIMEOUT_MS;
  let last = 'no answer from the node yet';
  while (Date.now() < deadline) {
    try {
      const { entry, blockHeight } = await callBackground('solana.signatureStatus', { signature: txHash });
      const verdict = judgeSignatureStatus(entry, { blockHeight, lastValidBlockHeight: Number(lastValidBlockHeight) || null });
      if (verdict === 'landed') { step('landed on chain', true, { txHash, status: entry?.confirmationStatus }); return { verdict, detail: entry?.confirmationStatus ?? 'confirmed' }; }
      if (verdict === 'failed') { const detail = JSON.stringify(entry?.err).slice(0, 160); step('failed on chain', false, { txHash, err: detail }); return { verdict, detail }; }
      if (verdict === 'expired') { step('dropped', false, { txHash, blockHeight, lastValidBlockHeight }); return { verdict, detail: `block ${blockHeight} past ${lastValidBlockHeight}` }; }
      last = blockHeight ? `not seen at block ${blockHeight}` : 'not seen';
    } catch (err) {
      last = String(err?.message || err).slice(0, 120);
    }
    await new Promise((r) => { setTimeout(r, LANDING_EVERY_MS); });
  }
  step('landing unknown', false, { txHash, last });
  return { verdict: 'pending', detail: last };
}
