// Output guard: floor arithmetic, call assembly, revert recognition.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  GUARD_ADDRESS, GUARD_CASH, GUARD_ERRORS, RELAY_DEPOSITORY, SEL_ASSERT, SEL_SNAPSHOT,
  guardCalls, guardFloor, guardSupported, looksLikeGuardRevert, verifyGuardCalls,
} from '../src/shared/output-guard.js';

// The stored target is in the quote scale 1e18: $100 = 100e18.
const USD = 10n ** 18n;

test('floor = target × (1 − slippage) in the six decimals of the token; quote fees are informational only', () => {
  const f = guardFloor({ targetOutScaled: 100n * USD, maxSlippageBps: 500, usdFees: { relay: 0.02, app: 0.5 } });
  assert.equal(f.afterSlippage, 95_000_000n);
  assert.equal(f.floor, 95_000_000n, 'no fee mark-up in the floor');
  assert.equal(f.quoteFeesUnits, 520_000n);
});

test('a deposit of $1.976 at a target of $2.078 and 10% passes without a mark-up', () => {
  const f = guardFloor({ targetOutScaled: 2_078_159_000_000_000_000n, maxSlippageBps: 1000, usdFees: { relay: 0.657 } });
  assert.equal(f.floor, 1_870_343n);
  assert.ok(1_976_027n >= f.floor);
});

test('a target of 2.0988 USDC at 10% gives a floor of about 1.89 USDG, not 1.9e18', () => {
  const f = guardFloor({ targetOutScaled: 2_098_779_900_000_898_600n, maxSlippageBps: 1000 });
  assert.equal(f.afterSlippage, 1_888_901n);
  assert.ok(f.floor < 10_000_000n, 'the floor is in six decimals, not in the quote scale');
});

test('without fees in the quote the floor is the same', () => {
  const f = guardFloor({ targetOutScaled: 100n * USD, maxSlippageBps: 1000 });
  assert.equal(f.floor, 90_000_000n);
  assert.equal(f.quoteFeesUnits, 0n);
});

test('zero slippage, the floor equals the target; the floor is never zero', () => {
  assert.equal(guardFloor({ targetOutScaled: 777n * USD, maxSlippageBps: 0 }).floor, 777_000_000n);
  assert.equal(guardFloor({ targetOutScaled: 1n, maxSlippageBps: 9999 }).floor, 1n);
  assert.throws(() => guardFloor({ targetOutScaled: 0n, maxSlippageBps: 500 }), /not positive/);
  assert.throws(() => guardFloor({ targetOutScaled: 100n, maxSlippageBps: 10000 }), /outside 0\.\.9999/);
  assert.throws(() => guardFloor({ targetOutScaled: 100n, maxSlippageBps: 100, decimals: 19 }), /scale/);
});

test('guard calls: snapshot and check on the chain token and the relay depository', () => {
  const g = guardCalls({ chainId: 4663, minGain: 95n });
  assert.equal(g.before.target, GUARD_ADDRESS);
  assert.equal(g.before.data.slice(0, 10), SEL_SNAPSHOT);
  assert.equal(g.after.data.slice(0, 10), SEL_ASSERT);
  assert.ok(g.before.data.toLowerCase().includes(GUARD_CASH[4663].token.slice(2)));
  assert.ok(g.after.data.toLowerCase().includes(RELAY_DEPOSITORY.slice(2)));
  assert.equal(verifyGuardCalls([g.before, { target: '0x1', value: 0n, data: '0xdeadbeef' }, g.after], { chainId: 4663, minFloor: 95n }), null);
  assert.throws(() => guardCalls({ chainId: 4663, minGain: 0n }), /above zero/);
  assert.throws(() => guardCalls({ chainId: 1, minGain: 1n }), /not described/);
});

test('an undescribed chain has no guard, and not silently', () => {
  assert.equal(guardSupported(4663), true);
  assert.equal(guardSupported(8453), true);
  assert.equal(guardSupported(1), false);
  assert.match(verifyGuardCalls([], { chainId: 1, minFloor: 1n }), /not described/);
});

test('a guard revert is recognised by name and by error selector', () => {
  assert.equal(looksLikeGuardRevert('execution reverted: OutputBelowFloor(94000000, 95000000)'), true);
  assert.equal(looksLikeGuardRevert(`bundler refused (-32521): execution reverted ${GUARD_ERRORS.OutputBelowFloor}000000`), true);
  assert.equal(looksLikeGuardRevert('AA23 reverted: signature error'), false);
  assert.equal(looksLikeGuardRevert(null), false);
});
