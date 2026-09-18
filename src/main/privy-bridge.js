// Bridge to the embedded Privy provider. Lives in the MAIN world of fomo.family.
//
// The key is locked inside the auth.privy.io iframe and never leaves it. The
// only way to get a signature is to ask the iframe. There is no way to reach
// the provider object of a foreign bundle, so the bridge works one level
// lower, on the transport:
//
//   1. the getter HTMLIFrameElement.prototype.contentWindow is replaced so
//      the Privy iframe yields a transparent Proxy (postMessage of a
//      cross-origin window cannot be reassigned: SecurityError);
//   2. a SAMPLE of the envelope the page sends RPC requests in is recorded;
//   3. our own signature request replays that envelope with our method/params.
//
// Step 2 is unavoidable: the envelope is versioned and cannot be guessed.

import {
  buildConnectRequest,
  buildRecoverRequest,
  buildRequest,
  buildSolanaRequest,
  extractSolanaSignature,
  addressesIn,
  describeSample,
  envelopeBelongsTo,
  extractError,
  extractSignature,
  matchesRequestId,
  parseEnvelope,
  privyRefusalText,
} from '../shared/envelope.js';

import {
  decodeJwtPayload,
  findJwtPaths,
  freshestToken,
  getAtPath,
  looksLikeJwt,
  replaceAtPaths,
  secondsUntilExpiry,
} from '../shared/jwt.js';
import { sameTokenFamily } from '../shared/session-health.js';
import { PLACEHOLDER_JWT } from '../shared/daemon-api.js';

const PRIVY_HOST = /(^|\.)privy\.io$/i;

const state = {
  installed: false,
  /** @type {HTMLIFrameElement|null} */
  frame: null,
  /** @type {ReturnType<typeof describeSample>|null} */
  sample: null,
  /** When the sample was captured IN THIS tab. null, loaded from storage. */
  sampleAt: null,
  /** Outcome of the last token refresh attempt. */
  lastRefresh: null,
  log: [],
};

const listeners = new Set();

function note(level, text, extra) {
  const entry = { t: Date.now(), level, text, extra };
  state.log.push(entry);
  if (state.log.length > 200) state.log.shift();
  for (const fn of listeners) {
    try { fn(entry); } catch { /* a listener must not break the bridge */ }
  }
}

/** The iframe's answers, traced the same way: event and error text, no values. */
function traceIncoming(ev) {
  let host;
  try { host = new URL(ev.origin).hostname; } catch { return; }
  if (!PRIVY_HOST.test(host)) return;
  const parsed = parseEnvelope(ev.data);
  const event = parsed?.data?.event;
  if (typeof event !== 'string') return;
  const error = extractError(parsed.data);
  note('trace', `privy ← ${event}${error ? ` error: ${String(error).slice(0, 140)}` : ' ok'}`);
}
if (typeof window !== 'undefined') window.addEventListener('message', traceIncoming, true);

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function isPrivyFrame(iframe) {
  try {
    const src = iframe.src || '';
    return src ? PRIVY_HOST.test(new URL(src, location.href).hostname) : false;
  } catch {
    return false;
  }
}

function findPrivyFrame() {
  if (state.frame?.isConnected) return state.frame;
  for (const iframe of document.querySelectorAll('iframe')) {
    if (isPrivyFrame(iframe)) {
      state.frame = iframe;
      return iframe;
    }
  }
  return null;
}

// ------------------------------------------------------ transport interception

function isPrivyOrigin(targetOrigin) {
  if (typeof targetOrigin !== 'string' || targetOrigin === '*') return false;
  try {
    return PRIVY_HOST.test(new URL(targetOrigin).hostname);
  } catch {
    return false;
  }
}

const proxyCache = new WeakMap();

function wrapWindow(realWindow, iframe) {
  const cached = proxyCache.get(realWindow);
  if (cached) return cached;

  const proxy = new Proxy(realWindow, {
    get(target, prop) {
      if (prop === 'postMessage') {
        const original = Reflect.get(target, 'postMessage', target);
        return function postMessage(message, targetOrigin, transfer) {
          // Judged by the destination origin, not the element's src: the
          // iframe may receive its src after the page took its contentWindow.
          //
          // Captured ALWAYS: the envelope holds a short-lived Privy session
          // token, and a sample captured once answers "Invalid auth token" an
          // hour later. Constant refreshing keeps it valid as long as the page
          // talks to Privy at all.
          if (isPrivyOrigin(targetOrigin) || isPrivyFrame(iframe)) {
            recordOutgoing(message);
          }
          return original.call(target, message, targetOrigin, transfer);
        };
      }
      // Everything else passes through: to the page the proxy must be
      // indistinguishable from the real window, cross-origin errors included.
      return Reflect.get(target, prop, target);
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });

  proxyCache.set(realWindow, proxy);
  return proxy;
}

/**
 * A trace of the exchange with the iframe, event names and field names
 * only, no values: what FOMO sends before it signs is what the bridge must
 * send after a reload, and the trace shows it in the popup's journal.
 */
function traceOutgoing(message) {
  const parsed = parseEnvelope(message);
  const event = parsed?.data?.event;
  if (typeof event !== 'string') return;
  const data = parsed.data.data;
  const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data;
  const method = data?.request?.method ? ` ${data.request.method}` : '';
  note('trace', `privy → ${event}${method} {${keys}}${fingerprints(data)}`);
}

/**
 * A fingerprint of the three fields that identify the wallet and the
 * session in a message: length and a short digest, never the value. Two
 * messages with the same fingerprints carry the same values; the journal
 * can then tell whose message differs from whose.
 */
function fingerprints(data) {
  if (!data || typeof data !== 'object') return '';
  const parts = [];
  for (const key of ['entropyId', 'entropyIdVerifier', 'accessToken']) {
    const value = data[key];
    if (typeof value !== 'string') continue;
    parts.push(`${key}=${value.length}:${digest(value)}`);
  }
  return parts.length ? ` [${parts.join(' ')}]` : '';
}

/** A short, non-cryptographic digest for the journal (FNV-1a, 32 bit). */
function digest(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function recordOutgoing(message) {
  traceOutgoing(message);
  const described = describeSample(message);
  if (!described) return;
  // A Solana envelope does NOT replace the EVM sample: our UserOperations are
  // signed with the latter, and swapping in a foreign format would break sells.
  if (/^solana_/i.test(described.method)) {
    note('info', `Solana envelope seen: ${described.method}`, { method: described.method });
    return;
  }
  const first = !state.sample;
  state.sample = described;
  state.sampleAt = Date.now();
  note('refresh',
    first ? `envelope sample captured: ${described.method}`
      : `envelope sample refreshed: ${described.method}`, {
      method: described.method,
      rpcPath: described.rpcPath,
      idPaths: described.idPaths,
    });
}

/** Installs the transport interception. Idempotent. */
export function install() {
  if (state.installed) return true;
  const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (!desc?.get) {
    note('error', 'contentWindow is not a getter, interception is impossible in this browser');
    return false;
  }
  const rawGet = desc.get;

  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      const win = rawGet.call(this);
      if (!win) return win;
      if (isPrivyFrame(this)) state.frame = this;
      // Not only the recognised Privy iframe is wrapped but any still-empty
      // one: at the first access the src may not be set yet, and there is no
      // second chance to replace the transport. Third-party iframes with a src
      // (analytics, widgets) are left alone, a proxy breaks window identity.
      const src = this.getAttribute('src');
      if (!isPrivyFrame(this) && src && src !== 'about:blank') return win;
      return wrapWindow(win, this);
    },
  });

  state.installed = true;
  note('info', 'Privy transport interception installed');
  return true;
}

export function getSample() {
  return state.sample;
}

// ------------------------------------------------- token refresh in the envelope

/**
 * Collects Privy tokens from the page's storage.
 *
 * Privy keeps the session in localStorage under keys like `privy:token`. After
 * a reload the page may never talk to the iframe, and the recorded envelope
 * keeps an old token, hence "Invalid auth token" with a live session. The live
 * value is taken straight from storage. Key names are not filtered: what a
 * token is, `looksLikeJwt` decides.
 */
function collectTokens() {
  const found = [];
  const scan = (storage, label) => {
    if (!storage) return;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key) continue;
      const raw = storage.getItem(key);
      if (!raw || raw.length > 8192) continue;
      // The value may be a bare token or a JSON wrapper around one.
      const candidates = [raw];
      try {
        const parsed = JSON.parse(raw);
        for (const path of findJwtPaths(parsed)) candidates.push(getAtPath(parsed, path));
      } catch { /* not JSON, fine */ }
      for (const value of candidates) {
        if (looksLikeJwt(value)) found.push({ source: `${label}:${key}`, token: value });
      }
    }
  };
  try { scan(window.localStorage, 'localStorage'); } catch { /* access denied */ }
  try { scan(window.sessionStorage, 'sessionStorage'); } catch { /* access denied */ }

  for (const part of String(document.cookie || '').split(';')) {
    const [name, ...rest] = part.split('=');
    const value = decodeURIComponent(rest.join('=').trim());
    if (/privy|token/i.test(name) && looksLikeJwt(value)) {
      found.push({ source: `cookie:${name.trim()}`, token: value });
    }
  }
  return found;
}

/** Expiries of the tokens currently inside the sample. */
function sampleTokenInfo() {
  if (!state.sample?.envelope) return { paths: [], tokens: [] };
  const paths = findJwtPaths(state.sample.envelope);
  const tokens = paths.map((path) => getAtPath(state.sample.envelope, path));
  return { paths, tokens };
}

/**
 * The freshest Privy token visible in the page's storage. Not only for the
 * envelope: the header for their API is a token of the same family, and when
 * it goes stale it can be replaced from here without a reload.
 */
export function freshestKnownToken() {
  try {
    return freshestToken(collectTokens().map((c) => c.token)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Puts the freshest page token OF THE ENVELOPE'S FAMILY into the sample.
 * Sends nothing.
 *
 * The page's storage holds more JWTs than Privy's: analytics, other vendors,
 * whatever the app keeps. Taking the longest-lived of them all once put a
 * foreign token into the envelope, and since the sample is persisted and
 * refreshed from itself, the envelope stayed poisoned until the next real
 * signature in FOMO. So a candidate must share issuer, subject and audience
 * with the token already in the envelope (sameTokenFamily); when none does,
 * the envelope is left as it is and the reason is reported.
 */
export function refreshToken() {
  if (!state.sample?.envelope) {
    return { ok: false, reason: 'no envelope sample, nothing to refresh' };
  }
  const { paths, tokens } = sampleTokenInfo();
  if (paths.length === 0) {
    return {
      ok: false,
      reason: 'no JWT-like fields in the envelope, the token is stored in another form',
    };
  }

  const candidates = collectTokens();
  const current = tokens.find(looksLikeJwt) ?? null;
  if (!current) {
    return {
      ok: false,
      reason: 'the envelope token does not decode as a JWT, so no replacement can be told to be of the same family',
    };
  }
  // A stored sample carries no token at all, only the redaction placeholder
  // (background/index.js sample.save), so there is no family to match. The
  // token then comes from Privy's own storage keys, by name.
  const placeholder = isPlaceholderToken(current);
  const family = placeholder
    ? candidates.filter((c) => /privy/i.test(c.source))
    : candidates.filter((c) => sameTokenFamily(current, c.token));
  const best = freshestToken(family.map((c) => c.token));
  if (!best) {
    return {
      ok: false,
      reason: placeholder
        ? `the envelope is stored without its token and the page holds no Privy token to put in it (${candidates.length} JWT-like values looked at)`
        : family.length === 0 && candidates.length > 0
          ? `no token of the envelope's family in the page storage (${candidates.length} JWT-like values looked at, none with the same issuer, subject and audience), so the envelope is left as it is`
          : `no Privy tokens found in the page storage (${candidates.length} values looked at)`,
    };
  }

  const before = secondsUntilExpiry(tokens[0]);
  if (tokens.every((t) => t === best.token)) {
    return {
      ok: true,
      changed: false,
      expiresInSeconds: best.left,
      reason: before !== null && before < 0
        ? 'the envelope already holds the freshest token, and it is expired, log in to FOMO again'
        : 'the envelope already holds the freshest token',
    };
  }

  state.sample = {
    ...state.sample,
    envelope: replaceAtPaths(state.sample.envelope, paths, best.token),
  };
  state.sampleAt = Date.now();
  note('refresh', `token in the envelope refreshed (${paths.length} fields)`);
  return {
    ok: true,
    changed: true,
    replaced: paths.length,
    source: candidates.find((c) => c.token === best.token)?.source ?? null,
    expiresInSeconds: best.left,
    previousExpiresInSeconds: before,
  };
}

/** The redaction placeholder the background stores instead of the token. */
function isPlaceholderToken(token) {
  return token === PLACEHOLDER_JWT || decodeJwtPayload(token)?.sub === 'redacted';
}

/**
 * A sample stored by another tab, taken if it is newer than this tab's own:
 * one signature in any FOMO tab then serves every FOMO tab. The tab's own
 * capture is stamped when it happens, the stored one when it was saved.
 */
export function adoptSample(sample) {
  if (!sample?.envelope || !Array.isArray(sample.rpcPath)) return { adopted: false, reason: 'incomplete' };
  const savedAt = Number(sample.savedAt ?? 0);
  if (state.sample && Number(state.sampleAt ?? 0) >= savedAt) return { adopted: false, reason: 'own sample is as new' };
  state.sample = sample;
  state.sampleAt = savedAt || Date.now();
  note('info', 'envelope sample adopted from another tab');
  if (sampleTokenInfo().tokens.some(isPlaceholderToken)) {
    try { state.lastRefresh = { at: Date.now(), ...refreshToken() }; } catch { /* the tick retries */ }
  }
  return { adopted: true };
}

export function loadSample(sample) {
  if (!sample?.envelope || !Array.isArray(sample.rpcPath)) {
    throw new Error('envelope sample is incomplete');
  }
  state.sample = sample;
  note('info', 'envelope sample loaded from storage');
  // The stored sample has no token; the page's own goes in at once, so the
  // first signature after a reload does not wait for the refresh tick.
  if (sampleTokenInfo().tokens.some(isPlaceholderToken)) {
    try { state.lastRefresh = { at: Date.now(), ...refreshToken() }; } catch { /* the tick retries */ }
  }
}

/**
 * Whether this wallet can sign right now.
 *
 * The panel needs one answer BEFORE an order is placed: should the user be told
 * that auto-execution is not on yet. The envelope cannot be guessed; it is
 * captured only from a real request of their page, and an ordinary page load
 * does not produce one. So the person has to make one signature, and they
 * should be told in advance.
 *
 * `code` is stable and meant for the interface: 'no-privy', 'no-sample',
 * 'other-wallet'.
 */
export function canSign(sender) {
  if (!findPrivyFrame()) {
    return { ok: false, code: 'no-privy', reason: 'no Privy login on this page' };
  }
  if (!state.sample) {
    return { ok: false, code: 'no-sample', reason: 'no signature has been observed yet' };
  }
  if (sender && !envelopeBelongsTo(state.sample, sender)) {
    return { ok: false, code: 'other-wallet', reason: 'the observed signature belongs to another wallet' };
  }
  return { ok: true, code: null, reason: null };
}

export function status() {
  const ageSeconds = state.sampleAt
    ? Math.round((Date.now() - state.sampleAt) / 1000)
    : null;
  return {
    installed: state.installed,
    hasSample: Boolean(state.sample),
    sampleMethod: state.sample?.method ?? null,
    frameFound: Boolean(findPrivyFrame()),
    // Age of the sample from THIS tab. null means it was not refreshed here
    // and most likely came from storage, possibly stale even if present.
    sampleAgeSeconds: ageSeconds,
    sampleFresh: ageSeconds !== null,
    // Expiry of the token INSIDE the envelope. Negative means already expired.
    tokenExpiresInSeconds: sampleTokenInfo().tokens
      .map((t) => secondsUntilExpiry(t))
      .filter((v) => v !== null)
      .sort((a, b) => a - b)[0] ?? null,
    lastRefresh: state.lastRefresh
      ? {
        ok: state.lastRefresh.ok,
        changed: state.lastRefresh.changed ?? false,
        reason: state.lastRefresh.reason ?? null,
        agoSeconds: Math.round((Date.now() - state.lastRefresh.at) / 1000),
      }
      : null,
    // How many tokens are visible in the page storage at all. Zero means
    // Privy keeps the session elsewhere, and refreshing cannot help.
    tokensVisible: collectTokens().length,
  };
}

// ---------------------------------------------------------------- requests

/**
 * Below this remaining lifetime the token is refreshed. The check runs every
 * half minute, so a threshold equal to that left exactly one tick for
 * everything; two minutes give slack for a missed tick and a slow answer.
 */
const TOKEN_MIN_LIFE_SECONDS = 120;

/**
 * Substitutes a fresh token when the current one is about to expire. Cheap:
 * reads the page storage, no network. Runs on its own.
 */
export function ensureFreshToken() {
  if (!state.sample?.envelope) {
    state.lastRefresh = { at: Date.now(), ok: false, reason: 'no envelope sample' };
    return state.lastRefresh;
  }
  const left = status().tokenExpiresInSeconds;
  if (left !== null && left > TOKEN_MIN_LIFE_SECONDS) {
    return { ok: true, changed: false, expiresInSeconds: left };
  }
  // The outcome is always recorded: a silent failure here looked like
  // "somehow it did not refresh" with nothing to go on.
  state.lastRefresh = { at: Date.now(), ...refreshToken() };
  return state.lastRefresh;
}

/**
 * Sends our own RPC request into the Privy iframe, replaying the captured envelope.
 *
 * @param {{method: string, params: any, timeoutMs?: number, expectSender?: string|null, chainType?: string}} req
 * @returns {Promise<string>} the result (for a signature: hex of 65 bytes, or base64 for Solana)
 */
export async function requestViaPrivy({
  method, params, timeoutMs = 90_000, expectSender = null,
  /** 'solana', the Solana envelope (signMessage over message bytes), else EVM. */
  chainType = 'ethereum',
}) {
  // Before EVERY request: "Invalid auth token" is the most frequent and most
  // pointless failure, and it is cured without the user.
  try { ensureFreshToken(); } catch { /* could not, let Privy answer */ }
  if (!state.sample) {
    throw new Error(
      'no envelope sample, make one operation with a signature in FOMO, '
      + 'and the bridge will remember which envelope to ask for signatures with.',
    );
  }
  // The envelope belongs to a wallet, not to the browser. It is cloned whole,
  // together with the address of the account it was captured from. After an
  // account switch Privy answers "'0x…' not loaded on this device" naming the
  // OLD address. A foreign envelope is discarded at once: it will not become
  // valid by itself, and the person's next operation in FOMO captures the
  // right one.
  if (expectSender && !envelopeBelongsTo(state.sample, expectSender)) {
    const stale = state.sample;
    state.sample = null;
    state.sampleAt = null;
    // Level 'stale', not 'error': index.js clears the storage copy on it.
    // Otherwise the discarded envelope came back on the next page load.
    note('stale', 'the envelope belonged to another wallet, discarded', {
      expected: expectSender,
      seen: [...addressesIn(stale.envelope)].slice(0, 3),
    });
    throw new Error(
      `the signature envelope was captured from another wallet, but we trade with ${expectSender}. `
      + 'The envelope of the previous wallet has been discarded. Make one ordinary SELL with this '
      + 'account in FOMO: a buy is signed on Solana and is of no use for EVM, while a sell is '
      + 'signed by the very wallet we trade with.',
    );
  }
  const build = chainType === 'solana' ? buildSolanaRequest : buildRequest;
  const send = () => exchange(build(state.sample, {
    method,
    params,
    requestId: `limil-${crypto.randomUUID()}`,
  }), { timeoutMs, describe: `our ${method}` });

  let answer;
  try {
    answer = await send();
  } catch (err) {
    const text = String(err?.message || err);
    const ours = expectSender ? text.toLowerCase().includes(String(expectSender).toLowerCase()) : true;
    if (!/not loaded on this device/i.test(text) || !ours) throw new Error(privyRefusalText(text, { expectSender }));
    // The wallet is not loaded into this page session (a tab reload does
    // that): load it the way FOMO's own SDK does, then ask once more.
    note('info', 'the wallet is not loaded in this tab, connecting it');
    await connectWallet();
    try {
      answer = await send();
    } catch (again) {
      throw new Error(privyRefusalText(String(again?.message || again), { expectSender }));
    }
  }
  const signature = chainType === 'solana' ? extractSolanaSignature(answer) : extractSignature(answer);
  if (signature) return signature;
  throw new Error(`Privy answer without a signature and without an error: ${JSON.stringify(answer).slice(0, 400)}`);
}

/**
 * Loads the wallet into the iframe: `privy:wallets:connect` built from the
 * sample, with a fresh token. Resolves on the iframe's answer, throws on
 * its error.
 */
export async function connectWallet() {
  try { ensureFreshToken(); } catch { /* let Privy answer */ }
  if (!state.sample) throw new Error('no envelope sample, the wallet cannot be connected');
  try {
    await exchange(buildConnectRequest(state.sample, { requestId: `limil-${crypto.randomUUID()}` }), {
      timeoutMs: 30_000, describe: 'our wallets:connect',
    });
  } catch (err) {
    const text = String(err?.message || err);
    if (!/not loaded on this device|wallet_not_on_device/i.test(text)) throw err;
    // No device share in the iframe's storage: the SDK recovers the wallet
    // onto the device with the same three fields, and so do we.
    note('info', 'the wallet is not on this device, recovering it');
    try {
      await exchange(buildRecoverRequest(state.sample, { requestId: `limil-${crypto.randomUUID()}` }), {
        timeoutMs: 60_000, describe: 'our wallets:recover',
      });
    } catch (again) {
      throw new Error(
        `the wallet could not be recovered into this tab (${String(again?.message || again)}). `
        + 'Sign once in FOMO itself in this tab (any small buy), then try again without reloading.',
      );
    }
  }
  note('info', 'the wallet is connected in this tab');
  return true;
}

/**
 * One message to the iframe and its answer, matched by request id.
 *
 * @returns {Promise<object>} the parsed answer; an answer with an error rejects with its text
 */
function exchange({ payload, requestId }, { timeoutMs, describe }) {
  const frame = findPrivyFrame();
  if (!frame) throw new Error('Privy iframe not found on the page, log in to FOMO');
  const targetOrigin = new URL(frame.src, location.href).origin;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage, true);
      reject(new Error('Privy did not answer our request in time'));
    }, timeoutMs);

    function finish(settle, value) {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage, true);
      settle(value);
    }

    function onMessage(ev) {
      let host;
      try { host = new URL(ev.origin).hostname; } catch { return; }
      if (!PRIVY_HOST.test(host)) return;

      const parsed = parseEnvelope(ev.data);
      if (!parsed || !matchesRequestId(parsed.data, requestId)) return;

      // The answer to OUR request goes no further. The FOMO app listens to
      // the same messages and looks the id up in ITS queue; ours is not there
      // and it throws "cannot dequeue privy:wallets:rpc event" on every one of
      // our signatures. We listen in the capture phase, i.e. before them, so
      // stopping OUR answers is enough; theirs are not touched.
      ev.stopImmediatePropagation();
      note('info', 'answer to our request received');
      const error = extractError(parsed.data);
      if (error) { finish(reject, new Error(error)); return; }
      finish(resolve, parsed.data);
    }

    window.addEventListener('message', onMessage, true);
    note('info', `sending ${describe} to Privy`, { requestId });
    // postMessage on a cross-origin window is always allowed, the one thing
    // the same-origin policy does not block.
    frame.contentWindow.postMessage(payload, targetOrigin);
  });
}

/**
 * Signs the bytes of a Solana message with the same Privy wallet.
 *
 * Their front end sends `signMessage` with `chainType: solana` and the base64
 * of the transaction message; an ed25519 signature comes back in base64.
 *
 * @param {object} o
 * @param {string} o.address   EVM address of the wallet: the envelope belongs to it
 * @param {string} o.messageBase64 the transaction message, base64
 */
export function signSolanaMessage({ address, messageBase64, timeoutMs }) {
  return requestViaPrivy({
    method: 'signMessage',
    params: { message: messageBase64 },
    chainType: 'solana',
    timeoutMs,
    expectSender: address,
  });
}

/** EIP-712 signature through the Privy provider. */
export function signTypedData({ address, typedData, timeoutMs }) {
  return requestViaPrivy({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify(typedData)],
    timeoutMs,
    // The signature is requested for a specific wallet, the envelope must be
    // its own, or Privy refuses naming a FOREIGN address.
    expectSender: address,
  });
}
