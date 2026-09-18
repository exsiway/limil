// UserOperation v0.8 assembly for the FOMO wallet (EIP-7702 account).
//
// The hash formula has been verified byte for byte against a live transaction:
// EIP-712, domain name="ERC4337" version="1", verifyingContract = EntryPoint
// v0.8. The executeBatch ABI matches the verified Simple7702Account on chain:
// executeBatch((address target, uint256 value, bytes data)[]).

import { decodeFunctionData, encodeFunctionData, getAddress, hashTypedData, toHex } from 'viem';
import { ENTRY_POINT_V08 } from './chains.js';

/**
 * Checksums an address, accepting any case. Addresses come from responses and
 * constants written in lower case; a strict checksum check on input would
 * reject them as "not an address".
 */
export function normalizeAddress(value, label = 'address') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label}: "${value}" does not look like an address`);
  }
  return getAddress(value.toLowerCase());
}

const CALL_COMPONENTS = [
  { name: 'target', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
];

export const ACCOUNT_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
];

/** Session key revocation. Callable by the owner only, like the grant. */
export const REVOKE_SESSION_ABI = [
  {
    type: 'function',
    name: 'revokeSession',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'key', type: 'address' }],
    outputs: [],
  },
];

/** Version 2 only: every key of the wallet revoked in one operation. */
export const REVOKE_SESSIONS_ABI = [
  {
    type: 'function',
    name: 'revokeSessions',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'keys', type: 'address[]' }],
    outputs: [],
  },
];

const LIMITS_COMPONENTS = [
  { name: 'validUntil', type: 'uint48' },
  { name: 'maxOps', type: 'uint64' },
  { name: 'maxValuePerCall', type: 'uint256' },
  { name: 'valueBudget', type: 'uint256' },
  { name: 'feeBudget', type: 'uint256' },
  { name: 'maxFeePerOp', type: 'uint256' },
];

const TOKEN_CAP_COMPONENTS = [
  { name: 'token', type: 'address' },
  { name: 'maxPerOp', type: 'uint256' },
  { name: 'budget', type: 'uint256' },
  { name: 'minOutPerUnit', type: 'uint256' },
];

const GUARD_SPEC_COMPONENTS = [
  { name: 'guard', type: 'address' },
  { name: 'settlementToken', type: 'address' },
  { name: 'depository', type: 'address' },
];

const SWAP_SPEC_COMPONENTS = [
  { name: 'router', type: 'address' },
  { name: 'selector', type: 'bytes4' },
];


/**
 * Session key grant (contract version 2). Needed IN the extension, not only
 * in a script: the FOMO wallet cannot pay gas (native value sent to it is
 * wrapped into WETH by the app), so `grantSession` goes as a UserOperation
 * through the EntryPoint, whose gas is sponsored by the bundler. The contract
 * allows it: onlySelfOrEntryPoint admits the EntryPoint.
 *
 * One struct for the whole grant: the approve caps are per token, the guard
 * template is named explicitly, and the pair list is about the trade alone
 * (the guard's own pairs are the contract's to add).
 */
export const GRANT_SESSION_ABI = [
  {
    type: 'function',
    name: 'grantSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'address' },
      {
        name: 'g',
        type: 'tuple',
        components: [
          { name: 'limits', type: 'tuple', components: LIMITS_COMPONENTS },
          { name: 'tokenCaps', type: 'tuple[]', components: TOKEN_CAP_COMPONENTS },
          { name: 'guard', type: 'tuple', components: GUARD_SPEC_COMPONENTS },
          { name: 'swap', type: 'tuple', components: SWAP_SPEC_COMPONENTS },
          { name: 'targets', type: 'address[]' },
          { name: 'selectors', type: 'bytes4[]' },
          { name: 'feeRecipients', type: 'address[]' },
        ],
      },
    ],
    outputs: [],
  },
];

/**
 * Session key views: the client reads the ISSUED grant before sending, so a
 * refusal can be named instead of guessed from a bundler error.
 */
export const SESSION_VIEW_ABI = [
  {
    type: 'function',
    name: 'getSession',
    stateMutability: 'view',
    inputs: [{ name: 'key', type: 'address' }],
    outputs: [{
      name: 'session',
      type: 'tuple',
      components: [
        { name: 'validUntil', type: 'uint48' },
        { name: 'maxOps', type: 'uint64' },
        { name: 'opsUsed', type: 'uint64' },
        { name: 'exists', type: 'bool' },
        { name: 'maxValuePerCall', type: 'uint256' },
        { name: 'valueBudget', type: 'uint256' },
        { name: 'spentValue', type: 'uint256' },
        { name: 'feeBudget', type: 'uint256' },
        { name: 'spentFees', type: 'uint256' },
        { name: 'maxFeePerOp', type: 'uint256' },
        { name: 'guard', type: 'address' },
        { name: 'guardToken', type: 'address' },
        { name: 'guardHolder', type: 'address' },
        { name: 'swapRouter', type: 'address' },
        { name: 'swapSelector', type: 'bytes4' },
      ],
    }],
  },
  {
    type: 'function',
    name: 'tokenBudget',
    stateMutability: 'view',
    inputs: [
      { name: 'key', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{
      name: 'budget',
      type: 'tuple',
      components: [
        { name: 'exists', type: 'bool' },
        { name: 'maxPerOp', type: 'uint256' },
        { name: 'budget', type: 'uint256' },
        { name: 'spent', type: 'uint256' },
        { name: 'minOutPerUnit', type: 'uint256' },
      ],
    }],
  },
  {
    type: 'function',
    name: 'isAllowedCall',
    stateMutability: 'view',
    inputs: [
      { name: 'key', type: 'address' },
      { name: 'target', type: 'address' },
      { name: 'selector', type: 'bytes4' },
    ],
    outputs: [{ name: 'allowed', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isFeeRecipient',
    stateMutability: 'view',
    inputs: [
      { name: 'key', type: 'address' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: 'ok', type: 'bool' }],
  },
];

export const ENTRY_POINT_ABI = [
  {
    type: 'function',
    name: 'getNonce',
    stateMutability: 'view',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ name: 'nonce', type: 'uint256' }],
  },
];

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    // Used to prove a sell by balance: "the bundler accepted" and "the
    // position is gone" are different statements.
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

/** PackedUserOperation type for EIP-712. The signature field is NOT part of the hash. */
const USEROP_TYPES = {
  PackedUserOperation: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
  ],
};

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/** Two uint128 in one bytes32 word: the format of accountGasLimits and gasFees. */
export function packUint128Pair(hi, lo) {
  const packed = (BigInt(hi) << 128n) | BigInt(lo);
  return toHex(packed, { size: 32 });
}

/**
 * The inverse. The HASH is computed over the packed fields, but the bundler
 * JSON-RPC takes them separately (callGasLimit, verificationGasLimit,
 * maxFeePerGas, maxPriorityFeePerGas); sending them packed is refused.
 */
export function unpackUint128Pair(packed) {
  const value = BigInt(packed);
  const mask = (1n << 128n) - 1n;
  return { hi: value >> 128n, lo: value & mask };
}

/**
 * The calls of an account operation. Throws on anything else, like the
 * verifier wants.
 */
export function decodeBatch(callData) {
  const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: callData });
  if (decoded.functionName === 'executeBatch') return { functionName: decoded.functionName, calls: decoded.args[0] };
  return { functionName: decoded.functionName, calls: null };
}

/** executeBatch([{target, value, data}, ...]) as the account's callData. */
export function encodeExecuteBatch(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('executeBatch: the call list is empty');
  }
  const args = calls.map((call, i) => ({
    target: normalizeAddress(call.target, `call [${i}] target`),
    value: BigInt(call.value ?? 0),
    data: call.data ?? '0x',
  }));
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'executeBatch', args: [args] });
}

/**
 * Builds a UserOperation v0.8 with the FOMO-flow defaults: no initCode, no
 * paymaster, gasFees = 0 (the EntryPoint takes no compensation, the sender
 * pays the gas).
 */
export function buildUserOp({
  sender,
  nonce,
  callData,
  verificationGasLimit = 500_000n,
  callGasLimit = 1_500_000n,
  // Zero, not the "reasonable" 100k of the v0.8 example: the FOMO bundler
  // sponsors gas and in live trades all three fee fields are zero. Any other
  // value changes the hash and with it the signature.
  preVerificationGas = 0n,
  maxPriorityFeePerGas = 0n,
  maxFeePerGas = 0n,
}) {
  return {
    sender: normalizeAddress(sender, 'sender'),
    nonce: BigInt(nonce),
    initCode: '0x',
    callData,
    accountGasLimits: packUint128Pair(verificationGasLimit, callGasLimit),
    preVerificationGas: BigInt(preVerificationGas),
    gasFees: packUint128Pair(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: '0x',
  };
}

/** Domain and message exactly as EntryPoint v0.8 hashes them. */
function userOpTypedData({ userOp, chainId, entryPoint = ENTRY_POINT_V08 }) {
  return {
    domain: {
      name: 'ERC4337',
      version: '1',
      chainId: Number(chainId),
      verifyingContract: normalizeAddress(entryPoint, 'entryPoint'),
    },
    types: USEROP_TYPES,
    primaryType: 'PackedUserOperation',
    message: {
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: userOp.preVerificationGas,
      gasFees: userOp.gasFees,
      paymasterAndData: userOp.paymasterAndData,
    },
  };
}

/** The hash that must equal the EntryPoint's userOpHash. */
export function userOpHash({ userOp, chainId, entryPoint = ENTRY_POINT_V08 }) {
  return hashTypedData(userOpTypedData({ userOp, chainId, entryPoint }));
}

/**
 * The same typed data, JSON-serialisable: this is the second parameter of
 * eth_signTypedData_v4. bigint -> string, plus EIP712Domain in types, as
 * wallets expect.
 */
export function userOpTypedDataJson({ userOp, chainId, entryPoint = ENTRY_POINT_V08 }) {
  const typed = userOpTypedData({ userOp, chainId, entryPoint });
  return {
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...typed.types },
    primaryType: typed.primaryType,
    domain: typed.domain,
    message: {
      ...typed.message,
      nonce: typed.message.nonce.toString(),
      preVerificationGas: typed.message.preVerificationGas.toString(),
    },
  };
}

/** The UserOperation as hex strings, the way handleOps and the simulator take it. */
export function userOpToJson(userOp, signature = '0x') {
  return {
    sender: userOp.sender,
    nonce: toHex(userOp.nonce),
    initCode: userOp.initCode,
    callData: userOp.callData,
    accountGasLimits: userOp.accountGasLimits,
    preVerificationGas: toHex(userOp.preVerificationGas),
    gasFees: userOp.gasFees,
    paymasterAndData: userOp.paymasterAndData,
    signature,
  };
}
