// FOMO's stylesheet, adapted for the side panel: the pure part.
//
// The panel draws FOMO's block with FOMO's CSS. Linking the sheet is not
// enough: its @font-face rules point at fomo.family, a font is fetched with
// CORS, fomo.family sends no CORS header, and an extension page ends up with
// the system face while the page has Aeonik. The extension may fetch the
// font files itself (host permission) and register them with the FontFace
// API, but a face registered under a name the sheet also declares loses to
// the sheet's failing one. So the sheet is taken as text, its @font-face
// rules are cut out and returned as descriptors for the FontFace API, its
// relative url() references are made absolute (an inline sheet resolves
// them against the extension's origin otherwise), and anything that would
// fetch from a host other than FOMO's, or import another sheet, is dropped.

const FOMO_HOST = /(^|\.)fomo\.family$/i;

function fomoUrl(value, base) {
  try {
    const u = new URL(String(value).trim(), base);
    return u.protocol === 'https:' && FOMO_HOST.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** One @font-face rule as descriptors for `new FontFace(...)`; null when it names no usable file. */
export function parseFontFace(decl, base) {
  const family = /font-family\s*:\s*(['"]?)([^;'"]+)\1/i.exec(decl)?.[2]?.trim();
  const src = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/i.exec(decl)?.[2];
  if (!family || !src) return null;
  const url = fomoUrl(src, base);
  if (!url) return null;
  return {
    family,
    url,
    weight: /font-weight\s*:\s*([^;]+)/i.exec(decl)?.[1]?.trim() ?? '400',
    style: /font-style\s*:\s*([^;]+)/i.exec(decl)?.[1]?.trim() ?? 'normal',
  };
}

/**
 * @param {string} css the sheet's text
 * @param {string} base the sheet's own URL, for relative references
 * @returns {{ css: string, faces: Array<{family: string, url: string, weight: string, style: string}> }}
 */
export function adaptSheet(css, base) {
  const faces = [];
  let out = String(css ?? '');
  // @import fetches another sheet from wherever it says: out.
  out = out.replace(/@import\b[^;]*;/gi, '');
  // @font-face rules become descriptors; the rule itself goes.
  out = out.replace(/@font-face\s*\{([^}]*)\}/gi, (_m, decl) => {
    const face = parseFontFace(decl, base);
    if (face) faces.push(face);
    return '';
  });
  // Every remaining url(): absolute, and FOMO's, or gone.
  out = out.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q, ref) => {
    const trimmed = ref.trim();
    if (/^data:/i.test(trimmed)) return m;
    const url = fomoUrl(trimmed, base);
    return url ? `url("${url}")` : 'none';
  });
  return { css: out, faces };
}
