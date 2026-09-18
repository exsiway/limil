/**
 * The FOMO account THIS browser trades for.
 *
 * Asked of the FOMO tab first (`ui.status` → context.sender). When the page
 * does not say, the answer is the sender of the last order this browser sent
 * and the bundler accepted: such a send is the one fact about the account
 * that cannot be
 * wrong. Null when neither is known, reported as null rather than guessed.
 */
export async function signedInWallet({ fallback = null } = {}) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://fomo.family/*', 'https://*.fomo.family/*'] });
    for (const tab of tabs) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'ui.status' });
        const sender = (res?.result ?? res ?? {})?.context?.sender ?? null;
        if (typeof sender === 'string' && /^0x[0-9a-fA-F]{40}$/.test(sender)) return sender.toLowerCase();
      } catch { /* a deaf tab, try the next */ }
    }
  } catch { /* no tabs permission or no tabs */ }
  return typeof fallback === 'string' && /^0x[0-9a-fA-F]{40}$/.test(fallback) ? fallback.toLowerCase() : null;
}
