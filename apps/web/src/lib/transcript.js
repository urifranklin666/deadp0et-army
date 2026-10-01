/**
 * Presentation rules for the transcript that carry security weight, kept
 * apart from the components so they can be tested directly.
 */

const GROUP_WINDOW_MS = 5 * 60_000;

const isChat = (e) => !!e && (e.text !== undefined || e.deleted);

/** Any reason to doubt who sent this, which the sender line must show. */
export const hasTrustWarning = (e) => !!(e.unverified || e.claimed || e.pendingKey);

/**
 * May `m` be drawn under `prev`'s sender line (no name, avatar or warnings of
 * its own)? Only when nothing about who sent it could differ: both are ours,
 * or both were signed by the same key, and neither carries a warning. Equal
 * display names are not enough; a different key claiming the same name is
 * exactly the case its own warning must not be hidden for.
 */
export function groupsWith(prev, m) {
  if (!isChat(m) || !isChat(prev)) return false;
  if (!m.at || !prev.at || new Date(m.at).toDateString() !== new Date(prev.at).toDateString()) return false;
  if (new Date(m.at) - new Date(prev.at) >= GROUP_WINDOW_MS) return false;
  if (m.mine || prev.mine) return !!(m.mine && prev.mine);
  if (hasTrustWarning(m) || hasTrustWarning(prev)) return false;
  return !!m.key && m.key === prev.key && m.from === prev.from;
}
