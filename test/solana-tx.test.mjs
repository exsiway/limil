import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  base64ToBytes, bytesToBase64, missingSigners, parseMessageKeys, parseTransaction, readCompactU16,
  serializeTransaction, signerIndex, transactionSignature, withSignature, writeCompactU16, encodeBase58,
} from '../src/shared/solana-tx.js';

/** A node ed25519 key pair: the raw public key is the last 32 bytes of the DER. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { pub: Uint8Array.from(pub), address: encodeBase58(pub), privateKey };
}

/** A version-0 message with the given signers and one ordinary key. */
function messageV0(signers, others) {
  const keys = [...signers, ...others];
  const parts = [Uint8Array.from([0x80, signers.length, 0, others.length]), writeCompactU16(keys.length), ...keys,
    new Uint8Array(32).fill(7), // blockhash
    writeCompactU16(0), // instructions
    writeCompactU16(0)]; // address tables
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

test('compact-u16 round-trips', () => {
  for (const n of [0, 1, 127, 128, 300, 16383]) {
    const bytes = writeCompactU16(n);
    assert.equal(readCompactU16(bytes, 0).value, n);
  }
});

test('a relay transaction: the user slot is found, the signature placed, the hash is the first signature', () => {
  const feePayer = keypair();
  const user = keypair();
  const other = keypair();
  const message = messageV0([feePayer.pub, user.pub], [other.pub]);
  // As relay returns it: two empty signatures, the fee payer's signature separate.
  const raw = serializeTransaction({ signatures: [new Uint8Array(64), new Uint8Array(64)], message });
  const parsed = parseTransaction(raw);
  assert.equal(parsed.signatures.length, 2);
  assert.deepEqual([...parsed.message], [...message]);
  const keys = parseMessageKeys(message);
  assert.equal(keys.version, 0);
  assert.equal(keys.numRequiredSignatures, 2);
  assert.equal(keys.keys[1], user.address);
  assert.equal(signerIndex(message, user.address), 1);
  assert.throws(() => signerIndex(message, other.address), /no signature is expected/);

  const feeSig = sign(null, message, feePayer.privateKey);
  const userSig = sign(null, message, user.privateKey);
  let tx = withSignature(parsed, feePayer.address, bytesToBase64(feeSig));
  assert.deepEqual(missingSigners(tx), [user.address]);
  tx = withSignature(tx, user.address, bytesToBase64(userSig));
  assert.deepEqual(missingSigners(tx), []);
  const bytes = serializeTransaction(tx);
  const again = parseTransaction(bytes);
  assert.deepEqual([...again.signatures[1]], [...userSig]);
  assert.equal(transactionSignature(tx), encodeBase58(feeSig));
  assert.equal(bytesToBase64(base64ToBytes(bytesToBase64(bytes))), bytesToBase64(bytes));
});

test('a legacy message reads the same way', () => {
  const a = keypair();
  const message = Uint8Array.from([1, 0, 0, ...writeCompactU16(1), ...a.pub, ...new Uint8Array(32), 0]);
  const keys = parseMessageKeys(message);
  assert.equal(keys.version, 'legacy');
  assert.equal(keys.keys[0], a.address);
  assert.equal(signerIndex(message, a.address), 0);
});
