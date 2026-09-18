// Which headers the FOMO bundler accepts.
//
// The page only talks to the bundler at the moment of a swap, so waiting to
// capture that request would make autonomous sends impossible until the user
// swaps by hand, and again after every tab reload (captured headers live in
// tab memory). Instead the header set for the bundler is assembled from the
// headers the front end sends to the API on every page load, filtered by the
// list the bundler publishes in its CORS preflight response
// (`access-control-allow-headers`, max-age 86400). An extra header would fail
// the preflight and the request would never leave the browser.
//
// The bundler does require authorization: without headers it answers
// HTTP 401 {"error":"unauthorized","message":"no_auth_header"}.

/**
 * Headers allowed by the bundler, lower case. If FOMO changes the list the
 * send starts failing at the preflight; re-measure with:
 *
 *   curl -s -i -X OPTIONS https://bundler.prod-edge.fomo.family/v2/4663/rpc \
 *     -H 'Origin: https://fomo.family' \
 *     -H 'Access-Control-Request-Method: POST' \
 *     -H 'Access-Control-Request-Headers: authorization,content-type'
 */
export const BUNDLER_ALLOWED_HEADERS = Object.freeze([
  'content-type',
  'authorization',
  'fomo-authorization',
  'fomo-execution-context',
  'solana-client',
  'traceparent',
  'tracestate',
  'x-datadog-origin',
  'x-datadog-parent-id',
  'x-datadog-sampling-priority',
  'x-datadog-trace-id',
]);

/**
 * Whether a header carries the session. The name is undocumented and both
 * `authorization` and `fomo-authorization` occur, so the match is loose.
 */
export function carriesAuth(name) {
  return /auth/i.test(name);
}

/**
 * Header set for the bundler, built from headers captured on API requests.
 *
 * Returns null when none of them carries authorization: sending without it is
 * a guaranteed 401, better reported in words than as a foreign error.
 *
 * @param {Record<string,string>|null} apiHeaders captured from the page's own requests
 * @param {readonly string[]} allowed the bundler's allow-list
 */
export function bundlerHeaders(apiHeaders, allowed = BUNDLER_ALLOWED_HEADERS) {
  if (!apiHeaders) return null;
  const permitted = new Set(allowed.map((n) => n.toLowerCase()));
  const picked = {};
  let hasAuth = false;
  for (const [name, value] of Object.entries(apiHeaders)) {
    const lower = String(name).toLowerCase();
    if (!value || !permitted.has(lower)) continue;
    picked[lower] = value;
    if (carriesAuth(lower)) hasAuth = true;
  }
  if (!hasAuth) return null;
  picked['content-type'] = 'application/json';
  return picked;
}
