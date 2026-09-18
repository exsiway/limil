# Image for the hub. Built by deploy/runner/docker-compose.yml, which is the
# only stack there is: a hub alone executes nothing, so it never ships alone.
# Pinned by digest, not by tag: a tag moves, a digest does not. Update the
# digest deliberately (Dependabot proposes it) rather than on every build.
# scripts/update.sh reads this FROM line to build the extension in the same
# image, so this is the only place the digest lives; keep it the first FROM.
# node:22-alpine, pinned by digest.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only, and no lifecycle scripts: nothing here needs
# to run code at install time, so nothing gets to.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY daemon ./daemon
# The hub runs as the unprivileged `node` user the base image ships. The
# data directory is created and owned here so a fresh named volume inherits
# that ownership.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DAEMON_DATA=/data
# Inside the container the process must listen on all interfaces for the port
# mapping to reach it; WHICH host interface the port is published on is
# decided by docker-compose (BIND_ADDR, default 127.0.0.1).
ENV DAEMON_HOST=0.0.0.0
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "daemon/index.mjs"]
