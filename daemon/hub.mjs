// The hub: it keeps the orders and hands them to the browser that executes.
//
// It does not execute them itself, and the reason is worth keeping written
// down so nobody builds that by accident. A hub could quote relay's public
// API, build the batch, sign with a session key of its own and send
// `handleOps` paid by a gas courier of its own, but:
//
//   Sending trades that way goes around FOMO's pipeline. The balance is
//   right and the position is right, but their app never sees the trade, so
//   there is no PnL entry for it. A trade that does not show up where you
//   read your trades is not worth having, whatever it saves.
//
// So execution belongs to a browser, the owner's, or one on their server
// signed in to the same FOMO account. Those go through FOMO's own bundler,
// which also means FOMO pays the gas and no key of ours ever holds money.
// This process now holds no funds at all: there is no courier and nothing
// here can move a token.
//
// What is left is a post box. The laptop puts orders in, the browser takes
// them out and puts verdicts back, and a version counter lets the browser
// long-poll instead of asking on a timer.

import { refinesVerdict } from '../src/shared/daemon-api.js';

/**
 * @param {object} opts
 * @param {object} opts.state the persisted state (daemon/state.mjs)
 * @param {(text: string) => void} [opts.log]
 */
export function createHub({ state, log = console.log }) {
  /** Bumps the change counter the runner browser long-polls on. */
  function bump() { state.data.version = (state.data.version ?? 0) + 1; }

  /** Takes the order set the extension holds and makes it ours. */
  function syncOrders({ wallet, solanaAddress, orders, sample = null, ownerHeadless = null }) {
    if (!Array.isArray(orders)) throw new Error('orders must be an array');
    state.data.wallet = wallet ?? state.data.wallet;
    state.data.solanaAddress = solanaAddress ?? state.data.solanaAddress;
    // A HEADLESS owner is a program, not a browser: it holds no Privy session
    // and cannot sign a grant. The runner browser reads this off its poll and
    // plans the grants itself (background/headless-grant.js), the one case a
    // runner may, because there is no second browser to collide with at the
    // EntryPoint. A browser owner never sends the field, so an old laptop
    // keeps the old behaviour: absent is unchanged, not false.
    if (typeof ownerHeadless === 'boolean' && state.data.ownerHeadless !== ownerHeadless) {
      state.data.ownerHeadless = ownerHeadless;
      bump();
    }
    // The signing sample from the laptop, tokens redacted: the runner browser
    // uses its shape and puts its own token in. Kept only when it is one.
    if (sample && typeof sample === 'object' && sample.envelope && Array.isArray(sample.rpcPath) && sample.redacted === true) {
      const changed = JSON.stringify(state.data.sample ?? null) !== JSON.stringify(sample);
      state.data.sample = sample;
      if (changed) bump();
    }
    const incoming = new Map(orders.map((o) => [o.id, o]));
    const local = new Map(state.data.orders.map((o) => [o.id, o]));
    const next = [];
    let added = 0;
    let cancelled = 0;
    for (const [id, o] of incoming) {
      const mine = local.get(id);
      if (!mine) { next.push({ ...o, status: 'watching', receivedAt: new Date().toISOString() }); added += 1; continue; }
      // A closed order stays closed: the browser that closed it knows better
      // than a list that was assembled before it did.
      next.push(mine.status === 'watching' ? { ...mine, ...o, status: 'watching' } : mine);
    }
    for (const [id, mine] of local) {
      if (incoming.has(id)) continue;
      if (mine.status === 'watching') {
        next.push({ ...mine, status: 'cancelled', closedAt: new Date().toISOString(), cancelReason: 'removed in the extension' });
        cancelled += 1;
      } else next.push(mine);
    }
    state.data.orders = next.slice(0, 200);
    if (added || cancelled) bump();
    state.save();
    if (added || cancelled) {
      state.note({ kind: 'sync', added, cancelled });
      log(`sync: ${added} added, ${cancelled} cancelled`);
    }
    return { added, cancelled, watching: next.filter((o) => o.status === 'watching').length };
  }

  /**
   * What the runner browser reports back: verdicts on orders it closed, its
   * journal, and which FOMO account it is signed in to.
   *
   * That last one is not decoration. FOMO's swap endpoint takes no wallet
   * argument, the account is whoever asks, so a browser signed in to
   * another account of the owner's quotes for that account and can execute
   * nothing, while looking perfectly connected. The owner's popup compares
   * it with its own and says so.
   */
  /**
   * The runner's lines from this owner's time, and no earlier.
   *
   * A runner browser keeps its own journal in its own storage and its own
   * pairing across an owner change, so the first report after a new owner
   * pairs carries whatever it did for the previous one. Clearing the hub's
   * copy at unpair is not enough: this is where the old lines would come
   * back. An entry with no readable timestamp is dropped rather than kept,
   * because the only thing worse than losing a line is showing it to the
   * wrong person.
   */
  function sinceThisOwner(entries) {
    const since = state.data.ownerSince;
    // No owner at all: between one leaving and the next pairing there is
    // nobody these lines belong to, and keeping them means handing them to
    // whoever pairs next. A runner that keeps reporting into an unowned hub
    // is answered, but its journal is not kept.
    if (!since) return [];
    return entries.filter((e) => {
      const at = e?.at;
      const ms = typeof at === 'number' ? at : Date.parse(at ?? '');
      return Number.isFinite(ms) && ms >= since;
    });
  }

  function applyRunnerReport({ orders, journal = null, version = null, build = null, watching = null, wallet = null } = {}) {
    if (!Array.isArray(orders)) throw new Error('orders must be an array');
    if (Array.isArray(journal)) {
      state.data.runner = {
        ...(state.data.runner ?? {}),
        journal: sinceThisOwner(journal).slice(0, 25),
        version,
        build,
        watching,
        wallet: typeof wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(wallet) ? wallet.toLowerCase() : null,
        reportedAt: new Date().toISOString(),
      };
    }
    let applied = 0;
    for (const r of orders) {
      if (!r?.id || !r?.status || r.status === 'watching') continue;
      const mine = state.data.orders.find((o) => o.id === r.id);
      if (!mine) continue;
      // A runner refining its own verdict is not a collision: it reported
      // `triggered` when the send was accepted and comes back with what the
      // chain said. That second answer replaces the first.
      const refining = mine.closedBy === 'runner' && refinesVerdict(mine.status, r.status);
      if (mine.status !== 'watching' && !refining) {
        // The laptop closed it first, cancelled while the runner was already
        // selling, say. The order stays as the laptop left it, but a sale that
        // happened is a fact, so it is written down where the owner reads.
        if (r.status !== mine.status && r.closedTx) {
          state.note({ kind: 'late-verdict', orderId: r.id, status: r.status, tx: r.closedTx, was: mine.status, by: 'runner' });
          log(`${r.id}: runner reports ${r.status} (${r.closedTx}) but it was already ${mine.status} here`);
        }
        continue;
      }
      const at = new Date().toISOString();
      state.data.orders = state.data.orders.map((o) => (o.id === r.id
        ? { ...o, status: r.status, closedAt: at, closedTx: r.closedTx ?? null, closedBy: 'runner', cancelReason: r.reason ?? null }
        : o));
      state.note({ kind: r.status, orderId: r.id, tx: r.closedTx ?? null, by: 'runner' });
      log(`${r.id}: ${r.status}${r.closedTx ? ` (${r.closedTx})` : ''}`);
      applied += 1;
    }
    if (applied) bump();
    state.save();
    return { applied };
  }

  return { syncOrders, applyRunnerReport };
}
