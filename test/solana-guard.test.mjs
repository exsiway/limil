// What the wallet is allowed to sign on Solana: decoded instructions and
// simulated effects, both against transactions built by someone else.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';

import {
  LOOKUP_TABLE_META_SIZE, bytesToBase64, decodeBase58, encodeBase58, parseLookupTable, parseMessage, parseTransaction,
  resolveAccountKeys, serializeTransaction, writeCompactU16,
} from '../src/shared/solana-tx.js';
import {
  MAX_LAMPORT_SPEND, PROGRAMS, WSOL_MINT, guardSolanaTransaction, inspectInstructions, judgeEffects,
} from '../src/shared/solana-guard.js';

// ------------------------------------------------------------- builders

const key = () => Uint8Array.from(randomBytes(32));
const addr = (bytes) => encodeBase58(bytes);
const u64 = (v) => { const out = new Uint8Array(8); let n = BigInt(v); for (let i = 0; i < 8; i += 1) { out[i] = Number(n & 255n); n >>= 8n; } return out; };
const u32 = (v) => Uint8Array.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]);
const cat = (...parts) => { const total = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(total); let pos = 0; for (const p of parts) { out.set(p, pos); pos += p.length; } return out; };

const TOKEN_PROGRAM = decodeBase58(PROGRAMS.TOKEN);
const SYSTEM_PROGRAM = decodeBase58(PROGRAMS.SYSTEM);
const SWAP_PROGRAM = key();

/**
 * A version-0 message. `keys` are the static keys (signers first);
 * instructions name accounts by index into the resolved list.
 */
function messageV0({ signers, others, instructions, lookups = [] }) {
  const keys = [...signers, ...others];
  const parts = [
    Uint8Array.from([0x80, signers.length, 0, 0]),
    writeCompactU16(keys.length), ...keys,
    new Uint8Array(32).fill(7),
    writeCompactU16(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push(Uint8Array.from([ix.programIdIndex]), writeCompactU16(ix.accounts.length), Uint8Array.from(ix.accounts), writeCompactU16(ix.data.length), Uint8Array.from(ix.data));
  }
  parts.push(writeCompactU16(lookups.length));
  for (const l of lookups) {
    parts.push(l.account, writeCompactU16(l.writable.length), Uint8Array.from(l.writable), writeCompactU16(l.readonly.length), Uint8Array.from(l.readonly));
  }
  return cat(...parts);
}

const tokenTransfer = (amount) => cat(Uint8Array.from([3]), u64(amount));
const tokenTransferChecked = (amount, decimals) => cat(Uint8Array.from([12]), u64(amount), Uint8Array.from([decimals]));
const tokenApprove = (amount) => cat(Uint8Array.from([4]), u64(amount));
const tokenSetAuthority = () => Uint8Array.from([6, 2, 1, ...new Uint8Array(32)]);
const tokenClose = () => Uint8Array.from([9]);
const systemTransfer = (lamports) => cat(u32(2), u64(lamports));
const systemAssign = () => cat(u32(1), new Uint8Array(32));

/** A parsed token account as getMultipleAccounts / simulateTransaction return it. */
const tokenAccount = ({ mint, owner, amount, delegate = null, closeAuthority = null }) => ({
  lamports: 2_039_280, owner: PROGRAMS.TOKEN,
  data: { program: 'spl-token', parsed: { type: 'account', info: { mint, owner, tokenAmount: { amount: String(amount) }, ...(delegate ? { delegate } : {}), ...(closeAuthority ? { closeAuthority } : {}), state: 'initialized' } } },
});
const systemAccount = (lamports, over = {}) => ({ lamports, owner: PROGRAMS.SYSTEM, data: ['', 'base64'], ...over });

// -------------------------------------------------------------- parsing

test('a full message parses: instructions, data, lookups, and trailing bytes are refused', () => {
  const feePayer = key(); const user = key(); const ata = key(); const dest = key(); const table = key();
  const message = messageV0({
    signers: [feePayer, user],
    others: [ata, dest, TOKEN_PROGRAM],
    // keys: 0 feePayer, 1 user, 2 ata, 3 dest, 4 token program; 5 = first loaded address
    instructions: [{ programIdIndex: 4, accounts: [2, 5, 1], data: tokenTransfer(500n) }],
    lookups: [{ account: table, writable: [3], readonly: [] }],
  });
  const parsed = parseMessage(message);
  assert.equal(parsed.version, 0);
  assert.equal(parsed.instructions.length, 1);
  assert.deepEqual(parsed.instructions[0].accountIndexes, [2, 5, 1]);
  assert.equal(parsed.instructions[0].data[0], 3);
  assert.deepEqual(parsed.addressTableLookups, [{ account: addr(table), writableIndexes: [3], readonlyIndexes: [] }]);

  const loaded = key();
  const tableData = cat(new Uint8Array(LOOKUP_TABLE_META_SIZE), key(), key(), key(), loaded);
  const tables = new Map([[addr(table), parseLookupTable(tableData)]]);
  const keys = resolveAccountKeys(parsed, tables);
  assert.equal(keys.length, 6);
  assert.equal(keys[5], addr(loaded));
  assert.throws(() => resolveAccountKeys(parsed, new Map()), /was not resolved/);
  assert.throws(() => parseMessage(cat(message, Uint8Array.from([1]))), /trailing bytes/);
  // The keys-only reader still agrees with the full one.
  assert.deepEqual(parseMessage(message, { keysOnly: true }).keys, parsed.keys);
});

// ------------------------------------------------------------ static pass

function setup() {
  const feePayer = key(); const user = key(); const ata = key(); const dest = key(); const stranger = key();
  const signers = [feePayer, user];
  const others = [ata, dest, stranger, TOKEN_PROGRAM, SYSTEM_PROGRAM, SWAP_PROGRAM];
  // indexes: 0 feePayer, 1 user, 2 ata, 3 dest, 4 stranger, 5 token, 6 system, 7 swap
  const build = (instructions) => {
    const message = messageV0({ signers, others, instructions });
    const parsed = parseMessage(message);
    return { parsed, keys: resolveAccountKeys(parsed), user: addr(user), ata: addr(ata), dest: addr(dest), stranger: addr(stranger), feePayer: addr(feePayer), message };
  };
  return build;
}

test('a token transfer authorised by the wallet is a spend; a swap program is allowed', () => {
  const build = setup();
  const { parsed, keys, user, ata } = build([
    { programIdIndex: 5, accounts: [2, 3, 1], data: tokenTransfer(1000n) },
    { programIdIndex: 5, accounts: [2, 4, 3, 1], data: tokenTransferChecked(5n, 6) },
    { programIdIndex: 7, accounts: [1, 2, 3], data: Uint8Array.from([1, 2, 3]) },
  ]);
  const r = inspectInstructions({ parsed, keys, user });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.tokenSpends, [{ source: ata, amount: 1000n }, { source: ata, amount: 5n }]);
  assert.equal(r.unknownPrograms.length, 1);
  assert.equal(r.userIsFeePayer, false);
});

test('approve, SetAuthority, a foreign-destination close, Assign and unknown System instructions signed by the wallet are refused', () => {
  const build = setup();
  const { parsed, keys, user } = build([
    { programIdIndex: 5, accounts: [2, 4, 1], data: tokenApprove(1n) },
    { programIdIndex: 5, accounts: [2, 1], data: tokenSetAuthority() },
    { programIdIndex: 5, accounts: [2, 4, 1], data: tokenClose() },
    { programIdIndex: 6, accounts: [1], data: systemAssign() },
    { programIdIndex: 6, accounts: [4, 1], data: cat(u32(7), new Uint8Array(32)) },
  ]);
  const r = inspectInstructions({ parsed, keys, user });
  assert.equal(r.problems.length, 5, r.problems.join('; '));
  assert.match(r.problems[0], /delegate a token account/);
  assert.match(r.problems[1], /hand over an authority/);
  assert.match(r.problems[2], /pay its rent to/);
  assert.match(r.problems[3], /assigned to another program/);
  assert.match(r.problems[4], /unexpected System instruction 7/);
});

test('the same instructions authorised by somebody else, and a close paying the wallet, are fine', () => {
  const build = setup();
  const { parsed, keys, user } = build([
    { programIdIndex: 5, accounts: [2, 4, 0], data: tokenApprove(1n) },
    { programIdIndex: 5, accounts: [2, 0], data: tokenSetAuthority() },
    { programIdIndex: 5, accounts: [2, 1, 1], data: tokenClose() },
    { programIdIndex: 6, accounts: [0, 4], data: systemTransfer(5n) },
    { programIdIndex: 6, accounts: [1, 4], data: systemTransfer(7n) },
  ]);
  const r = inspectInstructions({ parsed, keys, user });
  assert.deepEqual(r.problems, []);
  assert.equal(r.lamportsFromUser, 7n, 'only the wallet\'s own transfer counts');
});

test('a transaction the wallet does not sign is refused', () => {
  const build = setup();
  const { parsed, keys, stranger } = build([]);
  const r = inspectInstructions({ parsed, keys, user: stranger });
  assert.match(r.problems[0], /not a required signer/);
});

// --------------------------------------------------------------- effects

const USER = 'UserUserUserUserUserUserUserUserUserUserUser';
const IN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OUT = 'TokenMintTokenMintTokenMintTokenMintTokenMi';
const OTHER = 'OtherMintOtherMintOtherMintOtherMintOtherMi';

test('a clean buy: input down by at most the amount, output up, fees under the cap', () => {
  const addresses = [USER, 'ataIn', 'ataOut', 'pool'];
  const pre = [systemAccount(50_000_000), tokenAccount({ mint: IN, owner: USER, amount: 10_000_000 }), null, tokenAccount({ mint: OUT, owner: 'pool', amount: 1 })];
  const post = [systemAccount(48_000_000), tokenAccount({ mint: IN, owner: USER, amount: 5_000_000 }), tokenAccount({ mint: OUT, owner: USER, amount: 777 }), tokenAccount({ mint: OUT, owner: 'pool', amount: 0 })];
  const r = judgeEffects({ addresses, pre, post, user: USER, inMint: IN, outMint: OUT, amount: 5_000_000n, requireOutput: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.deltas[IN], '-5000000');
  assert.equal(r.deltas[OUT], '777');
  assert.equal(r.lamportsDelta, '-2000000');
});

test('spending more than the order, another mint leaving, or no output arriving is refused', () => {
  const addresses = [USER, 'ataIn', 'ataOther', 'ataOut'];
  const pre = [systemAccount(50_000_000), tokenAccount({ mint: IN, owner: USER, amount: 10_000_000 }), tokenAccount({ mint: OTHER, owner: USER, amount: 100 }), tokenAccount({ mint: OUT, owner: USER, amount: 0 })];
  const post = [systemAccount(50_000_000), tokenAccount({ mint: IN, owner: USER, amount: 1 }), tokenAccount({ mint: OTHER, owner: USER, amount: 0 }), tokenAccount({ mint: OUT, owner: USER, amount: 0 })];
  const r = judgeEffects({ addresses, pre, post, user: USER, inMint: IN, outMint: OUT, amount: 5_000_000n, requireOutput: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /more than the order amount/.test(p)), r.problems.join('; '));
  assert.ok(r.problems.some((p) => new RegExp(`100 of ${OTHER} would leave`).test(p)));
  assert.ok(r.problems.some((p) => /no .* would arrive/.test(p)));
  // On the relay route the output arrives later; only the outflow is judged.
  const relay = judgeEffects({ addresses, pre, post, user: USER, inMint: IN, outMint: null, amount: 10_000_000n, requireOutput: false });
  assert.deepEqual(relay.problems, [`100 of ${OTHER} would leave the wallet, but only ${IN} is being sold`]);
});

test('a delegate, a close authority, an owner change, a closed foreign account or a drained wallet are refused', () => {
  const addresses = [USER, 'a1', 'a2', 'a3', 'a4'];
  const pre = [
    systemAccount(50_000_000),
    tokenAccount({ mint: OUT, owner: USER, amount: 5 }),
    tokenAccount({ mint: OUT, owner: USER, amount: 5 }),
    tokenAccount({ mint: OUT, owner: USER, amount: 5 }),
    tokenAccount({ mint: OTHER, owner: USER, amount: 5 }),
  ];
  const post = [
    systemAccount(50_000_000 - Number(MAX_LAMPORT_SPEND) - 1),
    tokenAccount({ mint: OUT, owner: USER, amount: 5, delegate: 'Eve' }),
    tokenAccount({ mint: OUT, owner: USER, amount: 5, closeAuthority: 'Eve' }),
    tokenAccount({ mint: OUT, owner: 'Eve', amount: 5 }),
    null,
  ];
  const r = judgeEffects({ addresses, pre, post, user: USER, inMint: IN, outMint: OUT, amount: 1n });
  assert.equal(r.ok, false);
  const text = r.problems.join('; ');
  assert.match(text, /gain delegate Eve/);
  assert.match(text, /gain close authority Eve/);
  assert.match(text, /change owner to Eve/);
  assert.match(text, /a4 \(.*\) would be closed/);
  assert.match(text, /more than the .* allowed for fees/);
});

test('a token account the transaction creates may carry a close authority; one that existed may not gain one', () => {
  const addresses = [USER, 'fresh', 'old'];
  const pre = [systemAccount(50_000_000), null, tokenAccount({ mint: OUT, owner: USER, amount: 5 })];
  const post = [
    systemAccount(50_000_000),
    // The sponsor paid the rent for the output account and keeps the right to reclaim it.
    tokenAccount({ mint: OUT, owner: USER, amount: 7, closeAuthority: 'Sponsor' }),
    tokenAccount({ mint: OUT, owner: USER, amount: 5 }),
  ];
  const r = judgeEffects({ addresses, pre, post, user: USER, inMint: IN, outMint: OUT, amount: 1n, requireOutput: true });
  assert.equal(r.ok, true, r.problems.join('; '));
  // The same right on the account that existed is still refused.
  const post2 = [systemAccount(50_000_000), null, tokenAccount({ mint: OUT, owner: USER, amount: 5, closeAuthority: 'Sponsor' })];
  const r2 = judgeEffects({ addresses, pre, post: post2, user: USER, inMint: IN, outMint: OUT, amount: 1n });
  assert.equal(r2.ok, false);
  assert.match(r2.problems.join('; '), /old \(.*\) would gain close authority Sponsor/);
  // And a delegate on the fresh account is not allowed either: a delegate moves tokens.
  const post3 = [systemAccount(50_000_000), tokenAccount({ mint: OUT, owner: USER, amount: 7, delegate: 'Sponsor' }), tokenAccount({ mint: OUT, owner: USER, amount: 5 })];
  assert.match(judgeEffects({ addresses, pre, post: post3, user: USER, inMint: IN, outMint: OUT, amount: 1n }).problems.join('; '), /fresh \(.*\) would gain delegate Sponsor/);
});

test('the wallet account may not be assigned away, and an emptied input or wrapped-SOL account may close', () => {
  const addresses = [USER, 'ataIn', 'wsol'];
  const pre = [systemAccount(50_000_000), tokenAccount({ mint: IN, owner: USER, amount: 3 }), tokenAccount({ mint: WSOL_MINT, owner: USER, amount: 0 })];
  const ok = judgeEffects({ addresses, pre, post: [systemAccount(50_000_000), null, null], user: USER, inMint: IN, amount: 3n });
  assert.deepEqual(ok.problems, []);
  const owned = judgeEffects({ addresses, pre, post: [systemAccount(50_000_000, { owner: 'Evil11111111111111111111111111111111111111' }), null, null], user: USER, inMint: IN, amount: 3n });
  assert.match(owned.problems[0], /owned by Evil/);
});

// ------------------------------------------------------------ end to end

test('guardSolanaTransaction: decodes, resolves tables through the worker, simulates, and refuses on either check', async () => {
  const feePayer = key(); const user = key(); const ata = key(); const table = key(); const loadedDest = key();
  const signers = [feePayer, user];
  const others = [ata, TOKEN_PROGRAM, SWAP_PROGRAM];
  // indexes: 0 feePayer, 1 user, 2 ata, 3 token, 4 swap; 5 = loaded (dest)
  const instructions = [
    { programIdIndex: 4, accounts: [1, 2, 5], data: Uint8Array.from([9]) },
    { programIdIndex: 3, accounts: [2, 5, 1], data: tokenTransfer(400n) },
  ];
  const message = messageV0({ signers, others, instructions, lookups: [{ account: table, writable: [1], readonly: [] }] });
  const parsed = parseTransaction(serializeTransaction({ signatures: [new Uint8Array(64), new Uint8Array(64)], message }));
  const U = addr(user); const A = addr(ata); const D = addr(loadedDest);
  const tableData = cat(new Uint8Array(LOOKUP_TABLE_META_SIZE), key(), loadedDest);

  const calls = [];
  const worker = (effects) => async (type, payload) => {
    calls.push(type);
    if (type === 'solana.accounts') {
      assert.deepEqual(payload.addresses, [addr(table)]);
      return [{ data: [bytesToBase64(tableData), 'base64'] }];
    }
    if (type === 'solana.simulate') {
      assert.equal(payload.addresses.length, 6);
      assert.ok(payload.addresses.includes(D), 'loaded addresses are simulated too');
      assert.equal(typeof payload.tx, 'string');
      return effects(payload.addresses);
    }
    throw new Error(`unexpected ${type}`);
  };

  const states = (addresses, { userAfter = 40_000_000, ataAfter = 600 } = {}) => ({
    pre: addresses.map((a) => (a === U ? systemAccount(40_500_000) : a === A ? tokenAccount({ mint: IN, owner: U, amount: 1000 }) : null)),
    post: addresses.map((a) => (a === U ? systemAccount(userAfter) : a === A ? tokenAccount({ mint: IN, owner: U, amount: ataAfter }) : null)),
    err: null,
  });

  const ok = await guardSolanaTransaction({ parsed, user: U, inMint: IN, outMint: null, amount: 400n, requireOutput: false, callBackground: worker(states) });
  assert.deepEqual(calls, ['solana.accounts', 'solana.simulate']);
  assert.equal(ok.effects.deltas[IN], '-400');
  assert.equal(ok.programs.length, 1);

  // The simulation shows more leaving than the instruction said: refused.
  await assert.rejects(
    guardSolanaTransaction({ parsed, user: U, inMint: IN, amount: 400n, callBackground: worker((a) => states(a, { ataAfter: 0 })) }),
    /more than the order amount/,
  );
  // A failing simulation is not signed either.
  await assert.rejects(
    guardSolanaTransaction({ parsed, user: U, inMint: IN, amount: 400n, callBackground: worker((a) => ({ ...states(a), err: { InstructionError: [1, 'Custom'] } })) }),
    /fails in simulation/,
  );
  // No account states at all (node silent): fail closed.
  await assert.rejects(
    guardSolanaTransaction({ parsed, user: U, inMint: IN, amount: 400n, callBackground: async (t) => (t === 'solana.accounts' ? [{ data: [bytesToBase64(tableData), 'base64'] }] : null) }),
    /no account states/,
  );
  // An unresolvable lookup table: fail closed before any simulation.
  await assert.rejects(
    guardSolanaTransaction({ parsed, user: U, inMint: IN, amount: 400n, callBackground: async () => [null] }),
    /could not be read/,
  );
  // The static pass refuses before the node is even asked.
  const bad = messageV0({ signers, others, instructions: [{ programIdIndex: 3, accounts: [2, 0, 1], data: tokenApprove(1n) }] });
  const badParsed = parseTransaction(serializeTransaction({ signatures: [new Uint8Array(64), new Uint8Array(64)], message: bad }));
  let asked = false;
  await assert.rejects(
    guardSolanaTransaction({ parsed: badParsed, user: U, inMint: IN, amount: 1n, callBackground: async () => { asked = true; return null; } }),
    /delegate a token account/,
  );
  assert.equal(asked, false);
});
