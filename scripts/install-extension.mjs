// Builds the extension and lays it out into THE folder Chrome has loaded as an
// unpacked extension. What remains is one click: ⟳ on the extension card.
//
//   npm run ext                          macOS, Linux, Windows alike
//   LIMIL_EXT_DIR=/path npm run ext    when the folder is elsewhere
//
// Why a separate folder and not extension/ from the repository. Chrome loads
// an unpacked extension by path and derives its id from that path, and the
// storage, orders and the PRIVATE part of the session key, is bound to the
// id. So the target path is never chosen anew or renamed: the files inside it
// are replaced in place. Loading the repository's extension/ as a second
// unpacked extension would mean a new id, empty storage, a lost key and an
// orphaned on-chain grant.
//
// The version is stamped here, not in the repository: manifest.json in git
// carries only the release number (its `version` field) and never a build
// number, otherwise every build would leave a version diff. The stamp appends
// the commit count to that number and makes "did it pick up the new build"
// answerable from the extension card: build number, commit and time.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
function defaultTarget() {
  const desktop = join(homedir(), 'Desktop', 'limil-ext');
  if (existsSync(join(homedir(), 'Desktop'))) return desktop;
  return join(homedir(), 'limil-ext');
}
const target = resolve(process.env.LIMIL_EXT_DIR ?? defaultTarget());

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(2);
}

function git(...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// 1. Build, in its own process so an esbuild failure stops the layout too:
//    laying out half a build is worse than laying out nothing.
const built = spawnSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' });
if (built.status !== 0) die('build failed, nothing was copied to the extension folder');

// 2. Make sure the target really is our extension and not a random folder:
//    the script removes stale files there, and a wrong path is expensive.
if (!existsSync(target)) {
  die(`folder ${target} does not exist.\n`
    + '  Create it and load it once through chrome://extensions -> "Load unpacked",\n'
    + '  or point at the real one: LIMIL_EXT_DIR=/path npm run ext');
}
const targetManifest = join(target, 'manifest.json');
if (!existsSync(targetManifest)) die(`no manifest.json in ${target}, not an extension folder`);
const existing = JSON.parse(await readFile(targetManifest, 'utf8'));
// The name is localised through _locales; older installs carry the literal.
if (!['limil', '__MSG_extName__'].includes(existing.name)) {
  die(`${target} holds the extension "${existing.name}", not limil, leaving it alone`);
}

// 3. Version stamp. The commit count is monotonic and fits a Chrome version
//    component (max 65535); uncommitted changes are named as such, otherwise
//    the build number would promise more than it contains.
const count = git('rev-list', '--count', 'HEAD') || '0';
const sha = git('rev-parse', '--short', 'HEAD') || 'nogit';
const dirty = git('status', '--porcelain') ? ' +local changes' : '';
const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
const base = manifest.version;
manifest.version = `${base}.${count}`;
manifest.version_name = `${base}.${count} (${sha}, ${stamp} UTC${dirty})`;

// 4. Layout. Files are replaced INSIDE the existing folder: the folder itself
//    is neither recreated nor renamed, the storage depends on its path.
async function syncDir(from, to) {
  await mkdir(to, { recursive: true });
  const wanted = new Set();
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    wanted.add(entry.name);
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) await syncDir(src, dst);
    else await cp(src, dst);
  }
  // Stale files go: a bundle that is no longer built must not execute.
  // Listing the target directory may be forbidden even when reading and
  // writing files in it is allowed (a sandbox that restricts traversal);
  // that must not fail the layout, the files are already in place.
  try {
    for (const entry of await readdir(to, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || wanted.has(entry.name)) continue;
      await rm(join(to, entry.name), { recursive: true, force: true });
    }
  } catch (err) {
    console.log(`  ! cannot list ${to} (${err.code}), stale files were not removed`);
  }
}
await syncDir(source, target);
await writeFile(targetManifest, `${JSON.stringify(manifest, null, 2)}\n`);

// 5. Report on what IS THERE, not on what was built: the build stamp is read
//    back from the laid-out bundle.
const bundle = await readFile(join(target, 'dist/content.js'), 'utf8');
const marks = [...new Set([...bundle.matchAll(/"(20\d\d-\d\d-\d\d \d\d:\d\d:\d\d)"/g)].map((m) => m[1]))];
const size = (await stat(join(target, 'dist/background.js'))).size;

console.log(`\n  laid out in      ${target}`);
console.log(`  version          ${manifest.version_name}`);
console.log(`  bundle stamp     ${marks.join(', ') || 'not found'}`);
console.log(`  background.js    ${size} bytes`);
console.log('\n  One click left: chrome://extensions -> limil -> ⟳, then reload the FOMO tab.');
console.log('  The extension card shows the new version once it has picked the build up.\n');
