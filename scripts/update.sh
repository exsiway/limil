#!/usr/bin/env bash
# Updates limil on a server: moves the checkout to the newest SIGNED release
# tag, rebuilds the extension and the hub, and restarts both the hub and the
# runner browser, so the browser is on the build that was just built
# (background/selfupdate.js).
#
#   bash /root/limil/scripts/update.sh            # update if a newer signed tag exists
#   bash /root/limil/scripts/update.sh --force    # rebuild even without a new tag
#
# WHAT IS TRUSTED. This script runs on a timer (deploy/runner/enable-autoupdate.sh)
# and whatever it checks out ends up executing in a browser that holds your
# FOMO session. So by default it does not follow a branch: anyone who can push
# to origin/main, a compromised maintainer account, a stolen token, a bad
# merge, would otherwise be running code on your box within fifteen minutes.
# It follows RELEASE TAGS whose signature verifies against the keys in
# deploy/allowed_signers (SSH signatures) or your GPG keyring (PGP
# signatures). A tag that does not verify is not checked out, and the script
# says so loudly.
#
# TWO MODES. LIMIL_UPDATE_MODE=signed (the default) is described above.
# LIMIL_UPDATE_MODE=main fast-forwards to origin/main without verification;
# it is the weaker choice and the only one that works while no maintainer key
# is listed in deploy/allowed_signers or while the repository has no signed
# release yet. The mode is read from the environment first and then from
# deploy/runner/.env, so the timer, a hand run and scripts/server-update.sh
# all agree on it.
#
# Safe to run on a timer: exits quietly when nothing changed, never touches
# .env or data. The build runs in a throwaway node container pinned by
# digest, so the host needs only git and Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FORCE="${1:-}"

# The mode: environment, then the runner's .env, then the default. The .env is
# not sourced (it holds the VNC password and may contain characters a shell
# would interpret); only the one line is read.
MODE="${LIMIL_UPDATE_MODE:-}"
if [ -z "$MODE" ] && [ -f deploy/runner/.env ]; then
  MODE="$(grep -E '^[[:space:]]*LIMIL_UPDATE_MODE=' deploy/runner/.env | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true)"
fi
MODE="${MODE:-signed}"
case "$MODE" in
  signed|main) ;;
  *) echo "update: LIMIL_UPDATE_MODE must be 'signed' or 'main', not '$MODE'"; exit 2 ;;
esac

# The build image is the hub's base image: one digest, kept in the Dockerfile
# where Dependabot bumps it, read here so the two can never drift apart.
NODE_IMAGE="$(grep -m1 '^FROM ' deploy/daemon/Dockerfile | awk '{print $2}')"
if [ -z "$NODE_IMAGE" ]; then
  echo "update: could not read the node image from deploy/daemon/Dockerfile"; exit 2
fi

if [ ! -d .git ]; then
  echo "update: $ROOT is not a git checkout, clone it first (see docs/SERVER-SETUP.md)"; exit 2
fi
if [ -n "$FORCE" ] && [ "$FORCE" != "--force" ]; then
  echo "usage: scripts/update.sh [--force]"; exit 2
fi

# Mirror the remote's tags, do not merely add to them.
#
# A plain `--tags` fetch REFUSES a tag that moved ("would clobber existing
# tag"), returns non-zero and, under `set -e`, stops this script before its
# first line of output. A server then sits on an old build for as long as
# nobody thinks to look, which is exactly what happened after a release tag
# was re-cut. Tags move: a release is re-signed, a repository is recreated.
#
# Accepting a moved tag gives nothing away in signed mode: its signature is
# verified below, before anything is checked out.
if ! git fetch --prune --prune-tags --force --tags origin; then
  echo "update: cannot reach origin (see the error above); leaving this checkout alone" >&2
  exit 2
fi
LOCAL="$(git rev-parse HEAD)"

if [ "$MODE" = "main" ]; then
  echo "update: WARNING: LIMIL_UPDATE_MODE=main follows origin/main WITHOUT signature verification"
  TARGET_REF="origin/main"
  TARGET_NAME="origin/main"
else
  # Newest tag by version, e.g. v0.2.1. Only tags whose signature verifies
  # are candidates; the first that does is the target.
  TARGET_REF=""
  TARGET_NAME=""
  while read -r TAG; do
    [ -n "$TAG" ] || continue
    if git -c gpg.ssh.allowedSignersFile="$ROOT/deploy/allowed_signers" verify-tag "$TAG" >/dev/null 2>&1; then
      TARGET_REF="$TAG^{commit}"
      TARGET_NAME="$TAG"
      break
    fi
    echo "update: tag $TAG does not verify, skipped"
  done < <(git tag -l 'v*' --sort=-v:refname)
  if [ -z "$TARGET_REF" ]; then
    # Exit 3 is the normal state of a fresh install, not a broken one: there
    # is nothing signed to move to. Say exactly what makes it go away.
    echo "update: no release tag with a valid signature, nothing checked out (LIMIL_UPDATE_MODE=signed)."
    echo "update: two ways forward:"
    echo "update:   1. keep signed updates: add the maintainer's public key to deploy/allowed_signers"
    echo "update:      and have releases tagged with 'git tag -s vX.Y.Z'; this run then picks the newest one up;"
    echo "update:   2. follow the branch unverified: put LIMIL_UPDATE_MODE=main into deploy/runner/.env"
    echo "update:      (or run LIMIL_UPDATE_MODE=main bash scripts/update.sh --force once for a first build)."
    echo "update: the timer installed by deploy/runner/enable-autoupdate.sh reads the same setting."
    exit 3
  fi
fi

REMOTE="$(git rev-parse "$TARGET_REF")"
if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" != "--force" ]; then
  echo "update: already at $(git rev-parse --short HEAD) ($TARGET_NAME), nothing to do"; exit 0
fi

echo "update: $(git rev-parse --short HEAD) -> $(git rev-parse --short "$REMOTE") ($TARGET_NAME)"
if [ "$MODE" = "main" ]; then
  # Fast-forward only: a diverged server checkout is a mistake to look at, not to overwrite silently.
  git merge --ff-only origin/main --quiet
else
  # A release is a fixed point; the checkout is detached at it.
  git checkout --quiet --detach "$REMOTE"
fi

echo "update: building the extension"
docker run --rm -v "$ROOT":/app -w /app "$NODE_IMAGE" sh -c 'npm ci --no-audit --no-fund --silent --ignore-scripts && npm run build --silent'

if [ -f deploy/runner/docker-compose.yml ] && docker compose -f deploy/runner/docker-compose.yml ps --services 2>/dev/null | grep -q daemon; then
  echo "update: rebuilding the hub"
  docker compose -f deploy/runner/docker-compose.yml up -d --build daemon >/dev/null
fi

# The runner browser is restarted rather than left to reload itself. An
# unpacked extension whose files changed under a running browser is supposed
# to pick the new build up (background/selfupdate.js, chrome.runtime.reload),
# and usually does; when it does not, the browser keeps running the old build
# and says nothing, or stops executing altogether. A restart takes fifteen
# seconds, re-reads the extension from disk, and leaves the profile, the FOMO
# login and the hub's orders where they are.
if [ -f deploy/runner/docker-compose.yml ] && docker compose -f deploy/runner/docker-compose.yml ps --services --filter status=running 2>/dev/null | grep -qx runner; then
  echo "update: restarting the runner browser"
  docker compose -f deploy/runner/docker-compose.yml restart runner >/dev/null
fi
echo "update: done at $(git rev-parse --short HEAD) ($TARGET_NAME)"
