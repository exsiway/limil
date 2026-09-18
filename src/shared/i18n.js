// Interface language.
//
// One dictionary per language under src/locales/. English is the source of
// truth and the fallback: a key missing from a translation falls through to
// the English string, and a key missing everywhere renders as the key itself,
// which is loud enough to notice in a screenshot and never throws.
//
// The current language is a module-level variable so that `t()` stays a
// synchronous, pure lookup usable from render code. Every context (popup,
// content script, service worker) calls `initLocale()` once at start; the
// popup writes `settings.uiLang`, and the storage listener installed by
// `initLocale()` keeps the other contexts in step.

import en from '../locales/en.js';
import ru from '../locales/ru.js';
import zh from '../locales/zh.js';
import ko from '../locales/ko.js';
import pt from '../locales/pt.js';
import hi from '../locales/hi.js';
import ar from '../locales/ar.js';

/** Code → native name and writing direction. Order is the order in menus. */
export const LOCALES = Object.freeze({
  en: { name: 'English', dir: 'ltr' },
  zh: { name: '中文', dir: 'ltr' },
  ko: { name: '한국어', dir: 'ltr' },
  pt: { name: 'Português', dir: 'ltr' },
  hi: { name: 'हिन्दी', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
  ru: { name: 'Русский', dir: 'ltr' },
});

export const DEFAULT_LOCALE = 'en';

const DICTS = { en, ru, zh, ko, pt, hi, ar };

let current = DEFAULT_LOCALE;
let dict = en;
const listeners = new Set();

export function getLocale() {
  return current;
}

/** Writing direction of the current language, for `dir` attributes. */
export function localeDir(code = current) {
  return LOCALES[code]?.dir ?? 'ltr';
}

export function setLocale(code) {
  const next = DICTS[code] ? code : DEFAULT_LOCALE;
  if (next === current) return current;
  current = next;
  dict = DICTS[next];
  for (const fn of listeners) {
    try { fn(next); } catch { /* one listener must not break the others */ }
  }
  return current;
}

/** Called after the language changed; returns an unsubscribe function. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Looks a key up and substitutes `{name}` placeholders.
 *
 * @param {string} key
 * @param {Record<string, unknown>} [vars]
 */
export function t(key, vars) {
  let text = dict[key] ?? en[key] ?? key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  }
  return text;
}

/** Has the key a translation in any language, for tests and audits. */
export function hasKey(key) {
  return key in en;
}

/**
 * Loads the language from extension storage and follows later changes.
 * Safe without `chrome` (tests, node): leaves English in place.
 */
export async function initLocale({ load = null } = {}) {
  // Content scripts have no access to extension storage (the worker marks it
  // TRUSTED_CONTEXTS only); they pass a loader that asks the worker, and the
  // worker tells them about later changes with a `locale.changed` message.
  if (load) {
    try {
      const settings = await load();
      setLocale(settings?.uiLang ?? DEFAULT_LOCALE);
    } catch { /* worker asleep, stay on the default */ }
    return current;
  }
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) return current;
  try {
    const bag = await storage.get('settings');
    setLocale(bag?.settings?.uiLang ?? DEFAULT_LOCALE);
  } catch { /* storage unavailable, stay on the default */ }
  globalThis.chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const lang = changes.settings.newValue?.uiLang;
    if (lang && lang !== current) setLocale(lang);
  });
  return current;
}

/**
 * Applies translations to static markup: `data-i18n` sets text content,
 * `data-i18n-placeholder`, `data-i18n-title` and `data-i18n-aria` set the
 * matching attributes. Called once at load and again on a language change.
 */
export function applyToDom(root = globalThis.document) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  const html = root.documentElement ?? null;
  if (html) {
    html.lang = current;
    html.dir = localeDir();
  }
}
