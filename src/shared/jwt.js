// Tokens inside the Privy envelope.
//
// A captured envelope carries a short-lived session token. Rather than
// rewriting the envelope (its structure is not ours to invent), the fields
// that look like a JWT are located and replaced with a fresh value from the
// page's storage.
//
// The signature is NOT verified and cannot be: only the expiry matters, so the
// user can be warned before Privy answers "Invalid auth token".

/** Three base64url parts separated by dots. */
const JWT_RE = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;

export function looksLikeJwt(value) {
  return typeof value === 'string' && value.length > 40 && JWT_RE.test(value);
}

/** Payload without signature verification: only exp and iat are needed. */
export function decodeJwtPayload(token) {
  if (!looksLikeJwt(token)) return null;
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    const json = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('binary');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Seconds until the token expires. Negative means expired, null means the
 * token carries no expiry or does not parse.
 */
export function secondsUntilExpiry(token, now = Date.now()) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return null;
  return Math.round(payload.exp - now / 1000);
}

/** Paths to every string that looks like a JWT. A path is an array of keys. */
export function findJwtPaths(node, path = [], found = [], depth = 0) {
  if (depth > 12 || node === null || node === undefined) return found;
  if (looksLikeJwt(node)) {
    found.push([...path]);
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => findJwtPaths(item, [...path, i], found, depth + 1));
    return found;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      findJwtPaths(value, [...path, key], found, depth + 1);
    }
  }
  return found;
}

/** Value at a path. */
export function getAtPath(node, path) {
  return path.reduce((acc, key) => (acc === undefined || acc === null ? acc : acc[key]), node);
}

/**
 * A copy of the object with the values at the given paths replaced. The
 * original is left intact: the envelope may still be needed as it was.
 */
export function replaceAtPaths(node, paths, value) {
  const copy = structuredClone(node);
  for (const path of paths) {
    if (path.length === 0) continue;
    const parent = getAtPath(copy, path.slice(0, -1));
    if (parent && typeof parent === 'object') parent[path.at(-1)] = value;
  }
  return copy;
}

/**
 * The freshest of the given tokens: the one that expires last. Tokens without
 * an expiry sort last, nothing is known about them.
 */
export function freshestToken(tokens, now = Date.now()) {
  const scored = tokens
    .filter(looksLikeJwt)
    .map((token) => ({ token, left: secondsUntilExpiry(token, now) }));
  if (scored.length === 0) return null;
  scored.sort((a, b) => (b.left ?? -Infinity) - (a.left ?? -Infinity));
  return scored[0];
}
