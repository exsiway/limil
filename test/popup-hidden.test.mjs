// `hidden` in the popup must actually hide.
//
// The attribute is honoured by the BROWSER's own stylesheet, and any author
// rule that sets `display` on the same element wins over it, author styles
// beat the user agent's whatever their specificity. `.field { display: block }`
// therefore kept a hidden block visible however carefully popup.js set
// `hidden`, which is exactly what happened once: the code was right, the
// interface disagreed, and the bug looked like a logic error for a while.
//
// So the stylesheet has to say it once, globally and with `!important`. This
// test fails if that rule is dropped, or if someone adds a `display` rule to a
// class that a hidden element in popup.html actually uses without it.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/popup/popup.css', 'utf8');
const html = readFileSync('src/popup/popup.html', 'utf8');

test('the stylesheet makes the hidden attribute authoritative', () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'popup.css must override the browser rule for [hidden] globally');
});

test('every class on a hidden element is covered by that rule', () => {
  // Elements that carry the attribute, with the classes they wear.
  const hiddenTags = [...html.matchAll(/<[a-z]+[^>]*\shidden(?:\s|>)[^>]*>/gi)].map((m) => m[0]);
  assert.ok(hiddenTags.length >= 6, `expected the popup to hide several blocks, found ${hiddenTags.length}`);
  const classes = new Set();
  for (const tag of hiddenTags) {
    const cls = /class="([^"]+)"/.exec(tag);
    for (const c of (cls?.[1] ?? '').split(/\s+/).filter(Boolean)) classes.add(c);
  }
  // Some of them set `display` of their own, and are hidden only because of
  // the global rule above. Listing them here is the point: a new one
  // appearing is a signal to check that it hides, not a reason to edit this
  // line without looking.
  const withDisplay = [...classes].filter((c) => new RegExp(`^\\.${c}\\s*\\{[^}]*display:`, 'm').test(css)).sort();
  assert.ok(classes.has('field'), 'the pairing fields still wear the class that started this');
  assert.deepEqual(withDisplay, ['field'], 'a new class with a display rule needs checking against [hidden]');
});
