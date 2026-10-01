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

/**
 * The reactions on offer. A fixed set, so a member can't hang arbitrary text
 * (or a thousand distinct "emoji") off someone else's message.
 */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

/**
 * Record one reaction on a chat entry: entry.reactions[emoji][signingKey] =
 * handle. Filed by key, so each signing key counts once per emoji and only
 * that key can take its reaction back. Returns whether anything changed.
 */
export function applyReaction(entry, emoji, key, handle, on) {
  if (!entry || entry.text === undefined || !key || !REACTIONS.includes(emoji)) return false;
  const all = entry.reactions || {};
  const who = { ...(all[emoji] || {}) };
  if (on) {
    if (who[key] === (handle || "")) return false;
    who[key] = handle || "";
  } else {
    if (!(key in who)) return false;
    delete who[key];
  }
  const next = { ...all, [emoji]: who };
  if (!Object.keys(who).length) delete next[emoji];
  if (Object.keys(next).length) entry.reactions = next;
  else delete entry.reactions;
  return true;
}
