// Networks and addresses. `networkId` values are the ones FOMO uses in
// balances and token ids; relay has its own id for Solana (792703809).

export const ENTRY_POINT_V08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

/** The delegate FOMO wallets ship with (Simple7702Account). Used to disconnect. */
export const SIMPLE_7702_ACCOUNT = '0xe6cae83bde06e4c305530e199d7217f42808555b';

/**
 * The FIRST LimilSessionAccount, as deployed on Robinhood Chain (4663).
 *
 * The extension has to know what the wallet is delegated to: without this,
 * issuing a session-key grant against FOMO's delegate, which has no
 * `grantSession`, fails with an opaque bundler error instead of "your wallet
 * is not delegated yet".
 *
 * When comparing deployed code with the compiled artifact, compare the
 * executable part only: the tail of the bytecode is solc's CBOR metadata,
 * which carries a hash of the source text and changes with any comment edit.
 */
export const LIMIL_DELEGATE_V1 = '0xdd118986d9357FECdBc1ba6C90Cd1838817ee3Ac';

/**
 * The first version on the other chains, deployed through the deterministic
 * CREATE2 deployer. Kept only so a wallet still delegated to v1 is recognised
 * as ours: disconnect revokes its keys there, and the grant flow migrates it.
 * The salt is not kept: nothing is ever deployed at this address again.
 */
export const CREATE2_DELEGATE_V1 = '0xE3BEa55fDE39539E25fd239796DF96c21CBEb614';

/**
 * Version 2: per-token approve caps and a mandatory guard, but it measured a
 * SHARED relay depository against a floor the session key chose, and charged
 * the budget from `approve` rather than from what the router was asked to
 * pull. Recognised, never delegated to again.
 */
export const CREATE2_DELEGATE_V2 = '0x53C265D677C9c2A4A480b6445372E75153029f26';

/** Superseded versions per chain: recognised, never delegated to again. */
export const LEGACY_DELEGATES = Object.freeze({
  4663: LIMIL_DELEGATE_V1,
  56: CREATE2_DELEGATE_V1,
  8453: CREATE2_DELEGATE_V1,
  '4663.v2': CREATE2_DELEGATE_V2,
  '56.v2': CREATE2_DELEGATE_V2,
  '8453.v2': CREATE2_DELEGATE_V2,
});

/**
 * Version 3 of the session account: the budget is charged from the amounts
 * the swap call itself declares rather than from `approve`, so a standing
 * allowance buys nothing, and the guard's floor must meet a price the owner
 * fixed at grant time rather than one the signing key writes
 * (contracts/LimilSessionAccount.sol). One address on
 * every chain, through the deterministic CREATE2 deployer with this salt
 * (scripts/deploy-delegate.mjs); the address follows from the salt and the
 * compiled bytecode, and test/chains.test.mjs checks that it still does.
 */
export const DELEGATE_SALT_V3 = '0x8feb41565e39cdb41f10dd22d6d3ee2743587df98abd314fd1b561bbc2491fca';
export const CREATE2_DELEGATE_V3 = '0xc21366f5e034d1E13171aa150E1d0e31e31cc364';

/** The version the extension delegates to and grants on today. */
export const DELEGATE_SALT = DELEGATE_SALT_V3;
export const CREATE2_DELEGATE = CREATE2_DELEGATE_V3;

/** The delegate per chain. A chain missing here has no auto-execution of sells. */
export const DELEGATES = Object.freeze({
  4663: CREATE2_DELEGATE,
  56: CREATE2_DELEGATE,
  8453: CREATE2_DELEGATE,
});

/** The delegate address for a chain, or null when the contract is not there. */
export function delegateFor(chainId) {
  return DELEGATES[Number(chainId)] ?? null;
}

const sameAddress = (list, address) => {
  const a = String(address ?? '').toLowerCase();
  return Boolean(a) && list.some((d) => d.toLowerCase() === a);
};

/** Whether an address is one of our delegates, current or legacy, on any chain. */
export function isLimilDelegate(address) {
  return sameAddress([...Object.values(DELEGATES), ...Object.values(LEGACY_DELEGATES)], address);
}

/** Whether an address is a FIRST-version delegate: ours, but to be left, not granted on. */
export function isLegacyDelegate(address) {
  return sameAddress(Object.values(LEGACY_DELEGATES), address);
}

export const SOLANA_NETWORK_ID = 1399811149;
export const SOLANA_RELAY_CHAIN_ID = 792703809;

/**
 * "Cash" in the FOMO interface is USDC on the user's Solana address. Every buy
 * is paid from it and every sell settles into it.
 */
export const CASH_TOKEN_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CASH_TOKEN_ID = `${CASH_TOKEN_ADDRESS}:${SOLANA_NETWORK_ID}`;
export const CASH_DECIMALS = 6;

/** EVM networks FOMO trades on. Solana is not EVM and is handled separately. */
export const CHAINS = {
  1: { name: 'Ethereum', rpc: 'https://cloudflare-eth.com', native: 'ETH' },
  56: { name: 'BNB Chain', rpc: 'https://bsc-dataseed.bnbchain.org', native: 'BNB' },
  143: { name: 'Monad', rpc: 'https://rpc.ankr.com/monad', native: 'MON' },
  1337: { name: 'Hyperliquid', rpc: null, native: 'HYPE' },
  4663: { name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', native: 'ETH' },
  8453: { name: 'Base', rpc: 'https://mainnet.base.org', native: 'ETH' },
};

/**
 * Relay router and the selector of its SELL method, as seen in live FOMO
 * sells: the deposit goes to this address with selector 0xf9e4bab4. Buys use
 * a different selector and never take this path. Kept in one place so the
 * grant and the batch builder agree on the same pair.
 */
export const RELAY_ROUTER = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
export const RELAY_SWAP_SELECTOR = '0xf9e4bab4';

export const DEFAULT_CHAIN_ID = 4663;

/** 2D nonce key of our own, so our operations never collide with the app's. */
export const NONCE_KEY = 777n;

export function rpcUrl(chainId) {
  const chain = CHAINS[Number(chainId)];
  if (!chain) throw new Error(`chain ${chainId} is not one FOMO trades on`);
  if (!chain.rpc) throw new Error(`no RPC configured for ${chain.name}`);
  return chain.rpc;
}
