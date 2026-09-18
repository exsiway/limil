// Publishes the contract sources to Sourcify, so anyone can read on an
// explorer the code their wallet is delegated to.
//
// Sourcify is used rather than one explorer's own form because the address is
// the same on every chain and Sourcify is explorer-independent: Blockscout and
// several others read its result, so one submission per chain covers them.
//
// Nothing here spends gas or needs a key. The contracts are already deployed;
// verification only links source to bytecode that is on chain already.
//
//   node scripts/verify-contract.mjs            # check, submit nothing
//   node scripts/verify-contract.mjs --send     # submit
//
// The check compares what solc produces here with the runtime code the chain
// returns, ignoring the CBOR metadata tail, which is what docs/CONTRACTS.md
// tells a reader to do by hand.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { CREATE2_DELEGATE_V3, rpcUrl } from '../src/shared/chains.js';
import { GUARD_ADDRESS } from '../src/shared/output-guard.js';

const require = createRequire(import.meta.url);
const solc = require('solc');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEND = process.argv.includes('--send');
const SOURCIFY = 'https://sourcify.dev/server';

/** The chains the contracts stand on. One address each, by construction. */
const CHAINS = [4663, 8453, 56];

const TARGETS = [
  { name: 'LimilSessionAccount', file: 'contracts/LimilSessionAccount.sol', address: CREATE2_DELEGATE_V3 },
  { name: 'LimilOutputGuard', file: 'contracts/LimilOutputGuard.sol', address: GUARD_ADDRESS },
];

/**
 * The compiler input, identical to scripts/build-contract.mjs. It has to be:
 * any difference in these settings produces different bytecode, and then
 * nothing matches what is on chain.
 */
function standardInput(name, file) {
  return {
    language: 'Solidity',
    sources: { [`${name}.sol`]: { content: readFileSync(resolve(ROOT, file), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
}

/** solc's long version, the form Sourcify expects: 0.8.28+commit.7893614a */
function compilerVersion() {
  const [head] = solc.version().split('.Emscripten');
  return head;
}

function compiled(name, file) {
  const out = JSON.parse(solc.compile(JSON.stringify(standardInput(name, file))));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage.trim());
    process.exit(1);
  }
  return out.contracts[`${name}.sol`][name].evm.deployedBytecode.object;
}

/** Runtime code as the chain has it. */
async function codeOnChain(chainId, address) {
  const res = await fetch(rpcUrl(chainId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return String(body.result ?? '0x').replace(/^0x/, '');
}

/**
 * Everything before solc's CBOR metadata, which differs between builds of the
 * same source and is not part of what the contract does. The tail is the last
 * two bytes (its own length) plus that many bytes.
 */
function executablePart(hex) {
  if (hex.length < 4) return hex;
  const len = parseInt(hex.slice(-4), 16);
  const tail = (len + 2) * 2;
  return tail < hex.length ? hex.slice(0, hex.length - tail) : hex;
}

async function already(chainId, address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${chainId}/${address}`);
  const body = await res.json().catch(() => ({}));
  return body?.match ?? null;
}

async function submit(chainId, target, input) {
  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${target.address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stdJsonInput: input,
      compilerVersion: compilerVersion(),
      contractIdentifier: `${target.name}.sol:${target.name}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { ok: true, text: 'already verified' };
  if (!res.ok) throw new Error(body?.customCode ?? body?.message ?? `HTTP ${res.status}`);
  const id = body?.verificationId;
  // No job id means nothing to wait on and nothing proven; it is not a success.
  if (!id) return { ok: false, text: 'submitted, but the server returned no job to follow' };
  // The job is asynchronous; wait for it rather than reporting a guess.
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => { setTimeout(r, 2000); });
    const job = await fetch(`${SOURCIFY}/v2/verify/${id}`).then((r) => r.json()).catch(() => null);
    if (job?.isJobCompleted) {
      if (job?.error) return { ok: false, text: `failed: ${job.error.customCode ?? job.error.message}` };
      return { ok: true, text: `verified (${job?.contract?.match ?? 'match'})` };
    }
  }
  // Still running is not verified. Saying so in the exit status matters:
  // something that runs this in a chain would otherwise take it for done.
  return { ok: false, text: 'still running, not confirmed; run again to check' };
}

console.log(`solc ${compilerVersion()}, optimizer 200 runs, evmVersion cancun`);
console.log(SEND ? 'submitting to Sourcify' : 'checking only, pass --send to submit');

let bad = 0;
for (const target of TARGETS) {
  const local = compiled(target.name, target.file);
  console.log(`\n${target.name} at ${target.address}`);
  for (const chainId of CHAINS) {
    let line = `  ${String(chainId).padEnd(5)}`;
    try {
      const onChain = await codeOnChain(chainId, target.address);
      if (!onChain) { console.log(`${line} no code at this address`); bad += 1; continue; }
      const same = executablePart(onChain) === executablePart(local);
      const match = await already(chainId, target.address);
      if (!same) { console.log(`${line} BYTECODE DIFFERS, not submitting`); bad += 1; continue; }
      if (match) { console.log(`${line} bytecode matches, already on Sourcify (${match})`); continue; }
      if (!SEND) { console.log(`${line} bytecode matches, ready to submit`); continue; }
      const result = await submit(chainId, target, standardInput(target.name, target.file));
      console.log(`${line} ${result.text}`);
      if (!result.ok) bad += 1;
    } catch (err) {
      console.log(`${line} ${String(err?.message ?? err)}`);
      bad += 1;
    }
  }
}

if (bad) { console.log(`\n${bad} target(s) need a look`); process.exit(1); }
