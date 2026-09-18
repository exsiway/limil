#!/usr/bin/env bash
# One command that puts the whole server side up: Docker if it is missing, the
# extension built, the stack started, the runner browser paired with the hub.
# It prints what the laptop needs and what is left to do by hand.
#
#   bash deploy/runner/install.sh                          # signed releases
#   LIMIL_UPDATE_MODE=main bash deploy/runner/install.sh    # follow the branch
#
# Safe to run again: it keeps an existing .env and never touches the hub's
# data or the browser profile. What it cannot do is log the server browser in
# to FOMO; that is a password, and it stays with the person.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
RUNNER="$ROOT/deploy/runner"
say() { printf '\n%s\n' "$*"; }

# What this machine will update itself to, and it is a security decision: the
# browser here is logged in to your FOMO account. `signed` moves only to a
# release tag whose signature verifies against deploy/allowed_signers; `main`
# follows the branch with nothing checked. An explicit environment variable
# wins; otherwise an .env already here decides, so running this again never
# weakens a machine that was set to signed; otherwise signed.
MODE="${LIMIL_UPDATE_MODE:-}"
if [ -z "$MODE" ] && [ -f "$RUNNER/.env" ]; then
  MODE="$(grep -E '^[[:space:]]*LIMIL_UPDATE_MODE=' "$RUNNER/.env" | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true)"
fi
MODE="${MODE:-signed}"
case "$MODE" in
  signed|main) ;;
  *) echo "install: LIMIL_UPDATE_MODE must be 'signed' or 'main', not '$MODE'" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  say "installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "install: docker compose v2 is missing; install it and run this again" >&2
  exit 2
fi

# ---------------------------------------------------------------- .env
if [ -f "$RUNNER/.env" ]; then
  say "keeping the .env that is already here"
else
  say "writing .env with a generated desktop password"
  cp "$RUNNER/.env.example" "$RUNNER/.env"
  PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28)"
  # The desktop password is generated rather than asked for: a password
  # invented at a prompt is the one that gets reused.
  tmp="$(mktemp)"
  # Signed by default. This machine runs a browser logged in to your FOMO
  # account, so what it updates itself to is a security decision: `signed`
  # moves only to a release tag whose signature verifies against
  # deploy/allowed_signers. Following a branch instead is an explicit choice,
  # made by starting this installer with LIMIL_UPDATE_MODE=main.
  sed -e "s|^VNC_PASSWORD=.*|VNC_PASSWORD=$PASS|" \
      -e "s|^LIMIL_UPDATE_MODE=.*|LIMIL_UPDATE_MODE=$MODE|" "$RUNNER/.env" > "$tmp"
  mv "$tmp" "$RUNNER/.env"
  chmod 600 "$RUNNER/.env"
fi

# ---------------------------------------------------------------- build
say "building the extension"
# No mode is forced here either: an installer that quietly overrode a machine
# already set to `signed` would undo the operator's decision on every run.
set +e
LIMIL_UPDATE_MODE="$MODE" bash "$ROOT/scripts/update.sh" --force
BUILT=$?
set -e
if [ "$BUILT" = 3 ]; then
  # update.sh already printed what it looked for. Say what it means here.
  echo ""
  echo "install: nothing signed to install, so nothing was built."
  echo "install: either add the maintainer's key to deploy/allowed_signers and"
  echo "install: use a release tag, or accept unsigned updates deliberately:"
  echo "install:   LIMIL_UPDATE_MODE=main bash $RUNNER/install.sh"
  exit 3
fi
[ "$BUILT" = 0 ] || exit "$BUILT"

# ---------------------------------------------------------------- start
say "starting the hub and the browser"
docker compose -f "$RUNNER/docker-compose.yml" up -d --build

# The hub writes its state on the first request; give it a moment before the
# token is read out of it.
for _ in $(seq 1 30); do
  if docker exec limil-hub node daemon/pairing.mjs all >/dev/null 2>&1; then break; fi
  sleep 1
done

# ---------------------------------------------------------------- pair
if [ -n "$(docker exec limil-hub node daemon/pairing.mjs runner 2>/dev/null || true)" ]; then
  say "pairing the browser with the hub"
  bash "$ROOT/scripts/pair-runner.sh"
else
  say "the browser is paired with the hub already"
fi

# ---------------------------------------------------------------- what now
LAPTOP="$(docker exec limil-hub node daemon/pairing.mjs 2>/dev/null || true)"
VNC_PASSWORD="$(grep -E '^VNC_PASSWORD=' "$RUNNER/.env" | cut -d= -f2-)"

cat <<EOF

--------------------------------------------------------------------
Done on the server. Two things are left, both from your own computer.

1. Open the server's desktop and log in to FOMO.

   Run this on your laptop and leave it running:

     ssh -N -L 3001:127.0.0.1:3001 -L 8787:127.0.0.1:8787 root@<this server>

   Then open  https://127.0.0.1:3001
   The certificate is self-signed: choose Advanced, Proceed.
   User: limil
   Password: $VNC_PASSWORD

   In the Chromium there: log in to FOMO with the account your orders
   belong to, open a token page, then in chrome://extensions switch
   Developer mode on and enable the limil card, and reload the FOMO tab.

2. Connect your laptop: open the limil popup, switch Autonomous orders
   on, and paste this line into "Your own server":

EOF
if [ -n "$LAPTOP" ]; then
  echo "     $LAPTOP"
  echo
  echo "   With the tunnel above, use http://127.0.0.1:8787 as the address:"
  echo "     http://127.0.0.1:8787#${LAPTOP##*#}"
else
  echo "     (already paired with a laptop; disconnect it there to pair another)"
fi
cat <<'EOF'
--------------------------------------------------------------------
EOF
