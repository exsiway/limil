// What a Solana transaction built by somebody else may do with the user's
// signature, decided BEFORE Privy signs it.
//
// Relay and dflow hand us a finished transaction, and a finished transaction
// is not a trustworthy one: a compromised quote source, or a script in the
// MAIN world substituting it, can ask the wallet to sign anything, a token
// approve to a stranger, a SetAuthority on the USDC account, a CloseAccount
// with a foreign destination. Reading the signatures and the static keys does
// not see any of that; the instructions have to be read.
//
// Two checks, both mandatory, both fail-closed:
//
//   1. STATIC. Every instruction is decoded. Instructions of the System and
//      Token programs in which the wallet acts as authority are judged one by
//      one: a transfer out of a wallet-owned token account is recorded as a
//      spend, an approve/delegate, SetAuthority, Burn, Assign, nonce
//      authority change or a CloseAccount paying anyone but the wallet is a
//      refusal. Programs we do not know (the swap venues) are allowed; what
//      they do is bounded by the second check.
//
//   2. EFFECTS. The transaction is simulated on a node with signature checks
//      off, and the state of every account it touches is compared before and
//      after. The wallet's own lamports may drop by at most a small fee
//      budget and its account must stay a plain system account. Of the
//      wallet's token accounts only the INPUT mint may decrease, by at most
//      the order amount; no delegate may appear on any of them, no owner or
//      close authority may change, none may be closed except an emptied input
//      account or wrapped SOL. One thing is allowed: a close authority on a
//      token account the transaction itself CREATES (FOMO's sponsor pays the
//      rent for the output token's account and keeps the right to reclaim it),
//      because a close authority can only close an emptied account and take
//      its rent back; it moves no token. Where the route delivers the output in the same
//      transaction (dflow), the output mint must increase. A failed simulation
//      is a refusal too: a trade that would revert is not signed either.
//
// Both checks exist because each covers the other's blind spot: the static
// pass catches an instruction the simulation would execute "successfully"
// (an approve is a success), the simulation catches spends nested inside a
// program we do not decode. A node that lies is the remaining trust; the same
// nodes are already trusted for balances, and two of them are asked in turn.
//
// Pure functions here; the RPC calls are injected (`callBackground`), so
// everything is testable with recorded account states.

import { base64ToBytes, parseLookupTable, parseMessage, resolveAccountKeys, accountMeta } from './solana-tx.js';

export const PROGRAMS = Object.freeze({
  SYSTEM: '11111111111111111111111111111111',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
  MEMO_V1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  MEMO_V2: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  LOOKUP_TABLE: 'AddressLookupTab1e1111111111111111111111111',
});

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** The wallet may lose this many lamports to fees, rent and priority (0.02 SOL). */
export const MAX_LAMPORT_SPEND = 20_000_000n;

const TOKEN_PROGRAMS = new Set([PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022]);

const u64le = (bytes, at) => {
  if (bytes.length < at + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
};
const u32le = (bytes, at) => (bytes.length < at + 4 ? null : (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0);

// SPL Token instruction indexes (shared by Token-2022 for the classic set).
const TOKEN_IX = {
  TRANSFER: 3, APPROVE: 4, REVOKE: 5, SET_AUTHORITY: 6, BURN: 8, CLOSE_ACCOUNT: 9,
  TRANSFER_CHECKED: 12, APPROVE_CHECKED: 13, BURN_CHECKED: 15, SYNC_NATIVE: 17,
};
// System program instruction indexes (u32 LE).
const SYSTEM_IX = { CREATE_ACCOUNT: 0, ASSIGN: 1, TRANSFER: 2, CREATE_ACCOUNT_WITH_SEED: 3, ALLOCATE: 8 };

/**
 * Static pass over the decoded instructions.
 *
 * @param {object} o
 * @param {ReturnType<typeof parseMessage>} o.parsed
 * @param {string[]} o.keys resolved account keys (static + lookup tables)
 * @param {string} o.user the wallet that is about to sign
 * @returns {{problems: string[], tokenSpends: {source: string, amount: bigint}[], lamportsFromUser: bigint, userIsFeePayer: boolean, unknownPrograms: string[]}}
 */
export function inspectInstructions({ parsed, keys, user }) {
  const problems = [];
  const tokenSpends = [];
  const unknown = new Set();
  let lamportsFromUser = 0n;

  const signerIdx = keys.indexOf(user);
  if (signerIdx < 0 || signerIdx >= parsed.numRequiredSignatures) {
    problems.push('the wallet is not a required signer of this transaction');
  }
  const userIsFeePayer = keys[0] === user;

  parsed.instructions.forEach((ix, n) => {
    const program = keys[ix.programIdIndex];
    const acc = ix.accountIndexes.map((i) => keys[i]);
    if (program === undefined || acc.some((a) => a === undefined)) {
      problems.push(`instruction ${n} indexes an account outside the key list`);
      return;
    }
    const data = ix.data;
    const where = `instruction ${n}`;

    if (TOKEN_PROGRAMS.has(program)) {
      const kind = data[0];
      switch (kind) {
        case TOKEN_IX.TRANSFER: {
          const [source, , authority] = acc;
          if (authority === user) {
            const amount = u64le(data, 1);
            if (amount === null) problems.push(`${where}: token transfer without an amount`);
            else tokenSpends.push({ source, amount });
          }
          break;
        }
        case TOKEN_IX.TRANSFER_CHECKED: {
          const [source, , , authority] = acc;
          if (authority === user) {
            const amount = u64le(data, 1);
            if (amount === null) problems.push(`${where}: token transfer without an amount`);
            else tokenSpends.push({ source, amount });
          }
          break;
        }
        case TOKEN_IX.APPROVE:
          if (acc[2] === user) problems.push(`${where}: the wallet would delegate a token account to ${acc[1]}`);
          break;
        case TOKEN_IX.APPROVE_CHECKED:
          if (acc[3] === user) problems.push(`${where}: the wallet would delegate a token account to ${acc[2]}`);
          break;
        case TOKEN_IX.SET_AUTHORITY:
          if (acc[1] === user) problems.push(`${where}: the wallet would hand over an authority of ${acc[0]}`);
          break;
        case TOKEN_IX.BURN:
        case TOKEN_IX.BURN_CHECKED:
          if (acc[2] === user) problems.push(`${where}: the wallet would burn tokens from ${acc[0]}`);
          break;
        case TOKEN_IX.CLOSE_ACCOUNT:
          if (acc[2] === user && acc[1] !== user) problems.push(`${where}: closing ${acc[0]} would pay its rent to ${acc[1]}, not to the wallet`);
          break;
        default:
          // Revoke, SyncNative, InitializeAccount*, mint-side instructions:
          // nothing leaves the wallet through them.
          break;
      }
      return;
    }

    if (program === PROGRAMS.SYSTEM) {
      const kind = u32le(data, 0);
      switch (kind) {
        case SYSTEM_IX.TRANSFER:
          if (acc[0] === user) lamportsFromUser += u64le(data, 4) ?? 0n;
          break;
        case SYSTEM_IX.CREATE_ACCOUNT:
          if (acc[0] === user) lamportsFromUser += u64le(data, 4) ?? 0n;
          if (acc[1] === user) problems.push(`${where}: the wallet account itself would be re-created`);
          break;
        case SYSTEM_IX.CREATE_ACCOUNT_WITH_SEED: {
          if (acc[0] === user) {
            // base pubkey (32), seed (u64 length + bytes), lamports (u64)
            const seedLen = u64le(data, 4 + 32);
            const at = 4 + 32 + 8 + Number(seedLen ?? 0n);
            lamportsFromUser += u64le(data, at) ?? 0n;
          }
          if (acc[1] === user) problems.push(`${where}: the wallet account itself would be re-created`);
          break;
        }
        case SYSTEM_IX.ASSIGN:
        case SYSTEM_IX.ALLOCATE:
          if (acc[0] === user) problems.push(`${where}: the wallet account would be assigned to another program`);
          break;
        default:
          // Nonce operations, seeded assigns and the like have no place in a
          // swap; refused whenever the wallet takes part as a signer.
          if (acc.some((a, i) => a === user && accountMeta(parsed, ix.accountIndexes[i]).signer)) {
            problems.push(`${where}: unexpected System instruction ${kind} signed by the wallet`);
          }
          break;
      }
      return;
    }

    if (program === PROGRAMS.LOOKUP_TABLE && acc.includes(user)) {
      problems.push(`${where}: the wallet would pay for or own an address lookup table`);
      return;
    }

    if (program === PROGRAMS.ATA || program === PROGRAMS.COMPUTE_BUDGET || program === PROGRAMS.MEMO_V1 || program === PROGRAMS.MEMO_V2) return;
    unknown.add(program);
  });

  return { problems, tokenSpends, lamportsFromUser, userIsFeePayer, unknownPrograms: [...unknown] };
}

// ---------------------------------------------------------------- effects

const asBig = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

/** Reads a jsonParsed token account, or null when the account is not one. */
function tokenInfo(account) {
  const parsed = account?.data?.parsed;
  if (!parsed || parsed.type !== 'account') return null;
  const program = account.data.program;
  if (program !== 'spl-token' && program !== 'spl-token-2022') return null;
  const info = parsed.info ?? {};
  return {
    mint: info.mint,
    owner: info.owner,
    amount: asBig(info.tokenAmount?.amount),
    delegate: info.delegate ?? null,
    closeAuthority: info.closeAuthority ?? null,
    state: info.state ?? null,
  };
}

/**
 * Judges the simulated effects on the wallet.
 *
 * @param {object} o
 * @param {string[]} o.addresses the accounts asked for, in order
 * @param {(object|null)[]} o.pre  jsonParsed accounts before (getMultipleAccounts)
 * @param {(object|null)[]} o.post jsonParsed accounts after (simulateTransaction)
 * @param {string} o.user
 * @param {string} o.inMint the mint that may leave the wallet
 * @param {string|null} o.outMint the mint expected to arrive, when known and on Solana
 * @param {bigint|string} o.amount the order amount in the input mint's units
 * @param {boolean} [o.requireOutput] the route delivers output in this transaction
 * @param {bigint} [o.maxLamportSpend]
 * @returns {{ok: boolean, problems: string[], deltas: Record<string, string>, lamportsDelta: string}}
 */
export function judgeEffects({
  addresses, pre, post, user, inMint, outMint = null, amount, requireOutput = false, maxLamportSpend = MAX_LAMPORT_SPEND,
}) {
  const problems = [];
  const limit = BigInt(amount);
  const deltas = new Map();
  const add = (mint, d) => deltas.set(mint, (deltas.get(mint) ?? 0n) + d);
  let lamportsDelta = 0n;

  addresses.forEach((address, i) => {
    const before = pre[i] ?? null;
    const after = post[i] ?? null;

    if (address === user) {
      const lBefore = asBig(before?.lamports);
      const lAfter = asBig(after?.lamports);
      lamportsDelta = lAfter - lBefore;
      if (after && after.owner !== PROGRAMS.SYSTEM) problems.push(`the wallet account would be owned by ${after.owner}`);
      const len = Array.isArray(after?.data) ? after.data[0]?.length ?? 0 : (after?.data?.parsed ? 1 : 0);
      if (after && len > 0) problems.push('the wallet account would carry data after the transaction');
      if (lamportsDelta < -maxLamportSpend) problems.push(`the wallet would lose ${-lamportsDelta} lamports, more than the ${maxLamportSpend} allowed for fees`);
      return;
    }

    const tb = tokenInfo(before);
    const ta = tokenInfo(after);
    const mineBefore = tb?.owner === user;
    const mineAfter = ta?.owner === user;
    if (!mineBefore && !mineAfter) return;

    if (mineBefore && ta && !mineAfter) {
      problems.push(`token account ${address} (${tb.mint}) would change owner to ${ta.owner}`);
      return;
    }
    if (mineBefore && !ta) {
      // Closed. Its whole balance is gone: counted as a spend of that mint.
      if (tb.mint !== inMint && tb.mint !== WSOL_MINT) problems.push(`token account ${address} (${tb.mint}) would be closed`);
      add(tb.mint, -tb.amount);
      return;
    }
    if (mineAfter) {
      if (ta.delegate && ta.delegate !== (tb?.delegate ?? null)) problems.push(`token account ${address} (${ta.mint}) would gain delegate ${ta.delegate}`);
      // A close authority can only close an EMPTIED account and take its rent.
      // On an account this transaction creates that is the sponsor's way of
      // getting the rent it paid back later; on an account that existed it
      // is a change nobody asked for.
      if (tb && (ta.closeAuthority ?? null) !== (tb.closeAuthority ?? null) && ta.closeAuthority) {
        problems.push(`token account ${address} (${ta.mint}) would gain close authority ${ta.closeAuthority}`);
      }
      if (tb && tb.mint !== ta.mint) problems.push(`token account ${address} would change mint`);
      add(ta.mint, ta.amount - (tb?.amount ?? 0n));
    }
  });

  for (const [mint, d] of deltas) {
    if (d >= 0n) continue;
    if (mint !== inMint) problems.push(`${-d} of ${mint} would leave the wallet, but only ${inMint} is being sold`);
    else if (-d > limit) problems.push(`${-d} of ${inMint} would leave the wallet, more than the order amount ${limit}`);
  }
  if (requireOutput) {
    const gain = outMint ? deltas.get(outMint) ?? 0n : 0n;
    if (!outMint) problems.push('the output mint is unknown, so the arrival of the output cannot be checked');
    else if (gain <= 0n) problems.push(`no ${outMint} would arrive in the wallet`);
  }

  return {
    ok: problems.length === 0,
    problems,
    deltas: Object.fromEntries([...deltas].map(([m, d]) => [m, d.toString()])),
    lamportsDelta: lamportsDelta.toString(),
  };
}

/**
 * Runs both checks on a transaction that is about to be signed.
 *
 * @param {object} o
 * @param {{signatures: Uint8Array[], message: Uint8Array}} o.parsed the transaction
 * @param {string} o.user the wallet that signs
 * @param {string} o.inMint
 * @param {string|null} o.outMint
 * @param {bigint|string} o.amount
 * @param {boolean} [o.requireOutput]
 * @param {(type: string, payload?: any) => Promise<any>} o.callBackground RPC through the worker
 * @returns {Promise<{keys: string[], programs: string[], effects: ReturnType<typeof judgeEffects>}>} throws on refusal
 */
export async function guardSolanaTransaction({ parsed, user, inMint, outMint = null, amount, requireOutput = false, callBackground }) {
  const message = parseMessage(parsed.message);

  // Address tables: whatever the instructions index must be known by name.
  const tables = new Map();
  if (message.addressTableLookups.length) {
    const wanted = message.addressTableLookups.map((l) => l.account);
    const raw = await callBackground('solana.accounts', { addresses: wanted });
    wanted.forEach((address, i) => {
      const data = raw?.[i]?.data;
      const b64 = Array.isArray(data) ? data[0] : null;
      if (!b64) throw new Error(`Solana guard: address lookup table ${address} could not be read, not signing`);
      tables.set(address, parseLookupTable(base64ToBytes(b64)));
    });
  }
  const keys = resolveAccountKeys(message, tables);

  const inspection = inspectInstructions({ parsed: message, keys, user });
  if (inspection.problems.length) {
    throw new Error(`Solana guard refused the transaction: ${inspection.problems.join('; ')}`);
  }

  // Simulation over every account the transaction can touch: a program can
  // only move what it is handed.
  const addresses = [...new Set(keys)];
  const sim = await callBackground('solana.simulate', {
    tx: bytesToBase64Safe(parsed),
    addresses,
  });
  if (!sim || !Array.isArray(sim.pre) || !Array.isArray(sim.post)) {
    throw new Error('Solana guard: the simulation returned no account states, not signing');
  }
  if (sim.err) {
    throw new Error(`Solana guard: the transaction fails in simulation (${JSON.stringify(sim.err).slice(0, 160)}), not signing`);
  }
  const effects = judgeEffects({ addresses, pre: sim.pre, post: sim.post, user, inMint, outMint, amount, requireOutput });
  if (!effects.ok) throw new Error(`Solana guard refused the transaction: ${effects.problems.join('; ')}`);
  return { keys, programs: inspection.unknownPrograms, effects };
}

/** The transaction as base64 with whatever signatures it has (the node is asked not to verify them). */
function bytesToBase64Safe(parsed) {
  // Imported lazily to keep this module free of a cycle with solana-send.
  const { serializeTransaction, bytesToBase64 } = solanaTx;
  return bytesToBase64(serializeTransaction(parsed));
}

import * as solanaTx from './solana-tx.js';
