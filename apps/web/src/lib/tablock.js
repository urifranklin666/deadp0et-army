/**
 * One tab per account per browser.
 *
 * Every tab of this origin shares one IndexedDB, so two tabs would load the
 * same MLS state and each advance its own copy: both would encrypt with the
 * same ratchet generation (key and nonce reuse) and their states would
 * diverge for good. An exclusive Web Lock, held for the tab's lifetime,
 * makes the second tab stand down instead.
 *
 * Resolves true if this tab now holds the lock, false if another tab does.
 * Browsers without Web Locks get true: no worse than before.
 */
export function claimTab(handle) {
  if (!navigator.locks?.request) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request(`deadp0et:keys:${handle}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return new Promise(() => {});      // never settles: held until the tab goes away
    }).catch(() => resolve(true));
  });
}
