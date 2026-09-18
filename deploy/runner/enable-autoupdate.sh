#!/usr/bin/env bash
# Opt-in automatic updates on the server: a systemd timer runs
# scripts/update.sh every 15 minutes. What that script moves the checkout to
# depends on LIMIL_UPDATE_MODE: the newest SIGNED release tag (signed, the
# default) or a fast-forward to origin/main without verification (main). The
# mode is taken from this shell's environment first and then from the
# runner's .env next to this script, and is written into the unit, so
# re-running this script keeps the mode the box was set up with instead of
# silently reverting a hand edit of the unit.
#
#   bash /root/limil/deploy/runner/enable-autoupdate.sh      # enable
#   LIMIL_UPDATE_MODE=main bash .../enable-autoupdate.sh    # enable, following main
#   systemctl disable --now limil-update.timer               # disable
#   journalctl -u limil-update --since today                 # what it did
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/runner/.env"

# Same resolution as scripts/update.sh, and the same reason for not sourcing
# the file: it holds the VNC password.
MODE="${LIMIL_UPDATE_MODE:-}"
if [ -z "$MODE" ] && [ -f "$ENV_FILE" ]; then
  MODE="$(grep -E '^[[:space:]]*LIMIL_UPDATE_MODE=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true)"
fi
MODE="${MODE:-signed}"
case "$MODE" in
  signed|main) ;;
  *) echo "enable-autoupdate: LIMIL_UPDATE_MODE must be 'signed' or 'main', not '$MODE'" >&2; exit 2 ;;
esac
if [ "$MODE" = "signed" ] && ! grep -qE '^[^#[:space:]]' "$ROOT/deploy/allowed_signers" 2>/dev/null; then
  echo "enable-autoupdate: note: deploy/allowed_signers lists no key yet, so in signed mode the timer" >&2
  echo "enable-autoupdate: will refuse every tag (exit 3) until one is added. Set LIMIL_UPDATE_MODE=main" >&2
  echo "enable-autoupdate: in deploy/runner/.env to follow origin/main unverified instead." >&2
fi

cat >/etc/systemd/system/limil-update.service <<EOF2
[Unit]
Description=limil: fetch, build and restart the hub when a new version is available
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment=LIMIL_UPDATE_MODE=$MODE
ExecStart=/usr/bin/bash $ROOT/scripts/update.sh
EOF2

cat >/etc/systemd/system/limil-update.timer <<EOF2
[Unit]
Description=limil: check for updates every 15 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
EOF2

systemctl daemon-reload
systemctl enable --now limil-update.timer
if [ "$MODE" = "main" ]; then
  echo "limil auto-update enabled: every 15 minutes, fast-forward to origin/main (unverified). Log: journalctl -u limil-update"
else
  echo "limil auto-update enabled: every 15 minutes, newest signed release tag. Log: journalctl -u limil-update"
fi
