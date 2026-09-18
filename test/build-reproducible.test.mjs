// The same source must give the same bytes: two builds with the same
// SOURCE_DATE_EPOCH are compared file by file. Anything a store reviewer or a
// self-hoster rebuilds has to match what was published.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function buildInto(dir) {
  execFileSync(process.execPath, ['build.mjs'], {
    env: { ...process.env, LIMIL_OUTDIR: dir, SOURCE_DATE_EPOCH: '1700000000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function digests(dir, prefix = '') {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, digests(p, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return out;
}

test('two builds of the same source with the same SOURCE_DATE_EPOCH are byte-identical', () => {
  const a = mkdtempSync(join(tmpdir(), 'limil-build-a-'));
  const b = mkdtempSync(join(tmpdir(), 'limil-build-b-'));
  try {
    buildInto(a);
    buildInto(b);
    const da = digests(a);
    const db = digests(b);
    assert.ok(Object.keys(da).length >= 5, 'the build wrote the bundles');
    assert.deepEqual(da, db);
    const stamp = JSON.parse(readFileSync(join(a, 'build.json'), 'utf8')).stamp;
    assert.equal(stamp, '2023-11-14 22:13:20', 'the stamp is the given epoch, not the wall clock');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
