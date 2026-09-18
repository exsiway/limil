// Promise-based RPC between the MAIN and ISOLATED worlds of one tab, over a
// private MessageChannel.
//
// The MAIN world sees the Privy provider and the DOM but not chrome.* and is
// bound by the page's CSP for network requests; the ISOLATED world sees
// chrome.* and talks to the service worker. Everything the two need from each
// other goes through this channel.
//
// WHY NOT window.postMessage. Both worlds share one `window`, and so does the
// page: every `message` event on it is delivered to the page's listeners as
// well, `ev.source === window` holds for a message the page sends itself, and
// the `ns`/`from`/`to` labels are forged in one line. A bus over the window is
// therefore readable AND writable by any script on fomo.family, the wrong
// property for a channel that carries the Privy envelope sample and commands
// that sign delegations and grants.
//
// A MessagePort has neither problem. Messages on it are delivered to the
// holder of the port and to nobody else; the page cannot enumerate ports it
// was never handed. The one moment the page could interfere is the handover
// of the port itself, and it is closed like this:
//
//   1. The ISOLATED world creates the channel at document_start, its realm is
//      untouchable by the page at any time, and transfers ONE end to the MAIN
//      world with a single window.postMessage.
//   2. The MAIN world registers a capture-phase listener on the window at
//      document_start, i.e. before the page's first line runs, takes the port
//      from the FIRST such message and calls stopImmediatePropagation, so the
//      event never reaches a page listener. Any later message of that shape is
//      also stopped and its port closed unused: there is no second handover.
//   3. Both content scripts are injected in one synchronous pass before the
//      parser resumes, so the handover message, a task queued during that
//      pass, is dispatched after both listeners exist and before any page
//      script has had a chance to post a forgery ahead of it.
//
// The MAIN world lives in the page's realm, so the handful of built-ins this
// module needs (postMessage, addEventListener, stopImmediatePropagation,
// Reflect.apply) are captured at module evaluation, before the page can patch
// their prototypes, and called through those captured references only.
//
// Neither side authenticates the other beyond this: there is no token, because
// no token can be shared over a channel the page can read, and none is needed
// over one it cannot.

export const NS = 'limil';

export const MAIN = 'main';
export const ISO = 'iso';

/** Shape of the one window message that carries the port. */
export const PORT_KIND = 'limil-port';

const DEFAULT_TIMEOUT_MS = 120_000;
/** How long MAIN waits for the port before failing calls. ISO is injected in the same pass; this is generous. */
const PORT_WAIT_MS = 10_000;

// Captured natives. Module evaluation happens at document_start in both
// worlds; in MAIN that is before the page runs, in ISO the page can never
// reach them anyway. In tests `window` is a fake and these fall back to it.
const rApply = Reflect.apply;
const hasOwn = Object.prototype.hasOwnProperty;
const own = (obj, key) => (obj && typeof obj === 'object' && rApply(hasOwn, obj, [key]) ? obj[key] : undefined);

/**
 * Promise and Map, captured whole.
 *
 * Everything the transport does with them is a DYNAMIC lookup: `ready.then(…)`
 * reads `then` off `Promise.prototype` at call time, `pending.get(id)` reads
 * `get` off `Map.prototype`. A page script that replaces either AFTER the
 * handover, it cannot run before it, but it can run a millisecond later,
 * turns those two lookups into its own code: the poisoned `then` is handed
 * the resolved value of `ready`, which is the private `send` closure, and the
 * poisoned `get` is asked for the slot of an id the page just forged, so it
 * receives the answer to a request nobody in this extension made. Neither
 * needs the port: the closure is the port.
 *
 * The MessageEvent getters above were captured for the same reason and are
 * not enough on their own: a page can poison the two prototypes after a
 * legitimate first call. So the methods are taken here,
 * at module evaluation, and every use below goes through `rApply`. The rule
 * for anything added to this file: no dot-call on a value whose prototype the
 * page can reach.
 */
const P = Promise;
const promiseThen = P.prototype.then;
const defineProperty = Object.defineProperty;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const objectCreate = Object.create;
// No captured `catch`: per the specification `Promise.prototype.catch` calls
// `then` back through a property LOOKUP on the promise, so using it would
// hand the page its own hook again. Rejections go through `then` with an
// undefined fulfillment handler instead.

/**
 * Gives a promise an own `constructor` before anything calls `then` on it.
 *
 * The third way in: native
 * `Promise.prototype.then` performs SpeciesConstructor, which READS
 * `constructor` off the promise, and that read walks the prototype chain to
 * `Promise.prototype`, which the page owns after the handover. A getter there
 * is handed the promise itself as `this`, and a promise is a handle to its
 * own value: attach a saved native `then` to it and the value follows.
 * Calling `then` through a captured reference does not help, because the
 * lookup happens INSIDE the native method.
 *
 * An own `constructor` equal to the captured Promise is found first, matches
 * what the specification compares against, and keeps the native behaviour.
 *
 * The deeper answer is not to keep anything worth stealing inside a promise
 * in this realm at all, which is why the port's `send` closure no longer sits
 * in one; see `createChannel`.
 */
function arm(promise) {
  try {
    if (!ownDescriptor(promise, 'constructor')) {
      defineProperty(promise, 'constructor', { value: P, writable: true, enumerable: false, configurable: true });
    }
  } catch { /* frozen: the caller still gets its promise */ }
  return promise;
}
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
const mapHas = Map.prototype.has;

/**
 * The MessageEvent accessors, captured at module evaluation.
 *
 * `ev.data` is not a field: it is a getter on MessageEvent.prototype, and a
 * page script that replaces that getter after the handover runs its own code
 * with `this` bound to the event, whose `target` is our private port. Read
 * through the prototype the port would be handed to whoever asked first. So
 * the native getters are taken once, here, before any page code exists, and
 * every read of data / ports / source / origin goes through them. An event
 * that is not a real MessageEvent (the test double) carries these as own
 * properties, which are read directly.
 */
const eventGetters = (() => {
  const proto = typeof globalThis.MessageEvent === 'function' ? globalThis.MessageEvent.prototype : null;
  const pick = (name) => {
    const d = proto ? Object.getOwnPropertyDescriptor(proto, name) : null;
    return typeof d?.get === 'function' ? d.get : null;
  };
  return { data: pick('data'), ports: pick('ports'), source: pick('source'), origin: pick('origin') };
})();
function readEvent(ev, name) {
  if (rApply(hasOwn, ev, [name])) return ev[name];
  const getter = eventGetters[name];
  if (getter) {
    try { return rApply(getter, ev, []); } catch { /* not a MessageEvent */ }
  }
  return ev[name];
}

function natives(win) {
  const g = globalThis;
  return {
    windowPostMessage: win.postMessage,
    addEventListener: typeof g.EventTarget === 'function' ? g.EventTarget.prototype.addEventListener : win.addEventListener,
    removeEventListener: typeof g.EventTarget === 'function' ? g.EventTarget.prototype.removeEventListener : win.removeEventListener,
    stopImmediate: typeof g.Event === 'function' ? g.Event.prototype.stopImmediatePropagation : null,
    portPostMessage: g.MessagePort.prototype.postMessage,
    portStart: g.MessagePort.prototype.start,
    portClose: g.MessagePort.prototype.close,
    MessageChannel: g.MessageChannel,
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
  };
}

/** Wires request/response handling onto a port. Shared by both worlds once the port is in hand. */
function attach(port, n, { self, handlers, pending }) {
  const send = (msg) => rApply(n.portPostMessage, port, [msg]);
  rApply(n.addEventListener, port, ['message', (ev) => {
    const msg = readEvent(ev, 'data');
    if (!msg || typeof msg !== 'object' || own(msg, 'ns') !== NS) return;
    const kind = own(msg, 'kind');

    if (kind === 'res') {
      const id = own(msg, 'id');
      const slot = rApply(mapGet, pending, [id]);
      if (!slot) return;
      rApply(mapDelete, pending, [id]);
      rApply(n.clearTimeout, null, [slot.timer]);
      const error = own(msg, 'error');
      if (error) slot.reject(new Error(String(error)));
      // Shielded BEFORE it is handed to resolve: that call is where the
      // engine performs the thenable check on the answer.
      else slot.resolve(shield(own(msg, 'result')));
      return;
    }

    if (kind === 'req') {
      const id = own(msg, 'id');
      const type = own(msg, 'type');
      const handler = typeof type === 'string' && rApply(hasOwn, handlers, [type]) ? handlers[type] : null;
      const reply = (patch) => send({ ns: NS, from: self, kind: 'res', id, ...patch });
      if (!handler) {
        reply({ error: `no handler for "${type}" in world ${self}` });
        return;
      }
      // The handler is called directly, not through `Promise.resolve().then`:
      // every promise this module creates is one more object in a realm the
      // page can reach into, and the fewer of them hold anything, the better.
      let answer;
      try {
        answer = handler(own(msg, 'payload'));
      } catch (err) {
        reply({ error: String(err?.message || err) });
        return;
      }
      if (answer instanceof P) {
        rApply(promiseThen, arm(answer), [
          (result) => reply({ result: shield(result) }),
          (err) => reply({ error: String(err?.message || err) }),
        ]);
      } else {
        reply({ result: shield(answer) });
      }
    }
  }]);
  rApply(n.portStart, port, []);
  // Node's MessagePort keeps the process alive; browsers have no unref. Only
  // the test runner ever reaches this line.
  if (typeof port.unref === 'function') port.unref();
  return send;
}

/**
 * Makes a value safe to FULFIL a promise with.
 *
 * Capturing `then` off `Promise.prototype` is not enough: when a promise is fulfilled with an object, the engine itself
 * reads `then` OFF THAT OBJECT, the thenable check, ECMA-262, and that read
 * walks the object's prototype chain. A page that installs a getter on
 * `Object.prototype.then` after the handover therefore has its own code run,
 * with `this` bound to the response, on every ordinary answer. No method of
 * ours is involved, so no amount of capturing prevents it.
 *
 * The fix is to make the read find something before it reaches the page's
 * prototype: an OWN `then` of undefined. `undefined` is not callable, so the
 * promise fulfils with the object unchanged, and the page's getter is never
 * invoked. The property is non-enumerable, so `Object.keys`, `JSON.stringify`
 * and spreading do not see it, and it travels with the object into every
 * later promise the value passes through.
 *
 * What this does NOT cover, stated plainly: a value an `async` handler
 * returns is assimilated by the async function's OWN promise before the bus
 * ever sees it, inside code this module does not control. The boundary that
 * actually decides what a page may learn stays the ISO allow-list
 * (`src/isolated/content.js`), not the privacy of this transport.
 */
function shield(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  // A real promise carries `then` on its own prototype; leave it assimilable.
  if (value instanceof P) return value;
  try {
    // An own `then` is either a genuine thenable or a value already shielded.
    if (ownDescriptor(value, 'then')) return value;
    defineProperty(value, 'then', { value: undefined, writable: true, enumerable: false, configurable: true });
  } catch {
    // Frozen or exotic: nothing to do here. The caller still gets the value.
  }
  return value;
}

/**
 * Opens the channel in the current world.
 *
 * @param {object} opts
 * @param {string} opts.self   id of this world (MAIN | ISO)
 * @param {string} opts.peer   id of the other world
 * @param {Record<string, (payload:any)=>any>} [opts.handlers] what this side answers
 * @param {Window} [opts.win]  the window to hand the port over on (tests pass a fake)
 * @returns {(type:string, payload?:any, timeoutMs?:number)=>Promise<any>} call to the peer
 */
export function createChannel({ self, peer, handlers = {}, win = globalThis.window, portWaitMs = PORT_WAIT_MS }) {
  const n = natives(win);
  const pending = new Map();
  let seq = 0;

  /**
   * The port's `send`, and whoever is waiting for it, deliberately NOT a
   * promise.
   *
   * A promise fulfilled with `send` is a handle to `send`, and in the MAIN
   * world that handle lives in the page's own realm, reachable through
   * `Promise.prototype.then` and through the species lookup inside the native
   * `then`. Capturing methods only moves the
   * hole. A closure and a null-prototype list of waiters have no prototype to
   * poison and no algorithm that reads properties off them, so there is
   * nothing left to hook.
   */
  let sendFn = null;
  let failure = null;
  const waiters = objectCreate(null);
  let waiting = 0;

  function whenReady(onSend, onFail) {
    if (sendFn) { onSend(sendFn); return; }
    if (failure) { onFail(failure); return; }
    waiters[waiting] = { onSend, onFail };
    waiting += 1;
  }

  function portReady(fn) {
    sendFn = fn;
    for (let i = 0; i < waiting; i += 1) waiters[i].onSend(fn);
    waiting = 0;
  }

  function portFailed(err) {
    failure = err;
    for (let i = 0; i < waiting; i += 1) waiters[i].onFail(err);
    waiting = 0;
  }

  if (self === ISO) {
    // The ISOLATED world owns the channel: its MessageChannel constructor is
    // the browser's own, whatever the page does to its realm.
    const channel = new n.MessageChannel();
    const send = attach(channel.port1, n, { self, handlers, pending });
    // One handover, at document_start, with the port TRANSFERRED: after this
    // line this world holds no reference to port2 at all.
    rApply(n.windowPostMessage, win, [
      { ns: NS, kind: PORT_KIND, to: MAIN, from: ISO },
      win.location.origin,
      [channel.port2],
    ]);
    portReady(send);
  } else if (self === MAIN) {
    let taken = false;
    const onMessage = (ev) => {
      const msg = readEvent(ev, 'data');
      if (!msg || typeof msg !== 'object' || own(msg, 'ns') !== NS || own(msg, 'kind') !== PORT_KIND) return;
      // Whatever happens next, the page does not get to see this event: a
      // forgery arriving later must not be answered, and the real handover
      // must not leak its port to a page listener registered after us.
      if (n.stopImmediate) rApply(n.stopImmediate, ev, []);
      else if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      const ports = readEvent(ev, 'ports');
      if (taken || readEvent(ev, 'source') !== win || readEvent(ev, 'origin') !== win.location.origin || !ports || ports.length !== 1) {
        // A second message of this shape has no business here. Its port is
        // closed so that whoever sent it cannot reach anyone through it.
        const stray = ports ?? [];
        for (let i = 0; i < stray.length; i += 1) {
          try { rApply(n.portClose, stray[i], []); } catch { /* not a port */ }
        }
        return;
      }
      taken = true;
      rApply(n.removeEventListener, win, ['message', onMessage, true]);
      portReady(attach(ports[0], n, { self, handlers, pending }));
    };
    rApply(n.addEventListener, win, ['message', onMessage, true]);
    const waitTimer = rApply(n.setTimeout, null, [() => {
      if (!taken) portFailed(new Error('the extension bus never connected: the isolated content script did not hand over its port'));
    }, portWaitMs]);
    if (typeof waitTimer?.unref === 'function') waitTimer.unref();
  } else {
    throw new Error(`unknown world "${self}"`);
  }

  return function call(type, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = `${self}:${++seq}:${Date.now()}`;
    // Armed before it is returned: our own callers will call `then` on it,
    // and that lookup must not reach the page either.
    return arm(new P((resolve, reject) => {
      const timer = rApply(n.setTimeout, null, [() => {
        rApply(mapDelete, pending, [id]);
        reject(new Error(`timed out waiting for "${type}" from world ${peer}`));
      }, timeoutMs]);
      rApply(mapSet, pending, [id, { resolve, reject, timer }]);
      whenReady(
        (send) => send({ ns: NS, from: self, to: peer, kind: 'req', id, type, payload }),
        (err) => {
          if (!rApply(mapHas, pending, [id])) return;
          rApply(mapDelete, pending, [id]);
          rApply(n.clearTimeout, null, [timer]);
          reject(err);
        },
      );
    }));
  };
}
