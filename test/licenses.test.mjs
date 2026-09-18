// Every package whose code ships must ship its licence with it.
//
// MIT, which all of them use, requires the copyright and permission notice to
// travel with the code. Reading package.json is not enough to know what
// travels: viem pulls in ox, abitype, isows and three @scure packages, all of
// which end up in the bundles, and a hand-written list missed every one of
// them. So this asks esbuild what it actually put in.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The entry points build.mjs bundles, kept in step with it by this comment. */
const ENTRIES = [
  'src/background/index.js',
  'src/isolated/content.js',
  'src/main/index.js',
  'src/popup/popup.js',
  'src/panel/panel.js',
];

async function bundledPackages() {
  const out = await build({
    entryPoints: ENTRIES.map((f) => resolve(ROOT, f)),
    outdir: resolve(ROOT, 'node_modules/.cache/licence-check'),
    bundle: true,
    format: 'esm',
    target: 'chrome114',
    platform: 'browser',
    write: false,
    metafile: true,
    logLevel: 'silent',
    define: { __LIMIL_BUILD__: '"licence-check"' },
  });
  const names = new Set();
  for (const input of Object.keys(out.metafile.inputs)) {
    const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

test('every bundled package has its licence in the extension folder', async () => {
  const shipped = readdirSync(resolve(ROOT, 'extension/licenses'));
  const notices = readFileSync(resolve(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const packages = await bundledPackages();

  assert.ok(packages.length > 0, 'the bundles should contain third-party code at all');
  for (const name of packages) {
    const file = `MIT-${name.replace('@', '').replace('/', '-')}.txt`;
    assert.ok(
      shipped.includes(file),
      `${name} is in the bundles but extension/licenses/${file} is missing; copy it from node_modules/${name}`,
    );
    assert.ok(notices.includes(name), `${name} is in the bundles but not named in THIRD_PARTY_NOTICES.md`);
  }
});

test('the project and font licences travel too', () => {
  const shipped = readdirSync(resolve(ROOT, 'extension/licenses'));
  for (const file of ['LICENSE-limil.txt', 'OFL-Manrope.txt', 'OFL-JetBrainsMono.txt']) {
    assert.ok(shipped.includes(file), `extension/licenses/${file} is missing`);
  }
});
