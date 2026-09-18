// FOMO's Tokens list places its rows 53px apart whatever they measure. The
// arithmetic that places them by their real height instead (shared/fixed-list.js).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ratioOf, rowHeightOf, scaledTop, stepOf } from '../src/shared/fixed-list.js';

test('the step is the most common distance between the tops, whatever order they come in', () => {
  assert.equal(stepOf([106, 0, 53, 159, 212]), 53);
  assert.equal(stepOf([0, 53, 106, 2014, 2067]), 53, 'a container parked far away does not change it');
  assert.equal(stepOf([0, 53, 53, 106]), 53, 'two rows on one top (mid-recycle) are one top');
  assert.equal(stepOf([0]), null);
  assert.equal(stepOf([]), null);
  assert.equal(stepOf([0, NaN, 53]), 53);
});

test('the row height is the most common one', () => {
  assert.equal(rowHeightOf([85, 85, 85, 0, 85.4]), 85);
  assert.equal(rowHeightOf([]), null);
});

test('the ratio is real over step, and 1 when the rows already fit', () => {
  assert.equal(ratioOf({ step: 53, rowHeight: 85 }), 85 / 53);
  assert.equal(ratioOf({ step: 53, rowHeight: 53 }), 1);
  assert.equal(ratioOf({ step: 53, rowHeight: 54 }), 1, 'a pixel of rounding is not a taller row');
  assert.equal(ratioOf({ step: null, rowHeight: 85 }), 1);
  assert.equal(ratioOf({ step: 53, rowHeight: null }), 1);
});

test('a top is scaled and rounded', () => {
  const ratio = 85 / 53;
  assert.equal(scaledTop(0, ratio), 0);
  assert.equal(scaledTop(53, ratio), 85);
  assert.equal(scaledTop(106, ratio), 170);
  assert.equal(scaledTop(2014, ratio), 3230);
});

test('the scroll-position shadow lives in the MAIN world, driven by the mark the content script sets', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  const scale = readFileSync(new URL('../src/main/scroll-scale.js', import.meta.url), 'utf8');
  const list = readFileSync(new URL('../src/isolated/token-list.js', import.meta.url), 'utf8');
  assert.match(main, /^scrollScale\.install\(\);/m, 'installed at document_start');
  assert.match(scale, /export const SCALE_ATTR = 'data-limil-scroll-scale';/);
  assert.match(list, /const SCALE_ATTR = 'data-limil-scroll-scale';/, 'the same mark on both sides');
  assert.doesNotMatch(list, /defineProperty\([^)]*scrollTop/, 'the content script defines nothing on the element itself');
  assert.match(scale, /set\(v\) \{ native\.set\.call\(this, v\); \}/, 'writes pass through');
});
