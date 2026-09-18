// The feed mirror: the pure part.
//
// The side panel shows FOMO's Alerts / Tokens / Leaderboard / Feed block on
// every site the person visits. The block cannot be framed (fomo.family sends
// X-Frame-Options: DENY), so the content script on the FOMO tab serialises
// the block's DOM and the panel rebuilds it, first as a snapshot and then as
// deltas from a MutationObserver.
//
// The panel is an extension page. What crosses into it is content other
// people wrote (theses, names, avatars), so the tree is a value, never
// markup: tag, allow-listed attributes, text, children. Scripts, handlers,
// javascript: links, foreign images and url() in styles do not survive
// serialisation, and the panel builds nodes with createElement and
// textContent, never innerHTML. The DOM work (the observer, the port) lives
// in isolated/feed-mirror.js and panel/panel.js; what can be tested without
// a page is here.

/** Name of the port between the side panel and the FOMO tab's content script. */
export const MIRROR_PORT = 'limil-feed-mirror';

/** The tab buttons that identify the block; the same four words in every FOMO language so far. */
export const BLOCK_TABS = Object.freeze(['Alerts', 'Tokens', 'Leaderboard', 'Feed']);

/** Tags that never cross. Anything that executes, embeds or takes input. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'template', 'noscript',
  'iframe', 'frame', 'object', 'embed', 'applet',
  'form', 'input', 'textarea', 'select', 'option', 'button-menu',
  'video', 'audio', 'source', 'track', 'canvas', 'dialog', 'slot', 'portal',
  'foreignobject', 'use', 'animate', 'set', 'animatemotion', 'animatetransform',
]);

/** Attributes that cross as they are, on any element. */
const PLAIN_ATTRS = new Set([
  'class', 'title', 'alt', 'role', 'dir', 'lang', 'translate', 'hidden', 'disabled',
  'type', 'width', 'height', 'colspan', 'rowspan',
  // FOMO's component state markers, matched by their CSS.
  'data-slot', 'data-state', 'data-side', 'data-orientation', 'data-selected', 'data-active',
  // SVG geometry and paint.
  'xmlns', 'viewbox', 'viewBox', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'fill-rule', 'clip-rule',
  'fill-opacity', 'opacity', 'transform', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y',
  'x1', 'x2', 'y1', 'y2', 'preserveaspectratio', 'preserveAspectRatio',
]);

/**
 * Image hosts the block uses: FOMO itself, profile pictures, token logos.
 *
 * A src from anywhere else is dropped, which is why this list has to match
 * what the app really serves. It did not: token logos come from three CDNs
 * that were missing, so every token in the panel drew an empty circle while
 * the profile pictures beside it came through.
 */
const IMAGE_HOSTS = Object.freeze([
  /^([a-z0-9-]+\.)*fomo\.family$/i,
  /^prod-fomo-profile-pics\.s3\.amazonaws\.com$/i,
  /^token-media\.defined\.fi$/i,
  /^metadata\.mobula\.io$/i,
  /^assets\.coingecko\.com$/i,
  /^crypto-exchange-logos-production\.s3\.us-west-2\.amazonaws\.com$/i,
]);

/** Where a link may point for the href to be kept: FOMO itself. */
const LINK_HOSTS = [/^([a-z0-9-]+\.)*fomo\.family$/i];

const MAX_ATTR = 4000;
const MAX_TEXT = 20_000;

function hostAllowed(url, hosts) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** A relative URL resolved against the FOMO origin; absolute ones stay. */
function absolute(value, base = 'https://fomo.family/') {
  try {
    return new URL(String(value), base).href;
  } catch {
    return null;
  }
}

/**
 * An inline style crosses when it is plain declarations. Anything that
 * fetches (url, image-set), evaluates (expression, behavior) or opens a
 * different grammar (@, <, backslash escapes) drops the whole attribute.
 */
/**
 * A feed card's text as a key: what the card SAYS, without what ticks under
 * it. Prices, percentages and the card's own age all change while the card
 * stays the same card, and a key that changes with them makes the panel
 * treat one post as a new one every minute.
 *
 * The age is the reason this is not a one-line regex. FOMO renders a card as
 * one run of text with no spaces between the parts, "aliceThesis10sPONS", so
 * there is no word boundary around "10s" to anchor on. The pattern therefore
 * matches a number and its unit wherever they sit, with "mo" tried before
 * "m" so that "3mo" does not leave an "o" behind. Over-stripping is harmless
 * here: the key has to be stable and distinct, not readable.
 */
export function cardKeyText(text, limit = 160) {
  return String(text ?? '')
    .replace(/\$\s?[\d.,]+\s?[KMB]?/g, '')
    .replace(/[\d.,]+\s?%/g, '')
    .replace(/\d+\s?(?:mo|s|m|h|d|y)/g, '')
    .replace(/[▲▼]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function safeStyle(value) {
  const s = String(value ?? '');
  if (!s || s.length > MAX_ATTR) return null;
  if (/url\s*\(|image-set|expression|behavior|binding|@|<|\\|javascript/i.test(s)) return null;
  return s;
}

/**
 * The value of one attribute as the panel may have it, or null when the
 * attribute does not cross. `tag` is the element's local name.
 */
export function safeAttr(tag, name, value) {
  const n = String(name);
  const v = String(value ?? '');
  if (v.length > MAX_ATTR) return null;
  if (n.startsWith('on')) return null;
  if (n.startsWith('aria-')) return v;
  if (n === 'style') return safeStyle(v);
  if (n === 'src') {
    if (tag !== 'img') return null;
    const abs = absolute(v);
    return abs && hostAllowed(abs, IMAGE_HOSTS) ? abs : null;
  }
  if (n === 'href') {
    if (tag !== 'a') return null;
    const abs = absolute(v);
    return abs && hostAllowed(abs, LINK_HOSTS) ? abs : null;
  }
  if (PLAIN_ATTRS.has(n)) return v;
  return null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Whether an element is dropped with its whole subtree. */
function droppedTag(tag) {
  return DROPPED_TAGS.has(String(tag).toLowerCase());
}

/**
 * The tree under `node` as a value.
 *
 * `idOf(node)` returns the mirror id of a node, assigning one when it has
 * none; the caller keeps the map, this module keeps no state. Elements come
 * out as `{ i, t, a, c }` (id, tag, attributes, children; `s: 1` marks the
 * SVG namespace), text nodes as `{ i, x }`. Comments, dropped tags and
 * anything else come out as null and are skipped by the parent.
 */
export function serializeNode(node, idOf) {
  if (!node) return null;
  if (node.nodeType === 3) {
    const x = String(node.data ?? '');
    return { i: idOf(node), x: x.length > MAX_TEXT ? x.slice(0, MAX_TEXT) : x };
  }
  if (node.nodeType !== 1) return null;
  const tag = String(node.localName ?? node.nodeName ?? '').toLowerCase();
  if (!tag || droppedTag(tag)) return null;
  const a = {};
  for (const attr of node.attributes ?? []) {
    const v = safeAttr(tag, attr.name, attr.value);
    if (v !== null) a[attr.name] = v;
  }
  const c = [];
  for (const child of node.childNodes ?? []) {
    const out = serializeNode(child, idOf);
    if (out) c.push(out);
  }
  const el = { i: idOf(node), t: tag, a, c };
  if (node.namespaceURI === SVG_NS) el.s = 1;
  return el;
}

/**
 * Mutation records as a list of operations the panel applies in order.
 *
 * Child list changes are not replayed one by one: a parent that changed is
 * sent with its whole current list of child ids, and the children that are
 * new are sent in full next to it. Applying that is idempotent, and a record
 * whose nextSibling has since moved cannot put a node in the wrong place.
 *
 * `hasId(node)` says whether a node was ever sent (a node inside a dropped
 * subtree never was, and changes under it are not the panel's business).
 * `forget(node)` is called for every node that left the tree, so the caller
 * can drop it from its id map.
 */
export function mutationsToOps(records, { idOf, hasId, forget = () => {} }) {
  const ops = [];
  const parents = new Set();
  for (const rec of records) {
    if (rec.type === 'childList') {
      if (hasId(rec.target)) parents.add(rec.target);
      continue;
    }
    if (!hasId(rec.target)) continue;
    if (rec.type === 'characterData') {
      const x = String(rec.target.data ?? '');
      ops.push({ op: 'txt', i: idOf(rec.target), x: x.length > MAX_TEXT ? x.slice(0, MAX_TEXT) : x });
    } else if (rec.type === 'attributes') {
      const tag = String(rec.target.localName ?? '').toLowerCase();
      const name = String(rec.attributeName ?? '');
      // An attribute that never crosses does not cross when it changes either.
      if (!attrCrossesEver(tag, name)) continue;
      const raw = rec.target.getAttribute?.(name);
      // A value that fails the filter is sent as a removal: the panel must not
      // keep the old, once acceptable value in its place.
      const v = raw === null || raw === undefined ? null : safeAttr(tag, name, raw);
      ops.push({ op: 'att', i: idOf(rec.target), k: name, v });
    }
  }
  for (const parent of parents) {
    // A parent that itself left the tree between the record and now is not
    // sent: its own parent's list no longer names it, and the panel drops it.
    if (!parent.isConnected) continue;
    const k = [];
    const n = [];
    for (const child of parent.childNodes ?? []) {
      if (child.nodeType === 1 && droppedTag(child.localName ?? child.nodeName)) continue;
      if (child.nodeType !== 1 && child.nodeType !== 3) continue;
      if (hasId(child)) {
        k.push(idOf(child));
      } else {
        const tree = serializeNode(child, idOf);
        if (!tree) continue;
        k.push(tree.i);
        n.push(tree);
      }
    }
    ops.push({ op: 'kids', p: idOf(parent), k, n });
  }
  for (const rec of records) {
    if (rec.type !== 'childList') continue;
    for (const gone of rec.removedNodes ?? []) {
      if (!gone.isConnected) forgetTree(gone, forget);
    }
  }
  return ops;
}

/** Whether an attribute of this name can ever cross, so a change to it is worth sending. */
export function attrCrossesEver(tag, name) {
  if (name.startsWith('on')) return false;
  if (name.startsWith('aria-')) return true;
  if (name === 'style') return true;
  if (name === 'src') return tag === 'img';
  if (name === 'href') return tag === 'a';
  return PLAIN_ATTRS.has(name);
}

function forgetTree(node, forget) {
  forget(node);
  for (const child of node.childNodes ?? []) forgetTree(child, forget);
}

/**
 * The panel side: builds and updates a DOM from what the other side sent.
 *
 * `doc` is the panel's document (or a fake in tests). The registry maps ids
 * to nodes and is owned by the caller, so it can look a node up when the
 * person clicks. Nothing here reads a string as markup.
 */
export function createMirror(doc, { registry = new Map(), owners = new WeakMap() } = {}) {
  function build(tree) {
    let node;
    if ('x' in tree) {
      node = doc.createTextNode(tree.x);
    } else {
      node = tree.s ? doc.createElementNS(SVG_NS, tree.t) : doc.createElement(tree.t);
      for (const [name, value] of Object.entries(tree.a ?? {})) {
        // The value was filtered on the way in; filtered again here, so the
        // panel does not depend on the sender having done it.
        const v = safeAttr(tree.t, name, value);
        if (v !== null) node.setAttribute(name, v);
      }
      for (const child of tree.c ?? []) node.appendChild(build(child));
    }
    registry.set(tree.i, node);
    owners.set(node, tree.i);
    return node;
  }

  function drop(node) {
    const id = owners.get(node);
    if (id !== undefined) { registry.delete(id); owners.delete(node); }
    for (const child of node.childNodes ?? []) drop(child);
  }

  /** Replaces the mirrored tree under `host` with a fresh snapshot. */
  function snapshot(host, tree) {
    for (const child of [...(host.childNodes ?? [])]) { drop(child); host.removeChild(child); }
    registry.clear();
    if (!tree) return null;
    const node = build(tree);
    host.appendChild(node);
    return node;
  }

  /**
   * Applies a batch. One op that cannot be applied (a parent the registry
   * does not know, a node of the wrong kind) is skipped and counted; the
   * rest of the batch still goes in, so a single stray record cannot leave
   * the mirror behind the page for good.
   *
   * @returns {number} how many ops were skipped
   */
  function apply(ops) {
    let skipped = 0;
    for (const op of ops ?? []) {
      try {
        applyOne(op);
      } catch {
        skipped += 1;
      }
    }
    return skipped;
  }

  function applyOne(op) {
    {
      if (op.op === 'txt') {
        const node = registry.get(op.i);
        if (node && node.nodeType === 3) node.data = String(op.x ?? '');
      } else if (op.op === 'att') {
        const node = registry.get(op.i);
        if (!node || node.nodeType !== 1) return;
        const tag = String(node.localName ?? '').toLowerCase();
        const v = op.v === null || op.v === undefined ? null : safeAttr(tag, op.k, op.v);
        if (v === null) node.removeAttribute(op.k);
        else node.setAttribute(op.k, v);
      } else if (op.op === 'kids') {
        const parent = registry.get(op.p);
        if (!parent || parent.nodeType !== 1) return;
        const fresh = new Map((op.n ?? []).map((tree) => [tree.i, tree]));
        const wanted = [];
        for (const id of op.k ?? []) {
          let node = registry.get(id);
          if (!node && fresh.has(id)) node = build(fresh.get(id));
          if (node) wanted.push(node);
        }
        // Put the wanted children in order, moving what exists and inserting
        // what is new; then whatever remains after them is gone.
        for (let i = 0; i < wanted.length; i += 1) {
          const at = parent.childNodes[i] ?? null;
          if (at !== wanted[i]) parent.insertBefore(wanted[i], at);
        }
        while (parent.childNodes.length > wanted.length) {
          const extra = parent.childNodes[parent.childNodes.length - 1];
          drop(extra);
          parent.removeChild(extra);
        }
      }
    }
  }

  /** The mirror id of a panel node, or of its nearest mirrored ancestor. */
  function idOf(node) {
    let n = node;
    while (n) {
      const id = owners.get(n);
      if (id !== undefined) return id;
      n = n.parentNode;
    }
    return null;
  }

  return { snapshot, apply, idOf, registry };
}
