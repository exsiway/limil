#!/usr/bin/env node
// limil hub: keeps the order list for a browser on this box to execute.
//
//   DAEMON_DATA   directory for state.json (default ./data)
//   DAEMON_PORT   port (default 8787)
//   DAEMON_HOST   bind address (default 127.0.0.1, local only; the Docker
//                 image sets 0.0.0.0 inside the container and docker-compose
//                 decides which host interface the port is published on)
//   DAEMON_TLS_CERT / DAEMON_TLS_KEY
//                 paths to a certificate chain and key: serve https in-process.
//                 Without TLS the extension pairs only over loopback, a private
//                 network or an SSH tunnel; plain http to a public address is
//                 refused on the extension side.
//   PUBLIC_URL    the URL the extension will reach this daemon at; printed in
//                 the pairing string (default http://127.0.0.1:port, pair over
//                 an SSH tunnel)
//   RUNNER_URL    the URL a runner browser on this box reaches the daemon at
//                 (default: the same as PUBLIC_URL; in the Docker stack http://daemon:8787)
//
// See daemon/README.md and docs/SELF-HOSTING.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isPrivateHost } from '../src/shared/daemon-api.js';
import { openState } from './state.mjs';
import { startServer } from './server.mjs';
import { createHub } from './hub.mjs';

const dataDir = resolve(process.env.DAEMON_DATA ?? './data');
const port = Number(process.env.DAEMON_PORT ?? 8787);
const host = process.env.DAEMON_HOST ?? '127.0.0.1';

let tls = null;
if (process.env.DAEMON_TLS_CERT || process.env.DAEMON_TLS_KEY) {
  if (!process.env.DAEMON_TLS_CERT || !process.env.DAEMON_TLS_KEY) {
    console.error('DAEMON_TLS_CERT and DAEMON_TLS_KEY must be set together');
    process.exit(2);
  }
  tls = { cert: readFileSync(process.env.DAEMON_TLS_CERT), key: readFileSync(process.env.DAEMON_TLS_KEY) };
}

const scheme = tls ? 'https' : 'http';
const publicUrl = (process.env.PUBLIC_URL || `${scheme}://127.0.0.1:${port}`).replace(/\/$/, '');
const runnerUrl = (process.env.RUNNER_URL ?? publicUrl).replace(/\/$/, '');

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const state = openState(dataDir);
// A post box, not a trader: it keeps the orders and hands them to the browser
// that executes them. Nothing here holds funds or can move a token.
const hub = createHub({ state, log });

startServer({ state, executor: hub, port, host, tls, log });

console.log('');
console.log('limil hub');
console.log(`  state         ${state.path}`);

// A pairing string the extension will refuse is not worth printing without a
// warning: plain http to a public host is not accepted on the other side.
let publicHost = null;
try { publicHost = new URL(publicUrl); } catch { /* printed as is */ }
if (publicHost && publicHost.protocol === 'http:' && !isPrivateHost(publicHost.hostname)) {
  console.log('');
  console.log(`  WARNING: PUBLIC_URL is plain http to a public address (${publicHost.hostname}).`);
  console.log('  The extension refuses such a pairing string. Either set DAEMON_TLS_CERT/DAEMON_TLS_KEY');
  console.log('  (or a TLS proxy) and PUBLIC_URL=https://…, or keep the port local and pair over an');
  console.log('  SSH tunnel: ssh -L 8787:127.0.0.1:8787 user@server, then http://127.0.0.1:8787#<token>.');
}

if (state.data.owner) {
  console.log(`  paired with   ${state.data.owner}`);
} else {
  console.log('');
  console.log('  Paste this into the extension popup, under Your own server (on your laptop):');
  console.log(`  ${publicUrl}#${state.data.pairToken}`);
  // The address above is reachable from this box; whether it is reachable
  // from the laptop is the thing nobody can tell from the laptop. The hub
  // knows the host and the port, so it writes the tunnel out rather than
  // leaving three values in an .env to be assembled by hand.
  if (publicHost && publicHost.hostname !== '127.0.0.1' && publicHost.hostname !== 'localhost') {
    const p = publicHost.port || (publicHost.protocol === 'https:' ? '443' : '80');
    console.log('');
    console.log('  If the laptop cannot reach that address, tunnel to it and pair through the tunnel:');
    console.log(`  ssh -N -L ${p}:${publicHost.hostname}:${p} <user>@<this server>`);
    console.log(`  ${publicHost.protocol}//127.0.0.1:${p}#${state.data.pairToken}`);
  }
}
if (state.data.runner) {
  console.log(`  runner        ${state.data.runner.key}   (a browser on this box executes; the owner's wallet grants this key)`);
} else {
  console.log('');
  console.log('  Optional: a browser on this box with the extension executes through FOMO itself.');
  console.log('  In THAT browser paste into the popup, under Runner browser (the token alone is enough):');
  console.log(`  ${runnerUrl}#${state.data.runnerToken}`);
}
console.log('');
