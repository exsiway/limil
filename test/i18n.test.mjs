import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LOCALE, LOCALES, getLocale, hasKey, localeDir, setLocale, t } from '../src/shared/i18n.js';
import en from '../src/locales/en.js';
import ru from '../src/locales/ru.js';
import zh from '../src/locales/zh.js';
import ko from '../src/locales/ko.js';
import pt from '../src/locales/pt.js';
import hi from '../src/locales/hi.js';
import ar from '../src/locales/ar.js';

const DICTS = { en, ru, zh, ko, pt, hi, ar };

test('English is the default and the fallback', () => {
  setLocale(DEFAULT_LOCALE);
  assert.equal(getLocale(), 'en');
  assert.equal(t('orders.toggle'), 'Limit orders');
  setLocale('nope');
  assert.equal(getLocale(), 'en');
});

test('every locale carries every English key with the same placeholders', () => {
  const keys = Object.keys(en);
  for (const [code, dict] of Object.entries(DICTS)) {
    assert.ok(LOCALES[code], `${code} is listed in LOCALES`);
    for (const key of keys) {
      assert.equal(typeof dict[key], 'string', `${code} has ${key}`);
      for (const ph of en[key].match(/\{\w+\}/g) ?? []) {
        assert.ok(dict[key].includes(ph), `${code}:${key} keeps ${ph}`);
      }
    }
    for (const key of Object.keys(dict)) assert.ok(hasKey(key), `${code} has no stray key ${key}`);
  }
});

test('placeholders are substituted and unknown ones are left alone', () => {
  setLocale('en');
  assert.equal(t('panel.orders', { n: 3 }), 'Active orders: 3');
  assert.equal(t('panel.orders', {}), 'Active orders: {n}');
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('a switch changes the text and the direction; Arabic is right-to-left', () => {
  setLocale('ar');
  assert.equal(localeDir(), 'rtl');
  assert.notEqual(t('orders.toggle'), 'Limit orders');
  setLocale('ko');
  assert.equal(localeDir(), 'ltr');
  assert.equal(t('orders.toggle'), ko['orders.toggle']);
  setLocale('en');
});
