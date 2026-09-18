// Local by default.
//
// Out of the box the extension talks to nothing of its own: orders are placed,
// watched and executed by THIS browser, on the FOMO page, and the only
// remote parties are the ones FOMO itself uses (its API, its bundler, the
// relay, the RPC nodes). No server of the user's is contacted, no pairing
// string is accepted, no order list or signing sample is mirrored anywhere.
//
// "Autonomous" mode, a hub on the user's own server, or this browser acting
// as the runner for another one, is a deliberate step into a different
// threat model: a second machine holds a session key, or a whole logged-in
// browser, that can trade the wallet within the grant. It is therefore behind
// one master switch in the popup, off until the person turns it on and
// acknowledges what it means. Everything that reaches out, pairing, order
// mirroring, hub polling, the runner's long poll, asks this one question
// first, so that "the switch is off" and "nothing leaves the browser" are the
// same statement.

/** Whether autonomous (server-assisted) execution has been switched on and acknowledged. */
export function autonomousOn(settings) {
  return settings?.autonomousEnabled === true;
}

/**
 * Whether a browser on the user's server executes the orders: autonomous mode
 * is on, a hub is paired, and the hub has reported a runner browser's key
 * (`daemon.sessionKey`, null while no runner is paired there).
 *
 * This is what stands the laptop's own runner down. A paired hub WITHOUT a
 * runner browser executes nothing, so it must not count: yielding to it left
 * every order with no executor at all.
 */
export function runnerExecutes(settings) {
  return autonomousOn(settings) && Boolean(settings?.daemonEnabled && settings?.daemon?.url && settings?.daemon?.sessionKey);
}

/** Refusal text for a server action attempted while the extension is local-only. */
export const AUTONOMY_REQUIRED = 'autonomous mode is off, the extension is local-only until you turn it on in the popup and acknowledge the risk';
