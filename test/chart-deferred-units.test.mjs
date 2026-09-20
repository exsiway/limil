// A level deferred until the chart exists must keep the numbers that place it.
//
// THE BUG, reported twice and fixed here. At a page load the panel syncs
// before FOMO has constructed the chart widget, so the request is held and
// drawn when the chart becomes ready. What was held was only `{orders,
// tokenAddress}`: the market cap and the price of the token were dropped on
// the way. Without them a level cannot be converted, so it stayed the market
// cap it is stored as, and on a chart drawn in prices (any blue chip: the
// axis reads ~2,600 while the level reads ~313,000,000,000) the scale check
// dropped it. The person saw a take-profit that vanished on every reload.
//
// Moving between tokens never showed it: by then the widget exists, nothing
// is deferred, and the units travel with the request. That asymmetry, the
// line coming back after a trip to another token and dying on reload, is what
// pointed here.
//
// The bridge is driven for real: a fake TradingView namespace is installed
// the way the page installs the library, and what reaches the chart is read
// off the fake.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

/** ETH as the app reported it while this was being chased. */
const CAP = 310.48e9;
const PRICE = 2572.9;
const TARGET = 322555705673.96216;
const ADDRESS = '7vfcxtuxx5wjv5jadk17duj4ksgau7utnkj4b963voxs';

const ORDER = {
  id: 'ord_reload',
  side: 'sell',
  inTokenId: `${ADDRESS}:1399811149`,
  outTokenId: 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v:1399811149',
  targetMarketCapUsd: TARGET,
  triggerWhen: 'at-or-above',
  amountPercent: 100,
};

/** A chart that records what was drawn on it, with a price axis like ETH's. */
function fakeChart() {
  const drawn = [];
  return {
    drawn,
    getAllShapes: () => [],
    removeEntity() {},
    getVisibleRange: () => ({ from: 1_758_000_000, to: 1_758_003_000 }),
    getPanes: () => [{
      getMainSourcePriceScale: () => ({
        // The axis of a blue chip: prices, not caps.
        getVisiblePriceRange: () => ({ from: 2500, to: 2650 }),
      }),
    }],
    onSymbolChanged: () => ({ subscribe() {} }),
    createShape(point, options) {
      drawn.push({ price: point.price, text: options?.overrides?.text });
      return `shape_${drawn.length}`;
    },
  };
}

/**
 * Loads a fresh bridge with a fake page around it and hands back the chart
 * the widget will report, plus the bridge itself.
 */
async function bridgeOnAPage(tag) {
  globalThis.window = {};
  const bridge = await import(`../src/main/chart-bridge.js?${tag}`);
  const chart = fakeChart();
  bridge.install({});
  /** Constructing the widget is what the page does once its data is up. */
  const construct = () => {
    let ready = null;
    globalThis.window.TradingView = {
      widget: function Widget() {
        this.onChartReady = (cb) => { ready = cb; };
        this.activeChart = () => chart;
      },
    };
    // eslint-disable-next-line no-new
    new globalThis.window.TradingView.widget({});
    ready?.();
  };
  return { bridge, chart, construct };
}

test('the chart is not ready yet: the level is drawn in prices once it is', async () => {
  const { bridge, chart, construct } = await bridgeOnAPage('deferred');

  // The panel syncs at page load, before FOMO built the chart.
  const first = bridge.syncOrders({
    orders: [ORDER], tokenAddress: ADDRESS, marketCapUsd: CAP, tokenPriceUsd: PRICE,
  });
  assert.equal(first.drawn, 0);
  assert.match(first.skipped.join(' '), /deferred/, 'held until the chart appears');
  assert.equal(chart.drawn.length, 0);

  // The chart appears and the held request is flushed.
  construct();

  assert.equal(chart.drawn.length, 1, 'the level is on the chart');
  const { price, text } = chart.drawn[0];
  // THE POINT: converted with this token's supply, so it lands on the axis.
  const expected = TARGET / (CAP / PRICE);
  assert.ok(Math.abs(price - expected) < 1e-6, `expected ~${expected}, got ${price}`);
  assert.ok(price > 2600 && price < 2800, `a price-scale level, got ${price}`);
  // The regression it replaces: the raw cap, off the axis by eight orders.
  assert.notEqual(price, TARGET);
  assert.match(text, /^Take Profit/, 'and it says what it is');
});

test('the chart was already there: nothing changes for the ordinary path', async () => {
  const { bridge, chart, construct } = await bridgeOnAPage('immediate');
  construct();

  const report = bridge.syncOrders({
    orders: [ORDER], tokenAddress: ADDRESS, marketCapUsd: CAP, tokenPriceUsd: PRICE,
  });
  assert.equal(report.drawn, 1);
  assert.equal(chart.drawn.length, 1);
  assert.ok(chart.drawn[0].price > 2600 && chart.drawn[0].price < 2800);
});

test('no units at all: the level waits instead of being blamed on the axis', async () => {
  const { bridge, chart, construct } = await bridgeOnAPage('unitless');
  construct();

  const report = bridge.syncOrders({
    orders: [ORDER], tokenAddress: ADDRESS, marketCapUsd: null, tokenPriceUsd: null,
  });
  assert.equal(report.drawn, 0, 'a cap cannot be put on a price axis');
  assert.equal(chart.drawn.length, 0);
  assert.match(report.skipped.join(' '), /cap and price of this token are not known yet/,
    'said as what it is, so the journal does not accuse the order');
});
