// The card that pairs a server shows the pairing field, not a switch in front
// of it.
//
// Two states carry meaning: autonomous mode is the consent for a machine to
// trade, and a paired server is a server in use. A third switch, "Own server
// executes", would only pause a server without unpairing, which the
// autonomous switch already does, and would stand between the person and the
// only thing that card is for.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/popup/popup.html'), 'utf8');
const js = readFileSync(join(root, 'src/popup/popup.js'), 'utf8');

test('there is no "own server executes" switch to get past', () => {
  assert.doesNotMatch(html, /id="daemonEnabled"/, 'the switch is gone from the markup');
  assert.doesNotMatch(js, /\$\('daemonEnabled'\)/, 'and nothing in the popup reaches for it');
});

test('the pairing field is hidden by being PAIRED, and by nothing else', () => {
  const line = js.split('\n').find((l) => l.includes("$('daemon-pair').hidden ="));
  assert.ok(line, 'the field must still be governed by something');
  assert.match(line, /Boolean\(st\?\.paired\)/);
  assert.doesNotMatch(line, /checked/, 'not by a switch, or the field is unreachable again');
});

test('the runner-browser card has no switch either, for the same reason', () => {
  // Pairing a browser as a runner IS the decision; a switch in front of it
  // only paused a runner without unpairing it, and on a server that switch
  // is a remote desktop away.
  assert.doesNotMatch(html, /id="mirrorEnabled"/, 'the switch is gone from the markup');
  assert.doesNotMatch(js, /\$\('mirrorEnabled'\)/, 'and nothing in the popup reaches for it');
  const line = js.split('\n').find((l) => l.includes("$('mirror-pair').hidden ="));
  assert.ok(line, 'the field must still be governed by something');
  assert.match(line, /Boolean\(st\?\.paired\)/);
  assert.doesNotMatch(line, /checked/, 'not by a switch');
});

test('pairing a server is what marks it in use', async () => {
  // With the switch gone, nothing else sets `daemonEnabled`, and the worker
  // still reads it to decide whether a server is active.
  const daemon = readFileSync(join(root, 'src/background/daemon.js'), 'utf8');
  const pair = daemon.slice(daemon.indexOf('export async function pair('));
  assert.match(pair.slice(0, 900), /daemonEnabled: true/);
});
