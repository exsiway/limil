// A virtualised list with a fixed row height, made taller: the pure part.
//
// FOMO's Tokens list tells its virtualiser that every row is 53px
// (`getFixedItemSize`), so the rows are placed at 53 × index and the list is
// 53 × count tall whatever the rows measure. The quick-buy strip needs the
// row taller. The rows are therefore placed by the extension: every top the
// list writes is multiplied by the ratio of the real row height to the
// list's, the list's height too, and the list is shown the scroll position
// divided by the same ratio, so what it decides to mount for a scroll
// position is what the viewport shows there. The DOM side lives in
// isolated/token-list.js; what can be tested without a page is here.

/** The list's own row size: the step its tops go by. Null when there is no step to read. */
export function stepOf(tops) {
  const sorted = [...new Set(tops.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  const counts = new Map();
  for (let i = 1; i < sorted.length; i += 1) {
    const d = Math.round(sorted[i] - sorted[i - 1]);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = null;
  for (const [d, n] of counts) if (best === null || n > counts.get(best) || (n === counts.get(best) && d < best)) best = d;
  return best;
}

/** The most common of the rows' real heights. */
export function rowHeightOf(heights) {
  const counts = new Map();
  for (const h of heights) {
    const r = Math.round(h);
    if (r > 0) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best = null;
  for (const [h, n] of counts) if (best === null || n > counts.get(best)) best = h;
  return best;
}

/**
 * How much taller the rows are than the list thinks, as a ratio; 1 when the
 * list's step already fits them (a list that measures its rows itself).
 */
export function ratioOf({ step, rowHeight }) {
  if (!step || !rowHeight || rowHeight <= step + 1) return 1;
  return rowHeight / step;
}

/** A top the list wrote, where the row goes. */
export function scaledTop(top, ratio) {
  return Math.round(top * ratio);
}
