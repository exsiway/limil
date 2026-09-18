# A server that trades while your laptop is closed

Orders live in a browser: one has to be awake with your FOMO session in it.
This puts that browser on a server of yours, next to a small hub that carries
orders between the two. Nothing here belongs to us: the box is yours, and so
is keeping it safe.

## Before you start

**One thing has to be done in your own browser first: make one ordinary sell
of a token on Robinhood, BNB or Base, $2 or more.** Two dollars is FOMO's
smallest trade; below that it refuses. The extension cannot ask your wallet
for a signature until it has seen how FOMO asks for one, and only a sell on
those chains shows it that. A buy is signed on Solana and does not count.
Without it every order waits and nothing executes, here or on your laptop.

You also need:

- the extension working on your laptop already (see [SETUP.md](SETUP.md));
- a server with 4 GB of RAM, Ubuntu 22.04 or 24.04, root access over SSH;
- Docker on it: `curl -fsSL https://get.docker.com | sh`, or the
  [official instructions](https://docs.docker.com/engine/install/ubuntu/).

## How it works

```
your laptop            your server
-----------            -----------
 extension  ---------->  hub (keeps the orders)
                            |
                            v
                         Chromium with the extension, logged in to FOMO
                         (quotes, signs, sends through FOMO's bundler)
```

The hub holds no key and never trades. Both browsers must be signed in to the
**same** FOMO account: FOMO's swap endpoint takes no wallet argument, so the
account is whoever asks.

## 1. One command

```bash
apt-get install -y git && git clone https://github.com/exsiway/limil /root/limil
```

```bash
bash /root/limil/deploy/runner/install.sh
```

It installs Docker if there is none, builds the extension in a throwaway Node
container, writes an `.env` with a generated desktop password, starts the hub
and the browser, and pairs them with each other. Run it again any time: it
keeps the `.env` you have and never touches the hub data or the browser
profile.

At the end it prints the desktop password, the tunnel command for your
laptop, and the pairing line for the popup.

### Settings you may want to change

They live in `deploy/runner/.env`; after editing, run
`docker compose -f deploy/runner/docker-compose.yml up -d`.

| Line | Meaning |
|---|---|
| `VNC_PASSWORD` | opens the desktop, and that desktop can trade your wallet |
| `BIND_ADDR` | where the desktop is published; `127.0.0.1` keeps it behind the tunnel |
| `PUBLIC_URL` | the address the laptop uses for the hub; empty keeps it behind the tunnel |
| `LIMIL_UPDATE_MODE` | `main` follows the branch; `signed` refuses to move until a maintainer key is listed in `deploy/allowed_signers` |

To publish the hub instead of tunnelling to it, give it TLS: certificate and
key into `deploy/runner/certs`, then `DAEMON_TLS_CERT=/certs/fullchain.pem`,
`DAEMON_TLS_KEY=/certs/privkey.pem`, `DAEMON_BIND_ADDR=0.0.0.0`,
`PUBLIC_URL=https://<your-host>:8787`. Plain http to a public address is
refused by the extension.

## 2. Log in to FOMO in the server browser

Run the tunnel command the installer printed, then open the desktop in your
laptop’s browser:

```
https://127.0.0.1:3001
```

The certificate is self-signed: Advanced, Proceed. User `limil`, the password
the installer printed. In the Chromium you get:

1. Log in to FOMO with **the same account as on your laptop**. If you ever
   switch accounts, switch this browser too; your laptop’s popup turns red
   when the two differ.
2. Open any token page and let it load.
3. In `chrome://extensions` turn **Developer mode** on and switch the limil
   card on. Chromium asks this once for an extension loaded from a folder.
4. Reload the FOMO tab.

## 3. Connect your laptop

In your laptop's popup, switch **Autonomous orders** on, then paste the line
the installer printed into **Your own server** and press Connect. Allow the permission Chrome asks for.
The card shows the server as online, with the server browser's key and the
last lines of its journal.

From then on: an order placed on the laptop appears on the server within
seconds and is executed there; cancelling on the laptop cancels it there. The
first order after connecting also grants the server browser's key on chain,
one signature in your wallet, no gas.

## 4. Check it

Place a small order with a target far from the market. In the server browser
it appears under Active orders. Cancel it on the laptop and it disappears
there too. Now you can close the laptop.

## Everyday

**Updating.** From your laptop, in the limil folder:

```bash
scripts/server-update.sh root@<server-ip>
```

It moves the checkout, rebuilds, and restarts the hub and the server browser.
The browser comes back in about fifteen seconds on the build that was just
built; the profile, the FOMO login and the orders are in volumes and stay. For updates without asking, once on the
server: `bash /root/limil/deploy/runner/enable-autoupdate.sh` installs a
15 minute timer in the mode from `.env`; turn it off with
`systemctl disable --now limil-update.timer`.

**Watching.** `docker compose logs -f` on the server; the laptop's popup shows
the server browser's journal; FOMO shows the trades themselves, with PnL,
because they went through FOMO.

**Restarting.** Everything comes back by itself: the browser profile, the FOMO
login and the hub's data live in Docker volumes.

**Disconnecting.** Laptop: popup, Disconnect server. Server browser: Stop
executing for the laptop.

## Security, plainly

- The server browser is logged in to your FOMO account and can trade your
  wallet, exactly like a second laptop. Treat the box like one: a long
  `VNC_PASSWORD`, nothing else running on it, system updates on, SSH by key
  with passwords disabled.
- Do not publish the desktop. Keep `BIND_ADDR=127.0.0.1` and reach it through
  an SSH tunnel, or put it on a Tailscale address where only your machines
  can see it.
- The hub accepts only requests signed by your two browsers' keys, and is
  still not meant to be public: over plain http the order list and the
  pairing token travel in the clear, and the extension refuses such a pairing
  string to a public address. Local plus a tunnel, a Tailscale address, or
  TLS. Those are the three choices.
- Your wallet's private key never touches the server; it stays in Privy. The
  grant the server browser's key gets is bounded by the contract in size,
  price and time, and allows no transfers and no native value. It is not
  bounded in destination: a stolen key can sell within those bounds and keep
  the proceeds ([SECURITY.md](SECURITY.md) section 5).
- Access to the machines is yours to keep. The contract bounds a key; it does
  not bound a person at your keyboard.

## When something is off

| You see | Meaning | Do |
|---|---|---|
| Popup or panel: "make one ordinary sell" | the extension has never seen a signature from this wallet | one sell on Robinhood, BNB or Base, $2 or more; a buy or a Solana token does not count |
| Laptop popup: server "unreachable" | the laptop cannot open the hub's address | use the tunnel line the hub printed; check `docker compose ps` |
| Server popup: Runner browser "unreachable" | the server browser cannot reach the hub | use `http://daemon:8787#...` exactly as printed, not the public address |
| Orders do not appear on the server | the laptop is not paired, or the runner is not | both cards "online" |
| Server panel: "auto-execution is still off" | this browser has no signing sample yet | it arrives with the laptop's next order sync; or make one small sell in the server browser |
| Panel after an order: "NOTHING TO EXECUTE WITH" | the grant to the server key is missing | place the order again from the laptop; the grant goes with it |
| Laptop popup: "signed in to another FOMO account" | exactly that; nothing can execute there | sign the server browser in to the account the orders belong to |
| Server journal: "Swap simulation reverted on-chain: dflow_..." | the quote is made for another account, which does not hold that token | same as above |
| Server journal: "AA24 signature error" | the wallet is not delegated on that chain, or the operation was built for another wallet | place an order from the laptop on that chain and sign |
| Laptop popup: "has not reported in for minutes" | the server browser is closed, asleep or cannot reach the hub | open the desktop and check the FOMO tab is there |
| The desktop is slow | the server is short of memory | 4 GB is the practical minimum for Chromium |
