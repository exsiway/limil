// Output guard: our own "no worse than X%" bound enforced inside the batch.
//
// Relay's tolerance on a sell (about 10% below the quote) is wider than the
// user's slippage, and pools with hooks that take 8–14% on top of the shown
// price fit inside it. The LimilOutputGuard contract checks, in the same
// operation, how much the relay depository gained: below the floor the whole
// batch reverts and the token stays with the user. This module holds the
// addresses, the call builders and the floor arithmetic; network and signing
// live in main/swap-exec.js and background/runner.js.

import { encodeFunctionData, toFunctionSelector } from 'viem';

/** The guard has the same address on every chain: CREATE2 through the deterministic deployer. */
export const GUARD_ADDRESS = '0x55f1dd8f6afe957fdfabb70e31b0f9ff46f237f3';
export const GUARD_SALT = '0x6b439d7f448eb8f9de24f517e8cec70501be819fb22a028c7468d94153a88018';
export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

/**
 * Relay depository: where the solver deposits the sell output
 * (RelayErc20Deposit event). One address on Robinhood Chain, Base and BNB.
 *
 * This is what the guard measures, and it is worth being exact about what
 * that proves. It proves the deposit happened and was not far below the
 * quote, a bad fill is caught. It does NOT prove the money reached the
 * owner: the depository is relay's shared contract, the payout it leads to is
 * named in an off-chain quote, and anyone may pay into it. Measuring the
 * wallet instead would prove delivery, but only for a sale that settles on
 * the origin chain, and the app that opened the position accounts for it only
 * when it settles into Solana cash through the app's own quote. So the
 * measurement stays here and the bound on a leaked key stays the per-token
 * budget. See docs/SECURITY.md §5.
 */
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';

/**
 * The token relay settles a sell into on each chain, with its decimals. BNB
 * Chain is not described: what relay pays in there has not been observed, and
 * guessing is not an option, on an undescribed chain the guard is not placed
 * and the journal says so.
 */
export const GUARD_CASH = Object.freeze({
  4663: { token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
  8453: { token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
  // Binance-Peg USDC: 18 decimals, unlike USDC elsewhere. Read from a relay
  // sell quote on BNB Chain: its swap pays this token into the depository.
  56: { token: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18 },
});

export const GUARD_ABI = [
  { type: 'function', name: 'snapshot', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'holder', type: 'address' }], outputs: [] },
  { type: 'function', name: 'assertGained', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'holder', type: 'address' }, { name: 'minGain', type: 'uint256' }], outputs: [] },
];

export const SEL_SNAPSHOT = toFunctionSelector('snapshot(address,address)');
export const SEL_ASSERT = toFunctionSelector('assertGained(address,address,uint256)');

/** The settlement token and its decimals for a chain, or null. */
export function settlementFor(chainId) {
  return GUARD_CASH[Number(chainId)] ?? null;
}

/** Whether the chain has everything the guard needs. */
export function guardSupported(chainId) {
  return Boolean(GUARD_CASH[Number(chainId)]);
}

/** Scale of the stored order target: QUOTE_SCALE from swaps.js, 18 digits. */
const TARGET_SCALE = 18;

/**
 * Floor for the depository's gain, in units of the chain's settlement token.
 *
 * The order target is stored in the quote scale (1e18) while the depository
 * counts USDG and USDC in six decimals, so the target is rescaled here.
 *
 * The floor is on the GROSS deposit, without a fee mark-up. The target is the
 * user's cash after relay and FOMO fees, and the deposit on the EVM side still
 * contains them; the `usdFees` field of the FOMO quote does not equal what is
 * later deducted, so adding it produced false reverts. What the quote reported
 * about fees is returned for information (`quoteFeesUnits`) and not added to
 * the floor.
 */
export function guardFloor({ targetOutScaled, maxSlippageBps, usdFees = null, decimals = 6, targetScale = TARGET_SCALE }) {
  const target = BigInt(targetOutScaled);
  const bps = Number(maxSlippageBps);
  if (!(target > 0n)) throw new Error('guard floor: the order target is not positive');
  if (!Number.isFinite(bps) || bps < 0 || bps >= 10000) throw new Error(`guard floor: slippage ${maxSlippageBps} bps outside 0..9999`);
  const d = Number(decimals);
  const s = Number(targetScale);
  if (!Number.isInteger(d) || d < 0 || d > 18 || !Number.isInteger(s) || s < d || s > 18) {
    throw new Error(`guard floor: scale ${targetScale} → ${decimals} does not parse`);
  }
  const targetUnits = target / 10n ** BigInt(s - d);
  const afterSlippage = (targetUnits * BigInt(10000 - bps)) / 10000n;
  let quoteFeesUnits = 0n;
  if (usdFees && typeof usdFees === 'object') {
    const total = Object.values(usdFees).reduce((acc, v) => acc + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
    if (total > 0) quoteFeesUnits = BigInt(Math.ceil(total * 10 ** d));
  }
  return { floor: afterSlippage > 0n ? afterSlippage : 1n, afterSlippage, quoteFeesUnits };
}

/** The two guard calls: snapshot BEFORE the trade and check AFTER. */
export function guardCalls({ chainId, minGain, holder = RELAY_DEPOSITORY }) {
  const cash = GUARD_CASH[Number(chainId)];
  if (!cash) throw new Error(`the guard is not described for chain ${chainId}`);
  if (!(BigInt(minGain) > 0n)) throw new Error('guard: the floor must be above zero');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(holder))) throw new Error('guard: the holder must be an address');
  const args = [cash.token, lower(holder)];
  return {
    before: {
      target: GUARD_ADDRESS, value: 0n,
      data: encodeFunctionData({ abi: GUARD_ABI, functionName: 'snapshot', args }),
    },
    after: {
      target: GUARD_ADDRESS, value: 0n,
      data: encodeFunctionData({ abi: GUARD_ABI, functionName: 'assertGained', args: [...args, BigInt(minGain)] }),
    },
  };
}

/**
 * The execution template a session grant names: the guard, the token the
 * chain's sells settle into and the relay depository that receives them. The
 * contract requires every operation of the key to open with a snapshot of
 * exactly this (token, depository) and close with a check on it. Null on a
 * chain where the settlement token is not described, no template, no grant.
 */
export function guardSpecFor(chainId, { holder = RELAY_DEPOSITORY } = {}) {
  const cash = GUARD_CASH[Number(chainId)];
  if (!cash) return null;
  return { guard: GUARD_ADDRESS, settlementToken: cash.token, depository: lower(holder) };
}

const lower = (v) => String(v ?? '').toLowerCase();
const word = (data, i) => `0x${String(data).slice(10 + i * 64, 10 + (i + 1) * 64)}`;
const addressWord = (data, i) => `0x${word(data, i).slice(26)}`.toLowerCase();

/**
 * Verifies the guard calls in a batch for the runner: snapshot first, check
 * last, both on the chain's settlement token and the relay depository, floor
 * not below the computed one. Returns a reason string or null.
 */
export function verifyGuardCalls(calls, { chainId, minFloor, holder = RELAY_DEPOSITORY }) {
  const cash = GUARD_CASH[Number(chainId)];
  if (!cash) return `the guard is not described for chain ${chainId}`;
  const isGuard = (c) => lower(c.target) === GUARD_ADDRESS;
  const guards = calls.filter(isGuard);
  if (guards.length !== 2) return `${guards.length} guard calls, exactly two expected`;
  const first = calls[0];
  const last = calls[calls.length - 1];
  if (!isGuard(first) || lower(first.data).slice(0, 10) !== SEL_SNAPSHOT) return 'the guard snapshot must be the first call';
  if (!isGuard(last) || lower(last.data).slice(0, 10) !== SEL_ASSERT) return 'the guard check must be the last call';
  for (const c of [first, last]) {
    if (BigInt(c.value ?? 0) !== 0n) return 'a guard call carries native value';
    if (addressWord(c.data, 0) !== cash.token) return `the guard does not watch the chain's ${cash.symbol}`;
    if (addressWord(c.data, 1) !== lower(holder)) {
      return `the guard watches ${addressWord(c.data, 1)}, not ${lower(holder)}`;
    }
  }
  // Three argument words: token, holder, floor. Anything shorter is not our call.
  if (String(last.data).length < 10 + 3 * 64) return 'the guard check has no floor';
  const minGain = BigInt(word(last.data, 2));
  if (minGain < BigInt(minFloor)) return `guard floor ${minGain} is below the computed ${minFloor}`;
  return null;
}

/** Guard error selectors: the bundler may return raw revert data. */
export const GUARD_ERRORS = Object.freeze({
  OutputBelowFloor: '0x543f947a',
  NoSnapshot: '0xc809c613',
  FloorIsZero: '0xebda6e16',
});

/** Whether a refusal (bundler or receipt) looks like the guard firing. */
export function looksLikeGuardRevert(text) {
  const s = String(text ?? '');
  if (/OutputBelowFloor|NoSnapshot|FloorIsZero/i.test(s)) return true;
  return Object.values(GUARD_ERRORS).some((sel) => s.toLowerCase().includes(sel));
}
