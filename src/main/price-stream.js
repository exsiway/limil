// Live prices for tokens the chart does not show.
//
// One socket to FOMO's candle host, one subscription per token with an order.
// The chart's own data feed subscribes the same way but forwards only the
// asset on screen to its listeners, so this is the only path by which orders
// on other tokens see the price tick by tick. Prices come per token; the
// levels are in market cap, so every token's total supply is asked from the
// chart's data feed once (`resolveSymbol` carries it) and the candle close is
// multiplied by it.
//
// The set of tokens changes rarely and the socket is cheap, so a change of the
// set closes the socket and opens a new one with the new subscriptions: no
// unsubscribe bookkeeping to get wrong.

import {
  PING_MS, PRICE_STREAM_URL, marketCapOf, parseCandle, pingMessage, subscribeMessage,
} from '../shared/price-stream.js';

const lower = (v) => String(v ?? '').toLowerCase();

const state = {
  /** key (lower-case token id) -> { name, id, supply, price, at, error } */
  tokens: new Map(),
  socket: null,
  pingTimer: null,
  reconnectTimer: null,
  backoffMs: 2_000,
  generation: 0,
  authorization: null,
  resolveSupply: null,
  onPrice: null,
  trail: [],
};

function note(what) {
  state.trail.push({ at: Date.now(), what });
  if (state.trail.length > 20) state.trail.shift();
}

/**
 * Wires the stream. `authorization` returns the current session token,
 * `resolveSupply(name)` resolves a token's total supply, `onPrice(key, mc)`
 * receives market-cap prices.
 */
export function configure({ authorization, resolveSupply, onPrice }) {
  state.authorization = authorization;
  state.resolveSupply = resolveSupply;
  state.onPrice = onPrice;
}

/** Sets the tokens to stream: [{ key, name }]. Reopens the socket when the set changed. */
export function setTokens(list) {
  const wanted = new Map();
  for (const { key, name } of list) if (key && name) wanted.set(key, name);
  const same = wanted.size === state.tokens.size && [...wanted.keys()].every((k) => state.tokens.has(k));
  if (same) return;
  const next = new Map();
  let n = 0;
  for (const [key, name] of wanted) {
    n += 1;
    const old = state.tokens.get(key);
    next.set(key, { name, id: `limil-${n}`, supply: old?.supply ?? null, price: old?.price ?? null, at: old?.at ?? 0, error: null });
  }
  state.tokens = next;
  reopen();
}

function close() {
  clearTimeout(state.pingTimer);
  clearTimeout(state.reconnectTimer);
  state.pingTimer = null;
  state.reconnectTimer = null;
  const s = state.socket;
  state.socket = null;
  if (s) { try { s.close(); } catch { /* already closed */ } }
}

function reopen() {
  close();
  state.generation += 1;
  if (!state.tokens.size) { note('no tokens, stream closed'); return; }
  const token = state.authorization?.();
  if (!token) {
    note('no session token yet, retry in 5 s');
    state.reconnectTimer = setTimeout(reopen, 5_000);
    return;
  }
  const gen = state.generation;
  let socket;
  try {
    socket = new WebSocket(PRICE_STREAM_URL);
  } catch (err) {
    note(`socket failed: ${String(err?.message || err).slice(0, 80)}`);
    scheduleReconnect();
    return;
  }
  state.socket = socket;
  socket.addEventListener('open', () => {
    if (gen !== state.generation) return;
    state.backoffMs = 2_000;
    for (const [key, t] of state.tokens) {
      try {
        socket.send(JSON.stringify(subscribeMessage({ tokenId: t.name, authorization: token, id: t.id })));
      } catch (err) {
        t.error = String(err?.message || err).slice(0, 80);
        note(`subscribe failed ${key}: ${t.error}`);
      }
      // The supply is asked once per token; a price without it is unusable.
      if (t.supply === null && state.resolveSupply) {
        Promise.resolve(state.resolveSupply(t.name))
          .then((s) => { if (Number(s) > 0) t.supply = Number(s); else t.error = 'total supply unknown'; })
          .catch((err) => { t.error = `supply: ${String(err?.message || err).slice(0, 60)}`; });
      }
    }
    note(`stream open: ${state.tokens.size} token(s)`);
    state.pingTimer = setInterval(() => {
      try { socket.send(JSON.stringify(pingMessage())); } catch { /* the close handler reconnects */ }
    }, PING_MS);
  });
  socket.addEventListener('message', (ev) => {
    if (gen !== state.generation) return;
    const candle = parseCandle(ev.data);
    if (!candle) return;
    const entry = matchToken(candle, state.tokens);
    if (!entry) return;
    const [key, t] = entry;
    const mc = marketCapOf(candle.close, t.supply);
    if (mc === null) return;
    t.price = mc;
    t.at = Date.now();
    try { state.onPrice?.(key, mc); } catch { /* the watcher must not break the stream */ }
  });
  const onGone = (why) => {
    if (gen !== state.generation) return;
    note(`stream ${why}`);
    clearInterval(state.pingTimer);
    state.pingTimer = null;
    state.socket = null;
    scheduleReconnect();
  };
  socket.addEventListener('close', () => onGone('closed'));
  socket.addEventListener('error', () => onGone('error'));
}

/**
 * Which subscribed token a candle belongs to: by subscription id first, by
 * asset address second. Returns a [key, token] entry or null.
 *
 * The asset match needs a NON-EMPTY asset. A frame with neither a known id
 * nor an asset would fall through to `startsWith('')`, which is true of
 * every key, so the first token in the map took the price of some other
 * token and its order could fire on a foreign candle.
 */
export function matchToken(candle, tokens) {
  const entries = [...tokens.entries()];
  const byId = candle?.id ? entries.find(([, t]) => t.id === candle.id) : null;
  if (byId) return byId;
  const asset = lower(candle?.asset);
  if (!asset) return null;
  return entries.find(([k]) => k.startsWith(asset)) ?? null;
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = state.backoffMs;
  state.backoffMs = Math.min(state.backoffMs * 2, 60_000);
  state.reconnectTimer = setTimeout(reopen, delay);
}

/** Last known market cap of a token, and its age. */
export function priceOf(key) {
  const t = state.tokens.get(lower(key));
  return t?.price ? { price: t.price, at: t.at } : null;
}

export function info() {
  return {
    open: state.socket?.readyState === 1,
    tokens: [...state.tokens.entries()].map(([key, t]) => ({
      tokenId: key, id: t.id, supply: t.supply, price: t.price, ageMs: t.at ? Date.now() - t.at : null, error: t.error,
    })),
    trail: state.trail.slice(-8),
  };
}
