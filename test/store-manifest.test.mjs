// The manifest that goes to the Chrome Web Store is derived from the one the
// unpacked build uses. What the store would refuse or question must not be in
// it: the fixed key, a plain-http host, an unused permission.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { storeManifest, storeProblems } from '../scripts/pack-store.mjs';

const unpacked = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('the unpacked manifest carries the key and the docker hub address, nothing else the store dislikes', () => {
  assert.ok(unpacked.key, 'the fixed id is for the managed policy on the server');
  assert.ok(unpacked.host_permissions.includes('http://daemon:8787/*'));
  assert.deepEqual(storeProblems(unpacked).sort(), ['a key field', 'a plain-http host permission (http://daemon:8787/*)']);
});

test('the store manifest drops exactly those two and keeps everything else', () => {
  const store = storeManifest(unpacked);
  assert.equal(store.key, undefined);
  assert.equal(store['//key'], undefined);
  assert.equal(store.host_permissions.includes('http://daemon:8787/*'), false);
  assert.deepEqual(storeProblems(store), []);
  assert.deepEqual(store.permissions, unpacked.permissions);
  assert.deepEqual(store.content_scripts, unpacked.content_scripts);
  assert.deepEqual(store.optional_host_permissions, unpacked.optional_host_permissions);
  assert.equal(store.host_permissions.length, unpacked.host_permissions.length - 1);
});

test('the optional origin pattern is there for the hub pairing, and only https and http', () => {
  assert.deepEqual(unpacked.optional_host_permissions, ['https://*/*', 'http://*/*']);
});

test('activeTab is not declared: nothing in the code uses it', () => {
  assert.equal(unpacked.permissions.includes('activeTab'), false);
});
