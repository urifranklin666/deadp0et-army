import { store } from "./db.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
// OWASP's 2023 figure for PBKDF2-SHA256. Files record the count they were made
// with, so raising this later does not orphan old backups.
const ITERATIONS = 600000;
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 5000000;
const FORMAT = "deadp0et-recovery";

const b64 = (bytes) => {
  let s = "";
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function jsonReplacer(_key, value) {
  if (value instanceof Uint8Array) return { __dp_u8: b64(value) };
  if (value instanceof ArrayBuffer) return { __dp_u8: b64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { __dp_u8: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  return value;
}
function jsonReviver(_key, value) {
  return value && typeof value === "object" && value.__dp_u8 ? unb64(value.__dp_u8) : value;
}

/** Keys are `<kind>:<handle>[:<group>]`; match the handle segment exactly. */
const ownsKey = (key, handle) => {
  const parts = String(key).split(":");
  return parts.length >= 2 && parts[1] === handle;
};

async function keyFrom(passphrase, salt, iterations, usages) {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material, { name: "AES-GCM", length: 256 }, false, usages);
}

export async function exportRecovery(handle, passphrase) {
  if (passphrase.length < 12) throw new Error("Recovery passphrase must be at least 12 characters.");
  const all = await store.entries();
  const entries = all.filter(([key]) => ownsKey(key, handle));
  if (!entries.length) throw new Error("No local device state exists for this handle.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, ITERATIONS, ["encrypt"]);
  // The header is authenticated as associated data, so the KDF parameters
  // cannot be tampered with to weaken a brute-force target.
  const header = {
    format: FORMAT, version: 2,
    kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt) },
    cipher: { name: "AES-256-GCM", nonce: b64(nonce) },
  };
  const payload = enc.encode(JSON.stringify({ version: 2, handle, exportedAt: new Date().toISOString(), entries }, jsonReplacer));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: enc.encode(JSON.stringify(header)) }, key, payload));
  return new Blob([JSON.stringify({ ...header, ciphertext: b64(ciphertext) })], { type: "application/vnd.deadp0et.recovery+json" });
}

export async function importRecovery(file, passphrase, expectedHandle) {
  let box;
  try { box = JSON.parse(await file.text()); } catch { throw new Error("That is not a DEADP0ET recovery file."); }
  if (box?.format !== FORMAT || ![1, 2].includes(box.version)) throw new Error("Unsupported recovery format.");
  const iterations = Number(box.kdf?.iterations);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error("Unsupported recovery format.");
  }

  let data;
  try {
    const { ciphertext, ...header } = box;
    const key = await keyFrom(passphrase, unb64(box.kdf.salt), iterations, ["decrypt"]);
    const params = { name: "AES-GCM", iv: unb64(box.cipher.nonce) };
    if (box.version >= 2) params.additionalData = enc.encode(JSON.stringify(header));
    const plaintext = await crypto.subtle.decrypt(params, key, unb64(ciphertext));
    data = JSON.parse(dec.decode(plaintext), jsonReviver);
  } catch {
    throw new Error("Recovery failed. The passphrase is wrong or the file was modified.");
  }

  if (typeof data?.handle !== "string" || !Array.isArray(data.entries)) throw new Error("Unsupported recovery format.");
  if (expectedHandle && data.handle !== expectedHandle) throw new Error(`This backup belongs to @${data.handle}, not @${expectedHandle}.`);
  for (const e of data.entries) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || !ownsKey(e[0], data.handle)) {
      throw new Error("Recovery file contains records for another account; refusing to restore it.");
    }
  }
  // Two live copies of one MLS ratchet diverge for good. Restoring over state
  // this browser already holds is exactly that, so refuse.
  const live = (await store.entries()).filter(([k]) => String(k).startsWith(`gs:${data.handle}:`));
  if (live.length) {
    throw new Error(`This browser already holds room state for @${data.handle}. Restoring would clone the MLS ratchet; clear this site's data first if this is really a replacement.`);
  }
  await store.import(data.entries);
  return { handle: data.handle, entries: data.entries.length, exportedAt: data.exportedAt };
}

export function downloadRecovery(blob, handle) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `deadp0et-${handle}-${new Date().toISOString().slice(0, 10)}.dpr`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
