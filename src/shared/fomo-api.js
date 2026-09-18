// Which of FOMO's hosts is the REST API.
//
// The page talks to several *.fomo.family origins with the same session
// header: the REST API (quotes, balances, trades), the OHLCV socket host and
// an EVM data host. Only the first answers `/swaps/v2`. Taking "the last host
// that carried a session header" as the API once sent a quote to the data
// host and got 404 "Cannot POST /swaps/v2" at the moment an order fired.

/** Paths that only the REST API serves. */
const API_PATH = /^\/(swaps|v\d+|trades|tokens|users|user|leaderboard|feed|alerts|search|profiles?|notifications)(\/|$|\?)/i;

/** Hosts that carry the session header but are not the REST API. */
const NOT_API_HOST = /^(mobula-api|[a-z0-9-]*-data|ws|socket|rum|app-actions\d*)\./i;

/**
 * Whether a request (origin + path) is one the REST API served, i.e. the
 * origin is a safe place to send our own API requests.
 */
export function isApiRequest(origin, pathname) {
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (!/(^|\.)fomo\.family$/i.test(host)) return false;
  if (NOT_API_HOST.test(host)) return false;
  return API_PATH.test(String(pathname ?? ''));
}
