#!/usr/bin/env node
// Prints the pairing string(s) of this hub, nothing else, so they can be
// piped into a clipboard from the laptop instead of retyped from the log:
//
//   ssh root@<server> 'docker exec limil-hub node daemon/pairing.mjs' | pbcopy    # macOS
//   ssh root@<server> 'docker exec limil-hub node daemon/pairing.mjs' | clip      # Windows
//
//   node daemon/pairing.mjs           the laptop string (empty when already paired)
//   node daemon/pairing.mjs runner    the runner-browser token (empty when paired)
//   node daemon/pairing.mjs all       both, labelled

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = resolve(process.env.DAEMON_DATA ?? './data');
const data = JSON.parse(readFileSync(resolve(dataDir, 'state.json'), 'utf8'));
const port = Number(process.env.DAEMON_PORT ?? 8787);
// The same address the hub itself prints (daemon/index.mjs). docker-compose
// passes PUBLIC_URL through as an empty string when it is not set, so empty
// must count as unset (`||`, not `??`), otherwise the laptop string comes out
// as a bare `#TOKEN`. The fallback is loopback on purpose: with PUBLIC_URL
// empty the hub is published on 127.0.0.1 and the laptop reaches it over an
// SSH tunnel to that same address. The container's own interface address
// would look plausible and be unreachable from anywhere but this box.
const scheme = process.env.DAEMON_TLS_CERT ? 'https' : 'http';
const publicUrl = (process.env.PUBLIC_URL || `${scheme}://127.0.0.1:${port}`).replace(/\/$/, '');
const runnerUrl = (process.env.RUNNER_URL || publicUrl).replace(/\/$/, '');
const laptop = data.owner ? '' : `${publicUrl}#${data.pairToken}`;
const runner = data.runner ? '' : data.runnerToken;
const what = process.argv[2] ?? 'laptop';
if (what === 'runner') process.stdout.write(runner);
else if (what === 'all') process.stdout.write(`laptop: ${laptop || '(paired)'}\nrunner: ${runner ? `${runnerUrl}#${runner}` : '(paired)'}\n`);
else process.stdout.write(laptop);
