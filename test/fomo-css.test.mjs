// The side panel takes FOMO's stylesheet as text: @font-face rules become
// FontFace descriptors, relative url() references become absolute, and
// nothing in it may fetch from a host that is not FOMO's.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { adaptSheet, parseFontFace } from '../src/shared/fomo-css.js';

const BASE = 'https://fomo.family/assets/root-v2-BZEHH2vw.css';

test('the @font-face rules of the real sheet come out as descriptors and leave the css', () => {
  const css = '@font-face{font-family:Aeonik;src:url(/fonts/Aeonik-Regular.woff2)format("woff2");font-weight:400;font-style:normal}'
    + '@font-face{font-family:Aeonik;src:url(/fonts/aeonik-regularitalic.otf)format("opentype");font-weight:400;font-style:italic}'
    + '@font-face{font-family:Aeonik;src:url(/fonts/Aeonik-Medium.woff2)format("woff2");font-weight:500;font-style:normal}'
    + '.x{color:red}';
  const { css: out, faces } = adaptSheet(css, BASE);
  assert.equal(out, '.x{color:red}');
  assert.deepEqual(faces, [
    { family: 'Aeonik', url: 'https://fomo.family/fonts/Aeonik-Regular.woff2', weight: '400', style: 'normal' },
    { family: 'Aeonik', url: 'https://fomo.family/fonts/aeonik-regularitalic.otf', weight: '400', style: 'italic' },
    { family: 'Aeonik', url: 'https://fomo.family/fonts/Aeonik-Medium.woff2', weight: '500', style: 'normal' },
  ]);
});

test('relative and same-host urls become absolute, foreign ones and imports are dropped, data urls stay', () => {
  const css = '@import url("https://evil.example/x.css");'
    + '.a{background:url(/img/a.png)}'
    + '.b{background:url("../img/b.png")}'
    + '.c{background:url(https://cdn.fomo.family/c.png)}'
    + '.d{background:url(https://evil.example/d.png)}'
    + '.e{background:url(http://fomo.family/e.png)}'
    + '.f{background:url(data:image/png;base64,AAAA)}';
  const { css: out, faces } = adaptSheet(css, BASE);
  assert.deepEqual(faces, []);
  assert.equal(out,
    '.a{background:url("https://fomo.family/img/a.png")}'
    + '.b{background:url("https://fomo.family/img/b.png")}'
    + '.c{background:url("https://cdn.fomo.family/c.png")}'
    + '.d{background:none}'
    + '.e{background:none}'
    + '.f{background:url(data:image/png;base64,AAAA)}');
});

test('a font face on a foreign host, or without a file, is not a descriptor', () => {
  assert.equal(parseFontFace('font-family:X;src:url(https://evil.example/x.woff2)', BASE), null);
  assert.equal(parseFontFace('font-family:X;src:local("X")', BASE), null);
  assert.equal(parseFontFace('src:url(/x.woff2)', BASE), null, 'no family');
  assert.deepEqual(parseFontFace("font-family: 'Quoted Name'; src: url('/q.woff2'); font-weight: 100 900", BASE),
    { family: 'Quoted Name', url: 'https://fomo.family/q.woff2', weight: '100 900', style: 'normal' });
  const { css } = adaptSheet('@font-face{font-family:X;src:url(https://evil.example/x.woff2)}.y{}', BASE);
  assert.equal(css, '.y{}', 'the rule is cut out even when it yields no descriptor');
});
