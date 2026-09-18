#!/usr/bin/env bash
# Pair the browser on THIS box with the hub, without touching its screen.
#
# The worst step of the server setup was the one that could not be scripted:
# open a remote desktop, find the extension's popup in a browser you are
# driving over a video stream, and paste a token into it. This does that step
# from a shell.
#
# It writes a Chromium managed policy, the browser's own channel for settings
# an administrator provisions, and restarts the browser. The extension reads
# it on start (`chrome.storage.managed`) and pairs itself. It pairs ONLY when
# nothing is paired, so this never overrides a pairing made by hand.
#
# The policy also carries the acknowledgement that this machine may execute
# orders. Running this script IS that consent: anyone able to write here owns
# the box already, and demanding a click inside the browser as well would stop
# nobody while forcing the owner through a remote desktop.
#
#   bash scripts/pair-runner.sh 'http://daemon:8787#TOKEN'
#
# The string comes from the laptop's popup, or from the hub's own log.
set -euo pipefail

PAIRING="${1:-}"
DIR="${LIMIL_RUNNER_DIR:-$(cd "$(dirname "$0")/.." && pwd)/deploy/runner}"
POLICY_DIR="$DIR/policies"
CONTAINER="${LIMIL_RUNNER_CONTAINER:-limil-runner}"
HUB_CONTAINER="${LIMIL_HUB_CONTAINER:-limil-hub}"
# The id is fixed by the `key` in the manifest, so a policy can name it.
EXT_ID="${LIMIL_EXT_ID:-fmjcaabdnlaefjlbkhidnonbpciangdc}"

# Without an argument the token is read from the hub on this same box: it is
# the hub that issued it, and copying it through a terminal adds nothing.
if [ -z "$PAIRING" ] && docker exec "$HUB_CONTAINER" node daemon/pairing.mjs runner >/dev/null 2>&1; then
  TOKEN="$(docker exec "$HUB_CONTAINER" node daemon/pairing.mjs runner 2>/dev/null || true)"
  [ -n "$TOKEN" ] && PAIRING="http://daemon:8787#$TOKEN"
fi

if [ -z "$PAIRING" ]; then
  echo "usage: bash scripts/pair-runner.sh ['http://daemon:8787#TOKEN']" >&2
  echo "  without an argument the token is taken from the hub container $HUB_CONTAINER;" >&2
  echo "  an empty answer from it means a browser is paired there already." >&2
  exit 2
fi
# Strict shape, not just "starts with http": the string is written into a JSON
# file below and passed to `sh -c` inside the container, so a quote, a brace
# or a semicolon in it would break the policy or become a command. The hub's
# tokens are 32 symbols from [A-Za-z0-9_-]; the host part allows a name, an
# IPv4 or a bracketed IPv6 address with an optional port.
PAIRING_SHAPE='^https?://[A-Za-z0-9._:-]+(:[0-9]+)?#[A-Za-z0-9_-]{16,128}$'
if ! [[ "$PAIRING" =~ $PAIRING_SHAPE ]]; then
  echo "that does not look like a pairing string: expected http://host:port#TOKEN," >&2
  echo "with the token made of letters, digits, '_' and '-' only. Paste it exactly as the hub printed it." >&2
  exit 2
fi

mkdir -p "$POLICY_DIR"
cat > "$POLICY_DIR/limil.json" <<JSON
{
  "3rdparty": {
    "extensions": {
      "$EXT_ID": {
        "runnerPairing": "$PAIRING",
        "acceptAutonomousRisk": true
      }
    }
  }
}
JSON
# Readable by the browser, which runs as another user inside the container,
# a 0600 root-owned file is silently invisible to it, and the pairing simply
# never happens. The token is kept private by the directory instead: this path
# lives under the server's own root-only home.
chmod 644 "$POLICY_DIR/limil.json"
chmod 755 "$POLICY_DIR"
echo "policy written: $POLICY_DIR/limil.json"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "the container $CONTAINER is not there yet, start the stack and the policy applies on its own" >&2
  exit 0
fi
# The mount is declared in the compose file; a container started before this
# script existed has no policy directory in it and must be recreated.
if ! docker exec "$CONTAINER" test -d /etc/chromium/policies/managed 2>/dev/null; then
  echo "recreating $CONTAINER so the policy directory is mounted"
  (cd "$DIR" && docker compose up -d --force-recreate runner)
else
  docker restart "$CONTAINER" >/dev/null
fi
# Second route, for when the policy does not take: put the string into the
# BROWSER's own clipboard, inside the container. Pasting from a laptop into a
# remote desktop generally does not work, the clipboards are on different
# machines, so this puts it where Ctrl+V in that browser will find it, and
# the only thing left to do by hand is click the field and paste.
if docker exec -e XDG_RUNTIME_DIR=/config/.XDG -e WAYLAND_DISPLAY=wayland-0 -u 1000 \
     "$CONTAINER" sh -c "printf %s '$PAIRING' | wl-copy" 2>/dev/null; then
  echo "also copied into that browser's clipboard: if it has not paired itself in a"
  echo "minute, open the remote desktop, the popup, Runner browser, Ctrl+V, Connect"
fi
echo "done: the browser pairs itself on start; check the hub log for the runner reporting in"
