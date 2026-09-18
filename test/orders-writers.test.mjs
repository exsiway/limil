// One place writes the order list. Not two, not four.
//
// Every change to the list is a read, a change and a write with awaits in
// between, and four subsystems change it: the panel adds and cancels, the
// runner closes what it filled, the daemon applies the hub's verdicts, the
// mirror merges the hub's list. For a while a queue held only the first of
// those, so the other three could still land a write on top of an array read
// before someone else's change. Losing a cancel means selling what the user
// said not to sell; losing a verdict means selling it twice.
//
// A queue is only worth anything if nothing goes around it, and going around
// it is one plain line of code, `chrome.storage.local.set({ orders })`,
// which is exactly what the four writers looked like before. So the rule is
// checked here as a rule, against the source, rather than being left to
// whoever adds the fifth writer.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const STORE = join('background', 'orders-store.js');

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('nothing outside the store writes the order list', () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    if (file.endsWith(STORE)) continue;
    const text = readFileSync(file, 'utf8');
    const re = /storage\.local\.set\(/g;
    let m;
    while ((m = re.exec(text))) {
      // The argument, near enough: a write of this key names it within a line.
      const arg = text.slice(m.index, m.index + 120);
      if (/\borders\b/.test(arg)) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${arg.split('\n')[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `the order list must be written through mutateOrders:\n${offenders.join('\n')}`);
});

test('and everyone who changes it goes through the queue', () => {
  const writers = ['background/index.js', 'background/runner.js', 'background/daemon.js', 'background/mirror.js'];
  for (const rel of writers) {
    const text = readFileSync(join(SRC, rel), 'utf8');
    assert.match(text, /from '\.\/orders-store\.js'/, `${rel} does not use the shared store`);
    assert.match(text, /mutateOrders\(/, `${rel} imports the store but changes the list some other way`);
  }
});
