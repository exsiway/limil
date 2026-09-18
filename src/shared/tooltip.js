// Positioning of the "?" tooltips.
//
// CSS alone cannot do it: a tooltip opening upwards from a card near the top
// of the window runs off the edge. The side depends on where the element is on
// screen, which is only known at hover time. The tooltip is positioned as
// fixed and clamped to the window, so neither scrolling nor a clipping parent
// affects it.

/** Distance from the window edges. */
const MARGIN = 8;

/** Gap between the "?" and the tooltip. */
const GAP = 8;

/**
 * Places the tooltip next to the anchor without leaving the window. Called at
 * show time, because the tooltip's size is unknown before that.
 */
export function placeTooltip(anchor, tip) {
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Horizontally: align with the left edge of the "?", clamped to the window.
  const maxLeft = Math.max(MARGIN, vw - t.width - MARGIN);
  const left = Math.min(Math.max(a.left, MARGIN), maxLeft);

  // Above when there is room; below otherwise; else clamp to the roomier edge.
  const above = a.top - t.height - GAP;
  const below = a.bottom + GAP;
  let top;
  if (above >= MARGIN) top = above;
  else if (below + t.height <= vh - MARGIN) top = below;
  else top = Math.max(MARGIN, Math.min(below, vh - t.height - MARGIN));

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/**
 * Attaches a tooltip to a button: shown on hover and on keyboard focus, the
 * position recomputed every time because the window may have scrolled.
 */
export function attachTooltip(anchor, tip) {
  const show = () => {
    tip.classList.add('shown');
    placeTooltip(anchor, tip);
  };
  const hide = () => tip.classList.remove('shown');

  anchor.addEventListener('mouseenter', show);
  anchor.addEventListener('focus', show);
  anchor.addEventListener('mouseleave', hide);
  anchor.addEventListener('blur', hide);
  return anchor;
}
