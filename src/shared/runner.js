// Rules of the runner.
//
// This is the one place in the project where money moves without a person
// present. Everything else the user starts by hand and sees the result; here
// they are asleep and the extension decides that it is time. The permission
// logic is therefore isolated here and covered by tests: it cannot be checked
// by a live run, because a live run is money spent.
//
// Nothing here touches the network, storage or signatures: only decisions on
// the state it is given, so hundreds of scenarios run in milliseconds.

import { t } from './i18n.js';

/** Default limits. Each answers "what if it goes haywire". */
export const RUNNER_LIMITS = Object.freeze({
  /** How often to wake up. One minute is the minimum chrome.alarms offers. */
  pollMinutes: 1,
  /**
   * Window in which samples count as fresh. It must fit every confirmation:
   * with one sample per minute and three confirmations, three samples take
   * two minutes and the rest is slack for alarms that chrome.alarms does not
   * promise to fire on time.
   */
  sampleWindowMs: 4 * 60_000,
  /** Pause between attempts on ONE order: a failure must not hammer the API. */
  cooldownMs: 120_000,
  /** Attempts per order before it is parked for the user to look at. */
  maxAttemptsPerOrder: 3,
  /**
   * Executions per rolling day. A bug that fires everything at once is bounded
   * by it. The default grows with the number of live orders (see `limitsWith`)
   * and can never be removed: a fuse without a limit is not a fuse.
   */
  maxFiresPerDay: 5,
  /** Above this the limit is never raised, not even by a setting. */
  maxFiresPerDayCeiling: 50,
});

/**
 * Whether the runner is working right now.
 *
 * There is no "arm for N hours" action and no manual pause. Both were states
 * that silently stopped an order from being watched and looked, from the
 * outside, exactly like a dead machine. The fuse lives where the extension
 * cannot bypass it: the session key has its own expiry (`validUntil`) and its
 * own operation count (`maxOps`) in the contract. To stop the runner, cancel
 * the orders or disable the extension in chrome://extensions.
 *
 * Returns the reason in words: "did not fire" without an explanation is
 * especially harmful here, because the user believes the order is watched.
 */
export function armState(runner) {
  if (!runner?.sessionKeyAddress) {
    return { armed: false, reason: t('runner.noKey') };
  }
  return { armed: true, reason: null };
}

/**
 * Limits adjusted for the user's setting and the number of live orders.
 *
 * The daily ceiling exists against a runaway loop, not against a person with
 * ten limit orders, for whom five executions is an ordinary day. So it is
 * computed from the work that legitimately exists: two firings per live order,
 * never below the default and never above the hard ceiling.
 */
export function limitsWith(settings = {}, base = RUNNER_LIMITS, liveOrders = 0) {
  const raw = Number(settings?.runnerMaxFiresPerDay);
  if (Number.isInteger(raw) && raw >= 1) {
    return { ...base, maxFiresPerDay: Math.min(raw, base.maxFiresPerDayCeiling) };
  }
  const needed = Math.max(base.maxFiresPerDay, Number(liveOrders) * 2);
  return { ...base, maxFiresPerDay: Math.min(needed, base.maxFiresPerDayCeiling) };
}

/** Executions in the last 24 hours, counted from the journal. */
export function firesToday(log = [], { now = Date.now() } = {}) {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  return log.filter((e) => e?.fired && Number(e.at) >= dayAgo).length;
}

/**
 * The common gate: may the runner do anything at all this round. Checked
 * before the orders are examined, so one reason is written once rather than
 * repeated per order.
 */
export function runnerGate(runner, { now = Date.now(), limits = RUNNER_LIMITS } = {}) {
  const arm = armState(runner, { now, limits });
  if (!arm.armed) return { ok: false, reason: arm.reason };

  const fires = firesToday(runner.log ?? [], { now });
  if (fires >= limits.maxFiresPerDay) {
    return {
      ok: false,
      reason: t('runner.dailyLimit', { fires, max: limits.maxFiresPerDay }),
    };
  }
  return { ok: true, reason: null, firesToday: fires };
}

/**
 * May this particular order be touched.
 *
 * @param {object} order the stored order
 * @param {object[]} attempts attempts on this order: {at, ok}
 */
export function orderGate(order, attempts = [], { now = Date.now(), limits = RUNNER_LIMITS } = {}) {
  if (order?.status !== 'watching') {
    return { ok: false, reason: t('runner.status', { status: order?.status ?? t('runner.noStatus') }) };
  }
  const failed = attempts.filter((a) => !a.ok).length;
  if (failed >= limits.maxAttemptsPerOrder) {
    return {
      ok: false,
      reason: t('runner.failed', { n: failed }),
      exhausted: true,
    };
  }
  const last = attempts.at(-1);
  if (last && now - Number(last.at) < limits.cooldownMs) {
    const wait = Math.ceil((limits.cooldownMs - (now - Number(last.at))) / 1000);
    return { ok: false, reason: t('runner.cooldown', { s: wait }) };
  }
  return { ok: true, reason: null };
}

/**
 * What to do with an order this round.
 *
 * Separate from `shouldTrigger` on purpose: that answers "has the price
 * arrived", this answers "are we allowed to act". Mixing them would let a
 * disabled runner still consider the price as triggered.
 *
 * @param {object} opts
 * @param {object} opts.runner runner state
 * @param {object} opts.order the order
 * @param {object[]} opts.attempts attempts on this order
 * @param {{fire: boolean, reason: string}} opts.trigger result of shouldTrigger
 */
export function decide({ runner, order, attempts = [], trigger, now = Date.now(), limits = RUNNER_LIMITS }) {
  const gate = runnerGate(runner, { now, limits });
  if (!gate.ok) return { act: 'stop', reason: gate.reason };

  const orderOk = orderGate(order, attempts, { now, limits });
  if (!orderOk.ok) {
    return { act: orderOk.exhausted ? 'shelve' : 'skip', reason: orderOk.reason };
  }

  if (!trigger?.fire) return { act: 'watch', reason: trigger?.reason ?? t('runner.watch') };
  return { act: 'fire', reason: t('runner.fire') };
}

/**
 * A journal entry for one round. Failures and inaction are recorded too:
 * "why did nothing happen overnight" is the first question in the morning,
 * and the answer must be in storage rather than in guesses.
 */
export function logEntry({ orderId, act, reason, fired = false, detail = null, now = Date.now() }) {
  return { at: now, orderId, act, reason, fired, detail };
}

/**
 * Whether a report proves the position did not move, so the order may go on
 * watching after a send.
 *
 * This is the one question that decides whether an order can fire a second
 * time, so the answer is deliberately narrow: only an outcome the chain
 * showed. `receipt.success === false` is set by the executors for a receipt
 * that says reverted, a Solana transaction that landed and failed, and one
 * dropped before inclusion. Everything else about which nobody can be sure,
 * a receipt that never came, a relay leg without a terminal status, a lost
 * answer, is `null`, and `null` is not proof.
 *
 * Reading an unknown outcome as a revert is how one sale becomes two.
 */
export function positionProvenIntact(report) {
  return Boolean(report?.sent) && report?.receipt?.success === false;
}

/**
 * The order an interrupted execution left behind, if any.
 *
 * A round writes a marker to storage before it asks the page to execute and
 * removes it only once that order's outcome has been written. Finding one at
 * the start of a round means a previous worker stopped in between: the browser
 * was closed, the extension reloaded, the process killed. The in-memory lock
 * that normally prevents a second attempt died with it, and the order is still
 * `watching`.
 *
 * It errs towards closing. A worker that died while still quoting sent
 * nothing, and its order is taken off watch anyway, which costs an order that
 * has to be placed again. The other direction costs a second sale.
 *
 * Nobody can say from here whether that operation reached the bundler. The
 * only safe reading is that it might have, so the order comes off the watch
 * list for a person to look at rather than being sent again.
 *
 * @returns {string|null} the order id to close, or null when there is nothing
 *   to recover: no ticket, an unused one, or an order already closed.
 */
export function interruptedAttempt({ attempt = null, ticket = null } = {}, orders) {
  // The attempt marker is written before the page is asked to execute, on
  // every chain, and cleared only after the outcome of that order has been
  // written. So a marker still here at the start of a round means the round
  // that wrote it never finished. The spent ticket is the older signal and is
  // kept for a browser upgraded mid-flight; on Solana it never gets spent,
  // because Privy signs on the page, which is exactly why the marker exists.
  const id = attempt?.orderId ?? (ticket?.used ? ticket.orderId : null);
  if (!id) return null;
  const order = (Array.isArray(orders) ? orders : []).find((o) => o?.id === id);
  return order?.status === 'watching' ? order.id : null;
}

/**
 * Whether an execution that ended in an error may already have sent something.
 *
 * The error itself says very little: a page that has gone silent throws the
 * same way whether it sent nothing or sent everything. So the answer comes
 * from what was recorded while things still worked.
 *
 * EVM is decided by the signature. Nothing can reach the bundler without the
 * session key, so an unspent ticket means nothing went out.
 *
 * Solana is not, because Privy signs on the page. Two records cover it: the
 * page's own `AFTER SEND` marker, which needs a working channel to come back
 * through, and the attempt marker the page writes BEFORE sending, which
 * survives a closed tab and a lost message port. Without the second, losing
 * the page between the send and its answer was indistinguishable from never
 * having sent, and the order was free to fire again.
 *
 * @param {boolean} signed        the signing ticket was spent (EVM)
 * @param {boolean} solanaSide    the transaction is a Solana one
 * @param {string} message        the error as it arrived
 * @param {boolean} attemptSent   the page marked the attempt before sending
 */
export function sendMayHaveHappened({ signed = false, solanaSide = false, message = '', attemptSent = false } = {}) {
  if (signed) return true;
  if (!solanaSide) return false;
  return /^AFTER SEND/.test(String(message ?? '')) || Boolean(attemptSent);
}

/** Journal trimming: it lives in chrome.storage and cannot grow without bound. */
export function trimLog(log, max = 200) {
  return log.slice(-max);
}

/**
 * Which orders get quoted this round when there are more than the round can
 * take. Round-robin from the one not asked for longest, so nobody starves,
 * except an order whose last quote already reached its target: it is
 * gathering confirmations, and those expire with the sample window. With
 * sixteen orders and three quotes a round an order would be sampled once
 * every eight minutes and never gather its three: a plain round-robin
 * starves exactly the orders about to fire. Pure.
 *
 * @param {object[]} orders
 * @param {object} o
 * @param {(order) => number} o.lastAskedAt   0 when never asked
 * @param {(order) => boolean} o.reached      the last sample met the target
 * @param {number} o.limit                    quotes this round may spend
 */
export function nextToQuote(orders, { lastAskedAt, reached, limit }) {
  if (orders.length <= limit) return orders;
  const rank = (o) => (reached(o) ? 0 : 1);
  return [...orders].sort((a, b) => rank(a) - rank(b) || lastAskedAt(a) - lastAskedAt(b)).slice(0, limit);
}

/**
 * An order this browser must not execute: its `sender` is a wallet other
 * than the account the browser is signed in to. The source of an EVM sell is
 * the order (sender + grant) while its proceeds and its PnL line follow the
 * signed-in session: with two accounts in one browser, money can move from
 * one to the other. Unknown signed-in wallet: no verdict here; the
 * runner decides (an order from the hub is refused, an order placed in this
 * browser proceeds). Pure.
 */
export function senderMismatch(order, signedIn) {
  const a = String(order?.sender ?? '').toLowerCase();
  const b = String(signedIn ?? '').toLowerCase();
  if (!a || !b) return null;
  return a === b ? null : { sender: a, signedIn: b };
}
