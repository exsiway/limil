// Limit order trigger tests.
//
// Quotes drift by up to 4.5% between refreshes seconds apart. The naive check
// "latest value >= target" fires on a spike that is gone a second later. These
// tests check that it does not, the main property of a limit order.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_CONFIRMATIONS,
  MARGIN_CAP_BPS,
  freshSamples,
  median,
  shouldTrigger,
  spreadBps,
} from '../src/shared/trigger.js';

const NOW = 1_800_000_000_000;
const at = (secondsAgo) => NOW - secondsAgo * 1000;
const s = (out, secondsAgo) => ({ out: String(out), at: at(secondsAgo) });

test('the median survives a single outlier, the mean does not', () => {
  assert.equal(median([100n, 101n, 100n]), 100n);
  assert.equal(median([100n, 100n, 200n]), 100n);
  assert.equal(median([100n, 200n]), 150n);
  assert.throws(() => median([]), /empty sample set/);
});

test('the spread is measured relative to the median', () => {
  assert.equal(spreadBps([100n, 100n, 100n]), 0);
  // 95..105 at a median of 100 is 1000 bps of spread.
  assert.equal(spreadBps([95n, 100n, 105n]), 1000);
});

test('stale samples take no part in the decision', () => {
  const samples = [s(100, 5), s(100, 300), s(100, 10)];
  const fresh = freshSamples(samples, { now: NOW, windowMs: 60_000 });
  assert.equal(fresh.length, 2);
  assert.ok(fresh[0].at < fresh[1].at);
});

test('a single crossing does NOT fire the order', () => {
  const verdict = shouldTrigger({
    targetOut: '1000',
    samples: [s(990, 30), s(995, 20), s(1005, 5)],
    now: NOW,
  });
  assert.equal(verdict.fire, false);
  assert.match(verdict.reason, /target confirmed 1 of/);
});

test('a target held for three consecutive samples fires the order', () => {
  const verdict = shouldTrigger({
    targetOut: '1000',
    samples: [s(1002, 30), s(1004, 20), s(1003, 5)],
    now: NOW,
  });
  assert.equal(verdict.fire, true);
  assert.equal(verdict.confirmed, DEFAULT_CONFIRMATIONS);
});

test('with too few samples the order waits instead of firing', () => {
  const verdict = shouldTrigger({ targetOut: '1000', samples: [s(1100, 1)], now: NOW });
  assert.equal(verdict.fire, false);
  assert.match(verdict.reason, /of 3/);
});

// The drift observed live: 2380 -> 2486 -> 2399, spread ~4.4%. All three above
// the target, so the order may fire, drift alone does not block execution when
// the condition holds on every sample.
test('normal drift does not block a trigger', () => {
  const verdict = shouldTrigger({
    targetOut: '2300',
    samples: [s(2380, 30), s(2486, 20), s(2399, 5)],
    now: NOW,
  });
  assert.equal(verdict.fire, true);
  assert.ok(verdict.spreadBps > 400 && verdict.spreadBps < 500, `spread ${verdict.spreadBps}`);
});

test('an abnormal spread blocks the decision', () => {
  const verdict = shouldTrigger({
    targetOut: '1000',
    samples: [s(1100, 30), s(2500, 20), s(1200, 5)],
    now: NOW,
  });
  assert.equal(verdict.fire, false);
  assert.match(verdict.reason, /spread is/);
});

test('a zero target is a configuration error, not a silent refusal', () => {
  assert.throws(() => shouldTrigger({ targetOut: '0', samples: [] }), /above zero/);
});

// --------------------------------------------------------------- stop loss

const smp = (out, t) => ({ out: String(out), at: t });

test('a stop loss does NOT fire while the price is above its target', () => {
  const samples = [smp(1000n, 1), smp(1010n, 2), smp(1005n, 3)];
  const r = shouldTrigger({
    targetOut: 980n, direction: 'at-or-below', samples, now: 4,
  });
  assert.equal(r.fire, false, 'price above target, no drop happened');
  assert.match(r.reason, /drop to target confirmed 0 of/);
});

test('the same set fires a take profit, the direction is the only difference', () => {
  const samples = [smp(1000n, 1), smp(1010n, 2), smp(1005n, 3)];
  const r = shouldTrigger({
    targetOut: 980n, direction: 'at-or-above', samples, now: 4,
  });
  assert.equal(r.fire, true);
});

test('a stop loss fires when the price has dropped to the target', () => {
  const samples = [smp(975n, 1), smp(970n, 2), smp(978n, 3)];
  const r = shouldTrigger({
    targetOut: 980n, direction: 'at-or-below', samples, now: 4,
  });
  assert.equal(r.fire, true);
  assert.match(r.reason, /drop to target holds for 3/);
});

test('without a direction the behaviour is take profit', () => {
  const samples = [smp(1000n, 1), smp(1000n, 2), smp(1000n, 3)];
  assert.equal(shouldTrigger({ targetOut: 900n, samples, now: 4 }).fire, true);
  assert.equal(shouldTrigger({ targetOut: 1100n, samples, now: 4 }).fire, false);
});

// ------------------------------ margin beyond the target: noise is not a move

test('a target inside the noise does not fire even with all three samples beyond it', () => {
  // All three below the target, but the median is beyond it by only 5 at a
  // spread of almost 200 bps, jitter, not a drop.
  const samples = [smp(975n, 1), smp(960n, 2), smp(978n, 3)];
  const r = shouldTrigger({ targetOut: 980n, direction: 'at-or-below', samples, now: 4 });
  assert.equal(r.fire, false);
  assert.match(r.reason, /edge/);
  assert.match(r.reason, /noise, not a move/);
});

test('a real drop beyond the target fires', () => {
  const samples = [smp(940n, 1), smp(930n, 2), smp(945n, 3)];
  const r = shouldTrigger({ targetOut: 980n, direction: 'at-or-below', samples, now: 4 });
  assert.equal(r.fire, true);
  assert.match(r.reason, /edge/);
});

test('the same rule applies to a take profit', () => {
  const thin = [smp(1025n, 1), smp(1010n, 2), smp(1040n, 3)];
  assert.equal(shouldTrigger({ targetOut: 1020n, samples: thin, now: 4 }).fire, false);

  const solid = [smp(1080n, 1), smp(1075n, 2), smp(1090n, 3)];
  assert.equal(shouldTrigger({ targetOut: 1020n, samples: solid, now: 4 }).fire, true);
});

test('the spread is shown in the ordinary waiting line, not only on a trigger', () => {
  const samples = [smp(1000n, 1), smp(1010n, 2), smp(990n, 3)];
  const r = shouldTrigger({ targetOut: 1200n, samples, now: 4 });
  assert.equal(r.fire, false);
  assert.match(r.reason, /spread \d+ bps/);
});

test('the margin cap keeps the protection from eating the target', () => {
  assert.equal(MARGIN_CAP_BPS, 150);

  // Spread 1000 bps: half would be 500, the cap leaves 150.
  const samples = [smp(9840n, 1), smp(10000n, 2), smp(9200n, 3)];
  const r = shouldTrigger({ targetOut: 10000n, direction: 'at-or-below', samples, now: 4 });
  // Median 9840, target 10000, margin 150 bps = 150 -> need <= 9850. Passes.
  assert.equal(r.fire, true, r.reason);
});

test('on a quiet token the margin stays at half the spread', () => {
  // Spread 50 bps -> margin 25, the cap does not intervene. The edge is only
  // 10, below the margin: the crossing does not count.
  const thin = [smp(9950n, 1), smp(10000n, 2), smp(9990n, 3)];
  const r = shouldTrigger({ targetOut: 10000n, direction: 'at-or-below', samples: thin, now: 4 });
  assert.equal(r.fire, false, r.reason);
  assert.match(r.reason, /noise, not a move/);
});
