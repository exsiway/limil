// Rules of the unattended runner.
//
// This is the only place where the extension spends money without a person,
// so what is checked above all is what it does NOT do: switched off it does
// not trade, failures do not hammer the API, and a bug that decides to
// execute everything at once runs into the daily limit.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_CONFIRMATIONS, shouldTrigger } from '../src/shared/trigger.js';
import {
  limitsWith,
  RUNNER_LIMITS,
  armState,
  decide,
  firesToday,
  orderGate,
  runnerGate,
  trimLog, nextToQuote, senderMismatch } from '../src/shared/runner.js';

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

const armed = (over = {}) => ({
  armed: true,
  sessionKeyAddress: '0x1111111111111111111111111111111111111111',
  armedUntil: NOW + HOUR,
  log: [],
  ...over,
});

const order = (over = {}) => ({ id: 'o1', status: 'watching', ...over });
const FIRE = { fire: true, reason: 'price reached' };
const WAIT = { fire: false, reason: '1 of 3 samples' };

// ------------------------------------------------------------- arming

test('without a session key it does not work', () => {
  // A forgotten setting must mean inaction, not trading.
  assert.equal(armState({}).armed, false);
  assert.equal(armState(undefined).armed, false);
  assert.match(armState({}).reason, /no session key/);
});

test('a key and no pause: it works without any arming', () => {
  // No person-set term is required here; one that ran out would silently
  // stop the order being watched. The term is held by the session key
  // on chain: it has its own validUntil and maxOps, which the extension
  // cannot bypass.
  const s = armState(armed(), { now: NOW });
  assert.equal(s.armed, true);
  assert.equal(s.reason, null);
});

test('an expired term from old state no longer switches anything off', () => {
  // State written by a previous build holds armedUntil in the past. Reading it
  // as "off" would inherit exactly the refusal arming was removed to fix.
  const s = armState(armed({ armedUntil: NOW - 1 }), { now: NOW });
  assert.equal(s.armed, true);
});

test('the only gate is the presence of a key, and it is the only meaningful one', () => {
  // Neither a term nor a pause: both were state that silently blocks an order
  // and is indistinguishable from a dead box from the outside. What remains
  // is what cannot be bypassed in substance: nothing to sign with.
  assert.equal(armState(armed()).armed, true);
  assert.equal(armState(armed({ sessionKeyAddress: null })).armed, false);
  assert.equal(armState(armed({ paused: true })).armed, true, 'a forgotten flag means nothing any more');
});

// -------------------------------------------------------- daily limit

test('executions are counted per day, not per lifetime', () => {
  const log = [
    { at: NOW - 25 * HOUR, fired: true },
    { at: NOW - 2 * HOUR, fired: true },
    { at: NOW - HOUR, fired: false },
  ];
  assert.equal(firesToday(log, { now: NOW }), 1, "yesterday's and the ones that did not fire do not count");
});

test('the daily limit stops everything', () => {
  // A bug that decides to execute everything at once runs into this.
  const log = Array.from({ length: RUNNER_LIMITS.maxFiresPerDay }, () => ({ at: NOW, fired: true }));
  const g = runnerGate(armed({ log }), { now: NOW });
  assert.equal(g.ok, false);
  assert.match(g.reason, /executions today/);
});

// ------------------------------------------------------------ per order

test('an order not in status watching is left alone', () => {
  for (const status of ['filled', 'cancelled', 'failed']) {
    assert.equal(orderGate(order({ status }), [], { now: NOW }).ok, false, status);
  }
});

test('after failures the order is parked for the operator', () => {
  // Repeating what does not work forever means hammering the API all night.
  const attempts = Array.from(
    { length: RUNNER_LIMITS.maxAttemptsPerOrder },
    (_, i) => ({ at: NOW - (i + 1) * HOUR, ok: false }),
  );
  const g = orderGate(order(), attempts, { now: NOW });
  assert.equal(g.ok, false);
  assert.equal(g.exhausted, true);
});

test('the pause between attempts is respected', () => {
  const g = orderGate(order(), [{ at: NOW - 1000, ok: false }], { now: NOW });
  assert.equal(g.ok, false);
  assert.match(g.reason, /pause/);
  // Once the pause is over, go ahead.
  const later = orderGate(order(), [{ at: NOW - RUNNER_LIMITS.cooldownMs, ok: false }], { now: NOW });
  assert.equal(later.ok, true);
});

test('successful attempts do not count towards the failure limit', () => {
  const attempts = Array.from({ length: 10 }, () => ({ at: NOW - HOUR, ok: true }));
  assert.equal(orderGate(order(), attempts, { now: NOW }).ok, true);
});

// -------------------------------------------------------------- decision

test('a switched-off runner does not fire even on a triggered price', () => {
  // The most important property: the price and the permission are separate questions.
  const d = decide({ runner: { armed: false }, order: order(), trigger: FIRE, now: NOW });
  assert.equal(d.act, 'stop');
  assert.notEqual(d.act, 'fire');
});

test('an armed runner fires on a triggered price', () => {
  const d = decide({ runner: armed(), order: order(), trigger: FIRE, now: NOW });
  assert.equal(d.act, 'fire');
});

test('price not reached: keep watching and say why', () => {
  const d = decide({ runner: armed(), order: order(), trigger: WAIT, now: NOW });
  assert.equal(d.act, 'watch');
  assert.match(d.reason, /samples/);
});

test('an exhausted order is shelved, not skipped silently', () => {
  // Different outcomes: a shelved order needs attention, a skipped one comes back on its own.
  const attempts = Array.from(
    { length: RUNNER_LIMITS.maxAttemptsPerOrder },
    () => ({ at: NOW - HOUR, ok: false }),
  );
  const d = decide({ runner: armed(), order: order(), attempts, trigger: FIRE, now: NOW });
  assert.equal(d.act, 'shelve');
});

test('a pause gives skip, which differs from stop', () => {
  const d = decide({
    runner: armed(), order: order(), attempts: [{ at: NOW, ok: false }], trigger: FIRE, now: NOW,
  });
  assert.equal(d.act, 'skip', 'this order waits, the others do not');
});

test('a missing trigger is not a triggered price', () => {
  // A price source failure must not read as "time to execute".
  const d = decide({ runner: armed(), order: order(), trigger: undefined, now: NOW });
  assert.equal(d.act, 'watch');
});

// --------------------------------------------------------------- the log

test('the log does not grow without bound', () => {
  const log = Array.from({ length: 500 }, (_, i) => ({ at: i }));
  const trimmed = trimLog(log, 200);
  assert.equal(trimmed.length, 200);
  assert.equal(trimmed.at(-1).at, 499, 'the fresh entries are kept, not the first');
});

// ------------------------------------------------- window versus tick step
//
// The quietest defect possible: the runner ticks faithfully, writes the log
// and NEVER fires. The freshness window equalled the alarm step, so the first
// sample fell out of it exactly when the third one arrived.

test('the sample window fits all the required confirmations', () => {
  // Three confirmations at a one-minute step take two minutes; the window must
  // be wider, otherwise the counter never reaches the threshold.
  const spanMs = (DEFAULT_CONFIRMATIONS - 1) * RUNNER_LIMITS.pollMinutes * 60_000;
  assert.ok(
    RUNNER_LIMITS.sampleWindowMs > spanMs,
    `a window of ${RUNNER_LIMITS.sampleWindowMs} ms does not fit ${spanMs} ms of confirmations`,
  );
});

test('over three consecutive ticks the order reaches the trigger', () => {
  // A run in the same units as a live tick: the step is exactly pollMinutes.
  const step = RUNNER_LIMITS.pollMinutes * 60_000;
  let samples = [];
  const results = [];
  for (let tick = 0; tick < DEFAULT_CONFIRMATIONS; tick += 1) {
    const at = tick * step;
    samples = [...samples, { out: '1000', at }];
    results.push(shouldTrigger({
      targetOut: '1', samples, now: at, windowMs: RUNNER_LIMITS.sampleWindowMs,
    }).fire);
  }
  assert.equal(results.at(-1), true, 'must fire by the third tick');
});

test('with the old one-minute window it would never have fired', () => {
  // The control: without it the test above does not prove the defect existed.
  const step = RUNNER_LIMITS.pollMinutes * 60_000;
  let samples = [];
  let fired = false;
  for (let tick = 0; tick < 10; tick += 1) {
    const at = tick * step;
    samples = [...samples, { out: '1000', at }].slice(-10);
    if (shouldTrigger({ targetOut: '1', samples, now: at, windowMs: 60_000 }).fire) fired = true;
  }
  assert.equal(fired, false, 'ten ticks with the narrow window give no trigger at all');
});

// ------------------------------- daily limit: configurable and explainable

test('the execution limit is raised by a setting, but not above the ceiling', () => {
  assert.equal(limitsWith({}).maxFiresPerDay, 5);
  assert.equal(limitsWith({ runnerMaxFiresPerDay: 12 }).maxFiresPerDay, 12);
  // It cannot be removed entirely: a safety without a limit is no safety.
  assert.equal(limitsWith({ runnerMaxFiresPerDay: 9999 }).maxFiresPerDay, 50);
  // Garbage is ignored, the default stays.
  assert.equal(limitsWith({ runnerMaxFiresPerDay: 0 }).maxFiresPerDay, 5);
  assert.equal(limitsWith({ runnerMaxFiresPerDay: 'lots' }).maxFiresPerDay, 5);
});

test('executions older than a day do not count towards the limit', () => {
  const now = Date.now();
  const log = [
    { at: now - 25 * 3600_000, fired: true },
    { at: now - 1000, fired: true },
  ];
  assert.equal(firesToday(log, { now }), 1);
});

test('nextToQuote: an order already at its target is quoted first, the rest round-robin from the least recently asked', () => {
  const orders = [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' },
  ];
  const asked = { a: 100, b: 50, c: 0, d: 400, e: 300 };
  const pick = nextToQuote(orders, { lastAskedAt: (o) => asked[o.id], reached: (o) => o.id === 'd', limit: 3 });
  assert.deepEqual(pick.map((o) => o.id), ['d', 'c', 'b'], 'd is confirming (most recently asked, but first); then never-asked c, then b');
  const few = nextToQuote(orders.slice(0, 2), { lastAskedAt: () => 0, reached: () => false, limit: 3 });
  assert.equal(few.length, 2, 'under the limit nothing is dropped');
});

test('senderMismatch: an order for another wallet is named; the same wallet or an unknown one is no verdict', () => {
  const me = '0xCaFeCaFeCaFeCaFeCaFeCaFeCaFeCaFeCaFeCaFe';
  assert.equal(senderMismatch({ sender: me }, me.toLowerCase()), null);
  assert.equal(senderMismatch({ sender: me }, null), null, 'unknown signed-in: no verdict');
  assert.equal(senderMismatch({ sender: null }, me), null, 'no sender: no verdict');
  const m = senderMismatch({ sender: '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb' }, me);
  assert.equal(m.sender, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(m.signedIn, me.toLowerCase());
});
