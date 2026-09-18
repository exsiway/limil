// FOMO session health: notice an expiring session BEFORE it kills an order.
//
// There are two different tokens. The Privy envelope signs operations and
// refreshes itself. The authorization header for `/swaps/v2` and the bundler
// is another one: it is captured from the page's own requests, and while the
// page is idle no fresh one appears. Between "the token lives another minute"
// and "the token is dead" there is a window in which the fix is cheap.
//
// Remedies go from cheap to blunt. If Privy holds a fresher token of the same
// family, the header is fixed by substitution: no reload, no lost page state.
// Otherwise the tab is reloaded, because a new token is issued by their backend
// to their app. The reload is behind a cooldown: a reload that did not help
// must not repeat in a loop.

import { decodeJwtPayload, secondsUntilExpiry } from './jwt.js';

/** Closer than this to expiry, act without waiting for a refusal. */
export const REFRESH_BEFORE_SECONDS = 180;
/** Between reloads made for the session. Less risks a loop when logged out. */
export const RELOAD_COOLDOWN_MS = 5 * 60_000;

/**
 * Same account and same issuer. A token of another family must not be
 * substituted: it would not work and would look like a fix. The claims that do
 * not change on refresh are compared: who issued it and for whom.
 */
export function sameTokenFamily(a, b) {
  const one = decodeJwtPayload(a);
  const two = decodeJwtPayload(b);
  if (!one || !two) return false;
  const keys = ['iss', 'sub', 'aud'];
  return keys.every((k) => {
    const x = one[k];
    const y = two[k];
    if (x === undefined && y === undefined) return true;
    return JSON.stringify(x) === JSON.stringify(y);
  });
}

/**
 * What to do with the session right now.
 *
 * @param {object} opts
 * @param {string|null} opts.header token from the authorization header
 * @param {string|null} opts.privyToken freshest token known to Privy
 * @param {number} opts.lastReloadAt when the tab was last reloaded for this
 * @param {number} [opts.now]
 * @returns {{action:'ok'|'substitute'|'reload'|'wait', reason:string, secondsLeft:number|null}}
 */
export function sessionPlan({ header, privyToken, lastReloadAt = 0, now = Date.now() }) {
  if (!header) {
    return { action: 'wait', reason: 'header not captured yet, waiting for the first page request', secondsLeft: null };
  }
  const left = secondsUntilExpiry(header, now);
  if (left === null) {
    // Not a JWT: nothing to judge the expiry by, leave what works alone.
    return { action: 'ok', reason: 'header expiry is unreadable, left as is', secondsLeft: null };
  }
  if (left > REFRESH_BEFORE_SECONDS) {
    return { action: 'ok', reason: `session alive for another ${left} s`, secondsLeft: left };
  }

  const privyLeft = privyToken ? secondsUntilExpiry(privyToken, now) : null;
  if (privyToken && privyLeft !== null && privyLeft > left && sameTokenFamily(header, privyToken)) {
    return {
      action: 'substitute',
      reason: `Privy holds a fresher token of the same family (${privyLeft} s vs ${left})`,
      secondsLeft: left,
    };
  }

  if (now - Number(lastReloadAt ?? 0) < RELOAD_COOLDOWN_MS) {
    return {
      action: 'wait',
      reason: 'reloaded recently, waiting so as not to loop',
      secondsLeft: left,
    };
  }
  return { action: 'reload', reason: `session has ${left} s left and nothing to substitute`, secondsLeft: left };
}
