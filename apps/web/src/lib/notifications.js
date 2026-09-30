/**
 * Desktop notifications, opt-in.
 *
 * They say THAT something happened and where — never what. A notification's
 * text is handed to the operating system, which keeps it in a notification
 * centre outside this page's control; message plaintext has no business
 * there. At most the sender's verified handle and the channel.
 */

const PREF = "dp:notifications";
const THROTTLE_MS = 10_000;
const lastShown = new Map();          // tag -> time

const supported = () => typeof Notification !== "undefined";

export function notificationsOn() {
  try {
    return supported() && Notification.permission === "granted" && localStorage.getItem(PREF) === "on";
  } catch {
    return false;
  }
}

/** Ask the browser (if needed) and remember the choice. Resolves to the new state. */
export async function setNotifications(on) {
  try {
    if (!on) { localStorage.setItem(PREF, "off"); return false; }
    if (!supported()) return false;
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    localStorage.setItem(PREF, perm === "granted" ? "on" : "off");
    return perm === "granted";
  } catch {
    return false;
  }
}

/**
 * Show one notification per `tag` (a channel) at most every few seconds; a
 * newer one replaces the older in the notification centre. Only when the
 * page isn't what the user is looking at.
 */
export function notify(tag, title, body, onClick) {
  if (!notificationsOn() || document.visibilityState === "visible") return;
  const now = Date.now();
  if (now - (lastShown.get(tag) || 0) < THROTTLE_MS) return;
  lastShown.set(tag, now);
  try {
    const n = new Notification(title, { body, tag, silent: false });
    n.onclick = () => { window.focus(); onClick?.(); n.close(); };
  } catch { /* some browsers refuse outside a service worker; skip */ }
}
