// A scroller whose scroll position the page reads divided by a ratio.
//
// The rows of FOMO's Tokens list are placed by the extension, taller than
// the list thinks they are (isolated/token-list.js). The list decides what
// to mount from the scroll position in ITS coordinates, so it must read the
// real position divided by the ratio of the two row heights. That read
// happens in the page's own JavaScript, and a property defined on an
// element in the content script's world is not seen from the page's: each
// world wraps the DOM in its own objects. So the content script only marks
// the scroller with the ratio, in an attribute, and this MAIN-world module
// shadows `scrollTop` on the marked element with a getter that divides.
// Writes pass through unchanged. The attribute gone, the shadow goes too.

export const SCALE_ATTR = 'data-limil-scroll-scale';

const native = Object.getOwnPropertyDescriptor(globalThis.Element?.prototype ?? {}, 'scrollTop');

function ratioOf(el) {
  const r = parseFloat(el.getAttribute(SCALE_ATTR));
  return r > 0 ? r : 1;
}

function shadow(el) {
  if (!native?.get || !native?.set) return;
  if (Object.prototype.hasOwnProperty.call(el, 'scrollTop')) return;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    enumerable: true,
    get() { return native.get.call(this) / ratioOf(this); },
    set(v) { native.set.call(this, v); },
  });
}

function unshadow(el) {
  if (Object.prototype.hasOwnProperty.call(el, 'scrollTop')) delete el.scrollTop;
}

function sync(el) {
  if (el.nodeType !== 1) return;
  if (el.hasAttribute(SCALE_ATTR)) shadow(el);
  else unshadow(el);
}

/** Watches the document for the mark; installed at document_start. */
export function install() {
  if (typeof MutationObserver !== 'function' || !globalThis.document) return false;
  const seen = (root) => {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute?.(SCALE_ATTR)) sync(root);
    root.querySelectorAll?.(`[${SCALE_ATTR}]`).forEach(sync);
  };
  new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes') sync(rec.target);
      else for (const node of rec.addedNodes) seen(node);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: [SCALE_ATTR] });
  seen(document.documentElement);
  return true;
}
