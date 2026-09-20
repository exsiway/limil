// The units a level is drawn with belong to ONE token, and they arrive late.
//
// A level is stored as a market cap; the chart may be drawn in caps or in
// prices, and only the cap and the price of THAT token, read together, say
// which (see chart-units.test.mjs for the conversion itself). Two things went
// wrong around that conversion, and both looked to a person like a level that
// vanishes:
//
//   1. The panel handed the chart `state.marketCapUsd` raw. After a move from
//      one token to another that number is the PREVIOUS token's until the new
//      balances arrive, so the supply used to convert was the wrong token's.
//      `freshMarketCap()` already refuses a foreign or stale cap; the two call
//      sites that fed the chart simply went around it.
//   2. Nothing redrew once the right numbers arrived. They come over the
//      network a moment after a load or a token change, and until then a cap
//      cannot be put on an axis drawn in prices: the level is dropped as out
//      of scale. `applyTokenInfo` and `applyBalances` only re-rendered the
//      panel, so on a blue chip the level stayed missing until the order list
//      happened to change.
//
// The panel needs a DOM to run, so this is checked against the source, the
// way panel-trust.test.mjs does.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { levelForAxis } from '../src/main/chart-bridge.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'src/isolated/limit-ui.js'), 'utf8');
const bridge = readFileSync(join(root, 'src/main/chart-bridge.js'), 'utf8');

/** The body of a top-level function, by name. */
function bodyOf(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `${signature} is still there`);
  const rest = source.slice(at);
  const end = rest.search(/\n}\n/);
  return rest.slice(0, end + 2);
}

test('every chart sync takes its units from the guarded getter', () => {
  for (const signature of ['function syncChart(', 'export async function refreshChartLines(']) {
    const body = bodyOf(ui, signature);
    assert.match(body, /\.\.\.chartUnits\(\)/, `${signature} spreads chartUnits()`);
    // The regression: reading the remembered numbers straight out of state,
    // which is what handed one token's supply to another token's level.
    assert.doesNotMatch(body, /marketCapUsd:\s*state\.marketCapUsd/, `${signature} does not read the cap raw`);
    assert.doesNotMatch(body, /tokenPriceUsd:\s*state\.priceUsd/, `${signature} does not read the price raw`);
  }
});

test('the price is dropped together with the cap it was read beside', () => {
  const body = bodyOf(ui, 'function chartUnits(');
  assert.match(body, /const marketCapUsd = freshMarketCap\(\);/, 'the cap comes from the guarded getter');
  // Alone the price converts nothing: it is half of the supply.
  assert.match(body, /marketCapUsd === null \? null/, 'no cap means no price either');
});

test('a response that brings the units asks for a redraw, and only then', () => {
  const body = bodyOf(ui, 'function redrawWhenUnitsArrive(');
  assert.match(body, /if \(hadUnits \|\| freshMarketCap\(\) === null\) return;/,
    'only on the transition from no units to units, or the lines flicker');
  assert.match(body, /syncChart\(\);/);

  for (const signature of ['export function applyTokenInfo(', 'export function applyBalances(']) {
    const apply = bodyOf(ui, signature);
    assert.match(apply, /const hadUnits = freshMarketCap\(\) !== null;/,
      `${signature} samples the units BEFORE it applies the response`);
    assert.match(apply, /redrawWhenUnitsArrive\(hadUnits\);/, `${signature} asks for the redraw`);
    const sampledAt = apply.indexOf('const hadUnits');
    const setAt = apply.indexOf('state.marketCapUsd = info.marketCapUsd;');
    assert.ok(sampledAt >= 0 && setAt >= 0 && sampledAt < setAt,
      `${signature} samples before it overwrites, otherwise the transition is never seen`);
  }
});

test('a level that could not be converted is reported as deferred, not as a bad level', () => {
  const body = bodyOf(bridge, 'export function syncOrders(');
  assert.match(body, /const unconverted = !\(Number\(marketCapUsd\) > 0\) \|\| !\(Number\(tokenPriceUsd\) > 0\);/);
  assert.match(body, /deferred, the cap and price of this token are not known yet/);
  // `deferred` is the word chartTrouble() filters on, so the ordinary first
  // sync after a load stays out of the journal while a real misplacement does
  // not: see chart-trouble.test.mjs.
  assert.match(body, /not in the scale of the axis/, 'the real complaint is still made');
});

test('why it mattered: without the units an ETH level cannot reach a price axis', () => {
  // The numbers from the live account: the level is a cap, the axis is a price.
  const level = 313.3e9;
  const axis = 2575.05;
  // No cap and no price for the token, which is the first sync after a load.
  const unconverted = levelForAxis({ level, marketCapUsd: null, tokenPriceUsd: null, reference: axis });
  assert.equal(unconverted, level, 'the level is returned as the cap it is');
  assert.ok(unconverted / axis > 1000, 'and a cap on a price axis is off the scale, so it is dropped');

  // The same level once the two numbers for THIS token have arrived.
  const converted = levelForAxis({ level, marketCapUsd: 310.9e9, tokenPriceUsd: axis, reference: axis });
  assert.ok(converted / axis < 1.1 && converted / axis > 0.9, `expected a price-scale level, got ${converted}`);
});

test('a foreign token supply would put the level nowhere near the axis', () => {
  // Standing on ETH with the memecoin's cap and price still remembered: the
  // supply is the memecoin's, and the ETH level converts to nonsense.
  const level = 313.3e9;
  const wrong = levelForAxis({
    level, marketCapUsd: 4.1e6, tokenPriceUsd: 0.00413, reference: 2575.05,
  });
  assert.ok(wrong / 2575.05 > 1000, `a foreign supply lands off the axis, got ${wrong}`);
});
