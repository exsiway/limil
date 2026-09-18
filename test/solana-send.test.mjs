import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  finalize, prepareForSigning, readSwapStatus, relayIndexBody, swapStatusPath, userSignerOf,
} from '../src/shared/solana-send.js';
import { bytesToBase64, serializeTransaction, writeCompactU16, encodeBase58, parseTransaction, base64ToBytes } from '../src/shared/solana-tx.js';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Uint8Array.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  return { pub, address: encodeBase58(pub), privateKey };
}
function messageV0(signers) {
  const parts = [Uint8Array.from([0x80, signers.length, 0, 0]), writeCompactU16(signers.length), ...signers, new Uint8Array(32).fill(3), writeCompactU16(0), writeCompactU16(0)];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

test('a buy: the relay transaction with the fee payer signature in slot 0 is co-signed by the user', () => {
  const feePayer = keypair();
  const user = keypair();
  const message = messageV0([feePayer.pub, user.pub]);
  const feeSig = sign(null, message, feePayer.privateKey);
  // The fee payer's signature is already in the transaction AND in a separate field.
  const tx = bytesToBase64(serializeTransaction({ signatures: [Uint8Array.from(feeSig), new Uint8Array(64)], message }));
  const { parsed, messageBase64 } = prepareForSigning({ tx, feePayerAddress: feePayer.address, feePayerSignature: bytesToBase64(feeSig) });
  assert.equal(messageBase64, bytesToBase64(message));
  assert.equal(userSignerOf(parsed), user.address, 'the only missing signer is the user');
  assert.equal(userSignerOf(parsed, user.address), user.address);

  const userSig = bytesToBase64(sign(null, message, user.privateKey));
  const { base64, txHash } = finalize(parsed, user.address, userSig);
  assert.equal(txHash, encodeBase58(feeSig), 'the hash is the first signature, the fee payer\'s');
  const again = parseTransaction(base64ToBytes(base64));
  assert.equal(bytesToBase64(again.signatures[1]), userSig);
  assert.throws(() => finalize(parsed, user.address, bytesToBase64(new Uint8Array(64))), /missing|signature/);
});

test('relay registration and status', () => {
  assert.deepEqual(relayIndexBody({ relaySwapId: '0xabc', txHash: '61dW' }), { chainId: 792703809, requestId: '0xabc', txHash: '61dW' });
  assert.equal(swapStatusPath('0xabc'), '/swaps/v2/status?relaySwapId=0xabc');
  assert.equal(readSwapStatus({ responseObject: { status: 'SUCCESS' } }), 'SUCCESS');
  assert.equal(readSwapStatus({}), null);
});

test('a sent transaction is judged by the node: landed, failed, dropped, or still pending', async () => {
  const { judgeSignatureStatus } = await import('../src/shared/solana-send.js');
  assert.equal(judgeSignatureStatus({ err: null, confirmationStatus: 'confirmed' }), 'landed');
  assert.equal(judgeSignatureStatus({ err: null, confirmationStatus: 'finalized' }), 'landed');
  assert.equal(judgeSignatureStatus({ err: null, confirmationStatus: 'processed' }), 'pending');
  assert.equal(judgeSignatureStatus({ err: { InstructionError: [2, { Custom: 6001 }] }, confirmationStatus: 'confirmed' }), 'failed');
  assert.equal(judgeSignatureStatus(null, { blockHeight: 100, lastValidBlockHeight: 150 }), 'pending');
  assert.equal(judgeSignatureStatus(null, { blockHeight: 151, lastValidBlockHeight: 150 }), 'expired');
  assert.equal(judgeSignatureStatus(null, { blockHeight: 151, lastValidBlockHeight: null }), 'pending', 'no window known: keep waiting');
});
