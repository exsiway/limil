// Hub state: one JSON file in the data directory.
//
// Holds the two pairing tokens, the paired extension's address, the runner
// browser's address, the order list the extension pushed, the redacted
// signing sample and the journal. No private key lives here: the hub signs
// nothing, the browsers do (hub.mjs). Nothing is encrypted; the box is the
// user's, and a pairing token is all a reader could take.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { randomToken } from '../src/shared/daemon-api.js';

const FILE = 'state.json';
const JOURNAL_MAX = 300;

function fresh() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    pairToken: randomToken(randomBytes(32)),
    owner: null,
    /** A runner browser (the extension on this box) pairs with its own token. */
    runnerToken: randomToken(randomBytes(32)),
    runner: null,
    wallet: null,
    solanaAddress: null,
    orders: [],
    journal: [],
    /** Accepted request nonces with their expiry: the replay cache survives a restart. */
    nonces: {},
  };
}

export function openState(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE);
  let data;
  function save() {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
  if (existsSync(path)) {
    data = JSON.parse(readFileSync(path, 'utf8'));
    // State written before the runner browser existed.
    if (!data.runnerToken) { data.runnerToken = randomToken(randomBytes(32)); data.runner = data.runner ?? null; save(); }
    // State written while the hub still executed on its own: a private key of
    // its own and the executor's scratch. A wallet may have granted that key,
    // and nothing signs with it any more, so it is dropped from disk rather
    // than merely ignored.
    const stale = ['sessionKey', 'samples', 'attempts', 'lastLoopAt', 'pausedUntil', 'watch'].filter((k) => k in data);
    if (stale.length) { for (const k of stale) delete data[k]; save(); }
  } else {
    data = fresh();
    save();
  }

  function note(entry) {
    data.journal.push({ at: new Date().toISOString(), ...entry });
    if (data.journal.length > JOURNAL_MAX) data.journal = data.journal.slice(-JOURNAL_MAX);
    save();
  }

  return {
    path,
    get data() { return data; },
    save,
    note,
    /** A new pairing token: after an unpair, the old one must not work. */
    rotateToken() {
      data.pairToken = randomToken(randomBytes(32));
      save();
      return data.pairToken;
    },
    rotateRunnerToken() {
      data.runnerToken = randomToken(randomBytes(32));
      save();
      return data.runnerToken;
    },
  };
}
