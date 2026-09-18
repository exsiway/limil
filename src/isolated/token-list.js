// FOMO's Tokens list, made taller than it thinks it is.
//
// The list (Legend List, in FOMO's build) is told that every row is 53px:
// it places the rows at 53 × index and never measures them, so a row with
// the quick-buy strip under its text overlapped the next one. While the
// strip is on, the rows of that list are placed by this module instead:
// every `top` the list writes on a row is multiplied by the real row
// height over 53, the list's height too, and the list reads the scroll
// position divided by the same ratio. What the list mounts for a scroll
// position is then exactly what the viewport shows there; it keeps its own
// bookkeeping, recycling and end-of-list loading, in its own coordinates.
// The list's writes are caught by a MutationObserver and corrected in the
// same microtask, before the browser paints. The pure arithmetic is in
// shared/fixed-list.js.

import { ratioOf, rowHeightOf, scaledTop, stepOf } from '../shared/fixed-list.js';

/** Per scroller: what is attached to it. */
const attached = new WeakMap();
/** Per row wrapper: the last top the LIST wrote, i.e. its own coordinate. */
const listTops = new WeakMap();

const SIZED = ':scope > .legend-list-content-container > div[style*="position: relative"]';

function sizedOf(scroller) {
  return scroller.querySelector(SIZED);
}

function rowsOf(sized) {
  return [...sized.children].filter((el) => el.style?.position === 'absolute' && /^-?\d/.test(el.style.top ?? ''));
}

/** Reads the list's coordinates and writes ours. Idempotent. */
function apply(scroller) {
  const rec = attached.get(scroller);
  const sized = sizedOf(scroller);
  if (!rec || !sized) return;
  const rows = rowsOf(sized);
  // A top that is not the one this module wrote is the list's: remember it.
  for (const row of rows) {
    const current = parseFloat(row.style.top);
    const known = listTops.get(row);
    if (known === undefined || scaledTop(known, rec.ratio) !== Math.round(current)) listTops.set(row, current);
  }
  const step = stepOf(rows.map((r) => listTops.get(r)));
  const rowHeight = rowHeightOf(rows.map((r) => r.offsetHeight));
  const ratio = ratioOf({ step, rowHeight });
  rec.ratio = ratio;
  rec.writing = true;
  try {
    for (const row of rows) {
      const want = `${scaledTop(listTops.get(row), ratio)}px`;
      if (row.style.top !== want) row.style.top = want;
    }
    const listHeight = parseFloat(sized.style.height);
    const known = rec.listHeight;
    if (known === undefined || Math.round(listHeight) !== Math.round(known * rec.lastRatio)) rec.listHeight = listHeight;
    const wantHeight = `${Math.round(rec.listHeight * ratio)}px`;
    if (sized.style.height !== wantHeight) sized.style.height = wantHeight;
    rec.lastRatio = ratio;
    mark(scroller, ratio);
  } finally {
    rec.writing = false;
  }
}

/**
 * The scroll position the list sees is the real one divided by the ratio.
 * The list reads it in the page's own world, where nothing this world
 * defines on an element is visible, so the scroller is only MARKED here
 * with the ratio; the MAIN-world script (main/scroll-scale.js) shadows
 * `scrollTop` on the marked element. Writes pass through unchanged: they
 * come from the extension (the side panel forwarding its own scroll, in
 * real pixels); the list sets the position only for programmatic scrolls,
 * which are rare here.
 */
const SCALE_ATTR = 'data-limil-scroll-scale';
function mark(scroller, ratio) {
  if (ratio === 1) { scroller.removeAttribute(SCALE_ATTR); return; }
  const want = String(ratio);
  if (scroller.getAttribute(SCALE_ATTR) !== want) scroller.setAttribute(SCALE_ATTR, want);
}

/** Places the rows of this scroller's list. Safe to call again; nothing changes while the rows fit. */
export function attach(scroller) {
  if (!scroller || attached.has(scroller)) { if (scroller) apply(scroller); return; }
  const rec = { ratio: 1, lastRatio: 1, listHeight: undefined, writing: false, observer: null };
  attached.set(scroller, rec);
  rec.observer = new MutationObserver(() => { if (!rec.writing) apply(scroller); });
  rec.observer.observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  apply(scroller);
}

/** Gives the list its coordinates back. */
export function detach(scroller) {
  const rec = attached.get(scroller);
  if (!rec) return;
  rec.observer?.disconnect();
  attached.delete(scroller);
  scroller.removeAttribute(SCALE_ATTR);
  const sized = sizedOf(scroller);
  if (!sized) return;
  for (const row of rowsOf(sized)) {
    const top = listTops.get(row);
    if (top !== undefined) row.style.top = `${top}px`;
  }
  if (rec.listHeight !== undefined) sized.style.height = `${rec.listHeight}px`;
}
