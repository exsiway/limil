// Packs the extension for the Chrome Web Store.
//
//   npm run pack:store            -> release/limil-<version>.zip
//
// The repository's extension/manifest.json is the manifest of the UNPACKED
// build: the one the laptop loads from a folder and the one the runner
// browser on the server loads from a bind mount. Two of its entries exist only
// for that build and have no place in a store package:
//
//   key                    fixes the extension id so a Chromium managed policy
//                          on the server can address the extension. The store
//                          assigns its own id from the developer account.
//   http://daemon:8787/*   the hub's address inside the docker stack, where
//                          the runner browser pairs without a permission
//                          prompt. A store install pairs its hub through the
//                          optional origin permission like any other address.
//
// Everything else is the same code. The zip is built from extension/ after
// `npm run build`, so run that first (this script does when dist/ is missing).

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Entries that belong to the unpacked build only. */
const UNPACKED_HOSTS = ['http://daemon:8787/*'];

/**
 * The store manifest, derived from the unpacked one. Pure, for the test.
 *
 * @param {object} manifest the parsed extension/manifest.json
 * @returns {object} a new manifest object
 */
export function storeManifest(manifest) {
  const out = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k === 'key' || k === '//key') continue;
    out[k] = v;
  }
  out.host_permissions = (manifest.host_permissions ?? []).filter((h) => !UNPACKED_HOSTS.includes(h));
  const problems = storeProblems(out);
  if (problems.length) throw new Error(`the manifest is not fit for the store: ${problems.join('; ')}`);
  return out;
}

/** What a reviewer would refuse or question, as a list of reasons; empty when clean. */
export function storeProblems(manifest) {
  const problems = [];
  if (manifest.key) problems.push('a key field');
  const perms = manifest.permissions ?? [];
  if (perms.includes('activeTab')) problems.push('activeTab is declared but unused');
  const hosts = manifest.host_permissions ?? [];
  for (const h of hosts) {
    if (h.startsWith('http://')) problems.push(`a plain-http host permission (${h})`);
    if (/\*:\/\/\*\/|<all_urls>|^https?:\/\/\*\/\*$/.test(h)) problems.push(`a broad host permission (${h})`);
  }
  if (manifest.manifest_version !== 3) problems.push('not manifest v3');
  return problems;
}

async function main() {
  const src = join(root, 'extension');
  if (!existsSync(join(src, 'dist', 'background.js'))) {
    const build = spawnSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
  const store = storeManifest(manifest);
  const version = store.version;
  const release = join(root, 'release');
  const stage = join(release, 'store');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await cp(src, stage, {
    recursive: true,
    // The build stamp file is for the unpacked build's self-update check.
    filter: (p) => !p.endsWith('.DS_Store') && !p.endsWith(join('dist', 'build.json')),
  });
  await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(store, null, 2)}\n`);
  const zipName = `limil-${version}.zip`;
  await rm(join(release, zipName), { force: true });
  const zip = spawnSync('zip', ['-qr', join('..', zipName), '.'], { cwd: stage, stdio: 'inherit' });
  if (zip.status !== 0) { console.error('zip failed; is the zip tool installed?'); process.exit(zip.status ?? 1); }
  console.log(`\n  release/${zipName}`);
  console.log(`  manifest: no key, hosts ${store.host_permissions.length}, permissions ${store.permissions.join(', ')}`);
  console.log('  Upload this file in the Chrome Web Store developer dashboard; the listing texts are in docs/STORE-LISTING.md.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
