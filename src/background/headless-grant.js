// The grant round a runner browser runs for a HEADLESS owner.
//
// The owner of the hub is normally a person's laptop: it plans the grant from
// its live orders and signs it through Privy on its own FOMO tab, and a runner
// browser issues no grants of its own (runner.js grantPlan), because two
// browsers granting under one nonce key collide at the EntryPoint (AA25).
//
// A headless owner is a program, a bot that puts orders on the hub. It holds
// no Privy session and cannot sign anything, so its EVM sells would sit
// watching forever: the session key that must sign them is this browser's, and
// nobody grants it. The hub says `ownerHeadless` on every poll (mirror.js),
// grantPlan then plans for this browser's own key, and this module carries the
// plan to the page exactly the way the order panel does on a laptop
// (isolated/limit-ui.js ensureGrantOn): sign the 7702 authorization if the
// wallet is not delegated yet, then one sponsored `session.grant` operation per
// key. Nothing here signs: Privy does, in the tab, and the intents the worker
// issued bind each signature to the plan.
//
// One round in flight at a time, a pause after a failure so a wallet that
// cannot sign (no Privy envelope yet: the one manual sell has not been done)
// is not asked every twenty seconds, and every outcome in the runner's journal
// where the owner reads it off the hub.

import { grantPlan as planGrant, orderChains as chainsWithOrders, askPage as ask, fomoTab as findTab, note as journal } from './runner.js';

/** After a failed round, how long before the same chain is tried again. */
export const HEADLESS_RETRY_MS = 10 * 60_000;
/** How often a headless owner's grants are re-checked with no new orders (renewals). */
export const HEADLESS_RECHECK_MS = 30 * 60_000;

let inFlight = false;
/** chainId -> { at, ok } of the last round on that chain. */
const lastRound = new Map();

/** Test seam: everything that touches the worker, the page or the chain. */
const DEFAULT_DEPS = { grantPlan: planGrant, orderChains: chainsWithOrders, askPage: ask, fomoTab: findTab, note: journal };

/**
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.force] ignore the retry pause
 * @param {object} [opts.deps] overrides for tests
 * @returns {Promise<{acted: boolean, reason?: string, results?: object[]}>}
 */
export async function grantForHeadlessOwner({ now = Date.now(), force = false, deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  if (inFlight) return { acted: false, reason: 'a grant round is already in flight' };
  inFlight = true;
  try {
    const chains = await d.orderChains();
    if (!chains.length) return { acted: false, reason: 'no EVM orders, nothing to grant' };
    const results = [];
    for (const chainId of chains) {
      const prev = lastRound.get(chainId);
      if (!force && prev && !prev.ok && now - prev.at < HEADLESS_RETRY_MS) {
        results.push({ chainId, acted: false, reason: 'failed recently, retried later' });
        continue;
      }
      let plan;
      try {
        plan = await d.grantPlan({ chainId, now });
      } catch (err) {
        await d.note({ text: `headless grant on chain ${chainId}: the plan failed: ${String(err?.message || err)}` });
        lastRound.set(chainId, { at: now, ok: false });
        results.push({ chainId, acted: false, reason: String(err?.message || err) });
        continue;
      }
      if (plan?.blocked) {
        await d.note({ text: `headless grant on chain ${chainId} blocked: ${plan.reason}` });
        results.push({ chainId, acted: false, reason: plan.reason });
        continue;
      }
      if (!plan?.needed) {
        results.push({ chainId, acted: false, reason: plan?.reason ?? 'not needed' });
        continue;
      }
      const tab = await d.fomoTab();
      if (!tab) {
        await d.note({ text: `headless grant on chain ${chainId}: no FOMO tab to sign in` });
        lastRound.set(chainId, { at: now, ok: false });
        results.push({ chainId, acted: false, reason: 'no FOMO tab' });
        continue;
      }
      try {
        // The delegation is signed on the page, because only the owner can sign
        // it through Privy, and it travels INSIDE the same operation as the
        // grant: the EntryPoint applies it before validation.
        let authorization = null;
        if (plan.delegation) {
          const signed = await d.askPage(tab.id, 'page.gate.signAuthorization', {
            sender: plan.params.sender,
            chainId: plan.params.chainId,
            delegate: plan.delegation.delegate,
            allowLive: true,
            intent: plan.intents?.delegation ?? null,
          });
          authorization = signed?.authorizationRpc ?? null;
          if (!authorization) throw new Error('the delegation was not signed');
        }
        const rounds = [];
        if (plan.mainNeeded !== false || plan.delegation) {
          rounds.push({ params: plan.params, authorization, intent: plan.intents?.grant ?? null, label: 'runner key' });
        }
        for (const extra of plan.extra ?? []) {
          rounds.push({ params: extra, authorization: null, intent: extra.intent ?? null, label: 'second key' });
        }
        for (const r of rounds) {
          const report = await d.askPage(tab.id, 'page.session.grant', { ...r.params, send: true, authorization: r.authorization, intent: r.intent });
          if (!report?.sent) throw new Error(`${r.label}: ${report?.note ?? 'the grant was not sent'}`);
        }
        lastRound.set(chainId, { at: now, ok: true });
        await d.note({
          text: `headless grant on chain ${chainId}: granted ${plan.params.key} for ${(plan.params.targets ?? []).length} token(s)`
            + (plan.delegation ? ', and the wallet was delegated' : ''),
        });
        results.push({ chainId, acted: true });
      } catch (err) {
        lastRound.set(chainId, { at: now, ok: false });
        await d.note({ text: `headless grant on chain ${chainId} failed: ${String(err?.message || err)}` });
        results.push({ chainId, acted: false, reason: String(err?.message || err) });
      }
    }
    return { acted: results.some((r) => r.acted), results };
  } finally {
    inFlight = false;
  }
}

/** For tests: forget the retry pauses. */
export function resetHeadlessRounds() { lastRound.clear(); }
