# Features

Everything the extension does, grouped by where you meet it. Each entry names
the behaviour, the rule behind it and, where useful, the module that implements
it so you can read the code.

## Contents

1. [The popup](#1-the-popup)
2. [The order panel](#2-the-order-panel)
3. [How an order is watched](#3-how-an-order-is-watched)
4. [How an order is executed](#4-how-an-order-is-executed)
5. [Safety limits](#5-safety-limits)
6. [Wallet delegation and the session key](#6-wallet-delegation-and-the-session-key)
7. [Quick buy and sell from the feed](#7-quick-buy-and-sell-from-the-feed)
8. [Self-hosted execution](#8-self-hosted-execution)
9. [Interface language and theme](#9-interface-language-and-theme)

---

## 1. The popup

Opened from the toolbar icon.

| The switches and the server | The status and the journal |
|---|---|
| [<img src="screenshots/popup-switches.png" width="330" alt="Limit orders, autonomous orders, your own server, quick trade settings" />](screenshots/popup-switches.png) | [<img src="screenshots/popup-status.png" width="330" alt="Your own Solana node, the side panel, the status card with both lamps" />](screenshots/popup-status.png) |

**Limit orders switch.** Master switch for everything order-related. Turning it
off cancels every open order, returns the wallet from the `LimilSessionAccount`
delegate to FOMO's own account contract (one sponsored operation) and drops
every session key. Turn it off before removing the extension: otherwise the
delegation stays on chain with nothing to use it.

The switch is also the consent to the wallet delegation. Auto-execution needs
the wallet delegated to the limil account contract (EIP-7702, a change of the
account's code): on, the first order connects the wallet with one signature and
no gas; off, the wallet returns to FOMO's contract. That decision lives here,
in the extension's own window, because a script on fomo.family can press any
button the panel draws but cannot reach the popup. The “?” next to the switch
says so.

**Autonomous orders (own server).** The master switch for everything that
talks to a server of yours. Off, the default, the extension is fully local:
orders live and execute in this browser only, nothing is mirrored anywhere, no
pairing string is accepted, no hub is polled, and the grant carries no second
key. Turning it on shows the risk in plain words and waits for an explicit
acknowledgement before the two server cards appear; turning it off unpairs the
hub and the runner role and returns the host permissions they were granted.
See [section 8](#8-self-hosted-execution).

**Your own server.** Pairs the extension with a hub you run yourself, so
orders fire while this browser is closed. Visible in autonomous mode only.

**Runner browser.** The mirror image of the card above, for the browser that
executes someone else's orders: the runner string the server printed goes in
here. Visible in autonomous mode only, and hidden while this browser owns a
hub of its own, because a browser is one or the other and never both. The
pairing is the switch; unpairing is how it stops.
See [section 8](#8-self-hosted-execution).

**Quick buy and sell.** The feed buttons on or off, the two buy amounts, the
share of the holding the sell button takes, and whether a trade needs a second
press. Your own Solana node goes here too, with its key.
See [section 7](#7-quick-buy-and-sell-from-the-feed).

**Feed in the side panel.** Opens FOMO's Alerts / Tokens / Leaderboard / Feed
block in Chrome's side panel, so it stays in view on any site.
See [section 7](#7-quick-buy-and-sell-from-the-feed).

**Status card.** Two lamps:

- *Orders through the open browser.* Green when the active tab is on
  fomo.family, a FOMO session exists and the wallet's signing sample has been
  captured. The text names what is missing otherwise: no FOMO tab, no login, no
  sample yet, a sample from another wallet.
- *Autonomous orders.* Green when a server is paired and the browser on it can execute.

Folded into the same card is the **journal**: the lines the executor wrote,
newest last, with a Copy button. Every watch round, quick trade and refusal
leaves one, and it is what a bug report should carry.

**Reload banner.** Appears when the FOMO tab runs an older bundle than the
extension. The bundle carries a build stamp; the manifest version alone does
not prove a tab has fresh code.

**Self-reload.** Every build writes its stamp to `dist/build.json`. The
running extension compares it with its own every two minutes and, when a
newer build is on disk and no trade is in flight, reloads itself and then the
FOMO tabs still running the old bundle.

A reloaded tab is asked afterwards which build it runs, and reloaded once more
if it cannot say. A tab reloaded in the moment the extension is still coming
back up gets no content scripts at all: `fetch` is never patched, the app's
first request fails and the page sits there empty, looking like the update
broke the site. Two reloads is the limit; past that the journal says so and
asks for a manual one, because reloading forever would be worse. `npm run build` on a laptop and the
update script on a server both take effect without a click.

## 2. The order panel

[<img src="screenshots/order-panel-and-levels.png" alt="The order panel under FOMO's own buy box, with the order drawn on the chart" />](screenshots/order-panel-and-levels.png)

The panel sits under FOMO's own buy box, and every live order is a level on
the chart: take profit in green, stop loss in red, labelled with the share of
the position it sells and the exact level. A buy order is placed from the same
panel, the Buy side of it: [the buy panel](screenshots/order-panel-buy.png).

Mounted under the Buy/Sell trade card on every `/tokens/…` page, the same
width as the card. It hides while the card is not on the page and unmounts
when an in-app navigation leaves the token page.

**Side.** Sell or Buy.

**Amount.** A share of the balance in percent. It is counted from the balance
at execution time, not at placement, because the position can change
overnight. For buys the amount is a share of your cash (USDC on Solana).

**Target.** A percent against the current market. Positive is take-profit:
wait until the same amount fetches more. Negative is stop-loss: sell if the
price has fallen this much. The direction of the comparison is decided at
placement and stored in the order, so a stop-loss does not fire the moment it
is placed. The panel shows the target as a market-cap level in the same units
the chart uses.

**Slippage.** How much worse than the order price you accept. One number
covers two situations: someone else's trade moving the price right before
execution, and your own size moving a thin pool. Default 10 percent. The relay's
own execution tolerance is separate and cannot be changed from here.

**Balance line.** The position with a refresh button. Amounts are formatted the
way FOMO formats them; dust below the visible threshold is shown as `< 0.001`
rather than in exponent notation.

**Active orders.** Every open order across all tokens, one line each: side in
colour, ticker as a link to the token page, size, level, a cancel button. Orders
are described by level (`Sell 2K $BEAR at $2.76M MC`) because a level does not
depend on when you look at it; without a cap they fall back to the percent.

**Placement checks.** Before an order is saved the panel asks FOMO for a quote.
An order whose route the extension cannot execute is refused rather than saved
as an empty promise. A duplicate (same token, size and target) is refused so
the same position is not sold twice; change size or target for a ladder.

**Automatic cleanup.** When a sell order's token balance is exactly zero the
order is retired with the reason "token sold". Unknown is never read as zero:
a token missing from the balances answer, a failed lookup or a page without
balances leaves the order alone.

**Chart lines.** Each order draws a level on the TradingView chart, labelled
Take Profit or Stop Loss. Lines are recreated on symbol change and orphaned
lines are removed by label.

---

## 3. How an order is watched

Module: `src/main/chart-bridge.js`, `src/background/runner.js`.

**The price feed.** The extension intercepts the chart's datafeed on the page
and receives price ticks for free for the token on screen. For every other
token with an order it opens one socket of its own to FOMO's candle host, the
same one the chart uses, with one subscription per token; candle prices are
turned into market cap with the token's total supply, so all levels live in
the chart's units. Two consecutive ticks across a level wake the executor for
that one order with one quote. This is what makes every order react in
seconds rather than minutes, from one open tab, without polling anyone.

**Control quotes.** While the watcher sees every order, scheduled quoting is
quiet except for one control quote every two minutes per order. An order
whose stream has gone quiet for two minutes is quoted once a minute until it
speaks again.

**Calibration.** The drawn level is derived from a market cap that FOMO
reports with a lag, so it can be off. Each quote taken together with the live
price yields the true level (`price × target ÷ quote`) and the line is moved
there. Calibration survives resynchronisation.

**Keeping a tab.** If orders exist and no FOMO tab is open, the executor opens a
pinned background tab on the token page. If the tab stops answering it is
reloaded; a stale session is detected from the JWT in FOMO's own headers and
handled by substituting a fresh Privy token of the same account or reloading,
never more than once per cooldown.

**Two independent triggers.** The one-minute alarm and the watcher's nudge
arrive independently. An in-flight lock and a queue of ticks make sure one
position is never sold twice by the two of them.

---

## 4. How an order is executed

Modules: `src/shared/trigger.js`, `src/background/impact.js`,
`src/background/route-check.js`, `src/shared/swaps.js`, `src/main/swap-exec.js`,
`src/main/solana-exec.js`.

**Confirmation.** Two paths. On a level crossing seen in the price stream the
order is quoted at once and a single quote at or past the target fires; if
that quote falls short (on a small order the relay fee swings quotes a few
percent), the order is quoted again every six seconds, five quotes in half a
minute, and the first one past the target fires. On the scheduled path, a
fresh quote is one sample and the target has to hold across three consecutive
samples inside a four-minute window. The spread between the samples is
checked too: above 9 percent it is noise, and a move that clears the target
by less than half the spread (capped at 1.5 percent) is not a move. A single
spike on the scheduled path does not fire.

**Price impact.** Before signing, a public relay quote measures the impact of
your size. The executor waits up to a minute, asking every two seconds, until the impact
is within the order's tolerance. If it never is, the attempt does not count and
the next round asks again.

**Sells (EVM → cash).** The operation is a batch: guard snapshot, approve to the
router, the swap, guard check. The output guard reverts the whole batch if the
relay depository gained less than `target × (1 − slippage)`. The signed
UserOperation goes to FOMO's bundler with FOMO's own session headers. An
operation that reverts in the bundler's simulation is not an attempt: the order
stays alive and, after three guard reverts in a row, the executor pauses for
ten minutes.

**Buys (cash → EVM).** A buy is a Solana transaction built by the relay, with
the relay's fee payer already signed in slot 0. The extension checks the route
first: the same KyberSwap aggregator the solver uses, and every Uniswap v4 hop
through the official quoter so hook fees show up in simulation. A hop that
yields less than promised by more than the slippage, or that fails to simulate,
means no signature and a live order. The user then co-signs with Privy's
`signMessage` for Solana, the transaction is sent through Jito and registered
with the relay, and the swap status is polled.

**Buys (Solana → Solana).** Routed through dflow the same way, with Jupiter as
the impact sensor.

**Closing.** An order is closed by the position, not by the receipt: the
contract counts validations, not sales, so the token balance is re-read after
sending. Once a signature has been issued the order leaves the watch list
unless the bundler refused in words; otherwise a slow receipt could look like
"not sent" and sell twice.

That leaves two answers about one order, and both travel. `triggered` says the
bundler took the send; a minute later the chain answers, `filled` when the
balance proved the sale and `failed` when it did not, and either replaces the
first. A runner browser reports the second as well as the first, the
hub replaces the verdict it holds, and the laptop takes the replacement, so an
order that really sold does not sit in every list but one reading "sent,
unconfirmed". Only that one step is allowed: nothing reopens a closed order,
and a verdict the owner set stands, with a late sale written into the hub's
notes instead.

**Nothing to sell.** A sell whose wallet holds none of that token is closed
rather than sent. The position can go while the order watches it, sold by hand
in the app or by another order, and a sale of nothing is a refusal with a fee
attached.

**One position, one sale.** A take profit and a stop loss over one holding are
two watching orders for the same position; when either fills, the other must
stop. After a confirmed sell the wallet's balance of that token is read again
and every other watching sell of it is measured against what is left: an order
whose amount no longer fits is cancelled, with the reason on it. A ladder
survives, because an order the remainder still covers is left watching. This
is not cosmetic. An armed sell outlives the position it was written for, and
would sell whatever of that token the wallet holds next.

**Logging.** Every round writes a line to the executor journal with the reason
in words: which order, why it waited, what it measured, what was sent.

---

## 5. Safety limits

Module: `src/shared/runner.js`.

| Limit | Value | Why |
|---|---|---|
| Confirmations | 1 quote on a crossing, 3 consecutive quotes on the schedule | a crossing is confirmed by the quote itself |
| Quote burst after a crossing | 5 quotes, 6 s apart | a fee-swung quote gets more chances within half a minute |
| Sample window | 4 minutes | fits three one-minute samples plus alarm slack |
| Pause after a failed attempt | 2 minutes | a failure must not hammer the API |
| Attempts per order | 3, then parked | the operator has to look |
| Executions per rolling day | 5 by default, grows with live orders, hard ceiling 50 | a bug that fires everything is bounded |
| Network refusals | exponential back-off | their API refusing is not a reason to retry faster |
| Guard reverts | 3 in a row pause 10 minutes | a poisoned pool is not retried blindly |

The limits are checked before every round and cannot be switched off. The
only condition for the executor to work at all is the presence of a session
key; there is no separate "arm" state that could be forgotten.

---

## 6. Wallet delegation and the session key

Modules: `src/main/authorization.js`, `src/main/grant-session.js`,
`src/main/disconnect.js`, `src/shared/grant-plan.js`, `src/shared/grant.js`,
`src/shared/runner-verify.js`. Contracts: [CONTRACTS.md](CONTRACTS.md).

**The sample.** FOMO's embedded wallet (Privy) signs through an iframe. The
extension listens for one real signing request from FOMO's own front end and
keeps its envelope. Every later signature is a replay of that envelope with a
new payload. Only a sell produces the right envelope; buys are signed on
Solana. The envelope is checked to belong to the current wallet.

**Delegation.** On the first order the wallet signs an EIP-7702 authorization
that points its code at `LimilSessionAccount`. The authorization travels
inside the first UserOperation, sponsored by FOMO's bundler, so the wallet
never needs gas. It is inert until applied and stays in the browser only.
Delegation is per chain: the first sell order on each chain (Robinhood Chain,
Base, BNB Chain) connects the wallet there the same way, one signature, no
gas, nothing to do by hand. The one ordinary sell that captures the signing
sample is needed once, not per chain.

**The grant.** In the same operation the wallet grants the session key: an
expiry 30 days out, an operation count with headroom for retries, an approve
cap equal to the largest order, an approve budget for the session, and an
explicit list of target-and-selector pairs: `approve` on each order's token,
the swap on the relay router, the two guard functions. No native value, no
transfers, no fee recipients. The grant is renewed three weeks before expiry, when
operations run low, or when a larger order no longer fits the cap.

**Verification before signing.** Every operation the executor builds is
checked twice: against the grant as the contract will see it, and by a
verifier that refuses any transfer, any unknown spender, any approve larger
than the trade, any banned selector, and any batch longer than five calls.
A signature is issued only against a one-time ticket bound to the order.

**Where it works.** The account contract and the output guard are deployed
on Robinhood Chain, Base and BNB Chain, so sell orders execute there. On a
chain without them the order is saved and the panel says plainly that
auto-execution is not available there; nothing is signed. Buy orders are
Solana transactions signed by the wallet and do not need the contract,
whatever chain the token lives on.

**Disconnect.** The Limit orders switch off returns the wallet to FOMO's
account contract. The popup reports the result, including a not-finished state
with the delegate that is still in place.

---

## 7. Quick buy and sell from the feed

Modules: `src/isolated/feed-buy.js`, `src/shared/quick-buy.js`.

| Under a card in the feed | On a row of the Tokens tab |
|---|---|
| [<img src="screenshots/quick-trade-feed-card.png" width="390" alt="Buy $50, Buy $200 and Sell 50% under a thesis card" />](screenshots/quick-trade-feed-card.png) | [<img src="screenshots/quick-trade-token-row.png" width="390" alt="The same three buttons on a token row" />](screenshots/quick-trade-token-row.png) |

**Where.** Under every **Buy**, **Sell** and **Thesis** card in Alerts and
Feed, and on every token row of the Tokens tab (Trending, Most held,
Graduated and the other lists; the row's link names the token). On a token
row the room for the strip is made by a stylesheet rule, present while the
switch is on, and the strip is placed into it without changing the row's
height. That list (`getFixedItemSize` in FOMO's build) tells its
virtualiser that every row is 53px and places them 53px apart whatever
they measure, so while the switch is on the rows of that list are placed by
the extension (`src/isolated/token-list.js`, arithmetic in
`src/shared/fixed-list.js`): every top the list writes is multiplied by
the real row height over 53, the list's height too, and the list reads the
scroll position divided by the same ratio, so what it mounts for a scroll
position is what the viewport shows there. Its recycling and end-of-list
loading keep working in its own coordinates. A trade card names its token in the trade link; a
thesis card has no link, so the token is read from its logo URL, which
carries the chain and the address.

**What.** Three small buttons. Two green ones buy with fixed amounts in USD
(default $50 and $200, set in the popup, at most two, capped at $10,000); a
red one sells a share of the holding (default 50%, set in the popup as a
percentage). By default the first press arms the button and a second press
within three seconds executes, so a stray tap in a scrolling feed trades
nothing; the popup has a checkbox to turn the second press off and trade on
the first press.

**How.** A market trade through FOMO's own pipeline, the same path an order
takes: their quote for cash → token (a buy) or token → cash (a sell), the
wallet's signature through Privy on the page, their sender. A sell takes
the holding from the balances the app itself fetches, and for a Solana mint
without decimals there from the token account on the chain, the way the
order panel does; nothing is sold when there is no holding. After a send
the chain has the last word: a Solana transaction is watched until it
lands, fails or is dropped; an EVM operation whose bundler receipt does
not come is judged by the input token's balance on the chain. No target and
no tolerance of the extension's own apply; relay's slippage stands, as in
the app. The result is written next to the buttons and as a line in the
executor journal. No order is created and nothing is watched afterwards.

**Prerequisites.** A FOMO session, enough cash for a buy or a holding for
a sell, and the captured signing sample; the same refusals as the order
panel are shown otherwise.

**Speed, and the Solana node.** The cash is USDC on the user's Solana address
(`CASH_TOKEN_ID`), so EVERY buy starts there whatever chain the token is on,
and so does every sell of a Solana token. Each of them is checked on a Solana
node before it is signed (the guard: account reads and a simulation). A press
of these buttons and a limit order take the same path through `prepareSwap`;
only a sell of an EVM token skips the node, because it settles through the
bundler on its own chain. The
public nodes are asked all at once and the fastest good answer wins; they
are slow and refuse bursts. A node of your own (Helius, QuickNode, Triton,
any provider), pasted into the popup with its key, is asked first and
alone, so your traffic goes through your node; the public ones are asked
only when it did not answer. Chrome asks once for its origin. The key stays
in this browser.

[<img src="screenshots/side-panel-anywhere.png" alt="FOMO's feed in Chrome's side panel while another site fills the window" />](screenshots/side-panel-anywhere.png)

**The feed in the side panel.** Modules: `src/panel/`,
`src/isolated/feed-mirror.js`, `src/shared/mirror-tree.js`. The popup's
**Open the panel** button opens Chrome's side panel with FOMO's Alerts /
Tokens / Leaderboard / Feed block in it, so the feed stays in view on every
site. FOMO cannot be framed (`X-Frame-Options: DENY`), so the block is read
from an open FOMO tab: the content script there finds it by its four tab
buttons, sends it once as a tree and then as deltas from a
`MutationObserver`, and the panel rebuilds it with FOMO's own stylesheet
and FOMO's fonts (fetched by the extension itself: fomo.family sends no
CORS header for them, so the stylesheet alone cannot load them into an
extension page). FOMO's virtualised lists mount a window of rows around
the page's own scroll position, place them by measured or estimated tops
and recycle the row containers; the panel does not read a feed that way.
For every such list it keeps a shelf of its own: one slot per card, keyed
by the card's identity (a token row by its link, a card by its text
without the prices, percentages and times that tick), holding a copy of
the card as the page last showed it. A card the page has mounted once
stays on the shelf whether or not the page still mounts it, its copy is
refreshed in place when the page changes it, and a card arriving above the
viewport is inserted with the scroll moved by exactly its height. The
order comes from neighbourhood in the page's windows. The page's list
stays in the mirror as the hidden source; clicks and presses on a copy
reach the original through a map of copied elements to their ids. While a panel mirrors a tab, the MAIN-world
script answers "visible" to the page's visibility checks (`src/main/awake.js`):
FOMO loads its token lists only in a visible document, and a pinned tab in
the background showed the panel an empty Tokens tab otherwise; the moment
the last panel disconnects the real answer is back. A click in the panel is forwarded as a click on the same element in the tab
(the tabs switch, the lists page); a scroll is forwarded as a scroll, so
FOMO's virtualised lists render the rows the panel is looking at; a press on
a quick-buy button is forwarded as a press and runs on the tab through the
same code as a real one. When no FOMO tab is open the panel offers to open
one, pinned and in the background. Nothing is stored by the panel; it holds
the block only while it is open.

---

## 8. Self-hosted execution

Modules: `src/background/daemon.js`, `src/shared/daemon-api.js`, `daemon/`.
Guides: [SETUP.md](SETUP.md) (start here), [SERVER-SETUP.md](SERVER-SETUP.md), [SELF-HOSTING.md](SELF-HOSTING.md).

**Pairing.** The hub prints a one-time pairing string
(`http://host:8787#token`); `daemon/pairing.mjs` prints it alone so an
`ssh … | pbcopy` puts it in the clipboard. Pasted into the popup and confirmed
with **Connect**, it is exchanged for a paired state; from then on every
request is signed by the extension's session key and the hub ignores
everything else. Chrome asks once, inside that click, for permission to reach
the origin.

**Mirroring.** Every order change in the browser is pushed to the hub.
Verdicts from the server browser are pulled before each browser round and
close the order in the panel.

**The grant.** On the next order placement the wallet grants the runner
browser's session key, which the hub reports as its key, with the same bounds
as the laptop's own key. Each key is a separate owner-signed `grantSession`
operation; the hub has no key of its own to grant.

**Standing down.** While the hub reports a runner key the laptop's executor
does not execute (`runnerExecutes` in `src/shared/autonomy.js`), so one
position is never sold twice. Until a runner browser is paired the hub reports
no key, and the laptop keeps executing.

**Status.** The card shows one word next to **Details** (online or
unreachable); opened, it lists the server, the key to grant, how many orders
the hub watches, the last check, and with a runner browser its liveness,
build stamp and the last lines of its journal.

**Runner browser.** The complete answer to "orders that execute while the
laptop is off": a browser with the extension on the server, logged in to FOMO
and paired with the daemon as its runner. The installer pairs it; by hand it
is `scripts/pair-runner.sh` on the server, or the runner string pasted into
that browser's popup. The pairing itself is what makes a browser a runner,
there is no switch to flip, and unpairing is how it stops. The daemon becomes the hub: the laptop mirrors orders to it,
the runner browser holds one long-poll request open and gets each change
within a second or two into its own list, executes
them through FOMO exactly as the laptop would (chart streams, quotes, session
key, Privy on the page, so buys and Solana sells work and the app records the
PnL) and reports fills back; the laptop closes them in its panel. The laptop's
executor stands down while the hub reports a runner key, and not a moment
before: until a runner browser is paired there is no key, and the laptop keeps
executing rather than leaving the orders with nobody. The wallet grants the
runner's session key on the next order, because the hub reports it as its
key. The laptop's signing sample travels along with its tokens redacted, so
the runner browser signs without a sell of its own. `deploy/runner` ships both
services; see SERVER-SETUP.md.

**The daemon does not execute.** A server sending trades on its own, quoting
relay's public API and paying from a gas courier of its own, would go around
FOMO's pipeline, and no PnL line would be written for those sales. So there
is no such option: the hub keeps the orders, a browser executes them.

## 9. Interface language and theme

Modules: `src/shared/i18n.js`, `src/locales/`, `src/shared/theme.js`.

Seven interface languages, English as the source and fallback; a test enforces
key parity across dictionaries. Arabic switches the layout to right-to-left.
The panel reads FOMO's own CSS colour tokens with fallbacks, and uses the
page's typeface on the page; the popup ships its own. The executor journal is
English regardless of the interface language.
