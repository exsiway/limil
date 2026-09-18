// One version, in three places that ship it.
//
// The extension manifest is what a person reads in chrome://extensions, the
// package is what a build and a release are named after, and the hub answers
// its own version to whoever asks. A release called one thing and a manifest
// saying another leaves nobody able to tell what is installed.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION as DAEMON_VERSION } from '../daemon/server.mjs';
import { storeManifest } from '../scripts/pack-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

test('the package, both manifests and the hub say the same version', () => {
  const pkg = read('package.json').version;
  // The one Chrome loads, and the one the store package would carry. The
  // store copy is derived rather than read from disk: it is a build artifact
  // and a fresh clone has none.
  const loaded = read('extension/manifest.json');
  assert.equal(loaded.version, pkg, 'the loaded manifest and the package disagree');
  assert.equal(storeManifest(loaded).version, pkg, 'the store manifest and the package disagree');
  assert.equal(DAEMON_VERSION, pkg, 'the hub and the package disagree');
  assert.match(pkg, /^\d+\.\d+\.\d+$/, 'a plain three-part version, the form a tag carries');
});
