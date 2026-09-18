# Self-hosting: orders that live while your laptop is closed

The extension keeps every order, key and quote inside the browser profile it
runs in. That is the whole privacy story, and it is also the constraint: an
order fires only while a browser with a live FOMO session is running. Quotes
and the bundler come from FOMO's own backend and need the session that exists
only in an open tab, bound to the IP that logged in.

So the answer is a browser that never sleeps on a machine you control, with
the extension loaded and FOMO logged in. Three ways to have one, from the
simplest to the one that lets you close the laptop for good:

- **Your own computer, kept awake** (section 1) or **a spare machine at home**
  (section 2). Orders are placed and executed in that same browser.
- **A server with the bundled Docker stack** (section 3, step by step in [SERVER-SETUP.md](SERVER-SETUP.md)): a Chromium with
  the extension logged in to FOMO plus a hub. You keep placing orders on your
  laptop; the hub carries them to the server browser, which executes them
  through FOMO exactly as the laptop would, buys and Solana sells included,
  with the trade recorded in the app and the PnL kept.

None of them involves a server of ours: the box is yours in every case, and
the keys it holds are bounded by the contract. So is the box's safety: who can
log in to it, who can open the browser on it, whether it is patched, is your
responsibility, the same as for the laptop the extension runs on.

## 1. Your own computer, kept awake

Leave a FOMO tab open and stop the machine sleeping: `caffeinate` on macOS,
`systemd-inhibit` on Linux, the power settings on Windows. Sleep is the one
failure that leaves no trace: alarms do not fire and the journal stays empty.

## 2. A spare machine at home (mini PC, old laptop)

Same steps on that machine: install Chrome, load the extension unpacked, log
in to FOMO, keep it awake. Notes:

- **Separate profile, separate storage.** The box has its own session key and
  its own orders; orders placed on your laptop are not visible to it. Place
  them where the watcher runs.
- **Same home network, same public IP**: the FOMO session stays valid.
- **Encrypt the disk** (FileVault, BitLocker, LUKS), open no ports, keep a
  dedicated OS user with nothing else in the profile. The box deserves the
  same care as a hardware wallet.

## 3. A VPS with the bundled Docker image (recommended)

The beginner's walkthrough of this section, with every command and every
click, is [SERVER-SETUP.md](SERVER-SETUP.md). What follows is the short form.

`deploy/runner/` contains a Compose stack with two services: Chromium with the
extension preloaded behind a browser-based desktop (noVNC), and the hub (the
same hub as in section 4). You log in to FOMO in that Chromium once and
leave the tab open on the server. Orders you place on your laptop reach the
hub and the server browser executes them through FOMO itself, so buys, Solana
sells and the PnL entry all work, day and night, with the laptop closed.

```
laptop (place orders) ──push──▶ hub ◀──pull/report── server browser (executes)
```

How the laptop reaches the hub without exposing it, Tailscale, an SSH tunnel
or TLS, is in [SERVER-SETUP.md](SERVER-SETUP.md) under "Security, plainly".

```bash
git clone https://github.com/exsiway/limil && cd limil
npm install && npm run build
cd deploy/runner
cp .env.example .env            # set a strong VNC password
docker compose up -d
```

`docker compose logs daemon` prints two pairing strings: one for the laptop
(`PUBLIC_URL#token`) and one for the runner browser (`http://daemon:8787#token`).

The noVNC desktop is published on `127.0.0.1` by default and stays off the
internet. Open it through an SSH tunnel from the laptop
(`ssh -N -L 3001:127.0.0.1:3001 user@server`, then `https://127.0.0.1:3001`)
or over Tailscale (`https://<tailscale-ip>:3001`); the certificate is
self-signed. Enter the password, and in the Chromium window:

1. `chrome://extensions` → the extension is already listed (loaded from the
   mounted `extension/` folder). If it is not, Developer mode → Load unpacked
   → `/config/extension`.
2. Open `https://fomo.family`, log in with the same account, open any token
   page. The signing sample this browser needs arrives from your laptop with
   the orders, token-redacted; only if the panel here keeps warning that
   auto-execution is off, make one ordinary sell of $2 or more in this browser once.
3. The installer pairs this browser with the hub and switches limit orders
   on for you. By hand it is `scripts/pair-runner.sh` on the server, or the
   popup here: **Autonomous orders** on and acknowledged, **Limit orders**
   on, then the runner string into the **Runner browser** card. Pairing is
   what makes this browser a runner; there is no switch to flip, and
   unpairing is how it stops. No permission prompt: the hub's address
   inside the stack (`http://daemon:8787`) is a host permission in the
   extension's manifest.

On your laptop: in the popup, **Autonomous orders** on, then the laptop string
into **Your own server** and **Connect**. From now on every order you place on
the laptop appears in the server browser within seconds and is executed there;
fills come back to the laptop's panel. The laptop's own executor stands down
while the hub reports a runner key, so until a runner is paired the laptop
keeps executing. Your wallet grants the server browser's session key on the next
order you place, one signature, like the extension's own key.

Then close the noVNC tab; the container keeps running. The profile is stored in
the `runner-config` volume, so `docker compose restart` keeps the session,
orders and key. Orders placed directly in the server browser work too.

**What the image does not solve.** FOMO binds the session to the IP that
logged in, you log in from the server's own IP through noVNC, so that is
fine. What it cannot do is hide the risk: the container holds a session that
can trade your wallet. Treat the VPS accordingly: open no port but SSH (and
Tailscale, if you use it), keep noVNC and the hub on `127.0.0.1` or the
Tailscale address and reach them through the tunnel, keep the password long,
update the host, and hold on the wallet only what you are willing to have
traded by whoever gets root on that machine. The contract's per-operation caps
bound a leaked *session key*, not a live *browser session*.

**Knowing the box is down.** The laptop's popup shows the server browser's
last report; when it has not reported in for minutes, the card says so. That
line is the watchdog: there is no push notification from the server itself.

### Why Chromium and not Chrome

Google Chrome 137+ ignores `--load-extension`; Chromium keeps it. The image
uses Chromium so the extension loads on container start with no click. If a
future Chromium drops the flag too, the manual "Load unpacked" step above still
works, the profile persists in the volume, so it is a one-time click.

## 4. What the hub is, and why it does not trade

The hub (the `daemon` service in the compose file, a legacy name) does not
execute and holds no key. It keeps the order list, keeps the redacted signing
sample so a browser on the server can sign without a sell of its own, and
serves that browser, the runner browser. Executing here was tried and
removed, it went through relay's public API and paid from a gas courier of
its own, which meant the sale never touched FOMO's pipeline and their app
wrote no PnL line for it.

So the answer to "orders while the laptop is closed" is a browser on the
server, signed in to the same FOMO account, paired as the runner. That path
goes through FOMO's own bundler: they pay the gas, they record the trade, and
nothing on the server ever holds funds.

```bash
git clone https://github.com/exsiway/limil && cd limil/deploy/runner
cp .env.example .env && $EDITOR .env    # VNC_PASSWORD and PUBLIC_URL
docker compose up -d && docker compose logs -f
```

The log prints two pairing strings: one for your laptop, one for the browser
on that box. The step-by-step is in [SETUP.md](SETUP.md).

**Network.** The port binds to `127.0.0.1` by default. Reach it over an SSH
tunnel or a VPN, or give it TLS (in the hub with `DAEMON_TLS_*`, or a
Caddy/nginx proxy) and publish it. The extension refuses a plain-http pairing
string to a public address. Requests are signed with a nonce each and the
hub refuses replays, so a stranger cannot place or read orders even on the
path; TLS keeps them from reading what travels.

**What can go wrong.** The browser on the server must be signed in to the
same FOMO account as the orders, or it quotes for another account and
executes nothing while looking connected; the popup checks that and says so.

Step-by-step: [SETUP.md](SETUP.md). Internals: `daemon/README.md`.

## Updating the extension on a box

Rebuild (`npm run build`, or `scripts/update.sh` on the server) into the
folder the profile loaded the extension from, for the Docker stack the folder
is bind-mounted, so a rebuild on the host is enough. On the Docker stack scripts/update.sh restarts the browser after a rebuild,
so it comes back on the new build in about fifteen seconds. Elsewhere the
running extension notices the new build within two minutes and reloads itself
when no trade is in flight, then reloads the FOMO tabs still on the old
bundle. The popup shows a banner if a tab still runs an older bundle than the
extension.

