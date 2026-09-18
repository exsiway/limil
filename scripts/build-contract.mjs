// Compiles the contracts.
//
// A separate script rather than part of the extension build: the contracts
// change rarely, and their artifacts are needed by the tests and the deploy.
//
//   node scripts/build-contract.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import solc from 'solc';

// Two sources: the delegate account and the output guard, both kept exactly
// as deployed so their addresses stay reproducible from this tree.
const BUILDS = [
  { name: 'LimilSessionAccount', file: 'contracts/LimilSessionAccount.sol', out: 'LimilSessionAccount' },
  { name: 'LimilOutputGuard', file: 'contracts/LimilOutputGuard.sol', out: 'LimilOutputGuard' },
];

for (const b of BUILDS) compile(b);

function compile({ name: NAME, file, out: OUT }) {
  const source = readFileSync(file, 'utf8');

  const input = {
    language: 'Solidity',
    sources: { [`${NAME}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // The target is fixed explicitly: the contract runs as delegate code,
      // and compiler defaults are not something to rely on here.
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  for (const e of out.errors ?? []) console.log(`${e.severity}: ${e.formattedMessage.trim()}`);
  if (errors.length) process.exit(1);

  const c = out.contracts[`${NAME}.sol`][NAME];
  mkdirSync('artifacts/contracts', { recursive: true });
  writeFileSync(`artifacts/contracts/${OUT}.json`, JSON.stringify({
    abi: c.abi,
    bytecode: `0x${c.evm.bytecode.object}`,
    deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
  }, null, 2));

  const size = c.evm.deployedBytecode.object.length / 2;
  console.log(`${OUT}: ${size} bytes of runtime`);
  // EIP-170 limits a contract to 24576 bytes; learning that at deploy time
  // costs gas.
  if (size > 24576) {
    console.error(`EIP-170 limit (24576) exceeded: ${size}`);
    process.exit(1);
  }
  console.log(`artifact: artifacts/contracts/${OUT}.json`);
}
