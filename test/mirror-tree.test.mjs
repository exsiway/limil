// The feed mirror carries other people's content into an extension page.
// What crosses is a value: tags, allow-listed attributes, text. Checked here
// on a fake DOM: the filter on the way in, the rebuild on the way out, and
// the deltas in between.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { cardKeyText, attrCrossesEver, createMirror, mutationsToOps, safeAttr, safeStyle, serializeNode,
} from '../src/shared/mirror-tree.js';
import {
  FakeDocument, attrRecord, childListRecord, el, textRecord,
} from './helpers/fake-dom.mjs';

/** An id assigner the way the content script keeps one: a WeakMap and a counter. */
function ids() {
  const map = new WeakMap();
  let n = 0;
  return {
    idOf: (node) => {
      if (!map.has(node)) map.set(node, `n${n += 1}`);
      return map.get(node);
    },
    hasId: (node) => map.has(node),
    forget: (node) => map.delete(node),
  };
}

/** Serialises on one side and rebuilds on the other; returns both roots and the mirror. */
function roundTrip(spec) {
  const src = new FakeDocument();
  const page = el(src, spec);
  src.appendChild(page);
  const { idOf, hasId, forget } = ids();
  const tree = serializeNode(page, idOf);
  const dst = new FakeDocument();
  const host = dst.createElement('div');
  dst.appendChild(host);
  const mirror = createMirror(dst);
  const copy = mirror.snapshot(host, tree);
  return { src, page, dst, host, copy, mirror, idOf, hasId, forget };
}

test('a plain card crosses with its classes, text, image and inline style', () => {
  const { copy } = roundTrip(['div', { class: 'border-b border-bg-secondary', style: 'height: 24px; color: rgb(33, 201, 94);' },
    ['img', { src: 'https://token-media.defined.fi/1399811149_So111_small.png', alt: 'logo' }],
    ['span', { class: 'truncate' }, 'Pyro'],
    ['a', { href: '/tokens/robinhood/0xabc?tradeId=1' }, 'STONK'],
  ]);
  assert.equal(copy.outerHTML,
    '<div class="border-b border-bg-secondary" style="height: 24px; color: rgb(33, 201, 94);">'
    + '<img src="https://token-media.defined.fi/1399811149_So111_small.png" alt="logo"></img>'
    + '<span class="truncate">Pyro</span>'
    + '<a href="https://fomo.family/tokens/robinhood/0xabc?tradeId=1">STONK</a></div>');
});

test('every host the app draws a token logo from crosses', () => {
  // The panel drew empty circles for a week because these were not listed:
  // the profile picture beside each token came through and the token itself
  // did not. Taken from the running app, not from a guess.
  const hosts = [
    'https://metadata.mobula.io/assets/logos/evm_8453_0xb2000000.webp',
    'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
    'https://crypto-exchange-logos-production.s3.us-west-2.amazonaws.com/binance.png',
    'https://prod-fomo-profile-pics.s3.amazonaws.com/u/1.jpg',
    'https://token-media.defined.fi/1399811149_So111_small.png',
    'https://fomo.family/images/logo.svg',
  ];
  for (const src of hosts) {
    const { copy } = roundTrip(['div', {}, ['img', { src, alt: 'logo' }]]);
    assert.ok(copy.outerHTML.includes(`src="${src}"`), `${src} should cross, got ${copy.outerHTML}`);
  }
});

test('an image from anywhere else still does not cross', () => {
  const { copy } = roundTrip(['div', {}, ['img', { src: 'https://tracker.example/pixel.gif', alt: 'x' }]]);
  assert.ok(!copy.outerHTML.includes('tracker.example'), `a foreign host is still dropped, got ${copy.outerHTML}`);
});

test('scripts, handlers, ids, javascript: links, foreign images and url() styles do not cross', () => {
  const { copy } = roundTrip(['div', { id: 'x', onclick: 'steal()', 'data-discover': 'true' },
    ['script', {}, 'alert(1)'],
    ['iframe', { src: 'https://evil.example/' }],
    ['a', { href: 'javascript:alert(1)', onmouseover: 'x()' }, 'link'],
    ['a', { href: 'https://evil.example/phish' }, 'elsewhere'],
    ['img', { src: 'https://evil.example/track.gif', srcset: 'https://evil.example/a.png 2x' }],
    ['img', { src: 'https://prod-fomo-profile-pics.s3.amazonaws.com/u/1.png' }],
    ['span', { style: 'background: url(https://evil.example/x.png)' }, 'text'],
    ['span', { style: 'color: red; behavior: url(x.htc)' }, 'text'],
    ['input', { type: 'text', value: 'secret' }],
    ['style', {}, 'body{display:none}'],
  ]);
  assert.equal(copy.outerHTML,
    '<div>'
    + '<a>link</a>'
    + '<a>elsewhere</a>'
    + '<img></img>'
    + '<img src="https://prod-fomo-profile-pics.s3.amazonaws.com/u/1.png"></img>'
    + '<span>text</span>'
    + '<span>text</span>'
    + '</div>');
});

test('svg icons keep their namespace and geometry', () => {
  const { copy } = roundTrip(['svg', { viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    ['path', { d: 'M4 4h16', stroke: 'currentColor', 'stroke-width': '2' }],
    ['use', { href: '#sprite' }],
  ]);
  assert.equal(copy.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(copy.childNodes[0].namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(copy.outerHTML, '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h16" stroke="currentColor" stroke-width="2"></path></svg>');
});

test('the attribute filter, one case each', () => {
  assert.equal(safeAttr('div', 'class', 'a b'), 'a b');
  assert.equal(safeAttr('div', 'aria-label', 'x'), 'x');
  assert.equal(safeAttr('div', 'onclick', 'x'), null);
  assert.equal(safeAttr('div', 'id', 'x'), null);
  assert.equal(safeAttr('div', 'tabindex', '0'), null);
  assert.equal(safeAttr('img', 'src', '/logo.png'), 'https://fomo.family/logo.png');
  assert.equal(safeAttr('img', 'src', 'http://fomo.family/logo.png'), null, 'https only');
  assert.equal(safeAttr('img', 'src', 'data:image/png;base64,AAAA'), null);
  assert.equal(safeAttr('video', 'src', 'https://fomo.family/a.mp4'), null);
  assert.equal(safeAttr('a', 'href', 'https://fomo.family/tokens/x'), 'https://fomo.family/tokens/x');
  assert.equal(safeAttr('a', 'href', 'https://x.com/exsiway_'), null);
  assert.equal(safeAttr('div', 'href', 'https://fomo.family/'), null);
  assert.equal(safeAttr('div', 'style', 'x'.repeat(5000)), null);
  assert.equal(safeStyle('width: calc(100% - 8px); transform: translate(2px, 3px)'), 'width: calc(100% - 8px); transform: translate(2px, 3px)');
  assert.equal(safeStyle('background: image-set("a.png" 1x)'), null);
  assert.equal(safeStyle('content: "\\41"'), null);
  assert.equal(safeStyle('color: red; @import "x"'), null);
  assert.equal(attrCrossesEver('div', 'onload'), false);
  assert.equal(attrCrossesEver('div', 'style'), true);
  assert.equal(attrCrossesEver('span', 'src'), false);
  assert.equal(attrCrossesEver('img', 'src'), true);
  assert.equal(attrCrossesEver('div', 'data-discover'), false);
});

test('a childList change resends the parent as its list of children, new ones in full', () => {
  const rt = roundTrip(['ul', {}, ['li', {}, 'one'], ['li', {}, 'two']]);
  const { page, src, copy, mirror, idOf, hasId, forget } = rt;
  const [one, two] = page.childNodes;
  const oneId = idOf(one);
  // FOMO's virtualised lists reuse and reorder rows: two moves first, a
  // third appears, one leaves.
  page.removeChild(one);
  const three = el(src, ['li', { class: 'new' }, 'three']);
  page.insertBefore(three, two);
  page.insertBefore(two, three);
  const ops = mutationsToOps([
    childListRecord(page, { removed: [one] }),
    childListRecord(page, { added: [three] }),
    childListRecord(page, { added: [two] }),
  ], { idOf, hasId, forget });
  assert.equal(ops.length, 1, 'one op per changed parent, however many records');
  assert.equal(ops[0].op, 'kids');
  assert.deepEqual(ops[0].k, [idOf(two), idOf(three)]);
  assert.equal(ops[0].n.length, 1, 'only the new row travels in full');
  assert.equal(ops[0].n[0].t, 'li');
  mirror.apply(ops);
  assert.equal(copy.outerHTML, '<ul><li>two</li><li class="new">three</li></ul>');
  assert.equal(hasId(one), false, 'the removed row is forgotten by the sender');
  assert.equal(mirror.registry.has(oneId), false, 'and by the panel');
  assert.equal(mirror.registry.size, 5, 'ul, two li, two text nodes');
});

test('text and attribute changes travel as such, and a filtered value becomes a removal', () => {
  const rt = roundTrip(['div', { class: 'a' }, ['button', { class: 'lc-btn' }, 'Buy $50']]);
  const { page, copy, mirror, idOf, hasId, forget } = rt;
  const button = page.childNodes[0];
  const text = button.childNodes[0];
  text.data = 'Sure? $50';
  button.setAttribute('class', 'lc-btn lc-arm');
  button.setAttribute('disabled', '');
  page.setAttribute('style', 'background: url(https://evil.example/x.png)');
  page.setAttribute('onclick', 'x()');
  const ops = mutationsToOps([
    textRecord(text),
    attrRecord(button, 'class'),
    attrRecord(button, 'disabled'),
    attrRecord(page, 'style'),
    attrRecord(page, 'onclick'),
  ], { idOf, hasId, forget });
  assert.deepEqual(ops.map((o) => o.op), ['txt', 'att', 'att', 'att'], 'the handler change is not sent at all');
  assert.deepEqual(ops[3], { op: 'att', i: idOf(page), k: 'style', v: null });
  mirror.apply(ops);
  assert.equal(copy.outerHTML, '<div class="a"><button class="lc-btn lc-arm" disabled="">Sure? $50</button></div>');
});

test('the panel filters again on apply: a forged op cannot put a handler or a foreign image in', () => {
  const rt = roundTrip(['div', {}, ['img', { src: 'https://fomo.family/a.png' }]]);
  const { copy, mirror, idOf, page } = rt;
  const img = page.childNodes[0];
  mirror.apply([
    { op: 'att', i: idOf(img), k: 'onerror', v: 'steal()' },
    { op: 'att', i: idOf(img), k: 'src', v: 'https://evil.example/x.png' },
    { op: 'kids', p: idOf(page), k: [idOf(img), 'z1'], n: [{ i: 'z1', t: 'script', a: {}, c: [{ i: 'z2', x: 'alert(1)' }] }] },
    { op: 'kids', p: idOf(page), k: [idOf(img), 'z3'], n: [{ i: 'z3', t: 'a', a: { href: 'javascript:1', onclick: 'x' }, c: [{ i: 'z4', x: 'l' }] }] },
  ]);
  // The src that failed the filter is removed, the script tag is not built
  // (createElement would make one; the dropped-tag check stops it) and the
  // link arrives bare.
  assert.equal(copy.outerHTML, '<div><img></img><a>l</a></div>');
});

test('a change inside a dropped subtree, or under a node never sent, is ignored', () => {
  const rt = roundTrip(['div', {}, ['span', {}, 'x']]);
  const { page, src, mirror, idOf, hasId, forget, copy } = rt;
  const stray = el(src, ['div', {}, ['b', {}, 'late']]);
  // A parent the panel never saw (never serialised): its records are skipped.
  const ops = mutationsToOps([childListRecord(stray, { added: [stray.childNodes[0]] })], { idOf, hasId, forget });
  assert.deepEqual(ops, []);
  // A parent that left the tree since the record: not sent either.
  const span = page.childNodes[0];
  page.removeChild(span);
  const ops2 = mutationsToOps([
    childListRecord(span, { added: [] }),
    childListRecord(page, { removed: [span] }),
  ], { idOf, hasId, forget });
  assert.deepEqual(ops2.map((o) => o.op), ['kids']);
  mirror.apply(ops2);
  assert.equal(copy.outerHTML, '<div></div>');
});

test('idOf on the panel side finds the mirrored ancestor of any node', () => {
  const rt = roundTrip(['div', {}, ['button', {}, ['span', {}, 'x']]]);
  const { copy, mirror, idOf, page } = rt;
  const text = copy.childNodes[0].childNodes[0].childNodes[0];
  assert.equal(mirror.idOf(text), idOf(page.childNodes[0].childNodes[0].childNodes[0]));
  assert.equal(mirror.idOf(copy), idOf(page));
});

test('one op that cannot be applied is skipped and counted; the rest of the batch still goes in', () => {
  const rt = roundTrip(['div', {}, ['span', {}, 'a']]);
  const { copy, mirror, idOf, page } = rt;
  const span = page.childNodes[0];
  const skipped = mirror.apply([
    { op: 'kids', p: 'nowhere', k: ['z1'], n: [{ i: 'z1', t: 'b', a: {}, c: [] }] },
    { op: 'kids', p: idOf(page), k: [idOf(span)], n: 'not a list' },
    { op: 'txt', i: idOf(span.childNodes[0]), x: 'still applied' },
    { op: 'kids', p: idOf(page), k: [idOf(span), 'z2'], n: [{ i: 'z2', t: 'i', a: {}, c: [{ i: 'z3', x: 'b' }] }] },
  ]);
  assert.equal(skipped, 1, 'the malformed op is counted, an unknown parent is merely ignored');
  assert.equal(copy.outerHTML, '<div><span>still applied</span><i>b</i></div>');
});

// ------------------------------------------------- a card key that holds still

test('a feed card keeps one key while it ages: the age is glued to the words around it', () => {
  // FOMO renders a card as one run of text with no spaces, so the age sits
  // between two letters and a word-boundary pattern never sees it. A key that
  // moved with the age made the panel mount the same post again every minute:
  // stale copies piled up, the order went with them, and the page was asked
  // for the wrong scroll position, so the feed stopped loading.
  const card = (age) => `evilspermThesis${age}FATCOIN$10,437.58(▲1.34%)I'm back0Buy $50Buy $200Sell 50%`;
  const keys = ['10s', '20s', '59s', '1m', '2m', '9m', '1h', '3h', '1d', '3mo', '1y'].map((a) => cardKeyText(card(a)));
  assert.equal(new Set(keys).size, 1, `the key moved with the age: ${[...new Set(keys)].join(' | ')}`);
  assert.doesNotMatch(keys[0], /\d+(mo|s|m|h|d|y)/, 'no age left in the key');
});

test('two different posts are two different keys', () => {
  const a = cardKeyText('TekkerrssThesis1mxp$36,203.34(▲1,632.62%)so as long as it holds above');
  const b = cardKeyText('vancute1112Thesis30sxp$26,414.28(▲31.67%)Can someone take the phone');
  assert.notEqual(a, b, 'two posts about one token must not share a slot');
});

test('prices and percentages still go, and the text survives', () => {
  const k = cardKeyText('aliceThesis5mPONS$1,234.56(▼7.42%)hello there0Buy $50');
  assert.match(k, /alice/);
  assert.match(k, /hello there/);
  assert.doesNotMatch(k, /1,234|7\.42/);
});
