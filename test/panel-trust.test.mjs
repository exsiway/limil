// The order panel sits in the page's DOM, and the MAIN world runs in the
// page's realm. Two things follow, and both are checked statically here
// because the panel needs a DOM to run:
//
//   1. Balances PUSHED from the page (`fomoBalances`) may refresh the numbers
//      on screen and nothing more. Cancelling orders and learning the wallet
//      addresses happen only on balances the ISOLATED world asked for itself.
//      A page script that pushed a document with zero rows once could have
//      cancelled every order in one message.
//   2. Every control drops synthetic events, and place() reads the fields back
//      against the form before it quotes: a script that sets amount 100 and
//      target 0 and waits for one real click gains nothing.
//
// Also here: the context is dropped the moment the URL changes, and the
// warning mark's tooltip is wired to something that can show it.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'src/isolated/limit-ui.js'), 'utf8');
const content = readFileSync(join(root, 'src/isolated/content.js'), 'utf8');

/** The body of a top-level function, by name; enough for a regex to look at. */
function bodyOf(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `${signature} is still there`);
  const rest = source.slice(at);
  const end = rest.search(/\n}\n/);
  return rest.slice(0, end + 2);
}

test('orders are retired only from balances the isolated world polled itself', () => {
  const calls = [...ui.matchAll(/retireSoldOrders\(/g)].length;
  assert.equal(calls, 2, 'one definition and exactly one call');
  const apply = bodyOf(ui, 'export function applyBalances(');
  assert.match(apply, /const trusted = hint\.source === 'poll';/);
  assert.match(apply, /if \(trusted\) retireSoldOrders\(balances\);/, 'the one call is behind the flag');
  assert.doesNotMatch(apply.replace(/if \(trusted\) retireSoldOrders\(balances\);/, ''), /retireSoldOrders\(/);
});

test('the wallet addresses come from polled balances only', () => {
  const apply = bodyOf(ui, 'export function applyBalances(');
  assert.match(apply, /sender: \(trusted \? wallets\.evm : null\)/);
  assert.match(apply, /solanaAddress: \(trusted \? wallets\.solana : null\)/);
});

test('the pushed path carries no source, the poll does', () => {
  const pushed = bodyOf(content, 'fomoBalances: (json) =>');
  assert.match(pushed, /limitUi\.applyBalances\(json\)/);
  assert.doesNotMatch(content, /source: 'poll'/, 'content.js never claims the poll source');
  const refresh = bodyOf(ui, 'export async function refreshContext(');
  assert.match(refresh, /applyBalances\(balances, \{ address, uuid, source: 'poll' \}\)/);
});

test('every panel control drops synthetic events', () => {
  // Handlers are attached as on<event> props; each must be wrapped in real(),
  // except the "?" button whose click does nothing but preventDefault.
  const handlers = [...ui.matchAll(/\bon(click|input|change): (?!real\()([^\n]*)/g)];
  const unwrapped = handlers.map((m) => m[2].trim());
  assert.deepEqual(unwrapped, ['(ev) => ev.preventDefault(),'], `unwrapped handlers: ${unwrapped.join(' | ')}`);
  assert.match(bodyOf(ui, 'function real(handler)'), /isTrusted === false\) return;/);
});

test('place() reads the fields back against the form before it quotes', () => {
  const place = bodyOf(ui, 'async function place()');
  const drift = place.indexOf('fieldDrift()');
  const quote = place.indexOf("callMain('fomo.quote'");
  assert.ok(drift >= 0 && quote > drift, 'the comparison comes before the quote');
  assert.match(place.slice(drift, quote), /if \(drift\) \{[\s\S]*return;/, 'a difference refuses');
  const check = bodyOf(ui, 'function fieldDrift()');
  for (const field of ['.lc-amount', '#lc-target-number', '.lc-slip-input', '.lc-seg button.sell']) {
    assert.ok(check.includes(field), `${field} is compared`);
  }
});

test('the context is dropped synchronously when the URL changes', () => {
  const at = ui.indexOf('if (location.href !== lastUrl) {');
  assert.ok(at >= 0);
  const block = ui.slice(at, ui.indexOf('refreshContext()', at));
  assert.match(block, /state\.context = null;\s*\n\s*render\(\);/, 'null and redraw before the refresh is even scheduled');
});

test('the warning mark has a tooltip that can be shown', () => {
  const mark = bodyOf(ui, 'function warningMark(');
  assert.match(mark, /attachTooltip\(row, tip\)/);
});
