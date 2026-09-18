// The page stays awake for the side panel.
//
// FOMO loads its token lists only while the document is visible: the data
// layer (TanStack Query's focus manager, and their own checks) reads
// document.visibilityState, and a tab in the background gets no list at
// all, so a panel mirroring that tab showed an empty Tokens tab. While a
// panel is connected to this tab, the MAIN world answers "visible" to the
// page; the moment the last panel goes, the real answer is back. The
// getters are installed at document_start, before FOMO's first line, and
// read a flag, so the switch itself needs no reinstall.
//
// Nothing else changes: rendering steps, timers and animation frames in a
// hidden tab are the browser's, not the page's, and stay as they are. The
// content the panel needs arrives through fetch and the socket, which run.

const state = {
  on: false,
  installed: false,
  /** The browser's own getters, for the honest answer. */
  realState: null,
  realHidden: null,
};

/**
 * Animation frames for a hidden tab. A hidden document gets no rendering
 * steps and so no animation frames; FOMO schedules the loading of the next
 * page of a list on one, so a panel scrolling a list in a background tab
 * ran out of rows. While the switch is on and the document is really
 * hidden, a frame request becomes a short timer (which a hidden tab still
 * runs, throttled to about once a second). Ids handed out for the timers
 * live in their own range so cancel() can tell them apart.
 */
const TIMER_ID_BASE = 2 ** 31;
const timers = new Map();
let nextTimerId = TIMER_ID_BASE;
function installFrames() {
  const w = globalThis.window;
  if (!w || typeof w.requestAnimationFrame !== 'function') return;
  const nativeRequest = w.requestAnimationFrame.bind(w);
  const nativeCancel = w.cancelAnimationFrame.bind(w);
  w.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (!(state.on && state.realState?.call(document) === 'hidden')) return nativeRequest(callback);
    nextTimerId += 1;
    const id = nextTimerId;
    timers.set(id, setTimeout(() => { timers.delete(id); try { callback(performance.now()); } catch { /* the page's own error */ } }, 16));
    return id;
  };
  w.cancelAnimationFrame = function cancelAnimationFrame(id) {
    if (id >= TIMER_ID_BASE && timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); return undefined; }
    return nativeCancel(id);
  };
}

export function install() {
  if (state.installed) return true;
  const proto = globalThis.Document?.prototype;
  const stateDesc = proto && Object.getOwnPropertyDescriptor(proto, 'visibilityState');
  const hiddenDesc = proto && Object.getOwnPropertyDescriptor(proto, 'hidden');
  if (!stateDesc?.get || !hiddenDesc?.get) return false;
  state.realState = stateDesc.get;
  state.realHidden = hiddenDesc.get;
  Object.defineProperty(proto, 'visibilityState', {
    configurable: true,
    enumerable: stateDesc.enumerable,
    get() { return state.on ? 'visible' : state.realState.call(this); },
  });
  Object.defineProperty(proto, 'hidden', {
    configurable: true,
    enumerable: hiddenDesc.enumerable,
    get() { return state.on ? false : state.realHidden.call(this); },
  });
  state.installed = true;
  installFrames();
  return true;
}

/** Switches the pretence on or off; the page is told the state "changed" so its listeners re-read it. */
export function setAwake(on) {
  const next = Boolean(on);
  if (state.installed && next !== state.on) {
    state.on = next;
    try { document.dispatchEvent(new Event('visibilitychange')); } catch { /* no document */ }
    if (next) { try { window.dispatchEvent(new Event('focus')); } catch { /* no window */ } }
  }
  return { on: state.on, installed: state.installed, real: state.realState ? state.realState.call(document) : null };
}

/** The switch, and what the browser itself says about the document. */
export function status() {
  return { on: state.on, installed: state.installed, real: state.realState ? state.realState.call(document) : null };
}
