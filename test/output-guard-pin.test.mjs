// The output guard's executable bytecode is pinned to what stands on chain.
//
// The guard at GUARD_ADDRESS was deployed from an earlier compilation of the
// same source. Its executable code is byte for byte what the artifact produces
// today, but solc appends CBOR metadata to every runtime, and that metadata
// carries a hash of the source text and the compiler settings: a comment, a
// path or a solc patch level changes it. The metadata has drifted since the
// deployment, so the artifact's initcode hashes differently and its CREATE2
// address is no longer GUARD_ADDRESS. That is why the address cannot be
// recomputed from the artifact the way test/chains.test.mjs does for the
// account, and why scripts/deploy-guard.mjs rebuilds the initcode from the
// runtime already on chain rather than from the artifact.
//
// What CAN be pinned is the part that runs. The last two bytes of the runtime
// encode the metadata length; everything before the metadata is the
// executable, and its hash must stay what it was when the guard was
// deployed. A change here means the guard source changed, and a new guard
// would have to be deployed at a new address.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { keccak256 } from 'viem';

const ARTIFACT = 'artifacts/contracts/LimilOutputGuard.json';

/** keccak256 of the executable runtime of the deployed guard, metadata stripped. */
const DEPLOYED_EXECUTABLE_HASH = '0xa76f4fb384ecdf6c117f307aef5572447d0609adccdfdb18ad97426f2958c1d7';

/** The runtime without its CBOR metadata; the trailing two bytes give the metadata length. */
function executablePart(runtime) {
  const hex = String(runtime).toLowerCase().replace(/^0x/, '');
  const metadataBytes = parseInt(hex.slice(-4), 16);
  // Two more bytes for the length field itself.
  const cut = (metadataBytes + 2) * 2;
  assert.ok(cut < hex.length, 'the metadata length exceeds the runtime');
  return `0x${hex.slice(0, hex.length - cut)}`;
}

test('the compiled guard executes exactly what is deployed at GUARD_ADDRESS', () => {
  if (!existsSync(ARTIFACT)) return; // no artifact without npm run build:contract
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const executable = executablePart(artifact.deployedBytecode);
  // The metadata starts with a CBOR map whose first key is "ipfs" (0xa2 0x64 'ipfs').
  const hex = artifact.deployedBytecode.toLowerCase().replace(/^0x/, '');
  assert.equal(hex.slice(executable.length - 2, executable.length + 6), 'a2646970', 'the cut lands at the start of the metadata');
  assert.equal(keccak256(executable), DEPLOYED_EXECUTABLE_HASH, 'the guard source changed: the deployed guard no longer matches it');
});
