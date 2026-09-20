// HTTP(S) face of the daemon: pairing, order sync, state for the popup.
//
// Every route except /v1/hello requires a request signed by the paired
// extension (see src/shared/daemon-api.js, protocol 2). The pairing route is
// the one exception in the other direction: it is signed too, but by a key
// the daemon does not know yet, the one-time token proves the person, the
// signature tells the daemon which key to trust from now on.
//
// What a stranger on the network gets from this server:
//   - /v1/hello: the protocol number and the version, nothing else. The
//     wallet, the keys, the order count and the journal are behind a
//     signature, because an address that trades is not public information.
//   - a replayed request: refused. Every accepted (address, nonce) is kept
//     for the length of the time window; the second appearance is a 401.
//   - a signed request with a changed query string: refused. The signature
//     covers the exact request target the client sent.
//   - CORS: only extension origins are answered. A web page on any other
//     origin gets no CORS headers and its browser drops the response.
//
// TLS is available in-process (startServer({ tls })) for boxes without a
// reverse proxy; the extension refuses plain http to a public address.

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { keccak256, verifyMessage } from 'viem';
import { makeSolanaRelay } from './solana.mjs';

const solanaRelay = makeSolanaRelay();

import {
  AUTH_WINDOW_MS, PROTOCOL, authFresh, authMessage, bodyHashOf, parseAuthorization,
} from '../src/shared/daemon-api.js';

export const VERSION = '0.2.4';
const MAX_BODY = 512 * 1024;
/** Failed pairing attempts allowed per client address inside PAIR_WINDOW_MS. */
const PAIR_ATTEMPTS = 10;
const PAIR_WINDOW_MS = 10 * 60_000;

const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+$/i;

/** CORS only for an extension origin; anything else gets no CORS at all. */
function corsHeaders(req) {
  const origin = String(req.headers.origin ?? '');
  if (!EXTENSION_ORIGIN.test(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    vary: 'origin',
  };
}

function json(req, res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(req),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Constant-time comparison of two short strings. */
function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Accepted nonces inside the window. A nonce seen twice is a replay,
 * whatever else about the request is right.
 */
export function createReplayCache({ windowMs = AUTH_WINDOW_MS, max = 50_000, store = null } = {}) {
  // With a `store` (the daemon state) the nonces survive a restart: a request
  // captured just before the process went down cannot be replayed just after
  // it came back, inside the window. In memory only, the cache would be empty
  // exactly then.
  const persisted = store?.data?.nonces && typeof store.data.nonces === 'object' ? store.data.nonces : {};
  const seen = new Map(Object.entries(persisted).filter(([, until]) => Number(until) > Date.now()));
  let ops = 0;
  const prune = (now) => {
    for (const [key, until] of seen) if (until <= now) seen.delete(key);
  };
  const persist = () => {
    if (!store) return;
    store.data.nonces = Object.fromEntries(seen);
    try { store.save(); } catch { /* the in-memory cache still holds it */ }
  };
  return {
    /** @returns {boolean} true when the nonce is fresh and is now remembered */
    admit(address, nonce, { now = Date.now() } = {}) {
      ops += 1;
      if (ops % 200 === 0 || seen.size > max) prune(now);
      const key = `${address}:${nonce}`;
      if (seen.has(key)) return false;
      seen.set(key, now + 2 * windowMs);
      persist();
      return true;
    },
    get size() { return seen.size; },
  };
}

/** Failed pairing attempts per client, so the token cannot be guessed at speed. */
function createPairLimiter({ attempts = PAIR_ATTEMPTS, windowMs = PAIR_WINDOW_MS } = {}) {
  const hits = new Map();
  return {
    allowed(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || h.resetAt <= now) return true;
      return h.count < attempts;
    },
    failed(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || h.resetAt <= now) hits.set(ip, { count: 1, resetAt: now + windowMs });
      else h.count += 1;
    },
  };
}

/**
 * Checks the signature on a request. Returns the signer's address (lower
 * case) or throws. `owner` null means “anyone with a valid signature”,
 * used only by the pairing routes.
 */
async function authenticate(req, body, owner, replay) {
  const auth = parseAuthorization(req.headers.authorization);
  if (!auth) throw Object.assign(new Error('unauthorized: missing or malformed signature (protocol 2 expects address:ts:nonce:signature)'), { status: 401 });
  if (!authFresh(auth.ts, { windowMs: AUTH_WINDOW_MS })) {
    throw Object.assign(new Error('unauthorized: signature timestamp outside the window'), { status: 401 });
  }
  if (owner && auth.address !== owner) throw Object.assign(new Error('forbidden: not the paired key'), { status: 403 });
  // The client signed the exact request target it sent, path AND query.
  const message = authMessage({
    ts: auth.ts, nonce: auth.nonce, method: req.method, path: req.url, bodyHash: bodyHashOf(keccak256, body),
  });
  const ok = await verifyMessage({ address: auth.address, message, signature: auth.signature });
  if (!ok) throw Object.assign(new Error('unauthorized: bad signature'), { status: 401 });
  // Only after the signature is known good: a forged request must not be
  // able to burn a nonce the real client is about to use.
  if (!replay.admit(auth.address, auth.nonce)) {
    throw Object.assign(new Error('unauthorized: replayed request'), { status: 401 });
  }
  return auth.address;
}

/**
 * @param {object} o
 * @param {{cert: string|Buffer, key: string|Buffer}|null} [o.tls] serve https in-process
 */
export function startServer({
  state, executor, port, host = '127.0.0.1', tls = null, log = console.log,
  replay = createReplayCache({ store: state }),
  /** The address a browser ON THIS BOX reaches the daemon at; the same value index.mjs prints. */
  runnerUrl = (process.env.RUNNER_URL ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),
}) {
  const pairLimiter = createPairLimiter();

  /** What an unauthenticated caller may learn: which protocol to speak. */
  const publicHello = () => ({ protocol: PROTOCOL, daemonVersion: VERSION });

  /** The full picture, for the paired extension only. */
  const hello = () => ({
    ...publicHello(),
    paired: Boolean(state.data.owner),
    // The owner is a program with no Privy session; the runner grants itself.
    ownerHeadless: state.data.ownerHeadless === true,
    wallet: state.data.wallet,
    orders: state.data.orders.filter((o) => o.status === 'watching').length,
    // The change counter the runner browser long-polls on.
    version: state.data.version ?? 0,
    // A runner browser on this box executes through FOMO's own pipeline; its
    // session key is the one the owner's wallet must grant (`sessionKey`).
    // Without one there is no key to grant and nothing on this box executes;
    // the owner's browser keeps executing until a runner pairs.
    runner: state.data.runner ? {
      key: state.data.runner.key, lastSeenAt: state.data.runner.lastSeenAt ?? null,
      version: state.data.runner.version ?? null, build: state.data.runner.build ?? null, watching: state.data.runner.watching ?? null,
      journal: (state.data.runner.journal ?? []).slice(0, 12), reportedAt: state.data.runner.reportedAt ?? null,
    } : null,
    sessionKey: state.data.runner?.key ?? null,
  });

  const handler = async (req, res) => {
    const ip = req.socket?.remoteAddress ?? 'unknown';
    // Parsed INSIDE the guard. A request-target no URL parser accepts is a
    // thing any client can send, and outside the guard the throw left the
    // async handler as an unhandled rejection, which ends the process: an
    // unauthenticated stranger could stop the hub by asking badly.
    let url;
    let path;
    try {
      try {
        url = new URL(req.url, 'http://x');
      } catch {
        throw Object.assign(new Error('bad request target'), { status: 400 });
      }
      path = url.pathname;
      if (req.method === 'OPTIONS') { json(req, res, 204, {}); return; }
      if (path === '/v1/hello' && req.method === 'GET') { json(req, res, 200, publicHello()); return; }

      const body = await readBody(req);
      let parsed = {};
      if (body) {
        try { parsed = JSON.parse(body); } catch { throw Object.assign(new Error('body is not JSON'), { status: 400 }); }
      }

      if (path === '/v1/pair' && req.method === 'POST') {
        if (!pairLimiter.allowed(ip)) throw Object.assign(new Error('too many pairing attempts, wait ten minutes'), { status: 429 });
        if (!sameToken(parsed.token, state.data.pairToken)) {
          pairLimiter.failed(ip);
          throw Object.assign(new Error('pairing token does not match'), { status: 403 });
        }
        const signer = await authenticate(req, body, null, replay);
        state.data.owner = signer;
        // When this owner took over. Nothing recorded before it belongs to
        // them, and the runner browser keeps its own journal across an owner
        // change, so without this line its next report hands the previous
        // owner's activity to this one.
        state.data.ownerSince = Date.now();
        state.rotateToken();
        state.note({ kind: 'paired', owner: signer });
        log(`paired with extension key ${signer}`);
        json(req, res, 200, hello());
        return;
      }

      // ---- the runner browser: its own token, its own key, its own routes.
      if (path === '/v1/runner/pair' && req.method === 'POST') {
        if (!pairLimiter.allowed(ip)) throw Object.assign(new Error('too many pairing attempts, wait ten minutes'), { status: 429 });
        if (!sameToken(parsed.token, state.data.runnerToken)) {
          pairLimiter.failed(ip);
          throw Object.assign(new Error('runner token does not match'), { status: 403 });
        }
        const signer = await authenticate(req, body, null, replay);
        state.data.runner = { key: signer, pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
        state.rotateRunnerToken();
        state.note({ kind: 'runner-paired', key: signer });
        log(`runner browser paired with key ${signer}; the owner's next order grants it`);
        json(req, res, 200, hello());
        return;
      }
      // `/v1/runner/pairing` is the OWNER asking for the runner's pairing
      // string; it is served with the owner's routes below, not here.
      if (path.startsWith('/v1/runner/') && path !== '/v1/runner/pairing') {
        const runner = state.data.runner?.key;
        if (!runner) throw Object.assign(new Error('no runner browser paired'), { status: 403 });
        await authenticate(req, body, runner, replay);
        state.data.runner.lastSeenAt = new Date().toISOString();
        if (path === '/v1/runner/orders' && req.method === 'GET') {
          // Long poll: `since` is the version the runner already has, `wait`
          // how many seconds to hold the request for a change. A cancel on
          // the laptop reaches the server browser within a second or two
          // instead of at the next scheduled pull.
          const since = Number(url.searchParams.get('since') ?? -1);
          const wait = Math.min(25, Math.max(0, Number(url.searchParams.get('wait') ?? 0)));
          const deadline = Date.now() + wait * 1000;
          while ((state.data.version ?? 0) <= since && Date.now() < deadline) {
            await new Promise((r) => { setTimeout(r, 400); });
          }
          state.save();
          json(req, res, 200, {
            ...hello(),
            // No owner means nobody is asking this browser to execute
            // anything: autonomous mode is off on their side, or they left.
            // The runner backs off to a slow heartbeat instead of holding a
            // long poll open every twenty seconds for an empty list.
            ownerPaired: Boolean(state.data.owner),
            ownerHeadless: state.data.ownerHeadless === true,
            wallet: state.data.wallet,
            solanaAddress: state.data.solanaAddress,
            orders: state.data.orders.filter((o) => o.status === 'watching'),
            sample: state.data.sample ?? null,
          });
          return;
        }
        if (path === '/v1/runner/status' && req.method === 'POST') {
          const result = executor.applyRunnerReport(parsed);
          json(req, res, 200, { ...hello(), ...result });
          return;
        }
        if (path === '/v1/runner/solana' && req.method === 'POST') {
          // The browser cannot reach a public Solana node (they 403 any
          // Origin); this process can. See daemon/solana.mjs.
          const out = await solanaRelay.relay(parsed ?? {});
          json(req, res, out.error ? 502 : 200, out);
          return;
        }
        if (path === '/v1/runner/pair' && req.method === 'DELETE') {
          state.data.runner = null;
          state.rotateRunnerToken();
          state.note({ kind: 'runner-unpaired' });
          log('runner browser unpaired; a new runner token is in the state file (node daemon/pairing.mjs runner)');
          json(req, res, 200, { ok: true });
          return;
        }
        json(req, res, 404, { error: 'no such route' });
        return;
      }

      const owner = state.data.owner;
      if (!owner) throw Object.assign(new Error('not paired yet'), { status: 403 });
      await authenticate(req, body, owner, replay);

      if (path === '/v1/orders' && req.method === 'PUT') {
        const result = executor.syncOrders(parsed);
        json(req, res, 200, { ...hello(), ...result });
        return;
      }
      if (path === '/v1/runner/pairing' && req.method === 'GET') {
        // The owner asks for the string their server browser needs, so the
        // popup can hand them one command to run instead of sending them
        // through a remote desktop to paste a token by hand. Owner-only: this
        // is behind the same signature as everything else below.
        json(req, res, 200, {
          ...hello(),
          pairing: runnerUrl ? `${runnerUrl}#${state.data.runnerToken}` : null,
          paired: Boolean(state.data.runner?.key),
        });
        return;
      }
      if (path === '/v1/owner/rotate' && req.method === 'POST') {
        // The laptop rotates its session key with every grant renewal; the
        // key that signs here is also the one this hub knows the owner by.
        // The outgoing key names its successor, signed, and from then on the
        // successor is the owner. Nothing else changes: the orders, the
        // sample and the runner browser stay.
        const next = String(parsed.next ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(next)) throw Object.assign(new Error('next must be an address'), { status: 400 });
        if (next === owner) { json(req, res, 200, { ok: true, owner }); return; }
        state.data.owner = next;
        state.save();
        state.note({ kind: 'owner-rotated', from: owner, to: next });
        log(`owner key rotated: ${owner} -> ${next}`);
        json(req, res, 200, { ok: true, owner: next });
        return;
      }
      if (path === '/v1/state' && req.method === 'GET') {
        json(req, res, 200, {
          ...hello(),
          orders: state.data.orders,
          journal: state.data.journal.slice(-60),
        });
        return;
      }
      if (path === '/v1/pair' && req.method === 'DELETE') {
        // The owner leaves: everything that was theirs goes with them, the
        // order list, the wallet addresses, the redacted signing sample the
        // runner browser was given. The runner browser's own pairing is a
        // separate credential and stays; a new owner's orders reach it after
        // the new pairing.
        state.data.owner = null;
        state.data.ownerHeadless = false;
        state.data.orders = [];
        state.data.wallet = null;
        state.data.solanaAddress = null;
        state.data.sample = null;
        // The journals go too. They name orders, transactions, wallets and the
        // reasons a trade did or did not happen, and the next person to pair
        // here reads them in the pairing answer. Whoever leaves takes their
        // record with them; the runner keeps its own pairing but not its
        // report, which would otherwise hand the same lines over again.
        state.data.journal = [];
        state.data.ownerSince = null;
        if (state.data.runner) {
          state.data.runner = { key: state.data.runner.key ?? null, journal: [], wallet: null };
        }
        state.data.version = (state.data.version ?? 0) + 1;
        state.rotateToken();
        state.note({ kind: 'unpaired' });
        log('unpaired; a new pairing token is in the state file (node daemon/pairing.mjs)');
        json(req, res, 200, { ok: true });
        return;
      }
      json(req, res, 404, { error: 'no such route' });
    } catch (err) {
      const status = err.status ?? 500;
      // Internal errors are not described to the network; the log has them.
      if (status === 500) log(`request failed: ${String(err?.stack || err)}`);
      json(req, res, status, { error: status === 500 ? 'internal error' : String(err?.message || err) });
    }
  };

  const server = tls ? createHttpsServer({ cert: tls.cert, key: tls.key }, handler) : createHttpServer(handler);
  server.listen(port, host, () => log(`listening on ${tls ? 'https' : 'http'}://${host}:${server.address()?.port ?? port}`));
  return server;
}
