// Access to the FOMO API from the page context.
//
// The extension already lives on fomo.family with a live session, so requests
// go out with THE SAME headers as their front end's. No refresh token has to be
// taken from anyone or stored anywhere; the request comes from the user's IP,
// which their access token is bound to (a change means 430); and no store of
// other people's credentials appears on our side.
//
// Headers are not invented but captured from their own requests, like the
// Privy envelope. The API session headers captured HERE are held only in tab
// memory: they are short-lived and have no business in chrome.storage. The
// Privy envelope is the exception and should be named as one: the sample that
// privy-bridge.js records carries the Privy JWT inside it, and the background
// persists that sample to chrome.storage.local (`sample.save`) so a reload
// does not lose the only envelope the extension can sign with. The token in
// it is refreshed in place from the page's own storage (privy-bridge.js).

import { isApiRequest } from '../shared/fomo-api.js';
import { uuidFromPath } from '../shared/balances.js';
import { bundlerHeaders } from '../shared/bundler-headers.js';
import { explainFully } from '../shared/explain.js';
import { secondsUntilExpiry } from '../shared/jwt.js';

const OUR_MARK = 'x-limil';

/**
 * Headers the browser controls itself: forwarding them in our own requests is
 * pointless, the browser sets them anyway and may reject the request.
 */
const BROWSER_OWNED = new Set([
  'host', 'origin', 'referer', 'content-length', 'connection', 'cookie',
]);

/**
 * Whether a header looks like a session carrier. The name is undocumented and
 * may change, so the match is loose rather than a fixed list.
 */
function looksLikeAuth(name) {
  return /(^authorization$)|token|auth|api[-_]?key|session|privy|bearer/i.test(name);
}

const state = {
  installed: false,
  /** @type {Record<string,string>|null} captured from their request, held in memory */
  headers: null,
  /**
   * Headers PER ORIGIN. The API and the bundler take different sets, and
   * giving the bundler the API's set fails the CORS preflight over an extra
   * header: the request is refused before it leaves.
   */
  headersByOrigin: {},
  apiOrigin: null,
  capturedAt: null,
  lastPath: null,
  /** Recent observations for diagnostics, WITHOUT header values. */
  seen: [],
  /** The user id, latched the first time it appears in a request path. */
  userId: null,
  onCapture: null,
  onBalances: null,
  onMarketCap: null,
};

function isFomoHost(url) {
  try {
    const { protocol, hostname } = new URL(url, location.href);
    return protocol === 'https:'
      && (hostname === 'fomo.family' || hostname.endsWith('.fomo.family'));
  } catch {
    return false;
  }
}

function note(url, headerNames) {
  try {
    const { origin, pathname } = new URL(url, location.href);
    // The id is latched AT ONCE: `seen` is a 12-entry diagnostic ring, and
    // the balances request that carries the id is followed by dozens more
    // within seconds.
    state.userId ??= uuidFromPath(pathname);
    state.seen.unshift({ origin, path: pathname, headers: headerNames, at: Date.now() });
    state.seen.length = Math.min(state.seen.length, 12);
  } catch { /* observation must not disturb the page */ }
}

function remember(url, headers) {
  const names = Object.keys(headers).map((n) => n.toLowerCase());
  note(url, names);

  // A set counts as a session when something in it looks like an
  // authorization carrier. Values are not inspected.
  if (!names.some(looksLikeAuth)) return;

  const picked = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!value || BROWSER_OWNED.has(lower) || lower === OUR_MARK) continue;
    picked[lower] = value;
  }
  if (Object.keys(picked).length === 0) return;

  const parsed = new URL(url, location.href);
  state.headersByOrigin[parsed.origin] = picked;
  // Only the REST API's own requests set the session and the API origin. The
  // candle host and the data host carry the same header, and taking the last
  // of them as the API sent a quote to the wrong host (404) as an order fired.
  if (!isApiRequest(parsed.origin, parsed.pathname)) return;
  const first = !state.headers;
  state.headers = picked;
  state.apiOrigin = parsed.origin;
  state.capturedAt = Date.now();
  state.lastPath = parsed.pathname;

  // Only the FIRST capture is reported upwards; later ones just refresh.
  if (first) {
    try { state.onCapture?.(status()); } catch { /* the listener is not our concern */ }
  }
}

function headersToObject(init, input) {
  const out = {};
  const absorb = (source) => {
    if (!source) return;
    if (typeof source.forEach === 'function' && !Array.isArray(source)) {
      source.forEach((value, key) => { out[key] = value; });
      return;
    }
    if (Array.isArray(source)) {
      for (const [key, value] of source) out[key] = value;
      return;
    }
    Object.assign(out, source);
  };
  if (input && typeof input === 'object' && input.headers) absorb(input.headers);
  absorb(init?.headers);
  return out;
}

/**
 * Whether a FOMO response may carry token facts (ticker, market cap).
 *
 * This is a broad net on purpose: narrowing to paths containing "token"
 * proved wrong, ticker and market cap come from other responses too, so
 * nearly every path passes and only analytics and the balances document,
 * parsed separately, are excluded. Because it is so broad it says nothing
 * about the HOST: the caller must pair it with isFomoHost, or a response from
 * any third-party endpoint the page talks to would be read as token facts.
 */
function isTokenUrl(url) {
  try {
    const { pathname } = new URL(url, location.href);
    if (/analytics|metrics|log|track/i.test(pathname)) return false;
    return !isBalancesUrl(url);
  } catch {
    return false;
  }
}

function isBalancesUrl(url) {
  try {
    return /\/v2\/users\/[0-9a-f-]{36}\/balances/i.test(new URL(url, location.href).pathname);
  } catch {
    return false;
  }
}

/** Installs the fetch and XHR interceptors. Idempotent, does not break the page. */
export function install({ onCapture = null, onBalances = null, onMarketCap = null } = {}) {
  if (onCapture) state.onCapture = onCapture;
  if (onBalances) state.onBalances = onBalances;
  if (onMarketCap) state.onMarketCap = onMarketCap;
  if (state.installed) return true;

  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const headers = headersToObject(init, typeof input === 'object' ? input : null);
      // Our own requests are not captured, or we would capture our own copy.
      if (url && isFomoHost(url) && !headers[OUR_MARK]) remember(url, headers);

      // The page fetches balances itself on navigation and after trades. Its
      // response is read instead of duplicating the request: fresh data for
      // free, and their API is not polled. Only from FOMO's own hosts: the
      // page also talks to analytics and wallet vendors, and isTokenUrl
      // matches nearly any path, so without the host check a third party's
      // JSON would be laid out as balances or as a market cap.
      if (url && isFomoHost(url) && !headers[OUR_MARK] && (isBalancesUrl(url) || isTokenUrl(url))) {
        const wantBalances = isBalancesUrl(url) && state.onBalances;
        const wantCap = isTokenUrl(url) && state.onMarketCap;
        if (wantBalances || wantCap) {
          return originalFetch.apply(this, arguments).then((res) => {
            try {
              res.clone().json().then((json) => {
                if (wantBalances) state.onBalances(json);
                if (wantCap) state.onMarketCap(json);
              }).catch(() => { /* not JSON, not our concern */ });
            } catch { /* clone unavailable, skip */ }
            return res;
          });
        }
      }
    } catch { /* observation must not disturb the page */ }
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    try {
      this.__limilUrl = url;
      this.__limilHeaders = {};
    } catch { /* foreign object, do not insist */ }
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
    try {
      if (this.__limilHeaders) this.__limilHeaders[name] = value;
    } catch { /* see above */ }
    return originalSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    try {
      const headers = this.__limilHeaders ?? {};
      if (this.__limilUrl && isFomoHost(this.__limilUrl) && !headers[OUR_MARK]) {
        remember(this.__limilUrl, headers);
      }
    } catch { /* see above */ }
    return originalSend.apply(this, args);
  };

  state.installed = true;
  return true;
}

/**
 * The user id, seen in the paths of their own requests. `GET /user` returns
 * Not Found, so this is the only available source.
 */
export function userId() {
  if (state.userId) return state.userId;
  for (const seen of state.seen) {
    const uuid = uuidFromPath(seen.path);
    if (uuid) return uuid;
  }
  return uuidFromPath(state.lastPath);
}

/**
 * Headers of the captured session, for requests to their own infrastructure.
 *
 * The bundler lives on bundler.prod-edge.fomo.family and answers 401 without
 * authorization. Their front end only talks to it at the moment of a swap, so
 * its header set is assembled from the API headers (sent on every page load)
 * filtered by the list the bundler publishes in its CORS preflight.
 */
export function sessionHeaders(origin = null) {
  // For a known host, exactly what their front end sends there.
  if (origin && state.headersByOrigin[origin]) {
    return { ...state.headersByOrigin[origin] };
  }
  if (!origin || !state.headers) {
    return state.headers ? { ...state.headers } : null;
  }
  // Host not seen, assemble the set ourselves. The allow-list filter drops
  // extras that would fail the preflight.
  return bundlerHeaders(state.headers);
}

/** Whether we can talk to the bundler right now: a captured API session is enough. */
function canReachBundler() {
  return bundlerHeaders(state.headers) !== null;
}

/** The token from the authorization header. Not handed out, only its expiry is. */
function headerToken() {
  const raw = state.headers?.authorization ?? state.headers?.Authorization ?? '';
  return String(raw).replace(/^Bearer\s+/i, '').trim() || null;
}

/**
 * Replaces the token in the header with a fresh one, leaving other fields
 * alone. The caller must make sure the token is of the same family; the
 * substitution here is mechanical. Returns whether it happened.
 */
export function substituteSessionToken(token) {
  if (!token || !state.headers) return false;
  const key = 'authorization' in state.headers ? 'authorization'
    : ('Authorization' in state.headers ? 'Authorization' : null);
  if (!key) return false;
  const prefix = /^Bearer\s+/i.test(String(state.headers[key])) ? 'Bearer ' : '';
  state.headers[key] = `${prefix}${token}`;
  for (const origin of Object.keys(state.headersByOrigin)) {
    if (state.headersByOrigin[origin]?.[key]) {
      state.headersByOrigin[origin][key] = state.headers[key];
    }
  }
  state.capturedAt = Date.now();
  return true;
}

/** The header token for the health check. The value stays inside the MAIN world. */
export function sessionToken() {
  return headerToken();
}

export function status() {
  return {
    installed: state.installed,
    hasSession: Boolean(state.headers),
    userId: userId(),
    apiOrigin: state.apiOrigin,
    capturedAt: state.capturedAt,
    lastPath: state.lastPath,
    ageSeconds: state.capturedAt ? Math.round((Date.now() - state.capturedAt) / 1000) : null,
    // Header NAMES only: values never leave, not even for diagnostics.
    headerNames: state.headers ? Object.keys(state.headers) : [],
    origins: Object.keys(state.headersByOrigin),
    // Readiness to send, not the fact of observation: the bundler set is
    // assembled from the API headers.
    bundlerReady: canReachBundler(),
    // The EXPIRY, not the token: it shows the session is about to die.
    sessionExpiresInSeconds: secondsUntilExpiry(headerToken() ?? ''),
    seen: state.seen.map((s) => ({ origin: s.origin, path: s.path, headers: s.headers })),
  };
}

function requireSession() {
  if (!state.headers) {
    const hint = state.seen.length
      ? `Requests to their API are visible (${state.seen.length}), but none carries a header that looks like a session.`
      : 'No requests to their API seen yet. Open a token page and let it load.';
    throw new Error(`FOMO session not captured. ${hint}`);
  }
  return { origin: state.apiOrigin, headers: state.headers };
}

/**
 * A request to their API with the same headers as their front end. Returns
 * parsed JSON or throws with the response body.
 */
export async function apiRequest({ path, method = 'GET', body = null }) {
  const { origin, headers } = requireSession();
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...headers,
      'content-type': 'application/json',
      // Marks the request so the interceptor does not capture it as a sample.
      [OUR_MARK]: '1',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }

  if (!res.ok) {
    const hint = res.status === 430
      ? ' (430, the token is bound to an IP; the network changed or a proxy was enabled)'
      : res.status === 429 ? ' (429, Cloudflare throttles frequent requests)' : '';
    // The status travels with the error: a caller that knows what a 422 means
    // for its own request should not have to parse the sentence back out.
    // What they said, in words. Their own sentence is buried in a JSON body,
    // so it is dug out and run past the explainer; if that recognises it, the
    // person reads what happened and what to do. If not, the body goes
    // through untouched, a wrong guess would be worse, and a bug report
    // needs the original either way. The raw text always travels on the error.
    const said = String(json?.message ?? json?.responseObject?.errorMsg ?? text);
    const { text: human, known } = explainFully(`${res.status} ${said}`);
    throw Object.assign(
      new Error(known ? `FOMO: ${human}` : `FOMO API ${res.status}${hint}: ${text.slice(0, 300)}`),
      { status: res.status, body: json ?? text, raw: text },
    );
  }
  return json ?? text;
}

/** How many times a reverted simulation is asked again, with `retry` raised. */
const QUOTE_RETRIES = 2;

/**
 * Whether a refusal is the kind that asking again can cure.
 *
 * Their `/swaps/v2` builds the route AND simulates it, and the simulation can
 * revert on a leg that has nothing to do with the trade being wrong, seen in
 * the field as `dflow_close_authority_fee` on a Solana sell whose amount and
 * balance were both fine, and which their own app sold minutes later. The
 * body carries a `retry` counter, which is what that counter is for.
 */
export function retryableQuote(err) {
  return err?.status === 422 && /simulation reverted/i.test(String(err?.message ?? ''));
}

/**
 * Quote for a trade. The body has exactly four fields, there is NO slippage
 * field, relay computes the tolerance itself.
 *
 * A reverted simulation is asked again with `retry` raised, up to twice.
 * Nothing is signed or sent here, and every later check still applies to
 * whatever comes back: this only stops one unlucky route from parking an
 * order until someone notices.
 */
export async function requestQuote({ inTokenId, outTokenId, amount, retry = 0 }) {
  if (!inTokenId || !outTokenId) throw new Error('inTokenId and outTokenId of the form "<address>:<networkId>" are required');
  if (!amount) throw new Error('an amount in minimal units of the input token is required');
  return askQuote(
    (body) => apiRequest({ path: '/swaps/v2', method: 'POST', body }),
    { inTokenId, outTokenId, amount: String(amount), retry },
  );
}

/**
 * The retry loop itself, with the sending injected so it can be driven in a
 * test without a browser, a session or a network.
 *
 * @param {(body: object) => Promise<any>} send
 * @param {object} body the quote body, `retry` included
 * @param {object} [opts]
 * @param {number} [opts.retries] extra attempts after the first
 * @param {number} [opts.waitMs] pause between attempts, so the route is
 *   rebuilt against a newer block rather than the same one
 */
export async function askQuote(send, body, { retries = QUOTE_RETRIES, waitMs = 1200 } = {}) {
  const base = Number(body.retry ?? 0);
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await send({ ...body, retry: base + attempt });
    } catch (err) {
      last = err;
      if (!retryableQuote(err) || attempt === retries) throw err;
      if (waitMs) await new Promise((r) => { setTimeout(r, waitMs); });
    }
  }
  throw last;
}

export function userBalances({ uuid }) {
  return apiRequest({ path: `/v2/users/${uuid}/balances` });
}
