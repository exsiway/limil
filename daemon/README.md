# limil hub

User-facing setup guide: [docs/SETUP.md](../docs/SETUP.md). This file is about
internals.

A small Node process that keeps your orders and hands them to the browser that
executes them, yours, or one on your server signed in to the same FOMO
account. It executes nothing itself and holds no funds: there is no gas
courier here and nothing in this process can move a token.

## Why it does not execute

A server could: quote relay's public API, build the batch, sign with a session
key of its own and send `handleOps` paid by a courier of its own. That goes
around FOMO's pipeline: the balance and the position come out right, but their
app never sees the trade, so there is no PnL entry for it. A trade that does
not appear where you read your trades is not worth what it saves.

So execution belongs to a browser, which goes through FOMO's own bundler.
FOMO pays the gas there, and the PnL line is written.

## What it does

- **Keeps the order list.** The extension pushes it; a closed order stays
  closed, and one the extension no longer lists is cancelled here.
- **Keeps the redacted signing sample**, so a browser on the server can sign
  without a sell of its own first.
- **Serves the runner browser**, which long-polls a version counter and posts
  verdicts and its journal back, including which FOMO account it is signed
  in to, so the owner's popup can say when that is the wrong one.
- **Tells the laptop which key to grant**: the runner browser's, once one is
  paired. Until then it reports none, and the laptop keeps executing itself.
  The hub has no key of its own.

## Files

| file | what |
|---|---|
| `index.mjs` | start-up, environment, the pairing strings it prints |
| `server.mjs` | the HTTP surface, request signing, replay cache |
| `hub.mjs` | the order list and what the runner reports back |
| `state.mjs` | one JSON file: pairing tokens, paired addresses, orders, sample, journal, the replay-nonce cache |
| `pairing.mjs` | prints a pairing string for the laptop or the runner |
