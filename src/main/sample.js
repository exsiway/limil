// What the captured Privy envelope sample says: the wallet address and the
// method. The address is needed before the first buy, when the wallet has no
// EVM balance row to read it from.

import * as privy from './privy-bridge.js';

/**
 * @returns {{hasSample: boolean, method?: string|null, address?: string|null}}
 */
export function inspectSample() {
  const sample = privy.getSample();
  if (!sample) return { hasSample: false };

  const { method = null, params = [] } = sample;
  const out = { hasSample: true, method, address: null };

  if (Array.isArray(params) && typeof params[0] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(params[0])) {
    out.address = params[0];
  }
  return out;
}
