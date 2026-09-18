// A test bench for the contract on a local EVM.
//
// The contract controls access to funds, so it has to be checked by execution
// rather than by reasoning. There is no network here: the code is deployed in
// memory, calls go through the EVM, the state is real.
//
// EIP-7702 delegation is reproduced directly: the contract code is placed AT
// the owner's address. That is exactly how it works on chain, and exactly why
// address(this) inside the contract equals the owner's address.

import { VM } from '@ethereumjs/vm';
import { Chain, Common, Hardfork } from '@ethereumjs/common';
import { Account, Address, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { readFileSync } from 'node:fs';

export const ENTRY_POINT = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';

const artifact = JSON.parse(
  readFileSync('artifacts/contracts/LimilSessionAccount.json', 'utf8'),
);
export const ABI = artifact.abi;

export async function makeVm() {
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  return VM.create({ common });
}

const addr = (hex) => new Address(hexToBytes(hex));

/** Funds an address so calls do not fail on insufficient balance. */
export async function fund(vm, hex, wei = 10n ** 20n) {
  await vm.stateManager.putAccount(addr(hex), new Account(0n, wei));
}

/**
 * Deploys the contract code AT the owner's address, the way EIP-7702 does.
 * Otherwise address(this) inside the contract would be foreign, and the owner
 * check in validateUserOp would check the wrong thing.
 */
export async function delegateTo(vm, ownerHex) {
  await fund(vm, ownerHex);
  await vm.stateManager.putContractCode(addr(ownerHex), hexToBytes(artifact.deployedBytecode));
}

/**
 * Block time for calls.
 *
 * A local EVM defaults to zero, and any expiry check passes simply because
 * "now" precedes every date. A real time is set; otherwise the expired-key
 * test checks nothing.
 */
export const NOW = 1_800_000_000n;

function blockAt(timestamp) {
  return {
    header: {
      timestamp,
      number: 1n,
      coinbase: Address.zero(),
      difficulty: 0n,
      prevRandao: new Uint8Array(32),
      gasLimit: 30_000_000n,
      baseFeePerGas: 0n,
      cliqueSigner: () => Address.zero(),
      getBlobGasPrice: () => 0n,
    },
  };
}

/** A contract call. Returns the data and whether it reverted. */
export async function call(vm, { from, to, data, value = 0n, timestamp = NOW }) {
  const result = await vm.evm.runCall({
    caller: addr(from),
    to: addr(to),
    data: hexToBytes(data),
    value,
    gasLimit: 30_000_000n,
    block: blockAt(timestamp),
  });
  return {
    reverted: Boolean(result.execResult.exceptionError),
    error: result.execResult.exceptionError?.error ?? null,
    returned: bytesToHex(result.execResult.returnValue),
  };
}
