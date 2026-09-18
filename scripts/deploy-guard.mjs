// Deploys the output guard through the deterministic CREATE2 deployer, so the
// address is the same on every chain and known in advance (GUARD_ADDRESS).
//
//   CHAIN_ID=4663 node scripts/deploy-guard.mjs          # dry run
//   CHAIN_ID=4663 node scripts/deploy-guard.mjs --send   # send
//
// Gas is paid by the courier in secrets/courier.key (see new-courier.mjs).
// Running it again on a chain where the guard already stands sends nothing.

import { readFile, readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http, concatHex, keccak256, getCreate2Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CHAINS, DEFAULT_CHAIN_ID, rpcUrl } from '../src/shared/chains.js';
import { CREATE2_DEPLOYER, GUARD_ADDRESS, GUARD_SALT } from '../src/shared/output-guard.js';

const SEND = process.argv.includes('--send');
const chainId = Number(process.env.CHAIN_ID ?? DEFAULT_CHAIN_ID);
const chain = {
  id: chainId,
  name: CHAINS[chainId]?.name ?? `chain ${chainId}`,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl(chainId)] } },
};
const pub = createPublicClient({ chain, transport: http() });

const artifact = JSON.parse(readFileSync(new URL('../artifacts/contracts/LimilOutputGuard.json', import.meta.url), 'utf8'));

// The last 53 bytes of the runtime are solc's CBOR metadata: a hash of the
// source text, which changes with any comment edit. The executable part is
// what has to match.
const METADATA_BYTES = 53;
const executable = (code) => String(code ?? '').toLowerCase().slice(0, -METADATA_BYTES * 2);
const sameCode = (code) => executable(code) === executable(artifact.deployedBytecode);

const already = await pub.getCode({ address: GUARD_ADDRESS });
if (already && already !== '0x') {
  const same = sameCode(already);
  console.log(`the guard already stands on ${chain.name}: ${GUARD_ADDRESS}, code ${same ? 'matches the artifact' : 'DIFFERS from the artifact'}`);
  process.exit(same ? 0 : 1);
}

// GUARD_ADDRESS is fixed by the ORIGINAL initcode. A recompiled artifact
// carries other metadata and would land at another address, so the initcode
// is rebuilt from the runtime already on chain: the constructor prefix of the
// artifact plus the deployed runtime of a chain where the guard stands.
let initcode = artifact.bytecode;
let landsAt = getCreate2Address({ from: CREATE2_DEPLOYER, salt: GUARD_SALT, bytecodeHash: keccak256(initcode) });
if (landsAt.toLowerCase() !== GUARD_ADDRESS.toLowerCase()) {
  const source = createPublicClient({ transport: http(rpcUrl(DEFAULT_CHAIN_ID)) });
  const runtime = await source.getCode({ address: GUARD_ADDRESS });
  if (!runtime || runtime === '0x') {
    console.error(`the artifact would land at ${landsAt}, not ${GUARD_ADDRESS}, and no deployed runtime is available on chain ${DEFAULT_CHAIN_ID} to rebuild the initcode from`);
    process.exit(2);
  }
  if (!sameCode(runtime)) {
    console.error('the deployed guard differs from the artifact in its executable part, the source changed. Refusing to deploy a different contract at the same address.');
    process.exit(2);
  }
  const prefix = artifact.bytecode.slice(0, artifact.bytecode.length - artifact.deployedBytecode.length + 2);
  initcode = prefix + runtime.slice(2);
  landsAt = getCreate2Address({ from: CREATE2_DEPLOYER, salt: GUARD_SALT, bytecodeHash: keccak256(initcode) });
  if (landsAt.toLowerCase() !== GUARD_ADDRESS.toLowerCase()) {
    console.error(`rebuilt initcode lands at ${landsAt}, not ${GUARD_ADDRESS}, refusing`);
    process.exit(2);
  }
  console.log(`initcode rebuilt from the runtime on chain ${DEFAULT_CHAIN_ID} (the artifact's metadata differs)`);
}
const deployerCode = await pub.getCode({ address: CREATE2_DEPLOYER });
if (!deployerCode || deployerCode === '0x') {
  console.error(`no deterministic deployer ${CREATE2_DEPLOYER} on ${chain.name}`);
  process.exit(2);
}

let raw;
try {
  raw = (await new Promise((res, rej) => readFile(new URL('../secrets/courier.key', import.meta.url), 'utf8', (e, d) => (e ? rej(e) : res(d))))).trim();
} catch {
  console.error('no secrets/courier.key, put the private key of a courier with gas there (npm run courier)');
  process.exit(2);
}
const courier = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
const balance = await pub.getBalance({ address: courier.address });
const data = concatHex([GUARD_SALT, initcode]);
const gas = await pub.estimateGas({ account: courier.address, to: CREATE2_DEPLOYER, data });
const gasPrice = await pub.getGasPrice();
console.log(`chain ${chain.name}, courier ${courier.address}, balance ${formatEther(balance)} ETH`);
console.log(`the guard will stand at ${GUARD_ADDRESS}; gas ≈ ${gas}, price ${gasPrice} wei, total ≈ ${formatEther(gas * gasPrice)} ETH`);
console.log(`initcode hash ${keccak256(initcode)}`);
if (!SEND) {
  console.log('dry run. To send: --send');
  process.exit(0);
}
const wallet = createWalletClient({ account: courier, chain, transport: http() });
const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data, gas: gas * 3n / 2n });
console.log(`sent: ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
const code = await pub.getCode({ address: GUARD_ADDRESS });
const ok = receipt.status === 'success' && Boolean(code) && sameCode(code);
console.log(ok ? `the guard stands: ${GUARD_ADDRESS}` : `NOT CONFIRMED: status ${receipt.status}, code ${code ? code.length : 0} characters`);
process.exit(ok ? 0 : 1);
