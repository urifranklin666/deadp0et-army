/**
 * Application-payload envelope.
 *
 * Chat and canvas share one MLS group — same ratchet, same ordered log, one
 * ciphertext per op for the whole room. So the plaintext needs a type tag to
 * say which subsystem an op belongs to.
 *
 * Kept deliberately small: this is inside the encrypted payload, and every
 * canvas stroke pays for it.
 */

export const T = {
  CHAT: "c",      // { t:'c', b: text }
  Y_UPDATE: "y",  // { t:'y', u: base64(Yjs update) }
  Y_SNAPSHOT: "s",// { t:'s', u: base64(full Yjs state) } — for members who joined late
  Y_REQUEST: "r", // { t:'r' } — "I have a gap, someone publish the board"
};

export function encodeEnvelope(obj) {
  return JSON.stringify(obj);
}

/**
 * Parse a decrypted payload. Anything unrecognised is treated as chat text so
 * a future sender using a newer tag degrades to something visible rather than
 * vanishing silently.
 */
export function decodeEnvelope(text) {
  if (typeof text !== "string") return { t: T.CHAT, b: String(text ?? "") };
  if (!text.startsWith("{")) return { t: T.CHAT, b: text };
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" && o.t ? o : { t: T.CHAT, b: text };
  } catch {
    return { t: T.CHAT, b: text };
  }
}
