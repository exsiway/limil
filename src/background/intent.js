// One-time intents: the service worker's written consent for one privileged
// operation with exactly these parameters.
//
// The MAIN world signs delegations and grants through Privy, but it runs in
// the page's realm and cannot be trusted to have decided anything itself. So
// it decides nothing: the worker plans the operation (background/runner.js
// grantPlan, or the popup for a disconnect), issues an intent bound to the
// canonical form of the parameters, and the MAIN world may only proceed after
// the worker has confirmed, and spent, that intent for the very same
// parameters. A changed key, limit, target or delegate hashes differently and
// is refused; a spent or expired intent is refused; an intent of another kind
// is refused.
//
// This is a second line behind the private bus (shared/bus.js): even if a page
// script ever found a way to speak to the MAIN world's handlers, it could not
// make them sign anything the worker had not planned.

const STORE = 'intents';
/** A signature through Privy can take a while; ten minutes covers a slow one. */
export const INTENT_TTL_MS = 10 * 60_000;
export const INTENT_KINDS = Object.freeze(['delegate', 'grant', 'disconnect']);

/** chrome.storage.session is in-memory and dies with the browser, the right place for a nonce. */
function area() {
  const s = globalThis.chrome?.storage;
  return s?.session ?? s?.local;
}

/**
 * Canonical JSON: keys sorted at every level, BigInt as decimal string, hex
 * addresses lower-cased. Two parameter objects that mean the same operation
 * canonicalise to the same string.
 */
export function canonical(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return JSON.stringify(value.toLowerCase());
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * Every issue and every consume runs to completion before the next starts.
 *
 * Without this, two concurrent consumes of one id both read the list before
 * either wrote it back, both found the intent unspent, and both succeeded,
 * a one-time intent spent twice. The storage API has no compare-and-swap, so
 * the worker serialises its own writers: one promise chain, every operation
 * appended to it.
 */
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readAll() {
  const bag = await area().get(STORE);
  const list = Array.isArray(bag?.[STORE]) ? bag[STORE] : [];
  const now = Date.now();
  return list.filter((i) => i && typeof i === 'object' && Number(i.expiresAt) > now && !i.used);
}

async function writeAll(list) {
  await area().set({ [STORE]: list.slice(-50) });
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Issues an intent for one operation.
 *
 * @param {object} o
 * @param {'delegate'|'grant'|'disconnect'} o.kind
 * @param {object} o.params the exact parameters the MAIN world will be handed
 * @param {number} [o.now]
 * @returns {Promise<string>} the intent id to travel with the parameters
 */
export function issueIntent({ kind, params, now = Date.now() }) {
  if (!INTENT_KINDS.includes(kind)) return Promise.reject(new Error(`unknown intent kind "${kind}"`));
  return serialized(async () => {
    const list = await readAll();
    const id = randomId();
    list.push({ id, kind, hash: canonical(params), issuedAt: now, expiresAt: now + INTENT_TTL_MS, used: false });
    await writeAll(list);
    return id;
  });
}

/**
 * Spends an intent. Throws unless an unspent, unexpired intent of this kind
 * exists for exactly these parameters. Spent BEFORE the caller proceeds: a
 * failed signature needs a new plan, not a retry on the old consent.
 */
export function consumeIntent({ id, kind, params, now = Date.now() }) {
  return serialized(async () => {
    const list = await readAll();
    const found = list.find((i) => i.id === id);
    if (!found) throw new Error(`no intent "${String(id ?? '').slice(0, 8)}" for ${kind}: the operation was not planned by the extension, or the plan expired`);
    if (found.kind !== kind) throw new Error(`intent is for ${found.kind}, not ${kind}`);
    if (found.hash !== canonical(params)) throw new Error(`intent parameters differ from the planned ${kind}, refused`);
    if (Number(found.expiresAt) <= now) throw new Error(`intent for ${kind} expired`);
    // Removed before anything awaits outside this chain: the next consume of
    // the same id, queued behind this one, no longer finds it.
    await writeAll(list.filter((i) => i.id !== id));
    return true;
  });
}
