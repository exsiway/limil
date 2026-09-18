// The side panel keeps the FOMO tab "visible" for the page while it mirrors
// it (main/awake.js). Checked on a fake Document: the getters answer the
// browser's truth until the switch is on, the page is told when it flips,
// and the switch is flipped only by the mirror's start and stop.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A Document with the browser's own getters, installed before the module loads.
let real = 'hidden';
const events = [];
class FakeDocument {}
Object.defineProperty(FakeDocument.prototype, 'visibilityState', { configurable: true, enumerable: true, get() { return real; } });
Object.defineProperty(FakeDocument.prototype, 'hidden', { configurable: true, enumerable: true, get() { return real === 'hidden'; } });
globalThis.Document = FakeDocument;
globalThis.document = Object.assign(new FakeDocument(), { dispatchEvent: (ev) => { events.push(`document:${ev.type}`); return true; } });
globalThis.window = { dispatchEvent: (ev) => { events.push(`window:${ev.type}`); return true; } };
globalThis.Event = class { constructor(type) { this.type = type; } };

const awake = await import('../src/main/awake.js');

test('installed, the getters still tell the truth', () => {
  assert.equal(awake.install(), true);
  assert.equal(document.visibilityState, 'hidden');
  assert.equal(document.hidden, true);
  real = 'visible';
  assert.equal(document.visibilityState, 'visible');
  assert.equal(document.hidden, false);
  real = 'hidden';
  assert.deepEqual(awake.status(), { on: false, installed: true, real: 'hidden' });
});

test('on: the page sees visible and hears about it; off: the truth again', () => {
  events.length = 0;
  assert.deepEqual(awake.setAwake(true), { on: true, installed: true, real: 'hidden' });
  assert.equal(document.visibilityState, 'visible');
  assert.equal(document.hidden, false);
  assert.deepEqual(events, ['document:visibilitychange', 'window:focus']);
  events.length = 0;
  awake.setAwake(true);
  assert.deepEqual(events, [], 'no event when nothing changed');
  assert.deepEqual(awake.setAwake(false), { on: false, installed: true, real: 'hidden' });
  assert.equal(document.visibilityState, 'hidden');
  assert.deepEqual(events, ['document:visibilitychange']);
});

test('only the mirror flips it, on start and on stop', () => {
  const mirror = readFileSync(join(root, 'src/isolated/feed-mirror.js'), 'utf8');
  const main = readFileSync(join(root, 'src/main/index.js'), 'utf8');
  const content = readFileSync(join(root, 'src/isolated/content.js'), 'utf8');
  assert.equal([...mirror.matchAll(/keepAwake\((true|false)\)/g)].map((m) => m[1]).join(','), 'true,false');
  assert.match(mirror.slice(mirror.indexOf('function start()')), /^function start\(\) \{\s*if \(state\.pageWatch\) return;\s*keepAwake\(true\);/m);
  assert.match(mirror.slice(mirror.indexOf('function stop()')), /^function stop\(\) \{\s*keepAwake\(false\);/m);
  assert.match(main, /^awake\.install\(\);/m, 'installed at document_start, before the page');
  assert.match(main, /'awake\.set': \(\{ on \} = \{\}\) => awake\.setAwake\(on\)/);
  assert.match(content, /feedMirror\.attachMain\(callMain\)/);
  // Nothing else in the extension speaks of it.
  for (const file of ['src/isolated/feed-buy.js', 'src/isolated/limit-ui.js', 'src/background/runner.js', 'src/popup/popup.js']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /awake\.set|setAwake/, `${file}`);
  }
});

test('while on and really hidden, an animation frame is a short timer; otherwise the native one', async () => {
  // A fresh module instance with a window that has frames.
  const calls = [];
  globalThis.window = {
    dispatchEvent: (ev) => { events.push(`window:${ev.type}`); return true; },
    requestAnimationFrame: (cb) => { calls.push('native'); return 7; },
    cancelAnimationFrame: (id) => { calls.push(`cancel:${id}`); },
  };
  globalThis.performance ??= { now: () => 0 };
  const fresh = await import(`../src/main/awake.js?frames=${Date.now()}`);
  assert.equal(fresh.install(), true);
  real = 'hidden';
  assert.equal(window.requestAnimationFrame(() => {}), 7, 'off: native frames');
  fresh.setAwake(true);
  let ran = false;
  const id = window.requestAnimationFrame(() => { ran = true; });
  assert.ok(id >= 2 ** 31, 'a timer id in its own range');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ran, true, 'the frame callback ran off a timer');
  const id2 = window.requestAnimationFrame(() => { throw new Error('never'); });
  window.cancelAnimationFrame(id2);
  await new Promise((r) => setTimeout(r, 40));
  window.cancelAnimationFrame(7);
  assert.deepEqual(calls.filter((c) => c.startsWith('cancel')), ['cancel:7'], 'a native id goes to the native cancel');
  real = 'visible';
  assert.equal(window.requestAnimationFrame(() => {}), 7, 'visible: native frames even while on');
  fresh.setAwake(false);
});
