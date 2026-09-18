// Every locale file parses.
//
// A stray apostrophe inside a single-quoted string, "FOMO's", "server's",
// makes the file a syntax error, and because everything imports i18n, ONE of
// them takes the entire suite down: sixty-two failures pointing everywhere
// except at the line that caused them. It happened three times in one night
// while rewriting help texts.
//
// This is the cheapest possible guard: import each file and see that it is a
// table of strings.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src', 'locales');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));

test('there are locales to check', () => {
  assert.ok(files.length >= 7, `expected the seven languages, found ${files.length}`);
});

for (const file of files) {
  test(`${file} parses and is a table of strings`, async () => {
    const mod = await import(join(dir, file));
    const table = mod.default ?? mod.messages ?? mod;
    const keys = Object.keys(table).filter((k) => k !== 'default');
    assert.ok(keys.length > 50, `${file} has only ${keys.length} keys`);
    for (const k of keys) {
      assert.equal(typeof table[k], 'string', `${file}: ${k} is not a string`);
    }
  });
}

// The manifest's own strings live apart from the dictionaries, one JSON file
// per language under extension/_locales. Chrome refuses to load the extension
// when one of them does not parse or lacks a key the manifest names, and it
// says so only at install time, not in any test. So they are parsed here too.
const manifestDir = join(root, 'extension', '_locales');
const manifestLocales = readdirSync(manifestDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test('there is a manifest locale for every dictionary', () => {
  const codes = files.map((f) => f.replace(/\.js$/, '')).sort();
  assert.deepEqual(manifestLocales.sort(), codes);
});

for (const code of manifestLocales) {
  test(`extension/_locales/${code}/messages.json parses and names the extension`, () => {
    const table = JSON.parse(readFileSync(join(manifestDir, code, 'messages.json'), 'utf8'));
    for (const key of ['extName', 'extDesc']) {
      assert.equal(typeof table[key]?.message, 'string', `${code}: ${key} is missing`);
      assert.ok(table[key].message.trim().length > 0, `${code}: ${key} is empty`);
    }
  });
}
