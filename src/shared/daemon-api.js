// Shared by the extension and the self-hosted daemon: how a request is
// signed, how the pairing string is read, how fresh a signature must be.
//
// The daemon is the user's own box; the extension proves it is the same
// person by signing every request with its session key (the private part
// never leaves the service worker). At pairing the daemon learns that key's
// address from a one-time token printed on its console; from then on only
// requests signed by that address are accepted. No passwords, no sessions.
//
// PROTOCOL 2. Every signed request carries a fresh random nonce, and the
// signed string covers the WHOLE request target (path and query). The daemon
// remembers the nonces it has accepted for the length of the time window and
// refuses a second appearance: a request captured on the wire cannot be
// replayed, and nothing in the URL can be changed without breaking the
// signature. Protocol 1 signed the path without the query and had no nonce.

/** How long a signed request stays valid. Longer, replay window; shorter, clocks drift. */
export const AUTH_WINDOW_MS = 2 * 60_000;

/** Wire version: the daemon refuses an extension that speaks another one. */
export const PROTOCOL = 2;

/**
 * The string under the signature. The daemon rebuilds every field itself:
 * protocol, time, nonce, method, the exact request target and the hash of the
 * body. Changing any of them breaks the signature.
 */
export function authMessage({ ts, nonce, method, path, bodyHash }) {
  return `limil-daemon\n${PROTOCOL}\n${ts}\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash}`;
}

/** Body hash for the signed string; keccak comes from viem on both sides. */
export function bodyHashOf(keccak256, body) {
  const bytes = new TextEncoder().encode(body ?? '');
  return keccak256(bytes);
}

/** `Authorization: Limil <address>:<ts>:<nonce>:<signature>` → its parts, or null. */
export function parseAuthorization(header) {
  const m = /^Limil (0x[0-9a-fA-F]{40}):(\d{10,16}):([A-Za-z0-9_-]{16,64}):(0x[0-9a-fA-F]{130})$/.exec(String(header ?? '').trim());
  if (!m) return null;
  return { address: m[1].toLowerCase(), ts: Number(m[2]), nonce: m[3], signature: m[4] };
}

export function authFresh(ts, { now = Date.now(), windowMs = AUTH_WINDOW_MS } = {}) {
  return Number.isFinite(ts) && Math.abs(now - ts) <= windowMs;
}

/**
 * Whether a host is one plain http is acceptable to: loopback, a private or
 * link-local range, a Tailscale/CGNAT address, a single-label name (a Docker
 * service, a LAN box) or a local-only suffix. Everything else is the public
 * internet, where the order list, the wallet and the pairing token would
 * travel in the clear and a captured request could be replayed within its
 * window. Public hosts require https.
 */
export function isPrivateHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (!h.includes('.') && !h.includes(':')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    return false;
  }
  return false;
}

/**
 * Pairing string printed by the daemon: `http://host:port#token` or
 * `https://host:port#token`. A bare `host:port#token` is taken as http. The
 * token is the one-time secret; the URL is where the extension will talk to.
 *
 * Plain http is accepted only towards a private host (see isPrivateHost); a
 * public address must be https, or be reached through an SSH tunnel.
 */
export function parsePairing(text) {
  const raw = String(text ?? '').trim();
  const at = raw.lastIndexOf('#');
  if (at <= 0) throw new Error('pairing string must look like https://host:port#token');
  let urlText = raw.slice(0, at).trim();
  const token = raw.slice(at + 1).trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('pairing token is malformed');
  if (!/^https?:\/\//i.test(urlText)) urlText = `http://${urlText}`;
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error('pairing URL does not parse');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('pairing URL must be an origin without a path');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error(`plain http to a public address (${url.hostname}) is refused: put TLS on the daemon or in front of it, or pair over an SSH tunnel (http://127.0.0.1:port#token)`);
  }
  return { url: url.origin, token };
}

/**
 * A pairing string fit to be pasted inside single quotes on a shell line, or
 * null.
 *
 * The popup renders `bash scripts/pair-runner.sh '<pairing>'` from a value
 * the hub returned. The hub is the user's own box, but the value crosses into
 * a command the person will paste into a terminal, and a single quote or a
 * `$(...)` inside it would run there. So the value must parse as a pairing
 * (origin plus a token from a fixed alphabet) AND contain none of the
 * characters a shell reads specially: quotes, backslash, dollar, backtick,
 * any whitespace including a newline. What fails is not rendered at all.
 */
export function shellSafePairing(text) {
  const raw = String(text ?? '');
  try {
    parsePairing(raw);
  } catch {
    return null;
  }
  if (/['"\\$`\s]/.test(raw)) return null;
  return raw;
}

/** A random pairing token or request nonce: URL-safe, one character per byte. */
export function randomToken(bytes) {
  // 64 symbols: six bits per byte, so the mapping is uniform (256 = 4 × 64,
  // no modulo bias) and written as a mask to say so.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let out = '';
  for (const b of bytes) out += alphabet[b & 63];
  return out;
}

/**
 * The order fields the daemon needs. Everything else (chart level, market
 * cap, symbols) stays in the extension; the daemon executes, it does not
 * draw.
 */
export function orderForDaemon(order) {
  return {
    id: order.id,
    status: order.status,
    side: order.side,
    inTokenId: order.inTokenId,
    outTokenId: order.outTokenId,
    amount: String(order.amount),
    targetOut: String(order.targetOut),
    triggerWhen: order.triggerWhen ?? null,
    maxSlippageBps: order.maxSlippageBps ?? null,
    maxImpactBps: order.maxImpactBps ?? null,
    decimals: order.decimals ?? 18,
    symbol: order.symbol ?? '',
    sender: order.sender ?? null,
    solanaAddress: order.solanaAddress ?? null,
    createdAt: order.createdAt ?? null,
    // For a runner browser that draws and watches the mirrored order the way
    // the placing browser does. The daemon itself ignores these.
    percent: order.percent ?? null,
    amountPercent: order.amountPercent ?? null,
    marketCapUsd: order.marketCapUsd ?? null,
    targetMarketCapUsd: order.targetMarketCapUsd ?? null,
    tokenAddress: order.tokenAddress ?? null,
  };
}

/**
 * A JWT-shaped placeholder: expired at epoch zero. The Privy envelope sample
 * carries the laptop's session tokens; before the sample travels to the hub
 * they are replaced with this, so nothing secret leaves the browser. It keeps
 * the SHAPE of a token so the runner browser still finds the fields and puts
 * its own live token there before signing (privy-bridge refreshToken).
 */
export const PLACEHOLDER_JWT = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjAsInN1YiI6InJlZGFjdGVkIn0.redacted-redacted-redacted-redacted';

/** Field names under which a credential would travel. */
const SENSITIVE_KEY = /token|auth|secret|session|cookie|bearer|jwt|credential|password|apikey|api_key/i;
/** An opaque credential: long, one charset, not an address. */
const OPAQUE_VALUE = /^(Bearer\s+)?[A-Za-z0-9_\-+/=.]{48,}$/;

/**
 * What in a redacted envelope still looks like a credential. Fail-CLOSED
 * input for redactSample: the envelope's format is Privy's and may change,
 * and a token in a shape we do not recognise must stop the sample from
 * leaving the browser rather than travel because nobody recognised it.
 *
 * @returns {string[]} descriptions of the suspicious places; empty when clean
 */
/** Deeper than this the redaction stops LOOKING, so deeper than this it refuses. */
const REDACTION_MAX_DEPTH = 12;
/** A sample larger than this is not an envelope we know; refused unread. */
const REDACTION_MAX_BYTES = 64 * 1024;

export function redactionProblems(node, path = [], out = [], depth = 0) {
  if (node === null || node === undefined) return out;
  if (depth > REDACTION_MAX_DEPTH) {
    // Not "nothing found there", "not looked at". Fail closed.
    out.push(`field "${path.join('.')}" lies deeper than ${REDACTION_MAX_DEPTH} levels and was not inspected`);
    return out;
  }
  if (typeof node === 'string') {
    if (node === PLACEHOLDER_JWT) return out;
    const key = String(path.at(-1) ?? '');
    if (SENSITIVE_KEY.test(key) && node.length > 0) out.push(`field "${path.join('.')}" still holds a value`);
    else if (OPAQUE_VALUE.test(node) && !/^0x[0-9a-fA-F]+$/.test(node)) out.push(`field "${path.join('.')}" holds an opaque ${node.length}-character value`);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => redactionProblems(item, [...path, i], out, depth + 1));
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) redactionProblems(value, [...path, key], out, depth + 1);
  }
  return out;
}

/**
 * The envelope sample with every JWT replaced by the placeholder, or null
 * when the sample cannot be PROVEN clean.
 *
 * Fail-closed on purpose. Forwarding an envelope untouched because no JWT was
 * found in it, marked `redacted: true`, would, had Privy moved to an opaque or
 * Bearer token, ship the live session to the hub under a label saying it was
 * safe. So: no recognisable
 * token, or anything credential-shaped left after the replacement, means no
 * sample travels. The runner browser then captures its own from a sell of
 * its own, which is the slower but safe path.
 *
 * `findJwtPaths` and `replaceAtPaths` come from shared/jwt.js and are passed
 * in to keep this module free of that import for the daemon.
 *
 * @returns {{sample: object|null, reason: string|null}}
 */
function getAt(root, path) {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

export function redactSample(sample, { findJwtPaths, replaceAtPaths }) {
  if (!sample?.envelope) return { sample: null, reason: 'no envelope in the sample' };
  let size = 0;
  try { size = JSON.stringify(sample.envelope).length; } catch { return { sample: null, reason: 'the envelope does not serialise' }; }
  if (size > REDACTION_MAX_BYTES) {
    return { sample: null, reason: `the envelope is ${size} bytes, larger than any Privy envelope we know, withheld` };
  }
  const paths = findJwtPaths(sample.envelope);
  if (!paths.length) {
    return { sample: null, reason: 'the envelope carries no recognisable token; withheld rather than sent unredacted' };
  }
  const rpcPath = Array.isArray(sample.rpcPath) ? sample.rpcPath.map(String) : null;
  if (!rpcPath) return { sample: null, reason: 'the sample has no rpcPath' };
  let envelope = replaceAtPaths(sample.envelope, paths, PLACEHOLDER_JWT);
  // The request's params are what was signed that time: a typed-data blob,
  // or the bytes of a Solana transaction, which the credential scan below
  // cannot tell from a secret. They are replaced on every use of the sample
  // (envelope.js buildRequest) and are of no use stored, so they go out
  // before the scan: a sample that stays fresh matters more, because the
  // wallet fields next to them (the entropy verifier, the requester app id)
  // change with Privy's SDK, and a stale sample cannot load the wallet.
  // The wallet address in front of EVM params stays: it is what tells a
  // sample of another wallet apart (envelope.js envelopeBelongsTo).
  const paramsPath = [...rpcPath, 'params'];
  const params = getAt(envelope, paramsPath);
  if (Array.isArray(params)) {
    const address = /^0x[0-9a-fA-F]{40}$/.test(String(params[0] ?? '')) ? [params[0]] : [];
    envelope = replaceAtPaths(envelope, [paramsPath], address);
  } else if (params !== undefined) {
    envelope = replaceAtPaths(envelope, [paramsPath], {});
  }
  const problems = redactionProblems(envelope);
  if (problems.length) {
    return { sample: null, reason: `credential-shaped values remain after redaction: ${problems.join('; ')}` };
  }
  // ONLY what the runner browser needs to rebuild a request travels: the
  // redacted envelope and the paths into it. Everything else the capture
  // recorded (the original params, whatever a future capture adds) stays here.
  // An allow-list, not a copy: `{ ...sample }` once forwarded fields nobody
  // had looked at.
  const idPaths = Array.isArray(sample.idPaths) ? sample.idPaths.filter(Array.isArray).map((p) => p.map(String)) : [];
  return {
    sample: {
      envelope,
      rpcPath,
      idPaths,
      method: typeof sample.method === 'string' ? sample.method : null,
      wasString: sample.wasString === true,
      redacted: true,
    },
    reason: null,
  };
}

/**
 * Whether a verdict may replace the one already written down.
 *
 * `triggered` is "a send was accepted"; `filled` and `failed` are what the
 * chain said afterwards. The second answer is the one a person needs, and it
 * always arrives after the first, so a recorded verdict is refined exactly
 * once, from `triggered` to a terminal one. Nothing else is overwritten: an
 * order the owner cancelled stays cancelled even if a sale landed a moment
 * later, and that collision is noted rather than applied.
 *
 * Without this an order that really sold stayed `triggered` everywhere except
 * in the browser that sold it, and the owner read "sent, unconfirmed" about a
 * position that was gone.
 */
export function refinesVerdict(was, next) {
  return was === 'triggered' && (next === 'filled' || next === 'failed');
}

/** Mark on an order that came from the hub rather than from this browser's panel. */
export const MIRRORED = 'mirrored';

/**
 * Merges the hub's watching orders into a runner browser's own list.
 *
 * Orders the hub watches and this browser does not know are added (marked
 * mirrored). Mirrored orders this browser still watches but the hub no longer
 * lists are cancelled: the owner removed them on the laptop. Mirrored orders
 * this browser closed (filled, failed, cancelled by its own rules) are
 * reported back so the laptop sees the verdict. Orders placed in this browser
 * itself are left alone.
 */
export function mergeMirror(local, upstream, { now = Date.now() } = {}) {
  const here = Array.isArray(local) ? local.filter((o) => o && typeof o === 'object') : [];
  const theirs = new Map((Array.isArray(upstream) ? upstream : []).filter((o) => o?.id).map((o) => [o.id, o]));
  const known = new Set(here.map((o) => o.id));
  const orders = [];
  const report = [];
  let added = 0;
  let cancelled = 0;
  for (const o of here) {
    const remote = theirs.get(o.id);
    if (!o[MIRRORED]) { orders.push(o); continue; }
    if (o.status === 'watching' && !remote) {
      cancelled += 1;
      orders.push({
        ...o,
        status: 'cancelled',
        cancelledAt: new Date(now).toISOString(),
        cancelReason: 'removed on the owner\'s browser',
        // The hub is where this cancellation came from, so there is nothing to
        // tell it about.
        reportedStatus: 'cancelled',
      });
      continue;
    }
    // A verdict this browser has not sent yet.
    //
    // It cannot be decided by what the hub lists. A runner is handed only the
    // orders the hub still WATCHES, so an order closed here is simply absent
    // from that list, and its absence says nothing about whether the verdict
    // arrived. The stamp written when a report goes out is the only record of
    // that, and it is also what keeps a hub that will not take the verdict
    // from being asked again every round.
    if (o.status !== 'watching' && o.reportedStatus !== o.status) {
      report.push({ id: o.id, status: o.status, closedAt: o.closedAt ?? o.cancelledAt ?? null, closedTx: o.closedTx ?? null, reason: o.cancelReason ?? null });
    }
    orders.push(o);
  }
  for (const [id, remote] of theirs) {
    if (known.has(id) || remote.status !== 'watching') continue;
    added += 1;
    orders.unshift({ ...remote, [MIRRORED]: true, status: 'watching', mirroredAt: new Date(now).toISOString() });
  }
  return { orders, added, cancelled, report };
}
