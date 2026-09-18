// A Solana transaction without libraries: enough to READ someone else's build
// before signing it, sign it, and send it.
//
// Relay and dflow return a READY transaction: the message is assembled and the
// fee payer's (FOMO's) signature is attached separately. What remains is to
// find the user's signature slot, put the Privy signature there and serialise
// it back. That needs: parsing the signature array, reading the static keys of
// the message (signers come first, in signature order) and reassembling.
//
// Signing what one has not read is the same as signing anything, so the
// message is parsed in full as well: header, static keys, blockhash, every
// instruction (program, accounts, data) and, for version-0 messages, the
// address table lookups. The judgement of what the instructions DO lives in
// shared/solana-guard.js; this module only takes the bytes apart.

import { decodeBase58, encodeBase58 } from './base58.js';

const SIGNATURE_BYTES = 64;
const PUBKEY_BYTES = 32;

export function base64ToBytes(text) {
  const bin = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

/** compact-u16 as in Solana: up to three bytes of seven bits. */
export function readCompactU16(bytes, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const b = bytes[pos];
    if (b === undefined) throw new Error('truncated compact-u16');
    pos += 1;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 14) throw new Error('compact-u16 longer than three bytes');
  }
  return { value, next: pos };
}

export function writeCompactU16(value) {
  const out = [];
  let v = value;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(b); break; }
    b |= 0x80;
    out.push(b);
  }
  return Uint8Array.from(out);
}

/** Parses a serialised transaction: signatures and message separately. */
export function parseTransaction(bytes) {
  const { value: count, next } = readCompactU16(bytes, 0);
  const signatures = [];
  let pos = next;
  for (let i = 0; i < count; i += 1) {
    signatures.push(bytes.slice(pos, pos + SIGNATURE_BYTES));
    pos += SIGNATURE_BYTES;
  }
  if (pos > bytes.length) throw new Error('more signatures than bytes');
  return { signatures, message: bytes.slice(pos) };
}

/**
 * Parses the message header and static keys. Version 0 starts with a
 * 0x80|version byte, legacy starts with the header directly.
 */
export function parseMessageKeys(message) {
  return parseMessage(message, { keysOnly: true });
}

/** Reads `count` bytes as indexes. */
function readIndexes(bytes, pos) {
  const { value: count, next } = readCompactU16(bytes, pos);
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const b = bytes[next + i];
    if (b === undefined) throw new Error('truncated index list');
    list.push(b);
  }
  return { list, next: next + count };
}

/**
 * Parses a whole message.
 *
 * @returns {{
 *   version: 'legacy'|number, numRequiredSignatures: number, numReadonlySigned: number,
 *   numReadonlyUnsigned: number, keys: string[], recentBlockhash: string,
 *   instructions: {programIdIndex: number, accountIndexes: number[], data: Uint8Array}[],
 *   addressTableLookups: {account: string, writableIndexes: number[], readonlyIndexes: number[]}[],
 * }}
 */
export function parseMessage(message, { keysOnly = false } = {}) {
  let pos = 0;
  let version = 'legacy';
  if ((message[0] & 0x80) !== 0) {
    version = message[0] & 0x7f;
    pos = 1;
  }
  if (version !== 'legacy' && version !== 0) throw new Error(`unsupported message version ${version}`);
  const numRequiredSignatures = message[pos];
  const numReadonlySigned = message[pos + 1];
  const numReadonlyUnsigned = message[pos + 2];
  pos += 3;
  const { value: count, next } = readCompactU16(message, pos);
  pos = next;
  const keys = [];
  for (let i = 0; i < count; i += 1) {
    if (pos + PUBKEY_BYTES > message.length) throw new Error('truncated account keys');
    keys.push(encodeBase58(message.slice(pos, pos + PUBKEY_BYTES)));
    pos += PUBKEY_BYTES;
  }
  if (pos + PUBKEY_BYTES > message.length) throw new Error('truncated blockhash');
  const recentBlockhash = encodeBase58(message.slice(pos, pos + PUBKEY_BYTES));
  pos += PUBKEY_BYTES;
  const out = { version, numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned, keys, recentBlockhash, instructions: [], addressTableLookups: [] };
  if (keysOnly) return out;

  const { value: nIx, next: afterN } = readCompactU16(message, pos);
  pos = afterN;
  for (let i = 0; i < nIx; i += 1) {
    const programIdIndex = message[pos];
    if (programIdIndex === undefined) throw new Error('truncated instruction');
    pos += 1;
    const accounts = readIndexes(message, pos);
    pos = accounts.next;
    const { value: dataLen, next: dataStart } = readCompactU16(message, pos);
    if (dataStart + dataLen > message.length) throw new Error('truncated instruction data');
    out.instructions.push({ programIdIndex, accountIndexes: accounts.list, data: message.slice(dataStart, dataStart + dataLen) });
    pos = dataStart + dataLen;
  }

  if (version === 0) {
    const { value: nLookups, next: afterL } = readCompactU16(message, pos);
    pos = afterL;
    for (let i = 0; i < nLookups; i += 1) {
      if (pos + PUBKEY_BYTES > message.length) throw new Error('truncated address table lookup');
      const account = encodeBase58(message.slice(pos, pos + PUBKEY_BYTES));
      pos += PUBKEY_BYTES;
      const writable = readIndexes(message, pos);
      pos = writable.next;
      const readonly = readIndexes(message, pos);
      pos = readonly.next;
      out.addressTableLookups.push({ account, writableIndexes: writable.list, readonlyIndexes: readonly.list });
    }
  }
  if (pos !== message.length) throw new Error(`${message.length - pos} trailing bytes after the message`);
  return out;
}

/** Size of the AddressLookupTable account header before the addresses start. */
export const LOOKUP_TABLE_META_SIZE = 56;

/** Addresses stored in an address lookup table account (raw account data). */
export function parseLookupTable(data) {
  if (data.length < LOOKUP_TABLE_META_SIZE) throw new Error('lookup table account too short');
  const body = data.slice(LOOKUP_TABLE_META_SIZE);
  if (body.length % PUBKEY_BYTES !== 0) throw new Error('lookup table body is not whole addresses');
  const out = [];
  for (let pos = 0; pos < body.length; pos += PUBKEY_BYTES) out.push(encodeBase58(body.slice(pos, pos + PUBKEY_BYTES)));
  return out;
}

/**
 * The full account list of a parsed message in the order instructions index
 * it: static keys, then every lookup's writable addresses, then every lookup's
 * readonly addresses.
 *
 * @param {ReturnType<typeof parseMessage>} parsed
 * @param {Map<string, string[]>} tables lookup table address → its addresses
 */
export function resolveAccountKeys(parsed, tables = new Map()) {
  const keys = [...parsed.keys];
  const loaded = { writable: [], readonly: [] };
  for (const lookup of parsed.addressTableLookups) {
    const table = tables.get(lookup.account);
    if (!table) throw new Error(`address lookup table ${lookup.account} was not resolved`);
    for (const i of lookup.writableIndexes) {
      if (table[i] === undefined) throw new Error(`lookup index ${i} outside table ${lookup.account}`);
      loaded.writable.push(table[i]);
    }
    for (const i of lookup.readonlyIndexes) {
      if (table[i] === undefined) throw new Error(`lookup index ${i} outside table ${lookup.account}`);
      loaded.readonly.push(table[i]);
    }
  }
  return [...keys, ...loaded.writable, ...loaded.readonly];
}

/** Whether the account at `index` is a signer / writable, by the header rules. */
export function accountMeta(parsed, index, totalWritableLoaded = 0) {
  const n = parsed.keys.length;
  const { numRequiredSignatures: s, numReadonlySigned: rs, numReadonlyUnsigned: ru } = parsed;
  if (index < n) {
    const signer = index < s;
    const writable = signer ? index < s - rs : index < n - ru;
    return { signer, writable };
  }
  return { signer: false, writable: index - n < totalWritableLoaded };
}

/** Signature slot index for an address. Signers are the first N keys. */
export function signerIndex(message, address) {
  const { keys, numRequiredSignatures } = parseMessageKeys(message);
  const i = keys.findIndex((k) => k === address);
  if (i < 0) throw new Error(`address ${address} takes no part in the transaction`);
  if (i >= numRequiredSignatures) throw new Error(`address ${address} is in the transaction but no signature is expected from it`);
  return i;
}

/** Places a signature (base64 or bytes) into the address's slot; returns a new set. */
export function withSignature({ signatures, message }, address, signature) {
  const sig = typeof signature === 'string' ? base64ToBytes(signature) : Uint8Array.from(signature);
  if (sig.length !== SIGNATURE_BYTES) throw new Error(`a signature must be 64 bytes, not ${sig.length}`);
  const { numRequiredSignatures } = parseMessageKeys(message);
  const list = signatures.map((s) => Uint8Array.from(s));
  while (list.length < numRequiredSignatures) list.push(new Uint8Array(SIGNATURE_BYTES));
  list[signerIndex(message, address)] = sig;
  return { signatures: list, message };
}

export function serializeTransaction({ signatures, message }) {
  const head = writeCompactU16(signatures.length);
  const out = new Uint8Array(head.length + signatures.length * SIGNATURE_BYTES + message.length);
  out.set(head, 0);
  let pos = head.length;
  for (const s of signatures) { out.set(s, pos); pos += SIGNATURE_BYTES; }
  out.set(message, pos);
  return out;
}

/** Required signers whose slot is still empty (all zero). */
export function missingSigners({ signatures, message }) {
  const { keys, numRequiredSignatures } = parseMessageKeys(message);
  const missing = [];
  for (let i = 0; i < numRequiredSignatures; i += 1) {
    const s = signatures[i];
    if (!s || s.every((b) => b === 0)) missing.push(keys[i]);
  }
  return missing;
}

/** The transaction signature is its first signature in base58; it doubles as the tx hash. */
export function transactionSignature({ signatures }) {
  return encodeBase58(signatures[0]);
}

export { decodeBase58, encodeBase58 };
