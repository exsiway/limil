# Architecture

How the extension is put together and how a trade travels from a chart tick to
a bundler. Read [FEATURES.md](FEATURES.md) for what each part does for the
user; this page is about where the code lives and why it is split that way.

## Contents

1. [Three worlds](#1-three-worlds)
2. [The message bus](#2-the-message-bus)
3. [Storage](#3-storage)
4. [Talking to FOMO](#4-talking-to-fomo)
5. [The path of a sell](#5-the-path-of-a-sell)
6. [The path of a buy](#6-the-path-of-a-buy)
7. [The daemon](#7-the-daemon)
9. [Build and tests](#9-build-and-tests)

---

## 1. Three worlds

A Manifest V3 extension has three places to run code, and this project uses
all three deliberately.

```
 fomo.family tab                                 service worker
 ┌──────────────────────────────────────────┐    ┌──────────────────────────┐
 │  MAIN world        src/main/             │    │  src/background/         │
 │  · Privy bridge (signing)                │    │  · runner (executor)     │
 │  · FOMO API tap (session headers, uuid)  │    │  · impact / route checks │
 │  · chart bridge (TradingView datafeed)   │◄──►│  · daemon link           │
 │  · swap / Solana execution               │ bus│  · RPC reads             │
 │  · delegation and grant on chain         │    │  · storage owner         │
 ├──────────────────────────────────────────┤    └──────────┬───────────────┘
 │  ISOLATED world    src/isolated/         │               │
 │  · order panel (DOM, styles)             │      chrome.runtime.sendMessage
 │  · quick-buy buttons                     │               │
 │  · gatekeeper between MAIN and worker    │    ┌──────────┴───────────────┐
 └──────────────────────────────────────────┘    │  popup   src/popup/      │
                                                 └──────────────────────────┘
```

**MAIN world** (`src/main/`) runs inside the page's own JavaScript context.
Only there can the extension see the Privy iframe's `postMessage` traffic,
wrap `fetch` to read FOMO's session headers, and reach the TradingView widget
object. It has no access to `chrome.*` APIs and is subject to the page's
content-security policy, so it cannot call RPC nodes directly.

**ISOLATED world** (`src/isolated/`) is the ordinary content script. It shares
the DOM with the page but not its JavaScript, so it owns everything visual: the
order panel and the quick-buy buttons. It also
stands between the MAIN world and the service worker and lets through only an
explicit allow list of commands.

**Service worker** (`src/background/`) is the only place with `chrome.storage`,
`chrome.alarms` and unrestricted `fetch`. It keeps the orders, the session key,
and the settings, runs the executor on a one-minute alarm, measures impact
and routes, and talks to the daemon.

The order list is one array in that storage and four subsystems change it,
the panel, the executor, the daemon and the mirror. Every change goes through
the single queue in `src/background/orders-store.js`, because a change is a
read, a change and a write with awaits in between, and two that overlap leave
the later write on top of a stale array: a cancelled order comes back and is
sold, or a verdict is lost and a filled order is sold twice. Reads are not
queued, a list one write stale is harmless, and no network call may be
awaited while the queue is held.

A grant lives on ONE chain: the chain id is inside the EIP-7702 authorization
the owner signs, and the grant sits in the account's storage on that chain. So
a wallet trading on several chains needs a delegation and a grant on each.
`orderChains()` lists the chains that have live EVM orders and the panel walks
them, asking `grantPlan({ chainId })` for each; the readiness lamp checks all
of them too, because a chain that is perfect must not hide one that is dead.
Solana orders take no part: they are signed by Privy on Solana, with no
delegation, no session key and no grant.

**Popup** (`src/popup/`) is a settings surface. It reads state from the worker
and from the active tab and never executes anything itself.

`src/shared/` holds pure logic used by two or more worlds and by the daemon:
order arithmetic, UserOperation encoding, the trigger rule, grant planning, the
operation verifier, the guard maths, the i18n table. Every file
there has tests and no browser dependency.

**Side panel** (`src/panel/`) is the second extension page: FOMO's feed
block, mirrored from a FOMO tab over a port to `src/isolated/feed-mirror.js`
(a snapshot, then `MutationObserver` deltas, serialised and filtered by
`src/shared/mirror-tree.js`). It talks to the tab only; the worker is not
involved.

## 2. The message bus

`src/shared/bus.js` is a tiny request/response layer over a private
`MessageChannel` between MAIN and ISOLATED, and over
`chrome.runtime.sendMessage` between ISOLATED and the worker. Every request
carries a type, an id and a payload; every reply carries the same id and
either a result or an error string.

Why a MessageChannel and not `window.postMessage`: the page shares the window
with both worlds, so a bus over the window is readable and writable by any
script on fomo.family. The ISOLATED world creates the channel at
`document_start` and hands one port to the MAIN world in a single window
message; the MAIN world takes it in a capture-phase listener registered before
the page's first line runs and stops the event, so no page listener ever sees
the port. From then on nothing the two worlds say to each other is visible to
the page, and the page has no port to speak on. There is no handshake token,
because none can be shared over a channel the page can read and none is needed
over one it cannot. `test/bus.test.mjs` plays the hostile page.

**A private channel is not a private realm.** The MAIN world runs inside the
page's own JavaScript realm, and the page can replace the machinery that realm
is built from as soon as it gets a line of its own, after the handover, not
before it. There are three ways in, and all three are closed the same way, by taking what the transport needs at module evaluation instead
of looking it up when it is used:

- the `MessageEvent` accessors (`data`, `ports`, `source`, `origin`), because
  a replaced getter runs with `this` bound to an event whose target is the
  private port;
- `Promise.prototype.then` and the `Map` methods, because `ready.then(send =>
  …)` and `pending.get(id)` are lookups: a replaced `then` is handed the
  private `send` closure, and a replaced `get` is asked for the slot of an id
  the page just forged. `Promise.prototype.catch` is not used at all, by
  specification it calls `then` back through a lookup;
- the **thenable check**: fulfilling a promise with an object makes the engine
  itself read `then` off that object, walking its prototype chain, so a getter
  on `Object.prototype.then` receives every ordinary answer. No method of ours
  is involved, so capturing does not help; instead every value the bus fulfils
  a promise with is given an own, non-enumerable `then` of `undefined`, which
  the check finds first and which is invisible to `Object.keys`,
  `JSON.stringify` and spreading (`shield` in `src/shared/bus.js`).

The residue is stated where it belongs: a value an `async` handler returns is
assimilated by that function's own promise before the bus sees it. The
boundary that decides what a page may learn or cause is therefore the
allow-list below and the intents after it, never the privacy of the channel.

The two scripts injected into the page are bundled as self-calling functions
rather than as modules. A content script is loaded classically, so every
top-level name in it would otherwise become a property of the page's `window`,
and the page would be able to read the levels being watched or move the one
the watcher nudges on. The worker, the popup and the panel are real modules
and have their own scope already.

The ISOLATED script is still the gatekeeper. `MAIN_MAY_ASK` in
`src/isolated/content.js` lists the only commands the MAIN world may send
onward: five RPC reads, three Solana reads for the transaction guard, the
three sample commands, `runner.info`, `runner.sign`, `runner.nudge`,
`runner.watchdog`, `runner.note`, `runner.sending` and `intent.consume`, eighteen in all. Anything else is refused with the
command name in the error, because a silent refusal on that boundary costs
hours.

Commands that change rights, `gate.signAuthorization` (live),
`session.grant`, `session.disconnect`: additionally require a one-time
**intent** (`src/background/intent.js`): the worker plans the operation, issues
an intent bound to the canonical form of its parameters, and the MAIN world
must have the worker spend that intent for the very same parameters before
Privy is asked to sign. A live delegation is planned only to the limil
contract of that chain and only while **Limit orders** is on in the popup,
that switch, on the extension's own surface where no page script can flip
it, is the consent to the delegation; returning the wallet to FOMO's contract
is what turning it off does, through `session.disconnect`, which the popup
starts.

`runner.sign` is guarded by a ticket: the worker issues a one-time ticket for
one order before it asks the page to build an operation, and signs only an
operation presented with that ticket. The page cannot obtain a signature on
its own initiative.

Long commands (a swap through the bundler, a Solana send) have their own
timeouts in `PAGE_TIMEOUTS`; the bus default is 120 seconds, and after a
signature has been issued the order is treated as sent unless the bundler
refused in words.

## 3. Storage

Everything lives in `chrome.storage.local` of the browser profile.

| Key | Contents |
|---|---|
| `settings` | popup settings: switches, interface language, daemon and runner pairing (`daemon`, `mirror`) |
| `orders` | the order list with status, target, direction, slippage |
| `runner` | executor state: session key address, journal, attempts, samples, watcher heartbeat |
| `runner.secret` | the session key's private key; only the worker signs with it, and content scripts and web pages cannot read this storage |
| `runner.secret.next`, `runner.secret.prev` | the incoming and outgoing keys of a rotation, until every chain has granted the new one |
| `runner.ticket` | the one-time signing ticket of the round in progress |
| `privy.sample` | the captured Privy envelope for the current wallet |
| `selfupdate.pending` | the stamps of a self-reload in progress |

Nothing is synced to a Google account (`storage.sync` is not used) and nothing
is sent anywhere except as described in [PRIVACY.md](PRIVACY.md).

## 4. Talking to FOMO

FOMO's front end talks to its API with session headers bound to the login and
signs with an embedded Privy wallet inside an iframe. The extension does not
hold the wallet's key and does not log in on its own; it reuses what the page
already has.

**Session headers.** `src/main/fomo-bridge.js` wraps `fetch` and remembers the
headers FOMO sends to its own API, plus the user id from the request path. The
extension reuses them for quotes, balances and the bundler. Only headers the
bundler's CORS preflight allows are forwarded (`src/shared/bundler-headers.js`).

**Signing.** `src/main/privy-bridge.js` listens to the Privy iframe and keeps
one real signing request as a sample. To sign, it clones the sample, replaces
the method, params and every id, posts it to the iframe and waits for the reply
with the matching id. The same envelope works for EVM typed data and, with
`chainType: solana`, for Solana messages. `canSign` reports one of three
reasons when it cannot: no Privy on the page, no sample yet, sample from
another wallet.

**Chart.** `src/main/chart-bridge.js` intercepts the TradingView widget at
construction, taps its datafeed for ticks of the token on screen, streams the
other order tokens over FOMO's candle socket (`src/main/price-stream.js`,
message shapes in `src/shared/price-stream.js`), draws order levels with
`createShape` (FOMO ships the Charting Library, not the Trading Platform, so
`createOrderLine` throws) and hooks `onSymbolChanged` because the widget is
reused across tokens.

**Quotes and balances.** Through FOMO's own `/swaps/v2` and
`/v2/users/{uuid}/balances` endpoints with the captured headers. The balances
parser (`src/shared/balances.js`) is defensive: it reads minimal units by exact
path, infers decimals from the balance pair when FOMO gives none, and never
confuses the wallet address with a token address.


**The wallet after a reload.** Privy keeps the embedded wallet loaded per
page session; a tab reload starts a new one, and FOMO connects the wallet
only when it is about to sign itself. An rpc that comes first is answered
"'0x…' not loaded on this device". The bridge then sends what the SDK sends
before its first rpc, `privy:wallets:connect` with the wallet's entropy id,
its verifier and the fresh session token, all three taken from the captured
envelope (`shared/envelope.js` buildConnectRequest), and asks once more.

**One sample for every tab.** A capture in any FOMO tab goes to extension
storage without its token and with the moment it was saved; the worker
tells every FOMO tab (`sample.changed`), and a tab whose own sample is
older adopts it and puts its own live token in. A signature in one tab
serves all of them, open or opened later, with no reload.

## 5. The path of a sell

```
chart tick ─► level crossing (2 ticks) ─► runner.nudge ─┐
one-minute alarm ────────────────────────────────────────┤
                                                         ▼
                                              tick() queue, inFlight lock
                                                         │
                                   quote via FOMO ◄──────┤
                                   shouldTrigger: 3 samples, spread, margin
                                                         │ fire
                                   waitForImpact: relay public quote ≤ tolerance
                                                         │
                                   route check (buys) / guard floor (sells)
                                                         │
                          MAIN: swap.prepare ─► buildSwapCalls(quote, guard)
                                   [snapshot, approve, swap, assertGained]
                                                         │
                          worker: verifyOperation, checkAgainstGrant, ticket
                          worker: sign with session key (EIP-712 UserOp hash)
                                                         │
                          MAIN: swap.execute ─► FOMO bundler (session headers)
                                                         │
                          worker: re-read balance ─► close by position
```

Each step lives in one module: the trigger in `src/shared/trigger.js`, impact
in `src/background/impact.js`, the batch in `src/shared/swaps.js`, the guard
floor in `src/shared/output-guard.js`, the verifier in
`src/shared/runner-verify.js`, the grant check in `src/shared/grant.js`, the
UserOperation encoding and hash in `src/shared/userop.js`, sending in
`src/main/bundler.js`.

The first sell of a session also carries the EIP-7702 authorization and the
grant call, sponsored by the bundler, so the wallet never needs gas
(`src/main/authorization.js`, `src/main/grant-session.js`).

## 6. The path of a buy

A buy spends cash (USDC on Solana) and is a Solana transaction, so it cannot
use the session key. The executor quotes FOMO, checks the route
(`src/background/route-check.js`: KyberSwap route summary and the Uniswap V4
quoter for every v4 hop, keyed by pool and amount because a split route can
visit one pool twice), then asks the page to sign.

`src/shared/solana-tx.js` parses and serialises versioned transactions without
a Solana library: compact-u16, account keys, signer slots. The relay's fee
payer signature is already in slot 0; the user's signature from Privy's
`signMessage` goes into the user's slot. `src/main/solana-exec.js` sends
through Jito, registers the hash with the relay and polls the swap status.
A Solana-to-Solana buy goes through dflow the same way.

## 7. The daemon

`daemon/` is a Node process with two roles.

**Hub** (the `deploy/runner` stack): a browser with the extension on the same
box pairs as the *runner* with its own one-time token
(`/v1/runner/pair`) and its own session key. The laptop mirrors its orders,
wallets and a token-redacted signing sample to the hub (`PUT /v1/orders`; the
sample is withheld when the redaction cannot prove it clean); the
runner browser long-polls `GET /v1/runner/orders?since=&wait=` and reports
verdicts and its journal on `POST /v1/runner/status`. The hub reports the
runner's key as `sessionKey`, so the laptop's grant plan grants it, and it
executes nothing itself. Extension side: `src/background/daemon.js` (laptop),
`src/background/mirror.js` (runner browser), merge rule in
`src/shared/daemon-api.js`.

**The hub does not execute.** It keeps the order list, the redacted signing
sample and the address of the key the wallet grants (the runner browser's;
the hub holds no key of its own); a browser does the trading, so
everything goes through FOMO's own bundler and their app records the PnL. The
hub never executes on its own: a trade sent from a server through relay's
public API would skip their pipeline and the PnL line with it.

The protocol is in `src/shared/daemon-api.js`: one-time pairing tokens, then
requests signed by the caller's session key. Updates: `scripts/update.sh`
follows the newest release tag whose signature verifies (the default,
`LIMIL_UPDATE_MODE=signed`) and fast-forwards `origin/main` without
verification only with `LIMIL_UPDATE_MODE=main`; it builds in a node
container and restarts the hub. The
extension reloads itself on a new build (`src/background/selfupdate.js`).
See [SERVER-SETUP.md](SERVER-SETUP.md) and [SELF-HOSTING.md](SELF-HOSTING.md).

## 9. Build and tests

`build.mjs` bundles four entry points with esbuild into `extension/dist/`:
`main-world.js` and `content.js` for fomo.family, `background.js` and
`popup.js`. A build stamp is defined into every bundle so a tab can report
which build it runs. `npm run pack:store` zips the same build for the Chrome
Web Store with two manifest entries removed, the fixed `key` and the docker
hub address (`scripts/pack-store.mjs`, `docs/STORE-LISTING.md`).

`scripts/build-contract.mjs` compiles the two contracts, kept exactly as
deployed so their addresses stay reproducible, with solc 0.8.28 into
`artifacts/` (ignored by git). The tests need the ABI and bytecode:
`test/session-account.test.mjs` and `test/output-guard-evm.test.mjs` put the
deployed bytecode at an owner address on an in-memory EVM and execute every
rule, including everything that must be refused.

`npm test` runs `node --test` over `test/`. Tests are English, pure and
network-free; the suite takes about half a minute because of the EVM cases.
