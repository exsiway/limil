# Privacy

The extension has no server, no account and no telemetry. This page lists
exactly what it stores, what it sends, and to whom.

## What is stored, and where

Everything is in `chrome.storage.local` of the browser profile the extension
runs in, except the one-time intents behind a delegation, grant or disconnect,
which live in `chrome.storage.session` and vanish with the browser. Nothing
uses `chrome.storage.sync`, so nothing is copied to a Google account or
another device.

One exception, and only on a runner browser you run on your own server:
`scripts/pair-runner.sh` writes the pairing string and the risk
acknowledgement into Chromium's managed policy, which the extension reads
through `chrome.storage.managed`. A daily execution limit can be added to that
file by hand (`runnerMaxFiresPerDay`); the script does not write one. That file is on your server,
written by you, and carries the pairing token of your own hub; nothing else is
ever read from managed storage.

| Data | Purpose | Leaves the browser? |
|---|---|---|
| Settings (switches, interface language) | your choices | no |
| Orders (token, size, target, direction, slippage, status) | watching and executing | to your own daemon if you paired one; otherwise no |
| Session key (private) | signing bounded operations | never; signatures leave, the key does not |
| Privy envelope sample, stored without its session token | replaying the wallet's signing request; the live token is taken from the page at use | to your own hub if you paired one, with its session tokens removed first (withheld when that cannot be proven); otherwise never, it is posted only to the Privy iframe already on the page |
| Executor journal | telling you what happened and why | from your own browser, no; a browser running as a runner on your server sends its last 25 lines to your own hub, so you can see on the laptop what it did |
| Daemon pairing state | reaching your own server | to that server only |
| Runner policy (pairing string, risk acknowledgement, daily limit), self-hosted runner only | pairing that browser with your own hub without a popup | to your own hub only; you write it into Chromium's managed policy on your server |

## Leaving a hub

Unpairing is not only a disconnection, it is an erasure. The hub drops the
order list, both wallet addresses, the signing sample and its own journal, and
resets the runner browser's record to the pairing alone, without its reported
journal or the account it was signed in to. The runner keeps its own pairing,
because that credential belongs to the machine rather than to you, but the hub
refuses journal lines older than the owner who is paired now. So a hub handed
on, or paired again by someone else, carries nothing of what you did with it.

## What is sent, and to whom

**FOMO (`fomo.family`, `*.fomo.family`, its bundler).** Quotes, balances and
signed operations, with the session headers FOMO's own front end already
sends. This is the same traffic a tap in the app produces.

**Privy (iframe on the page).** Signing requests, through `postMessage`. No
network request of the extension's own.

**Public RPC nodes** (Robinhood Chain, Base, BNB Chain, Ethereum, Solana,
listed in the manifest; Monad through `rpc.ankr.com`). Reads only: nonces,
code, balances, quoter simulations. They see your wallet address, as any block
explorer would. A Solana node of your own, if you paste one into the popup
(with your provider key), takes those reads instead, and the public ones
are asked only when it did not answer; its URL stays in this browser's
extension storage and goes nowhere else.

**Public aggregators** (`api.relay.link`, KyberSwap, Jupiter). Quote requests
for impact and route checks. KyberSwap and Jupiter see token addresses and
amounts; the relay impact quote also carries your EVM wallet as its user or
recipient and, when the order has one, your Solana address.

**Jito** (Solana). Signed buy transactions.

**Your own hub**, if paired. The live orders, your wallet addresses (EVM and
Solana) and the Privy envelope sample with its session tokens removed, so a
browser on your server can sign without a sell of its own; the sample stays
here when the redaction cannot prove it clean. Requests are signed by your
session key. It is your server: nothing goes anywhere else.

Nothing is sent to the project's authors. There is no analytics, crash
reporting or update check.

## Permissions

`storage`, `alarms`, `sidePanel` (the feed shown in Chrome's side panel,
read from an open FOMO tab; the panel stores nothing), and host permissions
for fomo.family, the RPC nodes and the quote APIs above. `optional_host_permissions` covers `https://*/*` and
`http://*/*` for one thing: a self-hosted hub runs on an address only you
know, and Chrome asks you once when you pair it. Nothing else is ever
requested.

## Removing everything

Turn **Limit orders** off (this returns the wallet to FOMO's account contract),
then remove the extension. Chrome deletes its storage with it.
