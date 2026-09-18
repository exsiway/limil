# limil, setup

limil adds limit orders to FOMO. You say "sell when it reaches this price",
and it sells for you.

Part 1 takes ten minutes and needs nothing but Chrome. Part 2 is optional: it
keeps your orders running with the laptop closed, and needs a small rented
server.

You need Chrome and a FOMO account you are logged in to, with something in it.

---

# Part 1. Orders in your browser

## A. Install the extension

1. Download `limil-<version>.zip` from
   [the latest release](https://github.com/exsiway/limil/releases/latest)
   and unzip it. You get a folder.
2. Open `chrome://extensions`.
3. Switch **Developer mode** on, top right.
4. Press **Load unpacked** and choose that folder.
5. Click the puzzle-piece icon in Chrome's toolbar and pin limil.

Do not move or delete that folder. Chrome loads the extension from it every
time it starts. To build it yourself instead, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## B. Switch limit orders on

1. Open **fomo.family** and log in.
2. Click the limil icon and switch **Limit orders** on.

Open any token page. Under FOMO's own buy/sell box there is now a **Limit
order** panel. That is where your orders go.

## C. Sell once by hand, on Robinhood, BNB or Base

Sell $2 or more of a token on one of those three chains, with FOMO's own
**Sell** button. Two dollars is FOMO's smallest trade; below that it refuses.

- It must be a **sell**. A buy does not count: the cash you buy with sits on
  Solana, so a buy is signed the Solana way.
- It must be on **Robinhood, BNB or Base**. A Solana token does not count,
  for the same reason.

This is what lets limil sign for you later. Once per FOMO account. If you
switch accounts, do it again; the popup tells you when.

## D. Use it

Setup is done. Place orders in the panel and get on with your day.

One thing to remember: **orders fire only while Chrome is running on this
computer and the computer is awake.** The FOMO tab may be closed. A closed
laptop lid may not, because on most machines that is sleep.

To leave orders running overnight:

- turn automatic sleep off in the system's power settings;
- leave Chrome running;
- keep the machine plugged in.

For orders that fire whatever your laptop is doing, go to part 2.

---

# Part 2. Orders around the clock

A browser on a server watches your orders and executes them. You keep placing
them from your laptop as before. Any small Linux server will do.

## E. One command on the server

```bash
git clone https://github.com/exsiway/limil /root/limil
```

```bash
bash /root/limil/deploy/runner/install.sh
```

It installs Docker if the server has none, builds the extension, starts the
browser and the hub, and pairs them. At the end it prints three things: the
desktop password, the tunnel command for your laptop, and the line to paste
into the popup. Keep that output.

## F. Log the server browser in to FOMO

1. Run the printed tunnel command on your laptop and leave it running.
2. Open `https://127.0.0.1:3001`. The certificate is self-signed: choose
   Advanced, Proceed.
3. User `limil`, the password it printed.
4. In the Chromium you get, log in to FOMO with **the same account as on your
   laptop**.
5. Open any token page and let it load.
6. In `chrome://extensions` there, switch **Developer mode** on, enable the
   limil card, and reload the FOMO tab.

## G. Connect your laptop

In the popup, switch **Autonomous orders** on and accept the warning. Paste
the printed line into **Your own server** and press **Connect**. Allow the
permission Chrome asks for. The card shows the server as online.

Check it once: place a small order with a target far from the market. It
appears in the server browser within seconds. Cancel it on the laptop and it
disappears there too. Now you can close the laptop.

## Turning the server off

Switch **Autonomous orders** off in the popup. Your own browser takes the
orders back. To connect again, get a fresh pairing line: leaving invalidates
the old one.

---

## If something looks wrong

Open the popup. The top block answers one question: will my orders fire? It
checks the chain rather than guessing.

| It says | What to do |
|---|---|
| Orders will not execute yet: make one ordinary sell… | step C, with the account the orders belong to |
| the wallet is not connected to the limil contract on… | place the order again; the connection goes with it |
| Orders only work on fomo.family | open a FOMO token page |
| Auto-execution is still off | step C |
| the browser on your server is signed in to another FOMO account | step F, with the right account |
| the server browser has not reported in for minutes | open the server desktop and check the FOMO tab is open |

Updating the server later, from your laptop, in the limil folder:

```bash
scripts/server-update.sh root@<server-ip>
```

More detail on the server half: [SERVER-SETUP.md](SERVER-SETUP.md).
