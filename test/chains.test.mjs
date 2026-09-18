import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { keccak256, getCreate2Address, stringToHex } from 'viem';
import { readFileSync, existsSync } from 'node:fs';

import {
  CREATE2_DELEGATE, CREATE2_DELEGATE_V1, CREATE2_DELEGATE_V2, CREATE2_DELEGATE_V3, DELEGATES, DELEGATE_SALT,
  DELEGATE_SALT_V3, LEGACY_DELEGATES, LIMIL_DELEGATE_V1, delegateFor, isLegacyDelegate, isLimilDelegate,
} from '../src/shared/chains.js';
import { CREATE2_DEPLOYER } from '../src/shared/output-guard.js';

test('the delegate is known per chain, and unknown chains get none', () => {
  assert.equal(delegateFor(4663), CREATE2_DELEGATE);
  assert.equal(delegateFor(56), CREATE2_DELEGATE);
  assert.equal(delegateFor(8453), CREATE2_DELEGATE);
  assert.equal(delegateFor(1), null, 'Ethereum has no deployment');
  assert.equal(delegateFor('4663'), CREATE2_DELEGATE);
  // Version 2 everywhere: the first version is never delegated to again.
  for (const d of Object.values(DELEGATES)) assert.equal(isLegacyDelegate(d), false);
});

test('any of our delegates is recognised regardless of case, the first version as legacy', () => {
  for (const d of [...Object.values(DELEGATES), ...Object.values(LEGACY_DELEGATES)]) {
    assert.equal(isLimilDelegate(d.toUpperCase().replace('0X', '0x')), true);
  }
  assert.equal(isLegacyDelegate(LIMIL_DELEGATE_V1.toLowerCase()), true);
  assert.equal(isLegacyDelegate(CREATE2_DELEGATE_V1), true);
  assert.equal(isLegacyDelegate(CREATE2_DELEGATE_V2), true, 'the second version is recognised but never used again');
  assert.equal(isLegacyDelegate(CREATE2_DELEGATE), false);
  assert.equal(isLimilDelegate('0x1111111111111111111111111111111111111111'), false);
  assert.equal(isLimilDelegate(null), false);
  assert.equal(isLegacyDelegate(null), false);
});

test('the live delegate is version 3, and its address follows from the source', () => {
  // Version 3 holds live grants on three chains. Its source is kept exactly
  // as deployed, so the address stays reproducible from this tree.
  assert.equal(DELEGATE_SALT, DELEGATE_SALT_V3);
  assert.equal(CREATE2_DELEGATE, CREATE2_DELEGATE_V3);
  assert.equal(DELEGATE_SALT_V3, keccak256(stringToHex('limil.session-account.v3')));
  const path = 'artifacts/contracts/LimilSessionAccount.json';
  if (!existsSync(path)) return; // no artifact without npm run build:contract
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const expected = getCreate2Address({ from: CREATE2_DEPLOYER, salt: DELEGATE_SALT_V3, bytecodeHash: keccak256(artifact.bytecode) });
  assert.equal(expected, CREATE2_DELEGATE_V3, 'the source no longer reproduces the deployed contract');
});
