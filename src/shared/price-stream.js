// The OHLCV socket FOMO's chart uses, as far as the watcher needs it.
//
// The chart subscribes to `wss://mobula-api.fomo.family/` with the session
// token and receives one-minute candles per asset as they change. The chart's
// data feed only forwards the asset on screen to its listeners, so orders on
// other tokens are watched through a socket of our own with the same message
// shapes. Prices arrive per token; the chart and the order levels are in
// market cap, so a candle is converted with the token's total supply.

import { SOLANA_NETWORK_ID } from './chains.js';

export const PRICE_STREAM_URL = 'wss://mobula-api.fomo.family/';
/** The chart pings every half minute or so; the server answers pong. */
export const PING_MS = 25_000;

/** The chain key the socket expects: "evm:<id>" or "solana". */
export function chainKeyOf(tokenId) {
  const chain = Number(String(tokenId ?? '').split(':')[1]);
  if (!Number.isInteger(chain) || chain <= 0) return null;
  return chain === SOLANA_NETWORK_ID ? 'solana' : `evm:${chain}`;
}

/** Subscribe message for one token. `id` is our subscription id. */
export function subscribeMessage({ tokenId, authorization, id }) {
  const asset = String(tokenId ?? '').split(':')[0];
  const chainId = chainKeyOf(tokenId);
  if (!asset || !chainId) throw new Error(`price stream: token id "${tokenId}" names no chain`);
  return { type: 'ohlcv', authorization, payload: { asset, chainId, period: '1m', subscriptionId: id } };
}

export const pingMessage = () => ({ event: 'ping' });

/**
 * Reads a candle frame. Returns {id, close, asset, time} or null for
 * anything else (pong, subscribed, data of other kinds).
 */
export function parseCandle(raw) {
  let json = raw;
  if (typeof raw === 'string') {
    try { json = JSON.parse(raw); } catch { return null; }
  }
  if (!json || json.type !== 'ohlcv') return null;
  const close = Number(json.close);
  if (!Number.isFinite(close) || close <= 0) return null;
  return {
    id: json.subscriptionId ?? null,
    close,
    asset: json.asset ?? null,
    time: Number(json.tradeTime ?? json.time ?? 0) || null,
  };
}

/** Market cap from a price and a total supply, the quantity the chart shows. */
export function marketCapOf(close, totalSupply) {
  const p = Number(close);
  const s = Number(totalSupply);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(s) || s <= 0) return null;
  return p * s;
}
