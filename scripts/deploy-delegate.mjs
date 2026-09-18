// Deploys the session-key account (the EIP-7702 delegate) through the
// deterministic CREATE2 deployer, so every chain gets the same address and it
// is known before sending (see DELEGATE_SALT / delegateFor in shared/chains.js).
//
//   CHAIN_ID=56 node scripts/deploy-delegate.mjs          # dry run
//   CHAIN_ID=56 node scripts/deploy-delegate.mjs --send   # send
//
// Gas is paid by the courier in secrets/courier.key (see new-courier.mjs).
// Running it again on a chain where the delegate already stands sends nothing.
// Version 2 of the contract stands at one address on every chain; the first
// version (LEGACY_DELEGATES in chains.js) is recognised but never deployed again.

import { readFile, readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, formatEther, http, concatHex, keccak256, getCreate2Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CHAINS, CREATE2_DELEGATE, DEFAULT_CHAIN_ID, DELEGATE_SALT, rpcUrl } from '../src/shared/chains.js';
// The artifact in artifacts/ is the live contract, deployed already on every
// supported chain; this script is for a chain it is not on yet.
import { CREATE2_DEPLOYER } from '../src/shared/output-guard.js';

const SEND = process.argv.includes('--send');
const chainId = Number(process.env.CHAIN_ID ?? DEFAULT_CHAIN_ID);
const chain = {
  id: chainId,
  name: CHAINS[chainId]?.name ?? `chain ${chainId}`,
  nativeCurrency: { name: CHAINS[chainId]?.native ?? 'ETH', symbol: CHAINS[chainId]?.native ?? 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl(chainId)] } },
};
const pub = createPublicClient({ chain, transport: http() });

const artifact = JSON.parse(readFileSync(new URL('../artifacts/contracts/LimilSessionAccount.json', import.meta.url), 'utf8'));
const address = getCreate2Address({ from: CREATE2_DEPLOYER, salt: DELEGATE_SALT, bytecodeHash: keccak256(artifact.bytecode) });
if (address.toLowerCase() !== CREATE2_DELEGATE.toLowerCase()) {
  console.error(`the artifact deploys to ${address}, but chains.js expects ${CREATE2_DELEGATE}.\n`
    + '  The bytecode changed (or the salt did). Either restore the source or update CREATE2_DELEGATE.');
  process.exit(2);
}

const already = await pub.getCode({ address });
if (already && already !== '0x') {
  const same = already.toLowerCase() === artifact.deployedBytecode.toLowerCase();
  console.log(`the delegate already stands on ${chain.name}: ${address}, code ${same ? 'matches the artifact' : 'DIFFERS from the artifact'}`);
  process.exit(same ? 0 : 1);
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
const data = concatHex([DELEGATE_SALT, artifact.bytecode]);
const gasPrice = await pub.getGasPrice();
let gas;
try {
  gas = await pub.estimateGas({ account: courier.address, to: CREATE2_DEPLOYER, data });
} catch (err) {
  console.error(`gas estimate failed on ${chain.name} (courier ${courier.address}, balance ${formatEther(balance)} ${chain.nativeCurrency.symbol}): ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`);
  process.exit(2);
}
console.log(`chain ${chain.name}, courier ${courier.address}, balance ${formatEther(balance)} ${chain.nativeCurrency.symbol}`);
console.log(`the delegate will stand at ${address}; gas ≈ ${gas}, price ${gasPrice} wei, total ≈ ${formatEther(gas * gasPrice)} ${chain.nativeCurrency.symbol}`);
console.log(`initcode hash ${keccak256(artifact.bytecode)}`);
if (!SEND) {
  console.log('dry run. To send: --send');
  process.exit(0);
}
const wallet = createWalletClient({ account: courier, chain, transport: http() });
const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data, gas: gas * 3n / 2n });
console.log(`sent: ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
const code = await pub.getCode({ address });
const ok = receipt.status === 'success' && code?.toLowerCase() === artifact.deployedBytecode.toLowerCase();
console.log(ok ? `the delegate stands: ${address}` : `NOT CONFIRMED: status ${receipt.status}, code ${code ? code.length : 0} characters`);
process.exit(ok ? 0 : 1);
