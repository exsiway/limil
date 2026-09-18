# Security

What the extension can do with your wallet, what stops it from doing more,
and what it cannot protect you from. Read this before placing an order with a
position you would mind losing.

## Contents

1. [The short version](#1-the-short-version)
2. [Trust boundaries](#2-trust-boundaries)
3. [What the session key can do](#3-what-the-session-key-can-do)
4. [What stops a bad trade](#4-what-stops-a-bad-trade)
5. [What is not protected](#5-what-is-not-protected)
6. [Operational advice](#6-operational-advice)
7. [Reporting](#7-reporting)

---

## 1. The short version

- The wallet's private key is never touched. It stays inside Privy's iframe;
  every owner signature is a request to that iframe on the page.
- The session key is generated in the service worker, and only the worker signs
  with it. It is kept in the extension's own local storage, which content
  scripts and web pages cannot read; the page receives signatures, not the key.
- On chain, the session key is bounded by `LimilSessionAccount` in two
  dimensions, both read from the swap call's own arguments rather than from an
  approval: HOW MUCH of each token may be sold (per operation your largest live
  order of it, per session your orders plus one retry) and HOW LITTLE it may
  fetch (a minimum price fixed from the order). Around those: an expiry, an
  operation count, and an explicit list of (contract, function) pairs. It
  cannot move native value, cannot transfer tokens, cannot grant itself
  anything, cannot call the wallet or the EntryPoint.
- What the contract does NOT bound is WHERE the proceeds go. That is the one
  thing worth reading twice, and §5 is about it.
- Every sell runs inside `LimilOutputGuard`, and the contract REQUIRES it,
  at a floor you fixed rather than one the signing key writes. Read it
  narrowly: the guard measures the relay depository, which is shared, so it
  proves the fill was not bad, not that the money reached you. Against a
  leaked key the bound is the per-token budget. See §5.
- Extension storage (session key, signing sample) is closed to the
  content scripts; they ask the service worker for what they need.
- The signing sample is stored WITHOUT its Privy session token: the token is
  cut out before the sample is written and the page puts its own live token
  back in at every use. What that token buys is FOMO's sponsored gas and the
  app's own flow, so a thief of this storage cannot trade the way the
  extension does. It does not make the key harmless: `EntryPoint` is a public
  contract, and whoever holds a live session key can pay their own gas and
  send an operation the account will accept. The bound is the grant itself,
  the per-token budget and the price floor, and §5 says what those bounds do
  not cover.
- The session key rotates with every grant renewal: the renewal is granted
  to a new key, the new key takes over once it is granted on every chain
  with live orders, and the old one is revoked on each chain's next round.
  A stolen key therefore dies with the grant it had instead of being handed
  its rights back at each renewal. The hub learns the new owner key from the
  old one; the runner browser's own key is not rotated by this.
- Local by default. Until you turn on **Autonomous orders** in the popup and
  acknowledge the risk, the extension talks to no server of yours: no pairing,
  no order mirroring, no hub polling, no second key in the grant. The remote
  parties it does talk to are the ones FOMO itself uses, its API and
  bundler, the relay, public RPC nodes.

## 2. Trust boundaries

**You trust FOMO** with the wallet, as you already do by using it. The
extension adds no key material to that relationship: delegation and grants are
signed by the same Privy wallet, through the same iframe, on the same page.

**You trust the public relay** (`api.relay.link`) for impact measurements.
The relay never sees a key.

**You trust this code.** It runs in your browser with the permissions listed
in the manifest. Read it; it is small and every rule that matters has a test.

**You do not trust any server of the project.** There is none.

**You do not trust the page**, and the transport between the two worlds is not
the thing that protects you from it. A page shares its realm with the
MAIN-world script and can reach the intrinsics that realm is built from; the
ways to read what crosses the channel are closed in `src/shared/bus.js` and
pinned by `test/bus.test.mjs`, but the boundary that actually decides what a page may
learn or cause is the ISO allow-list and the one-time intents, not the privacy
of the channel.

**The side panel** is an extension page that shows content other people
wrote (theses, names, avatars), mirrored from the FOMO tab. What crosses
into it is a value, not markup: tag, allow-listed attributes, text
(`src/shared/mirror-tree.js`). Scripts, event handlers, `javascript:` links,
images from hosts other than FOMO's, `url()` in inline styles and anything
that embeds or takes input do not survive serialisation, the panel builds
nodes with `createElement` and `textContent` and filters every attribute
again on apply, and the extension page's own CSP allows no inline script
regardless. FOMO's stylesheet goes in as text the same way
(`src/shared/fomo-css.js`): `@import` and every `url()` to a host other
than FOMO's are dropped, and the fonts are fetched by the extension and
registered through the FontFace API rather than by the sheet. The port between panel and tab is accepted from a page of this
extension only (checked by sender origin), so a content script or a web page
cannot open it. Back across it the panel can do three things, each bounded
to the block: click an element of it, scroll one of its lists, and press a
quick-buy button, which goes through `feedBuy.press` and is refused for any
element that module did not mount itself. The `isTrusted` check on the real
buttons stays; a page script still cannot press them
(`test/feed-mirror-trust.test.mjs`, `test/mirror-tree.test.mjs`). One thing
the panel changes on the page: while it mirrors a tab, the page's
`document.visibilityState` reads "visible" whatever the tab's state
(`src/main/awake.js`), so FOMO keeps loading its lists in the background.
It is a getter on the page's own Document, flipped by the mirror alone and
off again with the last panel; it grants nothing and hides nothing from
the extension (`test/awake.test.mjs`).

**The MAIN-world script** runs inside fomo.family's
own JavaScript context, next to their bundle and anything it loads. The
extension is built so that a script on that page can neither listen to nor
speak on the channel between its two worlds (a private `MessageChannel`, not
`window.postMessage`; see `docs/ARCHITECTURE.md` §2), cannot start a
delegation, grant or disconnect (each needs a one-time intent the service
worker issues for exactly those parameters), cannot press the panel's buttons
(synthetic clicks are ignored), and cannot have a Solana transaction signed
that the guard has not decoded and simulated. What the page can still do is
what it could always do without the extension: talk to the Privy iframe
itself. That boundary is FOMO's, not ours.

## 3. What the session key can do

The grant issued to the session key is planned in `src/shared/grant-plan.js`
and enforced by the contract in `contracts/LimilSessionAccount.sol`.

| Bound | Value | Meaning if the key leaks |
|---|---|---|
| `validUntil` | 30 days from the grant, renewed silently whenever less than three weeks remain and a FOMO tab is open | the key dies by itself |
| `maxOps` | 60 minimum, 10 per order, renewed with the term | bounded number of operations, reverting or not |
| `tokenCaps[].maxPerOp` | the largest live order of that token | one operation can sell at most one order's worth, per token, charged from the swap's own arguments |
| `tokenCaps[].budget` | that token's orders plus one retry | total exposure over the key's life, per token, not cap × ops |
| `tokenCaps[].minOutPerUnit` | the lowest live target on that token, less slippage | the operation must demand at least this much back, so the floor is yours and not the key's |
| `guard` | the output guard, the chain's settlement token and the relay depository | every operation must be a guarded batch that ends with a measured gain; it catches a bad fill, not a redirected payout (§5) |
| `swap` | the relay proxy and its one function | the only place tokens may be handed to, its amounts charged and its leftovers returned to you |
| `maxValuePerCall`, `valueBudget` | 0 | no native value ever leaves |
| `maxFeePerOp`, `feeRecipients` | 0, empty | no token transfer is possible |
| target/selector pairs | `approve` on each order token, the relay swap; the two guard functions are added by the contract | nothing else is callable |

The contract additionally refuses to grant, and refuses to validate, a list of
selectors that move tokens regardless of the pair list: `transferFrom`,
`setApprovalForAll`, every `safeTransferFrom`, `permit`, `increaseAllowance`,
`transferAndCall`, `approveAndCall`, `authorizeOperator`. The list is tested by
signature, not by copied hex, because a one-character typo in a selector
constant would disable a ban unnoticed.

Caps are summed per operation and per token, not per call, so a batch of two
approves of one token under the cap is refused, while two tokens each at their
own cap pass. A rejected operation does not consume budget. A re-grant, with
or without a revoke, replaces the pair list and the budgets rather than adding
to them (epochs), so rights never accumulate.

The approve goes to the relay router, which pulls the token and swaps it. The
contract parses the swap call's own `tokens[]` and `amounts[]`, the amounts
the router will pull, and charges the per-token budget from those, so the
bound on a leaked key does not depend on what was approved. The guard sits
beside it and does less than the name suggests: it proves the shared relay
depository's balance rose by the floor within the operation, and the floor
must be at least the amount sold times the price the owner fixed in the
grant, which catches a pool that pays far less than the quote. The depository
is not this account's, so a rise proves a fill, not delivery.
`docs/CONTRACTS.md` states exactly what it does and does not prove.

Every batch the extension builds ends with `approve(router, 0)` on the traded
token, whether or not it approved anything itself, because relay omits the
approval exactly when an allowance already stands. The budget does not depend
on that: it is charged from the amounts the swap call itself declares it will
pull, not from `approve`, so a batch that approves nothing still spends it.

What the limits do NOT do is revoke an allowance that was already there. If
the FOMO app granted the router a large allowance in its own flow, the grant's
budgets do not reduce it, and the contract cannot read token allowances in
validation (ERC-7562) to find out. That residual belongs to the wallet's
history rather than to the key: it bounds what the ACCOUNT is exposed to, not
what this key may request.

## 4. What stops a bad trade

Layers, from the browser inward:

1. **The trigger** needs three consecutive quotes with a sane spread on the
   scheduled path, where noise and a single spike fire nothing. A level
   crossing seen in the price stream is a different path: it is quoted at once
   and fires on one quote at or past the target, guarded by the stream's own
   two-tick rule and by the layers below rather than by three samples.
2. **Impact** is measured against a public quote before signing; while it
   exceeds the order's tolerance the executor waits and does not sign.
3. **Route check (buys)**: every Uniswap v4 hop is simulated through the
   official quoter so hook fees show. A hop that yields less than promised, or
   does not simulate, blocks the signature. Kyber silent or chain unknown also
   blocks.
3b. **The signing envelope** is captured, not held. The extension has no key
   to your wallet: it signs by replaying a signing request made by FOMO's own
   page, so it must first observe one, which happens only when the page
   genuinely asks for a signature. One ordinary EVM sell, made by the person,
   supplies it. The envelope names a wallet and carries no chain, so one such
   sell serves every EVM chain; a Solana sell or a buy is signed on Solana and
   does not. The envelope is bound to its wallet
   (`envelopeBelongsTo`, `src/shared/envelope.js`): on an account switch the
   foreign one is discarded on the spot, in storage as well as in memory, and
   the refusal names the wallet rather than failing silently.
4. **The operation verifier** (`src/shared/runner-verify.js`) refuses any
   transfer, any approve to an unknown spender, any approve larger than the
   trade, any banned selector, any batch over five calls, and any operation
   without a valid one-time ticket for its order. It also reads the router's
   own arguments, `transferAndMulticall` takes the tokens out of the wallet
   with `transferFrom`, so `tokens`/`amounts` are the trade size whatever
   allowance happens to stand, and requires exactly one sale, of the order's
   input token, of no more than the order's amount. The approve alone was not
   enough: an allowance left standing by an earlier round is not in the batch
   at all, and on chain the per-token cap is the LARGEST live order of that
   token, so with a small and a large order open at once the small order's
   ticket would otherwise cover the large order's size.
4b. **The Solana guard** (`src/shared/solana-guard.js`), for buys and Solana
   sells: the transaction relay or dflow built is decoded instruction by
   instruction (address lookup tables resolved), and any approve, authority
   change, burn, foreign-destination close or account reassignment signed by
   the wallet is refused. It is then simulated on a node and the wallet's
   accounts compared before and after: only the input mint may decrease, by
   at most the order amount; no delegate, owner or close authority may change
   (one exception: a token account the transaction itself creates may carry
   a close authority, the sponsor's way of reclaiming the rent it paid, a
   right that closes only an emptied account and moves no token);
   the wallet may lose at most 0.02 SOL to fees; on dflow the output must
   arrive in the same transaction. A failed or unavailable simulation is a
   refusal. Privy is asked to sign only after both checks pass.
4c. **Where the proceeds go is NOT checked**, and this is the open
   limitation. A sale settles cross-chain, the destination is named in an
   off-chain request FOMO makes, and nothing on chain can see it: the output
   guard is satisfied by a sale that pays a stranger, and so is the contract.
   A leaked session key can therefore sell the granted amount at the granted
   price and take the proceeds; the bound is the per-token budget.
   docs/CONTRACTS.md gives it in full, including what closing it would take.
5. **The grant check** (`src/shared/grant.js`) evaluates the operation against
   the on-chain grant before a signature exists, with the same floor and budget
   arithmetic the contract uses. It is a subset of the contract's checks: the
   spender, native value and the banned selectors are left to the verifier
   and to the contract.
6. **The output guard** (sells): `snapshot` first, `assertGained` last; the
   batch reverts if the measured balance's gain is under the floor. WHOSE
   balance is measured is fixed by the owner at grant time and checked by the
   contract on every batch, relay's shared depository, because a sale settles
   cross-chain and that is where its proceeds land.

   What that does NOT prove is delivery: the depository is shared, and the
   final recipient is named in an off-chain quote the chain cannot see. So a
   leaked session key can sell the granted amount at the granted price and
   direct the proceeds elsewhere. That is the open limitation, bounded by the
   per-token budget, and docs/CONTRACTS.md gives it in full.

   A guard revert in the bundler's simulation is not an attempt; three in a
   row pause the executor for ten minutes.
7. **Runner limits**: attempts per order, pause between attempts, executions
   per day with a hard ceiling, back-off on network refusals.
8. **The lock**: one in-flight execution at a time, a queue of rounds, and the
   rule that a signed operation leaves the watch list unless the bundler
   refused in words. One position is never sold twice.

**Quick buy and sell from the feed** move money on a press and have their
own guards: the switch is off until you turn it on, a buy button carries a
fixed amount you set (capped at $10,000) and the sell button a share of the
holding you set (at most 100%), by default the first press only arms a
button and a second press within three seconds is required (a checkbox in
the popup turns that off for speed, your choice), one trade runs at a time,
a buy is checked against your cash and a sell against your holding before
anything is signed, and a sell of a token you do not hold is refused rather
than sent as zero. They sign through Privy on the page like a tap in the
app; the session key is not involved.

## 5. What is not protected

Be honest about the edges.

Everything in this section is about the machines you run. Whoever has your
laptop's browser profile, or a server you set up, has what you have; keeping
those machines yours is your responsibility, not a risk this project can
carry for you. The contract bounds a key; it does not bound a person at your
keyboard.

- **A live browser session can trade.** The contract bounds a leaked *session
  key*. It does not bound a person or malware with access to the logged-in
  browser profile: they have FOMO's own session and the Privy iframe, exactly
  as you do. Treat a machine that keeps orders alive like a hardware wallet.
- **A server browser is a second logged-in device.** In the server stack a
  Chromium on your server holds your FOMO login and Privy session, like a
  second laptop. The same rule applies: a long noVNC password or an SSH
  tunnel, nothing else on the box, updates on. The hub between the two
  browsers accepts only requests signed by their session keys (with a nonce
  per request and a replay cache), and the signing sample it carries has its
  tokens replaced by placeholders, or is withheld altogether when the
  redaction cannot prove it clean.
- **The daemon's network is yours to close.** Its port binds to loopback by
  default and the extension refuses plain http to a public address; pair over
  an SSH tunnel or give it TLS. Automatic server updates follow signed release
  tags (`deploy/allowed_signers`), not a branch.
- **The delegation itself is a code change.** The EIP-7702 authorization is
  signed by your wallet and sponsored by the bundler. It is signed only to the
  limil contract of that chain, only while **Limit orders** is on in the popup
  (the switch is the consent; the page cannot flip it), and only against a
  one-time intent the worker issued for that plan.
  Until it is applied, and while the wallet's nonce has not moved, anyone
  holding the signed authorization could apply it. It stays in the browser and
  is not written to disk by the extension; do not export it.
- **Buys carry no on-chain guard.** They are Solana transactions built by the
  relay. The Solana guard (decode and simulate, above) bounds what leaves the
  wallet; on the relay route it cannot see where the output is delivered,
  because relay fills in a separate transaction of its own, that recipient
  is FOMO's quote's word. On thin pools the relay's flat fee makes small buys
  noisy.
- **FOMO can change.** The extension depends on FOMO's API shape, header
  scheme, Privy envelope format and chart library. A change can break
  execution; it cannot make the session key do more than the grant allows.
- **Quotes are FOMO's and the relay's.** The extension measures; it does not
  make markets. A quote that lies is a quote that lies.
These two are ACCEPTED RISKS of the current design, not defects awaiting a
patch. Writing them down does not reduce them.

- **A leaked session key can sell, and redirect the proceeds.** The floor is
  yours now, and the amount is charged from the swap's own arguments, so the
  size of a sale is bounded by that token's budget, its live orders plus one
  retry. What is NOT bounded is where the money goes: the guard measures the
  relay depository, a shared contract anyone may pay into, and the payout is
  named in an off-chain quote the chain never sees, so a key holder can
  satisfy the floor with their own deposit under their own request. Measuring
  your wallet instead would prove delivery, but only for a sale settling on
  the origin chain, and FOMO's API refuses such a quote, routing around it
  would take the trade out of your position history. That trade-off was
  weighed and declined. Treat a machine holding the key as a hot wallet
  bounded by the per-token budget.
- One approve cap per token, a guard that is required rather than optional, a
  budget charged by the swap so a standing allowance is not free, and a floor
  the owner fixes rather than the signing key are enforced and pinned by
  `test/session-account-limits.test.mjs`, which also asserts the case above as
  still open.

### The account a runner browser trades for

A browser executes an order only for the FOMO account it is signed in to. The
account is asked of the FOMO tab; when the page does not answer, the sender of
the last order this browser sent and the bundler accepted stands in, and a
rejected send never counts as proof. An order for another account is skipped
with the reason in the journal. For an order that came from a hub (a runner
browser executing what the owner placed elsewhere) an UNKNOWN account is also
a refusal: the runner must prove which account it holds before it sells for
it. An order placed in this browser itself carries the sender its own page
reported when it was placed, and is executed while nothing contradicts it.

## 6. Operational advice

- Before turning on **Autonomous orders**, read the security section of
  [SERVER-SETUP.md](SERVER-SETUP.md): how to reach your server without
  exposing the hub or the server browser to the internet.
- Turn **Limit orders** off before uninstalling. That returns the wallet to
  FOMO's account contract and drops the session key.
- Keep only what you are willing to have traded by the grant's bounds on the
  wallet the extension runs with.
- On a box that runs unattended: encrypt the disk, open no ports, dedicate an
  OS user, keep nothing else in the profile.
- Nothing on a server of yours holds funds or keys: the hub keeps the orders,
  the signing sample with its tokens removed, and the ADDRESS of the runner
  browser's session key. It holds no private key, signs nothing and sends no
  transaction; the key that signs lives in the browser. What does sit there, if
  you run a browser on it, is your FOMO session, and that commands the whole
  wallet. Treat that machine accordingly.
- Read the executor journal when something looks wrong. Every round writes
  its reason in words.

## 7. Reporting

Open an issue on GitHub. For anything that could move funds, please open a
private security advisory on the repository instead of a public issue, and
include the chain, the transaction or operation hash, and what you expected.
