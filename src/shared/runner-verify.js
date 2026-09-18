// Verification of an operation before the session key signs it.
//
// The page assembles the operation and the service worker computes the hash
// itself: the key never signs a hash handed to it from outside, so it cannot
// sign something we did not build. The contents are then checked against the
// order the runner came here for: same wallet, same input token, no transfers,
// no calls into the account or the EntryPoint.
//
// This is not a replacement for the contract, which checks the same things on
// chain where nothing can be faked. It is a second line that catches a forgery
// before a signature exists at all.

import { decodeBatch } from './userop.js';
import { RELAY_ROUTER, RELAY_SWAP_SELECTOR } from './chains.js';
import { chainFromTokenId } from './orders.js';
import { parseSwapArgs } from './swap-args.js';
import { GUARD_ADDRESS, GUARD_CASH, guardFloor, guardSupported, verifyGuardCalls } from './output-guard.js';

/** Selectors that never belong in a runner batch. Mirrors the contract's list. */
const BANNED = new Set([
  '0x23b872dd', // transferFrom
  '0xa22cb465', // setApprovalForAll
  '0x42842e0e', // safeTransferFrom(address,address,uint256)
  '0xb88d4fde', // safeTransferFrom(...,bytes)
  '0xf242432a', // safeTransferFrom(...,uint256,uint256,bytes)
  '0x2eb2c2d6', // safeBatchTransferFrom
  '0xd505accf', // permit (EIP-2612)
  '0x8fcbaf0c', // permit (DAI)
  '0x39509351', // increaseAllowance
  '0x4000aea0', // transferAndCall (ERC-677)
  '0xcae9ca51', // approveAndCall (ERC-1363)
  '0x959b8c3f', // authorizeOperator (ERC-777)
]);

const SEL_TRANSFER = '0xa9059cbb';
const SEL_APPROVE = '0x095ea7b3';
/** increaseAllowance grants the same right as approve, by addition; checked the same way. */
const SEL_INC_ALLOWANCE = '0x39509351';
const ENTRY_POINT = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';

/** Batch length ceiling: approve, swap, the allowance reset and the two guard calls. */
const MAX_CALLS = 5;

const lower = (v) => String(v ?? '').toLowerCase();
const selectorOf = (data) => lower(String(data ?? '').slice(0, 10));

/** Address from `<address>:<network>`; null for anything that is not an address. */
function tokenAddress(tokenId) {
  const head = String(tokenId ?? '').split(':')[0]?.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(head ?? '') ? lower(head) : null;
}

/** Address argument by word index: 4 selector bytes plus 32 bytes per word. */
function addressArg(data, index) {
  const hex = String(data ?? '').replace(/^0x/, '');
  const start = 8 + index * 64;
  const word = hex.slice(start, start + 64);
  if (word.length < 64) return null;
  return `0x${word.slice(24)}`.toLowerCase();
}

/** Numeric argument by word index; null when the word is missing. */
function amountArg(data, index) {
  const hex = String(data ?? '').replace(/^0x/, '');
  const start = 8 + index * 64;
  const word = hex.slice(start, start + 64);
  if (word.length < 64) return null;
  return BigInt(`0x${word}`);
}

/**
 * Checks an assembled operation against the order it was assembled for.
 *
 * @param {object} opts
 * @param {object} opts.userOp the operation in JSON form
 * @param {object} opts.order the stored order
 * @param {string} [opts.guardHolder] whose balance the guard must measure.
 *   The server route settles into the WALLET, so there it is the wallet; the
 *   browser route settles cross-chain and it stays relay's depository.
 * @returns {{ok: boolean, reason: string|null, calls?: number, guarded?: boolean}}
 */
export function verifyOperation({ userOp, order, guardHolder = undefined }) {
  if (!userOp || !order) return { ok: false, reason: 'nothing to verify: no operation or no order' };

  // The session key's signature is only valid for the account it was granted
  // on; a different sender means the operation was not built for us.
  if (lower(userOp.sender) !== lower(order.sender)) {
    return { ok: false, reason: `operation built for another wallet ${userOp.sender}` };
  }

  let calls;
  try {
    const decoded = decodeBatch(userOp.callData);
    if (!decoded.calls) {
      return { ok: false, reason: `the operation calls ${decoded.functionName}, not executeBatch` };
    }
    ({ calls } = decoded);
  } catch (err) {
    // Undecodable means not our batch. Signing what cannot be decoded is
    // exactly what a forgery looks like.
    return { ok: false, reason: `callData does not decode: ${String(err?.message || err)}` };
  }

  if (!calls?.length) return { ok: false, reason: 'the batch is empty' };
  if (calls.length > MAX_CALLS) {
    return { ok: false, reason: `${calls.length} calls in the batch, at most ${MAX_CALLS} allowed` };
  }

  // Trade size. Without it nothing about amounts can be checked, and the
  // contract cannot help: it checks approve by spender only, and the swap
  // calldata is opaque to it.
  let amount;
  try {
    amount = BigInt(order.amount);
  } catch {
    return { ok: false, reason: `order amount does not parse: ${order.amount}` };
  }
  if (amount <= 0n) return { ok: false, reason: 'order amount is not positive' };

  const self = lower(order.sender);
  const inToken = tokenAddress(order.inTokenId);
  /** The sales found in the batch, read from the router's own arguments. */
  const sales = [];

  for (const call of calls) {
    const target = lower(call.target);
    // A call into the account itself would bypass the parser by nesting; a
    // call into the EntryPoint could move the deposit. The contract catches
    // both too; the duplication is deliberate.
    if (target === self || target === ENTRY_POINT) {
      return { ok: false, reason: `call into ${target === self ? 'the account itself' : 'the EntryPoint'}` };
    }
    if (BigInt(call.value ?? 0) !== 0n) {
      // Native value takes no part in a token sell at any step.
      return { ok: false, reason: `call with native value ${call.value}` };
    }

    const selector = selectorOf(call.data);
    if (selector.length < 10) return { ok: false, reason: 'call without a selector' };
    if (BANNED.has(selector)) return { ok: false, reason: `banned selector ${selector}` };

    if (selector === SEL_TRANSFER) {
      // A sell has no legitimate transfer: the token leaves through approve
      // and the router's transferFrom. Any transfer in the batch is a theft.
      const to = addressArg(call.data, 0);
      return { ok: false, reason: `token transfer to ${to}, a sell contains no transfers` };
    }

    if (selector === SEL_APPROVE || selector === SEL_INC_ALLOWANCE) {
      // The spender must be the target of another call in this batch, i.e.
      // the router of the trade. Otherwise it is an approve to a stranger.
      const spender = addressArg(call.data, 0);
      const known = calls.some((c) => lower(c.target) === spender);
      if (!known) return { ok: false, reason: `approve to an unknown spender ${spender}` };

      // How much, not only to whom. The allowance is the trade size: the
      // router takes the token through transferFrom within it, and the swap
      // calldata is opaque. An approve above the order amount is a right to
      // take more than the user named.
      const allowance = amountArg(call.data, 1);
      if (allowance === null) return { ok: false, reason: 'approve without an amount' };
      if (allowance > amount) {
        return {
          ok: false,
          reason: `allowance ${allowance} exceeds the order amount ${amount}, `
            + 'the approve is larger than the trade',
        };
      }
    }

    // The sale itself. `transferAndMulticall` takes the tokens with
    // `transferFrom(msg.sender, ...)`, so its `tokens`/`amounts` are exactly
    // what leaves the wallet, whatever allowance happens to stand. The
    // approve check above bounds a NEW allowance and nothing else; an
    // allowance left standing by an earlier round is not in this batch at
    // all, so without reading these arguments the batch's size is unknown.
    if (target === lower(RELAY_ROUTER)) {
      if (selector !== lower(RELAY_SWAP_SELECTOR)) {
        return { ok: false, reason: `call to the swap router with selector ${selector}` };
      }
      const args = parseSwapArgs(call.data);
      if (!args) return { ok: false, reason: 'the swap call does not decode' };
      sales.push(args);
    }
  }

  // The input token must take part: a batch without it sells something else.
  if (inToken && !calls.some((c) => lower(c.target) === inToken)) {
    return { ok: false, reason: 'the order input token is not in the batch' };
  }

  // What the sale sells, and how much of it.
  //
  // The contract checks the same arguments, but against the GRANT, whose
  // per-token cap is the largest live order of that token, so with a small
  // and a large order open at once, the contract would let the small order's
  // operation sell the large order's size. The ticket was issued for one
  // order; this is where the batch is held to that one order.
  if (inToken) {
    if (sales.length !== 1) {
      return {
        ok: false,
        reason: sales.length
          ? `${sales.length} swap calls in the batch, an order is sold once`
          : 'the batch has no swap call, so nothing in it is the trade',
      };
    }
    const [sale] = sales;
    if (sale.tokens.length !== 1) {
      return { ok: false, reason: `the swap moves ${sale.tokens.length} tokens, an order has one input` };
    }
    if (sale.tokens[0] !== inToken) {
      return { ok: false, reason: `the swap sells ${sale.tokens[0]}, the order is for ${inToken}` };
    }
    // `refundTo` and `nftRecipient` are parsed and deliberately NOT held to
    // the wallet, in step with the contract (LimilSessionAccount.sol, "the
    // two remaining head words"): live relay quotes put relay's own address
    // there, and requiring the wallet would refuse every real sell. They
    // receive leftover native value and minted NFTs; the batch carries no
    // native value (refused above) and the trade is ERC-20, so a stranger
    // there is handed nothing. What the sale sells and how much is bounded
    // by the two checks on either side of this note.
    const sold = sale.amounts[0];
    if (sold <= 0n) return { ok: false, reason: 'the swap sells nothing' };
    // Below the order amount is allowed: a quote may round down, and selling
    // less than asked is not a theft. Above it is another order's size.
    if (sold > amount) {
      return {
        ok: false,
        reason: `the swap sells ${sold}, above the order amount ${amount}, `
          + 'the batch is larger than the order it was built for',
      };
    }
  }

  // Output guard. Where the chain is described and the order has a target
  // with slippage, a batch without the guard is not signed: the user's bound
  // would otherwise rest on relay's tolerance, which is twice as wide. The
  // floor here excludes fees, i.e. it is the lower bound; the runner may set
  // it higher, never lower.
  const chainId = chainFromTokenId(order.inTokenId);
  const hasGuard = calls.some((c) => lower(c.target) === GUARD_ADDRESS);
  const wantsGuard = guardSupported(chainId)
    && order.maxSlippageBps !== null && order.maxSlippageBps !== undefined
    && BigInt(order.targetOut ?? 0) > 0n;
  if (wantsGuard) {
    let minFloor;
    try {
      minFloor = guardFloor({
        targetOutScaled: order.targetOut, maxSlippageBps: order.maxSlippageBps, decimals: GUARD_CASH[chainId].decimals,
      }).afterSlippage;
    } catch (err) {
      return { ok: false, reason: `guard floor cannot be computed: ${String(err?.message || err)}` };
    }
    const problem = verifyGuardCalls(calls, { chainId, minFloor, ...(guardHolder ? { holder: guardHolder } : {}) });
    if (problem) return { ok: false, reason: `output guard: ${problem}` };
  } else if (hasGuard) {
    // A guard without a target is someone else's build; check its shape anyway.
    const problem = verifyGuardCalls(calls, { chainId, minFloor: 1n, ...(guardHolder ? { holder: guardHolder } : {}) });
    if (problem) return { ok: false, reason: `output guard: ${problem}` };
  }

  return { ok: true, reason: null, calls: calls.length, guarded: hasGuard, sold: sales[0]?.amounts[0] ?? null };
}

/**
 * Signing ticket.
 *
 * The runner issues one before asking the page to assemble an operation and
 * spends it on the first signature. Without a ticket no signature is issued
 * at all, so a signature cannot be initiated from the page even by someone who
 * knows the bus format. The lifetime is short: one round of the runner.
 */
export const TICKET_TTL_MS = 90_000;

export function ticketValid(ticket, { orderId, now = Date.now() } = {}) {
  if (!ticket) return { ok: false, reason: 'no signature was requested by the runner' };
  if (ticket.used) return { ok: false, reason: 'the ticket is already used' };
  if (ticket.orderId !== orderId) return { ok: false, reason: 'the ticket was issued for another order' };
  if (now - Number(ticket.at ?? 0) > TICKET_TTL_MS) return { ok: false, reason: 'the ticket expired' };
  return { ok: true, reason: null };
}
