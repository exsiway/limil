// The smallest DOM the mirror needs: elements with attributes and ordered
// children, text nodes, a document that creates them. Enough to serialise a
// tree on one side and rebuild it on the other without a browser.

const SVG_NS = 'http://www.w3.org/2000/svg';

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === 9;
  }

  appendChild(node) { return this.insertBefore(node, null); }

  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && at < 0) throw new Error('reference node is not a child');
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at < 0) throw new Error('not a child');
    this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  get textContent() {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((c) => c.textContent).join('');
  }
}

export class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = String(data);
    this.nodeName = '#text';
  }
}

export class FakeElement extends FakeNode {
  constructor(tag, ns = null) {
    super(1);
    this.localName = tag;
    this.nodeName = ns === SVG_NS ? tag : tag.toUpperCase();
    this.namespaceURI = ns ?? 'http://www.w3.org/1999/xhtml';
    this.attrs = new Map();
  }

  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }

  /** `<tag attr="v">text</tag>` for assertions; attributes in insertion order. */
  get outerHTML() {
    const a = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
    const inner = this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.outerHTML)).join('');
    return `<${this.localName}${a}>${inner}</${this.localName}>`;
  }
}

export class FakeDocument extends FakeNode {
  constructor() { super(9); this.nodeName = '#document'; }
  createElement(tag) { return new FakeElement(String(tag).toLowerCase()); }
  createElementNS(ns, tag) { return new FakeElement(tag, ns); }
  createTextNode(text) { return new FakeText(text); }
}

/**
 * Builds a fake tree from a terse spec: ['div', { class: 'a' }, 'text', ['span', {}, 'x']].
 * A string is a text node; the attribute object is optional.
 */
export function el(doc, spec, ns = null) {
  if (typeof spec === 'string') return doc.createTextNode(spec);
  const [tag, maybeAttrs, ...rest] = spec;
  const hasAttrs = maybeAttrs && typeof maybeAttrs === 'object' && !Array.isArray(maybeAttrs);
  const attrs = hasAttrs ? maybeAttrs : {};
  const kids = hasAttrs ? rest : [maybeAttrs, ...rest].filter((k) => k !== undefined);
  const useNs = tag === 'svg' ? SVG_NS : ns;
  const node = useNs ? doc.createElementNS(useNs, tag) : doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const kid of kids) node.appendChild(el(doc, kid, useNs));
  return node;
}

/** A childList mutation record the way the observer would report it. */
export function childListRecord(target, { added = [], removed = [] } = {}) {
  return { type: 'childList', target, addedNodes: added, removedNodes: removed };
}
export function attrRecord(target, attributeName) {
  return { type: 'attributes', target, attributeName };
}
export function textRecord(target) {
  return { type: 'characterData', target };
}
