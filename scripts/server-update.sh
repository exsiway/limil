#!/usr/bin/env bash
# Updates limil on your server from your laptop, in one command:
#
#   scripts/server-update.sh root@1.2.3.4
#   scripts/server-update.sh root@1.2.3.4 --force
#
# Runs scripts/update.sh over ssh. The runner browser picks the new build up
# by itself; nothing to click there. Which mode the update runs in (signed
# release tags, or origin/main unverified) is the server's own setting,
# LIMIL_UPDATE_MODE in its deploy/runner/.env; nothing typed here changes it.
#
# Only `--force` is accepted as an argument: the remote command line is built
# from a fixed string, never from what was typed here, so nothing typed here
# can become a second command on the server.
set -euo pipefail
TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: scripts/server-update.sh user@server [--force]"; exit 2; }
shift
FORCE=""
case "${1:-}" in
  "") ;;
  --force) FORCE="--force" ;;
  *) echo "usage: scripts/server-update.sh user@server [--force]"; exit 2 ;;
esac
[ $# -le 1 ] || { echo "usage: scripts/server-update.sh user@server [--force]"; exit 2; }
case "$TARGET" in
  -*) echo "server-update: the target must be user@host, not an option"; exit 2 ;;
esac
# The remote side gets a fixed command; the only variable part is the one
# literal flag validated above.
ssh -- "$TARGET" "bash /root/limil/scripts/update.sh ${FORCE}"
