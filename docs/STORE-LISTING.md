# Chrome Web Store listing

Everything the developer dashboard asks for, in one place, so the answers
stay the same across submissions. Brave installs extensions from the Chrome
Web Store, so this is the one review that matters for both.

The package is `release/limil-<version>.zip` from `npm run pack:store`. It is
the same code as the unpacked build with two manifest entries removed (the
fixed `key` and the docker hub address); see `scripts/pack-store.mjs`.

## Single purpose

limil is a companion for one site, fomo.family: it adds limit orders to
that site's token pages, take-profit and stop-loss that fire on their own
through the site's own pipeline. The extension does nothing on any other
site, has no content script anywhere else, and no feature works away from
fomo.family. Translation of the theses posted there is a separate extension,
Belingver, with its own listing.

## Short description (132 characters max)

Limit orders for fomo.family: take-profit and stop-loss that fire on their
own. Runs entirely in your browser, no account, no fee.

## Detailed description

limil adds limit orders to fomo.family. Take-profit and stop-loss orders that fire on their own, signed
by a session key that lives in your browser and is bounded on chain in size
and in price, and sent through FOMO's own pipeline so the app still records
the trade and your PnL stays intact. Orders show as levels on the chart. A
quick-buy button under every post in the feed.

Everything stays on your machine: orders, keys, quotes. There is no account with us, no telemetry, no fee. Optionally you can
run a small hub on a server of your own so orders keep firing while your
laptop is closed; that server is yours, we operate nothing.

What it does with your FOMO session, said plainly: to place a trade the way
the app does, the extension reuses the session the app already has in your
tab, the same request headers and the same wallet-signing dialog. It reads
them from the page you are on and keeps them in extension storage on your
device. It never sends them to us; nobody at limil can see them. In the
optional self-hosted mode a redacted copy (tokens removed) goes to the server
you paired, so a browser there can sign the same way.

limil is unofficial and not affiliated with FOMO, Privy or any exchange. Open
source, MIT licence. Privacy policy: see the link below.

## Permission justifications

`storage`: orders, settings and the session key are kept in extension
storage on the device. There is no account and no server
of ours; storage is the only place this data can live.

`alarms`: the executor wakes once a minute to check quotes against the
orders, and once every two minutes to see whether a newer build is on disk. A service
worker cannot keep a timer alive on its own.

`sidePanel`: the feed block of fomo.family is shown in Chrome's side panel
so it stays in view while the user browses other sites. The panel reads the
block from an open fomo.family tab through the extension's own messaging;
it runs no script on other sites and stores nothing.

Host permissions, fomo.family: the content scripts run there and nowhere
else; the extension is a companion for that one site. The MAIN-world script
reads the page's own requests to learn quotes and the session; the ISOLATED
script draws the order panel.

Host permissions, RPC nodes (Robinhood Chain, Base, BNB Chain, Ethereum,
Monad via Ankr, two public Solana nodes): read-only chain queries, to verify a
grant before signing, read balances to confirm a sell, and read receipts. No
keys are sent; the nodes see addresses and transaction hashes.

Host permissions, `api.relay.link`, `aggregator-api.kyberswap.com`,
`lite-api.jup.ag`: public quote APIs, asked for price impact and route
checks before a trade is signed. They see token addresses and amounts, not
the user's identity.

`optional_host_permissions` `https://*/*` and `http://*/*`: one use, asked
for at the moment of the user's own action and never in advance: the user's
own self-hosted hub, on an address only they know; Chrome asks once when
they pair it. Plain `http://` is accepted only for
loopback and private-network addresses (the code refuses a public http hub).

No `tabs`, no `scripting`, no `webRequest`, no `cookies`, no `<all_urls>`.

## Remote code

None. All code ships in the package. The extension talks to APIs and
receives data (quotes, balances); it never fetches or executes code.

## Data use disclosures (the dashboard form)

Collected on the device and never sent to the developer: nothing is sent to
the developer at all. What the extension handles:

| Category            | What                                                                 | Where it goes                                                     |
|---------------------|----------------------------------------------------------------------|-------------------------------------------------------------------|
| Authentication information | the FOMO session headers and the Privy signing envelope the page already has | extension storage on the device; a token-redacted envelope to the user's own hub in the optional self-hosted mode |
| Financial and payment information | wallet addresses, token balances, order sizes and prices, transaction hashes | the same public RPC nodes and quote APIs the app itself uses; the user's own hub in self-hosted mode |
| Website content     | token data read from fomo.family pages                                | stays on the device except as above                               |

Not collected: personally identifiable information, health, location, web
history, user activity outside fomo.family.

Certifications, all true: no sale of data to third parties; no use or transfer
of data for purposes unrelated to the single purpose; no use or transfer of
data to determine creditworthiness or for lending.

## Privacy policy URL

https://exsiway.github.io/limil-privacy/privacy.html

## Trademarks and affiliation

The listing names FOMO and Privy only to say what the
extension works with. The name limil, the icon and the brand image are our
own. The description and the store page state that the extension is
unofficial and not affiliated with any of them.

## Before every upload

- `npm test`, `npm run build`, `npm run pack:store`.
- `test/store-manifest.test.mjs` is green: no key, no plain-http host, no
  unused permission in the package.
- The version in `extension/manifest.json` is bumped; the store refuses a
  re-upload of the same version.
- The privacy policy page answers with 200 and matches `docs/PRIVACY.md`.
- The screenshots in `docs/screenshots/` still show the current UI.

## What the store version does not have

The runner browser on a server loads the unpacked build with the fixed id and
the docker hub address; a managed policy pairs it by that id. The store id is
different, so the server keeps the unpacked build. Nothing else differs.
