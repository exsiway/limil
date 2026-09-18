// Turning what a service said into what it means.
//
// Errors reach a person through the panel, the journal and the popup, and
// they arrive as whatever the other side happened to send: a JSON body, a
// bundler code, a marketplace's support link. "FOMO API 400:
// {"success":false,"message":"Swap value $1.65 is below minimum $2.00"...}"
// is a complete and useless sentence, it says nothing about what to do, and
// the one fact in it is buried in punctuation.
//
// This is the one place that knows the shapes. A recognised error becomes a
// short line saying what happened and, where there is one, what to do about
// it. Anything unrecognised is passed through untouched: a wrong guess would
// be worse than the raw text, and the raw text is what a bug report needs.

import { t } from './i18n.js';

/** `$1.65` → `1.65`, tolerating spaces and commas. */
const money = (s) => String(s ?? '').replace(/[$,\s]/g, '');

/**
 * Each rule: a test against the raw message, and what to say instead.
 * Ordered, the first match wins, so put the specific before the general.
 */
const RULES = [
  {
    // FOMO refuses a trade under their floor. The numbers are in the body.
    when: /ERR_SWAP_BELOW_MINIMUM|below minimum/i,
    say: (text) => {
      const m = /value\s+\$?([\d.,]+)\s+is below minimum\s+\$?([\d.,]+)/i.exec(text);
      return m
        ? t('why.belowMinimum', { value: money(m[1]), min: money(m[2]) })
        : t('why.belowMinimumPlain');
    },
  },
  {
    // The session key signed for an account that does not run our contract.
    when: /AA24|signature error/i,
    say: () => t('why.aa24'),
  },
  {
    // Two operations for one wallet under one nonce key.
    when: /AA25|invalid account nonce/i,
    say: () => t('why.aa25'),
  },
  {
    // Their own simulation refused the route, not the trade.
    when: /simulation reverted|dflow_/i,
    say: () => t('why.routeReverted'),
  },
  {
    when: /\b429\b|rate limit|too many requests/i,
    say: () => t('why.rateLimited'),
  },
  {
    // FOMO binds the session token to the IP that logged in.
    when: /\b430\b/,
    say: () => t('why.ipChanged'),
  },
  {
    when: /Failed to fetch|NetworkError|ERR_NETWORK|ECONNREFUSED|ETIMEDOUT/i,
    say: () => t('why.network'),
  },
  {
    when: /\b40[13]\b|unauthor|invalid auth token/i,
    say: () => t('why.unauthorized'),
  },
  {
    when: /insufficient funds/i,
    say: () => t('why.noGas'),
  },
];

/**
 * @param {unknown} error a message, an Error, or anything stringifiable
 * @returns {string} a short human sentence, or the original text unchanged
 */
export function explain(error) {
  const text = String(error?.message ?? error ?? '').trim();
  if (!text) return text;
  for (const rule of RULES) {
    if (rule.when.test(text)) return rule.say(text);
  }
  return text;
}

/**
 * The same, keeping the original for anyone who needs the detail, a bug
 * report, a support ticket, the journal.
 *
 * @returns {{text: string, raw: string, known: boolean}}
 */
export function explainFully(error) {
  const raw = String(error?.message ?? error ?? '').trim();
  const text = explain(raw);
  return { text, raw, known: text !== raw };
}
