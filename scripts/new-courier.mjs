// Creates a gas courier wallet for the deploy scripts.
//
// The courier is an ordinary EOA that only pays gas, e.g. for deploying the
// output guard on another chain. It controls nothing else and there is no
// reason to keep more than a few dollars on it.
//
//   node scripts/new-courier.mjs
//
// The key is written to secrets/courier.key with mode 0600. The secrets/
// directory is not tracked by git. An existing file is NOT overwritten,
// otherwise access to an already funded wallet could be lost.

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, formatEther, http } from 'viem';

import { CHAINS, DEFAULT_CHAIN_ID, rpcUrl } from '../src/shared/chains.js';

const path = new URL('../secrets/courier.key', import.meta.url);
const chainId = Number(process.env.CHAIN_ID ?? DEFAULT_CHAIN_ID);

if (existsSync(path)) {
  console.log('A courier already exists, the file is left alone.');
} else {
  const key = generatePrivateKey();
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  console.log('Courier created, key written to secrets/courier.key (mode 0600).');
}

const raw = (await readFile(path, 'utf8')).trim();
const account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
console.log(`Address: ${account.address}`);

const client = createPublicClient({
  chain: {
    id: chainId,
    name: CHAINS[chainId]?.name ?? `chain ${chainId}`,
    nativeCurrency: { name: 'native', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl(chainId)] } },
  },
  transport: http(),
});

const balance = await client.getBalance({ address: account.address });
const gasPrice = await client.getGasPrice();
// A guard deploy is well under 1M gas; keep a margin.
const needed = gasPrice * 1_100_000n;

console.log(`\nChain: ${CHAINS[chainId]?.name ?? chainId}`);
console.log(`Balance: ${formatEther(balance)}`);
console.log(`Needed for a deploy: ~${formatEther(needed)} (with margin)`);

if (balance >= needed) {
  console.log('\nEnough gas. Next: CHAIN_ID=... node scripts/deploy-guard.mjs');
} else {
  console.log(`\nFund this address with the chain's native token, about ${formatEther(needed)}:`);
  console.log(`  ${account.address}`);
  console.log('Then run this command again to check the balance.');
}
