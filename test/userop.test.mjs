// Self-check of the UserOperation v0.8 assembly.
//
// The main test is the hash. userOpHash uses viem's hashTypedData; here the
// same value is assembled by hand per the EntryPoint v0.8 formula
// (typeHash -> structHash -> "\x19\x01" || domainSeparator || structHash).
// If the implementations diverged, the signature would fail on chain.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  concatHex,
  toHex,
} from 'viem';

import { ENTRY_POINT_V08 } from '../src/shared/chains.js';
import {
  ACCOUNT_ABI,
  ERC20_ABI,
  buildUserOp,
  encodeExecuteBatch,
  normalizeAddress,
  packUint128Pair,
  unpackUint128Pair,
  userOpHash,
  userOpTypedDataJson,
} from '../src/shared/userop.js';

const CHAIN_ID = 4663;
// Deliberately lower case, the way addresses are usually copied.
const SENDER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

function manualUserOpHash(op, chainId, entryPoint) {
  const domainTypeHash = keccak256(
    toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
  );
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [domainTypeHash, keccak256(toHex('ERC4337')), keccak256(toHex('1')), BigInt(chainId), entryPoint],
  ));

  const structTypeHash = keccak256(toHex(
    'PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,'
    + 'bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)',
  ));
  const structHash = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' },
      { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [
      structTypeHash,
      op.sender,
      op.nonce,
      keccak256(op.initCode),
      keccak256(op.callData),
      op.accountGasLimits,
      op.preVerificationGas,
      op.gasFees,
      keccak256(op.paymasterAndData),
    ],
  ));

  return keccak256(concatHex(['0x1901', domainSeparator, structHash]));
}

function sampleOp() {
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [ENTRY_POINT_V08, 0n],
  });
  return buildUserOp({
    sender: SENDER,
    nonce: 42n,
    callData: encodeExecuteBatch([{ target: TOKEN, value: 0n, data: approveData }]),
  });
}

test('the UserOp hash matches the manual assembly per the EntryPoint v0.8 formula', () => {
  const op = sampleOp();
  assert.equal(
    userOpHash({ userOp: op, chainId: CHAIN_ID }),
    manualUserOpHash(op, CHAIN_ID, ENTRY_POINT_V08),
  );
});

test('the hash depends on the chain, one operation hashes differently per chain', () => {
  const op = sampleOp();
  assert.notEqual(
    userOpHash({ userOp: op, chainId: 4663 }),
    userOpHash({ userOp: op, chainId: 8453 }),
  );
});

test('packUint128Pair puts two numbers in one word', () => {
  assert.equal(
    packUint128Pair(150_000n, 400_000n),
    // 150000 = 0x249f0 in the high 16 bytes, 400000 = 0x61a80 in the low
    '0x000000000000000000000000000249f000000000000000000000000000061a80',
  );
  assert.equal(packUint128Pair(0n, 0n), `0x${'0'.repeat(64)}`);
});

test('executeBatch encodes and decodes back without loss', () => {
  const calls = [
    { target: TOKEN, value: 0n, data: '0xdeadbeef' },
    { target: ENTRY_POINT_V08, value: 7n, data: '0x' },
  ];
  const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: encodeExecuteBatch(calls) });
  assert.equal(decoded.functionName, 'executeBatch');
  assert.equal(decoded.args[0].length, 2);
  assert.equal(decoded.args[0][0].target, getAddress(TOKEN));
  assert.equal(decoded.args[0][0].data, '0xdeadbeef');
  assert.equal(decoded.args[0][1].value, 7n);
});

test('an address is accepted in any case and checksummed', () => {
  const checksummed = getAddress(SENDER);
  assert.equal(normalizeAddress(SENDER), checksummed);
  assert.equal(normalizeAddress(checksummed), checksummed);
  assert.equal(normalizeAddress(SENDER.toUpperCase().replace('0X', '0x')), checksummed);
  assert.throws(() => normalizeAddress('0x123'), /does not look like an address/);
});

test('executeBatch with an empty list does not assemble', () => {
  assert.throws(() => encodeExecuteBatch([]), /empty/);
});

test('typed data for the provider serialises to JSON and carries EIP712Domain', () => {
  const typed = userOpTypedDataJson({ userOp: sampleOp(), chainId: CHAIN_ID });
  const roundTrip = JSON.parse(JSON.stringify(typed));
  assert.ok(roundTrip.types.EIP712Domain, 'EIP712Domain is mandatory for wallets');
  assert.equal(roundTrip.primaryType, 'PackedUserOperation');
  assert.equal(roundTrip.domain.name, 'ERC4337');
  assert.equal(roundTrip.domain.version, '1');
  assert.equal(roundTrip.domain.verifyingContract, ENTRY_POINT_V08);
  assert.equal(typeof roundTrip.message.nonce, 'string');
});

// The hash is over the PACKED gas fields while the bundler JSON-RPC takes them
// separately. An unpacking error would mean a valid signature under an
// operation the bundler reads differently.
test('packing and unpacking of the gas fields are inverse', () => {
  const packed = packUint128Pair(250_000n, 6_095_650n);
  const { hi, lo } = unpackUint128Pair(packed);
  assert.equal(hi, 250_000n, 'verificationGasLimit');
  assert.equal(lo, 6_095_650n, 'callGasLimit');
});

test('zeros unpack to zeros, the bundler sponsors the gas', () => {
  const { hi, lo } = unpackUint128Pair(packUint128Pair(0n, 0n));
  assert.equal(hi, 0n);
  assert.equal(lo, 0n);
});

test('high and low halves do not swap', () => {
  const { hi, lo } = unpackUint128Pair(packUint128Pair(1n, 2n));
  assert.equal(hi, 1n);
  assert.equal(lo, 2n);
});
