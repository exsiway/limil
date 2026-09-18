// The pair command the popup hands out is built from a value the hub sent.
//
// `bash scripts/pair-runner.sh '<pairing>'` is pasted into a terminal by the
// person. The hub is their own box, but the value still crosses into a shell
// line, and a single quote followed by `$(...)` inside it would run there. So
// the line is rendered only from a value that parses as a pairing and carries
// none of the characters a shell reads specially; anything else leaves the
// field empty rather than rendering a command with a hole in it.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shellSafePairing } from '../src/shared/daemon-api.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a well-formed pairing string is returned as it is', () => {
  const ok = 'http://10.0.0.7:8787#abcdefghijklmnop_-Z9';
  assert.equal(shellSafePairing(ok), ok);
  assert.equal(shellSafePairing('https://box.example.com:8787#abcdefghijklmnop'), 'https://box.example.com:8787#abcdefghijklmnop');
});

test('a string that does not parse as a pairing is not rendered', () => {
  assert.equal(shellSafePairing('nothing here'), null);
  assert.equal(shellSafePairing('http://10.0.0.7:8787#short'), null);
  assert.equal(shellSafePairing(''), null);
  assert.equal(shellSafePairing(null), null);
  assert.equal(shellSafePairing(undefined), null);
});

test('shell metacharacters refuse the whole string even where parsePairing would forgive them', () => {
  // parsePairing trims, so leading and trailing whitespace passes it; a shell
  // line must not carry it. The token alphabet already excludes quotes and
  // dollars, but the URL half is only required to parse as a URL.
  for (const bad of [
    " http://10.0.0.7:8787#abcdefghijklmnop",
    "http://10.0.0.7:8787#abcdefghijklmnop\n",
    "http://10.0.0.7:8787#abcdefghijklmnop ",
    "http://'$(id)'@10.0.0.7:8787#abcdefghijklmnop",
    'http://"x"@10.0.0.7:8787#abcdefghijklmnop',
    'http://a\\b@10.0.0.7:8787#abcdefghijklmnop',
    'http://$HOME@10.0.0.7:8787#abcdefghijklmnop',
    'http://`id`@10.0.0.7:8787#abcdefghijklmnop',
  ]) {
    assert.equal(shellSafePairing(bad), null, JSON.stringify(bad));
  }
});

test('the popup renders the pair line through the validator and from nothing else', () => {
  const js = readFileSync(join(root, 'src/popup/popup.js'), 'utf8');
  const lines = js.split('\n').filter((l) => l.includes('pair-runner.sh'));
  assert.equal(lines.length, 1, 'one place builds the command');
  assert.match(lines[0], /shellSafePairing\(/, 'the value goes through the validator');
  assert.doesNotMatch(lines[0], /\$\{r\??\.pairing\}/, 'the raw hub value is not interpolated');
});
