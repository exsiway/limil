// The output guard on a real EVM: snapshot, trade and check in one account
// batch, the way it runs on chain. The token is a minimal ERC-20 with mint.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { encodeFunctionData } from 'viem';
import { hexToBytes, Address } from '@ethereumjs/util';
import solc from 'solc';

import { ABI, ENTRY_POINT, call, delegateTo, fund, makeVm } from './helpers/evm.mjs';
import { GUARD_ABI, GUARD_ERRORS } from '../src/shared/output-guard.js';

const guardArtifact = JSON.parse(readFileSync('artifacts/contracts/LimilOutputGuard.json', 'utf8'));

const OWNER = '0x1111111111111111111111111111111111111111';
const GUARD = '0x55f1dd8f6afe957fdfabb70e31b0f9ff46f237f3';
const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const HOLDER = '0x4cd00e387622c35bddb9b4c962c136462338bc31';

const MOCK_SRC = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract MockToken {
  mapping(address => uint256) public balanceOf;
  function mint(address to, uint256 v) external { balanceOf[to] += v; }
  function burn(address from, uint256 v) external { balanceOf[from] -= v; }
}`;
const MOCK_ABI = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'burn', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
];
function compileMock() {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Mock.sol': { content: MOCK_SRC } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } },
  })));
  return `0x${out.contracts['Mock.sol'].MockToken.evm.deployedBytecode.object}`;
}
const MOCK_CODE = compileMock();

async function setup() {
  const vm = await makeVm();
  await fund(vm, OWNER);
  await fund(vm, ENTRY_POINT);
  await delegateTo(vm, OWNER);
  await vm.stateManager.putContractCode(new Address(hexToBytes(GUARD)), hexToBytes(guardArtifact.deployedBytecode));
  await vm.stateManager.putContractCode(new Address(hexToBytes(TOKEN)), hexToBytes(MOCK_CODE));
  return vm;
}

const snapshot = () => ({ target: GUARD, value: 0n, data: encodeFunctionData({ abi: GUARD_ABI, functionName: 'snapshot', args: [TOKEN, HOLDER] }) });
const assertGained = (min) => ({ target: GUARD, value: 0n, data: encodeFunctionData({ abi: GUARD_ABI, functionName: 'assertGained', args: [TOKEN, HOLDER, min] }) });
const mint = (v) => ({ target: TOKEN, value: 0n, data: encodeFunctionData({ abi: MOCK_ABI, functionName: 'mint', args: [HOLDER, v] }) });
const burn = (v) => ({ target: TOKEN, value: 0n, data: encodeFunctionData({ abi: MOCK_ABI, functionName: 'burn', args: [HOLDER, v] }) });

/** executeBatch from the EntryPoint: this is how the operation runs on chain. */
const batch = (vm, calls) => call(vm, {
  from: ENTRY_POINT, to: OWNER,
  data: encodeFunctionData({ abi: ABI, functionName: 'executeBatch', args: [calls.map((c) => ({ target: c.target, value: c.value, data: c.data }))] }),
});

test('a gain at or above the floor: the batch passes', async () => {
  const vm = await setup();
  const r = await batch(vm, [snapshot(), mint(95n), assertGained(95n)]);
  assert.equal(r.reverted, false, r.error);
});

test('a gain below the floor: the whole batch reverts with OutputBelowFloor', async () => {
  const vm = await setup();
  const r = await batch(vm, [snapshot(), mint(94n), assertGained(95n)]);
  assert.equal(r.reverted, true);
  assert.ok(r.returned.startsWith(GUARD_ERRORS.OutputBelowFloor), r.returned);
});

test('a balance that fell counts as zero gain rather than overflowing', async () => {
  const vm = await setup();
  await batch(vm, [mint(1000n)]);
  const r = await batch(vm, [snapshot(), burn(10n), assertGained(1n)]);
  assert.equal(r.reverted, true);
  assert.ok(r.returned.startsWith(GUARD_ERRORS.OutputBelowFloor));
});

test('a check without a snapshot in the same transaction: NoSnapshot', async () => {
  const vm = await setup();
  await batch(vm, [snapshot()]);
  // The snapshot lived in transient storage and died with the previous transaction.
  const r = await batch(vm, [mint(100n), assertGained(1n)]);
  assert.equal(r.reverted, true);
  assert.ok(r.returned.startsWith(GUARD_ERRORS.NoSnapshot), r.returned);
});

test('the check consumes the snapshot: a second check in the same batch is NoSnapshot', async () => {
  const vm = await setup();
  const r = await batch(vm, [snapshot(), mint(5n), assertGained(5n), assertGained(1n)]);
  assert.equal(r.reverted, true);
  assert.ok(r.returned.startsWith(GUARD_ERRORS.NoSnapshot));
});

test('a zero floor is rejected: such a check protects nothing', async () => {
  const vm = await setup();
  const r = await batch(vm, [snapshot(), mint(5n), assertGained(0n)]);
  assert.equal(r.reverted, true);
  assert.ok(r.returned.startsWith(GUARD_ERRORS.FloorIsZero));
});

test("someone else's snapshot does not count: the key includes the caller", async () => {
  const vm = await setup();
  const stranger = '0x3333333333333333333333333333333333333333';
  await fund(vm, stranger);
  // A foreign snapshot and our check cannot share a transaction without a
  // common contract; here the foreign call runs separately, and there is
  // still no snapshot for us.
  await call(vm, { from: stranger, to: GUARD, data: snapshot().data });
  const r = await batch(vm, [mint(100n), assertGained(1n)]);
  assert.equal(r.reverted, true);
  assert.ok(r.returned.startsWith(GUARD_ERRORS.NoSnapshot));
});

test('the guard accepts no ether and no unknown functions', async () => {
  const vm = await setup();
  const plain = await call(vm, { from: OWNER, to: GUARD, data: '0x', value: 1n });
  assert.equal(plain.reverted, true, 'sending ether to the guard reverts');
  const unknown = await call(vm, { from: OWNER, to: GUARD, data: '0xdeadbeef' });
  assert.equal(unknown.reverted, true, 'an unknown selector reverts');
});
