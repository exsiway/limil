// The feed mirror puts other people's content into an extension page and
// lets that page press the quick-buy buttons on the FOMO tab. Checked
// statically here, because both sides need a DOM to run:
//
//   1. The port is accepted from a page of this extension only; a content
//      script (which shares a tab with the page) cannot open it.
//   2. A press from the panel goes through feedBuy.press, which refuses any
//      element it did not mount itself; the click command never touches the
//      quick-buy row.
//   3. Every command is bounded to the block: nodeOf() checks the root.
//   4. The panel builds nodes, it never parses markup.
//   5. The manifest and the build know the panel.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromExtensionPage } from '../src/isolated/feed-mirror.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mirrorSrc = readFileSync(join(root, 'src/isolated/feed-mirror.js'), 'utf8');
const buySrc = readFileSync(join(root, 'src/isolated/feed-buy.js'), 'utf8');
const panelSrc = readFileSync(join(root, 'src/panel/panel.js'), 'utf8');
const treeSrc = readFileSync(join(root, 'src/shared/mirror-tree.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
const build = readFileSync(join(root, 'build.mjs'), 'utf8');

const ME = { runtimeId: 'abc', baseUrl: 'chrome-extension://abc/' };

test('the port is accepted from a page of this extension and from nothing else', () => {
  // What Chrome actually sends for a connection from an extension page: id and origin.
  assert.equal(fromExtensionPage({ id: 'abc', origin: 'chrome-extension://abc' }, ME), true);
  assert.equal(fromExtensionPage({ id: 'abc', url: 'chrome-extension://abc/dist/panel.html' }, ME), true, 'older shape, url only');
  assert.equal(fromExtensionPage({ id: 'abc', origin: 'chrome-extension://abc', tab: { id: 1 } }, ME), true, 'the panel page shown as a tab');
  assert.equal(fromExtensionPage({ id: 'abc', origin: 'https://fomo.family', url: 'https://fomo.family/', tab: { id: 1 } }, ME), false, 'a content script');
  assert.equal(fromExtensionPage({ id: 'abc', origin: 'chrome-extension://abcd' }, ME), false, 'a longer id');
  assert.equal(fromExtensionPage({ id: 'abc', url: 'https://fomo.family/chrome-extension://abc/' }, ME), false);
  assert.equal(fromExtensionPage({ id: 'xyz', origin: 'chrome-extension://xyz' }, ME), false, 'another extension');
  assert.equal(fromExtensionPage({ id: 'abc' }, ME), false, 'neither origin nor url');
  assert.equal(fromExtensionPage(null, ME), false);
});

test('a connection that is not from an extension page is closed before anything is sent', () => {
  const install = mirrorSrc.slice(mirrorSrc.indexOf('export function install('));
  assert.match(install, /if \(!fromExtensionPage\(port\.sender, \{ runtimeId: chrome\.runtime\.id, baseUrl: chrome\.runtime\.getURL\(''\) \}\)\) \{\s*port\.disconnect\(\);\s*return;/);
  assert.ok(install.indexOf('port.disconnect()') < install.indexOf('state.ports.add(port)'));
});

test('a press from the panel is feedBuy.press and nothing else; the click command skips the quick-buy row', () => {
  const buy = mirrorSrc.slice(mirrorSrc.indexOf('  buy({ i })'), mirrorSrc.indexOf('  refresh('));
  assert.match(buy, /return feedBuy\.press\(node\);/);
  assert.doesNotMatch(buy, /\.click\(/);
  const click = mirrorSrc.slice(mirrorSrc.indexOf('  click({ i })'), mirrorSrc.indexOf('  scroll('));
  assert.match(click, /if \(node\.closest\('\.lc-feedbuy'\)\) return false;/);
  assert.match(click, /if \(!state\.root\.contains\(target\)\) return false;/);
});

test('press() refuses an element the module did not mount, and the real click still checks isTrusted first', () => {
  const press = buySrc.slice(buySrc.indexOf('export function press('), buySrc.indexOf('// --------------------------------------------------------------------- buy'));
  assert.match(press, /const m = meta\.get\(button\);\s*if \(!m \|\| !button\.isConnected\) return false;/);
  const handler = buySrc.slice(buySrc.indexOf("button.addEventListener('click'"), buySrc.indexOf('row.append(button)'));
  assert.match(handler, /if \(ev\.isTrusted === false\) return;\s*press\(button\);/);
  assert.equal([...buySrc.matchAll(/meta\.set\(/g)].length, 1, 'buttons are registered in one place');
});

test('every command resolves its node through nodeOf, which requires the node to be inside the block', () => {
  const nodeOf = mirrorSrc.slice(mirrorSrc.indexOf('function nodeOf('), mirrorSrc.indexOf('/** The commands'));
  assert.match(nodeOf, /!state\.root\.contains\(node\)/);
  for (const cmd of ['click', 'scroll', 'buy']) {
    const body = mirrorSrc.slice(mirrorSrc.indexOf(`  ${cmd}({`));
    assert.match(body.slice(0, 200), /const node = nodeOf\(i\);/, `${cmd} goes through nodeOf`);
  }
});

test('neither side parses markup', () => {
  for (const [name, src] of [['panel.js', panelSrc], ['mirror-tree.js', treeSrc], ['feed-mirror.js', mirrorSrc]]) {
    // The comments name the thing that must not happen; the code must not do it.
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|new DOMParser|createContextualFragment\(/, `${name} builds nodes, it does not parse`);
  }
  assert.match(treeSrc, /doc\.createTextNode\(tree\.x\)/);
  assert.match(treeSrc, /doc\.createElement\(tree\.t\)/);
});

test('the panel filters attributes again on apply', () => {
  const build = treeSrc.slice(treeSrc.indexOf('function build(tree)'), treeSrc.indexOf('function drop('));
  assert.match(build, /const v = safeAttr\(tree\.t, name, value\);\s*if \(v !== null\) node\.setAttribute\(name, v\);/);
  const apply = treeSrc.slice(treeSrc.indexOf('function apply(ops)'), treeSrc.indexOf('function idOf('));
  assert.match(apply, /safeAttr\(tag, op\.k, op\.v\)/);
});

test('the manifest declares the panel, and the build bundles it', () => {
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.side_panel?.default_path, 'dist/panel.html');
  assert.match(build, /panel: 'src\/panel\/panel\.js'/);
  assert.match(build, /\['panel\.html', 'panel\.css'\]/);
  // No new host: the panel reads a FOMO tab, it does not read sites.
  assert.equal(manifest.content_scripts.every((cs) => cs.matches.every((m) => /fomo\.family/.test(m))), true);
  assert.equal(manifest.host_permissions.some((h) => /<all_urls>|^https?:\/\/\*\/\*$/.test(h)), false);
});

test('the panel script is whole: an emptied file must not build into a blank panel', () => {
  assert.ok(panelSrc.length > 8000, `panel.js is ${panelSrc.length} bytes`);
  for (const mark of ['createMirror(', 'function relayout(', 'function updateShelf(', 'function copyOf(', 'chrome.tabs.connect(', "addEventListener('click'"]) {
    assert.ok(panelSrc.includes(mark), `panel.js carries ${mark}`);
  }
});
