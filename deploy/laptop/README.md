# Laptop: a standing SSH tunnel to the hub (macOS)

The hub listens on the server's Tailscale address (or on 127.0.0.1). When
Tailscale is not an option on the laptop, an SSH tunnel makes the hub
`http://127.0.0.1:8787` locally, and launchd keeps the tunnel up: it starts at
login and reconnects when it drops.

```bash
cp deploy/laptop/com.limil.hub-tunnel.plist.example ~/Library/LaunchAgents/com.limil.hub-tunnel.plist
# edit: <user@server>, <hub-tailscale-ip-or-127.0.0.1>, and ~ in the log paths -> /Users/<you>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.limil.hub-tunnel.plist
curl http://127.0.0.1:8787/v1/hello      # {"protocol":2,...}
```

Then pair in the popup with `http://127.0.0.1:8787#<token>` (a loopback
address is accepted over plain http). SSH must work non-interactively
(`ssh -o BatchMode=yes user@server true`): a key without a passphrase, or one
in the login keychain.

Stop and remove:

```bash
launchctl bootout gui/$(id -u)/com.limil.hub-tunnel
rm ~/Library/LaunchAgents/com.limil.hub-tunnel.plist
```
