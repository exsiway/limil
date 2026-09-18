// Extension build: three bundles (MAIN world, ISOLATED world, service worker)
// plus the popup, the side panel and their static files. Output goes to extension/dist/, which
// is not tracked by git.
import { build, context } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
// LIMIL_OUTDIR points a build elsewhere (the reproducibility test builds twice side by side).
const outdir = process.env.LIMIL_OUTDIR ? resolve(process.env.LIMIL_OUTDIR) : resolve(root, 'extension/dist');

const entries = {
  'main-world': 'src/main/index.js',
  content: 'src/isolated/content.js',
  background: 'src/background/index.js',
  popup: 'src/popup/popup.js',
  panel: 'src/panel/panel.js',
};

/**
 * Build stamp compiled into EVERY bundle.
 *
 * The manifest version describes the service worker. Content scripts live in
 * the tab and are replaced only when the tab reloads, so an updated extension
 * and a stale tab look identical from the outside. The stamp belongs to the
 * code that is actually executing, and the content script reports it over the
 * bus (`ui.build`).
 */
// A release build is reproducible: with SOURCE_DATE_EPOCH set, or with a clean
// git tree, the stamp is that time (the commit's) rather than the wall clock, so
// the same source gives the same bytes. A dirty tree or a --dev/--watch build
// stamps the wall clock, so the self-update check still sees every rebuild as
// new while developing.
function buildStamp() {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return iso(Number(epoch) * 1000);
  const wallClock = process.argv.includes('--watch') || process.argv.includes('--dev');
  if (!wallClock) {
    try {
      const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const dirty = git(['status', '--porcelain']);
      const commit = git(['show', '-s', '--format=%ct', 'HEAD']);
      if (!dirty && /^\d+$/.test(commit)) return iso(Number(commit) * 1000);
    } catch { /* not a git checkout: the wall clock */ }
  }
  return iso(Date.now());
}
const BUILD_STAMP = buildStamp();

/**
 * Source maps only while developing (`--watch` or `--dev`). Inlined, they
 * tripled every bundle (background.js 2.2 MB instead of 560 KB) and every
 * FOMO tab parsed that on load; a release ships the code alone. The bundle
 * stays unminified: the extension is open source and its stack traces are
 * meant to be readable as they are.
 */
const dev = process.argv.includes('--watch') || process.argv.includes('--dev');

/**
 * The two bundles that are INJECTED INTO A PAGE, and the three that are not.
 *
 * A content script is loaded as a classic script, not as a module, so every
 * top-level declaration in it becomes a property of the page's `window`. As
 * modules these two put `syncOrders`, `calibrate`, `levels`, `live` and the
 * rest within reach of anything else running on fomo.family: a script there
 * could read the orders being watched or move the level the watcher nudges
 * on. Wrapped in a function by the `iife` format, they leak nothing.
 *
 * The other three are loaded as real modules, by the manifest for the worker
 * and by `<script type="module">` for the popup and the panel, and have their
 * own scope already.
 */
const INJECTED = ['main-world', 'content'];

const common = {
  outdir,
  bundle: true,
  target: 'chrome114',
  platform: 'browser',
  sourcemap: dev ? 'inline' : false,
  // The dictionaries are the largest part of every bundle. Left as UTF-8 they
  // are a third of the size esbuild's default `\uXXXX` escaping makes them.
  charset: 'utf8',
  logLevel: 'info',
  define: { __LIMIL_BUILD__: JSON.stringify(BUILD_STAMP) },
};

const pointsFor = (names) => Object.fromEntries(
  Object.entries(entries)
    .filter(([name]) => names.includes(name))
    .map(([name, file]) => [name, resolve(root, file)]),
);

const builds = [
  { ...common, format: 'iife', entryPoints: pointsFor(INJECTED) },
  { ...common, format: 'esm', entryPoints: pointsFor(Object.keys(entries).filter((n) => !INJECTED.includes(n))) },
];

// Popup and side-panel static files go next to the bundles so everything
// generated lives in one directory, extension/dist, which git ignores.
async function copyStatic() {
  for (const file of ['popup.html', 'popup.css']) {
    await cp(resolve(root, 'src/popup', file), resolve(outdir, file));
  }
  for (const file of ['panel.html', 'panel.css']) {
    await cp(resolve(root, 'src/panel', file), resolve(outdir, file));
  }
  // The stamp on disk: the running extension compares it with its own and
  // reloads itself when a newer build has been written (background/selfupdate.js).
  await writeFile(resolve(outdir, 'build.json'), `${JSON.stringify({ stamp: BUILD_STAMP })}\n`);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (process.argv.includes('--watch')) {
  for (const options of builds) {
    const ctx = await context(options);
    await ctx.watch();
  }
  await copyStatic();
  console.log('watch: rebuilding on changes under src/');
} else {
  for (const options of builds) await build(options);
  await copyStatic();
  console.log('done: extension/ can be loaded unpacked');
}
