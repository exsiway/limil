// Clamping the tooltip to the window edges.
//
// A tooltip that opened upwards only would run off the edge for cards near
// the top of the window. Checked here: the side is chosen by the free space,
// and the coordinates never leave the window.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { placeTooltip } from '../src/shared/tooltip.js';

const VIEW = { innerWidth: 384, innerHeight: 600 };
const MARGIN = 8;

function anchorAt(rect) {
  return { getBoundingClientRect: () => rect };
}

function tipOf(width, height) {
  const style = {};
  return { getBoundingClientRect: () => ({ width, height }), style };
}

function place(anchorRect, width = 248, height = 120) {
  global.window = VIEW;
  const tip = tipOf(width, height);
  placeTooltip(anchorAt(anchorRect), tip);
  return { top: parseInt(tip.style.top, 10), left: parseInt(tip.style.left, 10) };
}

test('with room above, the tooltip opens upwards', () => {
  const { top } = place({ left: 20, top: 300, bottom: 315 });
  assert.equal(top, 300 - 120 - 8);
});

test('at the top edge it opens downwards, not off screen', () => {
  const { top } = place({ left: 20, top: 10, bottom: 25 });
  assert.ok(top >= MARGIN, `ran off the top: ${top}`);
  assert.equal(top, 25 + 8);
});

test('at the right edge it stays inside the window', () => {
  const { left } = place({ left: 370, top: 300, bottom: 315 });
  assert.ok(left + 248 <= VIEW.innerWidth - MARGIN, `ran off to the right: ${left}`);
});

test('at the left edge it does not go negative', () => {
  const { left } = place({ left: -40, top: 300, bottom: 315 });
  assert.ok(left >= MARGIN, `ran off to the left: ${left}`);
});

// A tall tooltip in a small window: there is room nowhere, but it still may
// not cross the edges, or the text gets cut just the same.
test('when there is room nowhere, the tooltip stays inside the window', () => {
  global.window = { innerWidth: 384, innerHeight: 200 };
  const tip = tipOf(248, 180);
  placeTooltip(anchorAt({ left: 20, top: 90, bottom: 105 }), tip);
  const top = parseInt(tip.style.top, 10);
  assert.ok(top >= MARGIN, `ran off the top: ${top}`);
  assert.ok(top + 180 <= 200, `ran off the bottom: ${top + 180}`);
});
