// The MAIN ↔ ISOLATED bus against a hostile page.
//
// Both worlds and the page share one window. The bus must give the page
// neither a way to READ what the worlds say to each other nor a way to SPEAK
// as one of them. These tests play the page: they listen on the window, forge
// requests, and try to slip in a port of their own.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ISO, MAIN, NS, PORT_KIND, createChannel } from '../src/shared/bus.js';

const ORIGIN = 'https://fomo.family';

/**
 * A window with the two things the bus uses: postMessage (delivered as a task,
 * like the browser does) and EventTarget listeners with capture order and
 * stopImmediatePropagation.
 */
class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.location = { origin: ORIGIN };
  }

  postMessage(data, targetOrigin, transfer = []) {
    const ev = new Event('message');
    Object.defineProperties(ev, {
      data: { value: data },
      origin: { value: ORIGIN },
      source: { value: this },
      ports: { value: transfer },
    });
    setTimeout(() => this.dispatchEvent(ev), 0);
  }
}

const tick = (ms = 30) => new Promise((r) => { setTimeout(r, ms); });

/** Both worlds on one window, in the injection order the browser gives (ISO then MAIN, or the reverse). */
function worlds(win, { isoFirst = true, mainHandlers = {}, isoHandlers = {} } = {}) {
  let iso;
  let main;
  const makeIso = () => createChannel({ self: ISO, peer: MAIN, handlers: isoHandlers, win });
  const makeMain = () => createChannel({ self: MAIN, peer: ISO, handlers: mainHandlers, win, portWaitMs: 500 });
  if (isoFirst) { iso = makeIso(); main = makeMain(); } else { main = makeMain(); iso = makeIso(); }
  return { iso, main };
}

test('the two worlds talk in both directions, whichever was injected first', async () => {
  for (const isoFirst of [true, false]) {
    const win = new FakeWindow();
    const { iso, main } = worlds(win, {
      isoFirst,
      isoHandlers: { bg: ({ type }) => `bg:${type}` },
      mainHandlers: { 'privy.status': () => ({ installed: true }) },
    });
    assert.equal(await main('bg', { type: 'sample.load' }), 'bg:sample.load');
    assert.deepEqual(await iso('privy.status'), { installed: true });
    await assert.rejects(iso('nope'), /no handler for "nope" in world main/);
  }
});

test('a page listener registered after the content scripts never sees the port handover', async () => {
  const win = new FakeWindow();
  const seen = [];
  const { main } = worlds(win, { isoHandlers: { bg: () => 1 } });
  // The page's first script: it runs after both content scripts, and it
  // listens for everything the window delivers.
  win.addEventListener('message', (ev) => seen.push(ev.data), true);
  win.addEventListener('message', (ev) => seen.push(ev.data));
  await main('bg', { type: 'rpc.getCode' });
  assert.deepEqual(seen.filter((m) => m?.ns === NS), [], 'no handover, no request and no reply reached the page');
});

test('a request forged on the window is not answered and reaches no handler', async () => {
  const win = new FakeWindow();
  let calls = 0;
  const { main } = worlds(win, {
    mainHandlers: { 'session.grant': () => { calls += 1; return 'granted'; } },
    isoHandlers: { bg: () => { calls += 1; return 'secret'; } },
  });
  const replies = [];
  win.addEventListener('message', (ev) => { if (ev.data?.kind === 'res') replies.push(ev.data); });
  // As the page would forge them: the exact shapes the worlds use.
  win.postMessage({ ns: NS, from: ISO, to: MAIN, kind: 'req', id: 'x1', type: 'session.grant', payload: { key: '0xattacker' } }, ORIGIN);
  win.postMessage({ ns: NS, from: MAIN, to: ISO, kind: 'req', id: 'x2', type: 'bg', payload: { type: 'sample.load' } }, ORIGIN);
  await tick(60);
  assert.equal(calls, 0);
  assert.deepEqual(replies, []);
  // The real channel still works.
  assert.equal(await main('bg', {}), 'secret');
  assert.equal(calls, 1);
});

test('a second port offered to MAIN is closed unused, and the offer is invisible to page listeners', async () => {
  const win = new FakeWindow();
  const { main } = worlds(win, { isoHandlers: { bg: () => 'real' } });
  await main('bg', {});

  // The page offers MAIN a channel of its own, in the exact handover shape.
  const page = new MessageChannel();
  const onPage = [];
  let closed = false;
  page.port1.addEventListener('message', (ev) => onPage.push(ev.data));
  page.port1.addEventListener('close', () => { closed = true; });
  page.port1.start();
  page.port1.unref();
  const pageSaw = [];
  win.addEventListener('message', (ev) => pageSaw.push(ev.data));
  win.postMessage({ ns: NS, kind: PORT_KIND, to: MAIN, from: ISO }, ORIGIN, [page.port2]);
  await tick(60);
  // Had MAIN attached to it, this request would be answered.
  page.port1.postMessage({ ns: NS, from: ISO, to: MAIN, kind: 'req', id: 'p1', type: 'privy.status' });
  await tick(60);
  assert.deepEqual(onPage, [], 'nothing ever comes back on the page\'s port');
  assert.equal(closed, true, 'the offered port was closed by MAIN');
  assert.deepEqual(pageSaw.filter((m) => m?.kind === PORT_KIND), [], 'stopImmediatePropagation hides even the page\'s own offer from later listeners');
  assert.equal(await main('bg', {}), 'real', 'the real channel is untouched');
  page.port1.close();
});

test('MAIN alone fails its calls instead of waiting forever', async () => {
  const win = new FakeWindow();
  const main = createChannel({ self: MAIN, peer: ISO, handlers: {}, win, portWaitMs: 50 });
  await assert.rejects(main('bg', {}), /never connected/);
});

test('an unknown world is refused', () => {
  assert.throws(() => createChannel({ self: 'page', peer: MAIN, win: new FakeWindow() }), /unknown world/);
});

test('a page that replaces the MessageEvent.data getter after the handover learns nothing about the port', async () => {
  // The bus reads event fields through getters captured at module load; a
  // getter installed later by page code is never invoked, so it cannot use
  // `this.target` to reach the private MessagePort.
  const win = new FakeWindow();
  const { iso, main } = worlds(win, { isoHandlers: { bg: () => 'sample' }, mainHandlers: { ping: () => true } });
  await main('bg', {});
  const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
  let stolen = null;
  let invoked = 0;
  Object.defineProperty(MessageEvent.prototype, 'data', {
    ...descriptor,
    get() {
      invoked += 1;
      if (this.target instanceof MessagePort) stolen = this.target;
      return descriptor.get.call(this);
    },
  });
  try {
    assert.equal(await iso('ping', {}), true);
    assert.equal(await main('bg', {}), 'sample');
  } finally {
    Object.defineProperty(MessageEvent.prototype, 'data', descriptor);
  }
  assert.equal(stolen, null, 'the port never passed through the replaced getter');
  assert.equal(invoked, 0, 'the replaced getter was never called by the bus');
});

test('a page that replaces Promise.prototype.then after the handover never gets the send closure', async () => {
  // A transport that called `ready.then(send => …)` would be lost here:
  // `then` is a lookup on a prototype the page owns after document_start, and
  // a poisoned `then` would be handed the resolved value, the private `send`
  // closure, and with it the page could speak as the MAIN world. Capturing
  // the MessageEvent getters (the test above) does nothing against this: the
  // port never comes into it, the closure IS the port.
  const win = new FakeWindow();
  const { main } = worlds(win, {
    isoHandlers: { bg: ({ type }) => (type === 'sample.load' ? { envelope: 'SYNTHETIC-SAMPLE' } : true) },
    mainHandlers: { ping: () => true },
  });
  await main('bg', { type: 'ping' });

  const realThen = Promise.prototype.then;
  let captured = null;
  let seen = 0;
  Promise.prototype.then = function poisoned(onFulfilled, onRejected) {
    seen += 1;
    const wrap = typeof onFulfilled === 'function'
      ? (value) => { if (typeof value === 'function') captured = value; return onFulfilled(value); }
      : onFulfilled;
    return Reflect.apply(realThen, this, [wrap, onRejected]);
  };
  try {
    await Reflect.apply(realThen, main('bg', { type: 'ping' }), [(v) => v]);
  } finally {
    Promise.prototype.then = realThen;
  }
  assert.equal(captured, null, 'the send closure was never handed to page code');
  assert.equal(seen, 0, 'the transport did not call the page\'s `then` at all');
});

test('a page that replaces Map.prototype.get after the handover cannot collect an answer', async () => {
  // The second half of the same probe: with the send closure in hand the page
  // forged a request under an id of its own, then poisoned `Map.prototype.get`
  // so that the pending slot the transport looked up was the page's, and the
  // answer to `sample.load`, the stored Privy envelope, resolved into page
  // code. Both halves are closed by capturing the methods at module load.
  const win = new FakeWindow();
  const { main } = worlds(win, {
    isoHandlers: { bg: () => ({ envelope: 'SYNTHETIC-SAMPLE' }) },
    mainHandlers: { ping: () => true },
  });
  const realGet = Map.prototype.get;
  let obtained = null;
  let asked = 0;
  Map.prototype.get = function poisoned(key) {
    asked += 1;
    if (String(key).startsWith('page-')) {
      return { timer: null, resolve(value) { obtained = value; }, reject() {} };
    }
    return Reflect.apply(realGet, this, [key]);
  };
  try {
    const answer = await main('bg', { type: 'sample.load' });
    assert.deepEqual(answer, { envelope: 'SYNTHETIC-SAMPLE' }, 'the legitimate call still works');
  } finally {
    Map.prototype.get = realGet;
  }
  assert.equal(obtained, null, 'no answer reached page-controlled code');
  assert.equal(asked, 0, 'the transport did not call the page\'s `get` at all');
});

test('a page that installs an Object.prototype.then getter does not see the answer', async () => {
  // The thenable check. Fulfilling a promise with an object makes the ENGINE
  // read `then` off that object, and the read walks its prototype chain, so
  // a getter the page installs on Object.prototype after the handover runs
  // with `this` bound to the response, on every ordinary answer. Capturing
  // Promise.prototype.then does nothing about it: no method of ours is
  // called. The answer carries an own `then` of undefined instead, which the
  // check finds first.
  const win = new FakeWindow();
  const { main } = worlds(win, {
    isoHandlers: { bg: ({ type }) => (type === 'sample.load' ? { syntheticSecret: 'SYNTHETIC-NOT-A-TOKEN' } : true) },
    mainHandlers: { ping: () => true },
  });
  await main('bg', { type: 'ping' });

  let leaked = null;
  Object.defineProperty(Object.prototype, 'then', {
    configurable: true,
    get() {
      if (Object.hasOwn(this, 'syntheticSecret')) leaked = this.syntheticSecret;
      return undefined;
    },
  });
  let answer;
  try {
    answer = await main('bg', { type: 'sample.load' });
  } finally {
    delete Object.prototype.then;
  }
  assert.equal(leaked, null, 'the page getter never received the response object');
  assert.equal(answer.syntheticSecret, 'SYNTHETIC-NOT-A-TOKEN', 'and the caller still got its answer');
  // The shield is invisible to ordinary use of the value.
  assert.deepEqual(Object.keys(answer), ['syntheticSecret']);
  assert.equal(JSON.stringify(answer), '{"syntheticSecret":"SYNTHETIC-NOT-A-TOKEN"}');
});

test('an array answer is shielded too, and a real thenable is left alone', async () => {
  const win = new FakeWindow();
  const { main } = worlds(win, {
    isoHandlers: { bg: () => [{ id: 'o1' }, { id: 'o2' }] },
    mainHandlers: {},
  });
  // Only OUR answer is counted: while the getter is installed the runtime
  // resolves promises of its own, and those are not what this asserts.
  let touched = 0;
  Object.defineProperty(Object.prototype, 'then', {
    configurable: true,
    get() {
      if (Array.isArray(this) && this.length === 2 && this[0]?.id === 'o1') touched += 1;
      return undefined;
    },
  });
  let list;
  try {
    list = await main('bg', {});
  } finally {
    delete Object.prototype.then;
  }
  assert.equal(touched, 0, 'Array.prototype inherits from Object.prototype, the array needs the shield as well');
  assert.deepEqual(list.map((o) => o.id), ['o1', 'o2']);
});

test('a page that installs a Promise.prototype.constructor getter never reaches the port', async () => {
  // The third way in, after `then` and the thenable check. Native
  // `Promise.prototype.then` performs SpeciesConstructor, which reads
  // `constructor` off the promise, a lookup that lands on the page's
  // prototype. The getter is handed the promise itself, and a promise is a
  // handle to its value: attach a saved native `then` and the value follows.
  // A transport that fulfilled one such promise with the private `send`
  // closure would make this read the port.
  const win = new FakeWindow();
  const { main } = worlds(win, {
    isoHandlers: { bg: () => ({ syntheticSecret: 'SYNTHETIC-NOT-A-TOKEN' }) },
    mainHandlers: { ping: () => true },
  });
  await main('bg', { type: 'ping' });

  const realThen = Promise.prototype.then;
  const seen = [];
  const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
  Object.defineProperty(Promise.prototype, 'constructor', {
    configurable: true,
    get() { seen.push(this); return descriptor.value; },
  });
  let answer;
  try {
    answer = await main('bg', { type: 'sample.load' });
  } finally {
    Object.defineProperty(Promise.prototype, 'constructor', descriptor);
  }
  assert.equal(answer.syntheticSecret, 'SYNTHETIC-NOT-A-TOKEN', 'the legitimate call still works');

  // Whatever the getter did collect, none of it may resolve to a function:
  // the only function worth stealing here is the port's `send`.
  const values = await Promise.all(seen.map((p) => (
    p instanceof Promise
      ? Reflect.apply(realThen, p, [(v) => v, () => null])
      : null
  )));
  assert.equal(values.some((v) => typeof v === 'function'), false, 'no captured promise carries the send closure');
  assert.equal(values.some((v) => v && typeof v === 'object' && 'syntheticSecret' in v), false, 'nor the answer');
});
