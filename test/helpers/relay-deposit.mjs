// Relay's depository calldata for the contract tests: the deposit call the
// router nests inside a swap, in the shapes the live router uses.

import { encodeAbiParameters, keccak256, toHex } from 'viem';

/** depositErc20(address,address,bytes32), depositErc20(address,address,uint256,bytes32), depositNative(address,bytes32). */
export const SEL_DEPOSIT_ERC20 = '0x5a1ee3ac';
export const SEL_DEPOSIT_ERC20_AMOUNT = '0xe8017952';
export const SEL_DEPOSIT_NATIVE = '0x49290c1c';

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** The depository call that credits `id`: relay's 3-argument form. */
export const depositData = (depositor, token, id) => `${SEL_DEPOSIT_ERC20}${pad(depositor)}${pad(token)}${pad(id)}`;
/** The 4-argument form, amount included. */
export const depositAmountData = (depositor, token, amount, id) => `${SEL_DEPOSIT_ERC20_AMOUNT}${pad(depositor)}${pad(token)}${amount.toString(16).padStart(64, '0')}${pad(id)}`;
/** A native deposit, which a settlement in an ERC-20 never has. */
export const depositNativeData = (depositor, id) => `${SEL_DEPOSIT_NATIVE}${pad(depositor)}${pad(id)}`;

/**
 * Nests calldata one level deeper, the way relay's proxy carries the
 * depository call inside its own multicall: a selector, then the bytes as an
 * ABI-encoded dynamic argument. Every level shifts word alignment by four.
 */
export function nested(inner, selector = '0x73b7bb2f') {
  return `${selector}${encodeAbiParameters([{ type: 'bytes' }], [inner]).slice(2)}`;
}

/** A 32-byte Solana-style key from a short label, deterministic. */
export const key32 = (label) => keccak256(toHex(label));
