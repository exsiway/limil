// Client of the FOMO bundler.
//
// The transaction is not sent by the wallet but by their own bundler over the
// standard ERC-4337 JSON-RPC. Our assembled UserOperation goes to the same
// place by the same method as their front end's, so the trade travels their
// path and not around it.
//
// The bundler SPONSORS gas: in live operations preVerificationGas, maxFeePerGas
// and maxPriorityFeePerGas are zero. Non-zero values change the hash and with
// it the signature.

import { ENTRY_POINT_V08 } from '../shared/chains.js';
import { unpackUint128Pair } from '../shared/userop.js';
import { explainFully } from '../shared/explain.js';
import { sessionHeaders } from './fomo-bridge.js';

/** The bundler address depends on the chain: /v2/<chainId>/rpc. */
function bundlerUrl(chainId) {
  return `https://bundler.prod-edge.fomo.family/v2/${Number(chainId)}/rpc`;
}

let nextId = 1;

async function rpc(chainId, method, params) {
  // The bundler is part of their infrastructure and requires the same
  // authorization as the API: without headers it answers 401 no_auth_header.
  // The headers are captured from their own requests; none are invented.
  const url = bundlerUrl(chainId);
  const session = sessionHeaders(new URL(url).origin);
  if (!session) {
    throw new Error('FOMO session not captured, nothing to present to the bundler. '
      + 'Open a token page and let it load: the headers are taken from its own balances request.');
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...session, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
  } catch (err) {
    // "Failed to fetch" is the browser, not the bundler: the request did not
    // leave, most often refused by the CORS preflight over an extra header.
    throw new Error(`request to the bundler did not leave (${String(err?.message || err)}). `
      + `Headers sent: ${Object.keys(session).join(', ')}. `
      + 'Looks like a CORS preflight refusal, the header set is wrong.');
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`the bundler answered non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.error) {
    // Error shapes differ between bundlers; show what is there, else the raw body.
    const code = json.error.code ?? json.error.status ?? '';
    const raw = json.error.message
      ?? json.error.data?.message
      ?? json.error.reason
      ?? JSON.stringify(json.error).slice(0, 300);
    // `AA24 signature error` names a cause nobody outside this code knows.
    const { text: message } = explainFully(raw);
    // The runner recognises this prefix as "certainly not sent".
    throw new Error(`bundler refused${code === '' ? '' : ` (${code})`}: ${message}`);
  }
  if (json.result === undefined) {
    throw new Error(`the bundler answered without result: ${text.slice(0, 300)}`);
  }
  return json.result;
}

/**
 * The UserOperation in the shape the JSON-RPC accepts.
 *
 * Gas fields go UNPACKED. The packed accountGasLimits and gasFees are only for
 * the hash that is signed; the bundler expects four separate keys, and sending
 * them packed is refused without a clear message.
 */
function toRpcUserOp(userOp, signature) {
  const hex = (v) => `0x${BigInt(v).toString(16)}`;
  const gas = unpackUint128Pair(userOp.accountGasLimits);
  const fees = unpackUint128Pair(userOp.gasFees);

  const rpc = {
    sender: userOp.sender,
    nonce: hex(userOp.nonce),
    callData: userOp.callData,
    callGasLimit: hex(gas.lo),
    verificationGasLimit: hex(gas.hi),
    preVerificationGas: hex(userOp.preVerificationGas),
    maxFeePerGas: hex(fees.lo),
    maxPriorityFeePerGas: hex(fees.hi),
    signature: signature ?? userOp.signature ?? '0x',
  };
  // initCode/factory/paymaster are not sent at all: the account is already
  // delegated and live operations carry none of these fields; some bundlers
  // reject empty strings where absence is expected.
  const paymaster = userOp.paymasterAndData;
  if (paymaster && paymaster !== '0x') rpc.paymasterAndData = paymaster;
  return rpc;
}

/** Simulation: the bundler estimates the operation without sending it. */
export function estimateGas({ chainId, userOp, signature }) {
  return rpc(chainId, 'eth_estimateUserOperationGas', [
    toRpcUserOp(userOp, signature), ENTRY_POINT_V08,
  ]);
}

/**
 * Sends the operation. THIS SPENDS FUNDS.
 *
 * A 7702 authorization travels INSIDE the operation, not as a separate
 * transaction. Delegation normally needs a type-4 transaction with gas, which
 * the FOMO wallet cannot pay. Their bundler accepts the `eip7702Auth` field and
 * the EntryPoint applies the authorization BEFORE validation, so one sponsored
 * operation carries both the delegation and what it is needed for.
 */
export function sendUserOperation({ chainId, userOp, signature, authorization = null }) {
  const rpcOp = toRpcUserOp(userOp, signature);
  if (authorization) rpcOp.eip7702Auth = authorization;
  return rpc(chainId, 'eth_sendUserOperation', [rpcOp, ENTRY_POINT_V08]);
}

/** The receipt is not immediate: null comes first. */
export function getReceipt({ chainId, userOpHash }) {
  return rpc(chainId, 'eth_getUserOperationReceipt', [userOpHash]);
}

/** Waits for the receipt, polling the bundler the way their front end does. */
export async function waitForReceipt({ chainId, userOpHash, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    // A refusal or a dropped connection on one poll is not the answer: the
    // operation is with the bundler either way, and the next poll may say so.
    try {
      const receipt = await getReceipt({ chainId, userOpHash });
      if (receipt) return receipt;
    } catch (err) {
      lastError = String(err?.message || err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`no receipt for ${userOpHash} within ${timeoutMs / 1000} s${lastError ? ` (last answer: ${lastError.slice(0, 120)})` : ''}`);
}
