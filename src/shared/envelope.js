// Parsing and reuse of the envelope the page sends RPC requests in to the
// Privy iframe.
//
// The envelope format is versioned and undocumented, so it is not hard-coded.
// It is derived from a captured sample: the JSON-RPC node inside the tree is
// located and its path remembered. Our own request is the same envelope with
// a fresh id and our method/params substituted.
//
// Pure functions: no DOM.

/**
 * Wallet methods that identify the RPC node inside an envelope. `signMessage`
 * is how the front end asks for a Solana signature; the envelope is the same
 * as for EVM signatures, so a sample from either a sell or a buy will do.
 */
const RPC_METHODS = /^(eth_|personal_|wallet_|signTypedData|secp256k1_|solana_|signMessage$)/i;

/** Walks the tree yielding [path, node] for every object (arrays included). */
export function* walk(node, path = []) {
  if (!node || typeof node !== 'object') return;
  yield [path, node];
  for (const key of Object.keys(node)) {
    yield* walk(node[key], [...path, key]);
  }
}

export function getAtPath(root, path) {
  return path.reduce((acc, key) => (acc == null ? acc : acc[key]), root);
}

function setAtPath(root, path, value) {
  if (path.length === 0) return value;
  const parent = getAtPath(root, path.slice(0, -1));
  if (parent && typeof parent === 'object') parent[path.at(-1)] = value;
  return root;
}

/** The envelope may arrive as a string or an object; normalise. */
export function parseEnvelope(raw) {
  if (typeof raw === 'string') {
    try {
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? { data, wasString: true } : null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object') return { data: raw, wasString: false };
  return null;
}

/** Path to the {method, params} node, i.e. the JSON-RPC request itself. */
export function findRpcNode(envelope) {
  for (const [path, node] of walk(envelope)) {
    // params is an array for EVM methods and an object for Solana signMessage.
    if (typeof node.method === 'string'
        && RPC_METHODS.test(node.method)
        && node.params && typeof node.params === 'object') {
      return { path, method: node.method, params: node.params };
    }
  }
  return null;
}

/** Every envelope field that looks like a request id. */
export function findIdPaths(envelope) {
  const found = [];
  for (const [path, node] of walk(envelope)) {
    if (Array.isArray(node)) continue;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if ((key === 'id' || key === 'requestId')
          && (typeof value === 'string' || typeof value === 'number')) {
        found.push([...path, key]);
      }
    }
  }
  return found;
}

/** Describes a captured sample: where everything is. */
export function describeSample(raw) {
  const parsed = parseEnvelope(raw);
  if (!parsed) return null;
  const rpc = findRpcNode(parsed.data);
  if (!rpc) return null;
  return {
    envelope: parsed.data,
    wasString: parsed.wasString,
    rpcPath: rpc.path,
    idPaths: findIdPaths(parsed.data),
    method: rpc.method,
    params: rpc.params,
  };
}

/**
 * All EVM addresses found in an envelope.
 *
 * The envelope is cloned as a whole; only method, params and request id are
 * replaced, so the wallet address it was captured from travels along. When
 * the user switches accounts Privy answers "'0x…' not loaded on this device"
 * about the OLD address. This set answers "is our wallet among them".
 */
export function addressesIn(node, found = new Set(), depth = 0) {
  if (depth > 12 || node === null || node === undefined) return found;
  if (typeof node === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(node)) found.add(node.toLowerCase());
    return found;
  }
  if (Array.isArray(node)) {
    for (const item of node) addressesIn(item, found, depth + 1);
    return found;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node)) addressesIn(value, found, depth + 1);
  }
  return found;
}

/**
 * Whether the sample belongs to this wallet. An envelope without any address
 * is not treated as a mismatch: refusing on a guess is worse than letting it
 * through.
 */
export function envelopeBelongsTo(sample, sender) {
  if (!sample?.envelope || !sender) return true;
  const found = addressesIn(sample.envelope);
  if (found.size === 0) return true;
  return found.has(String(sender).toLowerCase());
}

/**
 * Builds our request from the sample.
 *
 * @returns {{payload: any, requestId: string}} payload ready for postMessage
 */
export function buildRequest(sample, { method, params, requestId }) {
  if (!sample?.envelope || !Array.isArray(sample.rpcPath)) {
    throw new Error('envelope sample is incomplete');
  }
  const envelope = structuredClone(sample.envelope);
  for (const path of sample.idPaths ?? []) setAtPath(envelope, path, requestId);
  setAtPath(envelope, [...sample.rpcPath, 'method'], method);
  setAtPath(envelope, [...sample.rpcPath, 'params'], params);
  // The sample may come from a buy, i.e. a Solana envelope; for an EVM
  // signature the chain type goes back to ethereum or Privy signs with the
  // wrong key.
  const parent = getAtPath(envelope, sample.rpcPath.slice(0, -1));
  if (parent && typeof parent === 'object' && parent.chainType !== undefined) parent.chainType = 'ethereum';
  return {
    payload: sample.wasString ? JSON.stringify(envelope) : envelope,
    requestId,
  };
}

/** The signature in a response: a 65-byte hex string somewhere in the tree. */
export function extractSignature(payload) {
  for (const [, node] of walk(payload)) {
    if (Array.isArray(node)) continue;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value)) return value;
    }
  }
  return null;
}

/**
 * A Solana signature: ed25519, 64 bytes, base64 (88 characters ending in
 * "=="), found under `signature` in the response.
 */
export function extractSolanaSignature(payload) {
  for (const [, node] of walk(payload)) {
    if (Array.isArray(node)) continue;
    const value = node?.signature;
    if (typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value)) return value;
  }
  return null;
}

/**
 * A Solana request from an EVM sample: same transport, `chainType: solana`
 * and params as an object. `hdWalletIndex: 0` matches the front end.
 */
export function buildSolanaRequest(sample, { method, params, requestId }) {
  const built = buildRequest(sample, { method, params, requestId });
  const envelope = built.payload && typeof built.payload === 'string' ? JSON.parse(built.payload) : built.payload;
  const parent = getAtPath(envelope, sample.rpcPath.slice(0, -1)) ?? envelope;
  if (parent && typeof parent === 'object') {
    parent.chainType = 'solana';
    if (parent.hdWalletIndex === undefined) parent.hdWalletIndex = 0;
  }
  return { payload: sample.wasString ? JSON.stringify(envelope) : envelope, requestId };
}

/**
 * The message that loads the wallet into the iframe, from a sample.
 *
 * Privy's SDK sends `privy:wallets:connect` with the wallet's entropy id,
 * its verifier and the session token before the first `privy:wallets:rpc`
 * of a page session; the iframe answers "'0x…' not loaded on this device"
 * to an rpc that comes first. A tab reload starts a new page session, and
 * FOMO connects only when it is about to sign itself. The rpc envelope we
 * captured carries the same three fields, so the connect message is built
 * from it; the transport is the SDK's: `{ id, event, data }` as a string.
 */
export function buildConnectRequest(sample, { requestId, event = 'privy:wallets:connect' }) {
  if (!sample?.envelope || !Array.isArray(sample.rpcPath)) {
    throw new Error('envelope sample is incomplete');
  }
  const envelope = structuredClone(sample.envelope);
  const parent = getAtPath(envelope, sample.rpcPath.slice(0, -1));
  const { accessToken, entropyId, entropyIdVerifier } = parent ?? {};
  if (typeof entropyId !== 'string' || typeof entropyIdVerifier !== 'string' || typeof accessToken !== 'string') {
    throw new Error('the envelope carries no wallet entropy, the wallet cannot be connected from it');
  }
  const message = { id: requestId, event, data: { accessToken, entropyId, entropyIdVerifier } };
  return { payload: sample.wasString ? JSON.stringify(message) : message, requestId };
}

/**
 * The message that recovers the wallet onto this device: the iframe answers
 * `wallets:connect` with "not loaded on this device" when it holds no
 * device share for the wallet (third-party storage of the iframe is
 * partitioned or cleared), and the SDK then sends `wallets:recover` with the
 * same three fields; with Privy-managed recovery nothing else is needed.
 */
export function buildRecoverRequest(sample, { requestId }) {
  return buildConnectRequest(sample, { requestId, event: 'privy:wallets:recover' });
}

export function extractError(payload) {
  for (const [, node] of walk(payload)) {
    if (Array.isArray(node)) continue;
    const err = node.error;
    if (typeof err === 'string' && err) return err;
    if (err && typeof err === 'object' && (err.message || err.code !== undefined)) {
      return `${err.code ?? ''} ${err.message ?? JSON.stringify(err)}`.trim();
    }
  }
  return null;
}

/** Whether a response is ours: the request id must occur somewhere in the tree. */
export function matchesRequestId(payload, requestId) {
  for (const [, node] of walk(payload)) {
    if (Array.isArray(node)) continue;
    for (const key of Object.keys(node)) {
      if (node[key] === requestId) return true;
    }
  }
  return false;
}


/**
 * What to say when Privy refuses.
 *
 * Two of its refusals are not refusals to sign at all, and both looked like a
 * ban until they were told apart:
 *
 * - an expired token inside the captured envelope;
 * - "'0x…' not loaded on this device" naming the wallet we are asking FOR.
 *   That one is Privy saying the embedded wallet has not been loaded into
 *   this page session. FOMO loads it when it needs it, and a tab reload loses
 *   it, and this extension reloads the tab on its own updates, so a good
 *   envelope can meet an unloaded wallet. Nothing needs re-capturing.
 *
 * The same message naming ANOTHER address means the envelope belongs to a
 * different wallet, which is caught before a request is ever sent.
 *
 * @param {string} error the text Privy answered with
 * @param {string|null} [expectSender] the wallet the request was made for
 */
export function privyRefusalText(error, { expectSender = null } = {}) {
  const text = String(error ?? '');
  const ours = expectSender ? text.toLowerCase().includes(String(expectSender).toLowerCase()) : true;
  if (/not loaded on this device/i.test(text) && ours) {
    return `Privy refused: ${text}. The wallet is the right one and the envelope is good, `
      + 'FOMO simply has not loaded this wallet into this tab yet, and a tab reload loses it. '
      + 'Do one thing in FOMO that asks for a signature (any sell of $2 or more), then place the order '
      + 'again in the SAME tab without reloading.';
  }
  if (/invalid auth token|token (is )?expired|unauthor/i.test(text)) {
    return `Privy refused: ${text}. This is an expired token in the envelope sample, `
      + 'not a refusal to sign. Reload the FOMO tab, the sample refreshes itself, '
      + 'and retry. If that does not help, make any operation with a signature in FOMO.';
  }
  return `Privy refused: ${text}`;
}
