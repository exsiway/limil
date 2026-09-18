// One theme for the whole extension: FOMO's own design tokens.
//
// The panel lives inside their page and the popup is a separate window; they
// must read as one product with the app around them. So the values here are
// FOMO's, taken from their stylesheet (Tailwind theme, root-v2 bundle), not
// an approximation of them:
//
//   --color-bg-primary     #060510   page background
//   --color-bg-secondary   #12111a   inputs, inactive segments, popovers
//   --color-bg-tertiary    #cbd0eb1a card borders, hover fills
//   --color-text-primary   #f7f7f7 / secondary #9899a3 / tertiary #474b52
//   --color-accent-primary #516af6   green #21c95e   red #ff622e
//   --color-warning        #ffc74f   critical #ff622e
//   radius-lg 8px, radius-xl 12px, radius-2xl 16px
//
// On the page the panel reads their variables directly with these values as
// the fallback, so a palette change on their side carries over, and the
// popup, where their CSS is absent, gets the fallback. Both paths produce the
// same picture today.
//
// Font: their UI is set in Aeonik, a licensed face we cannot ship. On the
// page it is already loaded and the stack picks it up; in the popup the stack
// falls through to Manrope (OFL), which we bundle, so the popup is the one
// place where the letterforms differ.

/** Fallback values, FOMO's palette at the time of writing. */
const COLORS = {
  bg: '#060510',
  card: '#12111a',
  cardHover: '#161522',
  line: '#cbd0eb1a',
  lineStrong: '#474b52',
  text: '#f7f7f7',
  dim: '#9899a3',
  faint: '#474b52',
  buy: '#21c95e',
  buyTransparent: '#21c95e33',
  sell: '#ff622e',
  sellTransparent: '#ff622e33',
  accent: '#516af6',
  accentTransparent: '#516af629',
  accentSecondary: '#221d4b',
  warn: '#ffc74f',
  warnTransparent: '#ffc74f1f',
  bad: '#ff622e',
  badTransparent: '#ff622e1f',
  yellow: '#ffbf17',
};

/** FOMO's radii: rounded-md, rounded-lg, rounded-xl, rounded-2xl, full. */
const RADII = { xs: '6px', sm: '8px', md: '12px', lg: '16px', pill: '9999px' };

/**
 * @font-face for the bundled fallback face. Files live inside the extension:
 * the page's CSP would not let an external font through, and the popup has no
 * network font either.
 *
 * @param {(path: string) => string} url usually chrome.runtime.getURL
 */
export function fontFaces(url) {
  const face = (family, file, range, weight = '400 800') => `
@font-face {
  font-family: '${family}';
  src: url('${url(`fonts/${file}`)}') format('woff2');
  font-weight: ${weight};
  font-style: normal;
  font-display: swap;
  unicode-range: ${range};
}`;
  const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215';
  const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
  return [
    face('LimilSans', 'manrope.woff2', LATIN),
    face('LimilSans', 'manrope-cyr.woff2', CYRILLIC),
    face('LimilMono', 'jetbrains.woff2', LATIN, '400 600'),
    face('LimilMono', 'jetbrains-cyr.woff2', CYRILLIC, '400 600'),
  ].join('\n');
}

/** Their stack first (Aeonik resolves on the page), our bundled face after it. */
const FONT_STACK = "Aeonik, 'LimilSans', ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";
const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'LimilMono', 'Liberation Mono', 'Courier New', monospace";

/**
 * Variables shared by the panel and the popup. Each reads FOMO's variable and
 * falls back to the same value the page defines, so both surfaces agree.
 */
export function cssVariables() {
  const v = (name, fallback) => `var(--color-${name}, ${fallback})`;
  return `
  --lc-bg:${v('bg-primary', COLORS.bg)};
  --lc-card:${v('bg-secondary', COLORS.card)};
  --lc-card-hover:${v('bg-tertiary-solid', COLORS.cardHover)};
  --lc-line:${v('bg-tertiary', COLORS.line)};
  --lc-line-strong:${v('border', COLORS.lineStrong)};
  --lc-text:${v('text-primary', COLORS.text)};
  --lc-dim:${v('text-secondary', COLORS.dim)};
  --lc-faint:${v('text-tertiary', COLORS.faint)};
  --lc-buy:${v('green', COLORS.buy)};
  --lc-buy-soft:${v('green-transparent', COLORS.buyTransparent)};
  --lc-sell:${v('red', COLORS.sell)};
  --lc-sell-soft:${v('red-transparent', COLORS.sellTransparent)};
  --lc-accent:${v('accent-primary', COLORS.accent)};
  --lc-accent-soft:${v('accent-primary-transparent', COLORS.accentTransparent)};
  --lc-accent-2:${v('accent-secondary', COLORS.accentSecondary)};
  --lc-warn:${v('warning', COLORS.warn)};
  --lc-warn-soft:${v('warning-transparent', COLORS.warnTransparent)};
  --lc-bad:${v('critical', COLORS.bad)};
  --lc-bad-soft:${v('critical-transparent', COLORS.badTransparent)};
  --lc-yellow:${v('yellow', COLORS.yellow)};
  --lc-r-xs:${RADII.xs};
  --lc-r-sm:${RADII.sm};
  --lc-r-md:${RADII.md};
  --lc-r-lg:${RADII.lg};
  --lc-r-pill:${RADII.pill};
  --lc-font:${FONT_STACK};
  --lc-mono:${MONO_STACK};`;
}

/**
 * Shared elements, each a transcription of the FOMO pattern it copies:
 *
 *   .lc-card   border border-bg-tertiary rounded-2xl p-2 flex flex-col gap-2
 *   .lc-seg    flex gap-2; buttons flex-1 p-2 rounded-lg text-base font-bold;
 *              active buy bg-green-transparent text-green, active sell
 *              bg-red-transparent text-red, idle bg-bg-secondary
 *              text-text-secondary hover:bg-bg-tertiary
 *   .lc-row    bg-bg-secondary rounded-lg h-10 px-3 text-sm; input transparent
 *   .lc-btn    bg-bg-secondary hover:bg-bg-tertiary rounded-lg font-bold
 *   .lc-chip   bg-bg-tertiary-solid rounded-md px-2 py-1 text-xs font-bold
 *              text-text-secondary hover:text-text-primary
 *   .lc-pill   rounded-sm py-px px-1 text-xs font-bold
 *
 * Selectors are class-scoped with the lc- prefix so nothing leaks into their
 * page or back.
 */
export function baseCss(scope = '') {
  const s = scope ? `${scope} ` : '';
  return `
${s}.lc-card {
  border: 1px solid var(--lc-line);
  border-radius: var(--lc-r-lg);
  padding: 8px;
  display: flex; flex-direction: column; gap: 8px;
}
${s}.lc-row {
  display: flex; align-items: center; gap: 8px;
  min-height: 40px; padding: 0 12px;
  border-radius: var(--lc-r-sm);
  background: var(--lc-card);
  font-size: 14px;
}
${s}.lc-row:focus-within { box-shadow: 0 0 0 1px var(--lc-line-strong) inset; }
${s}.lc-row label { color: var(--lc-dim); font-size: 14px; font-weight: 500; min-width: 62px; }
${s}.lc-row input {
  flex: 1; min-width: 0; background: transparent; border: none;
  color: var(--lc-text); font: inherit; font-weight: 500;
  font-variant-numeric: tabular-nums; text-align: right; outline: none;
}
${s}.lc-row input::placeholder { color: var(--lc-faint); }
${s}.lc-unit { color: var(--lc-dim); font-size: 12px; }

${s}.lc-btn {
  border: none; background: var(--lc-card);
  color: var(--lc-dim); border-radius: var(--lc-r-sm);
  min-height: 40px; padding: 8px 12px; font: inherit; font-size: 14px; font-weight: 700;
  cursor: pointer; transition: background-color .15s, color .15s, opacity .15s;
}
${s}.lc-btn:hover { color: var(--lc-text); background: var(--lc-line); }
${s}.lc-btn:disabled { opacity: .5; cursor: not-allowed; }
${s}.lc-btn.primary { background: var(--lc-accent); color: var(--lc-text); width: 100%; }
${s}.lc-btn.primary:hover { filter: brightness(1.08); background: var(--lc-accent); }

${s}.lc-seg { display: flex; gap: 8px; }
${s}.lc-seg button {
  flex: 1; border: none; background: var(--lc-card); color: var(--lc-dim);
  border-radius: var(--lc-r-sm); padding: 8px; min-height: 40px; font: inherit;
  font-size: 16px; font-weight: 700; cursor: pointer; transition: background-color .15s, color .15s;
}
${s}.lc-seg button:hover { background: var(--lc-line); }
${s}.lc-seg button.on { background: var(--lc-line); color: var(--lc-text); }
${s}.lc-seg button.on.sell { background: var(--lc-sell-soft); color: var(--lc-sell); }
${s}.lc-seg button.on.buy { background: var(--lc-buy-soft); color: var(--lc-buy); }

${s}.lc-chip {
  border: none; background: var(--lc-card-hover); color: var(--lc-dim);
  border-radius: var(--lc-r-xs); padding: 4px 8px; font: inherit; font-size: 12px; font-weight: 700;
  cursor: pointer; transition: color .15s, background-color .15s;
}
${s}.lc-chip:hover { color: var(--lc-text); }
${s}.lc-chip.on { color: var(--lc-text); background: var(--lc-line); }

${s}.lc-pill {
  display: inline-block; padding: 1px 4px; border-radius: 4px;
  font-size: 12px; font-weight: 700; background: var(--lc-line); color: var(--lc-dim);
}
${s}.lc-pill.buy { color: var(--lc-buy); background: var(--lc-buy-soft); }
${s}.lc-pill.sell { color: var(--lc-sell); background: var(--lc-sell-soft); }
${s}.lc-pill.dim { color: var(--lc-faint); }

${s}.lc-muted { color: var(--lc-dim); font-size: 12px; line-height: 1.45; margin-top: 6px; white-space: pre-line; }
${s}.lc-muted.ok { color: var(--lc-buy); }
${s}.lc-muted.warn { color: var(--lc-warn); }
${s}.lc-muted.bad { color: var(--lc-bad); }

${s}.lc-help {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--lc-line-strong);
  background: transparent; color: var(--lc-dim); font: inherit; font-size: 9px; font-weight: 700;
  line-height: 1; cursor: help; padding: 0; vertical-align: middle;
}
${s}.lc-help:hover { color: var(--lc-text); border-color: var(--lc-dim); }
${s}.lc-tip {
  position: fixed; z-index: 2147483001; left: 0; top: 0;
  width: 260px; padding: 10px 12px; border-radius: var(--lc-r-md);
  background: var(--lc-card); border: 1px solid var(--lc-line);
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
  color: var(--lc-text); font-size: 12px; font-weight: 500; line-height: 1.45;
  text-align: left; white-space: pre-line; cursor: default;
  opacity: 0; visibility: hidden; transform: translateY(-2px);
  transition: opacity .15s ease, transform .15s ease, visibility 0s linear .15s;
  pointer-events: none;
}
${s}.lc-tip.shown { opacity: 1; visibility: visible; transform: translateY(0); transition-delay: 0s; pointer-events: auto; }
`;
}
