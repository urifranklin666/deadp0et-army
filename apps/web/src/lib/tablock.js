/**
 * One tab per account per browser.
 *
 * Every tab of this origin shares one IndexedDB, so two tabs would load the
 * same MLS state and each advance its own copy: both would encrypt with the
 * same ratchet generation (key and nonce reuse) and their states would
 * diverge for good. An exclusive Web Lock, held for the tab's lifetime,
 * makes the second tab stand down instead.
 *
 * Resolves true if this tab holds the lock, false if another tab does.
 * Browsers without Web Locks get true: no worse than before.
 */
const held = new Map();          // handle -> Promise<boolean>, once per tab

export function claimTab(handle) {
  if (!navigator.locks?.request) return Promise.resolve(true);
  // Asking again from this tab (boot retried after a failure) must not find
  // its own lock and conclude another tab has it.
  if (!held.has(handle)) held.set(handle, request(handle));
  return held.get(handle);
}

function request(handle) {
  return new Promise((resolve) => {
    navigator.locks.request(`deadp0et:keys:${handle}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return new Promise(() => {});      // never settles: held until the tab goes away
    }).catch(() => resolve(true));
  });
}
