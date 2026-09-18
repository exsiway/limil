// The order list, and the one queue every change to it goes through.
//
// The list is a single array in `chrome.storage.local`. Every change is a
// read, a change and a write, with an await on either side, and the service
// worker runs its callers concurrently: the panel adding an order, the runner
// closing a filled one, the daemon applying a remote verdict and the mirror
// merging the hub's list are four separate read-modify-write cycles over the
// same key. Two that overlap leave the later write on top of a stale array,
// and the loss is quiet in both directions, an added order that vanishes is
// never executed, a cancelled one that comes back is executed after the user
// said no. That is money either way, so there is exactly one place to write
// this array from and it is here.
//
// Reads stay outside the queue on purpose: a list one write stale is
// harmless, and queueing reads would serialise the whole panel behind a
// network round of the runner.

const KEY = 'orders';

/**
 * How many orders are kept. When the list is longer, CLOSED orders fall off
 * the end first; a live one is dropped only when the whole list is live, which
 * takes two hundred open orders. A plain `slice` would drop the oldest
 * entries whatever their status, so a stop-loss placed long ago could vanish
 * under two hundred later placements, and a page that could add orders could
 * erase every live one by adding two hundred.
 */
export const MAX_ORDERS = 200;

/** Trims a list to MAX_ORDERS, closed orders first, order of the rest preserved. */
export function trimOrders(orders) {
  if (orders.length <= MAX_ORDERS) return orders;
  let toDrop = orders.length - MAX_ORDERS;
  const kept = [];
  // Walk from the end: the list is newest first, so the oldest closed orders go first.
  for (let i = orders.length - 1; i >= 0; i -= 1) {
    const o = orders[i];
    if (toDrop > 0 && o?.status !== 'watching') { toDrop -= 1; continue; }
    kept.push(o);
  }
  kept.reverse();
  return kept.length > MAX_ORDERS ? kept.slice(0, MAX_ORDERS) : kept;
}

/**
 * Orders from a storage bag, without broken entries. `chrome.storage` gives
 * back an `undefined` array element as `null`, and one such hole would throw
 * on `o.status` and take the whole list with it.
 */
function readOrders(bag) {
  const raw = bag?.[KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((o) => o && typeof o === 'object');
}

/** The list as it stands. Not queued, see the note above. */
export async function loadOrders() {
  return readOrders(await chrome.storage.local.get(KEY));
}

let writes = Promise.resolve();

async function apply(fn) {
  const current = await loadOrders();
  const outcome = await fn(current);
  const next = Array.isArray(outcome) ? { orders: outcome } : (outcome ?? {});
  // A change that decided against writing says so by leaving `orders` out;
  // the daemon's pull does that on every round where nothing moved.
  if (Array.isArray(next.orders)) {
    await chrome.storage.local.set({ [KEY]: trimOrders(next.orders) });
  }
  return next.result;
}

/**
 * Changes the order list under the queue.
 *
 * @param {(orders: object[]) => object[]|{orders?: object[], result?: any}|Promise<...>} fn
 *   receives the current list and returns the new one, or an object carrying
 *   the new list plus whatever the caller wants back. Omitting `orders`
 *   writes nothing.
 * @returns {Promise<any>} whatever `fn` put in `result`
 *
 * Do not await a network call inside `fn`: the queue is held for its whole
 * length, and a long poll there would stop every other writer for as long as
 * the hub stays silent. Fetch first, then change.
 *
 * The chain itself never rejects, so one failed change cannot wedge the
 * queue; its own caller still gets the error.
 */
export function mutateOrders(fn) {
  const run = writes.then(() => apply(fn), () => apply(fn));
  writes = run.then(() => {}, () => {});
  return run;
}
